// Pictures on a page that has text, which may hold text themselves: a title or a table set as a picture. superPDF
// OCR reads them only when their pixels look like lines of print (textLikeness), so photos, logos and drawings never
// start the engine, and keeps the words only when they read clearly (clearReading). DOM-free: used by pdf-structure.js
// (which pictures to offer), ocr.js in the browser and pdf-node.js in Node (which to read).

const MAX_REGIONS = 6; // a page

const overlap = (a, b) => Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) * Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
const area = r => (r.x1 - r.x0) * (r.y1 - r.y0);

/**
 * Pictures worth offering to OCR on a page with text: at least 2% of the page and an inch by a quarter-inch, with no
 * text of the page's own on them (a picture behind printed text already has its text). Pictures that overlap mostly
 * (one placed in pieces) go together. `boxes`: image placements [x, y, w, h] in points; `items`: the page's text
 * items; `viewport`: {width, height}. Largest first, at most 6.
 * @returns {{x0: number, y0: number, x1: number, y1: number}[]}
 */
export function pictureRegions(boxes = [], items = [], { width, height } = {}) {
  if (!boxes.length || !width || !height) return [];
  const page = width * height;
  const out = [];
  for (const [x, y, w, h] of boxes) {
    const r = { x0: Math.max(0, x), y0: Math.max(0, y), x1: Math.min(width, x + w), y1: Math.min(height, y + h) };
    if (r.x1 - r.x0 < 72 || r.y1 - r.y0 < 18 || area(r) < page * 0.02 || area(r) >= page * 0.9) continue; // the page's background: not a picture on it
    const same = out.find(o => overlap(o, r) >= 0.5 * Math.min(area(o), area(r)));
    if (same) Object.assign(same, { x0: Math.min(same.x0, r.x0), y0: Math.min(same.y0, r.y0), x1: Math.max(same.x1, r.x1), y1: Math.max(same.y1, r.y1) });
    else out.push(r);
  }
  const textOn = r => items.reduce((n, i) => {
    const cx = i.x + i.width / 2, cy = i.y + i.size / 2;
    return cx > r.x0 && cx < r.x1 && cy > r.y0 && cy < r.y1 ? n + i.text.trim().length : n;
  }, 0);
  return out.filter(r => area(r) < page * 0.9 && textOn(r) < 10).sort((a, b) => area(b) - area(a)).slice(0, MAX_REGIONS)
    .map(r => ({ x0: Math.round(r.x0 * 100) / 100, y0: Math.round(r.y0 * 100) / 100, x1: Math.round(r.x1 * 100) / 100, y1: Math.round(r.y1 * 100) / 100 }));
}

/** Otsu's threshold of a 256-bin histogram, and how far apart the two classes' means are. */
function otsu(hist, total) {
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let lowSum = 0, low = 0, best = -1, cut = 128, spread = 0;
  for (let t = 0; t < 256; t++) {
    low += hist[t]; if (!low) continue;
    const high = total - low; if (!high) break;
    lowSum += t * hist[t];
    const m0 = lowSum / low, m1 = (sum - lowSum) / high, between = low * high * (m0 - m1) ** 2;
    if (between > best) { best = between; cut = t; spread = m1 - m0; }
  }
  return { cut, spread };
}

/**
 * Whether a picture (ImageData-like {data, width, height}, drawn at about 150 dpi) looks like print: its ink (the
 * smaller of the two tones) falls into letter-sized marks that sit side by side in rows, and those marks are most of
 * the picture's marks. A photo or a drawing makes large shapes and scattered specks instead. Returns the measures
 * and `text` (the verdict).
 */
export function textLikeness({ data, width, height }) {
  const n = width * height;
  const gray = new Uint8Array(n), hist = new Float64Array(256);
  for (let p = 0, q = 0; p < n; p++, q += 4) { const v = (data[q] * 77 + data[q + 1] * 150 + data[q + 2] * 29) >> 8; gray[p] = v; hist[v]++; }
  const { cut, spread } = otsu(hist, n);
  let dark = 0;
  for (let v = 0; v <= cut; v++) dark += hist[v];
  const inkDark = dark <= n / 2;
  const result = { text: false, contrast: Math.round(spread), letters: 0, inRows: 0, marks: 0, rows: 0 };
  if (spread < 60) return result;
  // Connected marks of ink (8-neighbour), by two-pass labelling.
  const label = new Int32Array(n), parent = [0];
  const find = a => { while (parent[a] !== a) a = parent[a] = parent[parent[a]]; return a; };
  for (let y = 0, p = 0; y < height; y++) for (let x = 0; x < width; x++, p++) {
    if ((gray[p] <= cut) !== inkDark) continue;
    let l = 0;
    const take = q => { const m = label[q]; if (!m) return; if (!l) l = m; else if (m !== l) { const a = find(l), b = find(m); if (a !== b) parent[Math.max(a, b)] = Math.min(a, b); } };
    if (x > 0) take(p - 1);
    if (y > 0) { take(p - width); if (x > 0) take(p - width - 1); if (x < width - 1) take(p - width + 1); }
    if (!l) { l = parent.length; parent.push(l); }
    label[p] = l;
  }
  const marks = new Map();
  for (let y = 0, p = 0; y < height; y++) for (let x = 0; x < width; x++, p++) {
    if (!label[p]) continue;
    const r = find(label[p]);
    let m = marks.get(r);
    if (!m) marks.set(r, m = { x0: x, y0: y, x1: x, y1: y, ink: 0 });
    if (x < m.x0) m.x0 = x; if (x > m.x1) m.x1 = x; if (y > m.y1) m.y1 = y;
    m.ink++;
  }
  // Letters: a line's height of ink (5 to 90 px at 150 dpi, 2.5 to 43 pt), not much wider than tall (letters that
  // touch included), neither a speck nor a solid block. Rules (long thin marks, as in tables) count for nothing.
  const letters = [];
  let counted = 0, letterInk = 0, shapeInk = 0;
  for (const m of marks.values()) {
    const w = m.x1 - m.x0 + 1, h = m.y1 - m.y0 + 1;
    if (w * h < 12 || (h <= 4 && w >= 20) || (w <= 4 && h >= 20)) continue;
    counted++;
    const fill = m.ink / (w * h);
    if (h >= 5 && h <= 90 && w <= h * 6 && fill >= 0.08 && fill <= 0.9) { letters.push({ ...m, h, cy: (m.y0 + m.y1) / 2 }); letterInk += m.ink; }
    else if (fill >= 0.3) shapeInk += m.ink; // a solid shape: a bar of a chart, part of a photo (a ruled frame is hollow)
  }
  // Rows: letters of about one height whose middles line up, close together side by side; a row of three or more.
  letters.sort((a, b) => a.x0 - b.x0);
  const used = new Uint8Array(letters.length);
  let inRows = 0, rows = 0;
  for (let i = 0; i < letters.length; i++) {
    if (used[i]) continue;
    const row = [i];
    let last = letters[i];
    for (let j = i + 1; j < letters.length; j++) {
      const c = letters[j];
      if (used[j] || c.x0 - last.x1 > last.h * 1.5) continue;
      if (Math.abs(c.cy - last.cy) <= Math.min(c.h, last.h) * 0.5 && Math.max(c.h, last.h) <= Math.min(c.h, last.h) * 2.2) { row.push(j); last = c; }
      if (c.x0 > last.x1 + last.h * 1.5) break;
    }
    if (row.length >= 3) { for (const k of row) used[k] = 1; inRows += row.length; rows++; }
  }
  Object.assign(result, { letters: letters.length, inRows, marks: counted, rows, shapes: Math.round(100 * shapeInk / Math.max(1, letterInk + shapeInk)) / 100 });
  // Two rows or more, or one long one (a title); most marks in rows; few solid shapes.
  result.text = rows >= 1 && inRows >= (rows >= 2 ? 12 : 14) && inRows >= counted * 0.5 && result.shapes < 0.5;
  return result;
}

/**
 * A reading of a picture clear enough to keep: three or more words of two letters or more read with confidence 80
 * or more, and the lettered words' mean confidence at least 70. `data`: Tesseract's, with blocks.
 */
export function clearReading(data) {
  let sum = 0, n = 0, sure = 0;
  for (const b of data?.blocks || []) for (const p of b.paragraphs || []) for (const l of p.lines || []) for (const w of l.words || []) {
    const letters = (w.text.match(/[\p{L}\p{N}]/gu) || []).length;
    if (!letters) continue;
    sum += w.confidence; n++;
    if (letters >= 2 && w.confidence >= 80) sure++;
  }
  return sure >= 3 && sum / n >= 70;
}

const CHECKS = 200, READS = 30; // pictures looked at, and read, in a document

/**
 * Reading of pictures for a document, with its budget: `draw(page, region, dpi)` gives the region drawn
 * ({image: ImageData, scale, ...}), `read(drawn, page)` Tesseract's data for it, `items(data, drawn)` text items in
 * the drawing's points (pdf-structure.js recognizedItems). The returned function gives a region's words in page
 * points, or null: when the picture doesn't look like print, doesn't read clearly, or the budget is spent. A picture
 * turned down at one place on a page is not looked at again at that place (a logo on every page costs one look).
 */
export function pictureReader({ draw, read, items }) {
  const declined = new Set();
  let checks = 0, reads = 0;
  return async (page, region) => {
    const key = [region.x0, region.y0, region.x1, region.y1].map(Math.round).join(',');
    if (declined.has(key) || checks >= CHECKS || reads >= READS) return null;
    checks++;
    if (!textLikeness((await draw(page, region, 150)).image).text) { declined.add(key); return null; }
    reads++;
    const drawn = await draw(page, region, 300);
    const data = await read(drawn, page);
    if (!clearReading(data)) { declined.add(key); return null; }
    return items(data, drawn).map(i => ({ ...i, x: i.x + region.x0, y: i.y + region.y0, ocrLine: `${key}:${i.ocrLine}` }));
  };
}
