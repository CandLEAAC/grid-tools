/*
 * Background worker: shrinks one picture at a time so the page stays responsive.
 * Several of these run side by side (see app.js).
 */
import '../vendor/fflate.min.js';
import '../vendor/ssim/ssim.web.js';
import './core.js';
import { loadCodecs, createShrinker } from './shrink.mjs';

const vendor = new URL('../vendor/', import.meta.url).href;

async function getWasm(path) {
  const res = await fetch(vendor + path);
  if (!res.ok) throw new Error('Could not load ' + path);
  return WebAssembly.compile(await res.arrayBuffer());
}

const ready = loadCodecs(vendor, getWasm).then((codecs) =>
  createShrinker(codecs, self.ssim.ssim, self.GridCore));

self.onmessage = async (event) => {
  const { id, bytes, method } = event.data;
  let shrinkImage;
  try {
    shrinkImage = await ready;
  } catch (err) {
    self.postMessage({ id, fatal: true, error: String(err && err.message || err) });
    return;
  }
  let result;
  try {
    result = shrinkImage(new Uint8Array(bytes));
  } catch (err) {
    result = { status: 'kept', reason: 'picture could not be processed' };
  }
  if (result.status === 'shrunk') {
    // Compress and checksum here so the page does not have to.
    const packed = self.GridCore.packReplacement(result.data, method);
    self.postMessage({ id, status: 'shrunk', method: result.method, size: result.data.length, packed }, [packed.raw.buffer]);
  } else {
    self.postMessage({ id, status: 'kept', reason: result.reason });
  }
};
