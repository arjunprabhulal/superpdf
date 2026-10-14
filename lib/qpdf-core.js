// qpdf (Apache-2.0) compiled to WebAssembly, for password protection, repair and saving adjusted page images. This module does the work
// on whatever thread loads it: in the browser that is ./qpdf-worker.js (started by ./qpdf.js), in Node the
// CLI and tests. Use ./qpdf.js rather than this module, so the page never runs qpdf itself.
// Each call creates a fresh instance: qpdf's main() is not re-entrant, and the compiled module is cached.
import createQpdf from '@neslinesli93/qpdf-wasm';
import { PDFDocument } from 'pdf-lib';

let locateWasm = async () => (await import('@neslinesli93/qpdf-wasm/dist/qpdf.wasm?url')).default;
/** Node and tests point qpdf at the .wasm file on disk. */
export function setQpdfWasm(path) { locateWasm = async () => path; }

// This build ignores Emscripten's print/printErr hooks (it binds console.log/error directly), so each
// instance gets its own stdout/stderr devices through FS.init before qpdf runs. Nothing global is
// swapped, so overlapping calls (API requests beside a job) can't mix their output or leave console replaced.
const clean = line => line.replace(/^[^:\n]*?: (?:\/file)?\/in\.pdf(?: \([^)]*\))?: /, '').replace(/^[^:\n]*?: /, '').trim();

function lineCollector(lines) {
  const decoder = new TextDecoder();
  let bytes = [];
  const flush = () => { if (bytes.length) lines.push(decoder.decode(new Uint8Array(bytes))); bytes = []; };
  const write = byte => { if (byte === null || byte === 10) flush(); else if (byte !== 0) bytes.push(byte & 255); };
  return { write, flush };
}

// WORKERFS (in this build, and only usable in a worker: it reads with FileReaderSync) lets qpdf read a File
// or Blob where it lies, a slice at a time, so a large file is never copied into memory to be processed.
const canMountBlob = () => typeof FileReaderSync === 'function';

// WORKERFS makes one FileReaderSync call per read, and qpdf reads in small pieces, so copying a large file
// meant hundreds of thousands of calls. A mounted file is read ahead instead: one call per READ_AHEAD bytes.
// WORKERFS asks the file for slice(begin, end) and passes the slice to its FileReaderSync's
// readAsArrayBuffer, whose result it copies; the reader below answers those slices from the read-ahead.
const READ_AHEAD = 4 * 1024 * 1024;
if (canMountBlob()) {
  // The method, not a subclass: WebKit's FileReaderSync can't be extended.
  const read = FileReaderSync.prototype.readAsArrayBuffer;
  FileReaderSync.prototype.readAsArrayBuffer = function (part) { return part?.readAhead ? part.readAhead() : read.call(this, part); };
}
// One read-ahead for all mounted files (qpdf reads one at a time), so many small files don't each keep one.
let ahead = { blob: null, start: 0, bytes: new Uint8Array(0) };
function readAhead(blob) {
  const read = (begin, end) => {
    if (ahead.blob !== blob || begin < ahead.start || end > ahead.start + ahead.bytes.length) {
      const bytes = new Uint8Array(new FileReaderSync().readAsArrayBuffer(blob.slice(begin, Math.max(end, begin + READ_AHEAD))));
      ahead = { blob, start: begin, bytes };
    }
    return ahead.bytes.subarray(begin - ahead.start, end - ahead.start);
  };
  return { size: blob.size, slice: (begin, end) => { end = Math.min(end, blob.size); return { size: end - begin, readAhead: () => read(begin, end) }; } };
}

/** Bytes of a Uint8Array, ArrayBuffer or Blob, for the code paths that need the whole file in memory. */
async function bytesOf(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  return new Uint8Array(await input.arrayBuffer());
}

/**
 * Put files ([name, data] pairs) where qpdf can open them, without copying them when possible. Returns their paths.
 * In a worker a Blob or File is mounted where it lies; anything else is written to memory.
 */
async function placeFiles(instance, files) {
  const mounted = canMountBlob() ? files.filter(([, data]) => typeof Blob === 'function' && data instanceof Blob) : [];
  if (mounted.length) {
    instance.FS.mkdir('/file');
    instance.FS.mount(instance.WORKERFS, { blobs: mounted.map(([name, data]) => ({ name, data: readAhead(data) })) }, '/file');
  }
  const paths = [];
  for (const [name, data] of files) {
    if (mounted.some(([mountedName]) => mountedName === name)) { paths.push(`/file/${name}`); continue; }
    // canOwn (the last argument) makes MEMFS keep this array as the file instead of copying it. qpdf only
    // reads its input, so the caller's bytes are left as they were.
    const bytes = await bytesOf(data);
    const stream = instance.FS.open(`/${name}`, 'w');
    try { instance.FS.write(stream, bytes, 0, bytes.length, 0, true); } finally { instance.FS.close(stream); }
    paths.push(`/${name}`);
  }
  return paths;
}

// qpdf exit codes: 0 success, 2 error, 3 success with warnings. `output` is the file qpdf writes: false for a check
// that writes nothing, '-' for standard output, handed to `stdout` a byte at a time. `files` ([name, data]) are
// placed beside the input; `args` can then be a function of their paths, the qpdf instance and the input's path.
// `primary: false` leaves the input off the end of the command, for commands that name it themselves (--empty --pages).
async function qpdf(args, input, { output = '/out.pdf', files = [], stdout = null, primary = true } = {}) {
  const wasm = await locateWasm();
  const lines = [];
  const out = lineCollector(lines);
  const instance = await createQpdf({
    locateFile: () => wasm,
    noInitialRun: true,
    preRun: [mod => mod.FS.init(null, stdout || out.write, out.write)],
  });
  const [path, ...paths] = await placeFiles(instance, [['in.pdf', input], ...files]);
  if (typeof args === 'function') args = args(paths, instance, path);
  // Under Node, Emscripten copies qpdf's exit status into process.exitCode; keep the host's own.
  const hostExitCode = globalThis.process?.exitCode;
  let code;
  try { code = instance.callMain([...args, ...(primary ? [path] : []), ...(output ? [output] : [])]); }
  catch (e) { code = typeof e?.status === 'number' ? e.status : 2; lines.push(String(e?.message || e)); }
  finally { out.flush(); if (globalThis.process) globalThis.process.exitCode = hostExitCode; }
  let written = null;
  if (output && output !== '-') try { written = instance.FS.readFile(output); } catch { /* no output on error */ }
  const messages = lines.map(clean).filter(line => line && !/--help|^For help/.test(line));
  return { code, messages, output: written };
}

/** 'none' | 'owner-only' (opens without a password; restrictions apply) | 'password' (needs a password to open). */
export async function encryptionState(input) {
  // One cheap qpdf check, which reads only the file's trailer and encryption dictionary: 3 means encrypted
  // but openable without a password. This build reports a file that needs a password as an error
  // ("invalid password") rather than with exit code 0, so both are read as 'password'.
  const { code, messages } = await qpdf(['--requires-password'], input, { output: false });
  if (code === 0 || messages.some(m => /invalid password/i.test(m))) return 'password';
  if (code === 3) return 'owner-only';
  if (!messages.length) return 'none';
  // qpdf couldn't read the file (damaged). pdf-lib is more forgiving: if it finds an encryption dictionary,
  // the file needs a password qpdf can't use, so treat it as protected; otherwise qpdf diagnoses it later.
  try { return (await PDFDocument.load(await bytesOf(input), { ignoreEncryption: true, updateMetadata: false })).isEncrypted ? 'password' : 'none'; }
  catch { return 'none'; }
}

const validPassword = (value, label) => {
  if (typeof value !== 'string' || !value) throw new Error(`${label} is required.`);
  if (value.length > 127) throw new Error(`${label} must be 127 characters or fewer.`);
  return value;
};

/** AES-256 encryption. Without a separate owner password, the open password also controls permissions. */
export async function protectPdf(input, { password, ownerPassword = '' } = {}) {
  validPassword(password, 'Password');
  if ((await encryptionState(input)) !== 'none') throw new Error('This PDF is already protected. Remove its password first.');
  const { code, messages, output } = await qpdf(
    // The named forms (qpdf 11.7+; this build is 12.2) keep a password like '-o' or '--' from being read as an option.
    ['--encrypt', `--user-password=${password}`, `--owner-password=${ownerPassword || password}`, '--bits=256', '--'], input);
  if (code === 2 || !output) throw new Error(messages[0] ? `superPDF couldn’t protect this PDF (${messages[0]}).` : 'superPDF couldn’t protect this PDF.');
  return output;
}

/** Remove encryption using a password the user knows. Never guesses or bypasses passwords. */
export async function unlockPdf(input, { password = '' } = {}) {
  const state = await encryptionState(input);
  if (state === 'none') throw new Error('This PDF isn’t password-protected.');
  if (state === 'password') validPassword(password, 'Password');
  const { code, messages, output } = await qpdf([`--password=${password}`, '--decrypt'], input);
  if (code === 2 || !output) {
    if (messages.some(m => /invalid password/i.test(m))) throw new Error('That password doesn’t open this PDF.');
    throw new Error(messages[0] ? `superPDF couldn’t unlock this PDF (${messages[0]}).` : 'superPDF couldn’t unlock this PDF.');
  }
  return output;
}

/**
 * Repair in two passes. qpdf rewrites the file and reports what it fixed; this WebAssembly build
 * does not rebuild a missing or broken cross-reference table, so if qpdf gives up, pdf-lib re-reads
 * the file object by object (ignoring the damaged table) and writes a fresh one.
 */
export async function repairPdf(input) {
  if ((await encryptionState(input)) === 'password') throw new Error('Remove the PDF’s password before repairing it.');
  const first = await qpdf(['--object-streams=preserve'], input);
  if (first.code !== 2 && first.output) return { bytes: first.output, warnings: first.messages.filter(m => !/operation succeeded with warnings/i.test(m)) };
  try {
    const pdf = await PDFDocument.load(await bytesOf(input), { throwOnInvalidObject: false, updateMetadata: false, ignoreEncryption: true });
    if (!pdf.getPageCount()) throw new Error('no pages found');
    return { bytes: await pdf.save(), warnings: ['Rebuilt the file’s damaged cross-reference table (the index readers use to find each page).'] };
  } catch (error) {
    throw new Error(`This file is too damaged to repair (${first.messages[0] || error.message}).`);
  }
}

const REF = /^\d+ \d+ R$/;
const UNREADABLE = 'This file could not be read as a PDF. Try Repair PDF first.';

/** The pages of a document read as qpdf JSON objects, in order: {ref, dict, box}, box being the crop box (else the media box), inherited or not. */
function pageList(objects) {
  const resolve = value => (typeof value === 'string' && REF.test(value) ? objects[`obj:${value}`]?.value : value);
  const pages = [], seen = new Set();
  const walk = (ref, inherited) => {
    const node = resolve(ref);
    if (!node || typeof node !== 'object' || seen.has(ref)) return;
    seen.add(ref);
    const boxes = { media: resolve(node['/MediaBox']) ?? inherited.media, crop: resolve(node['/CropBox']) ?? inherited.crop };
    const kids = resolve(node['/Kids']);
    if (node['/Type'] !== '/Page' && Array.isArray(kids)) for (const kid of kids) walk(kid, boxes);
    else pages.push({ ref, dict: node, box: (boxes.crop ?? boxes.media ?? [0, 0, 612, 792]).map(resolve) });
  };
  walk(resolve(objects.trailer?.value?.['/Root'])?.['/Pages'], {});
  return pages;
}

/** Bytes in fixed-size pieces: `write` takes one byte at a time (as qpdf's standard output gives them), `emit` gets each full piece. */
function pieces(emit, size = 8 * 1024 * 1024) {
  let piece = new Uint8Array(size), length = 0;
  return {
    write(byte) {
      if (byte === null) return;
      piece[length++] = byte;
      if (length === size) { emit(piece); piece = new Uint8Array(size); length = 0; }
    },
    end() { if (length) emit(piece.slice(0, length)); },
  };
}

/**
 * The last step of Enhance scanned PDF. Each image ({page: index, data: encoded Blob or bytes, width, height, colorSpace,
 * bitsPerComponent, filter}) replaces its page's content, drawn over the page's crop box. Pages keep their size,
 * rotation and annotations; old content and images nothing uses any more are left out. qpdf reads the input and
 * the images where they are and writes the new PDF a piece at a time, so no copy of the whole document, old or
 * new, is ever held in memory. With `saveTo` ([folder, file] in the site's private storage, OPFS) and a worker
 * that can write there, the pieces go to that file and the result is {saved: true}; otherwise each goes to `emit`.
 */
export async function replacePageImages(input, { images, saveTo }, emit) {
  const read = await qpdf(['--json-output', '--json-stream-data=none'], input, { output: '/out.json' });
  if (read.code === 2 || !read.output) throw new Error(UNREADABLE);
  const [header, objects] = JSON.parse(new TextDecoder().decode(read.output)).qpdf;
  const pages = pageList(objects);
  if (images.some(image => !pages[image.page])) throw new Error(UNREADABLE);
  let last = header.maxobjectid;
  const file = saveTo ? await savedFile(saveTo) : null;
  let at = 0, saving = Boolean(file);
  const writer = pieces(piece => {
    if (saving) {
      let written = 0;
      try { written = file.write(piece, { at }); } catch { /* out of space */ }
      if (written === piece.length) { at += written; return; }
      // A short or refused write (out of space; Chrome's private windows stopped near 900 MB in testing): never
      // leave a cut-off file, but hand over what was written and go on in pieces.
      saving = false;
      for (let begin = 0; begin < at; begin += piece.length) {
        const part = new Uint8Array(Math.min(piece.length, at - begin));
        file.read(part, { at: begin });
        emit(part);
      }
      file.truncate(0);
    }
    emit(piece);
  });
  const files = images.map((image, i) => [`image-${i}`, image.data]);
  const { code, messages } = await qpdf((paths, instance) => {
    const update = {};
    images.forEach((image, i) => {
      const { ref, dict, box: [x1, y1, x2, y2] } = pages[image.page];
      const picture = `${++last} 0 R`, content = `${++last} 0 R`;
      const page = { ...dict, '/Resources': { '/XObject': { '/Im0': picture } }, '/Contents': content };
      delete page['/Thumb']; // a thumbnail of the old content
      update[`obj:${ref}`] = { value: page };
      update[`obj:${picture}`] = { stream: { datafile: paths[i], dict: {
        '/Type': '/XObject', '/Subtype': '/Image', '/Width': image.width, '/Height': image.height,
        '/ColorSpace': `/${image.colorSpace}`, '/BitsPerComponent': image.bitsPerComponent, '/Filter': `/${image.filter}`,
      } } };
      update[`obj:${content}`] = { stream: { dict: {}, data: btoa(`q ${x2 - x1} 0 0 ${y2 - y1} ${x1} ${y1} cm /Im0 Do Q`) } };
    });
    instance.FS.writeFile('/update.json', JSON.stringify({ qpdf: [header, update] }));
    // preserve: streams are copied as they are, not decoded and compressed again.
    return ['--update-from-json=/update.json', '--stream-data=preserve'];
  }, input, { files, output: '-', stdout: writer.write });
  try {
    if (code === 2) throw new Error(messages[0] ? `superPDF couldn’t save the adjusted pages (${messages[0]}).` : 'superPDF couldn’t save the adjusted pages.');
    writer.end();
  } finally { file?.close(); }
  return { saved: saving };
}

/** A file in the site's private storage (OPFS) opened for writing, or null where that isn't possible (outside a worker, older browsers, some private windows). */
async function savedFile([folder, name]) {
  try {
    if (typeof FileSystemSyncAccessHandle !== 'function') return null;
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(folder);
    const file = await (await dir.getFileHandle(name, { create: true })).createSyncAccessHandle();
    file.truncate(0);
    return file;
  } catch { return null; }
}

/**
 * Edits to a few pages of a large file, in three steps: extractPages copies those pages into a small PDF, the tool
 * edits that with pdf-lib as it would the whole document, and splicePages puts the edited pages back in place.
 * qpdf reads the large file where it lies and writes the result a piece at a time, so memory stays near the size
 * of the pages edited, not of the document.
 */

const isRef = value => typeof value === 'string' && REF.test(value);
const isDict = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const without = (dict, ...keys) => Object.fromEntries(Object.entries(dict).filter(([key]) => !keys.includes(key)));
const objectArg = ref => (ref === 'trailer' ? '--json-object=trailer' : `--json-object=${ref.split(' ').slice(0, 2).join(',')}`);

/** qpdf JSON ([header, objects]) of some objects of a PDF (refs, or 'trailer'), read without going through the rest. */
async function someObjects(input, refs) {
  const { code, output } = await qpdf(['--json-output', '--json-key=qpdf', '--json-stream-data=none', ...refs.map(objectArg)], input, { output: '/out.json' });
  if (code === 2 || !output) throw new Error(UNREADABLE);
  return JSON.parse(new TextDecoder().decode(output)).qpdf;
}

/** What redaction can't splice: text kept outside the pages, which the whole-file redaction checks or removes. */
function redactionBlockers(objects) {
  const catalog = objects[`obj:${objects.trailer?.value?.['/Root']}`]?.value || {};
  const found = ['/Outlines', '/Names', '/Dests', '/AcroForm', '/AF', '/Collection'].filter(key => key in catalog);
  if (Object.values(objects).some(entry => entry?.value?.['/Subtype'] === '/FileAttachment')) found.push('/FileAttachment');
  return found;
}

/**
 * Copy pages (`pages`: indices, in order) into a small PDF, and read what splicePages needs of the large file: the
 * trailer, the catalog, and those pages' objects with their annotation lists. Returns {bytes, original}.
 * `scan` (redaction): read every object's dictionary (no stream data), to find bookmarks, destinations, form fields
 * and attachments anywhere in the document, and each page's metadata.
 */
export async function extractPages(input, { pages, scan = false }) {
  let header, objects, refs;
  if (scan) {
    const read = await qpdf(['--json-output', '--json-stream-data=none'], input, { output: '/out.json' });
    if (read.code === 2 || !read.output) throw new Error(UNREADABLE);
    [header, objects] = JSON.parse(new TextDecoder().decode(read.output)).qpdf;
    refs = pageList(objects).map(page => page.ref);
  } else {
    // qpdf's page list and the trailer, then only the objects needed.
    const read = await qpdf(['--json-output', '--json-key=pages', '--json-key=qpdf', '--json-object=trailer', '--json-stream-data=none'], input, { output: '/out.json' });
    if (read.code === 2 || !read.output) throw new Error(UNREADABLE);
    const json = JSON.parse(new TextDecoder().decode(read.output));
    refs = json.pages.map(page => page.object);
    if (pages.some(i => !refs[i])) throw new Error(UNREADABLE);
    [header, objects] = await someObjects(input, ['trailer', json.qpdf[1].trailer.value['/Root'], ...pages.map(i => refs[i])]);
    const lists = pages.map(i => objects[`obj:${refs[i]}`]?.value?.['/Annots']).filter(isRef);
    if (lists.length) Object.assign(objects, (await someObjects(input, lists))[1]);
  }
  if (pages.some(i => !refs[i])) throw new Error(UNREADABLE);
  const { code, messages, output } = await qpdf((_, __, path) => ['--empty', '--pages', path, pages.map(i => i + 1).join(','), '--'], input, { primary: false });
  if (code === 2 || !output) throw new Error(messages.some(m => /password/i.test(m)) ? 'This PDF is password-protected. Remove the password with Password controls first.' : UNREADABLE);
  const value = ref => objects[`obj:${ref}`]?.value;
  const root = objects.trailer.value['/Root'];
  const original = {
    maxobjectid: header.maxobjectid, trailer: objects.trailer.value, catalog: [root, value(root) || {}],
    blockers: scan ? redactionBlockers(objects) : [],
    // Pages with their own metadata, for redaction with metadata removed.
    metadata: scan ? refs.filter(ref => ['/Metadata', '/PieceInfo'].some(key => key in (value(ref) || {}))).map(ref => [ref, value(ref)]) : [],
    pages: pages.map(i => {
      const dict = value(refs[i]) || {}, annots = dict['/Annots'];
      return { ref: refs[i], dict, annots: (isRef(annots) ? value(annots) : annots) || [] };
    }),
  };
  return { bytes: output, original };
}

/** qpdf JSON objects of a small PDF in memory, stream data included as stored (still compressed). */
async function smallJson(bytes) {
  const { code, output } = await qpdf(['--json-output', '--json-stream-data=inline', '--decode-level=none'], bytes, { output: '/out.json' });
  if (code === 2 || !output) throw new Error('superPDF couldn’t read the edited pages.');
  return JSON.parse(new TextDecoder().decode(output)).qpdf[1];
}

/**
 * Put edited pages back into the large file. `before`: the small PDF extractPages returned, with its `original`;
 * `after`: the small PDF once edited. Each edited page takes the place of its original and keeps the page's object,
 * so bookmarks, links and page labels that point to it still do, and annotations it already had stay the same
 * objects (form fields still find their widgets). Everything else the edited pages use is added as new objects.
 * `redact`: the original page content must not survive anywhere. Resources a page doesn't use are dropped (so an
 * image only a redacted page drew isn't kept through a resource dictionary shared with other pages), the tag tree is
 * removed and, with `metadata`, the document metadata. A document with bookmarks, named destinations, form fields or
 * attachments is refused with an error named 'NeedsWholeFile': the whole-file redaction checks and removes those.
 */
export async function splicePages(input, { before, after, original, redact = false, metadata = false }, emit) {
  if (redact && original.blockers.length) throw Object.assign(new Error('This document needs the whole-file redaction.'), { name: 'NeedsWholeFile' });
  const copy = await smallJson(before), edited = await smallJson(after);
  const copies = pageList(copy), results = pageList(edited);
  if (copies.length !== original.pages.length || results.length !== original.pages.length) throw new Error('superPDF couldn’t put the edited pages back.');

  let last = original.maxobjectid;
  const target = new Map(copies.map(({ ref }, i) => [ref, original.pages[i].ref])), queue = [];
  const remap = value => {
    if (isRef(value)) {
      if (!target.has(value)) {
        const entry = edited[`obj:${value}`], type = entry?.value?.['/Type'];
        if (!entry || type === '/Pages' || type === '/Catalog') return null;
        target.set(value, `${++last} 0 R`);
        queue.push(value);
      }
      return target.get(value);
    }
    if (Array.isArray(value)) return value.map(remap);
    if (isDict(value)) return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, remap(v)]));
    return value;
  };
  const listOf = (objects, value) => (isRef(value) ? objects[`obj:${value}`]?.value : value);
  const update = {};
  results.forEach(({ dict }, i) => {
    const page = original.pages[i], had = listOf(copy, copy[`obj:${copies[i].ref}`]?.value?.['/Annots']) || [];
    const value = remap(without(dict, '/Parent', '/Annots'));
    // Annotations the page already had stay the original objects; added ones are new.
    const annots = listOf(edited, dict['/Annots']);
    if (Array.isArray(annots) && annots.length) value['/Annots'] = annots.map((ref, n) => (ref === had[n] && page.annots[n] ? page.annots[n] : remap(ref)));
    update[`obj:${page.ref}`] = { value: { ...value, '/Parent': page.dict['/Parent'] } };
  });
  while (queue.length) {
    const ref = queue.shift(), entry = edited[`obj:${ref}`];
    update[`obj:${target.get(ref)}`] = entry.stream
      ? { stream: { dict: remap(without(entry.stream.dict, '/Length')), data: entry.stream.data } }
      : { value: remap(entry.value) };
  }
  if (redact) {
    const [root, catalog] = original.catalog;
    update[`obj:${root}`] = { value: without(catalog, '/StructTreeRoot', '/MarkInfo', ...(metadata ? ['/Metadata', '/PieceInfo'] : [])) };
    if (metadata) {
      const info = original.trailer['/Info'];
      if (isRef(info)) update[`obj:${info}`] = { value: {} };
      else if (info) update.trailer = { value: without(original.trailer, '/Info') };
      for (const [ref, dict] of original.metadata) {
        const entry = update[`obj:${ref}`];
        if (entry) entry.value = without(entry.value, '/Metadata', '/PieceInfo');
        else update[`obj:${ref}`] = { value: without(dict, '/Metadata', '/PieceInfo') };
      }
    }
  }
  const writer = pieces(emit);
  const { code, messages } = await qpdf((_, instance) => {
    instance.FS.writeFile('/update.json', JSON.stringify({ qpdf: [{ jsonversion: 2 }, update] }));
    // --pages . 1-z keeps every page object as it is; qpdf drops unused resources only when it rebuilds the page list.
    return ['--update-from-json=/update.json', '--stream-data=preserve', ...(redact ? ['--remove-unreferenced-resources=yes', '--pages', '.', '1-z', '--'] : [])];
  }, input, { output: '-', stdout: writer.write });
  if (code === 2) throw new Error(messages[0] ? `superPDF couldn’t save the edited pages (${messages[0]}).` : 'superPDF couldn’t save the edited pages.');
  writer.end();
}
