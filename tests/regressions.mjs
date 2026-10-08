// Synthetic fixtures only: no private grid sets required.
// Run: node tests/regressions.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { createShrinker, loadCodecs, hasTag } from '../assets/js/shrink.mjs';
const require = createRequire(import.meta.url);
const C = require('../assets/js/core.js');
const { zipSync, strToU8, zlibSync } = require('../assets/vendor/fflate.min.js');
const fixture = () => zipSync({
  'Settings0/settings.xml': strToU8('<Settings/>'),
  'Grids/Home/grid.xml': strToU8('<Grid/>'),
  'Grids/Home/image.png': new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0]),
});
const original = fixture();
const zip = C.readZip(original);
assert.equal(C.inspectGridset(zip).gridCount, 1);
const roundtrip = C.readZip(Buffer.concat(C.writeZip(zip.entries, zip.comment)));
for (let i = 0; i < zip.entries.length; i++) {
  assert.deepEqual(C.inflateEntry(roundtrip.entries[i]), C.inflateEntry(zip.entries[i]));
}
assert.throws(() => C.readZip(original.subarray(0, original.length - 1)), C.GridsetError);
const oversized = original.slice();
const end = oversized.length - 22;
const central = new DataView(oversized.buffer).getUint32(end + 16, true);
new DataView(oversized.buffer).setUint32(central + 20, original.length, true);
assert.throws(() => C.readZip(oversized), C.GridsetError);
// A ZIP comment may itself contain an end-of-directory signature.
const comment = new Uint8Array(30);
comment.set([80, 75, 5, 6]);
assert.equal(C.readZip(Buffer.concat(C.writeZip(zip.entries, comment))).entries.length, 3);

const shrink = createShrinker({ decodePng() { throw new Error('must not decode'); } }, null, C);
function chunk(type, data = new Uint8Array()) {
  const bytes = new Uint8Array(12 + data.length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, data.length);
  bytes.set(strToU8(type), 4);
  bytes.set(data, 8);
  view.setUint32(8 + data.length, C.crc32(bytes, 4, 8 + data.length));
  return bytes;
}
for (const type of ['acTL', 'iCCP', 'gAMA', 'cHRM', 'eXIf', 'cICP']) {
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IDAT'), chunk(type), chunk('IEND')]);
  assert.equal(shrink(png).reason, 'animation or display metadata');
}
// sRGB must not override animation, ICC, orientation or HDR protection.
for (const type of ['acTL', 'iCCP', 'eXIf', 'cICP', 'mDCv', 'cLLi']) {
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('sRGB', Uint8Array.of(0)), chunk(type), chunk('IEND')]);
  assert.equal(shrink(png).reason, 'animation or display metadata');
}

// Exercise the actual page flow with controlled file reads and workers.
const elements = new Map();
function element(id) {
  if (!elements.has(id)) elements.set(id, {
    hidden: false, style: {}, listeners: {}, parentElement: { setAttribute() {} },
    addEventListener(type, fn) { this.listeners[type] = fn; },
    focus() {}, classList: { add() {}, remove() {} }, replaceChildren() {}, append() {},
  });
  return elements.get(id);
}
const workers = [];
class Worker {
  constructor() { workers.push(this); }
  postMessage() {}
  terminate() { this.stopped = true; }
}
const context = vm.createContext({
  window: { GridCore: C, addEventListener() {} },
  document: { getElementById: element, createElement: () => ({}) },
  navigator: { hardwareConcurrency: 2 }, Worker, URL, Blob, console: { error() {} }, Uint8Array,
});
const source = fs.readFileSync(new URL('../assets/js/app.js', import.meta.url), 'utf8')
  .replaceAll('import.meta.url', JSON.stringify(new URL('../assets/js/app.js', import.meta.url).href));
vm.runInContext(source, context);
let resolveRead;
context.file = { name: 'test.gridset', arrayBuffer: () => new Promise(resolve => { resolveRead = resolve; }) };
const pending = vm.runInContext('handleFile(file)', context);
element('cancel-button').listeners.click();
resolveRead(original);
await pending;
assert.equal(workers.length, 0, 'cancelled read must not start workers');
assert.equal(element('step-choose').hidden, false);
context.file = { name: 'test.gridset', arrayBuffer: async () => original };
const failed = vm.runInContext('handleFile(file)', context);
await new Promise(resolve => setImmediate(resolve));
assert.equal(workers.length, 1);
workers[0].onerror({ preventDefault() {} });
await failed;
assert.equal(workers.length, 1, 'failed workers must not be respawned');
assert.equal(workers[0].stopped, true);
assert.equal(element('step-error').hidden, false);

// Load the real vendored WASM codecs and perform a JPEG encode/decode.
globalThis.ImageData ??= class { constructor(data, width, height) { Object.assign(this, { data, width, height }); } };
globalThis.self ??= globalThis;
const vendor = new URL('../assets/vendor/', import.meta.url);
const codecs = await loadCodecs(vendor.href, async path => new WebAssembly.Module(fs.readFileSync(new URL(path, vendor))));
const pixels = { data: new Uint8ClampedArray(32 * 32 * 4).fill(255), width: 32, height: 32 };
const jpeg = codecs.encodeJpeg(pixels, 90);
assert.equal(codecs.decodeJpeg(jpeg).width, 32);
const png = codecs.optimisePng(codecs.quantize(pixels));
assert.equal(codecs.decodePng(png).height, 32);
const { ssim } = require('../assets/vendor/ssim/ssim.web.js');
const shrinkReal = createShrinker(codecs, ssim, C);
// Typical Grid 3 export: sRGB + gAMA must still be eligible for shrinking.
// Test either metadata order, and redundant cHRM as well.
const gamma = chunk('gAMA', Uint8Array.of(0, 0, 177, 143)); // 45455
const srgb = chunk('sRGB', Uint8Array.of(0));
const chrm = chunk('cHRM', Uint8Array.from(Buffer.from(
  '00007a26000080840000fa00000080e8000075300000ea6000003a9800001770', 'hex')));
const textPadding = chunk('tEXt', strToU8('Padding\0' + 'x'.repeat(10000)));
for (const metadata of [[srgb, gamma], [gamma, srgb], [srgb, gamma, chrm]]) {
  const exported = Buffer.concat([png.subarray(0, 33), ...metadata, textPadding, png.subarray(33)]);
  const reduced = shrinkReal(exported);
  assert.equal(reduced.status, 'shrunk', 'standard sRGB exports must not be skipped');
  assert.equal(hasTag(reduced.data), true);
  assert.equal(shrinkReal(reduced.data).reason, 'already shrunk before');
}
for (const intent of [new Uint8Array(), Uint8Array.of(4)]) {
  const invalid = Buffer.concat([png.subarray(0, 33), chunk('sRGB', intent), gamma, png.subarray(33)]);
  assert.equal(shrinkReal(invalid).reason, 'animation or display metadata');
}
// Exercise both PNG paths, including codecs that already retain an sRGB chunk.
function readChunks(bytes) {
  const chunks = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let at = 8; at < bytes.length;) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    assert.equal(view.getUint32(at + 8 + length), C.crc32(bytes, at + 4, at + 8 + length));
    chunks.push({ type, data: bytes.subarray(at + 8, at + 8 + length) });
    at += 12 + length;
  }
  return chunks;
}
const transparentPixels = { ...pixels, data: pixels.data.slice() };
for (let i = 3; i < transparentPixels.data.length; i += 4) transparentPixels.data[i] = 128;
// Uncompressed RGBA data gives the lossless path real savings to recover.
const header = new Uint8Array(13);
new DataView(header.buffer).setUint32(0, 32);
new DataView(header.buffer).setUint32(4, 32);
header[8] = 8; header[9] = 6;
const scanlines = new Uint8Array(32 * (1 + 32 * 4));
for (let y = 0; y < 32; y++) scanlines.set(transparentPixels.data.subarray(y * 128, (y + 1) * 128), y * 129 + 1);
const transparentPng = Buffer.concat([png.subarray(0, 8), chunk('IHDR', header),
  chunk('IDAT', zlibSync(scanlines, { level: 0 })), chunk('IEND')]);
for (const method of ['lossless', 'colours']) {
  for (const intent of [0, 1, 2, 3, null]) {
    for (const codecRetainsTag of [false, true]) {
      const sourceTag = intent === null ? [] : [chunk('sRGB', Uint8Array.of(intent))];
      const exported = Buffer.concat([transparentPng.subarray(0, 33), ...sourceTag,
        transparentPng.subarray(33)]);
      const selective = createShrinker({ ...codecs,
        optimisePng(data) {
          if (method === 'colours' && data === exported) throw new Error('test palette path');
          const output = codecs.optimisePng(data);
          const withoutTag = readChunks(output).filter(c => c.type !== 'sRGB');
          return Buffer.concat([output.subarray(0, 8), chunk('IHDR', withoutTag[0].data),
            ...(codecRetainsTag ? sourceTag : []), ...withoutTag.slice(1).map(c => chunk(c.type, c.data))]);
        },
        quantize(img) {
          if (method === 'lossless') throw new Error('test lossless path');
          return codecs.quantize(img);
        },
      }, ssim, C);
      const reduced = selective(exported);
      assert.equal(reduced.status, 'shrunk', JSON.stringify({ method, intent, codecRetainsTag, reduced }));
      assert.equal(reduced.method, method);
      const chunks = readChunks(reduced.data);
      const colourTags = chunks.filter(c => c.type === 'sRGB');
      assert.equal(colourTags.length, intent === null ? 0 : 1);
      if (intent !== null) {
        assert.deepEqual([...colourTags[0].data], [intent]);
        const index = chunks.findIndex(c => c.type === 'sRGB');
        assert.ok(index < chunks.findIndex(c => c.type === 'IDAT'));
        const palette = chunks.findIndex(c => c.type === 'PLTE');
        if (palette !== -1) assert.ok(index < palette);
      }
      assert.deepEqual(codecs.decodePng(reduced.data).data, codecs.decodePng(exported).data);
      assert.equal(selective(reduced.data).reason, 'already shrunk before');
    }
  }
}
// Add valid JPEG comments so that there is meaningful space to recover.
const padding = new Uint8Array(10004);
padding.set([255, 254, 39, 18]); // COM length = 10002 bytes
const largeJpeg = Buffer.concat([jpeg.subarray(0, 2), padding, jpeg.subarray(2)]);
const gridset = C.readZip(zipSync({
  'Settings0/settings.xml': strToU8('<Settings/>'),
  'Grids/Home/grid.xml': strToU8('<Grid/>'),
  'Grids/Home/photo.png': largeJpeg,
}));
const photo = gridset.entries[2];
const result = shrinkReal(C.inflateEntry(photo));
assert.equal(result.status, 'shrunk');
assert.equal(hasTag(result.data), true);
photo.replacement = C.packReplacement(result.data, photo.method);
const reopened = C.readZip(Buffer.concat(C.writeZip(gridset.entries, gridset.comment)));
assert.equal(C.inspectGridset(reopened).gridCount, 1);
assert.deepEqual(C.inflateEntry(reopened.entries[0]), strToU8('<Settings/>'));
assert.deepEqual(C.inflateEntry(reopened.entries[1]), strToU8('<Grid/>'));
assert.equal(shrinkReal(C.inflateEntry(reopened.entries[2])).reason, 'already shrunk before');
console.log('Regression checks passed (ZIP validation, metadata, cancellation, worker failure, real codecs).');

