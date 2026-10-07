// Runs the same pipeline as the web page, in Node, for testing.
//   node tests/shrink-node.mjs <in.gridset> <out.gridset> [--log details.tsv]
import fs from 'fs';
import { createRequire } from 'module';
import { loadCodecs, createShrinker } from '../assets/js/shrink.mjs';

const require = createRequire(import.meta.url);
globalThis.ImageData ??= class ImageData { constructor(d, w, h) { this.data = d; this.width = w; this.height = h; } };
globalThis.self ??= globalThis;
const C = require('../assets/js/core.js');
const { ssim } = require('../assets/vendor/ssim/ssim.web.js');

const vendor = new URL('../assets/vendor/', import.meta.url);
const codecs = await loadCodecs(vendor.href, async (p) => new WebAssembly.Module(fs.readFileSync(new URL(p, vendor))));
const shrinkImage = createShrinker(codecs, ssim, C);

const [input, output] = process.argv.slice(2);
const logIdx = process.argv.indexOf('--log');
const log = logIdx > 0 ? fs.createWriteStream(process.argv[logIdx + 1]) : null;

const t0 = Date.now();
const zip = C.readZip(fs.readFileSync(input));
C.inspectGridset(zip);
const cache = new Map();
const stats = { shrunk: 0, kept: 0, methods: {}, reasons: {}, before: 0, after: 0 };
for (const e of zip.entries) {
  if (!C.isCandidateImage(e)) continue;
  const key = e.crc + ':' + e.usize;
  let res = cache.get(key);
  if (!res) {
    const data = C.inflateEntry(e);
    res = shrinkImage(data);
    cache.set(key, res);
    if (log) log.write([e.name, data.length, res.status, res.method || res.reason, res.data ? res.data.length : '', res.quality ? [res.quality.ssim.toFixed(4), res.quality.mean.toFixed(2), (res.quality.big * 100).toFixed(2)].join('\t') : ''].join('\t') + '\n');
  }
  stats[res.status]++;
  stats.before += e.usize;
  if (res.status === 'shrunk') {
    stats.methods[res.method] = (stats.methods[res.method] || 0) + 1;
    e.replacement = C.packReplacement(res.data, e.method);
    stats.after += res.data.length;
  } else {
    stats.reasons[res.reason] = (stats.reasons[res.reason] || 0) + 1;
    stats.after += e.usize;
  }
}
const parts = C.writeZip(zip.entries, zip.comment);
fs.writeFileSync(output, Buffer.concat(parts.map((p) => Buffer.from(p.buffer, p.byteOffset, p.length))));
log?.end();
const inSize = fs.statSync(input).size, outSize = fs.statSync(output).size;
console.log(JSON.stringify({ input, secs: (Date.now() - t0) / 1000, unique: cache.size, ...stats,
  MB: [+(inSize / 1e6).toFixed(1), +(outSize / 1e6).toFixed(1)], saved: ((1 - outSize / inSize) * 100).toFixed(1) + '%' }));
