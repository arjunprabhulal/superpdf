// Page layout from a PDF page's text items and drawn lines: rows and cells, tables, page headers and footers,
// and reading order. Shared by every reader (Markdown, HTML, JSON, Word and Excel exports in the browser, the
// CLI, the MCP server and the local API) so they all see the same tables in the same order. No DOM, no
// dependencies.
//
// Tables are found two ways. A table drawn with lines (a grid of horizontal and vertical rules) is read cell by
// cell from its lines, the "lattice" method; other tables are found where the cells of several rows line up
// with gaps between them, the "stream" method. Both ideas follow tabula-java and Camelot (both MIT); no code is
// taken from them. Reading order splits a page at its widest empty bands (recursive XY-cut), so the columns of
// a multi-column page are read one after the other.
import { bidiRuns, rightToLeftItems } from './pdf-text-fixes.js';

const round = n => Math.round(n * 100) / 100;
const median = values => { const s = [...values].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };

// ---------------------------------------------------------------------------------------------- rows and cells

/**
 * Split text items that pad columns with runs of spaces (common in reports from older systems) into
 * separate items, placing each part in proportion to its characters.
 */
function splitPadded(item) {
  if (!/\S\s{2,}\S/.test(item.text)) return [item];
  const parts = [], perChar = item.width / Math.max(1, item.text.length);
  for (const match of item.text.matchAll(/\S+(?: \S+)*/g)) parts.push({ ...item, text: match[0], x: item.x + match.index * perChar, width: match[0].length * perChar });
  return parts;
}

/**
 * Rows of a page: items on the same baseline, left to right, split into segments (cells) where the gap
 * between neighbouring items is wider than about half the font size.
 * @returns {{top: number, base: number, size: number, segments: {text, x0, x1, size, bold, italic, font}[]}[]}
 */
export function textRows(items) {
  const sorted = items.flatMap(splitPadded).filter(i => i.text.trim()).map(i => ({ ...i, base: i.y + i.size })).sort((a, b) => a.base - b.base || a.x - b.x);
  const rows = [];
  for (const item of sorted) {
    const row = rows.at(-1);
    if (row && Math.abs(item.base - row.base) <= Math.max(1.5, Math.min(item.size, row.size) * 0.35)) row.items.push(item);
    else rows.push({ base: item.base, size: item.size, items: [item] });
  }
  // Superscripts and subscripts (footnote marks, exponents, chemical formulas): a row of a few short pieces of
  // smaller text, raised or lowered within the height of the row beside it, joins that row.
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i], size = median(r.items.map(x => x.size));
    if (r.items.some(x => x.text.trim().length > 6)) continue;
    const host = [rows[i + 1], rows[i - 1]].find(o => {
      if (!o) return false;
      const os = median(o.items.map(x => x.size));
      if (size > os * 0.8) return false;
      const x0 = Math.min(...o.items.map(x => x.x)) - os, x1 = Math.max(...o.items.map(x => x.x + x.width)) + os;
      if (!r.items.every(x => x.x >= x0 && x.x <= x1)) return false;
      return (r.base < o.base && r.base > o.base - os * 0.9) || (r.base > o.base && r.base - size < o.base);
    });
    if (!host) continue;
    for (const x of r.items) { x.sup = r.base < host.base; x.sub = r.base > host.base; }
    host.items.push(...r.items);
    rows.splice(i, 1);
    i = Math.max(-1, i - 2);
  }
  return rows.map(row => {
    const parts = row.items.sort((a, b) => a.x - b.x), segments = [];
    for (const p of parts) {
      const last = segments.at(-1), gap = last ? p.x - last.x1 : Infinity;
      if (last && gap <= Math.max(3, Math.min(p.size, last.size) * 0.55)) {
        if (gap > p.size * 0.12 && !/\s$/.test(last.text) && !/^\s/.test(p.text)) last.text += ' ';
        last.text += p.text;
        last.x1 = Math.max(last.x1, p.x + p.width);
        last.items.push(p);
      } else segments.push({ text: p.text, x0: p.x, x1: p.x + p.width, size: p.size, bold: p.bold, italic: p.italic, font: p.font, items: [p] });
    }
    // A cell written right to left (Hebrew, Arabic) reads from its right end.
    for (const s of segments) if (s.items.length > 1 && rightToLeftItems(s.items)) s.text = rightToLeftText(s.items);
    for (const s of segments) { s.text = s.text.replace(/\s+/g, ' ').trim(); s.x0 = round(s.x0); s.x1 = round(s.x1); }
    const size = median(parts.map(p => p.size));
    return { top: round(Math.min(...parts.map(p => p.y))), base: round(row.base), size, segments: segments.flatMap(splitLeaders).flatMap(splitFigures).filter(s => s.text) };
  }).filter(r => r.segments.length).map(r => { for (const s of r.segments) Object.defineProperty(s, 'items', { enumerable: false }); return r; });
}

/** Text items of one piece of a right-to-left row as text, read from the right (bidiRuns), spaced as textRows spaces. */
function rightToLeftText(items) {
  const parts = bidiRuns([...items].sort((a, b) => b.x + b.width - a.x - a.width));
  let text = '';
  parts.forEach((p, k) => {
    const prev = parts[k - 1], gap = prev ? Math.max(prev.x - (p.x + p.width), p.x - (prev.x + prev.width)) : 0;
    text += (prev && gap > p.size * 0.12 && !/\s$/.test(text) && !/^\s/.test(p.text) ? ' ' : '') + p.text;
  });
  return text;
}

const LEADER = /\s*(?:\.\s?){4,}\s*/;

/**
 * Dot leaders ("Revenues . . . . . $1,705.9") separate a label from its figure: the segment splits there (each part
 * placed in proportion to its characters) and the dots go.
 */
function splitLeaders(seg) {
  const m = LEADER.exec(seg.text);
  if (!m) return [seg];
  const left = seg.text.slice(0, m.index).replace(/(\s*\.){2,}$/, '').trim(), right = seg.text.slice(m.index + m[0].length).trim();
  // `items` may be non-enumerable (a part split off below), so it is carried over explicitly.
  const keep = text => Object.defineProperty({ ...seg, text }, 'items', { value: seg.items || [], enumerable: false, writable: true });
  if (!right) return [keep(left)];
  if (!left) return splitLeaders(keep(right));
  const perChar = (seg.x1 - seg.x0) / Math.max(1, seg.text.length), cut = seg.x0 + (m.index + m[0].length) * perChar;
  // An item that holds the leader itself ("Revenues . . . $1,705.9" drawn as one run) splits there too, so each part
  // keeps the items it was read from.
  const items = (seg.items || []).flatMap(leaderParts);
  const a = { ...seg, text: left, x1: round(seg.x0 + left.length * perChar) }, b = { ...seg, text: right, x0: round(cut) };
  const before = items.filter(i => i.x + i.width / 2 < cut), after = items.filter(i => i.x + i.width / 2 >= cut);
  Object.defineProperty(a, 'items', { value: before.length ? before : items, enumerable: false, writable: true });
  Object.defineProperty(b, 'items', { value: after.length ? after : items, enumerable: false, writable: true });
  return [a, ...splitLeaders(b)];
}

/** An item whose text runs into dot leaders, as its parts on either side of them (placed in proportion to characters). */
function leaderParts(item) {
  const m = LEADER.exec(item.text);
  if (!m) return [item];
  const perChar = item.width / Math.max(1, item.text.length), parts = [];
  const left = item.text.slice(0, m.index), right = item.text.slice(m.index + m[0].length);
  if (left.trim()) parts.push({ ...item, text: left, width: left.length * perChar });
  if (right.trim()) parts.push(...leaderParts({ ...item, text: right, x: item.x + (m.index + m[0].length) * perChar, width: right.length * perChar }));
  return parts.length ? parts : [item];
}

/**
 * Figures set close together in one run ("$ 513.3 $175.9", "932.2 154.4"): a segment made only of two or more figures
 * splits into one segment per figure, each keeping the items it came from (a run that holds several is cut in
 * proportion to its characters). A currency sign stays with the figure after it.
 */
function splitFigures(seg) {
  if (/\p{L}/u.test(seg.text) || !/\d\s/.test(seg.text)) return [seg]; // words, or no gap after a figure: nothing to split
  const parts = [...seg.text.matchAll(/(?:[$€£¥₹]\s?)?\(?[-−–]?[$€£¥₹]?\d[\d,.]*\)?%?/g)];
  if (parts.length < 2 || parts.map(m => m[0]).join('').replace(/\s+/g, '').length !== seg.text.replace(/\s+/g, '').length || !parts.every(m => isValue(m[0]))) return [seg];
  const items = seg.items || [];
  const pieces = [];
  for (const item of items) {
    const perChar = item.width / Math.max(1, item.text.length);
    for (const m of item.text.matchAll(/(?:[$€£¥₹]\s?)?\S+/g)) pieces.push({ ...item, text: m[0], x: item.x + m.index * perChar, width: m[0].length * perChar });
  }
  const out = [];
  for (const m of parts) {
    const own = [];
    let text = '';
    while (pieces.length && text.replace(/\s+/g, '').length < m[0].replace(/\s+/g, '').length) { const p = pieces.shift(); own.push(p); text += p.text; }
    if (!own.length) return [seg];
    const part = { ...seg, text: m[0], x0: round(Math.min(...own.map(p => p.x))), x1: round(Math.max(...own.map(p => p.x + p.width))) };
    Object.defineProperty(part, 'items', { value: own, enumerable: false, writable: true });
    out.push(part);
  }
  return out;
}

/** The text of items read as lines: top to bottom, left to right, one space between lines. */
function joinItems(items) {
  return textRows(items).map(r => r.segments.map(s => s.text).join(' ')).join(' ').replace(/(\w)- (\w)/g, '$1$2').trim();
}

// ---------------------------------------------------------------------------------------------- cell values

const NUMBER = /^(\()?([-+−–])?\s*([$€£¥₹])?\s*(\d{1,3}(?:,\d{3})+|\d+)?(\.\d+)?\s*(%)?\s*(\))?$/;

/**
 * A cell's value: a number when the text is one (thousands separators stripped; currency, percent and
 * negative in brackets kept as the number format), otherwise the text. Numbers with leading zeros
 * (codes such as 00123) and more than 15 digits stay text, so nothing is lost.
 * @returns {string | {value: number, format?: string}}
 */
export function cellValue(text) {
  const t = String(text ?? '').trim();
  const m = NUMBER.exec(t);
  if (!m || (!m[4] && !m[5]) || Boolean(m[1]) !== Boolean(m[7])) return t;
  const [, open, sign, currency, whole = '', fraction = '', percent] = m;
  const digits = whole.replace(/,/g, '');
  if (/^0\d/.test(digits) || digits.length + fraction.length > 16) return t;
  let value = Number(`${digits || '0'}${fraction}`);
  if (open || (sign && sign !== '+')) value = -value;
  if (percent) value /= 100;
  const decimals = fraction.length ? `.${'0'.repeat(fraction.length - 1)}` : '';
  let format = (whole.includes(',') ? '#,##0' : '0') + decimals;
  if (percent) format += '%';
  if (currency) format = `"${currency}"${format}`;
  if (open) format = `${format};(${format})`;
  return format === '0' ? { value } : { value, format };
}

// ("$ (8,978)": the currency sign before the brackets of a negative amount counts too)
const isNumeric = text => typeof cellValue(String(text).replace(/\s+/g, '').replace(/^([$€£¥₹])\((.*)\)$/, '($1$2)')) === 'object' || /^[-–—]$/.test(String(text).trim());
const isValue = text => isNumeric(text) && !TRAILER.test(String(text).trim()) && !YEAR.test(String(text).trim());
// A figure, or a mark a grid holds for yes or no ("x", "✓"; with `letters`, a capital letter code such as "S"): data,
// not words.
const isDatum = (text, letters = false) => isValue(text) || /^[xX✓✔✗✘]$/u.test(String(text).trim()) || (letters && /^\p{Lu}$/u.test(String(text).trim()));
/** Whether a grid's single capital letters are marks: a column holds three or more of them, most of its cells. */
const lettersAreMarks = rows => {
  const width = Math.max(0, ...rows.map(r => r.length));
  return [...Array(width).keys()].some(c => { const own = rows.map(r => r[c]).filter(Boolean), marks = own.filter(t => /^\p{Lu}$/u.test(t.trim())); return marks.length >= 3 && marks.length >= own.length * 0.6; });
};

/** A first row of labels over rows that hold numbers. */
function isHeader(rows) {
  if (rows.length < 2) return false;
  const numeric = row => row.some(c => typeof cellValue(c) === 'object');
  return rows[0].every(isLabel) && rows[0].filter(Boolean).length > 1 && rows.slice(1).some(numeric);
}

// A year (2024, FY2024) heads a column of figures: a label, not a value.
const YEAR = /^(FY|CY)?\s?(19|20)\d\d[A-Z]?$/i;
const isLabel = c => typeof cellValue(c) === 'string' || YEAR.test(String(c).trim());

// ---------------------------------------------------------------------------------------------- table clean-up

const CURRENCY = /^([$€£¥₹]|USD|EUR|GBP|JPY|CHF|CAD|AUD|CNY|HKD|SGD|INR|SEK|NOK|DKK)$/; // a sign or a currency code
const TRAILER = /^(%|\)|\(\d{1,2}\)|\*{1,3}|[†‡§¶]|\(?[a-z]\))$/;

/**
 * Tidy a grid read from a page: a column holding only currency signs joins the numbers after it, a column of
 * only percent signs or footnote marks joins the one before, and empty columns and rows go. Then the header: the
 * lines of labels at the top (headerDepth) become header rows, a label over several columns spanning them
 * (headerLayout); `geo` gives where things sit on the page ({cols: [{x0, x1}], lines: per row its label pieces
 * {x0, x1, text}, rules: horizontal lines {y, x0, x1}}); without it each cell sits over its own column and a `wide`
 * row's lone label spans the columns after the first.
 * @returns {{rows: string[][], header: boolean, headerRows: number, spans: number[][]}}
 */
export function tidyGrid(grid, wide = [], geo = null) {
  // Trailing dot leaders ("administrative . . .") go.
  let rows = grid.map(r => r.map(c => c.trim().replace(/(\s+\.){2,}$/, '')));
  const width = Math.max(0, ...rows.map(r => r.length));
  rows = rows.map(r => Array.from({ length: width }, (_, i) => r[i] || ''));
  let cols = geo?.cols?.length === width ? geo.cols.map(c => ({ x0: c.x0, x1: c.x1 })) : Array.from({ length: width }, (_, c) => ({ x0: c * 100, x1: c * 100 + 80 }));
  let lines = geo?.lines?.length === rows.length ? geo.lines.map(l => [...l])
    : rows.map((r, i) => r.flatMap((t, c) => {
      if (!t) return [];
      // (a lone label of a wide row spans the columns after the first)
      if (wide[i] && r.filter(Boolean).length === 1 && c > 0 && width >= 3) return [{ x0: cols[1].x0, x1: cols[width - 1].x1, text: t, whole: true }];
      return [{ x0: cols[c].x0 + 10, x1: cols[c].x1 - 10, text: t, whole: true }];
    }));
  const join = (from, to) => { cols[to] = { x0: Math.min(cols[from].x0, cols[to].x0), x1: Math.max(cols[from].x1, cols[to].x1) }; cols.splice(from, 1); };
  // (a label over the signs, in a header line above the first figures, goes with them when the column beside is empty
  // there: "February 2, 2025" over "$ | 9,060")
  const head = Math.max(0, rows.findIndex(r => r.some(isValue)));
  const only = (c, pattern, beside) => rows.some(r => r[c] && pattern.test(r[c])) && rows.every((r, i) => !r[c] || pattern.test(r[c]) || (i < head && !r[beside]));
  for (let c = 0; c < (rows[0]?.length || 0); c++) {
    if (c + 1 < rows[0].length && only(c, CURRENCY, c + 1)) {
      for (const r of rows) if (r[c]) r[c + 1] = r[c + 1] ? `${r[c]} ${r[c + 1]}` : r[c];
      for (const r of rows) r.splice(c, 1);
      join(c, c + 1); // (the sign's column joins the figures' column after it)
      c--;
    } else if (c > 0 && only(c, TRAILER, c - 1)) {
      for (const r of rows) if (r[c]) r[c - 1] = r[c - 1] ? `${r[c - 1]} ${r[c]}` : r[c];
      for (const r of rows) r.splice(c, 1);
      join(c, c - 1);
      c--;
    }
  }
  for (let c = (rows[0]?.length || 0) - 1; c >= 0; c--) if (!rows.some(r => r[c])) { for (const r of rows) r.splice(c, 1); cols.splice(c, 1); }
  lines = lines.filter((_, i) => rows[i].some(Boolean));
  rows = rows.filter(r => r.some(Boolean));
  // A header label set beside its column rather than over it: a column with only that label, next to a column of figures
  // with no label, is one column.
  const labelsEnd = rows.findIndex(r => r.some(isValue));
  if (rows.length >= 3 && labelsEnd > 0) {
    for (let c = 0; c + 1 < rows[0].length; c++) {
      const onlyHead = k => rows.slice(0, labelsEnd).some(r => r[k]) && rows.slice(labelsEnd).every(r => !r[k]);
      const noHead = k => rows.slice(0, labelsEnd).every(r => !r[k]) && rows.slice(labelsEnd).some(r => r[k]);
      const [from, to] = onlyHead(c) && noHead(c + 1) ? [c, c + 1] : onlyHead(c + 1) && noHead(c) ? [c + 1, c] : [];
      if (from === undefined) continue;
      for (const r of rows.slice(0, labelsEnd)) r[to] = r[from];
      for (const r of rows) r.splice(from, 1);
      join(from, to);
    }
  }
  if (!rows.length) return { rows, header: false, headerRows: 0, spans: [] };
  const depth = headerDepth(rows);
  if (!depth) return { rows, header: false, headerRows: 0, spans: [] };
  let { rows: top, spans } = headerLayout(rows.slice(0, depth), lines.slice(0, depth), cols, { rules: geo?.rules || [], stub: stubColumns(rows.slice(depth)) });
  // (the header holds every character its lines had; else its lines join column by column, as read)
  const letters = rs => rs.flat().join('').replace(/\s+/g, '').length;
  if (letters(top) !== letters(rows.slice(0, depth))) {
    top = [rows[0].map((_, c) => rows.slice(0, depth).map(r => r[c]).filter(Boolean).join(' '))];
    spans = [];
  }
  return { rows: [...top, ...rows.slice(depth)], header: true, headerRows: top.length, spans };
}

/**
 * What kind of text a cell holds, for telling header lines from body rows: a number (with its decimals, currency and
 * percent, so "46" over "0.870" differs), a year, a date, a code ("2005M07"), a short label or longer text.
 */
function cellType(text) {
  // (a sign before the figure, and a currency sign that belongs to the next cell run into this one: "10,631 $")
  const t = String(text).trim().replace(/^[±~≈<>≤≥]\s?(?=[\d.$])/, '').replace(/(\d)\s+[$€£¥₹]$/u, '$1');
  if (!t) return '';
  if (YEAR.test(t)) return 'y';
  if (NULL_MARK.test(t)) return '-';
  if (isNumeric(t)) {
    const digits = (/\d[\d,]*/.exec(t)?.[0] || '').replace(/,/g, '').length;
    return `n${/%/.test(t) ? '%' : ''}${/[$€£¥₹]/.test(t) ? '$' : ''}${/\.(\d+)/.exec(t)?.[1].length || 0}${digits <= 2 ? 's' : digits <= 4 ? 'm' : 'l'}`;
  }
  if (/\d/.test(t) && /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s/i.test(t)) return 't';
  if (/\d/.test(t) && !/\p{L}/u.test(t)) return 't'; // (a date, "10/29/21", or a range of figures)
  if (!/\s/.test(t) && /\d/.test(t) && /\p{L}/u.test(t)) return 'c';
  if (t.length === 1 || /^[✓✔✗✘●○■□xX]+$/u.test(t)) return 'k'; // a mark ("S", "x", "✓")
  return words(t) <= 3 ? 'w' : 'W';
}

const WORDISH = new Set(['w', 'W', '']);
const NULL_MARK = /^(\$\s?)?([-–—*]|n\/?a|nm|n\.m\.|none|nil)$/i; // a cell that says "nothing here" in a body row
// Figures of one kind: the same type, or numbers with the same decimals when they have decimals, a currency sign or a
// percent ("$1,705.9" over "(568.1)"); whole numbers of another size differ ("3 | 6 | 9" over "109,344").
const sameKind = (a, b) => a === b || (a[0] === 'n' && b[0] === 'n' && a.replace(/[$%]/g, '').slice(0, -1) === b.replace(/[$%]/g, '').slice(0, -1) && (a.slice(1, -1) !== '0' || /[$%]/.test(a)));

/**
 * How many rows at the top of a grid are header lines. The header ends where the body starts: the first row whose cells
 * are the kind of text their columns hold below it (figures under labels, a code under codes), the change of data type
 * between a table's head and its body that Fang, Mitra, Tang and Giles (2012, "Table header detection and
 * classification") score header rows by. Up to twelve lines; a lone row label right under the header (a section label) is
 * body. A table of words with nothing that sets a first row apart has a one-row header when that row is labels over
 * figures (isHeader).
 */
export function headerDepth(rows) {
  const n = rows.length, width = rows[0]?.length || 0;
  if (n < 2) return 0;
  // (the body a row is compared with starts at the next row holding a figure, or in a table of words its lower half:
  // header lines below the row are not the body)
  const valueAt = rows.map(r => r.slice(1).some(isValue));
  const typesBelow = (c, from) => {
    const next = valueAt.indexOf(true, from), start = next >= 0 ? next : Math.max(from, Math.ceil(n / 2));
    return rows.slice(start, start + 40).map(r => cellType(r[c])).filter(Boolean);
  };
  // Row-label columns (stubColumns): a word there says nothing about header or body.
  const stub = stubColumns(rows.slice(1));
  // (a line of several cells, one of six words or more, is running text; a title alone on its line may be long)
  const running = r => r.filter(Boolean).length >= 2 && r.some(c => words(c) >= 6);
  const isData = i => {
    // (two or more figures with decimals: a row of measurements, whatever the rows below hold)
    if (rows[i].slice(stub).filter(c => isValue(c) && /\d\.\d/.test(c)).length >= 2) return true;
    let match = 0, miss = 0;
    for (let c = 0; c < width; c++) {
      const t = cellType(rows[i][c]);
      if (!t || t === '-') continue;
      const below = typesBelow(c, i + 1);
      if (!below.length) continue; // (nothing below to compare with)
      const share = below.filter(x => sameKind(t, x)).length / below.length, common = share >= 0.25;
      if (c < stub) { if (common && !WORDISH.has(t)) return true; continue; }
      // (a first cell of the kind nearly every row's first cell is, "(0)" over "(1)", "(2)"...: a row of the body)
      if (c === stub && share >= 0.4 && !WORDISH.has(t)) return true;
      if (common && !WORDISH.has(t)) match++;
      else if (!common) miss++;
    }
    return match > 0 ? match >= miss || match >= 2 : miss === 0;
  };
  let depth = 0;
  for (let i = 0; i < Math.min(12, n - 1); i++) {
    // (a line with only a row-label column cell, "(mm)" under "Sleeve length", says nothing either way: it is header when
    // a header line follows it)
    const stubOnly = rows[i].every((c, k) => !c || k < Math.max(1, stub));
    if (stubOnly) continue;
    // (lines of a label that wraps are short: running text below the first line is not header)
    if (i > 0 && running(rows[i])) break;
    if (isData(i)) break;
    depth = i + 1;
  }
  // (a section label in the stub, "Expenses:", under the header is the body's first row)
  while (depth > 0 && rows[depth - 1].filter(Boolean).length === 1 && rows[depth - 1][0] && depth > 1) depth--;
  // Lines of labels with the first column empty, down to the line that names the first column ("CHARGE" / "(Percentage
  // of" / ... / "CLTA NO. | DESCRIPTION | POLICY FORM | indicated)"): all header, whatever the body holds.
  let top = 0;
  while (top < Math.min(12, n - 1) && !rows[top][0] && !rows[top].some(isValue) && !running(rows[top])) top++;
  if (top > 0 && top < n - 1 && rows[top].filter(Boolean).length > 1 && !rows[top].some(isValue)) depth = Math.max(depth, top + 1);
  if (depth === 1 && rows[0].filter(Boolean).length === 1 && rows[0][0] && !rows.slice(1, 3).some(r => r.slice(1).some(isValue))) depth = 0;
  if (!depth && isHeader(rows)) depth = 1;
  return depth;
}

/** The words of a piece of a line, each placed in proportion to its characters within the text run it is in. */
function wordsOf(piece) {
  const runs = piece.items?.length ? piece.items : [{ text: piece.text, x: piece.x0, width: piece.x1 - piece.x0 }];
  const out = [];
  for (const run of runs) {
    const perChar = run.width / Math.max(1, run.text.length);
    for (const m of run.text.matchAll(/\S+/g)) out.push({ text: m[0], x0: run.x + m.index * perChar, x1: run.x + (m.index + m[0].length) * perChar });
  }
  return out;
}

/**
 * Header lines as header rows, with the columns each label heads. A label over one column heads it; labels of the same
 * column on several lines (a label that wraps) join into one cell. A label over several columns (it runs across them,
 * sits in the gap between them, or a rule drawn under it runs across them) heads all the columns of its group and
 * stays a row of its own above them, spanning them: its group runs out to the rule under it, else as far on each side
 * as from its middle to the nearer end of the room it has (up to the next label of its line or halfway to the next
 * group label; row-label columns only when it is over them; a label starting at its group's first column takes the
 * room to its right). So a header reads as a tree of labels, each column keyed by its path from the top ("2018
 * Insurance"), the table model of Wang (1996, "Tabular abstraction, editing, and formatting") and the header paths
 * of Embley, Krishnamoorthy, Nagy and Seth (2016, "Converting heterogeneous statistical tables on the web to
 * searchable databases").
 * @returns {{rows: string[][], spans: number[][]}}
 */
export function headerLayout(head, lines, cols, { rules = [], stub = 0 } = {}) {
  const width = cols.length, mid = c => (cols[c].x0 + cols[c].x1) / 2, tol = 2;
  const all = cols.map((_, k) => k);
  const covering = s => all.filter(k => overlap(cols[k], s) > Math.min(2, (cols[k].x1 - cols[k].x0) * 0.25));
  const nearest = m => all.reduce((best, k) => (Math.abs(mid(k) - m) < Math.abs(mid(best) - m) ? k : best), 0);
  // A part of a line sits over column k: centred on it, or lined up with its left or right edge.
  const over = (p, k) => Math.abs((p.x0 + p.x1) / 2 - mid(k)) <= Math.max(4, (cols[k].x1 - cols[k].x0) * 0.3) || Math.abs(p.x0 - cols[k].x0) <= 3 || Math.abs(p.x1 - cols[k].x1) <= 3;
  const placed = head.map((row, i) => {
    const labels = [];
    for (const s of lines[i] || []) {
      let cover = covering(s);
      const m = (s.x0 + s.x1) / 2;
      if (cover.length >= 2 && !s.whole) {
        // Words that fall into separate columns, each part over its column, are separate labels set close together
        // ("Specialized Financial" over "Markets | Services"), not one label over the columns.
        // (split only between the text runs the line was drawn in: one run is one label)
        // (one run that names three or more columns word by word, "AL AK AZ ... WY", splits at its words)
        const runs = (s.items || []).map(it => ({ text: it.text.trim(), x0: it.x, x1: it.x + it.width })).filter(w => w.text);
        const ws = wordsOf(s), wordCols = ws.map(w => nearest((w.x0 + w.x1) / 2));
        const byWord = ws.length >= 3 && new Set(wordCols).size === ws.length && ws.every((w, j) => over(w, wordCols[j]));
        const parts = [];
        for (const w of byWord ? ws : runs) {
          const k = nearest((w.x0 + w.x1) / 2), last = parts.at(-1);
          if (last && last.col === k) { last.text += ` ${w.text}`; last.x1 = w.x1; } else parts.push({ text: w.text, x0: w.x0, x1: w.x1, col: k });
        }
        if (parts.length >= 2 && (lines[i] || []).length >= 2 && parts.every(p => over(p, p.col))) {
          for (const p of parts) labels.push({ text: p.text, x0: p.x0, x1: p.x1, cols: [p.col], wide: false });
          continue;
        }
      }
      // In the gap between two columns (a label centred over a group of them).
      const inGap = cover.length <= 1 && !cols.some(c => m >= c.x0 - tol && m <= c.x1 + tol) && m > cols[0].x0 && m < cols[width - 1].x1;
      // A rule drawn just under the label, running past it across two or more columns, marks out its group.
      // (centred under it, and under no other label of its line: a rule under the whole header line marks no group)
      const rule = s.base === undefined ? null : rules.find(r => r.y >= s.base - 1 && r.y <= s.base + (s.size || 10) * 1.2 && r.x0 <= m && r.x1 >= m
        && r.x1 - r.x0 > (s.x1 - s.x0) * 1.15 && Math.abs((r.x0 + r.x1) / 2 - m) <= (r.x1 - r.x0) * 0.25
        && all.filter(k => mid(k) >= r.x0 && mid(k) <= r.x1).length >= 2 && !(lines[i] || []).some(o => o !== s && (o.x0 + o.x1) / 2 > r.x0 && (o.x0 + o.x1) / 2 < r.x1));
      if (rule) cover = all.filter(k => mid(k) >= rule.x0 - tol && mid(k) <= rule.x1 + tol);
      if (!cover.length) cover = [nearest(m)];
      labels.push({ text: s.text, x0: s.x0, x1: s.x1, cols: cover, wide: cover.length >= 2 || inGap, ruled: Boolean(rule) });
    }
    return labels.sort((a, b) => a.x0 - b.x0);
  });
  // A label over several columns alone on the top line of a header of several lines is the table's title ("(in thousands,
  // except share data)", "Year ended December 31,"): it heads every column but the row labels'.
  const title = head.length >= 2 && placed[0].length === 1 && placed[0][0].wide && !placed[0][0].ruled ? placed[0][0] : null;
  if (title) { const a = Math.min(stub, title.cols[0]); title.cols = all.filter(k => k >= a); }
  // Each group label's room: up to the next label of its line (halfway, when that one heads a group too).
  for (const labels of placed) {
    labels.forEach((l, j) => {
      if (!l.wide || l.ruled || l === title) return;
      const prev = labels[j - 1], next = labels[j + 1];
      const left = prev ? (prev.wide ? (prev.x1 + l.x0) / 2 : cols[Math.max(...prev.cols)].x1) : -Infinity;
      const right = next ? (next.wide ? (l.x1 + next.x0) / 2 : cols[Math.min(...next.cols)].x0) : Infinity;
      // (row-label columns only under the label itself)
      const room = all.filter(k => mid(k) > left && mid(k) < right && (k >= stub || covering(l).includes(k)));
      if (!room.length) return;
      const m = (l.x0 + l.x1) / 2, first = room[0];
      let group;
      if (Math.abs(l.x0 - cols[first].x0) <= tol * 2 && l.cols.length >= 2) group = room; // set at the start of its group
      else {
        const reach = Math.min(m - cols[first].x0, cols[room.at(-1)].x1 - m);
        group = room.filter(k => mid(k) >= m - reach - tol && mid(k) <= m + reach + tol);
      }
      const keep = [...group, ...l.cols.filter(k => room.includes(k))];
      if (!keep.length) return;
      const a = Math.min(...keep), b = Math.max(...keep);
      l.cols = Array.from({ length: b - a + 1 }, (_, k) => a + k);
    });
  }
  // A label centred over a group label of the line below (the first line of a group label that wraps, "Principal
  // Beverage" over "Manufacturing/Bottling Plants") heads the same group.
  for (let i = placed.length - 2; i >= 0; i--) {
    for (const l of placed[i]) {
      const m = (l.x0 + l.x1) / 2;
      const under = placed[i + 1].find(u => u.cols.length >= 2 && Math.abs((u.x0 + u.x1) / 2 - m) <= Math.max(3, (u.x1 - u.x0) * 0.15) && l.cols.every(k => u.cols.includes(k)));
      if (under && l !== title) l.cols = [...under.cols];
    }
  }
  // Rows: a line with labels over several columns stays a row of its own (consecutive lines with the same groups join:
  // a group label that wraps); every other label joins its column's cell in one row under them, line by line.
  const spanRows = [], plain = Array(width).fill('');
  for (const labels of placed) {
    const groups = labels.filter(l => l.cols.length >= 2);
    for (const l of labels) if (l.cols.length < 2) plain[l.cols[0]] = plain[l.cols[0]] ? `${plain[l.cols[0]]} ${l.text}` : l.text;
    if (!groups.length) continue;
    const key = groups.map(g => `${g.cols[0]}-${g.cols.at(-1)}`).join(',');
    const last = spanRows.at(-1);
    if (last?.key === key && last.open && !groups.some(g => g.ruled)) { groups.forEach((g, k) => { last.cells[k].text += ` ${g.text}`; }); continue; }
    if (last) last.open = false;
    // (a label underlined by a rule is a level of its own: the next line doesn't join it)
    spanRows.push({ key, open: !groups.some(g => g.ruled), cells: groups.map(g => ({ text: g.text, cols: g.cols })) });
  }
  const rows = [], spans = [];
  // A header of one line stays one row: a label over several columns spans them in place.
  if (head.length === 1) {
    const row = Array(width).fill(''), owner = new Map();
    for (const l of placed[0]) {
      let cols = l.cols.filter(k => !owner.has(k));
      if (cols.length && cols.at(-1) - cols[0] !== cols.length - 1) cols = [cols[0]];
      // (no text is lost: a label whose columns are taken joins the cell that holds its first column)
      const at = cols.length ? cols[0] : owner.get(l.cols[0]);
      cols.forEach(k => owner.set(k, at));
      row[at] = row[at] ? `${row[at]} ${l.text}` : l.text;
      if (cols.length > 1) spans.push([0, cols[0], cols.length]);
    }
    return { rows: [row], spans };
  }
  for (const r of spanRows) {
    const row = Array(width).fill(''), owner = new Map();
    for (const cell of r.cells) {
      // (labels whose groups overlap: the first keeps its place, the other joins the cell that holds its first column)
      if (cell.cols.some(k => owner.has(k))) { const at = owner.get(cell.cols[0]) ?? cell.cols[0]; row[at] = row[at] ? `${row[at]} ${cell.text}` : cell.text; continue; }
      cell.cols.forEach(k => owner.set(k, cell.cols[0]));
      row[cell.cols[0]] = row[cell.cols[0]] ? `${row[cell.cols[0]]} ${cell.text}` : cell.text;
      spans.push([rows.length, cell.cols[0], cell.cols.length]);
    }
    rows.push(row);
  }
  if (plain.some(Boolean) || !rows.length) rows.push(plain);
  return { rows, spans };
}

/**
 * Row labels that head a group of rows: a label printed once beside the first of several rows it applies to, the cells
 * under it left blank (a cell merged down the rows, as a spreadsheet's merged cell or HTML's rowspan). In the leading
 * columns of labels (before the first column of figures), when a third or more of the body rows that carry on to the
 * right leave the column blank, the label spans its blank cells below, so every row reads whole ("Owners | 130 |
 * Fire"). A row with one cell to the right (a line of text that wrapped) or a cell spanning columns ends the group.
 * Returns the merged cells as [row, column, rows] (row spans); `rows` is unchanged.
 */
export function fillDown(rows, headerRows = 0, spans = []) {
  const body = rows.slice(headerRows), width = rows[0]?.length || 0, out = [];
  if (body.length < 3 || width < 2) return out;
  const spanned = new Set(spans.filter(([, , n]) => n > 1).map(([r]) => r));
  const view = body.map(r => [...r]); // (as read with the spans filled in, for the columns after)
  const types = c => body.map(r => cellType(r[c])).filter(x => x && x !== '-');
  const labels = c => { const t = types(c); return t.length && t.filter(x => x[0] !== 'n' && x !== 'k').length >= t.length * 0.6; };
  let filled = -1;
  for (let c = 0; c < width - 1; c++) {
    const carries = (r, i) => !spanned.has(i + headerRows) && r.slice(c + 1).filter(Boolean).length >= 2;
    const data = body.filter(carries);
    const blank = data.filter(r => !r[c]).length;
    // (the first column of figures in nearly every row ends the columns of labels)
    if (!labels(c) && blank <= data.length * 0.1 && types(c).some(t => t !== 'y')) break;
    if (blank < 2 || blank < data.length / 3 || data.length === blank) continue;
    // (labels of groups differ from one to the next; marks repeated down a column, "S" ... "S", say yes or no per row)
    const seen = body.map(r => r[c]).filter(Boolean);
    if (seen.filter((t, k) => k && t === seen[k - 1]).length > (seen.length - 1) * 0.3) continue;
    // A column of numbers spans only as a level under the one before it: blank where that one was blank.
    if (!labels(c) && (filled !== c - 1 || body.some((r, i) => carries(r, i) && !r[c] && body[i][c - 1]))) continue;
    let top = -1;
    const close = end => { if (top >= 0 && end - top > 1) out.push([headerRows + top, c, end - top]); top = -1; };
    body.forEach((r, i) => {
      // (only a label that starts a row of its group carries down; a section label alone on its row starts afresh)
      if (!carries(r, i)) { close(i); return; }
      if (r[c]) { close(i); top = i; return; }
      if (top >= 0 && (c === 0 || !body[i][c - 1] || view[i][c - 1] === view[i - 1][c - 1])) view[i][c] = view[top][c];
      else close(i);
    });
    close(body.length);
    filled = c;
  }
  return out;
}

/** Rows with the cells merged down (row spans [row, column, rows]) written out in each row they cover. */
export function filledDown(rows, rowSpans = []) {
  const out = rows.map(r => [...r]);
  for (const [r, c, n] of rowSpans) for (let k = 1; k < n; k++) if (out[r + k]) out[r + k][c] = out[r][c];
  return out;
}

/**
 * A table's header rows as one row, each column named by the labels over it from the top ("2018 Insurance"; a label
 * spanning columns names each of them), for formats with a single header row (Markdown, a spreadsheet's first row).
 * Returns the rows with the header rows replaced by that one row; a table with one header row or none is unchanged.
 * @param {{rows: string[][], headerRows?: number, spans?: number[][]}} table
 * @returns {string[][]}
 */
export function flatHeader({ rows, headerRows = 0, spans = [] }) {
  if (headerRows < 2) return rows;
  const width = Math.max(...rows.map(r => r.length));
  const keys = Array.from({ length: width }, (_, c) => rows.slice(0, headerRows).map((r, k) => {
    const span = spans.find(([sr, sc, n]) => sr === k && c >= sc && c < sc + n);
    return span ? rows[k][span[1]] : r[c];
  }).filter(Boolean).join(' '));
  return [keys, ...rows.slice(headerRows)];
}

/** Row-label columns: the leading columns whose body cells are words. */
function stubColumns(body) {
  const width = body[0]?.length || 0;
  let stub = 0;
  while (stub < width - 1) {
    const types = body.slice(0, 40).map(r => cellType(r[stub])).filter(Boolean);
    if (!types.length || types.filter(t => t === 'w' || t === 'W').length < types.length * 0.6) break;
    stub++;
  }
  return stub;
}

// ---------------------------------------------------------------------------------------------- ruled tables

const TOL = 2; // points: lines this close count as touching

/** Join lines that lie on the same line and touch or overlap. `pos` is their y (or x), `a`-`b` their extent. */
function mergeLines(lines, pos, a, b) {
  const sorted = [...lines].sort((p, q) => p[pos] - q[pos] || p[a] - q[a]);
  const out = [];
  for (const l of sorted) {
    const same = out.findLast(o => Math.abs(o[pos] - l[pos]) <= TOL && l[a] <= o[b] + TOL);
    if (same) same[b] = Math.max(same[b], l[b]);
    else out.push({ ...l });
  }
  return out;
}

/** Positions within TOL of each other become one (their mean). */
function cluster(values) {
  const out = [];
  for (const v of [...values].sort((a, b) => a - b)) {
    const last = out.at(-1);
    if (last && v - last.at(-1) <= TOL * 1.5) last.push(v); else out.push([v]);
  }
  return out.map(g => g.reduce((s, v) => s + v, 0) / g.length);
}

/** Pieces of an item, split into words where it crosses one of the column lines `xs` (text drawn as one run across cells). */
function piecesAcross(item, xs) {
  const x1 = item.x + item.width;
  if (!xs.some(x => x > item.x + TOL && x < x1 - TOL) || !/\s/.test(item.text.trim())) return [item];
  const perChar = item.width / Math.max(1, item.text.length), out = [];
  for (const m of item.text.matchAll(/\S+/g)) out.push({ ...item, text: m[0], x: item.x + m.index * perChar, width: m[0].length * perChar });
  return out;
}

/**
 * Table lines on a page picture (a scan): rules {h, v} in page points. Dark pixels are kept where they run on in one
 * direction for at least 1/`scale` of the page's width (or height), which is a morphological opening with long 1-D
 * kernels, as Camelot's lattice method does (MIT; credited in scripts/adapted-sources.json), written fresh here as run
 * lengths: letters are too short to survive, rules and cell borders remain. Neighbouring pixel rows of one line (a
 * thick or slightly slanted rule) become one line. `image` is {data: RGBA bytes, width, height}; `scale` pixels per point.
 * @returns {{h: {y, x0, x1}[], v: {x, y0, y1}[]}}
 */
export function imageRules(image, scale, { lineScale = 15, threshold = 160, max = 4000 } = {}) {
  const { data, width, height } = image || {};
  if (!data || !width || !height || !(scale > 0)) return { h: [], v: [] };
  const ink = new Uint8Array(width * height);
  for (let p = 0, q = 0; p < ink.length; p++, q += 4) ink[p] = (data[q] * 299 + data[q + 1] * 587 + data[q + 2] * 114) / 1000 < threshold && data[q + 3] > 128 ? 1 : 0;
  // Runs of ink at least `min` long along one direction: [across, from, to] in pixels.
  const runs = (count, length, at, min) => {
    const out = [];
    for (let a = 0; a < count; a++) {
      let start = -1;
      for (let b = 0; b <= length; b++) {
        if (b < length && ink[at(a, b)]) { if (start < 0) start = b; }
        else if (start >= 0) { if (b - start >= min) out.push([a, start, b]); start = -1; }
      }
      if (out.length > max * 4) break;
    }
    return out;
  };
  // Runs in neighbouring rows (columns) that overlap are one line, at their middle.
  const lines = list => {
    const open = [], done = [];
    for (const [a, from, to] of list) {
      const hit = open.find(l => l.last >= a - 1 && Math.min(l.to, to) - Math.max(l.from, from) >= Math.min(to - from, l.to - l.from) * 0.5);
      if (hit) { hit.last = a; hit.sum += a; hit.n++; hit.from = Math.min(hit.from, from); hit.to = Math.max(hit.to, to); }
      else open.push({ first: a, last: a, sum: a, n: 1, from, to });
      for (let k = open.length - 1; k >= 0; k--) if (open[k].last < a - 1) done.push(...open.splice(k, 1));
    }
    return [...done, ...open].filter(l => l.last - l.first < 12).slice(0, max);
  };
  const h = lines(runs(height, width, (y, x) => y * width + x, Math.max(8, Math.round(width / lineScale))));
  const v = lines(runs(width, height, (x, y) => y * width + x, Math.max(8, Math.round(height / lineScale))));
  return {
    h: h.map(l => ({ y: round(l.sum / l.n / scale), x0: round(l.from / scale), x1: round(l.to / scale) })),
    v: v.map(l => ({ x: round(l.sum / l.n / scale), y0: round(l.from / scale), y1: round(l.to / scale) })),
  };
}

const JOIN = 5; // points: lines this close belong to one grid (cells drawn as separate boxes with a small gap)

/**
 * Groups of horizontal and vertical lines that cross, touch or come within JOIN of each other (union-find). Vertical
 * lines are sorted by x, so each horizontal line only looks at the ones within its reach. Joining lines within a
 * tolerance follows pdfplumber's table finder (MIT; credited in scripts/adapted-sources.json); written fresh here.
 * @returns {{h: object[], v: object[]}[]}
 */
export function lineGroups(h, v) {
  const parent = [...Array(h.length + v.length).keys()];
  const find = i => { while (parent[i] !== i) i = parent[i] = parent[parent[i]]; return i; };
  const byX = v.map((l, j) => j).sort((a, b) => v[a].x - v[b].x), xs = byX.map(j => v[j].x);
  const firstAtLeast = x => { let lo = 0, hi = xs.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (xs[mid] < x) lo = mid + 1; else hi = mid; } return lo; };
  h.forEach((a, i) => {
    for (let k = firstAtLeast(a.x0 - JOIN); k < byX.length && xs[k] <= a.x1 + JOIN; k++) {
      const b = v[byX[k]];
      if (a.y >= b.y0 - JOIN && a.y <= b.y1 + JOIN) parent[find(i)] = find(h.length + byX[k]);
    }
  });
  const groups = new Map();
  [...h, ...v].forEach((l, i) => {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, { h: [], v: [] });
    groups.get(root)[i < h.length ? 'h' : 'v'].push(l);
  });
  return [...groups.values()];
}

/**
 * Whether the lines of text inside one ruled band are several rows (a body ruled only at its edges) rather than one
 * row whose cells wrap: there are three or more lines, or numbers; two or more columns hold several lines each, about as
 * many as the longest (an address of several lines beside a rate is one cell that wraps, not rows of its own);
 * and no column's text runs on from line to line (a line ending in a comma, or the next starting in lower case).
 * `colOf(item)` is the ruled column an item sits in.
 */
function isStackOfRows(lines, colOf) {
  const perColumn = new Map();
  for (const line of lines) {
    const byCol = new Map();
    for (const s of line.segments) for (const i of s.items) byCol.set(colOf(i), `${byCol.get(colOf(i)) || ''} ${i.text}`.trim());
    for (const [c, text] of byCol) { if (!perColumn.has(c)) perColumn.set(c, []); perColumn.get(c).push(text); }
  }
  const counts = [...perColumn.values()].map(t => t.length);
  if (lines.length < 3 && !lines.some(l => l.segments.some(s => isValue(s.text)))) return false;
  // Rows fill their columns alike; wrapped cells leave one column much longer than the others.
  if (counts.filter(n => n >= 2 && n >= Math.max(...counts) * 0.6).length < 2) return false;
  const runsOn = texts => {
    let pairs = 0, on = 0;
    for (let k = 1; k < texts.length; k++) { pairs++; if (/[,;&/-]$/.test(texts[k - 1]) || /^\p{Ll}/u.test(texts[k])) on++; }
    return pairs >= 2 && on >= pairs * 0.5;
  };
  return ![...perColumn.values()].some(runsOn);
}

/**
 * Rules plus the top and bottom edges of shaded bands inside a grid of lines (a header row set apart only by its fill):
 * `fills` are filled rectangles {x0, y0, x1, y1} in page coordinates. Only fills within a grid that has lines both ways
 * count, so shaded panels and the bars of a chart never make a table of their own. Using the edges of filled
 * rectangles as ruling lines follows tabula-java (MIT; credited in scripts/adapted-sources.json); written fresh here.
 */
export function withFillEdges(rules, fills = []) {
  if (!rules || !fills.length || !rules.h?.length || !rules.v?.length || fills.length > 2000) return rules;
  const frames = lineGroups(rules.h, rules.v).filter(g => g.h.length >= 2 && g.v.length >= 2).map(g => ({
    x0: Math.min(...g.h.map(l => l.x0), ...g.v.map(l => l.x)), x1: Math.max(...g.h.map(l => l.x1), ...g.v.map(l => l.x)),
    y0: Math.min(...g.h.map(l => l.y), ...g.v.map(l => l.y0)), y1: Math.max(...g.h.map(l => l.y), ...g.v.map(l => l.y1)),
  }));
  const h = [];
  for (const f of fills) {
    if (f.x1 - f.x0 < 20 || f.y1 - f.y0 < 3) continue;
    const inside = frames.some(g => f.x0 >= g.x0 - JOIN && f.x1 <= g.x1 + JOIN && f.y0 >= g.y0 - JOIN && f.y1 <= g.y1 + JOIN && f.x1 - f.x0 >= (g.x1 - g.x0) * 0.5);
    if (inside) h.push({ y: round(f.y0), x0: round(f.x0), x1: round(f.x1) }, { y: round(f.y1), x0: round(f.x0), x1: round(f.x1) });
  }
  return h.length ? { h: [...rules.h, ...h], v: rules.v } : rules;
}

/**
 * Tables drawn with lines. Lines that cross or touch form a group; a group with at least two horizontal and two
 * vertical lines is a grid whose cells hold the text inside them. Where a column line stops short of a row the
 * cells on either side are one cell spanning both columns. A band between two horizontal lines that holds several
 * rows of text (tables ruled only around the header and the edge) is split into rows where its lines of text
 * start, and a line of text that only continues the cells above (a wrapped cell) stays with them.
 * @param {{h: {y, x0, x1}[], v: {x, y0, y1}[]}} rules
 * @returns {{box: {top, bottom, x0, x1}, rows: string[][], spans: number[][], header: boolean, headerRows: number,
 *   items: object[], boldTexts: Set<string>}[]}
 */
export function ruledTables(items, rules) {
  if (!rules || !rules.h?.length || !rules.v?.length) return [];
  const h = mergeLines(rules.h, 'y', 'x0', 'x1').filter(l => l.x1 - l.x0 >= 6);
  const v = mergeLines(rules.v, 'x', 'y0', 'y1').filter(l => l.y1 - l.y0 >= 6);
  if (h.length + v.length > 4000) return []; // a drawing (map, chart), not a table
  const tables = [];
  for (const g of lineGroups(h, v)) {
    if (g.h.length < 2 || g.v.length < 2) continue;
    const xs = cluster(g.v.map(l => l.x)), ys = cluster(g.h.map(l => l.y));
    if (xs.length < 3 || ys.length < 2) continue; // one column: a box around text, not a table
    const box = { top: ys[0], bottom: ys.at(-1), x0: xs[0], x1: xs.at(-1) };
    const inside = items.filter(i => { const cx = i.x + i.width / 2, cy = i.y + i.size * 0.6; return cx > box.x0 && cx < box.x1 && cy > box.top && cy < box.bottom; });
    if (!inside.length) continue;
    const pieces = inside.flatMap(splitPadded).flatMap(i => piecesAcross(i, xs));
    const colOf = p => { const cx = p.x + p.width / 2; let c = xs.findIndex((x, k) => k < xs.length - 1 && cx >= x && cx < xs[k + 1]); return c < 0 ? 0 : c; };
    const bandOf = p => { const cy = p.y + p.size * 0.6; let r = ys.findIndex((y, k) => k < ys.length - 1 && cy >= y && cy < ys[k + 1]); return r < 0 ? 0 : r; };
    const cols = xs.length - 1;
    const vAt = (c, y) => g.v.some(l => Math.abs(l.x - xs[c]) <= TOL * 1.5 && l.y0 <= y + TOL && l.y1 >= y - TOL);
    const bands = Array.from({ length: ys.length - 1 }, () => []);
    for (const p of pieces) bands[bandOf(p)].push(p);
    const rows = [], spans = [], pieceRows = [], boldTexts = new Set();
    bands.forEach((band, r) => {
      if (!band.length) return;
      let groupsOfLines = [band];
      // A band holds one row, unless it is a stack of rows (a body ruled only at its edges): two or more columns
      // with several lines each, and either three or more lines or numbers in them. A line that only continues
      // the cells above (no text in the row's first column, no numbers, close under it) stays with them.
      const lines = textRows(band);
      const stacked = isStackOfRows(lines, colOf);
      if (stacked) {
        groupsOfLines = [];
        let prev = null;
        for (const line of lines) {
          const lineItems = line.segments.flatMap(s => s.items);
          const filled = new Set(lineItems.map(colOf));
          const firstCol = prev ? Math.min(...prev.cols) : 0;
          const continues = prev && !filled.has(firstCol) && !line.segments.some(s => isNumeric(s.text)) && line.base - prev.base <= line.size * 1.6;
          if (continues) { prev.items.push(...lineItems); lineItems.forEach(i => prev.cols.add(colOf(i))); prev.base = line.base; }
          else { prev = { items: [...lineItems], cols: filled, base: line.base }; groupsOfLines.push(prev.items); }
        }
      }
      for (const group of groupsOfLines) {
        const top = Math.min(...group.map(p => p.y)), bottom = Math.max(...group.map(p => p.y + p.size));
        const mid = (top + bottom) / 2;
        const cells = Array.from({ length: cols }, () => []);
        for (const p of group) cells[colOf(p)].push(p);
        // Spanning cells: no column line between two neighbours at this row's height.
        const rowSpans = [];
        for (let c = 0; c < cols - 1; c++) {
          let end = c;
          while (end < cols - 1 && !vAt(end + 1, mid)) end++;
          // Without a line between them, cells that each hold their own text, none of it crossing into the next
          // column, are still separate cells (a header row ruled only above and below).
          const own = [];
          for (let k = c; k <= end; k++) if (cells[k].some(p => p.text.trim())) own.push(k);
          const crosses = cells.slice(c, end + 1).flat().some(p => p.text.trim() && xs.slice(c + 1, end + 1).some(x => p.x < x - TOL && p.x + p.width > x + TOL));
          // A phrase centred over the columns ("Dimensions | In Inches") has only a word space where it meets the line.
          const seen = k => cells[k].filter(p => p.text.trim());
          const apart = own.every((k, i) => !i || Math.min(...seen(k).map(p => p.x)) - Math.max(...seen(own[i - 1]).map(p => p.x + p.width)) >= Math.max(...seen(k).map(p => p.size)) * 0.8);
          // (or each sits inside its own column: "AL AK AZ ..." drawn as one run over a column each)
          const within = own.length >= 3 && own.every(k => seen(k).every(p => p.x >= xs[k] - TOL && p.x + p.width <= xs[k + 1] + TOL));
          if (end > c && own.length >= 2 && !crosses && (apart || within)) { c = end; continue; }
          if (end > c) { for (let k = c + 1; k <= end; k++) cells[c].push(...cells[k].splice(0)); rowSpans.push([c, end - c + 1]); c = end; }
        }
        pieceRows.push({ cells, spans: rowSpans, band: r, stacked: groupsOfLines.length > 1, top, bottom });
      }
    });
    if (!pieceRows.length) continue;
    // A ruled column can hold several columns of its own, separated only by space (a "Code  Factor" pair under
    // one rule): when most of its rows split into the same number of cells, it is split the same way.
    const parts = Array.from({ length: cols }, (_, c) => {
      const lineRows = pieceRows.filter(r => !r.spans.some(([sc, n]) => n > 1 && c >= sc && c < sc + n)).map(r => textRows(r.cells[c])).filter(l => l.length);
      const firstLines = lineRows.map(l => l[0]).filter(Boolean);
      const multi = firstLines.filter(l => l.segments.length > 1);
      // Most rows split, or the header splits ("MIN TYP MAX") and some figures below it do too.
      const headed = lineRows.slice(0, 3).flat().some(l => l.segments.length > 1 && !l.segments.some(seg => isValue(seg.text)));
      if (multi.length < 2 || (multi.length < firstLines.length * 0.6 && !headed)) return null;
      const columns = columnsOf(lineRows.flat());
      return columns.length > 1 ? columns : null;
    });
    const width = parts.reduce((n, p) => n + (p ? p.length : 1), 0);
    const startOf = c => parts.slice(0, c).reduce((n, p) => n + (p ? p.length : 1), 0);
    for (const r of pieceRows) {
      const row = Array(width).fill('');
      const spanned = new Map(r.spans.map(([c, n]) => [c, n]));
      for (let c = 0; c < cols; c++) {
        const n = spanned.get(c) || 1;
        if (n > 1 || !parts[c]) {
          row[startOf(c)] = joinItems(r.cells[c]);
          if (allBold(r.cells[c])) boldTexts.add(row[startOf(c)]);
          const cover = startOf(c + n) - startOf(c);
          if (cover > 1) spans.push([rows.length, startOf(c), cover]);
          c += n - 1;
          continue;
        }
        const sub = parts[c].map(() => []);
        for (const line of textRows(r.cells[c])) for (const seg of line.segments) sub[columnFor(parts[c], seg)].push(...seg.items);
        sub.forEach((pieces, k) => { row[startOf(c) + k] = joinItems(pieces); if (allBold(pieces)) boldTexts.add(row[startOf(c) + k]); });
      }
      rows.push(row);
    }
    if (!rows.length) continue;
    // A cell merged down two or more rows (no line between them in its column, lines there in others): each row it spans
    // reads its text, as HTML's rowspan does ("Masonry" beside each of its eight rows). Only where every ruled column is a
    // column of the table and each of the rows is a band of its own.
    const downs = [];
    if (parts.every(p => !p)) {
      const hAt = (band, c) => g.h.some(l => Math.abs(l.y - ys[band]) <= TOL * 1.5 && l.x0 <= (xs[c] + xs[c + 1]) / 2 && l.x1 >= (xs[c] + xs[c + 1]) / 2);
      const crossed = band => [...Array(cols).keys()].some(c => hAt(band, c));
      for (let c = 0; c < cols; c++) {
        for (let k = 0; k < pieceRows.length;) {
          let e = k;
          while (e + 1 < pieceRows.length && !pieceRows[e].stacked && !pieceRows[e + 1].stacked && pieceRows[e + 1].band === pieceRows[e].band + 1
            && !hAt(pieceRows[e + 1].band, c) && crossed(pieceRows[e + 1].band) && ![k, e + 1].some(q => pieceRows[q].spans.some(([sc, n]) => n > 1 && c >= sc && c < sc + n))) e++;
          const texts = rows.slice(k, e + 1).map(r => r[c]).filter(Boolean);
          // (the text goes to the merged cell's top row; the rows below are covered by it)
          if (e > k && texts.length === 1) { for (let q = k; q <= e; q++) rows[q][c] = q === k ? texts[0] : ''; downs.push([k, c, e - k + 1]); }
          k = e + 1;
        }
      }
    }
    // A grid with one row and no text in most cells is a form or a frame, not a table.
    if (rows.length < 2 && rows[0].filter(Boolean).length < 2) continue;
    const cleaned = tidyGridKeepingSpans(rows, spans, downs);
    if (!cleaned.rows.length || (cleaned.rows.length < 2 && (cleaned.rows[0]?.length || 0) < 2)) continue;
    const { usedCols, keepRows, ...grid } = cleaned;
    // The x range of each column, when every ruled column is one column of the table (for header lines found above it).
    const edges = parts.every(p => !p) ? usedCols.map(c => [xs[c], xs[c + 1]]) : null;
    const rowY = keepRows.map(r => [pieceRows[r].top, pieceRows[r].bottom]); // (where each row sits, top to bottom)
    tables.push({ box: { top: round(box.top), bottom: round(box.bottom), x0: round(box.x0), x1: round(box.x1) }, ...grid, edges, items: inside, boldTexts, rowY });
  }
  return tables.sort((a, b) => a.box.top - b.box.top || a.box.x0 - b.box.x0);
}

/** Tidy a ruled table: its columns come from lines, so only empty rows and columns go (spans follow them). */
function tidyGridKeepingSpans(rows, spans, downs = []) {
  const usedCols = [...Array(rows[0].length).keys()].filter(c => rows.some(row => row[c]));
  const keepRows = rows.map((_, r) => r).filter(r => rows[r].some(Boolean));
  const colIndex = new Map(usedCols.map((c, i) => [c, i])), rowIndex = new Map(keepRows.map((r, i) => [r, i]));
  const out = keepRows.map(r => usedCols.map(c => rows[r][c]));
  const outSpans = [];
  for (const [r, c, n] of spans) {
    if (!rowIndex.has(r) || !colIndex.has(c)) continue;
    const cs = usedCols.filter(k => k >= c && k < c + n).length;
    if (cs > 1) outSpans.push([rowIndex.get(r), colIndex.get(c), cs]);
  }
  // Header rows: the rows above the body (headerDepth); a table of text has one.
  let headerRows = out.length > 1 ? headerDepth(out) : 0;
  if (out.length > 1 && !headerRows && !out.some(r => r.some(isValue))) headerRows = 1;
  // Cells merged down (drawn so: no line under them), then labels that head a group of rows (fillDown), as row spans.
  const rowSpans = [];
  for (const [r, c, n] of downs) {
    const kept = keepRows.filter(k => k >= r && k < r + n);
    if (rowIndex.has(r) && colIndex.has(c) && kept.length > 1 && rowIndex.get(r) >= headerRows) rowSpans.push([rowIndex.get(r), colIndex.get(c), kept.length]);
  }
  const taken = new Set(rowSpans.flatMap(([r, c, n]) => Array.from({ length: n }, (_, k) => `${r + k},${c}`)));
  for (const d of fillDown(out, headerRows, outSpans)) if (!Array.from({ length: d[2] }, (_, k) => `${d[0] + k},${d[1]}`).some(x => taken.has(x))) rowSpans.push(d);
  return { rows: out, spans: outSpans, rowSpans, header: headerRows > 0, headerRows, usedCols, keepRows };
}

// ---------------------------------------------------------------------------------------------- stream tables

/**
 * Text laid out in boxes or columns that isn't a table: one column; side-by-side profiles or notes, where many lines
 * hold a single piece of text; two lines of sentences (all with hardly any figures); or a numbered list ("1." beside
 * each line of text).
 */
function wordsNotTable(rows) {
  const cells = rows.flat().filter(Boolean);
  if (!cells.length || Math.max(...rows.map(r => r.length)) < 2) return true;
  const marks = lettersAreMarks(rows), datum = c => isDatum(c, marks);
  const figures = cells.filter(datum).length, average = cells.reduce((n, c) => n + c.length, 0) / cells.length;
  const singles = rows.filter(r => r.filter(Boolean).length === 1).length / rows.length;
  const numbered = rows.length >= 2 && rows.every(r => /^\(?(\d{1,3}|[a-z])[.)]$/i.test(r[0] || '') && r.slice(1).filter(Boolean).length === 1 && !r.slice(1).some(isValue));
  // Justified text set with wide word spaces: lone lower-case words beside a run of a sentence.
  const loose = cells.filter(c => /^\p{Ll}[\p{L}'’-]*[,;]?$/u.test(c) && !datum(c)).length;
  if (!figures && loose >= cells.length * 0.3 && cells.some(c => c.split(/\s+/).length >= 6)) return true;
  return numbered || (figures < cells.length * 0.15 && average >= 25 && singles >= 0.3) || (!figures && rows.length <= 2 && average >= 20);
}

const MARK = /^[•●▪◦○■□►▸‣⁃∙·➢➤\p{Co}\u0080-\u009f]$/u; // a bullet or icon set as a glyph of its own (not a tick)

/**
 * Text laid out in a grid that is not a table (checked on a tidied grid of either kind): a table of contents in groups
 * across the page; a list set in columns (a
 * column of bullet or icon glyphs beside text, or most cells starting with a bullet); cards side by side (two or more
 * rows whose cells all repeat the same label, "Term of office ends: 2027" under each person); or numbered steps or
 * tabs (a first row counting 1, 2, 3... over words, with no figures below); or the labels of a chart, over its axis.
 */
export function layoutNotTable(rows) {
  const cells = rows.flat().filter(Boolean);
  if (!cells.length) return false;
  const width = Math.max(...rows.map(r => r.length));
  const figures = cells.filter(c => isValue(c) && !MARK.test(c)).length;
  const markColumn = [...Array(width).keys()].some(c => {
    const own = rows.map(r => r[c]).filter(Boolean);
    return own.length >= 2 && own.every(t => MARK.test(t.trim()));
  });
  if (markColumn && figures <= cells.length * 0.1) return true;
  // (a column of dashes as list markers, each beside a sentence: "- | Do not heat the pen.")
  const dashList = [...Array(width - 1).keys()].some(c => {
    const own = rows.map(r => r[c]).filter(Boolean), next = rows.filter(r => r[c]).map(r => r[c + 1] || '');
    return own.length >= 2 && own.every(t => /^[-–—*]$/.test(t.trim())) && next.every(t => words(t) >= 3) && rows.every(r => r.filter(Boolean).length <= 2);
  });
  if (dashList) return true;
  if (cells.filter(c => BULLET_START.test(c)).length >= cells.length * 0.4 && figures <= cells.length * 0.1) return true;
  // (a label, or a mark with a date: "✪ 2023"; not a figure or a tick that a table repeats)
  // (or the same label before a colon in most of them: "Board member since: 2013 | Board member since: 2023")
  const label = t => (/^([^:]{4,40}:)/.exec(t) || [])[1];
  const repeated = rows.filter(r => {
    const f = r.filter(Boolean);
    if (f.length >= 2 && f.every(t => t === f[0]) && f[0].length >= 6 && !isValue(f[0]) && !YEAR.test(f[0])) return true;
    const l = f.map(label).filter(Boolean), top = l.find(x => l.filter(y => y === x).length >= 2);
    return Boolean(top) && l.filter(y => y === top).length >= Math.max(2, f.length * 0.6);
  }).length;
  if (repeated >= 2) return true;
  const first = (rows[0] || []).filter(Boolean);
  const counting = first.length >= 3 && first.every((t, i) => /^\d{1,2}$/.test(t) && Number(t) === Number(first[0]) + i);
  if (counting && !rows.slice(1).some(r => r.some(isValue))) return true;
  // A table of contents set in groups across the page: page numbers rising down a column beside a column of titles,
  // two or more such pairs side by side.
  const pages = c => { const n = rows.map(r => r[c]).filter(Boolean); return n.length >= 3 && n.every(t => /^\d{1,4}$/.test(t)) && n.every((t, k) => !k || +t > +n[k - 1]); };
  const titles = c => { const t = rows.map(r => r[c]).filter(Boolean); return t.length >= 3 && t.filter(x => /\p{L}{2}/u.test(x) && !isValue(x)).length >= t.length * 0.8; };
  let groups = 0;
  for (let c = 0; c + 1 < width; c++) if ((pages(c) && titles(c + 1)) || (titles(c) && pages(c + 1))) { groups++; c++; }
  if (groups >= 2) return true;
  // (a scale repeated on every row, "Inferior 1 2 ... 10 Superior", is a rating grid, not an axis)
  return rows.length >= 2 && isAxis(rows.at(-1)) && !isAxis(rows.at(-2));
}

/**
 * The scale under a chart that couldn't be read as data: four or more numbers (not years) that rise or fall by the
 * same step ("$3,500 $3,750 $4,000 $4,250"). As the last row of a grid, it is the chart's axis, not a table's row.
 */
function isAxis(row) {
  // Ticks close together can share a cell ("$3,750 $4,000").
  const tokens = row.flatMap(c => (c || '').replace(/([$€£¥₹])\s+/g, '$1').split(/\s+/)).filter(t => t && !YEAR.test(t));
  const read = tokens.map(t => cellValue(t)), values = read.filter(v => typeof v === 'object').map(v => v.value);
  // An axis is figures, with at most a unit or a label beside them.
  if (values.length < 4 || read.length - values.length > 1) return false;
  const step = values[1] - values[0];
  return step !== 0 && values.every((v, i) => !i || Math.abs(v - values[i - 1] - step) <= Math.abs(step) * 0.01);
}

const BULLET_START = /^[•●▪◦○■□►▸‣⁃∙·➢➤]\s*\S/u;

const overlap = (a, b) => Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);

/** Column ranges of a block of rows, from the rows with the most common cell count (spanning cells excluded). */
function columnsOf(rows) {
  const counts = new Map();
  for (const r of rows) if (r.segments.length > 1) counts.set(r.segments.length, (counts.get(r.segments.length) || 0) + 1);
  const mode = [...counts].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0][0];
  const columns = [];
  const add = s => {
    const hits = columns.filter(c => overlap(c, s) > 0);
    if (!hits.length) { columns.push({ x0: s.x0, x1: s.x1 }); return; }
    // Cells in the model rows widen the column they share; overlapping columns merge.
    const merged = { x0: Math.min(s.x0, ...hits.map(c => c.x0)), x1: Math.max(s.x1, ...hits.map(c => c.x1)) };
    for (const c of hits) columns.splice(columns.indexOf(c), 1);
    columns.push(merged);
  };
  rows.filter(r => r.segments.length === mode).forEach(r => r.segments.forEach(add));
  // Cells in other rows that sit in a gap no model row uses become columns of their own, narrowest first (a group label
  // over several of them, "Offset (mm)" over "6 | 7 | 8", doesn't make them one).
  const others = rows.flatMap(r => r.segments).sort((a, b) => (a.x1 - a.x0) - (b.x1 - b.x0));
  // (a label centred in a narrow gap between two columns heads both of them: "Total" over "Reported | Constant Currency")
  const between = s => {
    const left = columns.filter(c => c.x1 <= s.x0).reduce((a, c) => (!a || c.x1 > a.x1 ? c : a), null);
    const right = columns.filter(c => c.x0 >= s.x1).reduce((a, c) => (!a || c.x0 < a.x0 ? c : a), null);
    if (!left || !right || /\d/.test(s.text)) return false;
    const gap = right.x0 - left.x1;
    return gap <= (s.x1 - s.x0) * 2.5 && Math.abs((s.x0 + s.x1) / 2 - (left.x1 + right.x0) / 2) <= gap * 0.2;
  };
  for (const s of others) if (!columns.some(c => overlap(c, s) > 0) && !between(s)) columns.push({ x0: s.x0, x1: s.x1 });
  return columns.sort((a, b) => a.x0 - b.x0);
}

/** Index of the column a segment belongs to: the one it overlaps most, or the nearest. */
function columnFor(columns, s) {
  let best = 0, score = -Infinity;
  columns.forEach((c, i) => {
    const o = overlap(c, s), value = o > 0 ? o : -Math.abs((c.x0 + c.x1) / 2 - (s.x0 + s.x1) / 2) - 1e6;
    if (value > score) { score = value; best = i; }
  });
  return best;
}

function toGrid(rows, columns) {
  return rows.map(r => {
    const cells = Array(columns.length).fill('');
    for (const s of r.segments) {
      const i = columnFor(columns, s);
      cells[i] = cells[i] ? `${cells[i]} ${s.text}` : s.text;
    }
    return cells;
  });
}

/**
 * Tables on one page found from where cells line up: runs of rows with two or more cells, close together,
 * allowing up to two single-cell rows between them (a cell that wrapped, or a group label), and short header lines
 * just above (labels that wrap over several lines). Two-column prose (every column's cells long) is not a table.
 */
/**
 * Whether the rows of a candidate table leave a channel of white space down the page between its columns: an x range,
 * at least 2 points wide and inside the table, where at most a quarter of the rows of several cells have text. Columns of
 * a table line up, so their gaps do; the wide word gaps of justified text fall at different places on every line. (The
 * text-edge idea of Nurminen's stream method, as in Camelot (MIT; credited in scripts/adapted-sources.json); written
 * fresh here.)
 */
function hasChannel(rows) {
  const multi = rows.filter(r => r.segments.length > 1);
  if (multi.length < 3) return true;
  const events = [];
  for (const r of multi) for (const s of r.segments) events.push([s.x0, 1], [s.x1, -1]);
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const x0 = events[0][0], x1 = events.at(-1)[0], allowed = multi.length * 0.25;
  let depth = 0, start = null;
  for (const [x, d] of events) {
    const before = depth;
    depth += d;
    if (before > allowed && depth <= allowed) start = x;
    else if (before <= allowed && depth > allowed && start !== null) {
      if (x - start >= 2 && start > x0 && x < x1) return true;
      start = null;
    }
  }
  return false;
}

/**
 * Entries that wrap with a hanging indent (a schedule of investments: "RR 28 Ltd., Series 2024-28RA, Class" over
 * indented lines "A1R, (3-mo. CME Term SOFR" ... "04/15/37 | 5,718 | 5,742,049"): an indented line of the first column
 * joins the entry above when that line ran to the column's edge (or ends with a comma or hyphen), the entry has no
 * figures yet and its label isn't a heading ending in a colon. Lines join cell by cell; `keep` marks the joined ones.
 */
function hangingEntries(run, grid, keep, columns, lines) {
  const first = run.map(r => (columnFor(columns, r.segments[0]) === 0 ? r.segments[0] : null));
  const lefts = first.filter(Boolean).map(s => s.x0);
  if (lefts.length < 3) return;
  const left = Math.min(...lefts), size = median(run.map(r => r.size)), widest = Math.max(...first.filter(Boolean).map(s => s.x1 - s.x0));
  const indented = i => first[i] && first[i].x0 - left >= size * 0.5 && first[i].x0 - left <= size * 3;
  if (run.filter((_, i) => indented(i)).length < 2 || !run.some((_, i) => first[i] && !indented(i))) return;
  for (let i = 1; i < grid.length; i++) {
    if (!keep[i] || !indented(i)) continue;
    let p = i - 1;
    while (p > 0 && !keep[p]) p--;
    // The line above, or the entry's own first line, ran to the column's edge (or broke after a comma or hyphen).
    const ran = line => line && (line.x1 - line.x0 >= widest * 0.7 || /[,\-–]$/.test(line.text));
    const wrapped = ran(first[i - 1]) || ran(first[p]);
    if (!keep[p] || grid[p].slice(1).some(Boolean) || /:$/.test(grid[p][0]) || !wrapped) continue;
    grid[p] = grid[p].map((c, k) => [c, grid[i][k]].filter(Boolean).join(' '));
    lines[p].push(...lines[i]);
    keep[i] = false;
  }
}

function streamTables(rows, hRules = []) {
  const tables = [];
  let run = [];
  // A label ending in a colon with its value beside it ("Maturity:  February 1") is a line of a key-value list, not a
  // table row: such lines at either end of a run are text.
  const pair = r => r.segments.length === 2 && r.segments[0].text.length <= 40 && /\p{L}.*:$/u.test(r.segments[0].text);
  const flush = () => {
    while (run.length && (run[0].segments.length < 2 || pair(run[0]))) run.shift();
    while (run.length && (run.at(-1).segments.length < 2 || pair(run.at(-1)))) run.pop();
    if (run.filter(r => r.segments.length > 1).length >= 2) {
      const x0 = Math.min(...run.flatMap(r => r.segments.map(s => s.x0))), x1 = Math.max(...run.flatMap(r => r.segments.map(s => s.x1)));
      // Header lines above: close, inside the table's width, and short (not a sentence across the page).
      const floor = tables.length ? tables.at(-1).last + 1 : 0;
      const valueStart = Math.min(...run.filter(r => r.segments.length > 1).map(r => r.segments[1].x0));
      // ...each over a column of figures or at the start of the first column (a title centred above the table is not), in
      // the table's type size (a heading in a larger type over it is not).
      const fits = (row, below) => row.segments.every(s => s.x0 >= x0 - 2 && s.x1 <= x1 + 2 && s.x1 - s.x0 < (x1 - x0) * 0.5 && !/[.:;]$/.test(s.text))
        && row.segments.some(s => s.x1 > valueStart || s.x0 <= x0 + 2) && !CAPTION.test(row.segments[0].text)
        && row.size <= below.size * 1.25 && below.top - row.base <= Math.max(row.size, below.size) * 1.2;
      // (a row label alone on its line, "Long-lived assets:", between the header and the first row of figures)
      const rowLabel = row => row.segments.length === 1 && row.segments[0].x1 < valueStart - 4 && row.segments[0].x0 >= x0 - row.size * 3 && row.segments[0].text.length <= 60;
      for (let k = rows.indexOf(run[0]) - 1, added = 0; k >= floor && added < 4; k--, added++) {
        const row = rows[k], below = run[0];
        if (fits(row, below)) { run.unshift(row); continue; }
        // (with column labels over the figures right above it: "2018 | 2017")
        if (!added && k - 1 >= floor && rowLabel(row) && below.top - row.base <= Math.max(row.size, below.size) * 1.2 && fits(rows[k - 1], row)
          && rows[k - 1].segments.every(s => s.x0 >= valueStart - row.size)) { run.unshift(row); continue; }
        break;
      }
      let columns = columnsOf(run);
      // A sentence under the table that runs across several columns (a note) isn't one of its rows.
      const spansColumns = r => r.segments.some(s => s.text.length > 30 && columns.filter(c => (c.x0 + c.x1) / 2 > s.x0 && (c.x0 + c.x1) / 2 < s.x1).length >= 2);
      while (run.length > 2 && spansColumns(run.at(-1))) {
        run.pop();
        // (and the rule of dashes that set the note apart)
        while (run.length > 2 && run.at(-1).segments.length < 2 && /^[-—–_=\s]+$/.test(run.at(-1).segments[0]?.text || '')) run.pop();
        columns = columnsOf(run);
      }
      const grid = toGrid(run, columns);
      // Where each row's pieces sit, for the header (tidyGrid).
      const lines = run.map((_, i) => [i]); // (the rows each grid row was read from)
      // A row label that wraps over several lines ("Selling, general and" / "administrative") joins the row of
      // figures it belongs to: lines with only a first cell, just above a row whose label carries on in lower case.
      const keep = run.map(() => true), firsts = grid.map(r => r[0]);
      for (let i = grid.length - 2, target = grid.length - 1; i >= 0; i--) {
        if (keep[i + 1]) target = i + 1;
        if (grid[i].slice(1).some(Boolean) || !grid[i][0] || !/^[\p{Ll}(]/u.test(firsts[i + 1] || '')) continue;
        if (run[i + 1].base - run[i].base > Math.max(run[i].size, run[i + 1].size) * 1.5) continue;
        grid[target][0] = `${grid[i][0]} ${grid[target][0]}`;
        lines[target].unshift(...lines[i]);
        keep[i] = false;
      }
      hangingEntries(run, grid, keep, columns, lines);
      // A cell of words that wraps onto the next line, alone there (the line carries on in lower case, or after a comma or
      // a hyphen), is one cell with the line above it ("Indenture, dated ... between the registrant and the bank" / "of
      // New York Mellon Trust Company, N.A., as trustee.").
      // (in the body: from the first row of figures, or below the first row in a table of words)
      const firstData = Math.max(1, grid.findIndex(r => r.some(isDatum)));
      for (let i = firstData + 1, p = firstData, last = firstData; i < grid.length; i++) {
        if (!keep[i]) continue;
        const own = grid[i].map((t, c) => (t ? c : -1)).filter(c => c >= 0);
        const c = own[0], above = grid[p][c];
        // (or set in from where the cell starts: a hanging indent)
        const start = run[p].segments.find(sg => columnFor(columns, sg) === c)?.x0;
        const wraps = own.length === 1 && c > 0 && above && grid[p].filter(Boolean).length >= 2 && !isDatum(grid[i][c]) && words(above) >= 3
          && (/^\p{Ll}/u.test(grid[i][c]) || /[,;\-–]$/.test(above) || (start !== undefined && run[i].segments[0].x0 - start >= run[i].size * 0.5)
            // (or a line of words, set tight under a row of figures: "Series B Preferred" under its entry's first line)
            || (grid[p].some(isDatum) && run[i].base - run[last].base <= Math.max(run[i].size, run[last].size) * 1.3))
          && run[i].base - run[last].base <= Math.max(run[i].size, run[last].size) * 1.6;
        if (wraps) { grid[p][c] = `${above} ${grid[i][c]}`; lines[p].push(...lines[i]); keep[i] = false; } else p = i;
        last = i;
      }
      // Columns of prose (a multi-column page, a brochure) are not a table: most cells are long runs of words and
      // hardly any hold figures.
      const filled = grid.flat().filter(Boolean);
      const marks = lettersAreMarks(grid), datum = c => isDatum(c, marks);
      const long = filled.filter(c => c.length > 35 && c.split(' ').length >= 5).length, figures = filled.filter(datum).length;
      // Columns of a designed page (a brochure, an annual report) line up too, but their text runs on from line to
      // line ("located in the heart" / "of the city") or leaves most of the grid empty, with few figures.
      const kept = grid.filter((_, i) => keep[i]);
      let pairs = 0, runsOn = 0;
      for (let r = 1; r < kept.length; r++) kept[r].forEach((cell, c) => { if (cell && kept[r - 1][c] && !datum(cell)) { pairs++; if (/^[\p{Ll}(]/u.test(cell) && !/[.:;!?]$/.test(kept[r - 1][c])) runsOn++; } });
      const fill = kept.flat().filter(Boolean).length / Math.max(1, kept.length * columns.length);
      // Columns of a page set justified: no figures, and the lines of every column fill its width.
      const ratios = columns.map(() => []);
      for (const r of run) for (const s of r.segments) { const c = columnFor(columns, s); ratios[c].push((s.x1 - s.x0) / Math.max(1, columns[c].x1 - columns[c].x0)); }
      const full = ratios.filter(list => list.length >= 3 && median(list) >= 0.8);
      // Lines of running text cut at their wide word spaces: within a row, one cell's words carry on into the next (it
      // starts in lower case after one that doesn't end a sentence), and the cells are short pieces of lines.
      let across = 0, acrossOn = 0;
      for (const r of kept) {
        const own = r.filter(Boolean);
        for (let k = 1; k < own.length; k++) { across++; if (/^\p{Ll}/u.test(own[k]) && !/[.:;!?]$/.test(own[k - 1]) && !datum(own[k])) acrossOn++; }
      }
      const pieces = across >= 4 && acrossOn >= across * 0.35;
      // (or cut where the word spaces of justified lines are only a little wider than usual: the gaps between a row's
      // cells hardly wider than a space, where a table's columns are set well apart; the word-gap ratio LiteParse uses
      // to tell tables from prose, as an idea)
      const gaps = run.filter(r => r.segments.length > 1).flatMap(r => r.segments.slice(1).map((sg, k) => (sg.x0 - r.segments[k].x1) / r.size));
      const tight = gaps.length >= 6 && median(gaps) < 0.9;
      // (or a grid of four or more columns of short pieces of words with hardly a figure or mark: the lines of narrow columns of
      // text side by side, cut at their word spaces, in any language)
      // (pieces of running text are nearly all different and hold hardly a digit; a table of words repeats its values,
      // "Yes", "No", or carries codes and numbers, "354-32-5")
      const shreds = figures <= filled.length * 0.05 && columns.length >= 4 && kept.length >= 8 && median(filled.map(c => c.length)) <= 20
        && new Set(filled.map(c => c.toLowerCase())).size >= filled.length * 0.8 && filled.filter(c => /\d/.test(c)).length <= filled.length * 0.05;
      const justified = !figures && full.length >= 2 && full.reduce((n, l) => n + l.length, 0) >= ratios.reduce((n, l) => n + l.length, 0) * 0.8;
      const prose = justified || shreds || ((pieces || tight) && figures < filled.length * 0.15) || !hasChannel(run) || wordsNotTable(kept) || columns.every((_, c) => median(grid.map(row => row[c].length).filter(Boolean)) > 30) || (long > filled.length * 0.4 && figures < filled.length * 0.15)
        || (!figures && filled.every(c => c.split(' ').length >= 4)) || fill < 0.3
        // (a short block of two or three lines whose text runs on in every column: headings side by side that wrap)
        || (figures < filled.length * 0.15 && ((pairs >= (kept.length <= 3 ? 2 : 3) && runsOn >= pairs * 0.5) || fill < 0.45))
        // Pieces of sentences (cells of three or more words starting in lower case) are lines of running text, unless
        // each line is numbered (a manuscript's line numbers, kept beside their lines).
        || (filled.filter(c => /^\p{Ll}/u.test(c) && words(c) >= 3).length >= Math.max(2, filled.length * 0.25) && !lineNumbered(kept));
      if (columns.length > 1 && !prose) tables.push({
        first: rows.indexOf(run[0]), last: rows.indexOf(run.at(-1)), columns, grid: grid.filter((_, i) => keep[i]),
        // Where the table sits on the page (points from the top-left), and its lines as read, for Extract tables from PDF.
        box: { top: run[0].top, bottom: Math.max(...run.map(r => r.base)), x0: Math.min(...run.flatMap(r => r.segments.map(s => s.x0))), x1: Math.max(...run.flatMap(r => r.segments.map(s => s.x1))) },
        lines: run.map(r => r.segments.map(s => s.text).join(' | ')),
        boldTexts: new Set(run.flatMap(r => r.segments.filter(seg => allBold(seg.items)).map(seg => seg.text))),
        // Rows with a label that spans several columns (a group heading over the figures).
        wide: run.filter((_, i) => keep[i]).map(r => r.segments.some(s => columns.filter(c => overlap(c, s) > (c.x1 - c.x0) * 0.3).length >= 2)),
        geo: { cols: columns, rules: hRules, lines: lines.filter((_, i) => keep[i]).map(own => own.flatMap(k => run[k].segments.map(s => ({ x0: s.x0, x1: s.x1, text: s.text, base: run[k].base, size: run[k].size, items: s.items })))) },
      });
    }
    run = [];
  };
  rows.forEach((row, i) => {
    const prev = run.at(-1);
    // (in about the same type: a heading in a much larger type over a table is not one of its rows)
    const bigger = prev && (prev.size > row.size ? prev : row);
    const close = prev && row.base - prev.base <= Math.max(prev.size, row.size) * 3.5
      && (Math.max(prev.size, row.size) <= Math.min(prev.size, row.size) * 1.45 || !bigger.segments.some(s => /\p{L}{2}/u.test(s.text)));
    // A new row of column labels right after rows of figures starts the next table (tables stacked one under another).
    const figures = r => r.segments.some(s => isValue(s.text));
    const labels = r => r.segments.every(s => /\p{L}/u.test(s.text) || YEAR.test(s.text));
    // (or two or more short labels and no figures at all: "Accident Period | Loss Development Factors" over the next block)
    const heads = r => r.segments.length >= 2 && r.segments.every(s => !isValue(s.text) && s.text.length < 40) && r.segments.filter(s => /\p{L}{3}/u.test(s.text)).length >= 2;
    // (group labels on lines of their own may come between: "Year Ended December 31, 2009" over the next block)
    const lastRow = run.findLast(r => r.segments.length > 1);
    const restarts = prev && ((row.segments.length > 2 && labels(row)) || heads(row)) && lastRow && figures(lastRow) && run.filter(figures).length >= 2;
    // Running text right under a table (a page in two columns below it: two or more long runs of words side by side,
    // no figures) is not more of its rows.
    const prose = r => r.segments.filter(s => s.text.length >= 30 && words(s.text) >= 5).length >= 2 && !figures(r);
    const intoProse = prev && prose(row) && run.filter(r => r.segments.length > 1).length >= 3 && run.some(figures) && !run.slice(-3).some(prose);
    if (!close || restarts || intoProse) flush();
    if (row.segments.length > 1) run.push(row);
    else if (run.length) {
      // A single-cell row stays in the table only when the table carries on after it.
      const next = rows[i + 1];
      const singles = run.length - 1 - run.findLastIndex(r => r.segments.length > 1);
      // ...and is a label, not a sentence across the table: short, or kept left of the columns of figures (a long row
      // label that wraps, "Adjustments to reconcile net loss to net cash", in a table of figures).
      const [only] = row.segments, x0 = Math.min(...run.flatMap(r => r.segments.map(s => s.x0))), x1 = Math.max(...run.flatMap(r => r.segments.map(s => s.x1)));
      const valueStart = Math.min(...run.filter(r => r.segments.length > 1).map(r => r.segments[1].x0));
      const numbers = run.flatMap(r => r.segments.slice(1).filter(s => isValue(s.text))).length >= 2;
      const headed = run.some(r => r.segments.length >= 3 && !r.segments.some(s => isValue(s.text)));
      const firstColumn = (numbers || headed) && only.x0 <= x0 + row.size * 3 && only.x1 < valueStart - 4;
      const label = (only.text.length <= 60 && only.x1 - only.x0 < (x1 - x0) * 0.6) || firstColumn;
      // (or the wrapped lines of a cell of text in a later column: starting at or just inside where that column's cells
      // start, and ending within it)
      // (set close under the line above, which has a cell there too)
      const last = run.at(-1);
      const inColumn = words(only.text) >= 2 && !isValue(only.text) && row.base - last.base <= row.size * 1.6 && last.segments.some((s, k) => (k > 0 || last.segments.length === 1) && only.x0 >= s.x0 - 1 && only.x0 - s.x0 <= row.size * 2)
        && run.some(r => r.segments.length > 1 && r.segments.slice(1).some(s => only.x0 >= s.x0 - 1 && only.x0 - s.x0 <= row.size * 2 && only.x1 <= s.x1 + row.size * 3));
      // (an entry of a schedule can wrap over several lines before its figures)
      if (singles < (firstColumn || inColumn ? 6 : 2) && (label || inColumn) && next && next.base - row.base <= Math.max(row.size, next.size) * 3.5) run.push(row);
      else flush();
    }
  });
  flush();
  return tables;
}

const words = text => text.split(/\s+/).filter(Boolean).length;
/** Rows whose first cells count up 1, 2, 3... (line numbers in a manuscript's margin). */
const lineNumbered = rows => {
  const n = rows.map(r => r[0]).filter(Boolean);
  return n.length >= 5 && n.every((t, i) => /^\d{1,4}$/.test(t) && (!i || Number(t) === Number(n[i - 1]) + 1));
};
const CAPTION = /^(table|exhibit|schedule|figure|fig\.)\s*[\dA-Z]+[.:]?(\s|$)/i; // "Table 4 Error at the neck", a title, not a header

/**
 * Where a column of running text sits beside other content (a page in two columns, with a table or boxes in one of
 * them): four or more lines of prose starting at the same x, with something beside them that no line crosses and that
 * keeps its own baselines (a table's rows line up with their labels; the next column of a page doesn't). Returns the
 * x of the gap and the stretch of the page it runs down, or null.
 */
function gutter(rows) {
  const prose = [];
  for (const r of rows) for (const s of r.segments) if (s.text.length >= 30 && words(s.text) >= 6) prose.push({ r, s });
  if (prose.length < 4) return null;
  const groups = [];
  for (const p of prose.sort((a, b) => a.s.x0 - b.s.x0)) {
    const g = groups.at(-1);
    if (g && p.s.x0 - g.at(-1).s.x0 <= 3) g.push(p); else groups.push([p]);
  }
  for (const g of groups) {
    if (g.length < 4) continue;
    const top = Math.min(...g.map(p => p.r.top)), bottom = Math.max(...g.map(p => p.r.base));
    const inside = rows.filter(r => r.base >= top && r.top <= bottom);
    const x0 = Math.min(...g.map(p => p.s.x0)), x1 = median(g.map(p => p.s.x1));
    const size = median(g.map(p => p.r.size));
    for (const side of ['right', 'left']) {
      // The gap: just past the column's edge, clear of every line of the stretch.
      const at = side === 'right' ? Math.max(x1, ...inside.flatMap(r => r.segments.filter(s => s.x0 < x1 - 1 && s.x0 >= x0 - 3).map(s => s.x1))) + 1 : x0 - 1;
      const beyond = s => (side === 'right' ? s.x0 >= at + size * 0.5 : s.x1 <= at - size * 0.5);
      const near = s => (side === 'right' ? s.x0 < at : s.x1 > at);
      if (inside.some(r => r.segments.some(s => near(s) && !(side === 'right' ? s.x1 <= at : s.x0 >= at)))) continue; // a line crosses it
      const other = inside.filter(r => r.segments.some(beyond));
      if (other.length < 3) continue;
      // Rows of the other side that share a baseline with a line of this column.
      const shared = other.filter(r => r.segments.some(s => !beyond(s) && near(s))).length;
      if (shared > other.length * 0.7) continue;
      return { x: side === 'right' ? at + size * 0.25 : at - size * 0.25, top, bottom };
    }
  }
  return null;
}

/**
 * Two tables printed side by side with the same column labels (a schedule of investments in two columns): a row of
 * labels whose second half repeats its first ("Security | Par | Value | Security | Par | Value"). Returns the gap
 * between the halves and the stretch below the labels, or null.
 */
function repeatedHeader(rows) {
  for (const [k, r] of rows.entries()) {
    const n = r.segments.length;
    if (n < 4 || n % 2 || r.segments.some(s => isValue(s.text))) continue;
    const key = s => s.text.toLowerCase().replace(/\s+/g, ' ');
    if (!r.segments.slice(0, n / 2).every((s, i) => key(s) === key(r.segments[n / 2 + i]))) continue;
    // Distinct labels in each half ("Security | Par | Value"), not one unit repeated over every column ("€'000").
    if (new Set(r.segments.slice(0, n / 2).map(key)).size < 2 || !r.segments.every(s => /\p{L}{2}/u.test(s.text))) continue;
    const a = r.segments[n / 2 - 1], b = r.segments[n / 2];
    // Each half starts a table of its own: words, not figures, start under its first label (the names of the second
    // table), unlike a group of value columns repeated under one header ("$ Change | % Change | $ Change | % Change").
    const below = rows.slice(k + 1, k + 8).flatMap(o => o.segments);
    if (!below.some(s => Math.abs(s.x0 - b.x0) <= 3 && /\p{L}{2}/u.test(s.text) && !isValue(s.text))) continue;
    return { x: (a.x1 + b.x0) / 2, top: r.top, bottom: Math.max(...rows.slice(k).map(o => o.base)) };
  }
  return null;
}

/**
 * Stream tables found region by region: a page's rows are split at the gap beside a column of running text (see
 * gutter()), so a table in one column never takes in the lines of the column next to it.
 */
function streamTablesOf(rows, depth = 0, hRules = []) {
  const cut = depth < 4 && (gutter(rows) || repeatedHeader(rows));
  if (!cut) {
    // Inside a column set apart from running text, only a table of figures or short entries counts: lines of prose cut
    // out of their page (a dictionary set in narrow columns) would otherwise line up into tables of words.
    const terse = t => { const cells = t.grid.flat().filter(Boolean); return cells.filter(isValue).length >= cells.length * 0.15 || median(cells.map(c => c.length)) <= 12; };
    const found = streamTables(rows, hRules).filter(t => !depth || terse(t));
    return { tables: found.map(t => ({ ...t, rowSet: new Set(rows.slice(t.first, t.last + 1)) })), rows };
  }
  const left = [], right = [], rest = [];
  for (const r of rows) {
    if (r.base < cut.top || r.top > cut.bottom) { rest.push(r); continue; }
    const l = r.segments.filter(s => s.x1 <= cut.x), rr = r.segments.filter(s => s.x1 > cut.x);
    if (l.length) left.push(rr.length ? { ...r, segments: l } : r);
    if (rr.length) right.push(l.length ? { ...r, segments: rr } : r);
  }
  const parts = [rest, left, right].map(part => streamTablesOf(part, depth + 1, hRules));
  return { tables: parts.flatMap(p => p.tables), rows: parts.flatMap(p => p.rows).sort((a, b) => a.base - b.base || a.segments[0].x0 - b.segments[0].x0) };
}

/**
 * The tables of one page, ruled ones first and then the ones found from aligned text, in page order.
 * @param {object[]} items  text items (pageItems in pdf-structure.js)
 * @param {{h, v}} [rules]  lines drawn on the page
 * @param {{stream?: boolean, pictures?: object[], claimed?: object[], fills?: object[]}} [options]  `stream: false` looks
 *   only for tables drawn with lines (recognized scans, whose word-by-word text would otherwise line up into false
 *   tables). `pictures`: pictures drawn as shapes {x, y, width, height}; text lined up over one isn't a table.
 *   `claimed`: regions {x, y, width, height} another reader owns (a chart's plot area, read or not): no table of either
 *   kind is found mostly inside one, and its text stays as it is. `fills`: filled rectangles {x0, y0, x1, y1}, whose
 *   edges inside a grid of lines separate its rows (withFillEdges).
 * @returns {{tables: {box, rows: string[][], header: boolean, headerRows: number, spans?: number[][], bold?: number[][],
 *   columns?, lines: string[], kind: 'ruled'|'stream'}[], rows: object[], allRows: object[]}}
 *   `spans` are [row, column, columns spanned]; `bold` are [row, column] cells set in bold. `rows` are the page's
 *   text rows that are not part of a table (their segments keep the items they were read from); `allRows` every row.
 */
export function pageTables(items, rules, { stream = true, pictures = [], claimed = [], fills = [] } = {}) {
  // Boxes that hold text rather than a table read as text.
  // (a frame around one or two lines of words, no figures: a form's header block or a box of labels, not a table)
  // (or two rows of words: a label row over a row of dates or codes, three or more columns each filled, is a table)
  const pair = rows => rows.length === 2 && rows[0].length >= 3 && rows.every(r => r.every(Boolean));
  const ruled = ruledTables(items, withFillEdges(rules, fills)).filter(t => !wordsNotTable(t.rows) && !layoutNotTable(t.rows) && !(t.rows.length <= 2 && !t.rows.flat().some(isValue) && !pair(t.rows))
    && !mostlyIn(t.box, claimed, 0.5));
  // A grid drawn around part of a table, the rest of its rows outside it on the left (on the same lines, lined up, for
  // most of its body rows): row labels there are its first column; figures there (the grid is the middle of a wider
  // table) leave the whole table to be read from the aligned text.
  for (let k = ruled.length - 1; k >= 0; k--) {
    const t = ruled[k], inside = new Set(t.items), body = t.rowY.slice(t.headerRows);
    if (body.length < 2) continue;
    const labels = t.rowY.map(([top, bottom]) => {
      const beside = items.filter(i => !inside.has(i) && i.text.trim() && i.x + i.width <= t.box.x0 + 2 && i.y + i.size * 0.5 >= top - 1 && i.y + i.size * 0.5 <= bottom + 1);
      const line = textRows(beside).at(-1)?.segments.at(-1);
      return line && line.text.length <= 40 && t.box.x0 - line.x1 <= Math.max(60, (t.box.x1 - t.box.x0) * 0.25) ? line : null;
    });
    const found = labels.slice(t.headerRows).filter(Boolean);
    if (found.length < body.length * 0.6) continue;
    if (found.filter(l => isDatum(l.text)).length >= found.length * 0.5) { ruled.splice(k, 1); continue; }
    if (found.filter(l => Math.abs(l.x0 - found[0].x0) <= 3).length < found.length * 0.8) continue;
    t.rows = t.rows.map((r, i) => [labels[i]?.text || '', ...r]);
    t.spans = t.spans.map(([r, c, n]) => [r, c + 1, n]);
    t.rowSpans = t.rowSpans.map(([r, c, n]) => [r, c + 1, n]);
    t.items = [...t.items, ...labels.filter(Boolean).flatMap(l => l.items || [])];
    t.box = { ...t.box, x0: round(Math.min(...found.map(l => l.x0))) };
    t.edges = null;
  }
  const taken = new Set(ruled.flatMap(t => t.items));
  const rest = ruled.length ? items.filter(i => !taken.has(i)) : items;
  let restRows = textRows(rest);
  for (const t of ruled) restRows = headerAbove(t, restRows);
  const found = stream ? streamTablesOf(restRows, 0, rules?.h || []) : { tables: [], rows: restRows };
  const rows = found.rows;
  const tables = ruled.map(t => ({ kind: 'ruled', box: t.box, rows: t.rows, header: t.header, headerRows: t.headerRows, ...(t.spans.length && { spans: t.spans }), ...(t.rowSpans.length && { rowSpans: t.rowSpans }), lines: t.rows.map(r => r.filter(Boolean).join(' | ')), boldTexts: t.boldTexts }));
  const streamed = [];
  for (const t of found.tables) {
    // Text lined up over a picture drawn as shapes (the values of donuts in a row, labels of icons) is the picture's.
    // (bands across the whole table, shading behind some of its rows, are not pictures it labels)
    const shown = pictures.filter(f => !(f.width >= (t.box.x1 - t.box.x0) * 0.6 && f.height < (t.box.bottom - t.box.top) * 0.34));
    if (mostlyIn(t.box, shown, 0.3) || mostlyIn(t.box, claimed, 0.5)) continue;
    const { rows: cells, header, headerRows, spans } = tidyGrid(t.grid, t.wide, t.geo);
    const rowSpans = fillDown(cells, headerRows, spans);
    if (layoutNotTable(cells)) continue; // its lines stay text
    streamed.push(t);
    if (cells.length && cells[0].length > 1) tables.push({ kind: 'stream', box: t.box, rows: cells, header, headerRows, ...(spans.length && { spans }), ...(rowSpans.length && { rowSpans }), columns: t.columns, lines: t.lines, rowSet: t.rowSet, boldTexts: t.boldTexts });
  }
  const inStream = new Set(streamed.flatMap(t => [...t.rowSet]));
  return { tables: tables.flatMap(sideBySide).map(withBoldCells).sort((a, b) => a.box.top - b.box.top || a.box.x0 - b.box.x0), rows: rows.filter(r => !inStream.has(r)), allRows: rows };
}

/**
 * Header lines printed just above a ruled table, outside its lines (a form's column labels over a ruled body): up to
 * three lines of labels, close above the table's top, each label within one of its columns, two or more columns named.
 * They become the table's header row (joined column by column) and leave `rows`, which is returned without them.
 */
function headerAbove(t, rows) {
  if (!t.edges || t.edges.length !== t.rows[0].length || t.edges.length < 2) return rows;
  const above = [];
  for (let k = rows.findLastIndex(r => r.base <= t.box.top + 2); k >= 0 && above.length < 3; k--) {
    const r = rows[k], next = above[0];
    const gap = (next ? next.top : t.box.top) - r.base;
    if (gap > r.size * 1.6 || gap < -2) break;
    // Each label within one column (a caption or title runs across several).
    if (r.segments.some(s => isValue(s.text) || !t.edges.some(([a, b]) => s.x0 >= a - 2 && s.x1 <= b + 2))) break;
    above.unshift(r);
  }
  if (!above.length) return rows;
  const head = t.edges.map(([a, b]) => above.flatMap(r => r.segments.filter(s => (s.x0 + s.x1) / 2 >= a && (s.x0 + s.x1) / 2 < b).map(s => s.text)).join(' '));
  if (head.filter(Boolean).length < 2) return rows;
  // The table's own first row was taken for its header only because it holds no figures; now it is a body row.
  const shift = ([r, ...rest]) => [r + 1, ...rest];
  t.rows = [head, ...t.rows];
  t.spans = t.spans.map(shift);
  t.rowSpans = t.rowSpans.map(shift);
  t.rowY = [[Math.min(...above.map(r => r.top)), t.box.top], ...t.rowY];
  t.headerRows = t.header && t.rows.slice(1).some(r => r.some(isValue)) ? t.headerRows + 1 : 1;
  t.header = true;
  t.box = { ...t.box, top: round(Math.min(...above.map(r => r.top))) };
  const used = new Set(above);
  return rows.filter(r => !used.has(r));
}

/** Whether at least `share` of a table box {x0, x1, top, bottom} lies within the regions {x, y, width, height}. */
function mostlyIn(box, regions, share) {
  if (!regions?.length) return false;
  const area = Math.max(1e-6, (box.x1 - box.x0) * (box.bottom - box.top));
  const covered = regions.reduce((n, f) => n + Math.max(0, Math.min(f.x + f.width, box.x1) - Math.max(f.x, box.x0)) * Math.max(0, Math.min(f.y + f.height, box.bottom) - Math.max(f.y, box.top)), 0);
  return covered >= area * share;
}

const allBold = items => items.length > 0 && items.every(i => i.bold || !i.text.trim());

/** Cells set in bold (header cells whose font is bold, a label column such as "To:" / "From:"), as [row, column] pairs in `bold`. */
function withBoldCells({ boldTexts, ...table }) {
  const bold = [];
  // (a header label joined from several lines is bold when each line was: every word of it is a word of a bold piece)
  const boldWords = new Set([...(boldTexts || [])].flatMap(t => t.split(/\s+/)));
  const joined = cell => cell.split(/\s+/).every(w => boldWords.has(w));
  table.rows.forEach((row, r) => row.forEach((cell, c) => { if (cell && (boldTexts?.has(cell) || (r < (table.headerRows || 0) && joined(cell)))) bold.push([r, c]); }));
  return bold.length ? { ...table, bold } : table;
}

/**
 * Tables printed side by side under one frame (a long list in several groups, "Code | Factor" repeated across the
 * page): when the header row repeats the same labels, each repeat is a table of its own.
 */
function sideBySide(table) {
  const head = table.rows[Math.max(0, (table.headerRows || 1) - 1)], width = head.length;
  if (!table.header || width < 4) return [table];
  for (let w = 1; w <= width / 2; w++) {
    if (width % w) continue;
    const label = head.slice(0, w).join('\u0001');
    if (!head.slice(0, w).every(Boolean)) continue;
    const groups = width / w;
    if (![...Array(groups).keys()].every(g => head.slice(g * w, g * w + w).join('\u0001') === label)) continue;
    const step = (table.box.x1 - table.box.x0) / groups;
    return [...Array(groups).keys()].map(g => {
      const sliced = table.rows.map(r => r.slice(g * w, g * w + w)), keep = sliced.map((r, i) => i).filter(i => sliced[i].some(Boolean) || i < table.headerRows);
      const rows = keep.map(i => sliced[i]), at = new Map(keep.map((r, i) => [r, i]));
      const spans = (table.spans || []).filter(([, c, n]) => c >= g * w && c + n <= g * w + w).map(([r, c, n]) => [r, c - g * w, n]);
      const rowSpans = (table.rowSpans || []).filter(([r, c]) => c >= g * w && c < g * w + w && at.has(r)).map(([r, c, n]) => [at.get(r), c - g * w, keep.filter(k => k >= r && k < r + n).length]).filter(([, , n]) => n > 1);
      return { ...table, rows, ...(spans.length ? { spans } : { spans: undefined }), ...(rowSpans.length ? { rowSpans } : { rowSpans: undefined }), columns: table.columns?.slice(g * w, g * w + w), box: { ...table.box, x0: round(table.box.x0 + g * step), x1: round(table.box.x0 + (g + 1) * step) }, lines: rows.map(r => r.filter(Boolean).join(' | ')) };
    });
  }
  return [table];
}

const sameColumns = (a, b) => a.length === b.length && a.every((c, i) => Math.abs(c - b[i]) <= 20);
const ROOM = 3; // running headers or footers allowed between a table and the page edge when joining pages

/**
 * Find the tables in a document's pages, joining a table that runs onto the next page.
 * @param {{page: number, items: object[], rules?: {h, v}, charts?: object[], claimed?: object[], fills?: object[]}[]} pages  text
 *   items (and drawn lines) per page, as pageItems returns them, and the charts read on the page (chart blocks from
 *   pdf-charts.js), which come out as tables too; `claimed` and `fills` as in pageTables
 * @returns {{tables: {pages: number[], rows: string[][], header: boolean, chart?: true, title?: string, parts: {page, top, bottom, x0, x1, lines: string[]}[]}[],
 *   layouts: {page: number, blocks: ({kind: 'text', text: string} | {kind: 'table', table: number, rows: string[][]})[]}[],
 *   emptyPages: number[]}}
 */
export function findTables(pages) {
  const tables = [], layouts = [], emptyPages = [];
  let previous = null; // last table of the previous page, with the rows that followed it
  for (const { page, items, rules, charts = [], claimed = [], fills = [] } of pages) {
    const { tables: found, allRows } = pageTables(items, rules, { claimed, fills });
    // (a header of several rows becomes one row naming each column in full: a sheet has one header row)
    // (and a cell merged down several rows is written in each of them: a sheet's rows are records)
    for (const t of found) t.rows = flatHeader({ ...t, rows: filledDown(t.rows, t.rowSpans) });
    for (const c of charts) found.push({ kind: 'chart', title: c.title, box: { x0: c.bbox[0], top: c.bbox[1], x1: c.bbox[0] + c.bbox[2], bottom: c.bbox[1] + c.bbox[3] }, rows: c.rows, header: true, headerRows: 1, lines: c.rows.map(r => r.filter(Boolean).join(' | ')) });
    found.sort((a, b) => a.box.top - b.box.top || a.box.x0 - b.box.x0);
    if (!allRows.length && !found.length) emptyPages.push(page);
    // Page text in order: rows outside tables, and each table where it starts.
    const entries = [
      ...allRows.filter(r => !found.some(t => t.kind === 'stream' && t.rowSet.has(r))).map(r => ({ top: r.top, text: r.segments.map(s => s.text).join(' ') })),
      ...found.map((t, n) => ({ top: t.box.top, table: n })),
    ].sort((a, b) => a.top - b.top);
    const blocks = [];
    const centres = t => t.rows[0].map((_, c) => c); // column count is what joins compare for ruled tables
    const signature = t => t.columns ? t.columns.map(c => (c.x0 + c.x1) / 2) : centres(t);
    entries.forEach((entry, position) => {
      if (entry.table === undefined) { blocks.push({ kind: 'text', text: entry.text }); return; }
      const t = found[entry.table];
      const before = position, after = entries.length - 1 - position;
      const joins = entry.table === 0 && t.kind !== 'chart' && previous && previous.page === page - 1 && previous.after <= ROOM && before <= ROOM
        && previous.width === t.rows[0].length && sameColumns(previous.signature, signature(t));
      let index;
      if (joins) {
        index = previous.index;
        const table = tables[index];
        // A header row repeated at the top of the continued table is dropped.
        const continued = t.rows[0].join('\u0001') === table.rows[0].join('\u0001') ? t.rows.slice(1) : t.rows;
        table.rows.push(...continued);
        table.pages.push(page);
        table.parts.push({ page, ...t.box, lines: t.lines });
      } else {
        index = tables.length;
        tables.push({ pages: [page], rows: t.rows.map(r => [...r]), header: t.header, ...(t.kind === 'chart' && { chart: true, ...(t.title && { title: t.title }) }), parts: [{ page, ...t.box, lines: t.lines }] });
      }
      blocks.push({ kind: 'table', table: index, rows: t.rows });
      if (entry.table === found.length - 1) previous = t.kind === 'chart' ? null : { page, index, width: t.rows[0].length, signature: signature(t), after };
    });
    if (!found.length) previous = null;
    layouts.push({ page, blocks });
  }
  return { tables, layouts, emptyPages };
}

// ---------------------------------------------------------------------------------------------- reading order

/**
 * Reading order of boxes on a page by recursive XY-cut. A region splits into columns at an empty vertical gap
 * (at least `gap` wide, running its full height) when both sides hold several lines, left part first; otherwise
 * at its widest empty horizontal band, top part first. So a title over two columns is read first, then the left
 * column, then the right one, and a label beside its value stays on its line.
 * @param {{x0, x1, top, bottom}[]} boxes
 * @returns {number[]} indices of `boxes` in reading order
 */
export function readingOrder(boxes, { gap = 12, rtl = false } = {}) {
  const order = [];
  // Top to bottom; pieces on one baseline (a label in another font beside its value) left to right (right to left on
  // a page written right to left, `rtl`, whose columns also read from the right).
  const byTop = list => [...list].sort((a, b) => (Math.abs(boxes[a].bottom - boxes[b].bottom) <= 1.5 && (boxes[a].x1 <= boxes[b].x0 || boxes[b].x1 <= boxes[a].x0) ? 0 : boxes[a].top - boxes[b].top) || (rtl ? boxes[b].x1 - boxes[a].x1 : boxes[a].x0 - boxes[b].x0));
  const cut = indices => {
    if (indices.length <= 2 || indices.length > 3000) { order.push(...byTop(indices)); return; }
    const xs = [...indices].sort((a, b) => boxes[a].x0 - boxes[b].x0);
    const vertical = widestGap(xs, i => boxes[i].x0, i => boxes[i].x1, gap);
    if (vertical !== null) {
      const left = indices.filter(i => boxes[i].x1 <= vertical), right = indices.filter(i => boxes[i].x0 >= vertical);
      if (columnsWorthSplitting(left, right, boxes)) { for (const side of rtl ? [right, left] : [left, right]) cut(side); return; }
    }
    if (byBands(indices)) return;
    const ys = byTop(indices);
    const horizontal = widestGap(ys, i => boxes[i].top, i => boxes[i].bottom, 0.01);
    if (horizontal === null) { order.push(...ys); return; }
    cut(ys.filter(i => boxes[i].bottom <= horizontal)); cut(ys.filter(i => boxes[i].bottom > horizontal));
  };
  // Columns that a few wide pieces (a heading or a line across both columns) keep from being cut apart: the columns are
  // found among the narrower pieces, and each wide piece is read where it starts, between the stretches
  // of columns above and below it. Returns false when there are no such columns.
  const byBands = indices => {
    const x0 = Math.min(...indices.map(i => boxes[i].x0)), x1 = Math.max(...indices.map(i => boxes[i].x1));
    const narrow = indices.filter(i => boxes[i].x1 - boxes[i].x0 < (x1 - x0) * 0.6);
    if (narrow.length < 4 || narrow.length === indices.length || indices.length - narrow.length > narrow.length / 2) return false;
    const xs = [...narrow].sort((a, b) => boxes[a].x0 - boxes[b].x0);
    const vertical = widestGap(xs, i => boxes[i].x0, i => boxes[i].x1, gap);
    if (vertical === null) return false;
    const left = narrow.filter(i => boxes[i].x1 <= vertical), right = narrow.filter(i => boxes[i].x0 >= vertical);
    if (!columnsWorthSplitting(left, right, boxes)) return false;
    let rest = narrow;
    for (const w of byTop(indices.filter(i => !narrow.includes(i)))) {
      const band = rest.filter(i => boxes[i].top < boxes[w].top);
      rest = rest.filter(i => boxes[i].top >= boxes[w].top);
      if (band.length) cut(band);
      order.push(w);
    }
    if (rest.length) cut(rest);
    return true;
  };
  cut(boxes.map((_, i) => i));
  return order;
}

/** The middle of the widest gap (at least `min`) between intervals sorted by start, or null. */
function widestGap(sorted, start, end, min) {
  let reach = end(sorted[0]), best = null, width = min;
  for (let k = 1; k < sorted.length; k++) {
    const s = start(sorted[k]);
    if (s - reach >= width) { width = s - reach; best = (s + reach) / 2; }
    reach = Math.max(reach, end(sorted[k]));
  }
  return best;
}

/**
 * Whether a vertical cut is a real column break: each side holds boxes stacked one above the other, over much the
 * same height. Otherwise (a label beside its value, a heading beside a page number) the region is read in bands.
 */
function columnsWorthSplitting(left, right, boxes) {
  const extent = side => [Math.min(...side.map(i => boxes[i].top)), Math.max(...side.map(i => boxes[i].bottom))];
  const stacked = side => side.length >= 2 && extent(side)[1] - extent(side)[0] > 1.8 * median(side.map(i => boxes[i].bottom - boxes[i].top));
  if (!stacked(left) || !stacked(right)) return false;
  // Labels ending in a colon, each level with the start of its value on the right, are a list of pairs read row by row.
  const labels = left.filter(i => boxes[i].label);
  if (labels.length >= 2 && labels.length >= left.length * 0.5 && labels.filter(i => right.some(j => Math.abs(boxes[j].bottom - boxes[i].bottom) <= 2)).length >= labels.length * 0.6) return false;
  // Columns run alongside each other. When one side reaches well above or below the other (a heading and list under
  // a short two-column passage), the region is read in bands first.
  const [a, b] = [extent(left), extent(right)];
  return Math.min(a[1], b[1]) - Math.max(a[0], b[0]) >= 0.5 * (Math.max(a[1], b[1]) - Math.min(a[0], b[0]));
}

// ---------------------------------------------------------------------------------------------- pictures drawn as shapes

/**
 * Pictures drawn as shapes rather than placed as images (charts, diagrams, icons, logos): the painted shapes of a page
 * (`marks`, boxes from pageItems) that touch each other, gathered into regions, with the short labels inside or on
 * their edge. Left out: page and panel backgrounds, rules and underlines, shading behind text (table rows, boxes of
 * text), and anything inside `avoid` (tables, charts read as data, images).
 * @param {{x0, y0, x1, y1, rect: boolean, curved: boolean, light: boolean}[]} marks
 * @returns {{x: number, y: number, width: number, height: number}[]}
 */
export function figureRegions(marks, items, { width, height }, avoid = []) {
  if (!marks?.length) return [];
  const size = median(items.map(i => i.size)) || 10, area = width * height, CELL = 36, pad = 3;
  // Text by band of the page, to find what lies inside a shape quickly.
  const bands = new Map();
  for (const i of items) { const k = Math.floor((i.y + i.size * 0.6) / CELL); if (!bands.has(k)) bands.set(k, []); bands.get(k).push(i); }
  const textIn = m => {
    const out = [];
    for (let k = Math.floor(m.y0 / CELL); k <= Math.floor(m.y1 / CELL); k++) for (const i of bands.get(k) || []) {
      const cx = i.x + i.width / 2, cy = i.y + i.size * 0.6;
      if (cx > m.x0 && cx < m.x1 && cy > m.y0 && cy < m.y1 && i.text.trim()) out.push(i);
    }
    return out;
  };
  // Whether a word's middle lies between y0 and y1 with the word reaching into x0..x1.
  const wordAcross = (y0, y1, x0, x1) => {
    for (let k = Math.floor(y0 / CELL); k <= Math.floor(y1 / CELL); k++) for (const i of bands.get(k) || []) {
      const cy = i.y + i.size * 0.6;
      if (cy > y0 && cy < y1 && i.x < x1 && i.x + i.width > x0 && i.text.trim()) return true;
    }
    return false;
  };
  const kept = [], pale = [];
  for (const m of marks) {
    const w = m.x1 - m.x0, h = m.y1 - m.y0;
    if (w * h > area * 0.25 || w > width * 0.9 || h > height * 0.9) continue; // backgrounds
    if (!m.curved && (w <= 3 || h <= 3)) continue; // rules, underlines, the lines of tables
    if (w * h >= size * size) {
      const text = textIn(m);
      // Shading behind text: a band as high as a line or two (table rows), a light panel, or a box holding a phrase.
      if (text.length && (h <= size * 2.6 || m.light || text.reduce((n, i) => n + i.text.trim().split(/\s+/).length, 0) >= 4)) continue;
    }
    // Near-white rectangles (a table's cell backgrounds, a pale panel) join no picture by themselves; one can only widen
    // the picture it lies under (the pale track of a progress bar), below.
    if (m.rect && m.light && !m.stroked) { pale.push(m); continue; }
    kept.push(m);
  }
  if (!kept.length) return [];
  // Shapes that touch (within a few points) are one picture: union-find over a grid of cells.
  const parent = kept.map((_, i) => i), find = i => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const grid = new Map();
  kept.forEach((m, i) => {
    for (let gx = Math.floor((m.x0 - pad) / CELL); gx <= Math.floor((m.x1 + pad) / CELL); gx++) for (let gy = Math.floor((m.y0 - pad) / CELL); gy <= Math.floor((m.y1 + pad) / CELL); gy++) {
      const key = gx * 100003 + gy, cell = grid.get(key);
      if (!cell) { grid.set(key, [i]); continue; }
      for (const j of cell) {
        const o = kept[j];
        if (m.x0 - pad <= o.x1 && o.x0 - pad <= m.x1 && m.y0 - pad <= o.y1 && o.y0 - pad <= m.y1) parent[find(i)] = find(j);
      }
      if (cell.length < 64) cell.push(i);
    }
  });
  // Bars of a chart drawn apart from each other: filled rectangles standing on one baseline (or, for bars across, starting
  // from one edge), each within a few bar widths of the next, are one picture.
  const bars = kept.map((m, i) => i).filter(i => kept[i].rect && !kept[i].stroked && kept[i].x1 - kept[i].x0 >= 2 && kept[i].y1 - kept[i].y0 >= 2);
  for (const standing of [true, false]) {
    const [edge, from, to, across] = standing ? [m => m.y1, m => m.x0, m => m.x1, m => m.x1 - m.x0] : [m => m.x0, m => m.y0, m => m.y1, m => m.y1 - m.y0];
    const rows = new Map();
    for (const i of bars) { const k = Math.round(edge(kept[i])); if (!rows.has(k)) rows.set(k, []); rows.get(k).push(i); }
    for (const [k, row] of rows) {
      const list = [...row, ...(rows.get(k + 1) || [])].sort((a, b) => from(kept[a]) - from(kept[b]));
      for (let n = 1; n < list.length; n++) {
        const a = kept[list[n - 1]], b = kept[list[n]], gap = from(b) - to(a), most = Math.max(across(a), across(b));
        if (!(gap > 0 && gap <= most * 2.5 && Math.abs(across(a) - across(b)) <= most * 0.5)) continue;
        // (Not with words between them: bars with labels of their own between are charts of their own.)
        // (Between bars across, a label set over the next bar may start to the left of it: any word reaching in counts.)
        if (standing ? textIn({ x0: a.x1, x1: b.x0, y0: Math.min(a.y0, b.y0), y1: a.y1 }).length
          : wordAcross(a.y1, b.y0, Math.min(a.x0, b.x0), Math.max(a.x1, b.x1))) continue;
        parent[find(list[n])] = find(list[n - 1]);
      }
    }
  }
  const groups = new Map();
  kept.forEach((m, i) => {
    const r = find(i);
    const g = groups.get(r) || { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity, n: 0, curved: false };
    g.x0 = Math.min(g.x0, m.x0); g.y0 = Math.min(g.y0, m.y0); g.x1 = Math.max(g.x1, m.x1); g.y1 = Math.max(g.y1, m.y1); g.n++; g.curved ||= m.curved;
    groups.set(r, g);
  });
  // A pale rectangle that touches exactly one picture, and is not many times its size, is part of it.
  const touches = (m, g) => m.x0 - pad <= g.x1 && g.x0 - pad <= m.x1 && m.y0 - pad <= g.y1 && g.y0 - pad <= m.y1;
  if (pale.length <= 500) for (const m of pale) {
    const hit = [...groups.values()].filter(g => touches(m, g));
    const [g] = hit;
    if (hit.length !== 1 || (m.x1 - m.x0) * (m.y1 - m.y0) > (g.x1 - g.x0) * (g.y1 - g.y0) * 6) continue;
    g.x0 = Math.min(g.x0, m.x0); g.y0 = Math.min(g.y0, m.y0); g.x1 = Math.max(g.x1, m.x1); g.y1 = Math.max(g.y1, m.y1); g.n++;
  }
  const covered = (g, b) => Math.max(0, Math.min(g.x1, b.x1) - Math.max(g.x0, b.x0)) * Math.max(0, Math.min(g.y1, b.y1) - Math.max(g.y0, b.y0));
  let regions = [...groups.values()].filter(g => {
    const w = g.x1 - g.x0, h = g.y1 - g.y0;
    if (Math.max(w, h) < 14 || Math.min(w, h) < 6 || (!g.curved && g.n < 2)) return false;
    return !avoid.some(b => covered(g, b) >= w * h * 0.5);
  });
  // The short labels inside a picture or on its edge (a value in a donut, the name under an icon, axis labels).
  // (Numbers, a chart's values and years ("2025 target"), a little farther out than words; none that reaches another picture.)
  const shapes = regions.map(g => ({ ...g })), touch = (a, b) => a.x0 <= b.x1 + pad && b.x0 <= a.x1 + pad && a.y0 <= b.y1 + pad && b.y0 <= a.y1 + pad;
  for (const [n, g] of regions.entries()) {
    const near = (i, k) => i.x < g.x1 + size * k && i.x + i.width > g.x0 - size * k && i.y < g.y1 + size * k && i.y + i.size > g.y0 - size * k;
    const reach = (i, k) => i.x + i.width / 2 > g.x0 - size * k && i.x + i.width / 2 < g.x1 + size * k && i.y + i.size * 0.6 > g.y0 - size * k && i.y + i.size * 0.6 < g.y1 + size * k;
    const e = { x0: g.x0 - size * 4, y0: g.y0 - size * 2.5, x1: g.x1 + size * 4, y1: g.y1 + size * 2.5 };
    const numeric = i => /^[\d\s.,%$€£¥+\-–−]+$/u.test(i.text.trim()) || (/\d/.test(i.text) && i.text.trim().split(/\s+/).length <= 2);
    for (const i of textIn(e)) if (i.text.trim().split(/\s+/).length <= 4 && i.width <= (g.x1 - g.x0) * 1.5 && (reach(i, 0.8) || (numeric(i) && near(i, 1.5)))
      && !shapes.some((o, m) => m !== n && !touch(o, shapes[n]) && i.x < o.x1 && i.x + i.width > o.x0 && i.y < o.y1 && i.y + i.size > o.y0)) {
      g.x0 = Math.min(g.x0, i.x); g.y0 = Math.min(g.y0, i.y); g.x1 = Math.max(g.x1, i.x + i.width); g.y1 = Math.max(g.y1, i.y + i.size);
    }
  }
  // Regions that now overlap are one picture.
  for (let changed = true; changed;) {
    changed = false;
    for (let a = 0; a < regions.length && !changed; a++) for (let b = a + 1; b < regions.length; b++) {
      if (covered(regions[a], regions[b]) > 0) {
        const r = regions[a], o = regions[b];
        regions[a] = { x0: Math.min(r.x0, o.x0), y0: Math.min(r.y0, o.y0), x1: Math.max(r.x1, o.x1), y1: Math.max(r.y1, o.y1) };
        regions.splice(b, 1); changed = true; break;
      }
    }
  }
  regions = regions.filter(g => !avoid.some(b => covered(g, b) >= (g.x1 - g.x0) * (g.y1 - g.y0) * 0.5));
  return regions.sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0).map(g => ({ x: round(g.x0), y: round(g.y0), width: round(g.x1 - g.x0), height: round(g.y1 - g.y0) }));
}

/**
 * The pictures of a page as a reader sees them: images and pictures drawn as shapes, with those that overlap taken as
 * one, and small ones set close together with no running text between them (a wall of logos, a row of icons drawn as
 * pieces, none with words of its own beside it, on one panel) taken as one picture. `panels` are filled boxes
 * ({x0, y0, x1, y1}) set behind pictures. `lines` are the page's text lines ({x, y, width, height, text}); text between two
 * pictures keeps them apart. In the spirit of PDFFigures 2.0's figure regions grown over nearby
 * graphics (Clark and Divvala, 2016; Apache-2.0; idea only).
 * @param {{x, y, width, height}[]} pieces
 * @returns {{x, y, width, height}[]}
 */
export function pictureGroups(pieces, lines, { width, height }, body = 10, panels = []) {
  let boxes = pieces.filter(p => p.width > 0 && p.height > 0).map(p => ({ x0: p.x, y0: p.y, x1: p.x + p.width, y1: p.y + p.height }));
  if (boxes.length < 2 || boxes.length > 150) return boxes.map(toPicture);
  const small = b => b.x1 - b.x0 <= width * 0.2 && b.y1 - b.y0 <= height * 0.2;
  const reach = Math.min(60, body * 5);
  const blockers = lines.filter(l => /[\p{L}\p{N}]/u.test(l.text)).map(l => ({ x0: l.x, y0: l.y, x1: l.x + l.width, y1: l.y + l.height }));
  const inside = (l, b) => { const cx = (l.x0 + l.x1) / 2, cy = (l.y0 + l.y1) / 2; return cx > b.x0 && cx < b.x1 && cy > b.y0 && cy < b.y1; };
  const gap = (a, b) => Math.max(0, Math.max(a.x0, b.x0) - Math.min(a.x1, b.x1), Math.max(a.y0, b.y0) - Math.min(a.y1, b.y1));
  const join = (a, b) => ({ x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1), small: a.small && b.small });
  // A picture with words of its own set close beside it (a portrait over its name, an icon by its label) stands alone.
  const near = body * 1.5;
  const labelled = b => blockers.some(l => !inside(l, b) && ((Math.min(l.x1, b.x1) - Math.max(l.x0, b.x0) > 0 && Math.max(l.y0 - b.y1, b.y0 - l.y1) <= near)
    || (Math.min(l.y1, b.y1) - Math.max(l.y0, b.y0) > 0 && Math.max(l.x0 - b.x1, b.x0 - l.x1) <= near)));
  boxes.forEach(b => { b.small = small(b) && !labelled(b); });
  const area = b => (b.x1 - b.x0) * (b.y1 - b.y0);
  for (let changed = true; changed;) {
    changed = false;
    for (let a = 0; a < boxes.length && !changed; a++) for (let b = a + 1; b < boxes.length; b++) {
      const A = boxes[a], B = boxes[b], g = gap(A, B);
      const overlapping = Math.min(A.x1, B.x1) > Math.max(A.x0, B.x0) && Math.min(A.y1, B.y1) > Math.max(A.y0, B.y0);
      // (Pictures that overlap are one when of about one size; a small one over a large one is kept as well.)
      if (overlapping ? Math.max(area(A), area(B)) > Math.min(area(A), area(B)) * 4 : !(A.small && B.small && g <= reach)) continue;
      // (Nor are pictures on different panels, filled boxes set behind them.)
      const holds = (p, b) => { const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2; return cx > p.x0 && cx < p.x1 && cy > p.y0 && cy < p.y1; };
      if (!overlapping && panels.some(p => holds(p, A) !== holds(p, B))) continue;
      const u = join(A, B);
      if (!overlapping && (blockers.some(l => inside(l, u) && !inside(l, A) && !inside(l, B)) || (u.x1 - u.x0) * (u.y1 - u.y0) > width * height * 0.5)) continue;
      boxes[a] = u; boxes.splice(b, 1); changed = true; break;
    }
  }
  return boxes.map(toPicture);
}
const toPicture = b => ({ x: round(b.x0), y: round(b.y0), width: round(b.x1 - b.x0), height: round(b.y1 - b.y0) });
