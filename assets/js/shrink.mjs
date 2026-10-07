/*
 * Gridset Image Shrinker — picture processing.
 *
 * Every picture gets several candidate versions made with established
 * codec libraries:
 *   - oxipng          lossless PNG optimiser (pixels identical)
 *   - libimagequant   reduces a PNG to a 256-colour palette (the pngquant engine)
 *   - MozJPEG         JPEG encoder (only for pictures with no transparency)
 *
 * A candidate is only allowed if it passes a "looks the same" check that
 * compares it with the original (see `looksTheSame`). The smallest allowed
 * candidate wins; if nothing is meaningfully smaller the original is kept.
 *
 * Grid 3 reads pictures by their content, not their file extension
 * (the sample gridsets already contain JPEG data in files named .png),
 * so file names are never changed.
 */

/* Quality thresholds. Tuned on real gridsets; see tests/README.md. */
export const QUALITY = {
  minSsim: 0.98,        // structural similarity of brightness (1 = identical)
  maxMeanDeltaE: 2.0,   // average colour difference (ΔE76) after slight blur; ~2.3 is "just noticeable"
  maxBigDeltaE: 0.005,  // share of pixels allowed a clearly visible colour change (ΔE > 10)
  maxAlphaChange: 12,   // largest change in see-through-ness allowed for any pixel (out of 255, ~5%)
  jpegQualities: [85, 90],
  minSaving: 0.05,      // keep the original unless we save at least 5%
  maxPixels: 16e6,      // larger pictures only get the lossless treatment
};

/**
 * Load every codec. `getWasm(path)` must return a compiled WebAssembly.Module
 * for a path relative to assets/vendor/.
 */
export async function loadCodecs(vendorUrl, getWasm) {
  const [oxipng, png, jpegEnc, jpegDec, liq] = await Promise.all([
    import(vendorUrl + 'oxipng/squoosh_oxipng.js'),
    import(vendorUrl + 'png/squoosh_png.js'),
    import(vendorUrl + 'jpeg/codec/enc/mozjpeg_enc.js'),
    import(vendorUrl + 'jpeg/codec/dec/mozjpeg_dec.js'),
    import(vendorUrl + 'imagequant/libimagequant_wasm.js'),
  ]);
  const [oxWasm, pngWasm, encWasm, decWasm, liqWasm] = await Promise.all([
    getWasm('oxipng/squoosh_oxipng_bg.wasm'),
    getWasm('png/squoosh_png_bg.wasm'),
    getWasm('jpeg/codec/enc/mozjpeg_enc.wasm'),
    getWasm('jpeg/codec/dec/mozjpeg_dec.wasm'),
    getWasm('imagequant/libimagequant_wasm_bg.wasm'),
  ]);
  await oxipng.default(oxWasm);
  await png.default(pngWasm);
  liq.initSync({ module: liqWasm });
  // Emscripten modules: hand them the pre-compiled wasm (same approach as jSquash).
  const emscripten = (factory, wasm) => factory({
    noInitialRun: true,
    instantiateWasm(imports, callback) {
      const instance = new WebAssembly.Instance(wasm, imports);
      callback(instance);
      return instance.exports;
    },
  });
  const [enc, dec] = await Promise.all([emscripten(jpegEnc.default, encWasm), emscripten(jpegDec.default, decWasm)]);

  return {
    optimisePng: (bytes) => oxipng.optimise(bytes, 2, false, true),
    decodePng: (bytes) => png.decode(bytes),
    decodeJpeg: (bytes) => {
      const img = dec.decode(bytes, false);
      if (!img) throw new Error('could not decode JPEG');
      return img;
    },
    encodeJpeg: (img, quality) => new Uint8Array(enc.encode(img.data, img.width, img.height, {
      ...JPEG_DEFAULTS, quality, chroma_quality: quality,
    })),
    quantize(img) {
      const rgba = new Uint8ClampedArray(img.data.buffer, img.data.byteOffset, img.data.length);
      const q = new liq.ImageQuantizer();
      try {
        q.setSpeed(4);
        q.setQuality(0, 100);
        const r = q.quantizeImage(rgba, img.width, img.height);
        try {
          r.setDithering(1.0);
          const indices = r.getPaletteIndices(rgba, img.width, img.height);
          return liq.encode_palette_to_png(indices, r.getPalette(), img.width, img.height);
        } finally { r.free(); }
      } finally { q.free(); }
    },
  };
}

// MozJPEG settings. Baseline (not progressive) for the widest device support.
const JPEG_DEFAULTS = {
  quality: 90,
  baseline: true,
  arithmetic: false,
  progressive: false,
  optimize_coding: true,
  smoothing: 0,
  color_space: 3, // YCbCr
  quant_table: 3,
  trellis_multipass: false,
  trellis_opt_zero: false,
  trellis_opt_table: false,
  trellis_loops: 1,
  auto_subsample: true,
  chroma_subsample: 2,
  separate_chroma_quality: false,
  chroma_quality: 90,
};

/* ------------------------------------------------------------------ */
/* "Looks the same" check                                              */
/* ------------------------------------------------------------------ */

/** Composite RGBA onto a solid background, as the picture would appear in a cell. */
function flatten(img, bg) {
  const d = img.data, out = new Uint8ClampedArray(d.length);
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3] / 255;
    out[i] = d[i] * a + bg * (1 - a);
    out[i + 1] = d[i + 1] * a + bg * (1 - a);
    out[i + 2] = d[i + 2] * a + bg * (1 - a);
    out[i + 3] = 255;
  }
  return { data: out, width: img.width, height: img.height };
}

/** 2x2 box average: approximates how fine dithering blends at normal viewing size. */
function halve(img) {
  const w = img.width >> 1, h = img.height >> 1, s = img.data, W = img.width;
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4, a = ((2 * y) * W + 2 * x) * 4, b = a + W * 4;
      for (let c = 0; c < 3; c++) out[o + c] = (s[a + c] + s[a + 4 + c] + s[b + c] + s[b + 4 + c] + 2) >> 2;
      out[o + 3] = 255;
    }
  }
  return { data: out, width: w, height: h };
}

const labCache = new Map();
function toLab(r, g, b) {
  const key = (r << 16) | (g << 8) | b;
  let v = labCache.get(key);
  if (v) return v;
  const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  const R = lin(r), G = lin(g), B = lin(b);
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const x = f((R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047);
  const y = f(R * 0.2126 + G * 0.7152 + B * 0.0722);
  const z = f((R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883);
  v = [116 * y - 16, 500 * (x - y), 200 * (y - z)];
  if (labCache.size > 500000) labCache.clear();
  labCache.set(key, v);
  return v;
}

function colourDifference(a, b) {
  const d1 = a.data, d2 = b.data, n = d1.length / 4;
  let sum = 0, big = 0;
  for (let i = 0; i < d1.length; i += 4) {
    const p = toLab(d1[i], d1[i + 1], d1[i + 2]), q = toLab(d2[i], d2[i + 1], d2[i + 2]);
    const e = Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
    sum += e;
    if (e > 10) big++;
  }
  return { mean: n ? sum / n : 0, big: n ? big / n : 0 };
}

/**
 * Transparency must be preserved: no pixel may become more than slightly
 * more or less see-through. (Changes this small cannot be seen; the
 * white/black background comparison below catches anything visible.)
 */
function alphaChange(a, b) {
  let worst = 0;
  for (let i = 3; i < a.length; i += 4) {
    const d = Math.abs(a[i] - b[i]);
    if (d > worst) worst = d;
  }
  return worst;
}

export function measure(original, candidate, ssimFn) {
  if (original.width !== candidate.width || original.height !== candidate.height) return null;
  const alpha = alphaChange(original.data, candidate.data);
  let hasAlpha = false;
  for (let i = 3; i < original.data.length; i += 4) if (original.data[i] !== 255 || candidate.data[i] !== 255) { hasAlpha = true; break; }
  // Pictures with transparency are judged on both a white and a black background.
  const backgrounds = hasAlpha ? [255, 0] : [255];
  let worst = { ssim: 1, mean: 0, big: 0, alpha };
  for (const bg of backgrounds) {
    const A = flatten(original, bg), B = flatten(candidate, bg);
    const ssim = A.width >= 11 && A.height >= 11 ? ssimFn(A, B, { downsample: false }).mssim : 1;
    const small = A.width >= 4 && A.height >= 4;
    const de = colourDifference(small ? halve(A) : A, small ? halve(B) : B);
    worst = { ssim: Math.min(worst.ssim, ssim), mean: Math.max(worst.mean, de.mean), big: Math.max(worst.big, de.big), alpha };
  }
  return worst;
}

export function looksTheSame(m) {
  return !!m && m.alpha <= QUALITY.maxAlphaChange &&
    m.ssim >= QUALITY.minSsim && m.mean <= QUALITY.maxMeanDeltaE && m.big <= QUALITY.maxBigDeltaE;
}

/* ------------------------------------------------------------------ */
/* Per-picture processing                                              */
/* ------------------------------------------------------------------ */

function sniff(b) {
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  return 'other';
}

function isOpaque(img) {
  for (let i = 3; i < img.data.length; i += 4) if (img.data[i] !== 255) return false;
  return true;
}

/**
 * Shrink one picture.
 * Returns { status: 'shrunk' | 'kept', data?, method?, reason?, quality? }.
 * `jpegInfo` comes from core.js and tells us when a JPEG must be left alone.
 */
export function createShrinker(codecs, ssimFn, jpegInfo) {
  function best(original, candidates) {
    let pick = null;
    for (const c of candidates) if (c && (!pick || c.data.length < pick.data.length)) pick = c;
    if (!pick || pick.data.length > original.length * (1 - QUALITY.minSaving)) return { status: 'kept', reason: 'already as small as it can be' };
    return { status: 'shrunk', data: pick.data, method: pick.method, quality: pick.quality };
  }

  function tryCandidate(method, original, make, decode) {
    try {
      const data = make();
      const m = measure(original, decode(data), ssimFn);
      if (!looksTheSame(m)) return null;
      return { method, data, quality: m };
    } catch (e) {
      return null;
    }
  }

  function shrinkPng(bytes) {
    let img;
    try { img = codecs.decodePng(bytes); } catch (e) { return { status: 'kept', reason: 'picture could not be read' }; }

    const cands = [];
    // Lossless, but still checked like every other candidate.
    cands.push(tryCandidate('lossless', img, () => codecs.optimisePng(bytes), (d) => codecs.decodePng(d)));

    if (img.width * img.height <= QUALITY.maxPixels) {
      cands.push(tryCandidate('colours', img,
        () => codecs.optimisePng(codecs.quantize(img)),
        (d) => codecs.decodePng(d)));
      if (isOpaque(img)) {
        for (const q of QUALITY.jpegQualities) {
          const c = tryCandidate('jpeg', img, () => codecs.encodeJpeg(img, q), (d) => codecs.decodeJpeg(d));
          if (c) { cands.push(c); break; } // lowest passing quality is the smallest
        }
      }
    }
    return best(bytes, cands);
  }

  function shrinkJpeg(bytes) {
    const info = jpegInfo(bytes);
    if (info.orientation > 1) return { status: 'kept', reason: 'rotated photo' };
    if (info.icc) return { status: 'kept', reason: 'has a colour profile' };
    if (info.components !== 1 && info.components !== 3) return { status: 'kept', reason: 'print (CMYK) colours' };
    let img;
    try { img = codecs.decodeJpeg(bytes); } catch (e) { return { status: 'kept', reason: 'picture could not be read' }; }
    if (img.width * img.height > QUALITY.maxPixels) return { status: 'kept', reason: 'very large picture' };

    const cands = [];
    for (const q of QUALITY.jpegQualities) {
      const c = tryCandidate('jpeg', img, () => codecs.encodeJpeg(img, q), (d) => codecs.decodeJpeg(d));
      if (c) { cands.push(c); break; }
    }
    return best(bytes, cands);
  }

  return function shrinkImage(bytes) {
    const kind = sniff(bytes);
    if (kind === 'png') return shrinkPng(bytes);
    if (kind === 'jpeg') return shrinkJpeg(bytes);
    return { status: 'kept', reason: 'not a PNG or JPEG' };
  };
}
