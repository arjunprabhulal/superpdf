// Text a page holds that PDF.js's text layer leaves out or breaks, fixed before layout (pdf-structure.js):
//   - values typed into form fields (AcroForm widgets), which live in annotations, not in the page's text;
//   - ligatures and soft hyphens (ﬁ → fi; a soft hyphen inside a word is dropped, at a line end it breaks the word);
//   - word spaces PDF.js sets as items of their own that layout would drop (a space narrower than a word gap);
//   - spaces PDF.js puts in that aren't word spaces: letter-spaced words ("P a g e") and gaps beside Chinese and
//     Japanese characters, measured on the glyphs drawn (respaceItems);
//   - figures and Latin words inside right-to-left lines (bidiRuns);
// and, for joining the lines of a paragraph, words broken at a line end and scripts written without spaces between
// words (Chinese, Japanese, Thai), whose lines join with no space. Pure functions over text items as pageItems makes
// them ({ text, x, y, width, size, ... }, top-left page points); none of them throws on odd input.

// Ligatures, and the one-dot leader some fonts map their full stop to ("열람․발급" is "열람.발급").
const LIGATURES = { '\uFB00': 'ff', '\uFB01': 'fi', '\uFB02': 'fl', '\uFB03': 'ffi', '\uFB04': 'ffl', '\uFB05': 'st', '\uFB06': 'st', '\u2024': '.' };
const SOFT_HYPHEN = '\u00AD';

/** Text with ligatures spelled out and soft hyphens gone, except one ending the text (a word broken there): "-". */
export function plainLetters(text) {
  if (typeof text !== 'string') return '';
  const out = text.replace(/[\uFB00-\uFB06\u2024]/g, c => LIGATURES[c]);
  if (!out.includes(SOFT_HYPHEN)) return out;
  const end = /\u00AD\s*$/.test(out);
  const kept = out.replace(/\u00AD/g, '');
  return end ? kept.replace(/\s*$/, '-') : kept;
}

const LETTER = /[\p{L}\p{N}]/u;
const finite = (...values) => values.every(Number.isFinite);

/**
 * Word spaces set as items of their own (" ") between two words on a line where the gap is too narrow to read as a
 * space: the word before keeps the space, so its line reads "for AI", not "forAI". Changes `items` in place.
 */
export function keepWordSpaces(items) {
  if (!Array.isArray(items)) return items;
  for (let k = 1; k + 1 < items.length; k++) {
    const [a, s, b] = [items[k - 1], items[k], items[k + 1]];
    if (!a || !s || !b || typeof s.text !== 'string' || s.text.trim() || s.text === '') continue;
    if (typeof a.text !== 'string' || typeof b.text !== 'string' || !finite(a.x, a.y, a.width, a.size, b.x, b.y)) continue;
    if (!LETTER.test(a.text.at(-1) || '') || !LETTER.test(b.text[0] || '')) continue;
    if (Math.abs(a.y - b.y) > a.size * 0.3 || a.angle || b.angle) continue;
    const gap = b.x - (a.x + a.width);
    if (gap > -a.size * 0.2 && gap < a.size * 0.2) a.text += ' ';
  }
  return items;
}

const SYLLABLE = /^[\p{scx=Hangul}\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}]$/u;
const SIGNS = /^[^\p{L}\p{N}]+$/u;

/**
 * Korean, Chinese or Japanese set with wide letter spacing, which PDF.js reads with a space after every character
 * ("거 래 처 가 간 이 , 일 반"): the spaces between characters and before signs go ("거래처가간이, 일반"); word spaces
 * between items stay. Only text of single characters, four at least, so a few one-syllable words ("그 외") stay.
 */
export function unspaceLetters(text) {
  if (typeof text !== 'string' || text.length < 7) return text;
  const lead = text.match(/^\s*/)[0], trail = text.match(/\s*$/)[0], tokens = text.trim().split(' ');
  const single = tokens.filter(t => SYLLABLE.test(t)).length;
  if (single < 4 || single < tokens.length * 0.75 || tokens.some(t => !SYLLABLE.test(t) && !SIGNS.test(t))) return text;
  let out = tokens[0];
  for (let k = 1; k < tokens.length; k++) out += (SYLLABLE.test(tokens[k]) && !SIGNS.test(tokens[k - 1])) || SIGNS.test(tokens[k]) ? tokens[k] : ` ${tokens[k]}`;
  return lead + out + trail;
}

/** Text items with their letters made plain and lost word spaces kept (see plainLetters, keepWordSpaces). */
export function fixItems(items) {
  if (!Array.isArray(items)) return [];
  for (const item of items) if (item && typeof item.text === 'string' && /[\uFB00-\uFB06\u00AD\u2024]/.test(item.text)) item.text = plainLetters(item.text);
  for (const item of items) if (item && typeof item.text === 'string' && item.text.includes(' ')) item.text = unspaceLetters(item.text);
  return keepWordSpaces(items);
}

// ------------------------------------------------------------------------------------------------- form fields

const CHECKED = '☒';
const HIDDEN_FLAGS = 2 | 32; // annotation flags Hidden and NoView
const PASSWORD_FLAG = 1 << 13;

/** What a form field shows: its text, the chosen options, or a mark for a ticked box or chosen radio button. */
export function fieldText(a) {
  if (!a || typeof a !== 'object') return '';
  if (a.fieldType === 'Tx') return a.password || (a.fieldFlags & PASSWORD_FLAG) ? '' : typeof a.fieldValue === 'string' ? a.fieldValue : '';
  if (a.fieldType === 'Btn') {
    if (a.pushButton) return '';
    const v = a.fieldValue;
    if (v == null || v === '' || v === 'Off') return '';
    if (a.radioButton) return a.buttonValue != null && v === a.buttonValue ? CHECKED : '';
    return a.checkBox ? CHECKED : '';
  }
  if (a.fieldType === 'Ch') {
    const chosen = (Array.isArray(a.fieldValue) ? a.fieldValue : [a.fieldValue]).filter(v => typeof v === 'string' && v.trim());
    const shown = v => (Array.isArray(a.options) ? a.options.find(o => o?.exportValue === v)?.displayValue : null) || v;
    return chosen.map(shown).filter(v => typeof v === 'string').join(', ');
  }
  return '';
}

/** A field's rectangle in top-left page points [x0, y0, x1, y1], or null. */
function fieldBox(a, viewport) {
  const r = a.rect;
  if (!Array.isArray(r) || r.length !== 4 || !finite(...r)) return null;
  let box;
  try { box = viewport?.convertToViewportRectangle ? viewport.convertToViewportRectangle(r) : [r[0], r[1], r[2], r[3]]; } catch { return null; }
  if (!Array.isArray(box) || !finite(...box)) return null;
  const [x0, x1] = [Math.min(box[0], box[2]), Math.max(box[0], box[2])], [y0, y1] = [Math.min(box[1], box[3]), Math.max(box[1], box[3])];
  return x1 - x0 >= 1 && y1 - y0 >= 1 ? [x0, y0, x1, y1] : null;
}

/** Whether the page's own text already shows this value inside the box (a form flattened with its fields left on). */
function printed(items, [x0, y0, x1, y1], text) {
  const probe = text.trim().slice(0, 12);
  return items.some(i => i && typeof i.text === 'string' && i.text.trim() && finite(i.x, i.y, i.width, i.size)
    && i.x + i.width / 2 >= x0 && i.x + i.width / 2 <= x1 && i.y + i.size / 2 >= y0 && i.y + i.size / 2 <= y1
    && (i.text.includes(probe) || probe.includes(i.text.trim())));
}

/**
 * Text items for the values of the page's filled form fields (PDF.js annotations), placed in their boxes: one item
 * per line of a field's text, at the field's font size (or one that fits the box). Empty fields, hidden ones,
 * password fields, push buttons and values the page already prints are left out.
 */
export function formFieldItems(annotations, viewport, items = []) {
  if (!Array.isArray(annotations)) return [];
  const out = [];
  for (const a of annotations) {
    if (!a || a.subtype !== 'Widget' || a.hidden || (a.annotationFlags & HIDDEN_FLAGS)) continue;
    const text = fieldText(a).replace(/\r\n?/g, '\n');
    if (!text.trim()) continue;
    const box = fieldBox(a, viewport);
    if (!box || printed(items, box, text)) continue;
    out.push(...fieldLines(a, box, text));
  }
  return out;
}

/** One field's text as items, line under line from the top of its box (a single line sits in the box's middle). */
function fieldLines(a, [x0, y0, x1, y1], text) {
  const lines = text.split('\n').map(l => l.replace(/\s+$/, '')).filter(l => l.trim()).slice(0, 200);
  const height = y1 - y0, set = Number(a.defaultAppearanceData?.fontSize);
  const size = Math.min(24, Math.max(4, set > 0 ? set : lines.length > 1 ? Math.min(10, height / lines.length) : Math.min(12, height * 0.7)));
  const top = lines.length > 1 ? y0 + 2 : y0 + Math.max(0, (height - size) / 2);
  return lines.map((line, k) => {
    const width = Math.min(x1 - x0, line.length * size * 0.5);
    const x = a.textAlignment === 1 ? (x0 + x1 - width) / 2 : a.textAlignment === 2 ? x1 - 2 - width : x0 + Math.min(2, (x1 - x0 - width) / 2);
    return { text: plainLetters(line), x, y: top + k * size * 1.15, width, size, font: '', weight: 400, bold: false, italic: false, formField: true };
  });
}

// --------------------------------------------------------------------------------------- right-to-left ligatures

const RTL_LETTERS = /^[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Syriac}\p{Script=Thaana}\p{M}]+$/u;
const RTL_TEXT = /[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Syriac}\p{Script=Thaana}]/u;

/**
 * Words of right-to-left text that PDF.js spells wrongly, from the glyphs a page draws (`glyphRuns`: the glyphs of
 * each text-showing operation, in drawing order, each with its `unicode`): a ligature glyph that stands for two
 * letters (Arabic lam-alef, "لا") comes out with its letters swapped when PDF.js turns the line around ("ال"), so
 * "الاتصالات" reads "االتصاالت". Returns a Map from each word as PDF.js spells it to the word as written.
 */
export function ligatureWords(glyphRuns) {
  const words = new Map();
  if (!Array.isArray(glyphRuns)) return words;
  // A word drawn in pieces (a ligature shown on its own) is read across operations too.
  for (const run of [...glyphRuns, glyphRuns.flatMap(r => (Array.isArray(r) ? r : []))]) {
    if (!Array.isArray(run)) continue;
    let word = [];
    const flush = () => {
      const parts = word.map(g => g.unicode);
      word = [];
      if (!parts.some(u => [...u].length > 1)) return;
      const right = [...parts].reverse().join('');
      if (!RTL_LETTERS.test(right)) return;
      const read = [...parts.join('')].reverse().join('');
      if (read !== right) words.set(read, right);
    };
    for (const g of run) {
      if (!g || typeof g !== 'object' || typeof g.unicode !== 'string') continue;
      if (/^[\p{L}\p{M}]+$/u.test(g.unicode)) word.push(g); else flush(); // spaces, digits and signs end a word
    }
    flush();
  }
  return words;
}

/** Text items with the misspelt right-to-left words (ligatureWords) written as on the page. Changes them in place. */
export function fixLigatureWords(items, words) {
  if (!Array.isArray(items) || !(words instanceof Map) || !words.size) return items;
  for (const item of items) {
    if (!item || typeof item.text !== 'string' || !RTL_TEXT.test(item.text)) continue;
    item.text = item.text.replace(/[\p{L}\p{M}]+/gu, w => words.get(w) ?? w);
  }
  return items;
}

const RTL_CHAR = /[\u0590-\u05FF\u0600-\u06FF\u0700-\u074F\u0750-\u077F\u08A0-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/u;
const leftToRight = i => typeof i?.text === 'string' && !RTL_CHAR.test(i.text) && /[\p{L}\p{N}]/u.test(i.text);
const neutral = i => typeof i?.text !== 'string' || !/[\p{L}\p{N}]/u.test(i.text);

/**
 * Text items of a right-to-left line, in reading order from its right end (`parts`, sorted so), with each run of
 * figures and Latin words (and the signs between them) turned back to read left to right, as the Unicode
 * bidirectional algorithm reads them ("04" "." "2022" set right to left is "04.2022", not "2022.04").
 */
export function bidiRuns(parts) {
  const out = [];
  if (!Array.isArray(parts)) return out;
  for (let k = 0; k < parts.length;) {
    if (!leftToRight(parts[k])) { out.push(parts[k++]); continue; }
    let end = k;
    for (let j = k + 1; j < parts.length && (leftToRight(parts[j]) || neutral(parts[j])); j++) if (leftToRight(parts[j])) end = j;
    out.push(...parts.slice(k, end + 1).reverse());
    k = end + 1;
  }
  return out;
}

/** Whether most letters of these text items are in a right-to-left script (Hebrew, Arabic). */
export function rightToLeftItems(items) {
  let rtl = 0, all = 0;
  for (const i of items || []) {
    if (typeof i?.text !== 'string') continue;
    for (const c of i.text) if (/\p{L}/u.test(c)) { all++; if (RTL_CHAR.test(c)) rtl++; }
  }
  return rtl > all / 2;
}

/** The glyphs of each text-showing operation of a page's operator list (PDF.js), for ligatureWords. */
function glyphRuns(ops, showText) {
  const runs = [];
  for (let k = 0; k < (ops?.fnArray?.length || 0); k++) if (ops.fnArray[k] === showText && Array.isArray(ops.argsArray[k]?.[0])) runs.push(ops.argsArray[k][0]);
  return runs;
}

/**
 * The page's text items fixed (fixItems, and right-to-left words read from the glyphs drawn) plus its filled form
 * fields' values (formFieldItems). Never throws: a page whose annotations or drawing can't be read keeps its own text.
 */
export async function fixPageText(page, viewport, items, pdfjs) {
  const fixed = fixItems(items);
  if (pdfjs?.OPS && fixed.some(i => typeof i?.text === 'string' && RTL_TEXT.test(i.text))) {
    try { fixLigatureWords(fixed, ligatureWords(glyphRuns(await page.getOperatorList(), pdfjs.OPS.showText))); } catch { /* text as read */ }
  }
  let annotations = [];
  try { annotations = await page.getAnnotations({ intent: 'display' }); } catch { /* no fields read */ }
  return [...fixed, ...formFieldItems(annotations, viewport, fixed)];
}

const placeKey = i => `${Math.round(i.x * 10)},${Math.round(i.y * 10)},${Math.round(i.width * 10)}`;

/**
 * Items read again (fonts loaded later) keep the fixes of the first reading: the text an item at the same place had,
 * and the form fields' values.
 */
export function rereadItems(previous, fresh) {
  const before = Array.isArray(previous) ? previous : [];
  const texts = new Map(before.filter(i => i && !i.formField && typeof i.text === 'string' && finite(i.x, i.y, i.width)).map(i => [placeKey(i), i.text]));
  const fixed = fixItems(fresh);
  for (const item of fixed) if (item && finite(item.x, item.y, item.width) && texts.has(placeKey(item))) item.text = texts.get(placeKey(item));
  return [...fixed, ...before.filter(i => i?.formField)];
}

// ---------------------------------------------------------------------------------------------- line joins

// Scripts written without spaces between words (and their punctuation): a line break there is not a space.
const UNSPACED = /[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}\p{scx=Thai}\p{scx=Lao}\p{scx=Khmer}\p{scx=Myanmar}\u3000-\u303F\u30FC\uFF01-\uFF0F\uFF1A-\uFF1F\uFF5B-\uFF65]$/u;
// The last word of a line is a web address cut after a separator (not after a full stop, which may end a sentence).
const URL_BROKEN = /(?:^|\s)<?(?:https?:\/\/|www\.)\S*[/\-_=&?#%~]\s*$/iu;
const UNSPACED_START =/^[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}\p{scx=Thai}\p{scx=Lao}\p{scx=Khmer}\p{scx=Myanmar}\u3000-\u303F\u30FC\uFF01-\uFF0F\uFF1A-\uFF1F\uFF5B-\uFF65]/u;

/**
 * The end of a paragraph's line as it joins the next one (`next`): a word broken by a hyphen at the line end joins
 * up ("infor-" + "mation"); after a capital or a digit the hyphen is the word's own ("COVID-" + "19", "QR-" + "code")
 * and stays, with no space; lines of Chinese, Japanese or Thai join with no space; any other line ends in a space.
 */
export function lineEnd(text, next) {
  const end = String(text ?? ''), start = String(next ?? '').trimStart();
  // A web address broken after one of its separators ("…/news/2014-02-27/stream-" + "bank-damage…") carries on.
  if (URL_BROKEN.test(end) && /^[\w%~#/-]/u.test(start)) return end.replace(/\s+$/, '');
  if (/\p{Ll}[-\u2010]\s*$/u.test(end) && /^\p{Ll}/u.test(start)) return end.replace(/[-\u2010]\s*$/u, '');
  if (/[\p{Lu}\p{N}][-\u2010]\s*$/u.test(end) && /^\p{L}/u.test(start)) return end.replace(/\s*$/, '');
  if (UNSPACED.test(end) && UNSPACED_START.test(start)) return end;
  return /\s$/.test(end) || !end ? end : `${end} `;
}

/** Lines of a paragraph as one text, joined as lineEnd says. */
export function joinWrapped(lines) {
  if (!Array.isArray(lines)) return '';
  let out = '';
  for (const line of lines) {
    const text = String(line ?? '');
    out = out ? lineEnd(out, text) + text.trimStart() : text;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------- lost glyphs

// The 258 glyphs of the standard Macintosh order (TrueType 'post' table, format 1), as the characters they are: a
// TrueType font kept in that order has its digits at 19-28, its capitals at 36-61 and so on.
const MAC_ORDER = ['', '', '', ' ', '!', '"', '#', '$', '%', '&', '\'', '(', ')', '*', '+', ',', '-', '.', '/', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', ':', ';', '<', '=', '>', '?', '@', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z', '[', '\\', ']', '^', '_', '`', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z', '{', '|', '}', '~', '\u00c4', '\u00c5', '\u00c7', '\u00c9', '\u00d1', '\u00d6', '\u00dc', '\u00e1', '\u00e0', '\u00e2', '\u00e4', '\u00e3', '\u00e5', '\u00e7', '\u00e9', '\u00e8', '\u00ea', '\u00eb', '\u00ed', '\u00ec', '\u00ee', '\u00ef', '\u00f1', '\u00f3', '\u00f2', '\u00f4', '\u00f6', '\u00f5', '\u00fa', '\u00f9', '\u00fb', '\u00fc', '\u2020', '\u00b0', '\u00a2', '\u00a3', '\u00a7', '\u2022', '\u00b6', '\u00df', '\u00ae', '\u00a9', '\u2122', '\u00b4', '\u00a8', '\u2260', '\u00c6', '\u00d8', '\u221e', '\u00b1', '\u2264', '\u2265', '\u00a5', '\u00b5', '\u2202', '\u2211', '\u220f', '\u03c0', '\u222b', '\u00aa', '\u00ba', '\u2126', '\u00e6', '\u00f8', '\u00bf', '\u00a1', '\u00ac', '\u221a', '\u0192', '\u2248', '\u2206', '\u00ab', '\u00bb', '\u2026', '\u00a0', '\u00c0', '\u00c3', '\u00d5', '\u0152', '\u0153', '\u2013', '\u2014', '\u201c', '\u201d', '\u2018', '\u2019', '\u00f7', '\u25ca', '\u00ff', '\u0178', '\u2044', '\u00a4', '\u2039', '\u203a', 'fi', 'fl', '\u2021', '\u00b7', '\u201a', '\u201e', '\u2030', '\u00c2', '\u00ca', '\u00c1', '\u00cb', '\u00c8', '\u00cd', '\u00ce', '\u00cf', '\u00cc', '\u00d3', '\u00d4', '', '\u00d2', '\u00da', '\u00db', '\u00d9', '\u0131', '\u02c6', '\u02dc', '\u00af', '\u02d8', '\u02d9', '\u02da', '\u00b8', '\u02dd', '\u02db', '\u02c7', '\u0141', '\u0142', '\u0160', '\u0161', '\u017d', '\u017e', '\u00a6', '\u00d0', '\u00f0', '\u00dd', '\u00fd', '\u00de', '\u00fe', '\u2212', '\u00d7', '\u00b9', '\u00b2', '\u00b3', '\u00bd', '\u00bc', '\u00be', '\u20a3', '\u011e', '\u011f', '\u0130', '\u015e', '\u015f', '\u0106', '\u0107', '\u010c', '\u010d', '\u0111'];

// Outlines learned on earlier pages of a document (its fonts are shared by every page): outline -> character.
const learned = new WeakMap();

/** A glyph's outline as a string, in thousandths of an em (rounded), or null for a glyph with nothing drawn. */
function outlineKey(font, glyph) {
  const commands = glyph?.path?.commands;
  if (!commands?.length) return null;
  const scale = 1000 / (font.unitsPerEm || 1000);
  return commands.map(c => c.command[0] + c.args.map(a => Math.round(a * scale)).join(',')).join(' ');
}

// A matrix as PDF.js passes it: six numbers, or one array (typed or not) of them.
const matrixOf = a => { const m = a && typeof a[0] === 'object' && a[0] !== null ? a[0] : a; return [0, 1, 2, 3, 4, 5].map(k => Number(m?.[k]) || (k === 0 || k === 3 ? (m?.[k] === 0 ? 0 : 1) : 0)); };

// m2 applied first, then m1 (PDF.js's Util.transform).
const times = (m1, m2) => [m1[0] * m2[0] + m1[2] * m2[1], m1[1] * m2[0] + m1[3] * m2[1], m1[0] * m2[2] + m1[2] * m2[3], m1[1] * m2[2] + m1[3] * m2[3], m1[0] * m2[4] + m1[2] * m2[5] + m1[4], m1[1] * m2[4] + m1[3] * m2[5] + m1[5]];

/**
 * The glyphs a page draws, with where each starts on the page (PDF user space, as PDF.js's text items give it): the
 * text state followed as PDF.js's canvas follows it. Returns entries { g, font, run, tr, adv } in drawing order, `tr`
 * being the transform a text item starting at that glyph would have and `adv` the glyph's advance along the line.
 */
function placedGlyphs(ops, OPS, commonObjs) {
  const out = [], stack = [];
  let ctm = [1, 0, 0, 1, 0, 0], tm = [1, 0, 0, 1, 0, 0], x = 0, y = 0, lineX = 0, lineY = 0;
  let font = null, size = 0, matrix = [0.001, 0, 0, 0.001, 0, 0], cs = 0, ws = 0, hs = 1, rise = 0, leading = 0;
  const move = (dx, dy) => { lineX += dx; lineY += dy; x = lineX; y = lineY; };
  for (let k = 0; k < ops.fnArray.length; k++) {
    const fn = ops.fnArray[k], a = ops.argsArray[k];
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() || ctm;
    else if (fn === OPS.transform) ctm = times(ctm, matrixOf(a));
    else if (fn === OPS.paintFormXObjectBegin) { stack.push(ctm); if (a?.[0]) ctm = times(ctm, matrixOf(a[0])); }
    else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() || ctm;
    else if (fn === OPS.beginText) { tm = [1, 0, 0, 1, 0, 0]; x = y = lineX = lineY = 0; }
    else if (fn === OPS.setTextMatrix) { tm = matrixOf(a); x = y = lineX = lineY = 0; }
    else if (fn === OPS.moveText) move(a[0], a[1]);
    else if (fn === OPS.setLeadingMoveText) { leading = a[1]; move(a[0], a[1]); }
    else if (fn === OPS.setLeading) leading = -a[0];
    else if (fn === OPS.nextLine) move(0, leading);
    else if (fn === OPS.setCharSpacing) cs = a[0];
    else if (fn === OPS.setWordSpacing) ws = a[0];
    else if (fn === OPS.setHScale) hs = a[0] / 100;
    else if (fn === OPS.setTextRise) rise = a[0];
    else if (fn === OPS.setFont) {
      font = a[0]; size = a[1];
      try { matrix = commonObjs.get(font)?.fontMatrix || [0.001, 0, 0, 0.001, 0, 0]; } catch { matrix = [0.001, 0, 0, 0.001, 0, 0]; }
    } else if (fn === OPS.showText && Array.isArray(a[0])) {
      const dir = size < 0 ? -1 : 1, fs = Math.abs(size);
      let run = 0;
      for (const g of a[0]) {
        if (typeof g === 'number') { run += -g * fs / 1000 * dir; continue; }
        if (!g || typeof g !== 'object') continue;
        const at = times(times(ctm, tm), [fs * hs, 0, 0, fs * dir, x + run * hs, y + rise]);
        const w = (g.width || 0) * fs * (matrix[0] || 0.001) + ((g.isSpace ? ws : 0) + cs) * dir;
        // ink: how wide the glyph itself is on the page (its advance without character or word spacing).
        out.push({ g, font, run: k, tr: at, adv: Math.hypot(at[0], at[1]) / (fs || 1) * w * hs, ink: Math.hypot(at[0], at[1]) * (g.width || 0) * (matrix[0] || 0.001) });
        run += w;
      }
      x += run * hs;
    }
  }
  return out;
}

/**
 * Letters a PDF draws but gives no Unicode for (a subset font with no ToUnicode entry for them): PDF.js reads them as
 * blanks, so "Lithuania" reads "ithuania" and an axis of 50, 45, 40 reads 0, , 0. Each such glyph gets its character
 *   - from a glyph with the same outline that the page (or an earlier page) does map, in any font (a sibling subset of
 *     the same typeface draws "L" with the same outline), or
 *   - from the standard Macintosh glyph order, for a TrueType font whose mapped glyphs all sit where that order says
 *     (so its glyph numbers can be trusted).
 * The character then goes into the text item (PDF.js's text content, `content.items`) of its font that it sits in or
 * next to on its line, in place of the blank PDF.js put there; a glyph with no item near becomes an item of its own.
 * Changes `content.items` in place; returns how many characters were put back. Never throws.
 */
export async function recoverLostGlyphs(page, ops, content, pdfjs) {
  try {
    const OPS = pdfjs?.OPS;
    if (!OPS || !ops?.fnArray || !Array.isArray(content?.items)) return 0;
    // Cheap first look: any glyph drawn blank that isn't a space.
    let suspect = false;
    for (let k = 0; k < ops.fnArray.length && !suspect; k++) {
      if (ops.fnArray[k] !== OPS.showText || !Array.isArray(ops.argsArray[k]?.[0])) continue;
      for (const g of ops.argsArray[k][0]) if (g && typeof g === 'object' && typeof g.unicode === 'string' && !g.unicode.trim() && !g.isSpace && ![32, 160, 0x3000].includes(g.originalCharCode) && g.fontChar && g.width > 0) { suspect = true; break; }
    }
    if (!suspect) return 0;
    const { default: fontkit } = await import('@pdf-lib/fontkit');
    const parsed = new Map();
    const programOf = name => {
      if (!parsed.has(name)) {
        let program = null;
        try { const f = page.commonObjs.get(name); if (f?.data && !f.isType3Font) program = fontkit.create(f.data instanceof Uint8Array ? f.data : new Uint8Array(f.data)); } catch { /* not a font fontkit reads */ }
        parsed.set(name, program);
      }
      return parsed.get(name);
    };
    const glyphOf = (program, g) => { try { return program.glyphForCodePoint(g.fontChar.codePointAt(0)); } catch { return null; } };
    const placed = placedGlyphs(ops, OPS, page.commonObjs);
    let known = learned.get(page.commonObjs);
    if (!known) { known = new Map(); learned.set(page.commonObjs, known); }
    const lost = new Map(); // font -> entries drawn but blank
    for (const e of placed) {
      const { g } = e;
      if (typeof g.unicode !== 'string' || !g.fontChar) continue;
      const program = programOf(e.font);
      if (!program) continue;
      const glyph = glyphOf(program, g), key = outlineKey(program, glyph);
      // Only glyphs the font program really has for this code: not .notdef, and as wide as the PDF says the glyph
      // is (a code the program has no glyph for lands on another one, which would be read as the wrong letter).
      if (!key || !glyph.id || !(g.width > 0) || Math.abs(g.width - glyph.advanceWidth * 1000 / (program.unitsPerEm || 1000)) > Math.max(10, g.width * 0.02)) continue;
      // (Only letters, figures and signs teach an outline: a font that maps its glyphs to control codes reads garbled.)
      if (g.unicode.trim()) { if ([...g.unicode].length === 1 && /[\p{L}\p{N}\p{P}\p{S}]/u.test(g.unicode) && !known.has(key)) known.set(key, g.unicode); }
      else if (!g.isSpace && ![32, 160, 0x3000].includes(g.originalCharCode)) { e.key = key; e.gid = glyph.id; if (!lost.has(e.font)) lost.set(e.font, []); lost.get(e.font).push(e); }
    }
    let restored = 0;
    for (const [name, entries] of lost) {
      const program = programOf(name);
      // The standard order holds when the font's mapped glyphs (and those matched by outline) all sit where it says.
      let agree = 0, checked = 0;
      for (const { g, font } of placed) {
        if (font !== name || !g.unicode?.trim() || [...g.unicode].length !== 1) continue;
        const glyph = glyphOf(program, g);
        if (!glyph || glyph.id >= MAC_ORDER.length || !MAC_ORDER[glyph.id]) continue;
        checked++;
        if (MAC_ORDER[glyph.id] === g.unicode) agree++;
      }
      for (const e of entries) if (known.has(e.key) && e.gid < MAC_ORDER.length) { checked++; if (MAC_ORDER[e.gid] === known.get(e.key)) agree++; }
      let type = '';
      try { type = String(page.commonObjs.get(name)?.type || ''); } catch { /* unknown */ }
      const ordered = checked >= 8 && agree >= checked * 0.95 && /TrueType|CIDFontType2/.test(type);
      for (const e of entries) e.r = known.get(e.key) || (ordered && e.gid < MAC_ORDER.length && MAC_ORDER[e.gid].trim() ? MAC_ORDER[e.gid] : null);
      const found = entries.filter(e => e.r);
      if (!found.length) continue;
      const items = content.items.filter(i => i?.fontName === name && typeof i.str === 'string' && Array.isArray(i.transform));
      // The places worked out must agree with PDF.js's: most of the font's items start where one of its glyphs does.
      const starts = placed.filter(e => e.font === name);
      const placedRight = items.filter(i => i.str.trim()).filter(i => starts.some(e => Math.abs(e.tr[4] - i.transform[4]) <= 1 && Math.abs(e.tr[5] - i.transform[5]) <= 1));
      if (placedRight.length < items.filter(i => i.str.trim()).length * 0.8) continue;
      restored += putBack(content.items, items, found, name, placed);
    }
    return restored;
  } catch { return 0; }
}

/**
 * Recovered characters (entries with `r`) put into the text items of their font. Each item is matched to the glyphs
 * drawn from where it starts, in order: a blank that is a lost glyph becomes its letter, a lost glyph PDF.js left out
 * goes in; an item whose text and glyphs don't line up stays as it is. Lost glyphs in no item become items.
 */
function putBack(all, items, found, fontName, placed) {
  const order = placed.filter(e => e.font === fontName);
  const lost = new Set(found);
  const blank = e => !e.g.unicode?.trim();
  // Same line and direction as an item: across its line within a third of its size.
  const onLine = (i, e) => {
    const [a, b, c, d, x, y] = i.transform, h = Math.hypot(a, b) || 1, v = Math.hypot(c, d) || 1, eh = Math.hypot(e.tr[0], e.tr[1]) || 1;
    if (Math.abs(a / h - e.tr[0] / eh) > 0.02 || Math.abs(b / h - e.tr[1] / eh) > 0.02) return false;
    return Math.abs(((e.tr[4] - x) * c + (e.tr[5] - y) * d) / v) <= Math.max(1, v * 0.3);
  };
  const along = (i, e) => { const [a, b, , , x, y] = i.transform, h = Math.hypot(a, b) || 1; return ((e.tr[4] - x) * a + (e.tr[5] - y) * b) / h; };
  const used = new Set();
  let count = 0;
  for (const item of items) {
    const s = item.str;
    if (!s.trim()) continue;
    // Walk the item's text and the glyphs together from glyph k: a blank that is a lost glyph becomes its letter, a
    // lost glyph PDF.js left out goes in, spaces PDF.js added between glyphs stay. Null when they don't line up.
    const walk = k => {
      let out = '', i = 0;
      const took = [];
      while (i < s.length && k < order.length) {
        const e = order[k], u = e.g.unicode || '';
        if (!blank(e)) {
          if (s.startsWith(u, i)) { out += u; i += u.length; k++; continue; }
          if (/\s/.test(s[i])) { out += s[i]; i++; continue; }
          return null;
        }
        if (/\s/.test(s[i])) { out += lost.has(e) ? e.r : s[i]; if (lost.has(e)) took.push(e); i++; k++; continue; }
        if (lost.has(e)) { out += e.r; took.push(e); }
        k++;
      }
      return i < s.length ? null : { out, k, took };
    };
    // The glyph the item starts at: one drawn at its start on its line (places worked out along a line can drift a
    // little from PDF.js's, so the nearest few are tried), then back over lost glyphs just before it (PDF.js trims
    // blanks off an item's start).
    const starts = order.map((e, k) => [k, onLine(item, e) ? Math.abs(along(item, e)) : Infinity]).filter(([k, d]) => d <= Math.max(1.5, order[k].adv * 1.2)).sort((a, b) => a[1] - b[1]).slice(0, 3);
    let k0 = -1, done = null;
    for (const [start] of starts) {
      let k = start;
      while (k > 0 && lost.has(order[k - 1]) && !used.has(order[k - 1]) && onLine(item, order[k - 1]) && along(item, order[k - 1]) >= -Math.max((order[k - 1].adv + order[k].adv) * 1.2, 2)) k--;
      done = walk(k);
      if (done) { k0 = k; break; }
    }
    if (!done) continue; // text and glyphs don't line up: the item stays as it is
    let { out, k, took } = done;
    // Lost glyphs drawn right after the item's last one (PDF.js trims blanks off an item's end) belong to it.
    while (k < order.length && lost.has(order[k]) && !used.has(order[k]) && onLine(item, order[k]) && along(item, order[k]) >= item.width - Math.max(order[k].adv * 1.5, 2) && along(item, order[k]) <= item.width + Math.max(order[k].adv * 1.5, 2)) { out += order[k].r; took.push(order[k]); k++; }
    took = took.filter(e => !used.has(e));
    if (!took.length) continue;
    took.forEach(e => used.add(e));
    // The item reaches to the end of the last glyph put back after it ("(U" + "K" is as wide as "(UK").
    const end = Math.max(...took.map(e => along(item, e) + e.adv));
    if (end > item.width + 0.5) item.width = end;
    if (along(item, order[k0]) < -0.5) { item.width += -along(item, order[k0]); item.transform = [...item.transform.slice(0, 4), order[k0].tr[4], order[k0].tr[5]]; }
    item.str = out;
    count += took.length;
  }
  // Lost glyphs in no item (PDF.js leaves out an item that is all blanks): an item for each run of them along a line.
  const groups = [];
  for (const e of found.filter(x => !used.has(x)).sort((a, b) => order.indexOf(a) - order.indexOf(b))) {
    const last = groups.at(-1)?.at(-1), h = Math.hypot(e.tr[0], e.tr[1]) || 1;
    const gap = last ? ((e.tr[4] - last.tr[4]) * e.tr[0] + (e.tr[5] - last.tr[5]) * e.tr[1]) / h : 0;
    const off = last ? Math.abs(((e.tr[4] - last.tr[4]) * e.tr[2] + (e.tr[5] - last.tr[5]) * e.tr[3]) / (Math.hypot(e.tr[2], e.tr[3]) || 1)) : 0;
    if (last && off <= 1 && gap >= 0 && gap - last.adv <= last.adv * 0.6) groups.at(-1).push(e); else groups.push([e]);
  }
  for (const group of groups) {
    const first = group[0], width = group.reduce((n, e) => n + e.adv, 0);
    all.push({ str: group.map(e => e.r).join(''), dir: 'ltr', width, height: Math.hypot(first.tr[2], first.tr[3]), transform: first.tr, fontName, hasEOL: false });
    count += group.length;
  }
  return count;
}

// ------------------------------------------------------------------------------------------ spaces PDF.js adds

// Scripts written without spaces between words (Chinese, Japanese) and their full-width signs.
const UNSPACED_CHAR = /[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}　-〿ー！-･]/u;
const CJK_CLASS = '[\\p{scx=Han}\\p{scx=Hiragana}\\p{scx=Katakana}\\p{scx=Hangul}\\u3000-\\u303F\\uFF01-\\uFF65]';
const SPACED_CJK = new RegExp(`${CJK_CLASS} \\S|\\S ${CJK_CLASS}`, 'u');
const HANGUL = /\p{scx=Hangul}/u;
const SPACED_LETTERS = /(?:^|\s)\S \S \S(?:\s|$)/u;

/**
 * How wide a gap between two pieces of a line's text (`left` ends where `right` starts) must be, in ems, to read as a
 * space: next to Chinese or Japanese, written with no spaces between words, half an em between two of their
 * characters and a third of an em beside a Latin letter or a figure (the room typesetters leave around them);
 * null for other text (its own rule applies).
 */
export function unspacedGap(left, right) {
  const a = UNSPACED_CHAR.test(String(left ?? '').slice(-1)), b = UNSPACED_CHAR.test(String(right ?? '').charAt(0));
  return a && b ? 0.5 : a || b ? 0.35 : null;
}

/** Whether an item's text may hold spaces PDF.js put in for a gap between glyphs (no space glyph drawn there). */
const suspectSpaces = str => typeof str === 'string' && str.length >= 3 && !RTL_TEXT.test(str) && (SPACED_LETTERS.test(str) || SPACED_CJK.test(str));

/**
 * The spaces in a text item's string read against the glyphs drawn from glyph k on (`order`: one font's glyphs in
 * drawing order, from placedGlyphs): for each space PDF.js added for a gap (no space glyph drawn there), its place in
 * the string and the gap in ems (`added`); and the gaps between the other neighbouring glyphs (`tight`). Null when
 * the string and the glyphs don't line up.
 */
function glyphGaps(str, order, k) {
  const first = order[k], h = Math.hypot(first.tr[0], first.tr[1]) || 1, ux = first.tr[0] / h, uy = first.tr[1] / h;
  const em = Math.hypot(first.tr[2], first.tr[3]) || 1;
  const along = e => e.tr[4] * ux + e.tr[5] * uy;
  const added = [], tight = [];
  let i = 0, end = null, pending = -1;
  while (i < str.length && k < order.length) {
    const e = order[k], u = e.g.unicode || '';
    if (!u.trim()) { // a space glyph drawn (or a blank): the space it reads as is the PDF's own
      if (/\s/.test(str[i])) i++;
      k++; end = null; pending = -1; continue;
    }
    const nfkc = u.normalize('NFKC');
    const len = str.startsWith(u, i) ? u.length : str.startsWith(nfkc, i) ? nfkc.length : 0;
    if (len) {
      if (end !== null) (pending >= 0 ? added : tight).push({ at: pending, gap: (along(e) - end) / em });
      end = Math.max(end ?? -Infinity, along(e) + (e.ink || 0));
      pending = -1; i += len; k++; continue;
    }
    if (/\s/.test(str[i]) && end !== null) { if (pending < 0) pending = i; i++; continue; }
    return null;
  }
  return i < str.length ? null : { added, tight };
}

const middle = values => { const s = [...values].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };

/** The letter spacing of an item set letter by letter (most neighbouring glyphs have a space added between them), in
 *  ems: the middle gap; null for an item that isn't. */
function tracking({ added = [], tight = [] }) {
  const all = [...added, ...tight].map(g => g.gap);
  const track = middle(all);
  return added.length >= 2 && added.length >= all.length * 0.6 && track < 0.45 ? track : null;
}

/**
 * The item's text with the spaces PDF.js added that are not word spaces taken out:
 *   - letters set apart one by one ("P a g e", "사 업 자"): most neighbouring glyphs have a space added between them,
 *     so the gaps are letter spacing; a space stays only where the gap is clearly wider than the letters' own;
 *   - a gap next to a Chinese or Japanese character (writing with no spaces between words) narrower than a word
 *     space there would be ("2012 年 7 月" → "2012年7月").
 * `gaps` as glyphGaps gives them; `fontTrack`, the letter spacing other items of the font are set with on the page
 * (a short word set the same way, "사 업", has a single gap to tell by). Returns the text unchanged when nothing is to go.
 */
export function respacedText(str, gaps = {}, fontTrack = null) {
  const { added = [] } = gaps;
  if (typeof str !== 'string' || !added.length) return str;
  const track = tracking(gaps);
  const drop = new Set();
  // (The font's spacing tells only between single letters, as in "본 점", or Korean syllables, "3자 리": a word space of
  // ordinary text may be as narrow.)
  const single = at => (/(?:^|\s)\S\s+$/u.test(str.slice(0, at + 1)) && /^\s+\S(?:\s|$)/u.test(str.slice(at)))
    || (HANGUL.test(str[at - 1] || '') && HANGUL.test(str.slice(at).trimStart()[0] || ''));
  for (const { at, gap } of added) {
    const limit = unspacedGap(str.slice(0, at), str.slice(at).trimStart());
    if (track !== null ? gap < track + 0.15 : (fontTrack !== null && gap < fontTrack + 0.1 && single(at)) || (limit !== null && gap < limit)) drop.add(at);
  }
  if (!drop.size) return str;
  let out = '';
  for (let i = 0; i < str.length; i++) {
    if (!drop.has(i)) { out += str[i]; continue; }
    while (i + 1 < str.length && /\s/.test(str[i + 1])) i++; // the whole run of spaces added there
  }
  return out;
}

/**
 * Spaces PDF.js puts into a text item for a gap between two glyphs where no space glyph is drawn (a gap wider than a
 * tenth of an em) that are not word spaces: letter-spaced words and gaps around Chinese and Japanese characters (see
 * respacedText). The gaps are measured on the glyphs the page draws (placedGlyphs), which PDF.js's text content
 * doesn't keep. Changes `content.items` in place; returns how many items changed. Never throws.
 */
export function respaceItems(page, ops, content, pdfjs) {
  try {
    const OPS = pdfjs?.OPS;
    if (!OPS || !ops?.fnArray || !Array.isArray(content?.items)) return 0;
    const suspects = content.items.filter(i => typeof i?.str === 'string' && Array.isArray(i.transform) && suspectSpaces(i.str));
    if (!suspects.length) return 0;
    // Each font's glyphs in drawing order, and where they start (to the nearest point) for finding an item's first.
    const fonts = new Map();
    for (const e of placedGlyphs(ops, OPS, page.commonObjs)) {
      if (!fonts.has(e.font)) fonts.set(e.font, { order: [], at: new Map() });
      const f = fonts.get(e.font), key = `${Math.round(e.tr[4])},${Math.round(e.tr[5])}`;
      if (!f.at.has(key)) f.at.set(key, []);
      f.at.get(key).push(f.order.length);
      f.order.push(e);
    }
    const found = [];
    for (const item of suspects) {
      const f = fonts.get(item.fontName);
      if (!f) continue;
      let vertical = false;
      try { vertical = Boolean(page.commonObjs.get(item.fontName)?.vertical); } catch { /* not loaded */ }
      if (vertical) continue;
      const [x, y] = [item.transform[4], item.transform[5]];
      const starts = new Set();
      for (const dx of [-1, 0, 1]) for (const dy of [-1, 0, 1]) for (const k of f.at.get(`${Math.round(x) + dx},${Math.round(y) + dy}`) || []) {
        const e = f.order[k];
        if (Math.abs(e.tr[4] - x) <= 0.6 && Math.abs(e.tr[5] - y) <= 0.6 && e.g.unicode?.trim()) starts.add(k);
      }
      for (const k of [...starts].sort((a, b) => a - b)) {
        const gaps = glyphGaps(item.str, f.order, k);
        if (gaps) { found.push({ item, gaps }); break; }
      }
    }
    // Each font's letter spacing on the page, from its items set letter by letter.
    const tracks = new Map();
    for (const { item, gaps } of found) {
      const t = tracking(gaps);
      if (t !== null) { if (!tracks.has(item.fontName)) tracks.set(item.fontName, []); tracks.get(item.fontName).push(t); }
    }
    let changed = 0;
    for (const { item, gaps } of found) {
      const text = respacedText(item.str, gaps, tracks.has(item.fontName) ? middle(tracks.get(item.fontName)) : null);
      if (text !== item.str) { item.str = text; changed++; }
    }
    return changed;
  } catch { return 0; }
}
