// PDF → structured content: pages → blocks (headings, paragraphs, list items, tables, page headers and footers)
// → lines with positions, fonts and inline bold, italic, superscript and subscript, plus image boxes, and exports
// to JSON, HTML and Markdown. Tables and reading order (multi-column pages) come from pdf-layout.js. DOM-free:
// runs in the browser, the CLI, the MCP server and the local API with the same output. Also builds a page index
// (section tree) for reasoning-based retrieval in the spirit of PageIndex (VectifyAI, MIT).
import { pageTables, readingOrder, figureRegions, pictureGroups, imageRules } from './pdf-layout.js';
import { findCharts, chartBlock, outlineTextAreas, outlinedWords, chartPictures, chartPictureShapes, looksLikeBars } from './pdf-charts.js';
import { fixPageText, rereadItems, joinWrapped, lineEnd, recoverLostGlyphs, respaceItems, unspacedGap, bidiRuns } from './pdf-text-fixes.js';
import { pictureRegions } from './ocr-pictures.js';
import { garbledText } from './ocr-languages.js';

const UNTRUSTED = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F‪-‮⁦-⁩]/g;
const round = n => Math.round(n * 100) / 100;
const median = values => { const s = [...values].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };
// Smallest and largest of a list that may be long (Math.min(...list) overflows the stack past ~100,000 values).
const lowest = values => values.reduce((m, v) => (v < m ? v : m), Infinity);
const highest = values => values.reduce((m, v) => (v > m ? v : m), -Infinity);

// Font weights from style names, heaviest names first so "SemiBold" isn't read as "Bold" (CSS numbers).
const WEIGHTS = [[/hairline|thin/i, 100], [/(extra|ultra)-?light/i, 200], [/light/i, 300], [/medium/i, 500], [/(semi|demi)-?bold|demi/i, 600], [/(extra|ultra)-?bold|heavy/i, 800], [/black/i, 900], [/bold/i, 700]];

/** Font facts from the PDF.js font object (loaded by getOperatorList): name, bold, italic, weight (100-900). */
function fontInfo(page, fontName, styles) {
  let font = null;
  try { font = page.commonObjs.has(fontName) ? page.commonObjs.get(fontName) : null; } catch { /* not loaded */ }
  const name = String(font?.name || font?.loadedName || styles[fontName]?.fontFamily || '').replace(/^[A-Z]{6}\+/, '');
  const style = name.includes('-') ? name.slice(name.lastIndexOf('-')) : name.includes(',') ? name.slice(name.lastIndexOf(',')) : '';
  // Short style codes too (HelveticaNeue-HvCn, -MdIt, -Bd, -Lt).
  const code = /^[-,](Ult|X|Ex|S|Sm|Dm)?(Th|Lt|Md|Bd|Hv|Blk)(?![a-z])/.exec(style);
  // Japanese faces number their weights (HiraginoSans-W3 for text, -W6 for bold).
  const numbered = /^-W([0-9])$/.exec(style);
  let weight = code ? { Th: 100, Lt: code[1] ? 200 : 300, Md: 500, Bd: code[1] === 'X' || code[1] === 'Ex' ? 800 : code[1] ? 600 : 700, Hv: 800, Blk: 900 }[code[2]]
    : numbered ? (Number(numbered[1]) >= 6 ? 700 : Number(numbered[1]) >= 4 ? 500 : 400) : WEIGHTS.find(([re]) => re.test(style))?.[1] || 400;
  if ((font?.bold || font?.black) && weight < 700) weight = font?.black ? 900 : 700;
  return {
    font: name, weight,
    // Names such as Arial-BoldMT and Times-Italic, or a short style suffix (AdvTT1234.B, .I, .BI; Font,Bold).
    bold: Boolean(font?.bold || font?.black) || weight >= 700 || /bold|black|heavy|semibold|demi/i.test(name) || /[.,-](B|BI|Bd|BdIt)(\+|$)/.test(name),
    italic: Boolean(font?.italic) || /italic|oblique/i.test(name) || /[.,-](I|BI|It|BdIt)(\+|$)/.test(name),
  };
}

const MAX_SEGMENTS = 20000; // a page drawn with more line pieces than this is a drawing (map, chart), not a table
const SWATCH = /^[■▪◼⬛●⬤▬▮█]$/u;
const MAX_SHAPE_POINTS = 60000;
const MAX_FILL_POINTS = 20000; // outline points of filled shapes (pie slices, areas) kept for reading charts
const MAX_MARKS = 20000; // boxes of painted shapes kept for finding pictures drawn as shapes // corners of filled rectangles and points of lines kept for finding charts (pdf-charts.js)

/** An axis-aligned rectangle from the corners of a closed subpath, or null. */
function rectOf(pts) {
  const n = pts.length - (pts.length === 5 && Math.abs(pts[0][0] - pts[4][0]) < 0.01 && Math.abs(pts[0][1] - pts[4][1]) < 0.01 ? 1 : 0);
  if (n !== 4) return null;
  for (let k = 0; k < 4; k++) {
    const [ax, ay] = pts[k], [bx, by] = pts[(k + 1) % 4];
    if (Math.abs(ax - bx) > 0.5 && Math.abs(ay - by) > 0.5) return null;
  }
  const xs = pts.slice(0, 4).map(p => p[0]), ys = pts.slice(0, 4).map(p => p[1]);
  return { x0: round(Math.min(...xs)), y0: round(Math.min(...ys)), x1: round(Math.max(...xs)), y1: round(Math.max(...ys)) };
}

/**
 * What a page draws besides text, from its operator list: image placements as [x, y, width, height], the
 * horizontal and vertical lines (strokes, thin filled rectangles, edges of stroked rectangles) that rule tables,
 * and, for charts, filled rectangles and stroked lines with their colours (`shapes`), all in top-left page
 * coordinates (points).
 */
function drawings(ops, pdfjs, viewport, { images = true } = {}) {
  const OPS = pdfjs.OPS, boxes = [], h = [], v = [], shapes = { rects: [], lines: [], swatches: [], dots: [], fills: [] }, marks = [];
  const stack = [], multiply = (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
  const stroked = new Set([OPS.stroke, OPS.closeStroke, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);
  const filled = new Set([OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);
  let ctm = [1, 0, 0, 1, 0, 0], segments = 0, fill = '#000000', strokeColor = '#000000', dash = false, budget = MAX_SHAPE_POINTS, fillBudget = MAX_FILL_POINTS;
  // Rectangular clipping (page space, PDF units) and where each run of text starts, to tell text clipped out of sight.
  let clip = null, clipping = false, tm = [1, 0, 0, 1, 0, 0], tlm = tm, leading = 0, moved = true;
  const runs = [];
  const toPage = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  const within = box => {
    if (!box) return;
    clip = clip ? { x0: Math.max(clip.x0, box.x0), y0: Math.max(clip.y0, box.y0), x1: Math.min(clip.x1, box.x1), y1: Math.min(clip.y1, box.y1) } : box;
  };
  const pageBox = (x0, y0, x1, y1) => {
    if (ctm[1] || ctm[2]) return null; // rotated or skewed: not an upright rectangle on the page
    const [ax, ay] = toPage(ctm, x0, y0), [bx, by] = toPage(ctm, x1, y1);
    return { x0: Math.min(ax, bx), y0: Math.min(ay, by), x1: Math.max(ax, bx), y1: Math.max(ay, by) };
  };
  // The clip (page space) as a box in viewport points.
  const clipBox = c => {
    const [ax, ay] = viewport.convertToViewportPoint(c.x0, c.y0), [bx, by] = viewport.convertToViewportPoint(c.x1, c.y1);
    return { x0: Math.min(ax, bx), y0: Math.min(ay, by), x1: Math.max(ax, bx), y1: Math.max(ay, by) };
  };
  /**
   * A polyline cut to a box: the runs of it inside (each segment cut where it crosses the edge). The polyline itself
   * when it lies inside (to within a point).
   */
  function clippedRuns(pts, box) {
    const out = (x, y) => x < box.x0 - 1 || x > box.x1 + 1 || y < box.y0 - 1 || y > box.y1 + 1;
    if (!pts.some(([x, y]) => out(x, y))) return [pts];
    const runs = [];
    let run = null;
    for (let k = 1; k < pts.length; k++) {
      const [ax, ay] = pts[k - 1], [bx, by] = pts[k], dx = bx - ax, dy = by - ay;
      // Liang–Barsky: the part of the segment from t0 to t1 lies inside.
      let t0 = 0, t1 = 1, keep = true;
      for (const [p, q] of [[-dx, ax - box.x0], [dx, box.x1 - ax], [-dy, ay - box.y0], [dy, box.y1 - ay]]) {
        if (p === 0) { if (q < 0) keep = false; continue; }
        const r = q / p;
        if (p < 0) { if (r > t1) keep = false; else if (r > t0) t0 = r; } else if (r < t0) keep = false; else if (r < t1) t1 = r;
      }
      if (!keep) { run = null; continue; }
      const a = [ax + dx * t0, ay + dy * t0], b = [ax + dx * t1, ay + dy * t1];
      if (run && t0 === 0) run.push(b);
      else { run = [a, b]; runs.push(run); }
      if (t1 < 1) run = null;
    }
    return runs.filter(r => r.length >= 2 && Math.hypot(r.at(-1)[0] - r[0][0], r.at(-1)[1] - r[0][1]) >= 0.5);
  }
  const moveText = (tx, ty) => { tlm = multiply(tlm, [1, 0, 0, 1, tx, ty]); tm = tlm; moved = true; };
  const point = (x, y) => viewport.convertToViewportPoint(ctm[0] * x + ctm[2] * y + ctm[4], ctm[1] * x + ctm[3] * y + ctm[5]);
  // Dashes of a border drawn as many short strokes (1 to 4 pt each), joined into rules after the walk (dashedRules).
  const dashes = { h: [], v: [] };
  const line = ([ax, ay], [bx, by], dash = false) => {
    if (Math.abs(ay - by) <= 1 && Math.abs(ax - bx) >= 4) h.push({ y: round((ay + by) / 2), x0: round(Math.min(ax, bx)), x1: round(Math.max(ax, bx)) });
    else if (Math.abs(ax - bx) <= 1 && Math.abs(ay - by) >= 4) v.push({ x: round((ax + bx) / 2), y0: round(Math.min(ay, by)), y1: round(Math.max(ay, by)) });
    else if (dash && Math.abs(ay - by) <= 1 && Math.abs(ax - bx) >= 1 && dashes.h.length < MAX_MARKS) dashes.h.push({ y: (ay + by) / 2, x0: Math.min(ax, bx), x1: Math.max(ax, bx) });
    else if (dash && Math.abs(ax - bx) <= 1 && Math.abs(ay - by) >= 1 && dashes.v.length < MAX_MARKS) dashes.v.push({ x: (ax + bx) / 2, y0: Math.min(ay, by), y1: Math.max(ay, by) });
  };
  const color = args => (typeof args?.[0] === 'string' ? args[0].toLowerCase() : null);
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i], args = ops.argsArray[i];
    if (fn === OPS.save || fn === OPS.paintFormXObjectBegin) {
      stack.push([ctm, fill, strokeColor, dash, clip]);
      if (fn === OPS.paintFormXObjectBegin && (Array.isArray(args?.[0]) || ArrayBuffer.isView(args?.[0]))) ctm = multiply(ctm, [...args[0]]);
      // A form draws only inside its bounding box.
      const bbox = fn === OPS.paintFormXObjectBegin && args?.[1];
      if (bbox?.length === 4) within(pageBox(bbox[0], bbox[1], bbox[2], bbox[3]));
    } else if (fn === OPS.restore || fn === OPS.paintFormXObjectEnd) [ctm, fill, strokeColor, dash, clip] = stack.pop() || [[1, 0, 0, 1, 0, 0], '#000000', '#000000', false, null];
    else if (fn === OPS.clip || fn === OPS.eoClip) clipping = true;
    else if (fn === OPS.beginText) { tm = tlm = [1, 0, 0, 1, 0, 0]; moved = true; }
    else if (fn === OPS.setTextMatrix) { tm = tlm = Array.from(args?.[0]?.length === 6 ? args[0] : args); moved = true; }
    else if (fn === OPS.moveText) moveText(args[0], args[1]);
    else if (fn === OPS.setLeadingMoveText) { leading = -args[1]; moveText(args[0], args[1]); }
    else if (fn === OPS.setLeading) leading = args[0];
    else if (fn === OPS.nextLine) moveText(0, -leading);
    else if (fn === OPS.transform) ctm = multiply(ctm, args);
    else if (fn === OPS.setFillRGBColor) fill = color(args) || fill;
    else if (fn === OPS.setStrokeRGBColor) strokeColor = color(args) || strokeColor;
    else if (fn === OPS.setDash) dash = args?.[0]?.length ? [...args[0]].map(round).join(',') : false; // its pattern
    else if (fn === OPS.showText || fn === OPS.showSpacedText || fn === OPS.nextLineShowText || fn === OPS.nextLineSetSpacingShowText) {
      if (fn === OPS.nextLineShowText || fn === OPS.nextLineSetSpacingShowText) moveText(0, -leading);
      // Where a run starts (a run carrying on from the last one shares its start) and the clip it is drawn under.
      if (moved && runs.length < MAX_MARKS) { const [x, y] = toPage(multiply(ctm, tm), 0, 0); runs.push({ x, y, clip }); }
      moved = false;
      // Legend swatches set as text (■ in the series colour): their colours, in the order they are drawn.
      for (const g of (fn === OPS.showText || fn === OPS.showSpacedText ? args?.[0] : args?.at(-1)) || []) if (typeof g?.unicode === 'string' && SWATCH.test(g.unicode) && shapes.swatches.length < 200) shapes.swatches.push(fill);
    }
    else if (images && (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject || fn === OPS.paintImageMaskXObject)) {
      // What shows of it: its box cut to the rectangle it is clipped to, and to the page.
      const own = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([u, w]) => toPage(ctm, u, w));
      let [px0, py0, px1, py1] = [lowest(own.map(c => c[0])), lowest(own.map(c => c[1])), highest(own.map(c => c[0])), highest(own.map(c => c[1]))];
      if (clip) [px0, py0, px1, py1] = [Math.max(px0, clip.x0), Math.max(py0, clip.y0), Math.min(px1, clip.x1), Math.min(py1, clip.y1)];
      const corners = [[px0, py0], [px1, py1]].map(([x, y]) => viewport.convertToViewportPoint(x, y));
      const xs = corners.map(c => Math.max(0, Math.min(viewport.width, c[0]))), ys = corners.map(c => Math.max(0, Math.min(viewport.height, c[1])));
      const box = [Math.min(...xs), Math.min(...ys), Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)].map(round);
      if (px1 > px0 && py1 > py0 && box[2] >= 4 && box[3] >= 4) boxes.push(box);
    } else if (fn === OPS.constructPath && clipping) {
      // A clipping path: a single rectangle narrows the clip; other shapes are not followed (the clip stays as it was).
      clipping = false;
      const [paint, [data] = []] = args || [];
      const r = data && data.length <= 13 && data[0] === 0 && args[2]?.length === 4 ? rectOf(rectPoints(data)) : null;
      if (r) within(pageBox(r.x0, r.y0, r.x1, r.y1));
      if (paint === OPS.endPath) continue;
      i--; continue; // painted as well as clipping: read it again as a shape
    } else if (fn === OPS.constructPath && (segments <= MAX_SEGMENTS || budget > 0)) {
      const [paint, [data] = []] = args || [];
      if (!data || !(stroked.has(paint) || filled.has(paint))) continue;
      // Subpaths as point lists (curves end at their last point), and for filled shapes the outline with curves
      // followed (`flat`, eight points a curve), for reading pie slices and areas.
      const paths = [];
      let current = null, x = 0, y = 0;
      const wantFlat = (filled.has(paint) && fillBudget > 0) || (stroked.has(paint) && budget > 0);
      const curve = (c1x, c1y, c2x, c2y, ex, ey) => {
        if (!current) return;
        current.push(point(ex, ey)); current.curved = true;
        if (wantFlat) for (let n = 1; n <= 8; n++) {
          const t = n / 8, u = 1 - t;
          current.flat.push(point(u * u * u * x + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * ex, u * u * u * y + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * ey));
        }
      };
      for (let k = 0; k < data.length;) {
        const op = data[k++];
        if (op === 0) { current = [point(data[k], data[k + 1])]; current.flat = [current[0]]; paths.push(current); [x, y] = [data[k], data[k + 1]]; k += 2; }
        else if (op === 1) { if (current) { current.push(point(data[k], data[k + 1])); current.flat.push(current.at(-1)); } [x, y] = [data[k], data[k + 1]]; k += 2; }
        else if (op === 2) { curve(data[k], data[k + 1], data[k + 2], data[k + 3], data[k + 4], data[k + 5]); [x, y] = [data[k + 4], data[k + 5]]; k += 6; }
        else if (op === 3) {
          // Quadratic: the same curve as a cubic.
          const [qx, qy, ex, ey] = [data[k], data[k + 1], data[k + 2], data[k + 3]];
          curve(x + (qx - x) * 2 / 3, y + (qy - y) * 2 / 3, ex + (qx - ex) * 2 / 3, ey + (qy - ey) * 2 / 3, ex, ey); [x, y] = [ex, ey]; k += 4;
        }
        else if (op === 4) { if (current?.length) { current.push(current[0]); current.flat.push(current[0]); } }
        else break;
      }
      for (const pts of paths) {
        segments += pts.length;
        // Every painted shape's box, for finding pictures drawn as shapes (figureRegions in pdf-layout.js).
        if (marks.length < MAX_MARKS && pts.length >= 2) {
          let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
          for (const [x, y] of pts) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
          const colour = filled.has(paint) ? fill : strokeColor;
          if (x1 - x0 >= 0.5 || y1 - y0 >= 0.5) marks.push({ x0, y0, x1, y1, rect: pts.length <= 5 && Boolean(rectOf(pts)), curved: Boolean(pts.curved), light: /^#(f[0-9a-f]){3}$/i.test(colour), stroked: !filled.has(paint) });
        }
        if (budget > 0 && filled.has(paint)) {
          const r = rectOf(pts);
          if (r) { shapes.rects.push({ ...r, color: fill }); budget -= 4; }
          else if (pts.length >= 3) {
            // Other filled shapes up to half the page each way (legend dots, chart markers, bars with rounded corners, pie
            // slices), as their box, colour and number of points.
            const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]), w = Math.max(...xs) - Math.min(...xs), hh = Math.max(...ys) - Math.min(...ys);
            if (w >= 1.5 && hh >= 1.5 && w <= viewport.width / 2 && hh <= viewport.height / 2) { shapes.dots.push({ x0: round(Math.min(...xs)), y0: round(Math.min(...ys)), x1: round(Math.max(...xs)), y1: round(Math.max(...ys)), color: fill, points: pts.length }); budget -= 4; }
            // Larger ones with their outline (pie slices, areas under lines): curved, or of five points or more.
            if (fillBudget > 0 && Math.max(w, hh) >= 6 && w <= viewport.width && hh <= viewport.height && (pts.curved || pts.length >= 5) && pts.flat.length <= 4000) {
              // (Its box from the outline followed along its curves: an arc bulges past its end points.)
              const fx = pts.flat.map(p => p[0]), fy = pts.flat.map(p => p[1]);
              shapes.fills.push({ x0: round(Math.min(...fx)), y0: round(Math.min(...fy)), x1: round(Math.max(...fx)), y1: round(Math.max(...fy)), color: fill, curved: Boolean(pts.curved), pts: pts.flat.map(([px, py]) => [round(px), round(py)]) });
              fillBudget -= pts.flat.length;
            }
          }
        }
        // Outlines that close on themselves (map borders, icons) aren't chart lines.
        const outline = pts.length > 5 && Math.abs(pts[0][0] - pts.at(-1)[0]) < 0.5 && Math.abs(pts[0][1] - pts.at(-1)[1]) < 0.5;
        // A curved line keeps the points followed along its curves (a smoothed line read between its knots) and
        // its knots.
        const along = pts.curved && pts.flat.length <= 4000 ? pts.flat : pts;
        if (budget > 0 && stroked.has(paint) && pts.length >= 2 && pts.length <= 2000 && !outline) {
          // A line drawn past the clip (a chart line starting off the page, cut to its plot) is kept as far as it shows.
          // (Only a line that runs off the page: one drawn on it is kept whole, as before.)
          const offPage = along.some(([x, y]) => x < -1 || y < -1 || x > viewport.width + 1 || y > viewport.height + 1);
          const shown = clip && offPage ? clippedRuns(along, clipBox(clip)) : [along];
          for (const run of shown) shapes.lines.push({ pts: run.map(([x, y]) => [round(x), round(y)]), color: strokeColor, ...(dash && { dash }), ...(run === along && along !== pts && { knots: pts.map(([x, y]) => [round(x), round(y)]) }) });
          budget -= along.length;
        }
        if (segments > MAX_SEGMENTS) continue;
        // (A dash is a stroke of its own: short pieces of a longer path, such as the points of a chart line, are not.)
        if (stroked.has(paint)) for (let k = 1; k < pts.length; k++) line(pts[k - 1], pts[k], pts.length === 2);
        else if (pts.length >= 4) {
          // A thin filled rectangle is a line.
          const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
          const x0 = lowest(xs), x1 = highest(xs), y0 = lowest(ys), y1 = highest(ys);
          if (y1 - y0 <= 3 && x1 - x0 >= 4) h.push({ y: round((y0 + y1) / 2), x0: round(x0), x1: round(x1) });
          else if (x1 - x0 <= 3 && y1 - y0 >= 4) v.push({ x: round((x0 + x1) / 2), y0: round(y0), y1: round(y1) });
          else if (y1 - y0 <= 1.5 && x1 - x0 >= 1 && x1 - x0 < 4 && dashes.h.length < MAX_MARKS && rectOf(pts)) dashes.h.push({ y: (y0 + y1) / 2, x0, x1 });
          else if (x1 - x0 <= 1.5 && y1 - y0 >= 1 && y1 - y0 < 4 && dashes.v.length < MAX_MARKS && rectOf(pts)) dashes.v.push({ x: (x0 + x1) / 2, y0, y1 });
        }
      }
    }
  }
  if (segments <= MAX_SEGMENTS) dashedRules(dashes, h, v);
  return { boxes, rules: segments > MAX_SEGMENTS ? { h: [], v: [] } : { h, v }, shapes, marks, runs };
}

/**
 * Borders drawn as rows of short dashes: dashes on one line (within half a point), each 1 to 4 pt, with gaps of at
 * most 6 pt, four or more of them covering 20 pt or more, become one rule. Dots under 1 pt (dotted leaders drawn as
 * shapes) are not dashes.
 */
function dashedRules(dashes, h, v) {
  const chain = (list, at, from, to, push) => {
    list.sort((a, b) => at(a) - at(b) || from(a) - from(b));
    for (let k = 0; k < list.length;) {
      let j = k + 1;
      while (j < list.length && Math.abs(at(list[j]) - at(list[k])) <= 0.5) j++;
      const row = list.slice(k, j).sort((a, b) => from(a) - from(b));
      let start = 0;
      for (let n = 1; n <= row.length; n++) {
        if (n < row.length && from(row[n]) - to(row[n - 1]) <= 6) continue;
        const run = row.slice(start, n);
        if (run.length >= 4 && to(run.at(-1)) - from(run[0]) >= 20) push(at(run[0]), from(run[0]), highest(run.map(to)));
        start = n;
      }
      k = j;
    }
  };
  chain(dashes.h, d => d.y, d => d.x0, d => d.x1, (y, x0, x1) => h.push({ y: round(y), x0: round(x0), x1: round(x1), dashed: true }));
  chain(dashes.v, d => d.x, d => d.y0, d => d.y1, (x, y0, y1) => v.push({ x: round(x), y0: round(y0), y1: round(y1) }));
}

/** The points of a path built from move/line/close operations (pdf.js path data), in its own coordinates. */
function rectPoints(data) {
  const pts = [];
  for (let k = 0; k < data.length;) {
    const op = data[k++];
    if (op === 0 || op === 1) { pts.push([data[k], data[k + 1]]); k += 2; }
    else if (op === 4) { if (pts.length) pts.push(pts[0]); }
    else return [];
  }
  return pts;
}

/**
 * Text drawn where a clipping rectangle hides it (a placed graphic repeated with only part of each copy showing): the
 * text items whose whole box lies outside the clip of the run they start, matched in drawing order with the runs the
 * operator list shows. Items that start no run (pieces of a run, or runs not followed) are kept.
 */
function clippedOut(items, runs) {
  if (!runs?.some(r => r.clip)) return new Set();
  const hidden = new Set();
  let j = 0, clip = null;
  for (const i of items) {
    if (!('str' in i) || !i.str) continue;
    const [x, y] = [i.transform[4], i.transform[5]];
    clip = null;
    for (let k = j; k < Math.min(runs.length, j + 50); k++) if (Math.abs(runs[k].x - x) <= 0.5 && Math.abs(runs[k].y - y) <= 0.5) { j = k + 1; clip = runs[k].clip; break; }
    if (!clip || i.transform[1] || i.transform[2]) continue;
    const size = Math.abs(i.transform[3]) || i.height || 0;
    const [x0, x1] = [Math.min(x, x + i.width), Math.max(x, x + i.width)], [y0, y1] = [y - size * 0.25, y + size * 0.8];
    if (x1 <= clip.x0 + 0.5 || x0 >= clip.x1 - 0.5 || y1 <= clip.y0 + 0.5 || y0 >= clip.y1 - 0.5) hidden.add(i);
  }
  return hidden;
}

// fontkit (@pdf-lib/fontkit, MIT) reads glyph outlines from the font programs PDF.js has loaded; it is loaded by
// extractStructure, and until then stroke widths are not measured.
let fontkit = null;
const stems = new WeakMap();

/**
 * How thick a font's strokes are drawn, in thousandths of an em, from the outlines of its first glyphs: twice the
 * ink area over the outline length (a stroke of width w and length L has area wL and outline 2L). Regular text
 * runs about 70-90, bold about 115 and up. 0 when the font program can't be read. Like the StemV a font descriptor
 * may carry (which PDF.js doesn't read, and which many PDFs leave at 0), but measured from the glyphs themselves,
 * so it works for fonts whose names say nothing of their weight ("font000002f4", "F1", subsets of one family).
 */
function fontStem(font) {
  if (!fontkit || !font?.data || font.isType3Font) return 0;
  if (stems.has(font)) return stems.get(font);
  let stem = 0;
  try {
    const face = fontkit.create(font.data instanceof Uint8Array ? font.data : new Uint8Array(font.data));
    let area = 0, length = 0, glyphs = 0;
    for (let id = 1; id < Math.min(face.numGlyphs, 65); id++) {
      const measured = glyphInk(face.getGlyph(id).path.commands);
      if (measured.area > 0) { area += measured.area; length += measured.length; glyphs++; }
    }
    if (glyphs >= 3 && length > 0 && face.unitsPerEm > 0) stem = 2 * area / length / face.unitsPerEm * 1000;
  } catch { /* a font program fontkit can't read: no measure */ }
  stems.set(font, stem);
  return stem;
}

/** Ink area and outline length of a glyph's path (curves followed in four steps). */
function glyphInk(commands) {
  let area = 0, length = 0, start = null, x = 0, y = 0, signed = 0;
  const to = (nx, ny) => { signed += x * ny - nx * y; length += Math.hypot(nx - x, ny - y); x = nx; y = ny; };
  const close = () => { if (start) to(start[0], start[1]); start = null; };
  for (const { command, args: a } of commands) {
    if (command === 'moveTo') { close(); start = [a[0], a[1]]; x = a[0]; y = a[1]; }
    else if (command === 'lineTo') to(a[0], a[1]);
    else if (command === 'quadraticCurveTo') { const [x0, y0] = [x, y]; for (let t = 0.25; t <= 1; t += 0.25) { const u = 1 - t; to(u * u * x0 + 2 * u * t * a[0] + t * t * a[2], u * u * y0 + 2 * u * t * a[1] + t * t * a[3]); } }
    else if (command === 'bezierCurveTo') { const [x0, y0] = [x, y]; for (let t = 0.25; t <= 1; t += 0.25) { const u = 1 - t; to(u * u * u * x0 + 3 * u * u * t * a[0] + 3 * u * t * t * a[2] + t * t * t * a[4], u * u * u * y0 + 3 * u * u * t * a[1] + 3 * u * t * t * a[3] + t * t * t * a[5]); } }
    else if (command === 'closePath') close();
  }
  close();
  area = Math.abs(signed) / 2;
  return { area, length };
}

/** Text items with positions (top-left origin, points), font size and the facts of fonts already loaded. */
function textItems(page, viewport, content) {
  const heavier = heavierCuts(page, content);
  return content.items.filter(i => 'str' in i && i.str).map(i => {
    const [x, yBase] = viewport.convertToViewportPoint(i.transform[4], i.transform[5]);
    const size = Math.hypot(i.transform[2], i.transform[3]) || i.height || 10;
    // Text set at an angle (chart labels): its direction on the page in degrees, counter-clockwise.
    let angle = 0;
    if (i.transform[1] || i.transform[2] || viewport.rotation) {
      const [ex, ey] = viewport.convertToViewportPoint(i.transform[4] + i.transform[0], i.transform[5] + i.transform[1]);
      angle = Math.round(Math.atan2(yBase - ey, ex - x) * 180 / Math.PI);
    }
    const font = fontInfo(page, i.fontName, content.styles);
    if (heavier.has(i.fontName) && !font.bold) Object.assign(font, { bold: true, weight: Math.max(font.weight, 700) });
    let stem = 0;
    try { stem = fontkit && page.commonObjs.has(i.fontName) ? fontStem(page.commonObjs.get(i.fontName)) : 0; } catch { /* not loaded */ }
    return { text: i.str.replace(UNTRUSTED, ''), x, y: yBase - size, width: i.width, size, ...font, ...(angle && { angle }), ...(stem && { stem }) };
  });
}

// Helvetica's advance widths (1/1000 em) for ASCII 32-126: a yardstick for how wide a cut sets the same text.
const YARDSTICK = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];

/**
 * Fonts set heavier than another cut of the same font on the page whose name doesn't say so (a variable font's bold
 * instance, or subsets named only by a number, keep the family's name): the same letters run at least 4% wider than
 * in the cut used most, from the fonts' widths where both have them by character code, otherwise from how wide each
 * sets its text against a yardstick.
 */
function heavierCuts(page, content) {
  const cuts = new Map();
  for (const i of content.items) {
    if (!i.str || !i.fontName) continue;
    const cut = cuts.get(i.fontName) || { id: i.fontName, used: 0, set: 0, yard: 0, measured: 0 };
    cut.used += i.str.length;
    const size = Math.abs(i.transform[3]);
    if (!i.transform[1] && !i.transform[2] && size > 0 && i.width > 0 && /^[\x20-\x7e]+$/.test(i.str)) {
      for (const c of i.str) cut.yard += YARDSTICK[c.charCodeAt(0) - 32];
      cut.set += i.width / size * 1000; cut.measured += i.str.length;
    }
    cuts.set(i.fontName, cut);
  }
  const families = new Map();
  for (const cut of cuts.values()) {
    let font = null;
    try { font = page.commonObjs.has(cut.id) ? page.commonObjs.get(cut.id) : null; } catch { /* not loaded */ }
    if (!font?.name) continue;
    if (!font.composite && Array.isArray(font.widths)) Object.assign(cut, { widths: font.widths, glyph: code => font.differences?.[code] ?? font.defaultEncoding?.[code] });
    const family = String(font.name).replace(/^[A-Z]{6}\+/, '');
    if (!families.has(family)) families.set(family, []);
    families.get(family).push(cut);
  }
  const heavier = new Set();
  for (const family of families.values()) {
    if (family.length < 2) continue;
    const main = family.reduce((a, b) => (b.used > a.used ? b : a));
    for (const cut of family) {
      if (cut === main) continue;
      let a = 0, b = 0, n = 0;
      // Only codes that name the same glyph in both (subsets can encode letters differently).
      if (main.widths && cut.widths) for (let code = 33; code < 256; code++) if (main.widths[code] > 0 && cut.widths[code] > 0 && main.glyph(code) === cut.glyph(code)) { a += main.widths[code]; b += cut.widths[code]; n++; }
      if (n < 8 && main.measured >= 15 && cut.measured >= 15) { a = main.set / main.yard; b = cut.set / cut.yard; n = 8; }
      if (n >= 8 && b >= a * 1.04) heavier.add(cut.id);
    }
  }
  return heavier;
}

/**
 * Text items of one PDF.js page with positions (top-left origin, points), font size and font facts, plus
 * image boxes and the lines the page draws (`rules`, for tables). Shared by extractStructure and the
 * spreadsheet and slide exports (pdf-tables.js, pptx-export.js).
 * `fonts: false` skips loading the page's fonts (PDF.js loads them with the operator list, which also decodes
 * the page's images), so bold and italic are known only for fonts an earlier page loaded, and lines are not read.
 */
export async function pageItems(pdfjs, page, { images = true, fonts = true } = {}) {
  const viewport = page.getViewport({ scale: 1 });
  const ops = images || fonts ? await page.getOperatorList() : null;
  const { boxes, rules, shapes, marks, runs } = ops ? drawings(ops, pdfjs, viewport, { images }) : { boxes: [], rules: null, shapes: null, marks: null };
  const content = await page.getTextContent();
  // Spaces PDF.js adds that aren't word spaces taken out, and letters drawn without a Unicode mapping put back from
  // their outlines (pdf-text-fixes.js).
  if (ops) respaceItems(page, ops, content, pdfjs);
  if (ops) await recoverLostGlyphs(page, ops, content, pdfjs);
  const hidden = clippedOut(content.items, runs);
  if (hidden.size) content.items = content.items.filter(i => !hidden.has(i));
  const text = textItems(page, viewport, content);
  const items = overprinted(ops ? outlinedBold(ops, pdfjs, text) : text);
  // Swatches set as text take their colour from the drawing, in order.
  if (shapes?.swatches.length) {
    let k = 0;
    for (const item of items) {
      const count = [...item.text].filter(c => SWATCH.test(c)).length;
      if (count === 1 && SWATCH.test(item.text.trim())) item.color = shapes.swatches[k];
      k += count;
    }
  }
  return { viewport, items, boxes, rules, shapes, marks, content };
}

const ENCLOSED = /[\u2460-\u24FF\u2776-\u2793\u3251-\u325F\u32B1-\u32BF]/u;

/**
 * Text drawn filled and outlined (text render mode 1 or 2) to look bold, as word processors do for bold in fonts that
 * have no bold: the drawn glyphs, in order, are matched to the text items' characters (whitespace aside), and the
 * outlined part of an item becomes an item of its own in bold (placed in proportion to its characters). When the two
 * don't line up (text the viewer reorders or normalizes), the items are left as they are.
 */
function outlinedBold(ops, pdfjs, items) {
  const { OPS } = pdfjs, stack = [], drawn = [];
  if (!ops.fnArray.some((fn, i) => fn === OPS.setTextRenderingMode && (ops.argsArray[i][0] === 1 || ops.argsArray[i][0] === 2))) return items;
  let mode = 0, any = false;
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    if (fn === OPS.save || fn === OPS.paintFormXObjectBegin) stack.push(mode);
    else if (fn === OPS.restore || fn === OPS.paintFormXObjectEnd) mode = stack.pop() ?? 0;
    else if (fn === OPS.setTextRenderingMode) mode = ops.argsArray[i][0];
    else if (fn === OPS.showText) {
      const outlined = mode === 1 || mode === 2;
      any ||= outlined;
      for (const g of ops.argsArray[i][0] || []) if (typeof g?.unicode === 'string') for (const c of g.unicode.normalize('NFKC')) if (c.trim()) drawn.push(outlined);
    }
  }
  if (!any) return items;
  const chars = items.reduce((n, item) => n + item.text.normalize('NFKC').replace(/\s+/g, '').length, 0);
  if (chars !== drawn.length) return items;
  let k = 0;
  return items.flatMap(item => {
    // Read in NFKC (as the drawn glyphs are counted), except numbers in circles, which NFKC would make plain figures
    // ("①" is not "1").
    const text = [...item.text].map(c => (ENCLOSED.test(c) ? c : c.normalize('NFKC'))).join('');
    if (item.text.normalize('NFKC').length !== item.text.length) { k += item.text.normalize('NFKC').replace(/\s+/g, '').length; return [item]; }
    // Each character's outline flag (spaces take the one before), then runs of one flag.
    let last = false;
    const flags = [...text].map(c => (c.trim() ? (last = drawn[k++]) : last));
    const runs = [];
    flags.forEach((flag, j) => { if (runs.at(-1)?.flag === flag) runs.at(-1).end = j + 1; else runs.push({ flag, start: j, end: j + 1 }); });
    const per = item.width / Math.max(1, text.length);
    return runs.map(({ flag, start, end }) => ({ ...item, text: text.slice(start, end), x: item.x + start * per, width: (end - start) * per,
      ...(flag && !item.bold && { bold: true, weight: Math.max(item.weight || 400, 700) }) }));
  });
}

/**
 * Text drawn twice a little apart to look bold (an old way of faking bold): one copy is kept, in bold, so the words
 * aren't doubled ("TitleTitle").
 */
function overprinted(items) {
  const seen = new Map(), out = [];
  for (const item of items) {
    const key = k => `${item.text}|${k}`, row = Math.round(item.y);
    const twin = item.text.trim() && [row - 1, row, row + 1].flatMap(k => seen.get(key(k)) || [])
      .find(o => Math.abs(o.x - item.x) <= item.size * 0.2 && Math.abs(o.y - item.y) <= item.size * 0.2 && Math.abs(o.size - item.size) <= item.size * 0.1);
    if (twin) { twin.bold = true; continue; }
    if (!seen.has(key(row))) seen.set(key(row), []);
    seen.get(key(row)).push(item);
    out.push(item);
  }
  return drawnTwice(out);
}

/**
 * Pieces of text drawn again over a longer run of the same text (a line drawn in parts and then whole, "市役所代" and
 * "表" over "市役所代表"): a piece lying inside another item on the same row, in the same size, whose text holds the
 * piece's at about the same place, is left out.
 */
function drawnTwice(items) {
  const rows = new Map();
  for (const i of items) {
    if (!i.text.trim() || i.angle) continue;
    const r = Math.round(i.y / 2);
    if (!rows.has(r)) rows.set(r, []);
    rows.get(r).push(i);
  }
  const drop = new Set();
  for (const [r, list] of rows) {
    if (list.length > 400) continue;
    const near = [...list, ...(rows.get(r - 1) || []), ...(rows.get(r + 1) || [])];
    for (const a of list) {
      const t = a.text.trim(), tol = a.size * 0.2;
      for (const b of near) {
        if (a === b || drop.has(b) || b.text.trim().length <= t.length || Math.abs(a.y - b.y) > tol || Math.abs(a.size - b.size) > a.size * 0.1) continue;
        if (a.x < b.x - tol || a.x + a.width > b.x + b.width + tol) continue;
        // Where the piece would sit in the longer text, from how far along it starts (characters of even width).
        const at = (a.x - b.x) / (b.width / Math.max(1, b.text.length)), slack = Math.max(1.5, t.length * 0.15);
        let k = b.text.indexOf(t), found = false;
        while (k >= 0 && !found) { found = Math.abs(k - at) <= slack; k = b.text.indexOf(t, k + 1); }
        if (found) { drop.add(a); break; }
      }
    }
  }
  return drop.size ? items.filter(i => !drop.has(i)) : items;
}

/**
 * Text items, as pageItems makes them, from the words Tesseract recognized on a page drawn at `scale` (its
 * `data` with blocks): words of one recognized line share its baseline, so they read as one row. With `image`, the
 * page as drawn (ImageData of the same picture), words set clearly heavier than the page's text are bold.
 */
export function recognizedItems(data, scale, { minConfidence = 30, image } = {}) {
  const items = [], heft = [];
  let lines = 0;
  for (const block of data?.blocks || []) for (const paragraph of block.paragraphs || []) for (const line of paragraph.lines || []) {
    lines++;
    // Marks with no letter or digit in them are noise from pictures and specks, except a sign read clearly between
    // words of the line ("&", "§", "%").
    const lettered = w => w.confidence >= minConfidence && /[\p{L}\p{N}]/u.test(w.text);
    if (!(line.words || []).some(lettered)) continue;
    const words = line.words.filter(w => lettered(w) || (w.confidence >= 60 && /^[&§%$€£#+=\/–—-]$/u.test(w.text)));
    const bl = line.baseline;
    const base = bl?.has_baseline !== false && bl && Number.isFinite(bl.y0) ? (bl.y0 + bl.y1) / 2 : median(words.map(w => w.bbox.y1));
    const height = Math.max(4, base - median(words.map(w => w.bbox.y0)));
    const size = height / 0.72 / scale;
    // A baseline read askew (a curved or tilted scan) makes the line's letter height far too small and every word on
    // it look heavy: such a line isn't weighed.
    const askew = height < median(words.map(w => w.bbox.y1 - w.bbox.y0)) * 0.5;
    // Words keep the line Tesseract found them in, so a line isn’t split where words were left out or spaced wide.
    for (const w of words) {
      items.push({ text: w.text.replace(UNTRUSTED, ''), x: w.bbox.x0 / scale, y: base / scale - size, width: (w.bbox.x1 - w.bbox.x0) / scale, size, font: '', bold: false, italic: false, ocrLine: lines });
      if (image) heft.push(w.confidence >= SURE && !askew ? strokeWeight(image, w.bbox, height) : 0);
    }
  }
  // A picture with no writing: a stray letter or two is not text.
  if (items.reduce((n, i) => n + (i.text.match(/[\p{L}\p{N}]/gu) || []).length, 0) < 3) return [];
  // The page picture also shows the lines drawn on a scan (table rules), which pdf-layout.js reads (imageRules).
  if (image) { markHeavy(items, heft); items.rules = imageRules(image, scale); }
  return items;
}

const HEAVY = 1.3; // bold strokes run about a third heavier than regular ones
const SURE = 70; // recognizer confidence a word needs for its stroke weight to count (smudges, handwriting and specks read as words are weighed by the line's other words)

/**
 * Bold: words whose strokes are clearly heavier than the page's usual text (the median of its longer words). A word
 * of one character is too small to measure, so it follows its line; a line mostly heavy is bold throughout.
 */
function markHeavy(items, heft) {
  const usual = median(heft.filter((h, k) => h && (items[k].text.match(/\p{L}/gu) || []).length >= 3));
  if (!usual) return;
  const measured = items.map((i, k) => heft[k] > 0 && (i.text.match(/[\p{L}\p{N}]/gu) || []).length >= 2);
  const heavy = heft.map((h, k) => measured[k] && h > usual * HEAVY);
  const lines = new Map();
  items.forEach((item, k) => { if (!lines.has(item.ocrLine)) lines.set(item.ocrLine, []); lines.get(item.ocrLine).push(k); });
  for (const words of lines.values()) {
    const sized = words.filter(k => measured[k]);
    const whole = sized.length > 0 && sized.filter(k => heavy[k]).length >= sized.length * 0.6;
    for (const k of words) if (whole || heavy[k]) items[k].bold = true;
  }
}

/**
 * How heavy a recognized word is set, from the page picture: the mean length of the dark runs along its pixel rows
 * (about the width of its upright strokes) over the height of its letters, or 0 when the box holds no clear ink.
 */
function strokeWeight({ data, width, height: rows }, box, letters) {
  const x0 = Math.max(0, Math.floor(box.x0)), x1 = Math.min(width, Math.ceil(box.x1));
  const y0 = Math.max(0, Math.floor(box.y0)), y1 = Math.min(rows, Math.ceil(box.y1));
  if (x1 - x0 < 2 || y1 - y0 < 2) return 0;
  const shade = (x, y) => { const p = (y * width + x) * 4; return (data[p] + 2 * data[p + 1] + data[p + 2]) >> 2; };
  let lo = 255, hi = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const v = shade(x, y); if (v < lo) lo = v; if (v > hi) hi = v; }
  if (hi - lo < 64) return 0;
  const cut = (lo + hi) / 2;
  let ink = 0, runs = 0;
  for (let y = y0; y < y1; y++) {
    let inside = false;
    for (let x = x0; x < x1; x++) {
      const dark = shade(x, y) < cut;
      if (dark) { ink++; if (!inside) runs++; }
      inside = dark;
    }
  }
  return runs ? ink / runs / letters : 0;
}

// ---------------------------------------------------------------------------------------------- lines

/** Formatting of an item within its line: superscript and subscript are smaller and raised or lowered. */
const formatKey = run => `${run.bold ? 'b' : ''}${run.italic ? 'i' : ''}${run.sup ? '^' : ''}${run.sub ? '_' : ''}${run.underline ? 'u' : ''}${run.strike ? 's' : ''}`;

/**
 * Text underlined or struck through with a drawn line: a horizontal line just under the baseline (underline) or across
 * the middle of the letters (strikethrough) that starts and ends with words of the text it marks. Returns the items,
 * with `underline` or `strike` set, a piece of text split where only some of its words are marked (placed in
 * proportion to its characters).
 */
function markLines(items, rules) {
  if (!rules?.h?.length) return items;
  // Only lines that run just under or through some text are looked at (a page ruled as a large table has thousands):
  // text baselines sorted, and for each line the ones within half the largest type size of it.
  const bases = items.filter(i => !i.angle && i.text.trim()).map(i => i.y + i.size).sort((a, b) => a - b);
  const reach = highest(items.map(i => i.size)) * 0.5;
  const near = r => {
    let lo = 0, hi = bases.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (bases[mid] < r.y - reach) lo = mid + 1; else hi = mid; }
    return lo < bases.length && bases[lo] <= r.y + reach;
  };
  // A line closed at both ends by upright lines is the edge of a table's cell, not an underline.
  const meets = (x, y) => (rules.v || []).some(v => Math.abs(v.x - x) <= 2 && y >= v.y0 - 2 && y <= v.y1 + 2);
  let out = items;
  for (const r of rules.h) {
    if (r.dashed) continue; // a dashed border or separator, not an underline
    if (!near(r) || (meets(r.x0, r.y) && meets(r.x1, r.y))) continue;
    const kind = i => {
      const below = r.y - (i.y + i.size);
      return below >= -i.size * 0.08 && below <= i.size * 0.3 ? 'underline' : below <= -i.size * 0.2 && below >= -i.size * 0.5 ? 'strike' : null;
    };
    // Recognized (OCR) words are left alone: their boxes and sizes are estimates, and the lines on a scan come from its
    // picture (table rules, a rule under a heading), so one near them would read as a false underline or strike.
    const touched = out.filter(i => !i.angle && i.ocrLine == null && i.text.trim() && i.x < r.x1 - 1 && i.x + i.width > r.x0 + 1 && kind(i));
    if (!touched.length) continue;
    // Where the line starts and ends in each piece of text, moved to the nearest word edge (two characters at most).
    const cuts = touched.map(i => {
      const per = i.width / i.text.length, n = i.text.length;
      const snap = (at, edge) => { for (let d = 0; d <= 2; d++) for (const k of [at - d, at + d]) if (k >= 0 && k <= n && edge(k)) return k; return null; };
      const s = snap(Math.max(0, Math.min(n, Math.round((r.x0 - i.x) / per))), k => k === 0 || (/\s/.test(i.text[k - 1]) && !/\s/.test(i.text[k])));
      const e = snap(Math.max(0, Math.min(n, Math.round((r.x1 - i.x) / per))), k => k === n || (!/\s/.test(i.text[k - 1]) && /\s/.test(i.text[k])));
      return s === null || e === null || e <= s || !i.text.slice(s, e).trim() ? null : { i, s, e, per };
    });
    if (cuts.some(c => !c)) continue;
    const parts = new Map(cuts.map(({ i, s, e, per }) => [i, [[0, s, false], [s, e, true], [e, i.text.length, false]].filter(([a, b]) => b > a)
      .map(([a, b, marked]) => ({ ...i, text: i.text.slice(a, b), x: i.x + a * per, width: (b - a) * per, ...(marked && { [kind(i)]: true }) }))]));
    out = out.flatMap(i => parts.get(i) || [i]);
  }
  return out;
}

/** One line of text from items on the same row, with its runs of bold, italic, superscript and subscript text. */
function lineOf(items, pageRtl = false) {
  // A line in a right-to-left script (Hebrew, Arabic) reads from its right end; so does a line of figures and signs
  // only ("2)", "₪ 7,500") on a right-to-left page. Inside it, figures and Latin words read left to right (bidiRuns).
  const rtl = rightToLeft(items) || (pageRtl && !items.some(i => /\p{L}/u.test(i.text)));
  const parts = rtl ? bidiRuns([...items].sort((a, b) => b.x + b.width - a.x - a.width)) : [...items].sort((a, b) => a.x - b.x);
  const visible = parts.filter(p => p.text.trim());
  const size = median((visible.some(p => !p.sup && !p.sub) ? visible.filter(p => !p.sup && !p.sub) : visible).map(p => p.size));
  const spans = [];
  let text = '';
  parts.forEach((p, i) => {
    const prev = parts[i - 1];
    const gap = prev && Math.max(prev.x - (p.x + p.width), p.x - (prev.x + prev.width));
    // Where the type changes (bold to regular), a narrower gap is still a word space: a word rarely changes weight.
    const changes = prev && (Boolean(prev.bold) !== Boolean(p.bold) || Boolean(prev.italic) !== Boolean(p.italic));
    // Between words a recognizer read on one line of Chinese or Japanese (cut where it guessed), a gap is a space only
    // when wider than an em. (Between items a PDF draws apart, the gap is kept as a space: it shows on the page.)
    const unspaced = prev && p.ocrLine != null && p.ocrLine === prev.ocrLine && unspacedGap(prev.text, p.text) !== null ? 1.2 : null;
    const space = prev && gap > prev.size * (unspaced ?? (changes ? 0.05 : 0.15)) && !/\s$/.test(text) && !/^\s/.test(p.text) ? ' ' : '';
    text += space + p.text;
    const run = { text: p.text, bold: Boolean(p.bold), italic: Boolean(p.italic), sup: Boolean(p.sup), sub: Boolean(p.sub), underline: Boolean(p.underline), strike: Boolean(p.strike) };
    const last = spans.at(-1);
    if (!p.text.trim() && last) last.text += space + p.text;
    else if (last && formatKey(last) === formatKey(run)) last.text += space + p.text;
    else { if (last && space) last.text += space; spans.push(run); }
  });
  const first = parts[0], left = lowest(parts.map(p => p.x));
  const line = {
    text: text.replace(/\s+/g, ' ').trim(), x: round(left), y: round(lowest(parts.map(p => p.y))), width: round(highest(parts.map(p => p.x + p.width)) - left),
    height: round(highest(parts.map(p => p.size))), fontSize: round(size), font: (visible[0] || first).font, weight: lowest((visible.length ? visible : parts).map(p => p.weight || 400)),
    bold: visible.length > 0 && visible.every(p => p.bold), italic: visible.length > 0 && visible.every(p => p.italic),
  };
  if (first.ocrLine != null) Object.defineProperty(line, 'ocr', { value: true }); // recognized: its size is an estimate
  const kept = spans.map(s => ({ ...s, text: s.text.replace(/\s+/g, ' ') })).filter(s => s.text.trim());
  if (kept.length && (kept.some(s => s.sup || s.sub || s.underline || s.strike) || new Set(kept.map(formatKey)).size > 1)) {
    line.spans = kept.map(s => ({ text: s.text, ...(s.bold && { bold: true }), ...(s.italic && { italic: true }), ...(s.sup && { sup: true }), ...(s.sub && { sub: true }), ...(s.underline && { underline: true }), ...(s.strike && { strike: true }) }));
  }
  return line;
}

const RTL = /[\u0590-\u05FF\u0600-\u06FF\u0700-\u074F\u0750-\u077F\u08A0-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/gu;

/** Whether most letters of these items are in a right-to-left script. */
function rightToLeft(items) {
  let rtl = 0, all = 0;
  for (const i of items) { rtl += (i.text.match(RTL) || []).length; all += (i.text.match(/\p{L}/gu) || []).length; }
  return rtl > all / 2;
}

/** Pieces of the page's text rows: a row splits where the gap is wider than about a word space, so the
 *  columns of a multi-column page (and side notes) are separate pieces. */
function piecesOf(rows, rtl = false) {
  const out = [];
  // A gutter: somewhere across the gap, the rows just above (or just below) have no text either, so the gap runs on
  // as a channel of white between columns or beside side notes. Otherwise the gap is inside a line: words spaced wide
  // in justified text, or words a recognizer left out of a line it read whole.
  const channel = (r, a, b) => [rows.slice(Math.max(0, r - 3), r), rows.slice(r + 1, r + 4)].some(side => {
    if (side.length < 2) return false;
    const spans = side.flatMap(o => o.segments).filter(s => s.x1 > a && s.x0 < b).map(s => [s.x0, s.x1]).sort((p, q) => p[0] - q[0]);
    let reach = a + 0.5;
    for (const [x0, x1] of spans) { if (x0 > reach) return true; reach = Math.max(reach, x1); }
    return reach < b - 0.5;
  });
  for (const [r, row] of rows.entries()) {
    let current = null;
    for (const s of row.segments) {
      if (!s.items?.length) continue;
      // The gap is measured against the smaller type on either side: a large headline beside a column of small text
      // (a newspaper page) is not one line with it.
      const size = current && Math.min(current.size, s.size || row.size);
      const sameLine = current && s.items[0]?.ocrLine != null && s.items[0].ocrLine === current.items.at(-1).ocrLine;
      // A list marker set apart from its text (a bullet or number in a column of its own) belongs to the text.
      // (On a right-to-left page the marker stands at the right of its text: "1." set as "." then "1".)
      const marker = current && s.x0 - current.x1 <= size * 3 && (current.items.length <= 2 && MARKER.test(current.items.map(i => i.text).join('').trim())
        || (rtl && s.items.length <= 2 && RTL_MARKER.test([...s.items].sort((a, b) => b.x - a.x).map(i => i.text).join('').trim())));
      if (current && (marker || ((sameLine || s.x0 - current.x1 <= Math.max(4, size * 1.2)) && !channel(r, current.x1, s.x0)))) { for (const i of s.items) current.items.push(i); current.x1 = Math.max(current.x1, s.x1); current.size = s.size || row.size; }
      else { current = { items: [...s.items], x0: s.x0, x1: s.x1, size: s.size || row.size }; out.push(current); }
    }
  }
  for (const p of out) { p.top = lowest(p.items.map(i => i.y)); p.bottom = highest(p.items.map(i => i.y + i.size)); }
  return out;
}

// ---------------------------------------------------------------------------------------------- blocks

// A heading is larger than body text, or a short bold line at body size that doesn't end like a sentence.
// (Sizes of recognized lines are estimates, so for those it takes half as large again.)
const largeHeading = (line, body) => line.text.length <= 120 && line.fontSize >= body * (line.ocr ? 1.5 : 1.2) && /\p{L}/u.test(line.text);
const boldHeadingShape = (line, body) => line.fontSize >= body * 0.95 && line.text.length <= 80 && !/[.:;,]$/.test(line.text) && /\p{L}/u.test(line.text);
// Or a short line set heavier than the running text: Medium headings over Light text, or Medium and a little larger
// over Regular text (`weight`: the running text's font weight).
const isHeading = (line, body, weight = 400) => largeHeading(line, body) || (boldHeadingShape(line, body)
  && (line.bold || line.weight >= weight + 200 || (line.weight > weight && line.fontSize >= body * 1.08)));
// A list item starts with a bullet (including symbol-font bullets PDF.js maps to private-use characters) or a
// number or letter followed by "." or ")".
// A list marker on its own: a bullet, or a number or letter followed by "." or ")".
const MARKER = /^([•●▪◦○■□►▸‣⁃∙·›»➢➤✓✔◆♦\-–—*]|\(?(\d{1,3}|[a-zA-Z]|[ivxlc]{1,5})[.)])$/u;
const RTL_MARKER = /^\(?(\d{1,3}(\.\d{1,3})*|\p{L})[.)]$/u;
export const BULLET = /^([•●▪◦○■□►▸‣⁃∙·›»➢➤✓✔◆♦\-–—*-])\s+(?=\S)/u;
const NUMBERED = /^(\(?(\d{1,3}|[a-zA-Z]|[ivxlc]{1,5})[.)])\s+(?=\S)/;

/**
 * Lines set like headings that are not: one opening with a bullet (a list item), a figure set large (a key number such
 * as "EUR 4.2 billion" or "2.42 years"), or a short label with its value ("Tenure: Freehold", "DATE: May 8, 1998").
 */
const KEY_FIGURE = /[$€£¥₹%]|\d,\d{3}|\b(USD|EUR|GBP|JPY|CHF|INR|RMB|CNY)\s?\d|^[<>~≈+]?\s*\d[\d.,]*\s*(\p{Ll}+|[A-Z]{1,3})?(\s\p{Ll}+)?$/u;
function notHeading(line) {
  const text = line.text.trim(), words = text.split(/\s+/);
  if (/^[•●▪◦○■□►▸‣⁃∙·›»➢➤✓✔◆♦]\s*\S/u.test(text)) return true;
  if (/\d/.test(text) && words.length <= 5 && KEY_FIGURE.test(text) && !/^(19|20)\d\d\b[^$€£¥₹%]*$/u.test(text)) return true;
  const pair = /^([^:]{1,30}):\s+(\S.*)$/u.exec(text);
  return Boolean(pair && pair[1].split(/\s+/).length <= 2 && pair[2].split(/\s+/).length <= 4
    && (pair[2].split(/\s+/).length <= 2 || /\d/.test(pair[2]) || !/\p{Ll}/u.test(pair[1])));
}

/** A line that opens with a label in bold ending in a colon ("Paying agent: Bond Trust"): an entry of a key-value list. */
const keyStart = line => (line.spans?.[0]?.bold ? line.spans[0].text.length <= 40 && /\p{L}.*:\s*$/u.test(line.spans[0].text) : line.bold && /^\p{Lu}[^:]{0,29}:(\s|$)/u.test(line.text));

/** How far apart two lines' sizes may be and still be one paragraph: sizes of recognized (OCR) lines are estimates. */
const sizeTolerance = (a, b) => (a.ocr || b.ocr ? Math.max(1, Math.max(a.fontSize, b.fontSize) * 0.3) : 1);

/** Whether the block's last line stops well short of the measure (its widest line, or this next one) without a
 *  hyphen or comma, and the next line starts flush under it, not in lower case (which carries a sentence on): the
 *  block ended there. */
function endsShort(block, line) {
  const last = block.lines.at(-1), measure = highest([...block.lines.map(l => l.width), line.width]);
  return last.width < measure * SHORT && Math.abs(line.x - last.x) <= Math.max(2, line.fontSize * 0.3) && !/[-\u00AD‐,]$/.test(last.text) && !/^\p{Ll}/u.test(line.text);
}
const SHORT = 0.7;

/** Group lines (already in reading order, with tables between them) into blocks. */
function groupBlocks(entries, body, weight) {
  // Four or more lines of one size set close together and flush left are running text, even when they are larger
  // than the document's usual text (a page whose notes outweigh its body).
  const running = new Set();
  let run = [];
  const flush = () => { if (run.length >= 4) run.forEach(l => running.add(l)); run = []; };
  for (const { line: l } of entries) {
    const p = run.at(-1);
    if (!l) { flush(); continue; }
    if (p && Math.abs(l.fontSize - p.fontSize) <= 0.5 && Math.abs(l.x - p.x) <= 2 && l.y > p.y && l.y - p.y <= Math.max(l.height, p.height) * 1.8) run.push(l);
    else { flush(); run = [l]; }
  }
  flush();
  // A heavier line over lighter ones in such a run is its heading all the same (a bold title set flush over its text).
  // (Over a paragraph: two lines or more after it, running past it. Not the last line of a bold paragraph, one
  // with bold lines of its size just above it.)
  const leadsLighter = (line, next, before, after) => next && after && (line.bold || line.weight > weight) && !next.bold && (next.weight || 400) < (line.weight || 400) && boldHeadingShape(line, body)
    && line.text.split(/\s+/).length <= 8 && next.width > line.width && after.width > line.width * 0.9 && !after.bold && Math.abs(after.x - next.x) <= 2
    && !(before && before.bold && Math.abs(before.fontSize - line.fontSize) <= 0.5 && line.y > before.y && line.y - before.y <= line.height * 1.8);
  const blocks = [];
  for (const [k, entry] of entries.entries()) {
    if (entry.table) { blocks.push(entry.table); continue; }
    const { line } = entry;
    const heading = isHeading(line, body, weight) && (!running.has(line) || leadsLighter(line, entries[k + 1]?.line, entries[k - 1]?.line, entries[k + 2]?.line)) && !notHeading(line);
    const marker = !heading && (BULLET.exec(line.text) || NUMBERED.exec(line.text));
    const joins = prev => {
      const prevLine = prev.lines?.at(-1);
      // Entries of a key-value list, a key in bold and its value not, set one under the other ("Nationality: Swiss"
      // over "Year of birth: 1956"), are one block; any other line that opens with a key (a memo's "DATE:" set all in
      // bold) starts one.
      const entry = l => keyStart(l) && !l.bold;
      const keys = entry(line) && prev.type === 'paragraph' && prev.lines.every(entry) && Math.abs(line.x - prevLine.x) <= 2
        && line.y > prevLine.y && line.y - prevLine.y <= Math.max(prevLine.height, line.height) * 1.6;
      if (!prevLine || marker || line.pair || line.turned || prevLine.turned || (keyStart(line) && !keys) || Math.abs(line.fontSize - prevLine.fontSize) > sizeTolerance(line, prevLine)) return false;
      if (keys) return true;
      const near = line.y > prevLine.y && line.y - prevLine.y <= Math.max(prevLine.height, line.height) * 1.8
        && line.x < prevLine.x + prevLine.width && line.x + line.width > prevLine.x - line.fontSize;
      if (!near) return false;
      // A bold lead-in sentence that wraps: the line before is all bold at body size and doesn't end the sentence,
      // and this line goes on in bold from a lowercase letter, then turns regular or ends the sentence (or the line
      // before broke off at a colon or comma). One paragraph.
      if ((prev.type === 'paragraph' || prev.type === 'heading') && prevLine.bold && !largeHeading(prevLine, body) && (line.spans ? line.spans[0].bold : line.bold)
        && Math.abs(line.fontSize - prevLine.fontSize) <= 0.5 && !/[.!?]["”’)]?$/.test(prevLine.text) && /^\P{L}*\p{Ll}/u.test(line.text)
        && (!line.bold || /[.!?:;]["”’)]?$/.test(line.text) || /[:,]$/.test(prevLine.text))) {
        prev.type = 'paragraph';
        return true;
      }
      // A sentence that turns bold at the end of a full line and goes on in bold on the next is one paragraph, even
      // when the bold line alone would pass for a heading.
      const boldOn = line.bold && prevLine.spans?.at(-1)?.bold && !/[.!?:;]["”’)]?$/.test(prevLine.text) && Math.abs(line.fontSize - prevLine.fontSize) <= 0.5;
      if (prev.type === 'paragraph' && boldOn && !endsShort(prev, line)) return true;
      // A heading that wraps: the next line in the same size and weight, up to three lines.
      if (heading) return prev.type === 'heading' && prev.lines.length < 3 && Math.abs(line.fontSize - prevLine.fontSize) <= 0.5 && line.bold === prevLine.bold && line.weight === prevLine.weight;
      // A bold "heading" whose sentence wraps onto a line that ends it is a bold paragraph.
      if (prev.type === 'heading' && prev.lines.length === 1 && line.bold && prevLine.bold && Math.abs(line.fontSize - prevLine.fontSize) <= 0.5 && /[.;:]$/.test(line.text)) return (prev.type = 'paragraph');
      // A line set in bold on its own (a label such as "Incident date:") isn't joined with the lines around it.
      // A paragraph's lines run the full measure but its last: after a line that stops well short (a list of short
      // sentences, a column of labels), a line set flush under it starts a new paragraph.
      if (prev.type === 'paragraph' && endsShort(prev, line)) return false;
      // Nor at a first-line indent: a line set in (0.8 em or more) under a block of two or more flush lines.
      // (The block's own first line may be indented too: paragraphs of a book or a report, each set in.)
      const setIn = l => l.x - prevLine.x >= line.fontSize * 0.8 && l.x - prevLine.x <= line.fontSize * 4;
      if (prev.type === 'paragraph' && prev.lines.length >= 2 && prev.lines.slice(1).every(l => Math.abs(l.x - prevLine.x) <= 1)
        && (Math.abs(prev.lines[0].x - prevLine.x) <= 1 || setIn(prev.lines[0])) && setIn(line)) return false;
      // Nor after more space than the block's own lines keep between them (a paragraph's spacing).
      const before = prev.lines?.at(-2);
      if (prev.type === 'paragraph' && before && prevLine.y > before.y && line.y - prevLine.y > (prevLine.y - before.y) * 1.3 + 1) return false;
      // Nor after a line that ends a sentence where the next line's first word would have fitted (the line was not
      // full: the paragraph ended), or that ends a sentence short of the measure with a little more space after it.
      if (prev.type === 'paragraph' && /[.!?:]["”’)]?$/.test(prevLine.text) && !/^\p{Ll}/u.test(line.text) && Math.abs(line.x - prevLine.x) <= Math.max(2, line.fontSize * 0.3)) {
        const measure = highest([...prev.lines.map(l => l.width), line.width]), word = line.text.split(/\s+/)[0];
        const fits = prevLine.width + line.width * (word.length + 1) / Math.max(1, line.text.length) < measure * 0.98;
        const spaced = before && prevLine.y > before.y && line.y - prevLine.y > (prevLine.y - before.y) * 1.15 && prevLine.width < measure * 0.9;
        if (fits || spaced) return false;
      }
      if (prev.type === 'paragraph') return line.bold === prevLine.bold && !(prevLine.bold && /:$/.test(prevLine.text));
      // A list item carries on in lines indented under its text, or flush with its marker when the sentence goes on.
      // (Not after an item of one line that stops well short of this one: it ended there, and this line, set in, starts
      // a paragraph, as under a numbered heading "A. Materials".)
      if (prev.type === 'list' && prev.lines.length === 1 && prevLine.width < line.width * SHORT && !/[-\u00AD‐,]$/.test(prevLine.text) && !/^\p{Ll}/u.test(line.text)) return false;
      if (prev.type === 'list') return line.x >= prev.lines[0].x + 2 || (line.x >= prev.lines[0].x - 1 && /^[\p{Ll}(]/u.test(line.text));
      return false;
    };
    // The block the line carries on: the last one, or one a little earlier when what came between sits beside this
    // column (a side tab, a figure's label), not across it.
    let target = null;
    for (let k = blocks.length - 1; k >= Math.max(0, blocks.length - 4); k--) {
      if (joins(blocks[k])) { target = blocks[k]; break; }
      const b = blocks[k], x0 = b.lines ? lowest(b.lines.map(l => l.x)) : b.bbox[0], x1 = b.lines ? highest(b.lines.map(l => l.x + l.width)) : b.bbox[0] + b.bbox[2];
      if (x0 < line.x + line.width && x1 > line.x) break;
    }
    if (target) target.lines.push(line);
    else blocks.push({ type: heading ? 'heading' : marker ? 'list' : 'paragraph', lines: [line], ...(marker && { marker: marker[1] }) });
  }
  for (const block of blocks) {
    if (block.type === 'table' || block.type === 'chart') continue;
    block.text = joinWrapped(block.lines.map(l => l.text));
    // Large type that reads as a sentence (an introduction set big) is a paragraph, not a heading.
    if (block.type === 'heading' && /\p{Ll}.*[.!?]["”’)]?$/u.test(block.text) && block.text.split(/\s+/).length >= 8) block.type = 'paragraph';
    const xs = block.lines.map(l => l.x), ys = block.lines.map(l => l.y);
    block.bbox = [round(lowest(xs)), round(lowest(ys)), round(highest(block.lines.map(l => l.x + l.width)) - lowest(xs)), round(highest(block.lines.map(l => l.y + l.height)) - lowest(ys))];
  }
  return blocks;
}

const EDGE = 0.15; // the top and bottom of the page where running heads and feet are looked for across pages

/**
 * A line's letters only, lower-cased (any script): what a running head or foot keeps from page to page while its page
 * number, date or section number change. After GROBID's repeated-pattern feature for headers and footers
 * (Segmentation, FeatureFactory.getPattern; Apache-2.0, idea only).
 */
const edgePattern = text => (text.toLowerCase().match(/\p{L}/gu) || []).join('');

/** The first two pieces from the top ('t') and the last two from the bottom ('b') of a page, within its edges. */
function edgeRanks(pieces, height) {
  const order = pieces.map((p, i) => i);
  const top = [...order].sort((a, b) => pieces[a].top - pieces[b].top).filter(i => pieces[i].bottom <= height * EDGE).slice(0, 2);
  const bottom = [...order].sort((a, b) => pieces[b].bottom - pieces[a].bottom).filter(i => pieces[i].top >= height * (1 - EDGE)).slice(0, 2);
  return [...top.map(i => ['t', i]), ...bottom.map(i => ['b', i])];
}

const PAGE_NUMBER = /^((page|p\.|pg\.?|página|pagina|pág\.?|seite|s\.)\s*)?\d{1,4}(\s*(of|\/|de|von)\s*\d{1,4})?$|^[ivxlc]{1,6}$|^[-–—]\s*\d{1,4}\s*[-–—]$/i;
// What running heads and feet carry: a page number, a link or DOI, a copyright line, a volume and issue, a year.
const FURNITURE = /https?:\/\/|www\.|\bdoi\b|©|\bcopyright\b|\bvol(ume)?\.?\s*\d|\bno\.\s*\d|\bissn\b|\b(19|20)\d\d\b|\bpage\s+\d/i;
const marginKey = text => text.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();

/**
 * Lines in the top or bottom margin that are page furniture: a page number, or text at body size or smaller that
 * repeats in the same margin on other pages (a running title, a footer), or, on a short document, small text alone
 * in the margin.
 */
function marginal(piece, line, height, body, repeats) {
  const top = piece.bottom <= height * 0.08, bottom = piece.top >= height * 0.92;
  if (!top && !bottom) return null;
  if (line.fontSize > body * 1.15) return null;
  const known = repeats.get(`${top ? 't' : 'b'}${marginKey(line.text)}`) >= 2;
  if (PAGE_NUMBER.test(line.text) || known || line.fontSize < body * 0.95 || repeats.pages < 3) return top ? 'header' : 'footer';
  return null;
}

/**
 * Page headers and footers of several lines: the lines from the page's top (bottom) edge to the first clear gap, when
 * that gap sets them apart from the text within the outer tenth of the page and they are set no larger than the text.
 * They are furniture together, however many lines they take (a journal's running head over its citation line). On a
 * long document each line must be furniture on its own count too (repeated, a page number, smaller type); on a short
 * one, one line carrying a page number, link, year or copyright is enough. Marks `furniture` and returns the lines.
 */
function edgeBands(pieces, lines, furniture, height, body, repeats) {
  const banded = new Set();
  if (pieces.length < 3) return banded;
  for (const kind of ['header', 'footer']) {
    const head = kind === 'header';
    const order = pieces.map((p, i) => i).sort((a, b) => (head ? pieces[a].top - pieces[b].top : pieces[b].bottom - pieces[a].bottom));
    const band = [];
    let reach = null, separated = false;
    for (const i of order) {
      const p = pieces[i];
      if (reach !== null && (head ? p.top - reach : reach - p.bottom) > Math.max(3, body * 0.8)) { separated = true; break; }
      band.push(i);
      reach = reach === null ? (head ? p.bottom : p.top) : head ? Math.max(reach, p.bottom) : Math.min(reach, p.top);
    }
    if (!separated || !band.length || band.length === pieces.length || (head ? reach > height * 0.1 : reach < height * 0.9)) continue;
    if (new Set(band.map(i => Math.round(head ? pieces[i].top : pieces[i].bottom))).size > 4) continue;
    if (band.some(i => lines[i].fontSize > body * 1.15)) continue;
    // A paragraph that starts at the very top (or runs to the bottom) wraps: a full line, then the next under it.
    // (A full line: as wide as the lines of text just past the gap.)
    const rows = [...band].sort((a, b) => pieces[a].top - pieces[b].top), widest = highest(order.slice(band.length, band.length + 5).map(i => lines[i].width));
    if (rows.some((i, k) => k > 0 && lines[rows[k - 1]].width >= widest * 0.8 && Math.abs(lines[i].x - lines[rows[k - 1]].x) <= 2 && lines[rows[k - 1]].y < lines[i].y)) continue;
    if (new Set(band.map(i => Math.round(pieces[i].top))).size > 2 && !band.some(i => FURNITURE.test(lines[i].text) || PAGE_NUMBER.test(lines[i].text))) continue;
    const own = i => furniture[i] === kind || PAGE_NUMBER.test(lines[i].text);
    if (repeats.pages >= 3 ? !band.every(i => own(i) || FURNITURE.test(lines[i].text)) : !band.some(i => own(i) || FURNITURE.test(lines[i].text))) continue;
    for (const i of band) { furniture[i] = kind; banded.add(i); }
  }
  return banded;
}

/**
 * Lay out one page: tables, then the other text in reading order as headings, paragraphs and list items, with
 * page headers and footers apart.
 */
function layoutPage({ items, rules, viewport, recognized, charts = [], figures = [], fills = [] }, body, repeats, weight) {
  items = markLines(items, rules);
  // Text set upright (turned a quarter) reads as lines of its own, not with the rows it happens to cross; letters set
  // each at its own slant (along a curve: a seal, a badge) are part of a drawing.
  const { upright, turned: across } = turnedText(items);
  // Chinese, Japanese or Korean written in columns reads down each column, the columns from the right.
  const { upright: level, columns, taken, vertical } = stackedColumns(upright, across);
  // Lines turned a quarter in the page's margin (a "Downloaded from …" banner) are read after the page's text, so they
  // don't break its columns apart; others (an axis title, a label beside a heading) stay with the rows they cross,
  // where the tables and charts read them. Columns of vertical writing are the text.
  const free = across.filter(t => !taken.has(t)), aside = free.filter(t => t.margin), turned = columns;
  items = [...level, ...free.filter(t => !t.margin).flatMap(t => t.piece.items)];
  const { tables, rows } = pageTables(items, rules, { stream: !recognized, pictures: figures, fills });
  // A page written right to left (Hebrew, Arabic) reads its columns and the pieces of a row from the right.
  const rtl = rightToLeft(items);
  const pieces = piecesOf(rows, rtl);
  const lines = pieces.map(p => lineOf(p.items, rtl));
  for (const { piece, line } of turned) { pieces.push(piece); lines.push(line); }
  const furniture = pieces.map((p, i) => marginal(p, lines[i], viewport.height, body, repeats));
  const banded = edgeBands(pieces, lines, furniture, viewport.height, body, repeats);
  // A page number alone a little inside the margin (the outer eighth of the page), with nothing past it, is furniture.
  for (const [i, p] of pieces.entries()) {
    if (furniture[i] || !PAGE_NUMBER.test(lines[i].text) || lines[i].fontSize > body * 1.15) continue;
    const kind = p.top >= viewport.height * 0.88 ? 'footer' : p.bottom <= viewport.height * 0.12 ? 'header' : null;
    // (Alone on its row too: a number beside a running title is the title's to go with.)
    if (kind && !pieces.some((o, j) => j !== i && (kind === 'footer' ? o.top > p.bottom : o.bottom < p.top) || (j !== i && o.top < p.bottom && o.bottom > p.top))) { furniture[i] = kind; banded.add(i); }
  }
  // A line among the first two or last two of the page whose letters repeat there on other pages (a running head with
  // a changing page or section number), even below the margin.
  if (repeats.pages >= 2) for (const [kind, i] of edgeRanks(pieces, viewport.height)) {
    const count = repeats.get(`p${kind}${edgePattern(lines[i].text)}`) || 0;
    if (edgePattern(lines[i].text).length >= 8 && count >= 2 && count >= repeats.pages * 0.2 && lines[i].fontSize <= body * 1.15) { furniture[i] = kind === 't' ? 'header' : 'footer'; banded.add(i); }
  }
  // Body text that runs into the margin (several lines of it) is not a page header or footer; a page number still is.
  for (const [kind, most] of [['header', 2], ['footer', 3]]) {
    const own = pieces.map((p, i) => i).filter(i => furniture[i] === kind && !banded.has(i));
    if (new Set(own.map(i => Math.round(pieces[i].top))).size > most) for (const i of own) if (!PAGE_NUMBER.test(lines[i].text)) furniture[i] = null;
  }
  // A line in the margin that carries on into the text next to it (a paragraph starting at the very top of the page,
  // footnotes running down to the bottom), in the same size, isn't furniture unless it repeats on other pages.
  for (let pass = 0; pass < 3; pass++) lines.forEach((l, i) => {
    const kind = furniture[i];
    if (!kind || banded.has(i) || PAGE_NUMBER.test(l.text) || repeats.get(`${kind === 'header' ? 't' : 'b'}${marginKey(l.text)}`) >= 2) return;
    const next = lines.some((o, j) => j !== i && !furniture[j] && Math.abs(o.fontSize - l.fontSize) <= 0.5 && o.x < l.x + l.width && o.x + o.width > l.x
      && (kind === 'header' ? o.y > l.y && o.y - l.y <= l.height * 1.8 : l.y > o.y && l.y - o.y <= o.height * 1.8));
    if (next) furniture[i] = null;
  });
  const content = pieces.map((p, i) => i).filter(i => !furniture[i]);
  // A short label ending in a colon (a key of a key-value list): reading order keeps it with the value beside it.
  for (const i of content) pieces[i].label = lines[i].text.length <= 40 && /\p{L}.*:$/u.test(lines[i].text);
  const tableBlocks = tables.map(t => ({
    type: 'table', rows: t.rows, header: t.header, headerRows: t.headerRows, ...(t.spans && { spans: t.spans }), ...(t.rowSpans && { rowSpans: t.rowSpans }), ...(t.bold && { bold: t.bold }),
    text: t.rows.map(r => r.filter(Boolean).join(' | ')).join('\n'),
    bbox: [round(t.box.x0), round(t.box.top), round(t.box.x1 - t.box.x0), round(t.box.bottom - t.box.top)],
  }));
  // Charts read as data (pdf-charts.js) take their place in the reading order like tables.
  tableBlocks.push(...charts.map(chartBlock));
  const boxes = [...content.map(i => pieces[i]), ...tables.map(t => t.box), ...charts.map(c => c.box)];
  const order = readingOrder(boxes, { gap: Math.max(6, body * 0.9), rtl: rtl || vertical });
  const entries = order.map(k => (k < content.length ? { line: lines[content[k]] } : { table: tableBlocks[k - content.length] }));
  // Pieces of one row that reading order kept together (a line split by a wide gap) read as one line.
  const merged = [];
  for (const entry of entries) {
    const prev = merged.at(-1);
    // (On a right-to-left page the piece read next stands to the left.)
    const apart = entry.line && prev?.line && (rtl ? prev.line.x - (entry.line.x + entry.line.width) : entry.line.x - (prev.line.x + prev.line.width));
    if (entry.line && prev?.line && !entry.line.turned && !prev.line.turned && Math.abs(prev.line.y + prev.line.height - entry.line.y - entry.line.height) <= 1.5 && apart > 0
      && Math.abs(prev.line.fontSize - entry.line.fontSize) <= 1 && apart < body * (/:$/.test(prev.line.text) && prev.line.text.length <= 40 ? 12 : 4)) {
      const pair = /:$/.test(prev.line.text) && prev.line.text.length <= 40 && !prev.line.pair;
      prev.line = joinLines(prev.line, entry.line);
      if (pair) Object.defineProperty(prev.line, 'pair', { value: true }); // "Maturity:  February 1": a pair starts a block of its own
    } else merged.push({ ...entry });
  }
  const blocks = groupBlocks(merged, body, weight);
  const edge = kind => {
    const own = pieces.map((p, i) => i).filter(i => furniture[i] === kind).sort((a, b) => pieces[a].top - pieces[b].top || pieces[a].x0 - pieces[b].x0);
    return own.map(i => ({ type: kind, text: lines[i].text, lines: [lines[i]], bbox: [lines[i].x, lines[i].y, lines[i].width, lines[i].height] }));
  };
  for (const { line } of aside) blocks.push({ type: 'paragraph', lines: [line], text: line.text, bbox: [line.x, line.y, line.width, line.height] });
  return [...edge('header'), ...blocks, ...edge('footer')];
}

const quarterTurn = a => Math.abs(Math.abs(a) - 90) <= 10;
const slanted = a => { const m = Math.abs(a) % 90; return m > 10 && m < 80; };

/**
 * A page's text items split into the upright ones and lines of text turned a quarter (`turned`: { piece, line } as
 * piecesOf and lineOf make them, each with its box as it stands on the page, read in its own direction). Letters set
 * one or two at a time at slants of their own (three or more: text along a curve, part of a drawing) are left out.
 */
function turnedText(items) {
  // (Letters, not figures, at three slants or more: tick labels of a chart set at one slant stay.)
  const curve = items.filter(i => i.angle && slanted(i.angle) && i.text.trim().length <= 2 && /^\p{L}+$/u.test(i.text.trim()));
  const drop = new Set(curve.length >= 3 && new Set(curve.map(i => Math.round(i.angle / 5))).size >= 3 ? curve : []);
  const vertical = items.filter(i => i.angle && quarterTurn(i.angle) && i.text.trim() && !drop.has(i));
  if (!drop.size && !vertical.length) return { upright: items, turned: [] };
  const set = new Set(vertical);
  const upright = items.filter(i => !drop.has(i) && !set.has(i));
  // Where the upright text runs across the page: a turned line beside it all stands in the margin.
  const level = upright.filter(i => !i.angle);
  const left = lowest(level.map(i => i.x)), right = highest(level.map(i => i.x + i.width));
  // Each item's box: from its start on the baseline (x, y + size) along its direction, its letters' tops to the left
  // (read upwards) or to the right (read downwards).
  const boxed = vertical.map(i => {
    const up = i.angle > 0, base = i.y + i.size;
    return { i, up, x0: up ? i.x - i.size : i.x, x1: up ? i.x + i.size * 0.25 : i.x + i.size, top: up ? base - i.width : base, bottom: up ? base : base + i.width };
  }).sort((a, b) => (a.up === b.up ? 0 : a.up ? -1 : 1) || a.x0 - b.x0 || (a.up ? b.bottom - a.bottom : a.top - b.top));
  const groups = [];
  for (const b of boxed) {
    const g = groups.at(-1), last = g?.at(-1);
    const gap = last && (b.up ? last.top - b.bottom : b.top - last.bottom);
    if (last && last.up === b.up && Math.abs(last.x0 - b.x0) <= b.i.size * 0.3 && gap > -b.i.size * 0.5 && gap <= b.i.size * 1.5) g.push(b);
    else groups.push([b]);
  }
  const turned = groups.map(g => {
    let text = '';
    g.forEach((b, k) => {
      const prev = g[k - 1], gap = prev ? (b.up ? prev.top - b.bottom : b.top - prev.bottom) : 0;
      text += (prev && gap > b.i.size * 0.15 && !/\s$/.test(text) && !/^\s/.test(b.i.text) ? ' ' : '') + b.i.text;
    });
    const x0 = lowest(g.map(b => b.x0)), x1 = highest(g.map(b => b.x1)), top = lowest(g.map(b => b.top)), bottom = highest(g.map(b => b.bottom));
    const line = { ...lineOf(g.map(b => b.i)), text: text.replace(/\s+/g, ' ').trim(), x: round(x0), y: round(top), width: round(x1 - x0), height: round(bottom - top) };
    if (g.length > 1) delete line.spans;
    Object.defineProperty(line, 'turned', { value: true }); // joins no other line (groupBlocks, layoutPage)
    return { piece: { items: g.map(b => b.i), x0, x1, top, bottom, size: g[0].i.size }, line, margin: x1 <= left + 2 || x0 >= right - 2 };
  });
  return { upright, turned };
}

const STACKED = /^[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}\p{scx=Hangul}　-〿ー！-･]$/u;

/**
 * Chinese, Japanese and Korean written in columns (top to bottom, columns right to left), as the page draws it: one
 * upright character after another down the same x. A column also takes the short pieces set across it (figures set
 * side by side, "15") and the words turned to read down it (`turned`, Latin words in vertical text). Returns the items
 * left over (`upright`), the blocks of columns (`columns`: { piece, line } as piecesOf and lineOf make them, a block's
 * columns read right to left as one line), the turned lines taken (`taken`), and whether the page is mostly written
 * so (`vertical`: its blocks then read from the right).
 */
export function stackedColumns(items, turned = []) {
  const none = { upright: items, columns: [], taken: new Set(), vertical: false };
  const cand = items.filter(i => !i.angle && i.ocrLine == null && STACKED.test(i.text.trim()));
  if (cand.length < 12) return none;
  // Characters at one x (a fifth of their size), then runs down the page about a character apart (a little more
  // where a piece set across the column sits between).
  const byX = [];
  for (const i of [...cand].sort((a, b) => a.x - b.x)) {
    const c = byX.at(-1);
    if (c && Math.abs(i.x - c[0].x) <= i.size * 0.2) c.push(i); else byX.push([i]);
  }
  const cols = [];
  for (const c of byX) {
    let run = [];
    const flush = () => { if (run.length >= 4) cols.push(run); run = []; };
    for (const i of c.sort((a, b) => a.y - b.y)) {
      const last = run.at(-1), step = last && i.y - last.y;
      if (last && step >= i.size * 0.7 && step <= i.size * 2.6 && Math.abs(i.size - last.size) <= last.size * 0.25) run.push(i);
      else { flush(); run = [i]; }
    }
    flush();
  }
  // Not a column where its characters sit in rows of text running across (Chinese or Japanese set on a grid, each
  // character drawn on its own, lines a character apart): most of a column's characters have no neighbour on their
  // row closer than a third of their size.
  const rows = new Map();
  for (const i of items) if (!i.angle && i.text.trim()) { const r = Math.round(i.y); if (!rows.has(r)) rows.set(r, []); rows.get(r).push(i); }
  const across = i => [-1, 0, 1].some(d => (rows.get(Math.round(i.y) + d) || []).some(o => o !== i && Math.abs(o.y - i.y) <= i.size * 0.2
    && Math.max(o.x - (i.x + Math.min(i.width, i.size)), i.x - (o.x + Math.min(o.width, o.size * o.text.length))) <= i.size * 0.3));
  for (let k = cols.length - 1; k >= 0; k--) if (cols[k].filter(across).length > cols[k].length * 0.3) cols.splice(k, 1);
  if (!cols.length) return none;
  const used = new Set(cols.flat()), taken = new Set();
  const boxes = cols.map(col => {
    const size = median(col.map(i => i.size)), x0 = lowest(col.map(i => i.x)), x1 = x0 + size;
    const top = lowest(col.map(i => i.y)), bottom = highest(col.map(i => i.y + i.size));
    // Pieces set across the column (centred on it, within its length) and turned words reading down it.
    const parts = col.map(i => ({ at: i.y, text: i.text.trim() }));
    for (const i of items) {
      if (used.has(i) || i.angle || i.ocrLine != null || !i.text.trim() || i.text.trim().length > 4) continue;
      const mid = i.x + Math.min(i.width, i.size * i.text.trim().length) / 2;
      if (mid > x0 && mid < x1 && i.y >= top - size * 0.5 && i.y <= bottom + size * 0.2) { parts.push({ at: i.y, text: i.text.trim() }); used.add(i); }
    }
    for (const t of turned) {
      if (taken.has(t) || t.line.text.length > 40) continue;
      const mid = (t.piece.x0 + t.piece.x1) / 2;
      if (mid > x0 && mid < x1 && t.piece.top >= top - size && t.piece.top <= bottom + size * 0.2) { parts.push({ at: t.piece.top, text: t.line.text }); taken.add(t); }
    }
    parts.sort((a, b) => a.at - b.at);
    return { text: parts.map(p => p.text).join(''), x0, x1, top: Math.min(top, ...parts.map(p => p.at)), bottom, size, items: col };
  });
  // Columns side by side, starting about level, a column's width or so apart, make one block, read right to left.
  const blocks = [];
  for (const c of boxes.sort((a, b) => b.x1 - a.x1 || a.top - b.top)) {
    const b = blocks.find(k => Math.abs(k.at(-1).size - c.size) <= c.size * 0.1 && Math.abs(k.at(-1).top - c.top) <= c.size * 1.5 && k.at(-1).x0 - c.x1 >= -c.size * 0.2 && k.at(-1).x0 - c.x1 <= c.size * 1.2);
    if (b) b.push(c); else blocks.push([c]);
  }
  const columns = blocks.map(b => {
    const all = b.flatMap(c => c.items), x0 = lowest(b.map(c => c.x0)), x1 = highest(b.map(c => c.x1)), top = lowest(b.map(c => c.top)), bottom = highest(b.map(c => c.bottom));
    const line = { ...lineOf([all[0]]), text: b.map(c => c.text).join(''), x: round(x0), y: round(top), width: round(x1 - x0), height: round(bottom - top) };
    delete line.spans;
    Object.defineProperty(line, 'turned', { value: true }); // joins no other line (groupBlocks, layoutPage)
    return { piece: { items: all, x0, x1, top, bottom, size: b[0].size }, line };
  });
  const chars = items.reduce((n, i) => n + i.text.replace(/\s/g, '').length, 0);
  return { upright: items.filter(i => !used.has(i)), columns, taken, vertical: used.size >= chars * 0.5 };
}

function joinLines(a, b) {
  const line = { ...a, text: `${a.text} ${b.text}`, x: Math.min(a.x, b.x), width: round(Math.max(a.x + a.width, b.x + b.width) - Math.min(a.x, b.x)), height: Math.max(a.height, b.height), weight: Math.min(a.weight || 400, b.weight || 400), bold: a.bold && b.bold, italic: a.italic && b.italic };
  if (a.spans || b.spans || a.bold !== b.bold || a.italic !== b.italic) {
    const spansOf = l => l.spans || [{ text: l.text, ...(l.bold && { bold: true }), ...(l.italic && { italic: true }) }];
    line.spans = [...spansOf(a).slice(0, -1), { ...spansOf(a).at(-1), text: `${spansOf(a).at(-1).text} ` }, ...spansOf(b)];
  }
  return line;
}

/** Read one page: its text items (recognized when it is a scan), drawings, image boxes and charts read as data. */
async function readPage(pdfjs, doc, index, { images, recognize, ocrAreas = { left: 30, looks: 12, misses: 0 } }) {
  const page = await doc.getPage(index + 1);
  const { content, ...rest } = await pageItems(pdfjs, page, { images, fonts: images });
  let recognized = false;
  // A scan: no text, or a little (a scanner's stamp, a header added over the scan) over pictures covering most of the
  // page (one picture, or strips of one). Recognized words add to the page's own text, not over it.
  const chars = rest.items.reduce((n, i) => n + i.text.trim().length, 0);
  // A text layer that can't be read (a font whose characters map to the wrong letters, ocr-languages.js) is read
  // with OCR too; its words replace that text when they read clearly.
  const garbled = recognize && chars >= SCANNED && garbledText(rest.items.map(i => i.text).join(' '));
  if (recognize && (!chars || garbled || (chars < SCANNED && pictured(rest.boxes, rest.viewport) >= 0.5))) {
    const words = await recognize(page, index, garbled ? { garbled: true } : undefined);
    if (words?.length) { rest.items = garbled ? words : [...outside(words, rest.items), ...rest.items]; recognized = true; }
    if (recognized && words.rules) rest.rules = { h: [...(rest.rules?.h || []), ...words.rules.h], v: [...(rest.rules?.v || []), ...words.rules.v] };
  }
  rest.items = (await fixPageText(page, rest.viewport, rest.items, pdfjs)).filter(usable); // pdf-text-fixes.js
  // A chart whose words and numbers are drawn as letter outlines: OCR reads where they are (recognize with a region),
  // and the words are the chart's to read (words no chart takes are dropped). At most 30 such reads a document.
  const outlined = [];
  if (recognize && !recognized && ocrAreas.left > 0 && rest.shapes && rest.shapes.rects.length + rest.shapes.lines.length >= 5) {
    for (const region of outlineTextAreas(rest.marks, rest.items, rest.viewport)) {
      if (ocrAreas.left-- <= 0) break;
      outlined.push(...outlinedWords(((await Promise.resolve(recognize(page, index, { region })).catch(() => null)) || []).filter(usable), rest.marks, rest.items));
    }
  }
  // Charts drawn as vectors: their numbers and labels become a data table, so they leave the page's text.
  let { charts, items: charted, strips } = recognized ? { charts: [] } : findCharts([...rest.items, ...outlined], rest.shapes, rest.viewport);
  // A chart whose labels are drawn as shapes or pictures: OCR reads the strip where they are (recognize with a region)
  // and the charts are read again; words no chart takes are dropped. Any failure leaves the page as it was.
  if (recognize && strips?.length) {
    const words = [];
    for (const region of strips) words.push(...((await Promise.resolve(recognize(page, index, { region })).catch(() => null)) || []).filter(usable));
    const again = words.length ? findCharts([...rest.items, ...outlined, ...words], rest.shapes, rest.viewport) : null;
    if (again?.charts.length > charts.length) ({ charts, items: charted } = again);
  }
  // Charts that are pictures: OCR reads each picture big enough to be one (recognize with a region, its pixels
  // asked for too), the bars are found in its pixels (pdf-charts.js chartPictureShapes), and the chart is read from
  // them with the words, as one drawn as shapes. The page's own text near it (a title) can be its too.
  // (A scanned page, a picture over most of the page with little text, is not looked at.)
  if (recognize && !recognized && ocrAreas.left > 0 && ocrAreas.looks > 0 && ocrAreas.misses < 2 && !(chars < SCANNED && pictured(rest.boxes, rest.viewport) >= 0.5)) {
    for (const box of chartPictures(rest.boxes, rest.items, rest.viewport)) {
      if (charts.some(c => c.box.x0 < box.x1 && c.box.x1 > box.x0 && c.box.top < box.y1 && c.box.bottom > box.y0)) continue;
      // Its pixels first, in less detail and without the OCR engine: a picture without bars in it (a photo) isn't
      // read. At most 12 pictures are looked at in a document, and none after two in a row without bars.
      if (ocrAreas.looks-- <= 0 || ocrAreas.misses >= 2) break;
      const look = await Promise.resolve(recognize(page, index, { region: { ...box, pixels: true, text: false } })).catch(() => null);
      if (!look?.pixels || !looksLikeBars(chartPictureShapes(look.pixels, box))) { ocrAreas.misses++; continue; }
      ocrAreas.misses = 0;
      if (ocrAreas.left-- <= 0) break;
      const words = await Promise.resolve(recognize(page, index, { region: { ...box, pixels: true } })).catch(() => null);
      if (!words?.pixels) continue;
      const rects = chartPictureShapes(words.pixels, box);
      const nearby = rest.items.filter(i => !charted?.has(i) && i.x < box.x1 + 40 && i.x + i.width > box.x0 - 40 && i.y < box.y1 + 40 && i.y + i.size > box.y0 - 40);
      const read = findCharts([...nearby, ...words.filter(usable)], { rects, lines: [], dots: [], fills: [], swatches: [] }, rest.viewport);
      if (!read.charts.length) continue;
      charts.push(...read.charts);
      charted = new Set([...(charted || []), ...read.items]);
    }
  }
  if (charts.length) rest.items = rest.items.filter(i => !charted.has(i));
  // Pictures on a page with text that may be text themselves (a title or a table set as a picture), other than the
  // charts read above: offered to recognize as a picture, which reads only those that look like print and read
  // clearly (ocr-pictures.js).
  if (recognize && !recognized) {
    for (const picture of pictureRegions(rest.boxes, rest.items, rest.viewport)) {
      if (charts.some(c => c.box.x0 < picture.x1 && c.box.x1 > picture.x0 && c.box.top < picture.y1 && c.box.bottom > picture.y0)) continue;
      const words = await Promise.resolve(recognize(page, index, { picture })).catch(() => null);
      if (words?.length) rest.items.push(...outside(words.filter(usable), rest.items));
    }
  }
  // Filled rectangles (not near-white): their edges inside a grid of lines separate a table's rows (pdf-layout.js).
  rest.fills = (rest.shapes?.rects || []).filter(r => r.x1 - r.x0 >= 20 && r.y1 - r.y0 >= 3 && !/^#f[0-9a-f]f[0-9a-f]f[0-9a-f]$/i.test(r.color));
  rest.shapes = null;
  page.cleanup?.();
  return { index, ...rest, charts, recognized, content: images || recognized ? null : content };
}

const SCANNED = 200; // characters of text a scanned page may carry besides its picture

/** Recognized words that don't fall on text the page already has. */
function outside(words, items) {
  const on = w => items.some(i => w.x + w.width / 2 >= i.x - 1 && w.x + w.width / 2 <= i.x + i.width + 1 && w.y + w.size / 2 >= i.y - 1 && w.y + w.size / 2 <= i.y + i.size + 1);
  return items.length ? words.filter(w => !on(w)) : words;
}

/** How much of the page its pictures cover (0 to 1; pictures are taken not to overlap). */
function pictured(boxes, { width, height }) {
  let covered = 0;
  for (const [x, y, w, h] of boxes) covered += Math.max(0, Math.min(x + w, width) - Math.max(x, 0)) * Math.max(0, Math.min(y + h, height) - Math.max(y, 0));
  return Math.min(1, covered / (width * height || 1));
}

/** A text item that can be placed: text, a finite position and a size above zero. */
export const usable = i => i.text && Number.isFinite(i.x) && Number.isFinite(i.y) && Number.isFinite(i.width) && i.size > 0 && Number.isFinite(i.size);

const BACKDROP = 0.8; // share of the page an image covers to be the page's backdrop (behind its text and pictures)

/** A page laid out, with its images and the pictures drawn as shapes. */
function pageResult(entry, body, repeats, weight) {
  const { index, viewport, boxes, recognized } = entry;
  // Pictures drawn as shapes, outside charts read as data and images; a scan is one picture of its page. (Shapes over
  // an image behind the whole page, a backdrop, are pictures all the same.)
  const box = ([x, y, w, h]) => ({ x0: x, y0: y, x1: x + w, y1: y + h });
  const backdrop = ([, , w, h]) => w * h >= viewport.width * viewport.height * BACKDROP;
  entry.figures = recognized ? [] : figureRegions(entry.marks, entry.items, viewport, [...entry.charts.map(c => box(chartBlock(c).bbox)), ...boxes.filter(b => !backdrop(b)).map(box)]);
  const blocks = layoutPage(entry, body, repeats, weight);
  entry.fills = null;
  const tableBoxes = blocks.filter(b => b.type === 'table').map(b => box(b.bbox));
  const overlap = (f, t) => Math.max(0, Math.min(f.x + f.width, t.x1) - Math.max(f.x, t.x0)) * Math.max(0, Math.min(f.y + f.height, t.y1) - Math.max(f.y, t.y0));
  const figures = entry.figures.filter(f => !tableBoxes.some(t => overlap(f, t) >= f.width * f.height * 0.5));
  const images = (recognized && pictured(boxes, viewport) >= 0.5 ? [] : boxes).map(([x, y, width, height]) => ({ x, y, width, height }));
  // The page's pictures for its layout: images and figures, grouped (pdf-layout.js pictureGroups).
  const panels = (entry.marks || []).filter(m => m.rect && !m.stroked && m.x1 - m.x0 >= 40 && m.y1 - m.y0 >= 40 && (m.x1 - m.x0) * (m.y1 - m.y0) < viewport.width * viewport.height * BACKDROP).slice(0, 300);
  const pictures = pictureGroups([...images, ...figures], blocks.flatMap(b => (b.type === 'table' || b.type === 'chart' ? [] : b.lines || [])), viewport, body, panels);
  // The words set on each picture (its labels and values), top to bottom.
  for (const p of pictures) {
    const on = entry.items.filter(i => i.text.trim() && i.x + i.width / 2 > p.x && i.x + i.width / 2 < p.x + p.width && i.y + i.size / 2 > p.y && i.y + i.size / 2 < p.y + p.height);
    if (on.length) p.text = on.sort((a, b) => a.y + a.size - b.y - b.size || a.x - b.x).map(i => i.text.trim()).join(' ').replace(UNTRUSTED, '').slice(0, 2000);
  }
  return { page: index + 1, width: round(viewport.width), height: round(viewport.height), ...(recognized && { recognized: true }), blocks, images, figures, pictures };
}

const SECTION_NUMBER = /^(\d{1,2}(?:\.\d{1,2}){0,4})\.?\s+\S/;

/**
 * Heading levels beyond type size: a numbered heading sits as deep as its number ("2.1" under "2", "2.1.3" under
 * "2.1") when the document numbers its top sections too, whatever size the numbered headings are set in.
 */
function nestHeadings(headings) {
  const depth = b => SECTION_NUMBER.exec(b.text)?.[1].split('.').length || 0;
  const top = lowest(headings.filter(b => depth(b) === 1).map(b => b.level));
  if (Number.isFinite(top)) for (const b of headings) if (depth(b) > 1) b.level = Math.max(b.level, Math.min(6, top + depth(b) - 1));
}

const titleKey = text => String(text).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const MAX_BOOKMARKS = 5000;

/**
 * Heading levels from the PDF's own bookmarks (its outline), where it has them: a heading, or a line or two on its own,
 * whose text is a bookmark's title (or the start of it) on the page the bookmark opens is a heading as deep as the
 * bookmark is nested. Headings no bookmark names keep the level their type gives them.
 */
async function bookmarkLevels(doc, pages) {
  const outline = await doc.getOutline().catch(() => null);
  if (!outline?.length) return;
  const marks = new Map();
  let count = 0;
  const walk = async (items, level) => {
    for (const item of items) {
      if (++count > MAX_BOOKMARKS) return;
      let page = null;
      try {
        const dest = typeof item.dest === 'string' ? await doc.getDestination(item.dest) : item.dest;
        if (Array.isArray(dest)) page = typeof dest[0] === 'number' ? dest[0] + 1 : (await doc.getPageIndex(dest[0])) + 1;
      } catch { /* a bookmark that opens no page here */ }
      const key = titleKey(item.title || '');
      if (page && key) { if (!marks.has(page)) marks.set(page, []); marks.get(page).push({ key, level }); }
      if (item.items?.length) await walk(item.items, level + 1);
    }
  };
  await walk(outline, 1);
  const alike = (a, b) => a === b || (Math.min(a.length, b.length) >= 4 && (a.startsWith(b) || b.startsWith(a)) && Math.min(a.length, b.length) / Math.max(a.length, b.length) >= 0.6);
  for (const page of pages) {
    const own = marks.get(page.page);
    if (!own) continue;
    for (const block of page.blocks) {
      if (!(block.type === 'heading' || (block.type === 'paragraph' && block.lines?.length <= 2)) || !block.text || block.text.length > 160) continue;
      const key = titleKey(block.text);
      const mark = key && own.find(m => alike(m.key, key));
      if (mark) Object.assign(block, { type: 'heading', level: Math.min(6, mark.level) });
    }
  }
}

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const HEAVIER_STEM = 1.35; // strokes this much thicker than the running text's read as bold (Medium runs about 1.25)
const BOLD_STEM = 82; // and, for Latin and other letters, at least this thick (Regular over Light text isn't bold)

/**
 * Text set in a font whose strokes are clearly thicker than the running text's is bold, when its name doesn't say so:
 * the running text's stroke width is the one most of the body-size text is set with, measured apart for Chinese,
 * Japanese and Korean, whose strokes are thinner for the em than Latin letters'.
 */
function boldByStem(read, body) {
  const scriptOf = i => (CJK.test(i.text) ? 'cjk' : 'other');
  for (const script of ['cjk', 'other']) {
    const tally = new Map();
    let all = 0;
    for (const { items } of read) for (const i of items) {
      if (!i.stem || Math.round(i.size * 2) / 2 !== body || scriptOf(i) !== script) continue;
      const n = i.text.trim().length;
      tally.set(i.stem, (tally.get(i.stem) || 0) + n);
      all += n;
    }
    if (all < 40) continue;
    // The stroke width carrying the most of that text.
    const usual = [...tally].sort((a, b) => b[1] - a[1])[0][0];
    for (const { items } of read) for (const i of items) {
      if (i.stem && !i.bold && scriptOf(i) === script && /[\p{L}\p{N}]/u.test(i.text) && i.stem >= usual * HEAVIER_STEM && (script === 'cjk' || i.stem >= BOLD_STEM)) Object.assign(i, { bold: true, weight: Math.max(i.weight || 400, 700) });
    }
  }
}

/** Said in place of a page that could not be read; the rest of the document is still exported. */
export const UNREAD_PAGE = 'This page could not be read.';

function unreadPage(index, viewport) {
  const text = `[${UNREAD_PAGE}]`;
  return { page: index + 1, width: round(viewport?.width || 0), height: round(viewport?.height || 0), unread: true, blocks: [{ type: 'paragraph', text, lines: [{ text }], bbox: [0, 0, 0, 0] }], images: [], figures: [], pictures: [] };
}

/**
 * Structured content of a PDF.js document. `pages` is a list of 0-based indices (default: all).
 * Coordinates are in PDF points with the origin at the top-left of the displayed (rotated) page.
 * `recognize(page, index)`, when given, reads a page that has no text (a scan) and returns its words as text items
 * (see ocr.js); `recognize(page, index, { region })` reads only that part of the page (chart labels drawn as shapes);
 * `recognize(page, index, { picture })` reads a picture on a page with text, or returns null; `progress(done, total)`
 * is called after each page is read.
 */
export async function extractStructure(pdfjs, doc, { pages, images = true, recognize, progress = () => {} } = {}) {
  const indices = pages || [...Array(doc.numPages).keys()];
  fontkit ||= await import('@pdf-lib/fontkit').then(m => m.default || m).catch(() => null);
  const metadata = await doc.getMetadata().catch(() => ({}));
  const result = { title: (metadata.info?.Title || '').replace(UNTRUSTED, ''), pageCount: doc.numPages, pages: [] };
  const collected = [], ocrAreas = { left: 30, looks: 12, misses: 0 };
  // Without image boxes, fonts are loaded later and only for the pages that need them (below).
  for (const [n, index] of indices.entries()) {
    // One page that can't be read (a broken drawing, a font PDF.js rejects) leaves that page empty, not the document;
    // stopping (an AbortError from recognition) still stops.
    collected.push(await readPage(pdfjs, doc, index, { images, recognize, ocrAreas }).catch(error => { if (error?.name === 'AbortError') throw error; return { index, failed: true }; }));
    progress(n + 1, indices.length);
  }
  const read = collected.filter(e => !e.failed);
  // Body text size across the whole document, weighted by the amount of text, so pages that are mostly
  // headings don't skew what counts as a heading.
  const weights = new Map();
  for (const { items } of read) for (const i of items) weights.set(Math.round(i.size * 2) / 2, (weights.get(Math.round(i.size * 2) / 2) || 0) + i.text.length);
  const body = [...weights].sort((a, b) => b[1] - a[1])[0]?.[0] || 10;
  // Bold matters only for a line shaped like a bold heading. Loading a page's fonts also decodes its images, so
  // a page of plain sentences (most of a long report or scanned book) is read from its text alone.
  if (!images) {
    for (const entry of read) {
      if (!entry.content) continue;
      try {
        const candidate = piecesOf(pageTables(entry.items).rows).map(p => lineOf(p.items));
        if (!candidate.some(line => !line.bold && !largeHeading(line, body) && boldHeadingShape(line, body))) continue;
        const page = await doc.getPage(entry.index + 1);
        await page.getOperatorList();
        entry.items = rereadItems(entry.items, textItems(page, entry.viewport, entry.content)).filter(usable);
        page.cleanup();
      } catch { /* its fonts didn't load: bold stays unknown on this page */ }
    }
  }
  boldByStem(read, body);
  // The running text's font weight (Light, Regular...): the most used weight at the body size.
  const weighed = new Map();
  for (const { items } of read) for (const i of items) if (Math.round(i.size * 2) / 2 === body) weighed.set(i.weight || 400, (weighed.get(i.weight || 400) || 0) + i.text.length);
  const weight = [...weighed].sort((a, b) => b[1] - a[1])[0]?.[0] || 400;
  // Text that repeats in the top or bottom margin of several pages (running headers and footers).
  const repeats = new Map();
  repeats.pages = read.length;
  for (const { items, viewport } of read) {
    const margins = items.filter(i => i.y + i.size <= viewport.height * 0.08 || i.y >= viewport.height * 0.92);
    const edges = items.filter(i => i.y + i.size <= viewport.height * EDGE || i.y >= viewport.height * (1 - EDGE));
    if (!edges.length) continue;
    try {
      for (const p of piecesOf(pageTables(margins).rows)) {
        const key = `${p.bottom <= viewport.height * 0.08 ? 't' : 'b'}${marginKey(lineOf(p.items).text)}`;
        repeats.set(key, (repeats.get(key) || 0) + 1);
      }
      // The letters of the first two and last two lines of the page, counted once a page (see edgePattern).
      const seen = new Set(), pieces = piecesOf(pageTables(edges, null, { stream: false }).rows);
      for (const [kind, i] of edgeRanks(pieces, viewport.height)) {
        const key = `p${kind}${edgePattern(lineOf(pieces[i].items).text)}`;
        if (key.length >= 10 && !seen.has(key)) { seen.add(key); repeats.set(key, (repeats.get(key) || 0) + 1); }
      }
    } catch { /* the page is laid out (or reported unread) below */ }
  }
  for (const entry of collected) {
    let laid = null;
    try { laid = entry.failed ? null : pageResult(entry, body, repeats, weight); } catch { /* reported as unread below */ }
    result.pages.push(laid || unreadPage(entry.index, entry.viewport));
    entry.items = entry.content = entry.marks = null; // laid out: let the page's text go
  }
  // Heading levels across the whole document: the largest heading size is level 1, the next level 2, and so on.
  const headings = result.pages.flatMap(p => p.blocks.filter(b => b.type === 'heading'));
  const sizes = [...new Set(headings.map(b => Math.round(b.lines[0].fontSize)))].sort((a, b) => b - a);
  for (const block of headings) block.level = Math.min(3, sizes.indexOf(Math.round(block.lines[0].fontSize)) + 1);
  nestHeadings(headings);
  await bookmarkLevels(doc, result.pages);
  return result;
}

// ---------------------------------------------------------------------------------------------- exports

/** Said under a chart's table when its values were measured from the drawing rather than printed on it. */
export const CHART_NOTE = 'Values measured from the chart drawing; approximate.';

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** Runs of a block's text with their formatting, lines joined (hyphenated line ends rejoined), neighbours merged. */
export function blockRuns(block) {
  const runs = [];
  for (const line of block.lines || [{ text: block.text || '' }]) {
    const spans = line.spans || [{ text: line.text, bold: line.bold, italic: line.italic }];
    spans.forEach((s, k) => {
      let text = s.text;
      const last = runs.at(-1);
      if (k === 0 && last) {
        last.text = lineEnd(last.text, text); // a word broken at the line end joins up (pdf-text-fixes.js)
      }
      const run = { text, bold: Boolean(s.bold), italic: Boolean(s.italic), sup: Boolean(s.sup), sub: Boolean(s.sub), underline: Boolean(s.underline), strike: Boolean(s.strike) };
      const prev = runs.at(-1);
      if (prev && formatKey(prev) === formatKey(run)) prev.text += text; else runs.push(run);
    });
  }
  for (const r of runs) r.text = r.text.replace(/\s+/g, ' ');
  if (runs.length) { runs[0].text = runs[0].text.trimStart(); runs.at(-1).text = runs.at(-1).text.trimEnd(); }
  return runs.filter(r => r.text);
}

/** Markdown for inline text: **bold**, *italic*, <sup>, <sub>, with the markers hugging the words. */
function markdownRuns(runs) {
  return runs.map(r => {
    if (!r.text.trim()) return r.text;
    const [, lead, core, trail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(r.text);
    let out = core;
    if (r.sup) out = `<sup>${esc(out)}</sup>`;
    else if (r.sub) out = `<sub>${esc(out)}</sub>`;
    if (r.underline) out = `<u>${out}</u>`;
    if (r.strike) out = `~~${out}~~`;
    if (r.bold && r.italic) out = `***${out}***`; else if (r.bold) out = `**${out}**`; else if (r.italic) out = `*${out}*`;
    return lead + out + trail;
  }).join('');
}

// Backslashes first, so a cell's own backslash before a pipe can't cancel that pipe's escape and split the cell.
const cellMd = c => String(c ?? '').replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();

/** A table as a Markdown (GitHub) pipe table; the first row is the header row. `bold`: [row, column] cells in bold. */
export function tableMarkdown(rows, bold = []) {
  const width = Math.max(1, ...rows.map(r => r.length));
  const strong = new Set(bold.map(([r, c]) => `${r},${c}`));
  const line = (r, n) => `| ${Array.from({ length: width }, (_, i) => { const text = cellMd(r[i]); return text && strong.has(`${n},${i}`) ? `**${text}**` : text; }).join(' | ')} |`;
  return [line(rows[0] || [], 0), `|${' --- |'.repeat(width)}`, ...rows.slice(1).map((r, n) => line(r, n + 1))].join('\n');
}

/** A table as HTML, header rows in <th>, cells that span columns with colspan and rows with rowspan (`rowSpans`: [row, column, rows]). */
export function tableHtml(block) {
  const spanAt = new Map((block.spans || []).map(([r, c, n]) => [`${r},${c}`, n]));
  const downAt = new Map((block.rowSpans || []).map(([r, c, n]) => [`${r},${c}`, n]));
  const covered = new Set((block.rowSpans || []).flatMap(([r, c, n]) => Array.from({ length: n - 1 }, (_, k) => `${r + 1 + k},${c}`)));
  const strong = new Set((block.bold || []).map(([r, c]) => `${r},${c}`));
  return `<table>\n${block.rows.map((row, r) => {
    const cells = [];
    for (let c = 0; c < row.length; c++) {
      if (covered.has(`${r},${c}`)) continue;
      const n = spanAt.get(`${r},${c}`) || 1, down = downAt.get(`${r},${c}`) || 1, tag = r < (block.headerRows ?? (block.header ? 1 : 0)) ? 'th' : 'td';
      cells.push(`<${tag}${n > 1 ? ` colspan="${n}"` : ''}${down > 1 ? ` rowspan="${down}"` : ''}>${strong.has(`${r},${c}`) && row[c] ? `<strong>${esc(row[c])}</strong>` : esc(row[c])}</${tag}>`);
      c += n - 1;
    }
    return `<tr>${cells.join('')}</tr>`;
  }).join('\n')}\n</table>`;
}

/** A heading's text, with the bold or italic of words set apart inside it (a heading set all in bold reads plainly). */
function headingRuns(block, format, plain = t => t) {
  const runs = blockRuns(block);
  return runs.length > 1 && runs.some(r => r.bold || r.italic || r.sup || r.sub) ? format(runs) : plain(block.text);
}

/** Markdown for one block. Page headers and footers (running titles, page numbers) are kept as lines of their own. */
export function blockMarkdown(block) {
  if (block.type === 'header' || block.type === 'footer') return markdownRuns(blockRuns(block));
  if (block.type === 'table') return tableMarkdown(block.rows, block.bold);
  if (block.type === 'chart') return [block.title && `**${block.title}**`, tableMarkdown(block.rows), block.values === 'measured' && `*${CHART_NOTE}*`].filter(Boolean).join('\n\n');
  if (block.type === 'heading') return `${'#'.repeat(block.level || 1)} ${headingRuns(block, markdownRuns)}`;
  const runs = blockRuns(block);
  if (block.type === 'list' && BULLET.test(block.text)) return `- ${markdownRuns(withoutMarker(runs, BULLET.exec(block.text)[1]))}`;
  return markdownRuns(runs);
}

/** A list item's runs without its marker (a bullet or number), which may be a run of its own in another style. */
function withoutMarker(runs, marker) {
  let left = marker.length;
  const out = [];
  for (const r of runs) {
    let text = r.text;
    if (left > 0) { text = text.trimStart(); const cut = Math.min(left, text.length); left -= cut; text = text.slice(cut); }
    if (!out.length) text = text.trimStart();
    if (text) out.push({ ...r, text });
  }
  return out;
}

export function toJson(structure) { return JSON.stringify(structure, null, 2); }

export function toMarkdown(structure) {
  const out = [];
  for (const page of structure.pages) {
    let previous = null;
    for (const block of page.blocks) {
      const md = blockMarkdown(block);
      if (!md) continue;
      // List items follow each other line by line.
      if (block.type === 'list' && previous === 'list') out[out.length - 1] += `\n${md}`; else out.push(md);
      previous = block.type;
    }
    out.push(`<!-- end of page ${page.page} -->`);
  }
  return out.join('\n\n') + '\n';
}

function htmlRuns(runs) {
  return runs.map(r => {
    let out = esc(r.text);
    if (r.sup) out = `<sup>${out}</sup>`; else if (r.sub) out = `<sub>${out}</sub>`;
    if (r.underline) out = `<u>${out}</u>`;
    if (r.strike) out = `<s>${out}</s>`;
    if (r.italic) out = `<em>${out}</em>`;
    if (r.bold) out = `<strong>${out}</strong>`;
    return out;
  }).join('');
}

export function toHtml(structure, { title } = {}) {
  const pageHtml = page => {
    const out = [];
    let list = null;
    for (const b of page.blocks) {
      if (b.type === 'list') {
        const runs = withoutMarker(blockRuns(b), (BULLET.exec(b.text) || NUMBERED.exec(b.text) || [, ''])[1]);
        const tag = BULLET.test(b.text) ? 'ul' : 'ol';
        if (!list || list.tag !== tag) { list = { tag, items: [] }; out.push(list); }
        list.items.push(`<li>${htmlRuns(runs)}</li>`);
        continue;
      }
      list = null;
      if (b.type === 'heading') out.push(`<h${b.level}>${headingRuns(b, htmlRuns, esc)}</h${b.level}>`);
      else if (b.type === 'table') out.push(tableHtml(b));
      else if (b.type === 'chart') out.push(`<figure>\n${b.title ? `<figcaption>${esc(b.title)}</figcaption>\n` : ''}${tableHtml(b)}${b.values === 'measured' ? `\n<p><em>${CHART_NOTE}</em></p>` : ''}\n</figure>`);
      else if (b.type === 'header' || b.type === 'footer') out.push(`<${b.type}>${htmlRuns(blockRuns(b))}</${b.type}>`);
      else out.push(`<p>${htmlRuns(blockRuns(b))}</p>`);
    }
    return out.map(o => (typeof o === 'string' ? o : `<${o.tag}>\n${o.items.join('\n')}\n</${o.tag}>`)).join('\n');
  };
  const body = structure.pages.map(page => `<section class="page" data-page="${page.page}">\n${pageHtml(page)}\n</section>`).join('\n');
  const name = esc(title || structure.title || 'Document');
  return `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width,initial-scale=1">\n<title>${name}</title>\n<style>body{font:16px/1.6 system-ui,sans-serif;max-width:46rem;margin:2rem auto;padding:0 1rem;color:#141922}.page+.page{border-top:1px solid #e4e7ec;margin-top:2rem;padding-top:1rem}table{border-collapse:collapse;margin:1rem 0}td,th{border:1px solid #c9ced6;padding:.25rem .5rem;text-align:left;vertical-align:top}header,footer{color:#5b6472;font-size:.85em}</style>\n</head>\n<body>\n${body}\n</body>\n</html>\n`;
}

/**
 * Page index: a section tree for reasoning-based retrieval. Uses the PDF's bookmarks when present,
 * otherwise the detected headings. Each node: { id, title, level, startPage, endPage, children }.
 */
export async function buildPageIndex(doc, structure) {
  const flat = [];
  const outline = await doc.getOutline().catch(() => null);
  if (outline?.length) {
    const walk = async (items, level) => {
      for (const item of items) {
        let page = null;
        try {
          const dest = typeof item.dest === 'string' ? await doc.getDestination(item.dest) : item.dest;
          if (Array.isArray(dest)) page = (await doc.getPageIndex(dest[0])) + 1;
        } catch { /* unresolved destination */ }
        if (page) flat.push({ title: item.title.replace(UNTRUSTED, '').trim(), level, startPage: page });
        if (item.items?.length) await walk(item.items, level + 1);
      }
    };
    await walk(outline, 1);
  }
  const fromOutline = flat.length > 0;
  if (!flat.length) for (const page of structure.pages) for (const b of page.blocks) if (b.type === 'heading') flat.push({ title: b.text, level: b.level, startPage: page.page });
  const lastPage = structure.pageCount;
  flat.forEach((node, i) => {
    node.id = `n${i + 1}`;
    const next = flat.slice(i + 1).find(n => n.level <= node.level);
    // Headings can start mid-page, so a section runs up to and including the page where the next one starts;
    // a bookmark usually opens a new page, so there the section ends on the page before.
    node.endPage = next ? Math.max(node.startPage, next.startPage - (fromOutline && next.startPage > node.startPage ? 1 : 0)) : lastPage;
    node.children = [];
  });
  const roots = [], stack = [];
  for (const node of flat) {
    while (stack.length && stack.at(-1).level >= node.level) stack.pop();
    (stack.at(-1)?.children ?? roots).push(node);
    stack.push(node);
  }
  return roots;
}
