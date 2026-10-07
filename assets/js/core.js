/*
 * Gridset Image Shrinker — gridset/ZIP handling.
 *
 * Pure functions with no DOM access, so the same file runs in the page,
 * in a Web Worker and in Node (for the test suite).
 *
 *   - ZIP reading / writing that copies every untouched entry byte-for-byte
 *   - Gridset checks (is it a gridset? is it encrypted?)
 *   - Small helpers for recognising picture formats
 *
 * All picture processing itself lives in shrink.mjs and uses established
 * codec libraries (oxipng, libimagequant, MozJPEG).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../vendor/fflate.min.js'));
  } else {
    root.GridCore = factory(root.fflate);
  }
})(typeof self !== 'undefined' ? self : this, function (fflate) {
  'use strict';

  /* ------------------------------------------------------------------ */
  /* CRC32                                                               */
  /* ------------------------------------------------------------------ */
  const CRC_TABLE = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })();

  function crc32(data, start = 0, end = data.length, seed = 0) {
    let c = seed ^ -1;
    for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  }

  /* ------------------------------------------------------------------ */
  /* Errors shown to users                                               */
  /* ------------------------------------------------------------------ */
  class GridsetError extends Error {
    constructor(code, message) {
      super(message);
      this.code = code;
    }
  }

  /* ------------------------------------------------------------------ */
  /* ZIP reader                                                          */
  /* ------------------------------------------------------------------ */
  const u16 = (b, o) => b[o] | (b[o + 1] << 8);
  const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

  function readZip(buf) {
    const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    if (b.length < 22 || u32(b, 0) !== 0x04034b50) {
      throw new GridsetError('not-zip', 'This file is not a gridset (it is not in the format Grid 3 uses).');
    }
    // End of central directory: search backwards (a comment may follow it).
    let eocd = -1;
    for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 0xffff); i--) {
      if (u32(b, i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new GridsetError('not-zip', 'This file looks damaged or incomplete. Try exporting the gridset again.');

    const count = u16(b, eocd + 10);
    const cdSize = u32(b, eocd + 12);
    const cdOffset = u32(b, eocd + 16);
    if (count === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) {
      throw new GridsetError('zip64', 'This gridset is too large for this tool (over 4 GB).');
    }
    const comment = b.subarray(eocd + 22, eocd + 22 + u16(b, eocd + 20));

    const entries = [];
    let p = cdOffset;
    for (let i = 0; i < count; i++) {
      if (u32(b, p) !== 0x02014b50) throw new GridsetError('not-zip', 'This file looks damaged or incomplete. Try exporting the gridset again.');
      const e = {
        versionMadeBy: u16(b, p + 4),
        versionNeeded: u16(b, p + 6),
        flags: u16(b, p + 8),
        method: u16(b, p + 10),
        time: u16(b, p + 12),
        date: u16(b, p + 14),
        crc: u32(b, p + 16),
        csize: u32(b, p + 20),
        usize: u32(b, p + 24),
        internalAttr: u16(b, p + 36),
        externalAttr: u32(b, p + 38),
        localOffset: u32(b, p + 42),
      };
      const nLen = u16(b, p + 28), xLen = u16(b, p + 30), cLen = u16(b, p + 32);
      e.nameBytes = b.subarray(p + 46, p + 46 + nLen);
      e.centralExtra = b.subarray(p + 46 + nLen, p + 46 + nLen + xLen);
      e.comment = b.subarray(p + 46 + nLen + xLen, p + 46 + nLen + xLen + cLen);
      e.name = decodeName(e.nameBytes, e.flags);
      if (e.csize === 0xffffffff || e.usize === 0xffffffff || e.localOffset === 0xffffffff) {
        throw new GridsetError('zip64', 'This gridset is too large for this tool (over 4 GB).');
      }
      const lp = e.localOffset;
      if (u32(b, lp) !== 0x04034b50) throw new GridsetError('not-zip', 'This file looks damaged or incomplete. Try exporting the gridset again.');
      const lnLen = u16(b, lp + 26), lxLen = u16(b, lp + 28);
      e.localExtra = b.subarray(lp + 30 + lnLen, lp + 30 + lnLen + lxLen);
      const dataStart = lp + 30 + lnLen + lxLen;
      e.raw = b.subarray(dataStart, dataStart + e.csize);
      entries.push(e);
      p += 46 + nLen + xLen + cLen;
    }
    return { entries, comment };
  }

  function decodeName(bytes, flags) {
    if (flags & 0x800) return new TextDecoder('utf-8').decode(bytes);
    // Legacy names: Grid 3 only writes ASCII names without the UTF-8 flag.
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return s;
  }

  function isEncryptedEntry(e) {
    return (e.flags & 1) !== 0;
  }

  function inflateEntry(e) {
    if (isEncryptedEntry(e)) throw new GridsetError('encrypted', 'encrypted entry');
    let out;
    if (e.method === 0) out = e.raw;
    else if (e.method === 8) out = fflate.inflateSync(e.raw, { out: new Uint8Array(e.usize) });
    else throw new GridsetError('unsupported', 'This gridset uses a compression type this tool does not support.');
    if (out.length !== e.usize || crc32(out) !== e.crc) {
      throw new GridsetError('corrupt', `The file "${e.name}" inside the gridset is damaged.`);
    }
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* ZIP writer                                                          */
  /* Entries keep their original order, names, dates and attributes.     */
  /* Entries with no `replacement` are copied byte-for-byte.             */
  /* ------------------------------------------------------------------ */
  function writeZip(entries, comment) {
    const parts = [];
    const central = [];
    let offset = 0;

    for (const e of entries) {
      const r = e.replacement; // { raw, method, crc, usize }
      const raw = r ? r.raw : e.raw;
      const method = r ? r.method : e.method;
      const crc = r ? r.crc : e.crc;
      const usize = r ? r.usize : e.usize;
      // Bit 3 (data descriptor) is cleared because sizes are written up front.
      const flags = e.flags & ~0x8;

      const lh = new Uint8Array(30 + e.nameBytes.length + e.localExtra.length);
      const lv = new DataView(lh.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, e.versionNeeded, true);
      lv.setUint16(6, flags, true);
      lv.setUint16(8, method, true);
      lv.setUint16(10, e.time, true);
      lv.setUint16(12, e.date, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, raw.length, true);
      lv.setUint32(22, usize, true);
      lv.setUint16(26, e.nameBytes.length, true);
      lv.setUint16(28, e.localExtra.length, true);
      lh.set(e.nameBytes, 30);
      lh.set(e.localExtra, 30 + e.nameBytes.length);
      parts.push(lh, raw);

      const ch = new Uint8Array(46 + e.nameBytes.length + e.centralExtra.length + e.comment.length);
      const cv = new DataView(ch.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, e.versionMadeBy, true);
      cv.setUint16(6, e.versionNeeded, true);
      cv.setUint16(8, flags, true);
      cv.setUint16(10, method, true);
      cv.setUint16(12, e.time, true);
      cv.setUint16(14, e.date, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, raw.length, true);
      cv.setUint32(24, usize, true);
      cv.setUint16(28, e.nameBytes.length, true);
      cv.setUint16(30, e.centralExtra.length, true);
      cv.setUint16(32, e.comment.length, true);
      cv.setUint16(34, 0, true);
      cv.setUint16(36, e.internalAttr, true);
      cv.setUint32(38, e.externalAttr, true);
      cv.setUint32(42, offset, true);
      ch.set(e.nameBytes, 46);
      ch.set(e.centralExtra, 46 + e.nameBytes.length);
      ch.set(e.comment, 46 + e.nameBytes.length + e.centralExtra.length);
      central.push(ch);

      offset += lh.length + raw.length;
      if (offset > 0xffffffff) throw new GridsetError('zip64', 'The finished gridset would be too large (over 4 GB).');
    }

    const cdStart = offset;
    let cdSize = 0;
    for (const c of central) { parts.push(c); cdSize += c.length; }

    const end = new Uint8Array(22 + comment.length);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, entries.length, true);
    ev.setUint16(10, entries.length, true);
    ev.setUint32(12, cdSize, true);
    ev.setUint32(16, cdStart, true);
    ev.setUint16(20, comment.length, true);
    end.set(comment, 22);
    parts.push(end);
    return parts;
  }

  /* Compress replacement image bytes the same way the original was stored. */
  function packReplacement(data, method) {
    const crc = crc32(data);
    if (method === 0) return { raw: data, method: 0, crc, usize: data.length };
    return { raw: fflate.deflateSync(data, { level: 6 }), method: 8, crc, usize: data.length };
  }

  /* ------------------------------------------------------------------ */
  /* Gridset inspection                                                  */
  /* ------------------------------------------------------------------ */
  function looksLikeXml(bytes) {
    let i = 0;
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) i = 3; // UTF-8 BOM
    else if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)) return true; // UTF-16 BOM
    while (i < bytes.length && (bytes[i] === 0x20 || bytes[i] === 0x09 || bytes[i] === 0x0a || bytes[i] === 0x0d)) i++;
    return bytes[i] === 0x3c; // '<'
  }

  const ENCRYPTED_MESSAGE =
    'This gridset is encrypted (protected), so its pictures cannot be read or changed. ' +
    'Please use the original, unprotected .gridset file instead.';

  /**
   * Throws a GridsetError if the zip is not a usable, unencrypted gridset.
   * Returns summary info otherwise.
   */
  function inspectGridset(zip) {
    const { entries } = zip;
    const lower = (s) => s.replace(/\\/g, '/').toLowerCase();
    const settings = entries.find((e) => lower(e.name) === 'settings0/settings.xml');
    const grids = entries.filter((e) => /^grids\/[^/]+\/grid\.xml$/.test(lower(e.name)));

    if (!settings || grids.length === 0) {
      throw new GridsetError('not-gridset', 'This file does not look like a Grid 3 gridset. Please choose a .gridset file exported from Grid 3.');
    }
    if (entries.some(isEncryptedEntry)) {
      throw new GridsetError('encrypted', ENCRYPTED_MESSAGE);
    }
    for (const e of entries) {
      if (!lower(e.name).endsWith('.xml')) continue;
      let data;
      try { data = inflateEntry(e); } catch (err) {
        if (err instanceof GridsetError && err.code !== 'corrupt') throw err;
        // Encrypted content usually fails to inflate or fails CRC.
        throw new GridsetError('encrypted', ENCRYPTED_MESSAGE);
      }
      if (data.length > 0 && !looksLikeXml(data)) throw new GridsetError('encrypted', ENCRYPTED_MESSAGE);
    }
    return { gridCount: grids.length };
  }

  /** Which entries are embedded pictures we may optimise. */
  function isCandidateImage(e) {
    const n = e.name.replace(/\\/g, '/');
    if (!/^Grids\//i.test(n)) return false; // only pictures inside grids
    if (n.endsWith('/')) return false;
    if (/\.xml$/i.test(n)) return false;
    return e.usize > 0;
  }

  function sniff(bytes) {
    if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
        bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return 'png';
    if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
    return 'other';
  }

  function exifOrientation(t) {
    try {
      const le = t[0] === 0x49;
      const r16 = (o) => (le ? t[o] | (t[o + 1] << 8) : (t[o] << 8) | t[o + 1]);
      const r32 = (o) => (le ? (t[o] | (t[o + 1] << 8) | (t[o + 2] << 16) | (t[o + 3] << 24)) : ((t[o] << 24) | (t[o + 1] << 16) | (t[o + 2] << 8) | t[o + 3])) >>> 0;
      const ifd = r32(4);
      const count = r16(ifd);
      for (let i = 0; i < count; i++) {
        const e = ifd + 2 + i * 12;
        if (r16(e) === 0x0112) return r16(e + 8);
      }
      return 0;
    } catch (e) {
      return 9; // unreadable EXIF: treat as rotated so the picture is left alone
    }
  }

  /** Information about a JPEG needed to decide whether re-encoding is safe. */
  function jpegInfo(b) {
    const info = { icc: false, adobe: false, orientation: 0, components: 0, progressive: false };
    let p = 2;
    while (p + 4 <= b.length && b[p] === 0xff) {
      const m = b[p + 1];
      if (m === 0xff) { p++; continue; }
      if (m === 0xda || m === 0xd9) break;
      if (m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { p += 2; continue; }
      const len = (b[p + 2] << 8) | b[p + 3];
      const seg = b.subarray(p, p + 2 + len);
      if (m === 0xe2 && String.fromCharCode(...seg.subarray(4, 15)) === 'ICC_PROFILE') info.icc = true;
      if (m === 0xee) info.adobe = true;
      if (m === 0xe1 && String.fromCharCode(...seg.subarray(4, 10)) === 'Exif\0\0') info.orientation = exifOrientation(seg.subarray(10));
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        info.components = seg[9];
        info.progressive = m === 0xc2;
        info.width = (seg[7] << 8) | seg[8];
        info.height = (seg[5] << 8) | seg[6];
      }
      p += 2 + len;
    }
    return info;
  }

  return {
    crc32, readZip, writeZip, inflateEntry, packReplacement, inspectGridset, isCandidateImage, sniff, jpegInfo,
    GridsetError,
  };
});
