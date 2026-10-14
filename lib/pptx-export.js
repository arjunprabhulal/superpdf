// PDF → PowerPoint (.pptx) with pptxgenjs, one slide per page. Two kinds of slide:
//   text   - editable text boxes where the PDF's text sits (lines that share a left edge, size and style
//            become one box), with the page's pictures cut out and placed behind them
//   images - each page as one picture filling the slide, with the page's text in the speaker notes
// Slide size follows the first page. Pictures come from a renderer the caller passes in (a canvas in the
// browser), so this module has no DOM and the CLI can reuse it.
import PptxGenJS from 'pptxgenjs';
import { pageItems, usable } from './pdf-structure.js';
import { fixPageText } from './pdf-text-fixes.js';
import { textRows } from './pdf-tables.js';
import { xmlSafe } from './pdf-paragraphs.js';

const MAX_SIDE = 56 * 72; // PowerPoint's largest slide side, in points
const MIN_SIDE = 72;
const MAX_PICTURES = 40; // per page; beyond that the page is usually a pattern of tiles
const half = n => Math.round(n * 2) / 2;

/** Slide size in points for a first page of width × height points, within PowerPoint's 1–56 inch limits. */
export function slideSize(width, height) {
  let k = Math.min(1, MAX_SIDE / Math.max(width, height));
  if (Math.min(width, height) * k < MIN_SIDE) k = Math.min(MAX_SIDE / Math.max(width, height), MIN_SIDE / Math.min(width, height));
  return { width: Math.round(width * k * 100) / 100, height: Math.round(height * k * 100) / 100 };
}

const KNOWN = [[/helvetica|arial/i, 'Arial'], [/times/i, 'Times New Roman'], [/courier/i, 'Courier New'], [/symbol/i, 'Symbol']];
/** A font family PowerPoint can use for a PDF font name (subset prefix and style suffixes removed). */
export function fontFace(name = '') {
  const clean = String(name).replace(/^[A-Z]{6}\+/, '');
  for (const [pattern, face] of KNOWN) if (pattern.test(clean)) return face;
  if (!clean || /^g_d\d|^f\d+$/i.test(clean)) return 'Arial';
  return clean.split(/[-,]/)[0].replace(/(PSMT|MT|PS|Std|Pro|LT)$/, '').replace(/([a-z])([A-Z])/g, '$1 $2').trim() || 'Arial';
}

/**
 * Text boxes for a page: consecutive lines with the same left edge, size and style, evenly spaced,
 * share a box, so a paragraph stays one box with the PDF's line breaks.
 */
export function textBoxes(rows) {
  const boxes = [];
  for (const row of rows) for (const s of row.segments) {
    const box = boxes.findLast(b => Math.abs(b.x0 - s.x0) <= 2 && Math.abs(b.size - s.size) <= 0.5 && b.bold === s.bold && b.italic === s.italic && b.font === s.font
      && row.base > b.base && row.base - b.base <= s.size * 1.7 && (b.lines.length < 2 || Math.abs(row.base - b.base - b.pitch) <= 1));
    if (box) {
      box.pitch = row.base - box.base;
      box.base = row.base;
      box.x1 = Math.max(box.x1, s.x1);
      box.lines.push(s.text);
    } else boxes.push({ x0: s.x0, x1: s.x1, top: row.base - s.size, base: row.base, size: s.size, bold: s.bold, italic: s.italic, font: s.font, lines: [s.text] });
  }
  return boxes;
}

/**
 * Read what each slide needs from a PDF.js document. `pages` is a list of 0-based indices (default all).
 * `render(page)` → {bytes, type} draws a whole page (needed for mode 'images'); `crop(page, boxes)` →
 * [{bytes, type} | null] cuts out picture areas (optional for mode 'text'; without it pictures are left out).
 */
export async function readPdfSlides(pdfjs, doc, { pages, mode = 'text', render, crop, progress = () => {} } = {}) {
  if (mode === 'images' && !render) throw new Error('Page pictures need a renderer.');
  const indices = pages || [...Array(doc.numPages).keys()];
  const slides = [];
  for (const [n, index] of indices.entries()) {
    progress(`${mode === 'images' ? 'Drawing' : 'Reading'} page ${n + 1} of ${indices.length}`);
    const page = await doc.getPage(index + 1);
    const { viewport, items: raw, boxes } = await pageItems(pdfjs, page, { images: mode === 'text' && Boolean(crop) });
    // Fixed as the other exports read it (pdf-structure.js readPage): ligatures, letter spacing, form field values.
    const items = (await fixPageText(page, viewport, raw, pdfjs)).filter(usable);
    const rows = textRows(items);
    const slide = { page: index + 1, width: viewport.width, height: viewport.height, notes: rows.map(r => r.segments.map(s => s.text).join('  ')).join('\n') };
    if (mode === 'images') slide.picture = await render(page);
    else {
      slide.texts = textBoxes(rows);
      const chosen = boxes.slice(0, MAX_PICTURES);
      const pictures = chosen.length ? await crop(page, chosen) : [];
      slide.images = chosen.map(([x, y, width, height], i) => pictures[i] && { x, y, width, height, ...pictures[i] }).filter(Boolean);
    }
    page.cleanup?.();
    slides.push(slide);
  }
  return slides;
}

function base64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
const dataUrl = ({ bytes, type }) => `data:${type || 'image/png'};base64,${base64(bytes)}`;

/**
 * Build the .pptx.
 * @param {Awaited<ReturnType<typeof readPdfSlides>>} slides
 * @param {{mode?: 'text' | 'images', title?: string}} options
 * @returns {Promise<{bytes: Uint8Array, slides: number, emptyPages: number[]}>}
 */
export async function slidesToPptx(slides, { mode = 'text', title = 'Presentation' } = {}) {
  if (!slides.length) throw new Error('Choose at least one page.');
  const emptyPages = slides.filter(s => !s.notes.trim()).map(s => s.page);
  if (mode === 'text' && emptyPages.length === slides.length && !slides.some(s => s.images?.length)) throw new Error('This PDF has no readable text layer. Run OCR PDF first, or choose Page images.');
  const pres = new PptxGenJS();
  const size = slideSize(slides[0].width, slides[0].height);
  pres.defineLayout({ name: 'PDF', width: size.width / 72, height: size.height / 72 });
  pres.layout = 'PDF';
  pres.title = xmlSafe(title);
  pres.company = 'superPDF';
  const inch = n => Math.round(n / 72 * 10000) / 10000;
  for (const s of slides) {
    const slide = pres.addSlide();
    // Pages of other sizes are scaled to fit the slide and centred.
    const k = Math.min(size.width / s.width, size.height / s.height);
    const ox = (size.width - s.width * k) / 2, oy = (size.height - s.height * k) / 2;
    const box = (x, y, w, h) => ({ x: inch(ox + x * k), y: inch(oy + y * k), w: inch(Math.max(1, w * k)), h: inch(Math.max(1, h * k)) });
    if (mode === 'images') {
      slide.addImage({ data: dataUrl(s.picture), ...box(0, 0, s.width, s.height) });
      if (s.notes.trim()) slide.addNotes(xmlSafe(s.notes));
      continue;
    }
    for (const image of s.images || []) slide.addImage({ data: dataUrl(image), ...box(image.x, image.y, image.width, image.height) });
    for (const t of s.texts || []) {
      const fontSize = Math.max(1, half(t.size * k));
      const lines = t.lines.map((line, i) => ({ text: xmlSafe(line), options: { breakLine: i < t.lines.length - 1 } }));
      slide.addText(lines, {
        ...box(t.x0, t.top, t.x1 - t.x0 + t.size * 0.6, (t.lines.length - 1) * (t.pitch || t.size * 1.2) + t.size * 1.3),
        fontSize, fontFace: fontFace(t.font), bold: t.bold, italic: t.italic, color: '000000',
        margin: 0, valign: 'top', wrap: false, fit: 'none', isTextBox: true,
        ...(t.lines.length > 1 && { lineSpacing: half(t.pitch * k) }),
      });
    }
  }
  const bytes = await pres.write({ outputType: 'uint8array', compression: true });
  return { bytes: bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), slides: slides.length, emptyPages };
}
