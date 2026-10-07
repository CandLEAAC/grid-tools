/*
 * Page logic: choose a gridset, shrink its pictures in background workers,
 * then offer the smaller gridset as a download. Nothing leaves the browser.
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
    for (let i = 0; i < size; i++) this.spawn();
  }

  spawn() {
    const w = new Worker(new URL('./worker.mjs', import.meta.url), { type: 'module' });
    w.busy = null;
    w.onmessage = (e) => this.finish(w, e.data);
    w.onerror = (e) => {
      e.preventDefault();
      // A worker crashed (for example out of memory): keep that picture unchanged and carry on.
      const job = w.busy;
      this.workers = this.workers.filter((x) => x !== w);
      w.terminate();
      if (!this.cancelled) this.spawn();
      if (job) this.finish(null, { id: job.id, status: 'kept', reason: 'picture could not be processed' });
    };
    this.workers.push(w);
    this.pump();
  }

  run(bytes, method) {
    return new Promise((resolve, reject) => {
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

  terminate() {
    this.cancelled = true;
    for (const w of this.workers) w.terminate();
    for (const p of this.pending.values()) p.reject(new Error('cancelled'));
    this.pending.clear();
    this.queue = [];
  }
}

/* ------------------------------------------------------------------ */
/* Main flow                                                           */
/* ------------------------------------------------------------------ */
let currentPool = null;
let currentUrl = null;

async function handleFile(file) {
  if (!file) return;
  if (currentUrl) { URL.revokeObjectURL(currentUrl); currentUrl = null; }

  if (!/\.gridsetx?$/i.test(file.name)) {
    showError('This is not a gridset', `"${file.name}" is not a gridset. Please choose a file that ends in .gridset.`);
    return;
  }

  $('working-name').textContent = file.name;
  setProgress(0, 1, 'Opening the gridset…');
  show('step-working');

  let zip;
  try {
    zip = C.readZip(new Uint8Array(await file.arrayBuffer()));
    C.inspectGridset(zip);
  } catch (err) {
    if (err instanceof C.GridsetError) {
      const title = err.code === 'encrypted' ? 'This gridset is encrypted' : "We couldn't open this file";
      showError(title, err.message);
    } else {
      console.error(err);
      showError("We couldn't open this file", 'Something went wrong while reading the gridset. Try exporting it from Grid 3 again.');
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
    showError('No pictures to shrink', 'This gridset has no photos or screenshots inside it, so there is nothing to make smaller.');
    return;
  }

  const size = Math.max(1, Math.min(6, (navigator.hardwareConcurrency || 4) - 1));
  const pool = (currentPool = new Pool(size));
  let done = 0;
  const outcome = { shrunk: 0, kept: 0, reasons: new Map(), methods: new Map() };
  setProgress(0, total, `Shrinking pictures: 0 of ${total}`);

  try {
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
    pool.terminate();
    if (currentPool !== pool) return; // cancelled
    currentPool = null;
    console.error(err);
    showError('Something went wrong', 'The picture tools could not start in this browser. Please try again in an up-to-date Chrome or Edge.');
    return;
  }
  pool.terminate();
  if (currentPool !== pool) return;
  currentPool = null;

  setProgress(total, total, 'Putting the gridset back together…');
  const parts = C.writeZip(zip.entries, zip.comment);
  const blob = new Blob(parts, { type: 'application/octet-stream' });
  currentUrl = URL.createObjectURL(blob);

  showResult(file, blob, outcome);
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

  if (saving < 0.02) {
    $('done-title').textContent = 'This gridset is already small';
    $('done-summary').textContent = 'We could not make the pictures any smaller without changing how they look. You can keep using your original gridset.';
  } else {
    $('done-title').textContent = 'Your gridset is ready';
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
  add('Words, symbols, sounds, buttons and settings were not changed.');

  show('step-done');
  link.focus();
}

/* ------------------------------------------------------------------ */
/* Wiring                                                              */
/* ------------------------------------------------------------------ */
function reset() {
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
