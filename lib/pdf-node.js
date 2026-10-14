// PDF.js and scan recognition in Node, for the command-line tool, the MCP server and the local API (copied into
// packages/cli/lib by its build). The browser has its own: pdf-runtime.js (PDF.js's data files from /pdfjs/) and
// ocr.js (the same Tesseract engine and settings, from /ocr/).
import { existsSync } from 'node:fs';
import { access } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { languageOf } from './ocr-languages.js';
import { straightened } from './ocr-straighten.js';

const require = createRequire(import.meta.url);
const pdfjsRequire = () => createRequire(require.resolve('pdfjs-dist/package.json'));

/**
 * PDF.js's own data files, from the installed pdfjs-dist: character maps (Chinese, Japanese and Korean text), the
 * standard fonts for PDFs that don't embed theirs, the JPEG 2000 and JBIG2 decoders (WebAssembly) and the colour
 * profile for CMYK. Without them such text reads as empty and such scans render blank. PDF.js reads each file only
 * when a PDF needs it, once per open document. A file that can't be read costs only what needs it: PDF.js warns
 * and reads the rest of the page.
 */
export function pdfjsResources(dir = path.dirname(require.resolve('pdfjs-dist/package.json')), sep = path.sep) {
  // PDF.js requires each folder to end in '/' (a '\\' fails with "Invalid factory url" on Windows), and Node's file
  // functions accept '/' on Windows too.
  const base = `${dir.split(sep).join('/')}/`;
  return { cMapUrl: `${base}cmaps/`, cMapPacked: true, standardFontDataUrl: `${base}standard_fonts/`, wasmUrl: `${base}wasm/`, iccUrl: `${base}iccs/` };
}

/** getDocument options for reading `data` (bytes) in Node: no scripts, no system fonts, PDF.js's data files. */
export const documentOptions = data => ({ data, verbosity: 0, isEvalSupported: false, useSystemFonts: false, fontExtraProperties: true, ...pdfjsResources() });

const MAX_SIDE = 4000; // pixels; ~300 dpi for a letter page, as in ocr.js

/**
 * Folder with eng.traineddata.gz: the copy the CLI ships (lib/, checked by its build against the app's), else the
 * one the app self-hosts under /ocr/lang (@tesseract.js-data/eng 4.0.0_best_int).
 */
export function ocrLangDir() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  if (existsSync(path.join(here, 'eng.traineddata.gz'))) return here;
  return path.dirname(require.resolve('@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz'));
}

/**
 * superPDF OCR in Node: pass `recognize` to extractStructure (pdf-structure.js) and pages without text are read with
 * Tesseract (in the document's language, told at its first scanned page; LSTM, ~300 dpi capped at 4,000 px, words
 * with confidence >= 30), as the app's exports do. recognize(page, index, options): with `{ region }`, that part of
 * the page only (chart labels drawn as shapes, pdf-charts.js readStrip; with `text: false` its pixels only, without
 * the engine); with `{ picture }`, a picture on a page with text is read when it looks like print (ocr-pictures.js),
 * in the language of the page's text; with `{ garbled: true }`, a page whose text
 * layer can't be read (ocr-languages.js garbledText) is read whole and its words returned only when they read clearly
 * (else null). One engine per run, started at the first page or picture that needs it (documents with text and no
 * such pictures never load it) and reused; pages are drawn and read one at a time, so memory stays flat however long
 * the file. `progress(text)` before each page. Fails soft: an engine that can't start, or a page it can't read, leaves
 * that page as it is (no text), counted in `missed` with the first reason in `failed`. `pages` counts the pages it
 * found words on; close() stops the engine.
 * `createEngine`: starts the engine instead (a Tesseract.js worker or the same interface; for tests and benchmarks).
 */
export function scannedPageReader({ progress = () => {}, signal, langPath = ocrLangDir(), createEngine } = {}) {
  let worker = null, count = 0, missed = 0, failed = null, current = 'eng'; // current: the engine's language
  const start = createEngine || (async () => {
    // Checked first: tesseract.js never settles a start whose language data is missing.
    await access(path.join(langPath, 'eng.traineddata.gz'));
    const { createWorker, OEM } = await import('tesseract.js');
    // cacheMethod 'none': the language data is read from langPath only, never from or into the working folder.
    // errorHandler: a failed job rejects here instead of throwing out of the engine's thread (which would end the run).
    let fail;
    const failure = new Promise((_, reject) => { fail = reject; });
    return Promise.race([failure, createWorker('eng', OEM.LSTM_ONLY, { langPath, gzip: true, cacheMethod: 'none', errorHandler: error => fail(new Error(String(error))) },
      // Tesseract's own diagnostics ("Line cannot be recognized!!") are dropped instead of printed to the terminal.
      { debug_file: '/dev/null' })]);
  });
  const use = async (engine, code) => {
    if (code === current) return;
    const { OEM } = await import('tesseract.js');
    await engine.reinitialize(code, OEM.LSTM_ONLY);
    current = code;
  };
  const canvases = () => pdfjsRequire()('@napi-rs/canvas');
  // `strip`: only a band across the middle of the page (for telling its script), as in ocr.js; `area`: only that
  // rectangle of the drawing (for comparing two languages on the same text).
  // The page being read, drawn once and kept while it is read again (another language, a strip, Sauvola's
  // thresholding); let go when the page is done (forget).
  let drawn = null;
  async function draw(page) {
    if (drawn?.page === page) return drawn;
    forget();
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(300 / 72, MAX_SIDE / Math.max(base.width, base.height));
    const viewport = page.getViewport({ scale });
    const canvas = canvases().createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    await page.render({ canvasContext: canvas.getContext('2d'), canvas, viewport, background: '#fff' }).promise;
    drawn = { page, canvas, png: canvas.toBuffer('image/png'), scale, width: canvas.width, height: canvas.height };
    return drawn;
  }
  function forget() { if (drawn) drawn.canvas.width = drawn.canvas.height = 0; drawn = null; }
  async function readData(engine, page, { strip = false, area } = {}) {
    const { canvas, png, scale, width, height } = await draw(page);
    const rectangle = strip ? { left: 0, top: Math.round(height * 0.3), width, height: Math.round(height * 0.3) } : area;
    // The page's pixels, for reading which words are set in bold from their strokes, as ocr.js does.
    const image = rectangle ? null : canvas.getContext('2d').getImageData(0, 0, width, height);
    // A whole page is read straightened when it's tilted (a skewed scan or photo), its words then put back in place.
    const { data } = await engine.recognize(png, rectangle ? { rectangle } : { rotateAuto: true }, { text: true, blocks: true });
    return { data: straightened(data, width, height), scale, image };
  }
  // The document's language, told at its first scanned page as ocr.js does (ocr-languages.js): the PDF's /Lang when it
  // names another language superPDF OCR reads, else the English reading's common words (a Latin-script language that
  // has only a few is tried on the page's main text and taken when it reads better), else, when the reading is too
  // poor to be English, the other scripts on its main text (or a strip). The engine is left set to it.
  let language = null, tag = null;
  async function chooseLanguage(engine, page, data, text) {
    const L = await import('./ocr-languages.js');
    const tagged = L.tagLanguage(tag);
    if (tagged && tagged !== 'eng') {
      progress(`Page ${page.pageNumber} is in ${L.languageOf(tagged).name}, so superPDF is recognizing it again…`);
      await use(engine, tagged);
      return tagged;
    }
    let code = L.latinLanguage(L.readingText(data));
    const candidate = !code && L.latinCandidate(L.readingText(data));
    const area = candidate && L.mainTextArea(data);
    if (area) {
      const english = L.readingConfidence((await readData(engine, page, { area })).data);
      await use(engine, candidate);
      if (L.confirmsLanguage(L.readingConfidence((await readData(engine, page, { area })).data), english)) code = candidate;
      else await use(engine, 'eng');
    }
    if (!code && L.readingLooksForeign(data)) {
      const place = L.probePlace(data);
      const english = L.readingConfidence((await readData(engine, page, place)).data).confidence;
      const results = [];
      for (const probe of L.scriptProbes(text)) {
        await use(engine, probe);
        results.push({ code: probe, ...L.readingConfidence((await readData(engine, page, place)).data) });
      }
      code = L.bestProbe(results, english);
      if (!code) { await use(engine, 'eng'); return 'eng'; }
    }
    if (!code) return 'eng';
    progress(`Page ${page.pageNumber} is in ${L.languageOf(code).name}, so superPDF is recognizing it again…`);
    await use(engine, code);
    return code;
  }
  async function read(engine, page, { garbled = false } = {}) {
    await use(engine, language || 'eng');
    let { data, scale, image } = await readData(engine, page);
    if (language === null) {
      language = await chooseLanguage(engine, page, data, garbled ? (await page.getTextContent()).items.map(i => i.str).join(' ') : '');
      if (language !== 'eng') { image = null; ({ data, scale, image } = await readData(engine, page)); }
    }
    // A page read poorly is read again with Sauvola's thresholding; the clearer reading is kept (ocr-languages.js).
    const L = await import('./ocr-languages.js');
    if (L.readPoorly(data)) {
      await engine.setParameters(L.SAUVOLA);
      try { data = L.betterReading(data, (await readData(engine, page)).data); } finally { await engine.setParameters(L.OTSU); }
    }
    // A page whose text layer is garbled keeps it unless the reading is clear.
    if (garbled && !L.clearPage(data)) return null;
    const { recognizedItems } = await import('./pdf-structure.js');
    return recognizedItems(L.joinedHanKana(data), scale, { image });
  }
  // A region of a page drawn at `dpi` (capped at 4,000 px a side): its pixels, and a PNG of it at 300 dpi to read.
  async function drawRegion(page, region, dpi) {
    const w = region.x1 - region.x0, h = region.y1 - region.y0;
    const scale = Math.min(dpi / 72, MAX_SIDE / Math.max(w, h));
    const canvas = canvases().createCanvas(Math.max(1, Math.ceil(w * scale)), Math.max(1, Math.ceil(h * scale)));
    await page.render({ canvasContext: canvas.getContext('2d'), canvas, viewport: page.getViewport({ scale }), transform: [1, 0, 0, 1, -region.x0 * scale, -region.y0 * scale], background: '#fff' }).promise;
    const image = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
    const png = dpi >= 300 ? canvas.toBuffer('image/png') : null;
    canvas.width = canvas.height = 0;
    return { image, png, scale };
  }
  let pictures = null;
  async function readPicture(engine, page, picture) {
    const [{ pictureReader }, { textLanguage, joinedHanKana }, { recognizedItems }] = await Promise.all([import('./ocr-pictures.js'), import('./ocr-languages.js'), import('./pdf-structure.js')]);
    pictures ??= pictureReader({
      draw: drawRegion,
      read: async (drawn, at) => {
        const code = textLanguage((await at.getTextContent()).items.map(i => i.str).join(' '));
        progress(`Page ${at.pageNumber} has text set as a picture, so superPDF is reading it (OCR, ${languageOf(code).name})…`);
        await use(engine, code);
        return (await engine.recognize(drawn.png, {}, { text: true, blocks: true })).data;
      },
      items: (data, drawn) => recognizedItems(joinedHanKana(data), drawn.scale, { image: drawn.image }),
    });
    return pictures(page, picture);
  }
  // A strip of a page (chart labels drawn as shapes): read as it is and turned a quarter (pdf-charts.js readStrip).
  async function readRegion(engine, page, region) {
    const { createCanvas } = pdfjsRequire()('@napi-rs/canvas');
    const { readStrip } = await import('./pdf-charts.js');
    return readStrip(page, region, { createCanvas, toImage: canvas => canvas.toBuffer('image/png'), recognize: async image => (await engine.recognize(image, {}, { text: true, blocks: true })).data });
  }
  return {
    async recognize(page, index, { region, picture, garbled = false } = {}) {
      if (signal?.aborted) throw Object.assign(new Error('Stopped.'), { name: 'AbortError' });
      if (picture) {
        try {
          // The engine starts only for a picture that looks like print.
          const engine = { recognize: async (...a) => (await (worker ??= start())).recognize(...a), reinitialize: async (...a) => (await (worker ??= start())).reinitialize(...a) };
          return await readPicture(engine, page, picture);
        } catch { return null; }
      }
      if (region) {
        // A picture's pixels only (is it a chart?): nothing to read, so the engine isn't started for it.
        try {
          if (region.text === false) return await readRegion(null, page, region);
          worker ??= start();
          await use(await worker, language || 'eng');
          return await readRegion(await worker, page, region);
        } catch { return null; }
      }
      progress(garbled ? `Page ${page.pageNumber}'s text is stored in a way that can't be read, so superPDF is recognizing it (OCR)…`
        : `Page ${page.pageNumber} is scanned, so superPDF is recognizing its text (OCR, ${languageOf(language || 'eng').name})…`);
      try {
        worker ??= start();
        const items = await read(await worker, page, { garbled });
        if (items?.length) count++;
        return items;
      } catch (error) {
        missed++;
        failed ??= error instanceof Error ? error : new Error(String(error));
        return null;
      } finally { forget(); }
    },
    get pages() { return count; },
    get language() { return language || 'eng'; },
    /** The PDF's /Lang ("de-DE"), when the caller knows it: the language of its scans when superPDF OCR reads it. */
    set documentLanguage(value) { tag = value || null; },
    get missed() { return missed; },
    get failed() { return failed; },
    async close() { forget(); const engine = worker; worker = null; await (await engine?.catch(() => null))?.terminate(); },
  };
}
