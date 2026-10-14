// qpdf (Apache-2.0) compiled to WebAssembly, for password protection, repair and saving adjusted page images.
// Runs entirely on this device; the .wasm is served by superPDF itself. The work is done by ./qpdf-core.js.
// In the browser each call runs in its own module worker (./qpdf-worker.js), so a large file never freezes
// the page. Node (the CLI and tests), and a browser that can't start the worker, run it on this thread.
//
// Input is a Uint8Array, an ArrayBuffer or a Blob/File. A Uint8Array or ArrayBuffer is moved to the worker
// (transferred, not copied), so in the browser the caller's array is empty afterwards; results come back the
// same way. A File is read by the worker from disk as qpdf needs it: use that when the page hasn't read the
// file already. When it has (the tool pages read every file to count its pages), handing over those bytes is
// faster and uses less memory than reading the file a second time.
import * as core from './qpdf-core.js';

export { setQpdfWasm } from './qpdf-core.js';

// The same wording validation.js uses for these cases, so batch reports read the same as single jobs.
const OUT_OF_MEMORY = 'Your browser ran out of memory. Close other tabs or choose a smaller file, then try again.';
const UNKNOWN = 'Something went wrong. Try again, or reload the page if it keeps happening.';

/** A started worker, or null where none can run (Node, old browsers, a blocked script): then the caller works in-thread. */
function startWorker() {
  if (typeof Worker !== 'function' || typeof window !== 'object') return Promise.resolve(null);
  return new Promise(resolve => {
    let worker;
    try { worker = new Worker(new URL('./qpdf-worker.js', import.meta.url), { type: 'module', name: 'superpdf-qpdf' }); }
    catch { resolve(null); return; }
    // The job is only sent once the worker says it has loaded, so if it can't load, the input is still here.
    worker.onmessage = ({ data }) => { if (data?.ready) resolve(worker); };
    worker.onerror = event => { event.preventDefault?.(); worker.terminate(); resolve(null); };
  });
}

/** The input as a message plus what to transfer with it. Nothing is structured-cloned byte by byte. */
function pack(input) {
  if (input instanceof ArrayBuffer) return { input, transfer: [input] };
  if (input instanceof Uint8Array) {
    // A view over part of a larger buffer is copied first: moving the whole buffer would empty memory
    // that isn't this file's.
    const bytes = input.byteOffset === 0 && input.byteLength === input.buffer.byteLength ? input : input.slice();
    return { input: bytes, transfer: [bytes.buffer] };
  }
  return { input, transfer: [] }; // a Blob or File is passed by reference
}

// `piece` receives the output of a job that sends it a piece at a time (replacePageImages) as it comes. Aborting
// `signal` stops the worker at once and rejects with signal.reason.
async function run(operation, input, options, piece, signal) {
  const worker = await startWorker();
  if (!worker) return core[operation](input, options, piece);
  return new Promise((resolve, reject) => {
    const fail = message => { worker.terminate(); reject(new Error(message)); };
    signal?.addEventListener('abort', () => { worker.terminate(); reject(signal.reason); }, { once: true });
    worker.onmessage = ({ data }) => {
      if (data.piece) { piece(data.piece); return; }
      worker.terminate();
      if (data.error) reject(Object.assign(new Error(data.error.message), { name: data.error.name }));
      else resolve(data.value);
    };
    // Every error inside a job is caught and sent back, so a worker that stops was almost always out of memory.
    worker.onerror = event => { event.preventDefault?.(); fail(OUT_OF_MEMORY); };
    worker.onmessageerror = () => fail(UNKNOWN);
    const message = pack(input);
    worker.postMessage({ operation, input: message.input, options }, message.transfer);
  });
}

/** 'none' | 'owner-only' (opens without a password; restrictions apply) | 'password' (needs a password to open). */
export const encryptionState = input => run('encryptionState', input);
/** AES-256 encryption. Without a separate owner password, the open password also controls permissions. */
export const protectPdf = (input, options) => run('protectPdf', input, options);
/** Remove encryption using a password the user knows. Never guesses or bypasses passwords. */
export const unlockPdf = (input, options) => run('unlockPdf', input, options);
/**
 * A PDF with only an owner password opens without a password (permissions are restricted), but pdf-lib can't read
 * it encrypted: its bytes decrypted, as the command-line tool does. Null for any other file. Pass a File in the
 * browser: a Uint8Array would be moved to the worker by the first check.
 */
export const decryptOwnerOnly = async input => ((await encryptionState(input)) === 'owner-only' ? new Uint8Array(await unlockPdf(input)) : null);
/** Repair: qpdf rewrites the file and reports what it fixed; pdf-lib rebuilds a broken cross-reference table. Returns {bytes, warnings}. */
export const repairPdf = input => run('repairPdf', input);
/**
 * Enhance scanned PDF: puts each image ({page, data, width, height, colorSpace, bitsPerComponent, filter}) in place of its
 * page's content. Returns the new PDF as a Blob, built from the pieces as they arrive so the page never holds it whole;
 * or null when it was written to `saveTo` ([folder, file] in the site's private storage, OPFS) instead.
 * Aborting `signal` stops it.
 */
export async function replacePageImages(input, images, { saveTo, signal } = {}) {
  const parts = [];
  const { saved } = await run('replacePageImages', input, { images, saveTo }, bytes => parts.push(new Blob([bytes])), signal);
  return saved ? null : new Blob(parts, { type: 'application/pdf' });
}

/**
 * Files at least this large are edited a few pages at a time (editPages) instead of whole: loading a PDF with pdf-lib
 * takes several times its size in memory, which a 1 GB file can't spare on most laptops.
 */
export const SPLICE_MIN_BYTES = 64 * 1024 * 1024;

/**
 * Edit some pages of a large PDF (a File or Blob) without loading the rest. `pages`: page indices; `edit(bytes, at)`
 * gets a small PDF holding just those pages, where page index `at(i)` is page i of the large file, and returns it
 * edited, as the tool would edit the whole document. The edited pages are put back in place by qpdf in a worker.
 * `options`: {redact, metadata} for splicePages. Returns the new PDF as a Blob, built from pieces as they arrive.
 */
export async function editPages(file, pages, edit, options = {}) {
  const indices = [...new Set(pages)].sort((a, b) => a - b);
  const { bytes: before, original } = await run('extractPages', file, { pages: indices, scan: Boolean(options.redact) });
  const after = await edit(before, i => indices.indexOf(i));
  const parts = [];
  await run('splicePages', file, { ...options, before, after, original }, bytes => parts.push(new Blob([bytes])));
  return new Blob(parts, { type: 'application/pdf' });
}
