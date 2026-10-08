/*
 * Page logic: choose a grid set, shrink its pictures in background workers,
 * then offer the smaller grid set as a download. Nothing leaves the browser.
 */
const C = window.GridCore;

const $ = (id) => document.getElementById(id);
const steps = ['step-choose', 'step-working', 'step-done', 'step-error'];
function show(step) {
  for (const s of steps) $(s).hidden = s !== step;
}

function formatSize(bytes) {
  if (bytes >= 1e9) return (bytes / 1e9).toFixed(2) + ' GB';
  if (bytes >= 1e6) return (bytes / 1e6).toFixed(1) + ' MB';
  return Math.max(1, Math.round(bytes / 1e3)) + ' KB';
}

function setProgress(done, total, text) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  $('progress-bar').style.width = pct + '%';
  $('progress-bar').parentElement.setAttribute('aria-valuenow', String(pct));
  if (text) $('working-status').textContent = text;
}

function showError(title, message) {
  $('error-title').textContent = title;
  $('error-message').textContent = message;
  show('step-error');
  $('error-button').focus();
}

/* ------------------------------------------------------------------ */
/* Worker pool                                                         */
/* ------------------------------------------------------------------ */
class Pool {
  constructor(size) {
    this.size = size;
    this.workers = [];
    this.queue = [];
    this.pending = new Map();
    this.nextId = 1;
    this.cancelled = false;
    try {
      for (let i = 0; i < size; i++) this.spawn();
    } catch (err) {
      this.terminate(err);
      throw err;
    }
  }

  spawn() {
    const w = new Worker(new URL('./worker.mjs', import.meta.url), { type: 'module' });
    w.busy = null;
    w.onmessage = (e) => this.finish(w, e.data);
    w.onerror = (e) => {
      e.preventDefault();
      // A broken worker script must not cause an endless respawn loop.
      this.terminate(new Error('The picture worker could not run.'));
    };
    this.workers.push(w);
    this.pump();
  }

  run(bytes, method) {
    return new Promise((resolve, reject) => {
      if (this.cancelled) { reject(new Error('The picture worker is unavailable.')); return; }
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.queue.push({ id, bytes, method });
      this.pump();
    });
  }

  pump() {
    for (const w of this.workers) {
      if (w.busy || !this.queue.length) continue;
      const job = this.queue.shift();
      w.busy = job;
      // Copy, so the original bytes stay available for the zip.
      const copy = job.bytes.slice().buffer;
      w.postMessage({ id: job.id, bytes: copy, method: job.method }, [copy]);
    }
  }

  finish(worker, msg) {
    if (worker) worker.busy = null;
    const p = this.pending.get(msg.id);
    if (p) {
      this.pending.delete(msg.id);
      if (msg.fatal) p.reject(new Error(msg.error));
      else p.resolve(msg);
    }
    this.pump();
  }

  terminate(error = new Error('cancelled')) {
    this.cancelled = true;
    for (const w of this.workers) w.terminate();
    for (const p of this.pending.values()) p.reject(error);
    this.pending.clear();
    this.queue = [];
  }
}

/* ------------------------------------------------------------------ */
/* Main flow                                                           */
/* ------------------------------------------------------------------ */
let currentPool = null;
let currentUrl = null;
let runId = 0;

async function handleFile(file) {
  if (!file) return;
  const id = ++runId;
  if (currentPool) { currentPool.terminate(); currentPool = null; }
  if (currentUrl) { URL.revokeObjectURL(currentUrl); currentUrl = null; }

  if (!/\.gridsetx?$/i.test(file.name)) {
    showError('This is not a grid set', `"${file.name}" is not a grid set. Please choose a file that ends in .gridset.`);
    return;
  }

  $('working-name').textContent = file.name;
  setProgress(0, 1, 'Opening the grid set…');
  show('step-working');

  let zip;
  try {
    const buffer = await file.arrayBuffer();
    if (id !== runId) return;
    zip = C.readZip(new Uint8Array(buffer));
    C.inspectGridset(zip);
  } catch (err) {
    if (id !== runId) return;
    if (err instanceof C.GridsetError) {
      const title = err.code === 'encrypted' ? 'This grid set is licensed' : "We couldn't open this file";
      showError(title, err.message);
    } else {
      console.error(err);
      showError("We couldn't open this file", 'Something went wrong while reading the grid set. Try exporting it from Grid 3 again.');
    }
    return;
  }

  // Find pictures. Identical pictures (very common) are only processed once.
  const groups = new Map();
  for (const e of zip.entries) {
    if (!C.isCandidateImage(e)) continue;
    const key = `${e.crc}:${e.usize}:${e.method}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }

  const jobs = [];
  for (const entries of groups.values()) {
    const first = entries[0];
    let bytes;
    try { bytes = C.inflateEntry(first); } catch (err) { continue; }
    const kind = C.sniff(bytes);
    if (kind === 'other') continue; // sounds, vector symbols, etc. are left alone
    jobs.push({ entries, bytes });
  }

  const total = jobs.length;
  if (!total) {
    showError('No pictures to shrink', 'This grid set has no photos or screenshots inside it, so there is nothing to make smaller.');
    return;
  }

  const size = Math.max(1, Math.min(6, (navigator.hardwareConcurrency || 4) - 1));
  let pool;
  let done = 0;
  const outcome = { shrunk: 0, kept: 0, reasons: new Map(), methods: new Map() };
  setProgress(0, total, `Shrinking pictures: 0 of ${total}`);

  try {
    pool = (currentPool = new Pool(size));
    await Promise.all(jobs.map(async (job) => {
      const res = await pool.run(job.bytes, job.entries[0].method);
      const n = job.entries.length;
      if (res.status === 'shrunk') {
        const packed = res.packed;
        for (const e of job.entries) e.replacement = packed;
        outcome.shrunk += n;
        outcome.methods.set(res.method, (outcome.methods.get(res.method) || 0) + n);
      } else {
        outcome.kept += n;
        outcome.reasons.set(res.reason, (outcome.reasons.get(res.reason) || 0) + n);
      }
      job.bytes = null;
      done++;
      setProgress(done, total, `Shrinking pictures: ${done} of ${total}`);
    }));
  } catch (err) {
    pool?.terminate();
    if (id !== runId) return; // cancelled or superseded
    currentPool = null;
    console.error(err);
    showError('Something went wrong', 'The picture tools could not start in this browser. Please try again in an up-to-date Chrome or Edge.');
    return;
  }
  pool.terminate();
  if (currentPool !== pool) return;
  currentPool = null;

  setProgress(total, total, 'Putting the grid set back together…');
  try {
  const parts = C.writeZip(zip.entries, zip.comment);
  const blob = new Blob(parts, { type: 'application/octet-stream' });
  currentUrl = URL.createObjectURL(blob);

  showResult(file, blob, outcome);
  } catch (err) {
    console.error(err);
    showError('Could not save the grid set', 'The finished file could not be created. Try a smaller grid set or close other browser tabs and try again.');
  }
}

function showResult(file, blob, outcome) {
  const before = file.size, after = blob.size;
  const saving = Math.max(0, 1 - after / before);
  $('size-before').textContent = formatSize(before);
  $('size-after').textContent = formatSize(after);
  $('size-saving').textContent = Math.round(saving * 100) + '%';

  const link = $('download-link');
  link.href = currentUrl;
  link.download = file.name;

  if (saving < 0.02 && outcome.reasons.get('already shrunk before')) {
    $('done-title').textContent = 'This grid set has already been shrunk';
    $('done-summary').textContent = 'Its pictures were made smaller before, so they have been left exactly as they are. You can keep using your original grid set.';
  } else if (saving < 0.02) {
    $('done-title').textContent = 'This grid set is already small';
    $('done-summary').textContent = 'We could not make the pictures any smaller without changing how they look. You can keep using your original grid set.';
  } else {
    $('done-title').textContent = 'Your grid set is ready';
    $('done-summary').textContent = `${outcome.shrunk} ${outcome.shrunk === 1 ? 'picture was' : 'pictures were'} made smaller. Nothing else was changed.`;
  }

  const labels = {
    lossless: 'stored more efficiently (no change at all)',
    colours: 'saved with a smaller colour palette',
    jpeg: 'saved as compressed photos',
  };
  const list = $('done-details');
  list.replaceChildren();
  const add = (text) => { const li = document.createElement('li'); li.textContent = text; list.append(li); };
  for (const [m, n] of outcome.methods) add(`${n} ${n === 1 ? 'picture' : 'pictures'} ${labels[m] || m}`);
  for (const [r, n] of outcome.reasons) add(`${n} ${n === 1 ? 'picture' : 'pictures'} left as they were (${r})`);
  add('Text, symbols, sounds, cell commands and settings were not changed.');

  show('step-done');
  link.focus();
}

/* ------------------------------------------------------------------ */
/* Wiring                                                              */
/* ------------------------------------------------------------------ */
function reset() {
  runId++;
  $('file-input').value = '';
  show('step-choose');
  $('file-input').focus();
}

$('file-input').addEventListener('change', (e) => handleFile(e.target.files[0]));

const zone = $('drop-zone');
['dragenter', 'dragover'].forEach((t) => zone.addEventListener(t, (e) => { e.preventDefault(); zone.classList.add('is-dragging'); }));
['dragleave', 'drop'].forEach((t) => zone.addEventListener(t, () => zone.classList.remove('is-dragging')));
zone.addEventListener('drop', (e) => {
  e.preventDefault();
  const file = e.dataTransfer.files[0];
  if (file) handleFile(file);
});
// Dropping a file anywhere else should not make the browser open it.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

$('cancel-button').addEventListener('click', () => {
  if (currentPool) { const p = currentPool; currentPool = null; p.terminate(); }
  reset();
});
$('again-button').addEventListener('click', reset);
$('error-button').addEventListener('click', reset);

window.addEventListener('beforeunload', (e) => {
  if (currentPool) { e.preventDefault(); e.returnValue = ''; }
});
