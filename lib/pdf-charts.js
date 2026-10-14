// Charts drawn as vector graphics (bars as filled rectangles or outlines, lines as stroked paths, areas as filled
// outlines, pies as filled slices) → their data as a table.
// Shared by every reader (Markdown, HTML, JSON, Word and Excel exports in the browser, the CLI, the MCP server and
// the local API). No DOM, no dependencies.
//
// A chart is found from a value axis: three or more numbers in a column (or a row) spaced evenly, their values in
// step with their positions. Bars that start at the axis's zero, and lines drawn across the plot, are then read
// through that scale; categories come from the labels under (or beside) the bars or along the line axis, series
// from the legend (a small swatch of the same colour beside a name). A number printed on a bar is used as it is;
// otherwise the value is measured from the drawing and rounded to the axis's precision. Bars and lines with a number
// printed at each bar or point need no axis; a pie is read from its slices (see findPies). When any of this can't be
// read with confidence (no axis, labels that don't line up) nothing is added: the page reads as before.

const round = n => Math.round(n * 100) / 100;
const median = values => { const s = [...values].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };
const MAX_TOKENS = 3000; // a page with more words than this is text, not a chart

// ---------------------------------------------------------------------------------------------- numbers and words

// Units charts print after a number ("10bn", "500k", "1.5x"): the multiple they stand for.
const UNITS = { k: 1e3, K: 1e3, m: 1e6, M: 1e6, mn: 1e6, bn: 1e9, B: 1e9, tn: 1e12, x: 1, pp: 1 };

/** A number as charts print it ("1 000", "−2.5", "45%", "$3.1", "(4)", "10bn"), or null. */
export function chartNumber(text) {
  let t = String(text).trim().replace(/[−–‒]/g, '-').replace(/[\u00a0\u2009\u202f]/g, ' ').replace(/^([-+(]|[$€£¥])\s+/, '$1').replace(/\s+%$/, '%');
  const unit = /\d\s?(k|K|m|M|mn|bn|B|tn|x|pp)\)?$/.exec(t)?.[1];
  if (unit) t = t.replace(new RegExp(`\\s?${unit}(\\)?)$`), '$1');
  // Spaces only between groups of thousands ("1 000"), not between separate numbers ("2020 2021").
  if (/\s/.test(t) && !/^\D*\d{1,3}( \d{3})+(\.\d+)?\D*$/.test(t)) return null;
  t = t.replace(/\s/g, '');
  if (!/^[-+(]?[$€£¥]?[-+]?\d[\d,]*(\.\d+)?%?\)?$/.test(t)) return null;
  const negative = /^-|^\(.*\)$|^[$€£¥]-/.test(t);
  const percent = t.includes('%');
  t = t.replace(/[-+()$€£¥%]/g, '');
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) t = t.replace(/,/g, '');
  else if (/^\d+,\d{1,2}$/.test(t)) t = t.replace(',', '.');
  else if (t.includes(',')) return null;
  const value = Number(t);
  if (!Number.isFinite(value)) return null;
  return { value: negative ? -value : value, percent, decimals: (t.split('.')[1] || '').length, ...(unit && { unit }) };
}

/** A number printed on a chart as it goes in a table: without spaces; a dash for nought is 0. */
const printedText = t => (t.num?.dash ? '0' : t.text.replace(/\s+/g, ''));

const isYear = n => n && !n.percent && Number.isInteger(n.value) && n.value >= 1900 && n.value <= 2100;

/**
 * Slanted or upright labels set a letter or two at a time (each piece its own text item): pieces of one angle that
 * follow each other along their direction, on one line, become one item.
 */
function joinRotatedLetters(items) {
  const letters = items.filter(i => i.angle && i.text.trim().length >= 1 && i.text.trim().length <= 3 && !/\s/.test(i.text.trim()));
  if (letters.length < 2) return items;
  const along = i => { const a = i.angle * Math.PI / 180; return i.x * Math.cos(a) - (i.y + i.size) * Math.sin(a); };
  const across = i => { const a = i.angle * Math.PI / 180; return i.x * Math.sin(a) + (i.y + i.size) * Math.cos(a); };
  const sorted = [...letters].sort((p, q) => p.angle - q.angle || across(p) - across(q) || along(p) - along(q));
  const joined = new Map(), out = [];
  let run = null;
  for (const i of sorted) {
    const last = run?.at(-1);
    if (last && last.angle === i.angle && Math.abs(across(i) - across(last)) <= i.size * 0.25 && along(i) - along(last) > i.size * 0.1 && along(i) - along(last) <= i.size * (0.3 + 0.8 * last.text.trim().length)) run.push(i);
    else { run = [i]; out.push(run); }
  }
  for (const r of out) if (r.length > 1) {
    const first = r[0];
    joined.set(first, { ...first, text: r.map(i => i.text.trim()).join(''), width: along(r.at(-1)) - along(first) + (r.at(-1).width || first.size * 0.6) });
    for (const i of r.slice(1)) joined.set(i, null);
  }
  return items.map(i => (joined.has(i) ? joined.get(i) : i)).filter(Boolean);
}

/** Rotated words on one line, a word space apart ("New" + "Zealand", "England (UK" + ")"), are one label. */
function joinRotatedWords(items) {
  const turned = items.filter(i => i.angle && i.text.trim());
  if (turned.length < 2) return items;
  const along = i => { const a = i.angle * Math.PI / 180; return i.x * Math.cos(a) - (i.y + i.size) * Math.sin(a); };
  const across = i => { const a = i.angle * Math.PI / 180; return i.x * Math.sin(a) + (i.y + i.size) * Math.cos(a); };
  // In reading order, each word goes on the run whose last word it follows on the same line.
  const runs = [];
  for (const i of [...turned].sort((p, q) => along(p) - along(q))) {
    const run = runs.find(r => {
      const last = r.at(-1), gap = along(i) - (along(last) + last.width);
      return last.angle === i.angle && Math.abs(last.size - i.size) <= 0.5 && Math.abs(across(i) - across(last)) <= i.size * 0.25 && gap >= -i.size * 0.2 && gap <= i.size * 0.6;
    });
    if (run) run.push(i); else runs.push([i]);
  }
  const joined = new Map();
  for (const r of runs) if (r.length > 1) {
    const first = r[0];
    let text = first.text.trim();
    for (let k = 1; k < r.length; k++) text += (along(r[k]) - (along(r[k - 1]) + r[k - 1].width) > r[k].size * 0.15 ? ' ' : '') + r[k].text.trim();
    joined.set(first, { ...first, text, width: along(r.at(-1)) + r.at(-1).width - along(first) });
    for (const i of r.slice(1)) joined.set(i, null);
  }
  return items.map(i => (joined.has(i) ? joined.get(i) : i)).filter(Boolean);
}

/** Words of the page: text items on one baseline that touch are one word ("-" + "1.5", "1" + "000"). */
function tokensOf(items) {
  items = joinRotatedWords(joinRotatedLetters(items));
  const out = [];
  // Spaces around the text (a trailing space after "0%") would shift its centre.
  const trimmed = i => {
    const lead = i.text.length - i.text.trimStart().length, trail = i.text.length - i.text.trimEnd().length;
    if (!lead && !trail) return i;
    const per = i.width / i.text.length;
    return { ...i, source: i.source || i, x: i.x + lead * per, width: i.width - (lead + trail) * per };
  };
  // Several labels in one piece of text ("2020 2021 2022 2023"): one word each, placed in proportion.
  const words = i => {
    if (i.angle || !/^\s*\S+(\s+\S+)+\s*$/.test(i.text) || chartNumber(i.text) || !i.text.trim().split(/\s+/).every(w => chartNumber(w))) return [i];
    const per = i.width / i.text.length;
    return [...i.text.matchAll(/\S+/g)].map(m => ({ ...i, source: i, word: true, text: m[0], x: i.x + m.index * per, width: m[0].length * per }));
  };
  const sorted = items.filter(i => i.text.trim()).flatMap(words).map(trimmed).sort((a, b) => (a.angle || 0) - (b.angle || 0) || (a.y + a.size) - (b.y + b.size) || a.x - b.x);
  for (const i of sorted) {
    const last = out.at(-1);
    // Letters set one by one, each given the width of a whole em (some PDF writers): they overlap, but follow each other.
    const glyphs = last && i.text.trim().length === 1 && last.glyphX != null && i.x > last.glyphX + i.size * 0.1 && i.x - last.glyphX <= i.size * 0.9 && i.width >= i.size * 0.9;
    if (last && !i.word && !last.split && !i.angle && !last.angle && Math.abs(last.base - (i.y + i.size)) <= Math.max(1, i.size * 0.2)
      // A piece may start inside the previous one when the writer gave that one too wide a box ("Mi" + "scellaneous"),
      // as long as it starts well after it.
      && Math.abs(last.size - i.size) <= 1 && (glyphs || (i.x - last.x1 <= i.size * 0.3 && (i.x - last.x1 >= -i.size * 0.5 || (i.x - last.x1 >= -i.size && i.x - last.items.at(-1).x >= i.size * 0.8))))) {
      last.text += (!glyphs && i.x - last.x1 > i.size * 0.15 ? ' ' : '') + i.text.trim();
      last.x1 = glyphs ? i.x + i.size * 0.6 : Math.max(last.x1, i.x + i.width);
      last.glyphX = i.text.trim().length === 1 ? i.x : null;
      last.items.push(i.source || i);
      continue;
    }
    const single = i.text.trim().length === 1 && i.width >= i.size * 0.9;
    out.push({ text: i.text.trim(), x0: i.x, x1: i.x + (single ? i.size * 0.6 : i.width), top: i.y, base: i.y + i.size, size: i.size, angle: i.angle || 0, items: [i.source || i], split: Boolean(i.word), glyphX: single ? i.x : null });
  }
  for (const t of out) {
    // A dash where a number goes ("–", "$ -", an accounting zero) is nought.
    t.num = chartNumber(t.text) || (/^\(?[$€£¥]?\s?[–—-]\s?\)?$/.test(t.text) ? { value: 0, percent: false, decimals: 0, dash: true } : null);
    if (t.angle) {
      // Rotated text: its two short edges (start and end); the one nearer the axis anchors it.
      const a = t.angle * Math.PI / 180, dx = Math.cos(a), dy = -Math.sin(a), px = -Math.sin(a) * t.size / 2, py = -Math.cos(a) * t.size / 2;
      const w = t.x1 - t.x0, sx = t.x0, sy = t.base;
      t.ends = [[sx + px, sy + py], [sx + dx * w + px, sy + dy * w + py]];
      const xs = [sx, sx + dx * w, sx + 2 * px, sx + dx * w + 2 * px], ys = [sy, sy + dy * w, sy + 2 * py, sy + dy * w + 2 * py];
      t.box = { x0: Math.min(...xs), x1: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys) };
    } else t.box = { x0: t.x0, x1: t.x1, top: t.top, bottom: t.base };
    t.cx = (t.box.x0 + t.box.x1) / 2;
    // Figures sit on the baseline and reach about 0.7 of the size up: their middle is what lines up with a tick.
    t.cy = t.angle ? (t.box.top + t.box.bottom) / 2 : t.base - t.size * 0.35;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------- axes

/** Least-squares line v = a + b·p and its largest miss. */
function fit(points) {
  const n = points.length, mp = points.reduce((s, [p]) => s + p, 0) / n, mv = points.reduce((s, [, v]) => s + v, 0) / n;
  let num = 0, den = 0;
  for (const [p, v] of points) { num += (p - mp) * (v - mv); den += (p - mp) ** 2; }
  const b = den ? num / den : 0, a = mv - b * mp;
  return { a, b, miss: Math.max(...points.map(([p, v]) => Math.abs(a + b * p - v))) };
}

/**
 * Value axes: runs of three or more numbers lined up in a column (`vertical`, same right or left edge) or along a
 * row (same baseline), evenly spaced, with values that change in step with the position. Years are labels, not
 * values.
 */
function valueAxes(tokens, vertical) {
  const nums = tokens.filter(t => t.num && !t.angle);
  const groups = [];
  if (vertical) {
    for (const edge of ['x1', 'x0']) {
      const sorted = [...nums].sort((a, b) => a[edge] - b[edge]);
      let run = [];
      for (const t of sorted) {
        if (run.length && t[edge] - run.at(-1)[edge] > 2.5) { groups.push(run); run = []; }
        run.push(t);
      }
      groups.push(run);
    }
  } else {
    const sorted = [...nums].sort((a, b) => a.base - b.base);
    let run = [];
    for (const t of sorted) {
      if (run.length && t.base - run.at(-1).base > 1.5) { groups.push(run); run = []; }
      run.push(t);
    }
    groups.push(run);
  }
  const axes = [], seen = new Set();
  for (const group of groups) {
    const pos = t => (vertical ? t.cy : t.cx);
    const sorted = [...group].sort((a, b) => pos(a) - pos(b));
    // Split where the spacing changes: two panels stacked one above the other share a column.
    const runs = [];
    let run = [];
    for (const t of sorted) {
      const gap = run.length ? pos(t) - pos(run.at(-1)) : 0;
      const step = run.length >= 2 ? pos(run[1]) - pos(run[0]) : null;
      const valueStep = run.length >= 2 ? run[1].num.value - run[0].num.value : null;
      // One tick missing (a label the drawing dropped): twice the spacing, twice the step.
      const skips = m => step !== null && Math.abs(gap - m * step) <= Math.max(1.5, step * 0.12) * m && Math.abs(t.num.value - run.at(-1).num.value - m * valueStep) <= Math.abs(valueStep) * 1e-6;
      const off = step !== null && !skips(1) && !skips(2);
      if (run.length && (gap < 3 || gap > 120 || off)) { runs.push(run); run = []; }
      run.push(t);
    }
    runs.push(run);
    for (const ticks of runs) {
      if (ticks.length < 3 || ticks.every(t => isYear(t.num)) || new Set(ticks.filter(t => !t.num.dash).map(t => t.num.unit || '')).size > 1) continue;
      const key = ticks.map(t => tokens.indexOf(t)).join(',');
      if (seen.has(key)) continue;
      const line = fit(ticks.map(t => [pos(t), t.num.value]));
      const values = ticks.map(t => t.num.value);
      const step = Math.abs(values[1] - values[0]);
      if (!step || line.miss > step * 0.04 || new Set(values).size !== values.length) continue;
      // Values rise up the page (vertical) or to the right (horizontal).
      if (vertical ? line.b >= 0 : line.b <= 0) continue;
      seen.add(key);
      const gap = Math.abs(pos(ticks[1]) - pos(ticks[0]));
      const spread = edge => Math.max(...ticks.map(t => t[edge])) - Math.min(...ticks.map(t => t[edge]));
      axes.push({
        vertical, ticks, align: vertical ? (spread('x1') <= 1 && spread('x0') > 1 ? 1 : spread('x0') <= 1 && spread('x1') > 1 ? -1 : 0) : 0, a: line.a, b: line.b, step, gap, percent: ticks.some(t => t.num.percent), unit: ticks.every(t => t.num.unit === ticks[0].num.unit) ? ticks[0].num.unit : undefined,
        decimals: Math.max(...ticks.map(t => t.num.decimals)), min: Math.min(...values), max: Math.max(...values),
        x0: Math.min(...ticks.map(t => t.x0)), x1: Math.max(...ticks.map(t => t.x1)),
        top: Math.min(...ticks.map(t => t.top)), bottom: Math.max(...ticks.map(t => t.base)),
      });
    }
  }
  return axes;
}

const valueAt = (axis, p) => axis.a + axis.b * p;
const posOf = (axis, v) => (v - axis.a) / axis.b;

/** Measured value, rounded to a fiftieth of the axis step or finer (2.43 on an axis of 0, 1, 2). */
function formatValue(axis, value) {
  const decimals = Math.max(axis.decimals, Math.min(4, Math.max(0, -Math.floor(Math.log10(axis.step / 20)))));
  const text = (Math.abs(value) < 10 ** -decimals / 2 ? 0 : value).toFixed(decimals);
  return axis.percent ? `${text}%` : axis.unit ? `${text}${axis.unit}` : text;
}

/**
 * Years shortened after the first ("2015, 17, 19, 21") written out ("2017"): a label of two figures that follows a full
 * year, in a run of rising years, takes that year's century (the next one after 99). Labels that are all short
 * ('18 … '25) stay as printed: that is how a reader quotes them.
 */
function fullYears(rows) {
  const short = /^['’‘]?(\d{2})([^\d].*)?$/, full = /^(1[89]|20)\d{2}\b/;
  const labels = rows.map(r => r[0]);
  if (!labels.some(l => full.test(l))) return;
  let last = null, out = [];
  for (const l of labels) {
    if (full.test(l)) { last = Number(l.slice(0, 4)); out.push(l); continue; }
    const m = short.exec(l);
    if (!m || last == null) return;
    const nn = Number(m[1]);
    let year = Math.floor(last / 100) * 100 + nn;
    if (year <= last) year += 100;
    if (year - last > 10) return; // not the next years of a run
    last = year;
    out.push(`${year}${m[2] || ''}`);
  }
  rows.forEach((r, i) => { r[0] = out[i]; });
}

// Units that stand for a multiple (thousands, millions, billions): a reader of the table takes "20bn" as 20 000 000 000.
const MULTIPLES = new Set(['k', 'K', 'm', 'M', 'mn', 'bn', 'B', 'tn']);

/**
 * A column whose numbers all carry one multiple ("20.0bn", "11.0bn") says it once, in its heading ("Exports (bn)"),
 * and its cells hold the numbers as charts' readers quote them ("20.0").
 */
function unitsToHeadings(series, rows) {
  series.forEach((name, k) => {
    const cells = rows.map(r => r[k + 1]).filter(Boolean);
    const units = new Set(cells.map(c => chartNumber(c)?.unit || ''));
    if (cells.length < 2 || units.size !== 1) return;
    const [unit] = units;
    if (!MULTIPLES.has(unit)) return;
    for (const r of rows) if (r[k + 1]) r[k + 1] = r[k + 1].replace(new RegExp(`\\s?${unit}(\\)?)$`), '$1');
    series[k] = `${name} (${unit})`;
  });
}

// ---------------------------------------------------------------------------------------------- legend

const isWhite = c => !c || /^#f[a-f0-9]f[a-f0-9]f[a-f0-9]$/.test(c);
// Paper colours a bar is never drawn in: a pale grey box behind a label (#efefef) is not a piece of the bar under it.
const isPaper = c => { const v = rgbOf(c); return isWhite(c) || (v && Math.min(...v) >= 0xec && Math.max(...v) - Math.min(...v) <= 8); };
const hasLetters = text => /\p{L}/u.test(text);

/** Legend entries: a small swatch (a square, or a short line) with a name just to its right. */
function legendEntries(tokens, shapes) {
  const entries = [];
  // Words by band of the page, so each swatch looks only at the words level with it.
  const bands = new Map(), BAND = 16;
  for (const t of tokens) if (!t.angle) { const k = Math.floor(t.cy / BAND); if (!bands.has(k)) bands.set(k, []); bands.get(k).push(t); }
  const near = cy => [...(bands.get(Math.floor(cy / BAND) - 1) || []), ...(bands.get(Math.floor(cy / BAND)) || []), ...(bands.get(Math.floor(cy / BAND) + 1) || [])];
  // A swatch drawn in a gap between words (the next legend entry's), which ends a name there.
  const swatchBetween = (x0, x1, cy) => [...shapes.rects, ...(shapes.dots || [])].some(r => r.x0 >= x0 - 0.5 && r.x1 <= x1 + 0.5 && r.y0 <= cy + 3 && r.y1 >= cy - 3)
    || shapes.lines.some(l => l.pts.length === 2 && Math.min(l.pts[0][0], l.pts[1][0]) >= x0 - 0.5 && Math.max(l.pts[0][0], l.pts[1][0]) <= x1 + 0.5 && Math.abs(l.pts[0][1] - cy) <= 3);
  // (Words read by OCR stand on their own boxes' bottoms, a descender lower: half their size apart is one line.)
  const level = (a, b) => Math.abs(a.base - b.base) <= (a.items?.[0]?.ocr || b.items?.[0]?.ocr ? Math.max(1, Math.max(a.size, b.size) * 0.5) : 1);
  const runFrom = first => {
    const parts = [first];
    for (;;) {
      const last = parts.at(-1);
      const next = near(last.cy).find(t => !t.angle && !parts.includes(t) && level(t, last) && t.x0 > last.x1 - 0.5 && (t.x0 - last.x1 <= last.size * 0.6 || (t.x0 - last.x1 <= last.size * 1.0 && !swatchBetween(last.x1, t.x0, last.cy))));
      if (!next) break;
      parts.push(next);
    }
    return parts;
  };
  const nameAfter = (x1, cy, maxGap, wraps = false) => {
    const after = near(cy).filter(t => !t.angle && t.x0 >= x1 - 0.5 && t.x0 - x1 <= maxGap && Math.abs(t.cy - cy) <= Math.max(3, t.size * 0.6)).sort((a, b) => a.x0 - b.x0);
    const first = after.find(t => hasLetters(t.text) || isYear(t.num) || (!t.num && /\d/.test(t.text)));
    // A name that starts with a number ("16 -24 year-olds"), when the run goes on to words.
    const numbered = after[0] && after[0] !== first && after[0].num ? runFrom(after[0]) : null;
    if (!first && !numbered?.some(t => hasLetters(t.text))) return null;
    const parts = numbered?.some(t => hasLetters(t.text)) ? numbered : runFrom(first);
    // A name OCR read as a scrap ("al", "A" beside a bar) is no name: fewer than three letters and digits, unless a
    // code in capitals (UK).
    const scrap = parts.map(t => t.text).join('');
    if (parts.every(t => t.items?.[0]?.ocr) && (scrap.match(/[\p{L}\p{N}]/gu)?.length || 0) < 3 && !/^[A-Z0-9]{2}$/.test(scrap)) return null;
    // A name wrapped onto a second line, set under its start ("Highest observed / threshold"), when no swatch of its
    // own stands before that line.
    const lead = parts[0];
    const under = near(lead.base + lead.size).filter(t => !t.angle && !parts.includes(t) && hasLetters(t.text) && Math.abs(t.x0 - lead.x0) <= 2
      && t.top >= lead.base - 1 && t.top - lead.base <= lead.size * 0.6 && Math.abs(t.size - lead.size) <= 0.5)[0];
    const swatchBefore = t => [...shapes.rects, ...(shapes.dots || [])].some(r => r.x1 <= t.x0 + 0.5 && t.x0 - r.x1 <= maxGap && r.y0 <= t.cy + 2 && r.y1 >= t.cy - 2 && r.x1 - r.x0 <= 24 && r.y1 - r.y0 <= 16)
      || shapes.lines.some(l => l.pts.length === 2 && Math.abs(l.pts[0][1] - l.pts[1][1]) < 0.5 && Math.abs(l.pts[0][1] - t.cy) <= 2 && Math.max(l.pts[0][0], l.pts[1][0]) <= t.x0 + 0.5 && t.x0 - Math.max(l.pts[0][0], l.pts[1][0]) <= maxGap);
    if (wraps && under && !swatchBefore(under)) {
      parts.push(under);
      for (;;) {
        const last = parts.at(-1);
        const next = near(last.cy).find(t => !t.angle && !parts.includes(t) && Math.abs(t.base - last.base) <= 1 && t.x0 > last.x1 - 0.5 && (t.x0 - last.x1 <= last.size * 0.6 || (t.x0 - last.x1 <= last.size * 1.0 && !swatchBetween(last.x1, t.x0, last.cy))));
        if (!next) break;
        parts.push(next);
      }
    }
    return parts;
  };
  for (const r of shapes.rects) {
    const w = r.x1 - r.x0, h = r.y1 - r.y0;
    // A flat swatch may be under a point tall (a dash of the colour) when it is a few points long.
    // (A white swatch names the white pieces of a stack; a white box behind text is no swatch, as no name follows it closely.)
    if (w < 2 || h < (w >= 3 ? 0.6 : 2) || w > 24 || h > 16 || w / h > 6 || h / w > 3 || (isWhite(r.color) && (w < 4 || h < 4))) continue;
    // A short piece of a bar (a stack's end, the label beside it): it butts onto another piece of another colour, the
    // same height, one of them longer than tall. (Two swatches side by side, hollow and filled, are both square.)
    const squarish = q => Math.abs((q.x1 - q.x0) - (q.y1 - q.y0)) <= (q.y1 - q.y0) * 0.3;
    if (shapes.rects.some(o => o !== r && o.color !== r.color && Math.abs(o.y0 - r.y0) <= 0.5 && Math.abs(o.y1 - r.y1) <= 0.5
      && (Math.abs(o.x1 - r.x0) <= 0.5 || Math.abs(o.x0 - r.x1) <= 0.5) && !(squarish(o) && squarish(r)))) continue;
    const parts = nameAfter(r.x1, (r.y0 + r.y1) / 2, 14, true);
    if (parts) entries.push({ color: r.color, dash: false, name: parts.map(t => t.text).join(' '), tokens: parts, swatch: r, box: { x0: r.x0, x1: parts.at(-1).x1, top: Math.min(r.y0, parts[0].top), bottom: Math.max(r.y1, parts[0].base) } });
  }
  // A name underlined by a bar of the series colour (MOBILE over a dark rule, CONSOLE over a lighter one), the rules
  // stacked one under another.
  for (const r of shapes.rects) {
    const w = r.x1 - r.x0, h = r.y1 - r.y0;
    if (h < 1 || h > 8 || w < 30 || w > 300 || isWhite(r.color)) continue;
    const over = near(r.y0).filter(t => !t.angle && !t.num && hasLetters(t.text) && t.base <= r.y0 + 1 && r.y0 - t.base <= Math.max(6, t.size * 0.6) && t.x0 >= r.x0 - 1 && t.x1 <= r.x1 + 1);
    const row = over.filter(t => Math.abs(t.base - Math.max(...over.map(o => o.base))) <= 1).sort((a, b) => a.x0 - b.x0);
    if (row.length) entries.push({ color: r.color, dash: false, name: row.map(t => t.text).join(' '), tokens: row, swatch: r, box: { x0: r.x0, x1: r.x1, top: Math.min(...row.map(t => t.top)), bottom: r.y1 } });
  }
  // Round swatches (● West ● East).
  for (const d of shapes.dots || []) {
    if (d.x1 - d.x0 > 12 || d.y1 - d.y0 > 12 || (isWhite(d.color) && (d.x1 - d.x0 < 4 || d.y1 - d.y0 < 4))) continue;
    const parts = nameAfter(d.x1, (d.y0 + d.y1) / 2, 14);
    if (parts) entries.push({ color: d.color, dash: false, name: parts.map(t => t.text).join(' '), tokens: parts, swatch: d, box: { x0: d.x0, x1: parts.at(-1).x1, top: Math.min(d.y0, parts[0].top), bottom: Math.max(d.y1, parts[0].base) } });
  }
  // A swatch set as text (■ in the series colour).
  for (const t of tokens) {
    const color = t.items.length === 1 && t.items[0].color;
    if (!color || isWhite(color)) continue;
    const parts = nameAfter(t.x1, t.cy, 14);
    if (parts) entries.push({ color, dash: false, name: parts.map(x => x.text).join(' '), tokens: [t, ...parts], swatch: null, box: { x0: t.x0, x1: parts.at(-1).x1, top: Math.min(t.top, parts[0].top), bottom: Math.max(t.base, parts[0].base) } });
  }
  for (const l of shapes.lines) {
    const xs = l.pts.map(p => p[0]), ys = l.pts.map(p => p[1]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), len = x1 - x0;
    if (len < 5 || len > 45 || Math.max(...ys) - Math.min(...ys) > 1 || isWhite(l.color)) continue;
    const parts = nameAfter(x1, ys[0], 14);
    if (parts) entries.push({ color: l.color, dash: Boolean(l.dash), line: true, name: parts.map(t => t.text).join(' '), tokens: parts, swatch: { x0, x1, y0: ys[0] - 1, y1: ys[0] + 1 }, line: l, box: { x0, x1: parts.at(-1).x1, top: Math.min(ys[0], parts[0].top), bottom: Math.max(ys[0], parts[0].base) } });
  }
  // A line's key drawn as a thin filled bar longer than a box swatch (24 by 1.5 points), its name after it.
  for (const r of shapes.rects) {
    const w = r.x1 - r.x0, h = r.y1 - r.y0;
    if (w <= 24 || w > 45 || h > 3 || h < 0.3 || isWhite(r.color)) continue;
    const cy = (r.y0 + r.y1) / 2, parts = nameAfter(r.x1, cy, 14);
    if (parts) entries.push({ color: r.color, dash: false, line: r, name: parts.map(t => t.text).join(' '), tokens: parts, swatch: r, box: { x0: r.x0, x1: parts.at(-1).x1, top: Math.min(r.y0, parts[0].top), bottom: Math.max(r.y1, parts[0].base) } });
  }
  return entries;
}

// Colours a swatch and its series share, give or take the rounding of two drawings of one colour (#a5a5a5, #a6a6a6).
const rgbOf = c => (/^#[0-9a-f]{6}$/i.test(c || '') ? [1, 3, 5].map(k => parseInt(c.slice(k, k + 2), 16)) : null);
const colourGap = (a, b) => { const p = rgbOf(a), q = rgbOf(b); return p && q ? Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) + Math.abs(p[2] - q[2]) : a === b ? 0 : Infinity; };
const sameColour = (a, b) => a === b || colourGap(a, b) <= 12;

/** The legend name for a colour (and dash) nearest the plot, or null. */
function seriesName(legend, plot, color, dash, line) {
  const distance = e => Math.max(0, plot.x0 - e.box.x1, e.box.x0 - plot.x1) + Math.max(0, plot.top - e.box.bottom, e.box.top - plot.bottom);
  const matches = legend.filter(e => sameColour(e.color, color) && (!line || !e.line || e.dash === Boolean(dash))).sort((a, b) => distance(a) - distance(b) || colourGap(a.color, color) - colourGap(b.color, color));
  // The only entry of that colour on the page, or the nearest one.
  return matches.length && (matches.length === 1 || distance(matches[0]) < 400) ? matches[0] : null;
}

// ---------------------------------------------------------------------------------------------- the plot

/**
 * Gridlines or tick marks at the labels: where they are drawn is where the values are (a label can sit a point or
 * two off its tick). The axis's scale is refitted to them.
 */
function snapToGrid(axis, shapes) {
  const v = axis.vertical, near = v ? [axis.x0 - 30, axis.x1 + 30] : [axis.top - 30, axis.bottom + 30];
  const rules = [];
  for (const l of shapes.lines) {
    if (l.pts.length !== 2) continue;
    const [[ax, ay], [bx, by]] = l.pts;
    if (v && Math.abs(ay - by) < 0.5 && Math.max(ax, bx) >= near[0] && Math.min(ax, bx) <= near[1]) rules.push((ay + by) / 2);
    if (!v && Math.abs(ax - bx) < 0.5 && Math.max(ay, by) >= near[0] && Math.min(ay, by) <= near[1]) rules.push((ax + bx) / 2);
  }
  for (const r of shapes.rects) {
    if (v && r.y1 - r.y0 <= 1.5 && r.x1 >= near[0] && r.x0 <= near[1]) rules.push((r.y0 + r.y1) / 2);
    if (!v && r.x1 - r.x0 <= 1.5 && r.y1 >= near[0] && r.y0 <= near[1]) rules.push((r.x0 + r.x1) / 2);
  }
  // Each label's nearest line; labels may all sit a little above (or beside) their lines, by the same amount.
  const pos = t => (v ? t.cy : t.cx), reach = axis.gap * 0.45;
  const nearest = axis.ticks.map(t => {
    const best = rules.filter(p => Math.abs(p - pos(t)) <= reach).sort((a, b) => Math.abs(a - pos(t)) - Math.abs(b - pos(t)))[0];
    return best === undefined ? null : [best, t.num.value, best - pos(t)];
  }).filter(Boolean);
  const shift = median(nearest.map(m => m[2]));
  // (Labels read by OCR stand only roughly where they are drawn.)
  const read = axis.ticks.every(t => t.items?.every(i => i.ocr));
  const matched = nearest.filter(m => Math.abs(m[2] - shift) <= (read ? Math.max(1, axis.gap * 0.15) : 1));
  if (matched.length < Math.max(3, axis.ticks.length - 1)) return;
  const line = fit(matched);
  if (Math.sign(line.b) !== Math.sign(axis.b) || line.miss / Math.abs(line.b) > 1.2) return;
  axis.a = line.a;
  axis.b = line.b;
}

/** The plot an axis measures: the side its marks are on, how far they reach, and the marks themselves. */
function plotOf(axis, axes, shapes, page) {
  const v = axis.vertical;
  snapToGrid(axis, shapes);
  const lo = posOf(axis, axis.ticks[0].num.value), hi = posOf(axis, axis.ticks.at(-1).num.value);
  // Along the axis: the ticks' span, and the zero line just beyond it when zero isn't labelled.
  let from = lo - axis.gap * 0.6, to = hi + axis.gap * 0.6;
  const zero = posOf(axis, 0);
  if (zero > from - axis.gap * 1.6 && zero < to + axis.gap * 1.6) { from = Math.min(from, zero - axis.gap * 0.25); to = Math.max(to, zero + axis.gap * 0.25); }
  // Across: the side with marks next to the labels.
  const marks = [...shapes.rects.map(r => ({ ...r, kind: 'rect', rect: r })), ...shapes.lines.map(l => {
    const xs = l.pts.map(p => p[0]), ys = l.pts.map(p => p[1]);
    return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys), kind: 'line', line: l };
  })].filter(m => !isWhite(m.color ?? m.line?.color) || m.kind === 'line');
  const along = m => (v ? [m.y0, m.y1] : [m.x0, m.x1]), across = m => (v ? [m.x0, m.x1] : [m.y0, m.y1]);
  const inside = m => along(m)[1] >= from && along(m)[0] <= to;
  const edgeLow = v ? axis.x0 : axis.top, edgeHigh = v ? axis.x1 : axis.bottom;
  // How far the nearest mark is on each side (within 40 points).
  // Marks within 40 points of the labels, or two and a half tick steps on a roomy axis (a plot set well apart from its labels).
  const reachOut = Math.max(40, axis.gap * 2.5);
  const near = side => Math.min(reachOut + 1, ...marks.filter(m => inside(m) && !isWhite(m.color ?? m.line?.color) && Math.max(m.x1 - m.x0, m.y1 - m.y0) >= 1 && (side > 0 ? across(m)[0] >= edgeHigh - 3 : across(m)[1] <= edgeLow + 3)).map(m => (side > 0 ? across(m)[0] - edgeHigh : edgeLow - across(m)[1])));
  const after = near(1), before = near(-1);
  if (after > reachOut && before > reachOut) return null;
  // Labels set flush right sit left of their plot (and flush left, right of it); otherwise the side with the nearer marks.
  const side = axis.align && (axis.align > 0 ? after : before) <= reachOut ? axis.align : after <= before ? 1 : -1;
  // As far as the next axis on that side, or the page edge.
  let limit = side > 0 ? (v ? page.width : page.height) : 0;
  for (const other of axes) {
    if (other === axis || other.vertical !== v) continue;
    const oLo = v ? other.top : other.x0, oHi = v ? other.bottom : other.x1;
    if (oHi < from || oLo > to) continue;
    const oEdge = side > 0 ? (v ? other.x0 : other.top) : (v ? other.x1 : other.bottom);
    if (side > 0 ? oEdge > edgeHigh && oEdge < limit : oEdge < edgeLow && oEdge > limit) limit = oEdge;
  }
  const start = side > 0 ? edgeHigh : edgeLow;
  const candidates = marks.filter(m => inside(m) && (side > 0 ? across(m)[0] >= start - 3 && across(m)[1] <= limit : across(m)[1] <= start + 3 && across(m)[0] >= limit));
  // Gridlines at the ticks give the plot's extent; otherwise marks are gathered while they stay close together.
  const ticksAt = axis.ticks.map(t => posOf(axis, t.num.value));
  const grid = candidates.filter(m => m.kind === 'line' && Math.abs(along(m)[1] - along(m)[0]) < 1 && ticksAt.some(p => Math.abs(p - along(m)[0]) < 2)
    && (side > 0 ? across(m)[0] - start < 30 : start - across(m)[1] < 30));
  let reach;
  if (grid.length >= 2) {
    reach = side > 0 ? Math.max(...grid.map(m => across(m)[1])) : Math.min(...grid.map(m => across(m)[0]));
    // Panels side by side on one scale (2024 | 2025): gridlines that carry on where these end extend the plot.
    const level = m => m.kind === 'line' && Math.abs(along(m)[1] - along(m)[0]) < 1 && ticksAt.some(p => Math.abs(p - along(m)[0]) < 2);
    for (let more = true; more;) {
      const next = candidates.filter(m => level(m) && (side > 0 ? Math.abs(across(m)[0] - reach) <= 4 && across(m)[1] > reach + 20 : Math.abs(across(m)[1] - reach) <= 4 && across(m)[0] < reach - 20));
      more = next.length >= 2;
      if (more) reach = side > 0 ? Math.max(...next.map(m => across(m)[1])) : Math.min(...next.map(m => across(m)[0]));
    }
  } else {
    const sorted = [...candidates].sort((a, b) => side * (across(a)[side > 0 ? 0 : 1] - across(b)[side > 0 ? 0 : 1]));
    reach = start;
    const maxGap = Math.max(30, axis.gap * 1.5);
    for (const m of sorted) {
      const near0 = side > 0 ? across(m)[0] : across(m)[1];
      if (side * (near0 - reach) > (reach === start ? Math.max(maxGap, reachOut) : maxGap)) break;
      reach = side > 0 ? Math.max(reach, across(m)[1]) : Math.min(reach, across(m)[0]);
    }
  }
  if (Math.abs(reach - start) < 20) return null;
  const a0 = Math.min(start, reach), a1 = Math.max(start, reach);
  const box = v ? { x0: a0, x1: a1, top: from, bottom: to } : { x0: from, x1: to, top: a0, bottom: a1 };
  const within = m => m.x0 >= box.x0 - 2 && m.x1 <= box.x1 + 2 && m.y0 >= box.top - 2 && m.y1 <= box.bottom + 2;
  // Markers (dots, diamonds) in the plot, for charts of points.
  const dots = (shapes.dots || []).filter(d => d.x0 >= box.x0 - 2 && d.x1 <= box.x1 + 2 && d.y0 >= box.top - 4 && d.y1 <= box.bottom + 4);
  // Filled outlines across the plot (areas under lines).
  const fills = (shapes.fills || []).filter(f => !isWhite(f.color) && f.x0 >= box.x0 - 2 && f.x1 <= box.x1 + 2 && f.y0 >= box.top - 4 && f.y1 <= box.bottom + 4);
  // White pieces drawn in the plot (a stack's "None" between coloured pieces), for readBars to weigh.
  const paper = shapes.rects.filter(r => isWhite(r.color) && within(r)).map(r => ({ ...r, kind: 'rect', rect: r }));
  // Gridlines on the axis's steps beyond its last label (a label OCR missed, or one left off): the plot reaches the
  // last of them, and labels start beyond it.
  // (One across the plot as the gridlines at the labels are, from the same place to the same place, an axis line in
  // another colour too; a rule under the chart, across the column or a note, is not one of them.)
  const along0 = l => l.pts[0][v ? 1 : 0], from0 = l => Math.min(l.pts[0][v ? 0 : 1], l.pts[1][v ? 0 : 1]), to0 = l => Math.max(l.pts[0][v ? 0 : 1], l.pts[1][v ? 0 : 1]);
  const level = shapes.lines.filter(l => l.pts.length === 2 && Math.abs(l.pts[0][v ? 1 : 0] - l.pts[1][v ? 1 : 0]) < 0.5 && to0(l) - from0(l) >= (v ? box.x1 - box.x0 : box.bottom - box.top) * 0.5);
  const atLabels = level.filter(l => ticksAt.some(p => Math.abs(p - along0(l)) < 2));
  const onStep = p => { const k = (valueAt(axis, p) - axis.ticks[0].num.value) / axis.step; return Math.abs(k - Math.round(k)) <= 0.08; };
  const steps = level.filter(l => atLabels.some(g => g !== l && Math.abs(from0(g) - from0(l)) <= 3 && Math.abs(to0(g) - to0(l)) <= 3))
    .map(along0).filter(p => onStep(p) && p >= Math.min(lo, hi) - axis.gap * 1.1 - 0.5 && p <= Math.max(lo, hi) + axis.gap * 1.1 + 0.5);
  const gridEnd = steps.length ? (v ? Math.max(...steps) : Math.min(...steps)) : null;
  return { box, side, zero, marks: candidates.filter(within), dots, fills, paper, ...(gridEnd != null && { gridEnd }) };
}

// ---------------------------------------------------------------------------------------------- bars

/** Bars of a plot read through its axis: stacks of rectangles that start at zero, grouped into categories. */
function readBars(axis, plot, legend) {
  const v = axis.vertical, { box } = plot;
  let { zero } = plot;
  const span = v ? box.x1 - box.x0 : box.bottom - box.top;
  const swatches = new Set(legend.map(e => e.swatch));
  const c0 = r => (v ? r.x0 : r.y0), c1 = r => (v ? r.x1 : r.y1), l0 = r => (v ? r.y0 : r.x0), l1 = r => (v ? r.y1 : r.x1);
  const fits = r => { const width = c1(r) - c0(r); return width >= 1 && width <= Math.min(Math.max(80, span * 0.2), span * (axis.implied ? 0.5 : 0.2)) && l1(r) - l0(r) >= 0.3; };
  const coloured = plot.marks.filter(m => m.kind === 'rect' && !swatches.has(m.rect) && !isPaper(m.color)).filter(fits);
  // A white piece of a stack ("None" between coloured pieces): as wide as a coloured piece and touching it end to end.
  const white = [...plot.marks, ...(plot.paper || [])].filter(m => m.kind === 'rect' && !swatches.has(m.rect) && isWhite(m.color) && fits(m)
    && coloured.some(q => Math.abs(c0(q) - c0(m)) <= 0.8 && Math.abs(c1(q) - c1(m)) <= 0.8 && (Math.abs(l0(q) - l1(m)) <= 1 || Math.abs(l1(q) - l0(m)) <= 1)));
  const shaped = [...coloured, ...white];
  // A band behind bars (a highlighted category) holds another bar within it: it's background.
  const rects = shaped.filter(r => !shaped.some(q => q !== r && c0(q) >= c0(r) - 0.5 && c1(q) <= c1(r) + 0.5 && c1(q) - c0(q) < c1(r) - c0(r) - 0.5 && Math.min(l1(q), l1(r)) - Math.max(l0(q), l0(r)) > 0));
  if (rects.length < 2) return null;
  // The bars' own base line, where labels set a little off their ticks put zero a point or two away.
  const edges = rects.flatMap(r => (v ? [r.y0, r.y1] : [r.x0, r.x1])).filter(e => Math.abs(e - zero) <= Math.max(2, axis.gap * 0.2));
  const counted = edges.map(e => [e, edges.filter(f => Math.abs(f - e) <= 0.6).length]).filter(([, n]) => n >= 2);
  // With no negative values on the axis, the base is the outermost shared edge (a sliver drawn under the bars is a
  // value, not below zero); otherwise the edge most bars share.
  const below = v ? 1 : -1;
  const shared = axis.min >= 0 && counted.length ? counted.sort((a, b) => below * (b[0] - a[0]))[0]
    : counted.sort((a, b) => b[1] - a[1] || Math.abs(a[0] - zero) - Math.abs(b[0] - zero))[0];
  if (shared) zero = shared[0];
  // Bars standing on a line other than zero (an index at 100, a scale cut short at its foot): the edge most of them
  // share, at one of the axis's ticks. Their values are read where they end.
  let offset = 0;
  if (!shared) {
    const all = rects.flatMap(r => (v ? [r.y0, r.y1] : [r.x0, r.x1]));
    const best = all.map(e => [e, all.filter(f => Math.abs(f - e) <= 0.6).length]).sort((a, b) => b[1] - a[1])[0];
    const atTick = best && axis.ticks.some(t => Math.abs(posOf(axis, t.num.value) - best[0]) <= Math.max(2, axis.gap * 0.1));
    if (best && best[1] >= Math.max(3, rects.length * 0.6) && atTick) { zero = best[0]; offset = valueAt(axis, zero); }
  }
  // Stacks: rectangles sharing the same extent across the axis.
  const stacks = [];
  for (const r of rects) {
    const c0 = v ? r.x0 : r.y0, c1 = v ? r.x1 : r.y1;
    let s = stacks.find(k => Math.abs(k.c0 - c0) <= 0.8 && Math.abs(k.c1 - c1) <= 0.8);
    if (!s) stacks.push(s = { c0, c1, rects: [] });
    s.rects.push(r);
  }
  const bars = [];
  for (const s of stacks) {
    // Chain outwards from zero on each side; a stack that doesn't start at zero isn't read.
    const a0 = r => (v ? r.y0 : r.x0), a1 = r => (v ? r.y1 : r.x1);
    const segments = [];
    // Stacks drawn as layers, each from zero, the tallest first: what shows of each layer is its part above the next.
    const fromZero = s.rects.every(r => Math.abs(a1(r) - zero) <= 1.5) || s.rects.every(r => Math.abs(a0(r) - zero) <= 1.5);
    const reach = r => Math.max(Math.abs(a0(r) - zero), Math.abs(a1(r) - zero));
    if (s.rects.length > 1 && fromZero && s.rects.every((r, k) => !k || reach(r) <= reach(s.rects[k - 1]) + 0.3)) {
      const shown = [];
      for (const r of s.rects) { const same = shown.findIndex(q => Math.abs(reach(q) - reach(r)) <= 0.3); if (same >= 0) shown[same] = r; else shown.push(r); }
      shown.reverse();
      const up = Math.abs(a1(shown[0]) - zero) <= 1.5 ? -1 : 1;
      let at = zero;
      const layers = shown.map(r => {
        const far = zero + up * reach(r), part = { ...r, ...(v ? { y0: Math.min(at, far), y1: Math.max(at, far) } : { x0: Math.min(at, far), x1: Math.max(at, far) }) };
        at = far;
        return part;
      });
      bars.push({ c0: s.c0, c1: s.c1, segments: layers.map(r => {
        const far = up < 0 ? a0(r) : a1(r), near = up < 0 ? a1(r) : a0(r);
        return { rect: r, color: r.color, value: valueAt(axis, far) - valueAt(axis, near) + (Math.abs(near - zero) <= 1.5 ? offset : 0), far, near };
      }) });
      continue;
    }
    for (const dir of [-1, 1]) { // -1: towards smaller page coordinate (up, or left)
      let at = zero;
      const pool = s.rects.filter(r => (dir < 0 ? a1(r) <= zero + 1.5 : a0(r) >= zero - 1.5));
      for (;;) {
        const next = pool.find(r => !segments.includes(r) && Math.abs((dir < 0 ? a1(r) : a0(r)) - at) <= 1.5);
        if (!next) break;
        segments.push(next);
        at = dir < 0 ? a0(next) : a1(next);
      }
    }
    if (!segments.length) continue;
    if (segments.length !== s.rects.length) return null; // pieces that float: not a bar chart we can read
    bars.push({ c0: s.c0, c1: s.c1, segments: segments.map(r => {
      const far = Math.abs(a0(r) - zero) > Math.abs(a1(r) - zero) ? a0(r) : a1(r), near = far === a0(r) ? a1(r) : a0(r);
      return { rect: r, color: r.color, value: valueAt(axis, far) - valueAt(axis, near) + (Math.abs(near - zero) <= 1.5 ? offset : 0), far, near };
    }) });
  }
  if (bars.length < 2) return null;
  // Little squares (the markers of a line chart) aren't bars.
  const lengths = bars.map(b => b.segments.reduce((n, s) => n + Math.abs(s.far - s.near), 0));
  if (median(lengths) < median(bars.map(b => b.c1 - b.c0)) * 1.5 && Math.max(...lengths) <= median(bars.map(b => b.c1 - b.c0)) * 2 && median(bars.map(b => b.c1 - b.c0)) <= 8 && plot.marks.some(m => m.kind === 'line' && m.line.pts.length >= 3)) return null;
  bars.sort((a, b) => a.c0 - b.c0);
  // Slices of one height and colour, edge to edge, are a band drawn behind the plot (a period highlighted), not bars.
  const sameLength = lengths.every(n => Math.abs(n - lengths[0]) <= Math.max(0.5, lengths[0] * 0.01));
  if (bars.length >= 3 && sameLength && new Set(bars.map(b => b.segments[0].color)).size === 1 && bars.slice(1).every((b, i) => b.c0 - bars[i].c1 <= 0.5)) return null;
  const stacked = bars.some(b => b.segments.length > 1);
  // Categories: bars side by side (one per series) form a group.
  const width = median(bars.map(b => b.c1 - b.c0));
  const groups = [];
  // Bars of one group stand closer together than the groups do (when the series have more than one colour).
  const gaps = bars.slice(1).map((b, i) => b.c0 - bars[i].c1), widest = Math.max(0, ...gaps);
  const colours = new Set(bars.map(b => b.segments[0].color)).size;
  for (const [i, b] of bars.entries()) {
    const g = groups.at(-1), color = b.segments[0].color, gap = i ? gaps[i - 1] : Infinity;
    if (g && !stacked && (gap <= width * 0.35 || (colours > 1 && gap < widest * 0.6)) && !g.bars.some(x => x.segments[0].color === color)) { g.bars.push(b); g.c1 = b.c1; }
    else groups.push({ c0: b.c0, c1: b.c1, bars: [b] });
  }
  return { bars, groups, stacked };
}

/** Labels of categories: text beyond the plot's base (under the bars, or left of them), in each group's slot. */
function categoryLabels(axis, plot, slots, tokens, taken, base) {
  const v = axis.vertical;
  // Beside horizontal bars, labels centred in a column (a short "Overall" over "Technology/IT consulting") may end
  // well short of the bars: lines centred where the others are (or starting or ending where they do) count too.
  const column = { centres: [], starts: [], ends: [] };
  const first = slots.map(slot => readLabel(slot, null));
  if (v || first.every(Boolean) || !column.centres.length) return first;
  const col = { centre: median(column.centres), start: median(column.starts), end: median(column.ends) };
  return slots.map((slot, i) => first[i] || readLabel(slot, col));
  function readLabel([s0, s1], col) {
    const inSlot = tokens.filter(t => !taken.has(t) && !(t.num && axis.ticks.includes(t))).filter(t => {
      if (v) {
        // A label may start a little above the bars' drawn base (bars with rounded ends drawn a few points long).
        if (t.box.top < base - Math.max(2, t.size * 0.5) || t.box.top > base + t.size * 2.5) return false;
        const x = t.angle ? t.ends.sort((a, b) => a[1] - b[1])[0][0] : t.cx;
        return x >= s0 && x <= s1;
      }
      if (t.angle || t.box.x1 > base + 2 || t.box.x1 < base - 400) return false;
      return t.cy >= s0 && t.cy <= s1;
    });
    if (!inSlot.length) return null;
    if (v && inSlot.some(t => t.angle)) {
      const t = inSlot.filter(x => x.angle).sort((a, b) => Math.min(...a.ends.map(e => e[1])) - Math.min(...b.ends.map(e => e[1])))[0];
      return { text: t.text, tokens: [t], first: [t] };
    }
    // Lines of one label, nearest the plot first; a wide gap ends it.
    const sorted = [...inSlot].sort((a, b) => a.top - b.top || a.x0 - b.x0);
    let lines = [];
    for (const t of sorted) {
      const line = lines.find(l => Math.abs(l[0].base - t.base) <= 1.5);
      if (line) line.push(t); else lines.push([t]);
    }
    if (v) {
      const kept = [lines[0]];
      // A label carries on to the next line only in words (a stray figure under it is a footnote mark).
      // (A line running far wider than the slot is a note under the chart, not the label's next line.)
      const wide = l => Math.max(...l.map(t => t.box.x1)) - Math.min(...l.map(t => t.box.x0)) > Math.max(s1 - s0, 1) * 2.5;
      for (const l of lines.slice(1)) { if (l[0].top - kept.at(-1)[0].base > l[0].size * 0.8 || !l.some(t => hasLetters(t.text)) || wide(l)) break; kept.push(l); }
      lines = kept;
    } else {
      // Beside horizontal bars: of each line, the words that run up to the plot (not text further left).
      lines = lines.map(l => {
        const sorted = l.sort((a, b) => b.x1 - a.x1), run = [sorted[0]];
        for (const t of sorted.slice(1)) { if (run.at(-1).x0 - t.x1 > t.size * 1.5) break; run.push(t); }
        return run;
      });
      const x0 = l => Math.min(...l.map(t => t.x0)), x1 = l => Math.max(...l.map(t => t.x1));
      let anchors = lines.filter(l => base - x1(l) < 40);
      if (!anchors.length && col) {
        const near = lines.filter(l => Math.abs((x0(l) + x1(l)) / 2 - col.centre) <= 3 || Math.abs(x0(l) - col.start) <= 3 || Math.abs(x1(l) - col.end) <= 3).sort((a, b) => x1(b) - x1(a));
        anchors = near.slice(0, 1);
      }
      if (!anchors.length) return null;
      if (!col) for (const l of anchors) { column.centres.push((x0(l) + x1(l)) / 2); column.starts.push(x0(l)); column.ends.push(x1(l)); }
      // Lines of the same label just above or below, lined up on the left or the right.
      const kept = new Set(anchors);
      for (let grew = true; grew;) {
        grew = false;
        for (const l of lines) {
          if (kept.has(l)) continue;
          if ([...kept].some(k => Math.abs(l[0].base - k[0].base) <= l[0].size * 1.6 && (Math.abs(x0(l) - x0(k)) <= 3 || Math.abs(x1(l) - x1(k)) <= 3))) { kept.add(l); grew = true; }
        }
      }
      lines = lines.filter(l => kept.has(l));
    }
    const text = lines.map(l => l.sort((a, b) => a.x0 - b.x0).map(t => t.text).join(' ')).join(' ').replace(/(\s*\.){3,}\s*$/, '').replace(/(\w)- (\w)/g, '$1$2').trim();
    return text ? { text, tokens: lines.flat(), first: lines[0] } : null;
  }
}

/**
 * A second row of category labels under the first (countries under "Dec 2023 … May 2024", repeated for each), each
 * spanning a run of bars: the name of each slot's run, or null. Only where the first labels repeat (otherwise a
 * second line is the rest of a label, or a note).
 */
/**
 * Group names left of the labels of horizontal bars ("Northern Europe" by Finland, Denmark ... UK; "Western Europe"
 * by Netherlands ... France), each set level with the first bar of its group, maybe on two lines: each bar's label
 * says both, its group's name first. Two groups at least, each over bars of its own.
 */
function sideLabels(slots, labels, tokens, taken) {
  const own = new Set(labels.filter(Boolean).flatMap(l => l.tokens));
  if (own.size < 2) return null;
  const left = Math.min(...[...own].map(t => t.box.x0)), size = median([...own].map(t => t.size));
  const from = Math.min(...slots.map(s => s[0])) - size, to = Math.max(...slots.map(s => s[1])) + size;
  const words = tokens.filter(t => !taken.has(t) && !own.has(t) && !t.angle && !t.num && hasLetters(t.text) && t.box.x1 <= left - size * 0.5 && left - t.box.x1 <= 200 && t.cy >= from && t.cy <= to)
    .sort((a, b) => a.top - b.top || a.x0 - b.x0);
  if (words.length < 2) return null;
  // Lines of words, then names: a line just under another, starting where it starts, carries it on.
  const lines = [];
  for (const t of words) { const l = lines.find(x => Math.abs(x[0].base - t.base) <= 1.5 && t.x0 - x.at(-1).x1 <= t.size * 1.2); if (l) l.push(t); else lines.push([t]); }
  const names = [];
  for (const l of lines.sort((a, b) => a[0].top - b[0].top)) {
    const n = names.at(-1), prev = n?.at(-1);
    if (prev && Math.abs(l[0].x0 - prev[0].x0) <= 3 && l[0].top - prev[0].base <= l[0].size * 0.8) n.push(l); else names.push([l]);
  }
  if (names.length < 2) return null;
  // The column of names stands apart: all start at one place (left-aligned) or end at one place (right-aligned).
  const x0s = names.map(n => n[0][0].x0), x1s = names.map(n => Math.max(...n.map(l => l.at(-1).x1)));
  if (Math.max(...x0s) - Math.min(...x0s) > 3 && Math.max(...x1s) - Math.min(...x1s) > 3) return null;
  // Each name is level with the first bar of its run; its run goes on to the next name.
  const centre = s => (s[0] + s[1]) / 2, pitch = median(slots.slice(1).map((s, i) => Math.abs(centre(s) - centre(slots[i])))) || size;
  const order = slots.map((s, i) => i).sort((a, b) => centre(slots[a]) - centre(slots[b]));
  const firstAt = names.map(n => order.findIndex(i => Math.abs(centre(slots[i]) - n[0][0].cy) <= Math.max(pitch * 0.6, size)));
  if (firstAt.some(k => k < 0) || firstAt.some((k, j) => j && k <= firstAt[j - 1]) || firstAt[0] !== 0) return null;
  const out = new Array(slots.length).fill(null);
  firstAt.forEach((k, j) => { for (let m = k; m < (firstAt[j + 1] ?? order.length); m++) out[order[m]] = j; });
  const text = names.map(n => n.map(l => l.map(t => t.text).join(' ')).join(' '));
  return { names: out.map(j => text[j]), tokens: names.flat(2) };
}

function outerLabels(slots, labels, tokens, taken, top = null) {
  const inner = labels.filter(l => l?.first);
  const texts = inner.map(l => l.first.map(t => t.text).join(' '));
  if (inner.length < 2 || new Set(texts).size === texts.length) return null;
  const own = new Set(inner.flatMap(l => l.first));
  if (!own.size) return null;
  const bottom = Math.max(...[...own].map(t => t.box.bottom)), size = median([...own].map(t => t.size));
  const from = slots[0][0] - 10, to = slots.at(-1)[1] + 10;
  // Under the first labels; or, given the plot's top, over the plot (a heading over each run of bars: 2024, 2025).
  const below = top == null ? tokens.filter(t => !taken.has(t) && !own.has(t) && !t.angle && t.box.top >= bottom - 1 && t.box.top <= bottom + Math.max(size, t.size) * 3 && t.cx >= from && t.cx <= to)
    .sort((a, b) => a.top - b.top || a.x0 - b.x0)
    : tokens.filter(t => !taken.has(t) && !own.has(t) && !t.angle && !t.tick && t.base <= top + 2 && top - t.base <= Math.max(size, t.size) * 3 && t.cx >= from && t.cx <= to)
      .sort((a, b) => b.base - a.base || a.x0 - b.x0);
  if (!below.length) return null;
  // The first line, split where words stand apart; lines under it join the name they sit under.
  const first = below.filter(t => Math.abs(t.base - below[0].base) <= 1.5).sort((a, b) => a.x0 - b.x0);
  const names = [];
  for (const t of first) { const n = names.at(-1); if (n && t.x0 - n.at(-1).x1 <= t.size * 1.2) n.push(t); else names.push([t]); }
  if (names.length < 2) return null;
  const spans = names.map(n => ({ x0: n[0].x0, x1: n.at(-1).x1, words: [...n] }));
  let last = first;
  for (;;) {
    if (top != null) break;
    const next = below.filter(t => t.top > last[0].base - 1 && t.top - last[0].base <= last[0].size * 0.8 && !spans.some(s => s.words.includes(t)));
    if (!next.length) break;
    const line = next.filter(t => Math.abs(t.base - next[0].base) <= 1.5).sort((a, b) => a.x0 - b.x0);
    let joined = false;
    for (const t of line) {
      const s = spans.find(p => t.cx >= p.x0 - 3 && t.cx <= p.x1 + 3);
      if (s) { s.words.push(t); joined = true; }
    }
    if (!joined) break;
    last = line;
  }
  const centres = spans.map(s => (s.x0 + s.x1) / 2);
  const runOf = slot => {
    const c = (slot[0] + slot[1]) / 2;
    let k = 0;
    while (k < centres.length - 1 && c > (centres[k] + centres[k + 1]) / 2) k++;
    return k;
  };
  const runs = slots.map(runOf);
  // Each name over two or more bars, one or more of them labelled.
  if (spans.some((s, k) => runs.filter(r => r === k).length < 2 || !runs.some((r, i) => r === k && labels[i]))) return null;
  // The first labels repeat run after run (the same quarters under each year), none twice in one run; the first and
  // last runs may hold only part of them (a series starting in Q3, or ending in Q2).
  const firstOf = l => l?.first?.map(t => t.text).join(' ');
  const pattern = spans.map((s, k) => slots.map((x, i) => (runs[i] === k ? firstOf(labels[i]) : null)).filter(Boolean).join('\u0001'));
  const full = pattern.reduce((a, b) => (b.length > a.length ? b : a));
  const within = p => `\u0001${full}\u0001`.includes(`\u0001${p}\u0001`);
  if (pattern.some(p => new Set(p.split('\u0001')).size !== p.split('\u0001').length) || pattern.some((p, k) => p !== full && (!within(p) || (k > 0 && k < pattern.length - 1)))) return null;
  const text = spans.map(s => s.words.map(t => t.text).join(' '));
  return { names: runs.map(k => text[k]), tokens: spans.flatMap(s => s.words) };
}

/** Labels set above a chart's zero line, one per slot: the lines of text just above it, nearest first, read top down. */
function labelsAbove(slots, tokens, taken, top) {
  return slots.map(([s0, s1]) => {
    const near = tokens.filter(t => !taken.has(t) && !t.angle && t.base <= top + 2 && t.base >= top - t.size * 5 && t.cx >= s0 && t.cx <= s1);
    if (!near.length) return null;
    const lines = [];
    for (const t of near.sort((a, b) => b.base - a.base || a.x0 - b.x0)) {
      const line = lines.find(l => Math.abs(l[0].base - t.base) <= 1.5);
      if (line) line.push(t); else lines.push([t]);
    }
    const kept = [lines[0]];
    for (const l of lines.slice(1)) { if (kept.at(-1)[0].top - l[0].base > l[0].size * 0.8) break; kept.push(l); }
    const text = kept.reverse().map(l => l.sort((a, b) => a.x0 - b.x0).map(t => t.text).join(' ')).join(' ').trim();
    return text && hasLetters(text) ? { text, tokens: kept.flat() } : null;
  });
}

/** Numbers printed at the end of (or on) each bar, when they agree with the measured value. */
function printedValues(axis, groups, tokens, taken) {
  const v = axis.vertical, range = axis.max - axis.min;
  const free = tokens.filter(t => t.num && !t.angle && !taken.has(t) && !axis.ticks.includes(t));
  const claims = [];
  for (const g of groups) for (const b of g.bars) for (const seg of b.segments) {
    const r = seg.rect, far = seg.far, outward = Math.sign(far - seg.near) || -1;
    for (const t of free) {
      const across = v ? t.cx : t.cy, c0 = v ? r.x0 : r.y0, c1 = v ? r.x1 : r.y1;
      if (across < c0 - 1.5 || across > c1 + 1.5) continue;
      const t0 = v ? t.top : t.x0, t1 = v ? t.base : t.x1;
      const inside = t0 >= Math.min(far, seg.near) - 1 && t1 <= Math.max(far, seg.near) + 1;
      // Beyond a piece's end only when no other piece of the stack goes on from there (that number is the next piece's).
      const capped = b.segments.some(o => o !== seg && Math.abs(o.near - far) <= 1 && Math.sign(o.far - o.near) === outward);
      const beyond = !capped && (outward < 0 ? t1 <= far + 1 && far - t1 <= t.size * 1.2 + 2 : t0 >= far - 1 && t0 - far <= t.size * 1.2 + 2);
      if (!inside && !beyond) continue;
      // (A scale worked out from the printed numbers themselves is only roughly right: a printed number in its piece
      // may be further from the measure.)
      if (Math.abs(t.num.value - seg.value) > (axis.implied && inside ? range * 0.15 : Math.max(range * 0.06, axis.step * 0.3))) continue;
      claims.push({ seg, t, d: Math.abs(across - (c0 + c1) / 2) + Math.abs((outward < 0 ? t1 : t0) - far) });
    }
  }
  claims.sort((a, b) => a.d - b.d);
  const used = new Set();
  for (const { seg, t } of claims) {
    if (seg.printed || used.has(t)) continue;
    seg.printed = t;
    used.add(t);
  }
}

// ---------------------------------------------------------------------------------------------- lines

/** Lines drawn across the plot (not gridlines, ticks or arrows), joined where pieces meet, one per colour and dash. */
function plotLines(plot, legend) {
  const swatchLines = new Set(legend.filter(e => e.line).map(e => e.line));
  const keyed = new Map();
  for (const m of plot.marks) if (m.kind === 'line' && !swatchLines.has(m.line) && !isWhite(m.line.color)) {
    // (Dashed lines of one colour but different dash patterns are different series.)
    const key = `${m.line.color}|${m.line.dash || ''}`;
    if (!keyed.has(key)) keyed.set(key, []);
    keyed.get(key).push(m.line.pts.map(p => [...p]));
  }
  const width = plot.box.x1 - plot.box.x0, out = [];
  for (const [key, list] of keyed) {
    // Join pieces end to start.
    const chains = [];
    for (const pts of list.sort((a, b) => Math.min(...a.map(p => p[0])) - Math.min(...b.map(p => p[0])))) {
      const ordered = pts[0][0] <= pts.at(-1)[0] ? pts : [...pts].reverse();
      const chain = chains.find(c => Math.abs(c.at(-1)[0] - ordered[0][0]) < 0.6 && Math.abs(c.at(-1)[1] - ordered[0][1]) < 0.6);
      if (chain) chain.push(...ordered.slice(1)); else chains.push(ordered);
    }
    const runs = chains.filter(c => new Set(c.map(p => Math.round(p[0] * 2))).size >= 2 && c.every((p, k) => !k || p[0] >= c[k - 1][0] - 0.3));
    // Pieces of one colour that follow each other left to right with gaps between them (missing data) are one line.
    runs.sort((a, b) => a[0][0] - b[0][0]);
    const joined = runs.length > 1 && runs.every((c, k) => !k || c[0][0] >= runs[k - 1].at(-1)[0] - 0.5) ? [runs.flat()] : runs;
    const series = joined.filter(c => {
      if (new Set(c.map(p => Math.round(p[0] * 2))).size < 3) return false;
      const xs = c.map(p => p[0]), ys = c.map(p => p[1]);
      return Math.max(...xs) - Math.min(...xs) >= width * 0.2 && Math.max(...ys) - Math.min(...ys) >= 0.5;
    });
    if (series.length !== 1) continue; // two lines of one colour can't be told apart
    const [color, pattern] = key.split('|');
    out.push({ color, dash: pattern || false, pts: series[0] });
  }
  return out;
}

/**
 * Lines drawn a piece at a time (each segment its own path): pieces of one colour that meet end to start (or
 * nearly, around a marker at the point), joined left to right. [{color, pts}]
 */
function chained(lines) {
  const out = [];
  const byColour = new Map();
  // (Closed outlines, the markers' rings, aren't pieces of a line.)
  for (const l of lines) if (l.pts.length >= 2 && !(l.pts.length > 2 && Math.hypot(l.pts[0][0] - l.pts.at(-1)[0], l.pts[0][1] - l.pts.at(-1)[1]) < 0.5)) { if (!byColour.has(l.color)) byColour.set(l.color, []); byColour.get(l.color).push(l.pts[0][0] <= l.pts.at(-1)[0] ? l.pts : [...l.pts].reverse()); }
  for (const [color, list] of byColour) {
    if (list.length > 2000) continue;
    const chains = [];
    for (const pts of list.sort((a, b) => a[0][0] - b[0][0])) {
      // (A gap the size of a marker drawn at the point is still a join.)
      const gap = c => Math.hypot(c.at(-1)[0] - pts[0][0], c.at(-1)[1] - pts[0][1]);
      const chain = chains.filter(c => pts[0][0] >= c.at(-1)[0] - 0.5 && gap(c) <= 12).sort((a, b) => gap(a) - gap(b))[0];
      // Across a gap (a marker between the pieces) the point is the middle of the gap.
      if (chain && gap(chain) > 0.8) { const end = chain.pop(); chain.push([(end[0] + pts[0][0]) / 2, (end[1] + pts[0][1]) / 2], ...pts.slice(1)); }
      else if (chain) chain.push(...pts.slice(1)); else chains.push([...pts]);
    }
    for (const pts of chains) out.push({ color, pts });
  }
  return out;
}

/**
 * Line charts drawn without a value axis, a number printed at each point: a line of three or more points, left to
 * right, with a number beside nearly every point, the numbers rising as the points do (in proportion, within a
 * few percent of their range). The printed numbers are the values, under the labels along its bottom.
 */
function impliedLineCharts(tokens, shapes, legend, taken, inChart) {
  const charts = [];
  const nums = tokens.filter(t => t.num && !t.angle && !isYear(t.num) && !t.tick && !taken.has(t));
  if (nums.length < 3) return charts;
  // (A curved line's own points are its knots, not the points followed along its curves.)
  for (const l of chained(shapes.lines.filter(x => !isWhite(x.color) && !x.dash && (x.knots || x.pts).length <= 400).map(x => (x.knots ? { ...x, pts: x.knots } : x)))) {
    if (l.pts.length < 3) continue;
    const pts = l.pts;
    if (!pts.every((p, k) => !k || p[0] > pts[k - 1][0] + 2)) continue;
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
    const box = { x0: Math.min(...xs), x1: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys) };
    if (box.x1 - box.x0 < 60 || box.bottom - box.top < 3 || inChart({ x0: box.x0, x1: box.x1, y0: box.top, y1: box.bottom })) continue;
    const used = new Set(), matched = [];
    for (const [x, y] of pts) {
      const t = nums.filter(n => !used.has(n) && !taken.has(n) && Math.abs(n.cx - x) <= Math.max((n.x1 - n.x0) * 0.75, n.size * 2) && Math.abs(n.cy - y) <= n.size * 2.5)
        .sort((a, b) => Math.hypot(a.cx - x, a.cy - y) - Math.hypot(b.cx - x, b.cy - y))[0];
      if (t) { used.add(t); matched.push({ x, y, t }); }
    }
    if (matched.length < 3 || matched.length < pts.length * 0.8) continue;
    const values = matched.map(m => m.t.num.value), range = Math.max(...values) - Math.min(...values);
    const line = fit(matched.map(m => [m.y, m.t.num.value]));
    if (!(line.b < 0) || !(range > 0) || line.miss > range * 0.08) continue;
    const trial = new Set([...taken, ...used]);
    const base = Math.max(box.bottom, ...matched.map(m => m.t.base));
    const plot = { box: { x0: box.x0 - 10, x1: box.x1 + 10, top: box.top, bottom: base } };
    const cats = lineCategories(plot, tokens, trial, null, base);
    if (!cats) continue;
    const spacing = (box.x1 - box.x0) / Math.max(1, pts.length - 1);
    const rows = [];
    for (const c of cats.labels) {
      const m = matched.filter(q => Math.abs(q.x - c.x) <= spacing * 0.5).sort((a, b) => Math.abs(a.x - c.x) - Math.abs(b.x - c.x))[0];
      if (m) rows.push([c.text, m.t.text.replace(/\s+/g, '')]);
    }
    const entry = seriesName(legend, plot.box, l.color, false, true);
    const chart = { kind: 'line', box: boxOf([plot.box, ...cats.labels.map(c => c.token.box), ...matched.map(m => m.t.box)]), series: [entry?.name || 'Value'], rows, categories: rows.map(r => r[0]), measured: false };
    if (rows.length < 3 || rows.length < matched.length * 0.8 || !solid(chart)) continue;
    cats.labels.forEach(c => trial.add(c.token));
    entry?.tokens.forEach(t => trial.add(t));
    const title = titleAbove(chart.box.top, chart.box, tokens, trial);
    if (title) { chart.title = title.text; title.tokens.forEach(t => trial.add(t)); }
    trial.forEach(t => taken.add(t));
    chart.box = { x0: round(chart.box.x0), x1: round(chart.box.x1), top: round(chart.box.top), bottom: round(chart.box.bottom) };
    charts.push(chart);
  }
  return charts;
}

/**
 * Areas (filled outlines across the plot, at least a fifth of its width, not bars): each a series whose value at a
 * point is its height there, from its lower edge to its upper one, measured on the axis, so stacked areas read as
 * their own values and an area standing on zero as its top. Read at the outline's corners. Two areas of one colour
 * can't be told apart and are left out. As lines: {color, pts} with each point at its value's height.
 */
function areaSeries(axis, plot) {
  const width = plot.box.x1 - plot.box.x0;
  const list = (plot.fills || []).filter(f => f.x1 - f.x0 >= width * 0.2 && f.pts.length >= 5 && f.pts.length <= 2000 && !boxy(f));
  const out = [];
  for (const f of list) {
    if (list.some(g => g !== f && sameColour(g.color, f.color))) continue;
    // The outline's edges crossed by an upright line at x: its highest and lowest crossing.
    const span = x => {
      let top = Infinity, bottom = -Infinity;
      for (let k = 1; k < f.pts.length; k++) {
        const [ax, ay] = f.pts[k - 1], [bx, by] = f.pts[k];
        if (x < Math.min(ax, bx) - 0.01 || x > Math.max(ax, bx) + 0.01) continue;
        const y = Math.abs(bx - ax) < 0.01 ? null : ay + (by - ay) * (x - ax) / (bx - ax);
        for (const v of y === null ? [ay, by] : [y]) { if (v < top) top = v; if (v > bottom) bottom = v; }
      }
      return top <= bottom ? [top, bottom] : null;
    };
    const xs = [...new Set(f.pts.map(p => Math.round(p[0] * 2) / 2))].sort((a, b) => a - b);
    const pts = [];
    for (const x of xs) {
      const s = span(x);
      if (s) pts.push([x, posOf(axis, valueAt(axis, s[0]) - valueAt(axis, s[1]) + valueAt(axis, posOf(axis, 0)))]);
    }
    if (pts.length >= 2) out.push({ color: f.color, dash: false, pts, area: true });
  }
  return out;
}

/** The line's height at x, between its points; null outside it. */
function lineAt(pts, x) {
  if (x < pts[0][0] - 0.5 || x > pts.at(-1)[0] + 0.5) return null;
  for (let k = 1; k < pts.length; k++) {
    const [ax, ay] = pts[k - 1], [bx, by] = pts[k];
    if (x <= bx + 0.5) return bx - ax < 0.01 ? by : ay + (by - ay) * Math.min(1, Math.max(0, (x - ax) / (bx - ax)));
  }
  return pts.at(-1)[1];
}

/** Labels along the bottom of a line chart: years (read as a scale) or category names (read where they stand). */
function lineCategories(plot, tokens, taken, axis, base) {
  const { box } = plot;
  const below = tokens.filter(t => !taken.has(t) && !t.tickV && t.box.top >= base - 2 && t.box.top <= base + 45
    && (t.angle ? t.box.x1 >= box.x0 - 20 && t.box.x0 <= box.x1 + 5 : t.cx >= box.x0 - 10 && t.cx <= box.x1 + 10));
  if (!below.length) return null;
  // Years along the axis when there are some; otherwise the rotated labels, or the first row of labels.
  const yearTokens = below.filter(t => isYear(t.num));
  const firstRow = yearTokens.length >= 3 ? yearTokens : below.some(t => t.angle) ? below.filter(t => t.angle) : (() => {
    const top = Math.min(...below.map(t => t.top));
    return below.filter(t => t.top - top < t.size * 0.8);
  })();
  const at = t => (t.angle ? t.ends.sort((a, b) => a[1] - b[1])[0][0] : t.cx);
  const labels = firstRow.map(t => ({ text: t.text, x: at(t), token: t })).sort((a, b) => a.x - b.x);
  if (labels.length < 2) return null;
  const years = labels.every(l => isYear(l.token.num));
  if (years) {
    const line = fit(labels.map(l => [l.x, l.token.num.value]));
    const spacing = 1 / Math.abs(line.b || Infinity);
    if (line.b > 0 && line.miss < 0.35) return { years: line, spacing, labels };
  }
  return { labels };
}

// ---------------------------------------------------------------------------------------------- titles

/**
 * A panel's own title: a line of words just above its plot, inside the chart (under a legend shared by the panels),
 * such as "A. Green-driven occupations" under the figure's title and legend.
 */
function panelTitle(box, plotBox, tokens, taken) {
  // (A unit set just over the axis, "%", is no title: only words count.)
  const above = tokens.filter(t => !taken.has(t) && !t.angle && !t.tick && !t.num && /\p{L}{2}/u.test(t.text) && t.top > box.top + 1 && t.base <= plotBox.top + 2
    && plotBox.top - t.base <= t.size * 2.5 + 8 && t.x1 > plotBox.x0 && t.x0 < plotBox.x1);
  if (!above.length) return null;
  const nearest = Math.max(...above.map(t => t.base));
  const row = above.filter(t => Math.abs(t.base - nearest) <= 2).sort((a, b) => a.x0 - b.x0);
  const pieces = [];
  for (const t of row) { const q = pieces.at(-1); if (q && t.x0 - q.at(-1).x1 <= t.size * 1.5) q.push(t); else pieces.push([t]); }
  const middle = (plotBox.x0 + plotBox.x1) / 2;
  const piece = pieces.sort((a, b) => Math.abs((a[0].x0 + a.at(-1).x1) / 2 - middle) - Math.abs((b[0].x0 + b.at(-1).x1) / 2 - middle))[0];
  const text = piece.map(t => t.text).join(' ');
  // Words, and a title's length: not a unit ("%") or a note.
  if (!hasLetters(text) || text.replace(/[^\p{L}]/gu, '').length < 3 || text.length > 120) return null;
  return { text, tokens: piece };
}

/** A short line just above the chart, over its plot: its title. */
function titleAbove(top, box, tokens, taken, year = false) {
  // (A unit set over the axis, "%", is not the title's row.)
  const candidates = tokens.filter(t => !taken.has(t) && !t.angle && !t.tick && !(!/\p{L}{2}/u.test(t.text) && t.text.length <= 3) && t.base <= top + 3 && t.base >= top - Math.max(30, t.size * 3.5) && t.x1 > box.x0 - 10 && t.x0 < box.x1 + 10);
  if (!candidates.length) return null;
  const nearest = Math.max(...candidates.map(t => t.base));
  const row = candidates.filter(t => Math.abs(t.base - nearest) <= 2).sort((a, b) => a.x0 - b.x0);
  // Pieces of the row far apart (a unit at the left, a title in the middle): the one nearest the plot's middle.
  const pieces = [];
  for (const t of row) { const p = pieces.at(-1); if (p && t.x0 - p.at(-1).x1 <= t.size * 1.5) p.push(t); else pieces.push([t]); }
  const middle = (box.x0 + box.x1) / 2;
  const piece = pieces.sort((a, b) => Math.abs((a[0].x0 + a.at(-1).x1) / 2 - middle) - Math.abs((b[0].x0 + b.at(-1).x1) / 2 - middle))[0];
  // A title that wraps: up to two more lines just above, starting at the same place (or centred the same).
  const lines = [piece];
  for (let k = 0; k < 2; k++) {
    const first = lines[0], x0 = first[0].x0, x1 = first.at(-1).x1;
    const above = tokens.filter(t => !taken.has(t) && !t.angle && t.base < first[0].top && first[0].top - t.base <= first[0].size * 0.7 && t.x1 > x0 - 5 && t.x0 < x1 + 60 && Math.abs(t.size - first[0].size) <= 1);
    if (!above.length) break;
    const row = above.sort((a, b) => a.x0 - b.x0);
    if (Math.abs(row[0].x0 - x0) > 3 && Math.abs((row[0].x0 + row.at(-1).x1) / 2 - (x0 + x1) / 2) > 3) break;
    lines.unshift(row);
  }
  const text = lines.map(l => l.map(t => t.text).join(' ')).join(' ');
  // (A year alone names one of several pies, 2019 | 2024 | 2029P, when asked for.)
  const lone = year && lines.flat().length === 1 && isYear(lines[0][0].num);
  if ((!hasLetters(text) && !lone) || text.length > 240) return null;
  return { text, tokens: lines.flat() };
}

// ---------------------------------------------------------------------------------------------- charts

/** Legend entries next to the chart belong to its box; a legend shared by several panels further off doesn't. */
function addLegend(parts, named) {
  const box = boxOf(parts);
  for (const n of named) if (n && n.box.x0 >= box.x0 - 40 && n.box.x1 <= box.x1 + 40 && Math.max(0, box.top - n.box.bottom, n.box.top - box.bottom) < 40) parts.push(n.box);
}

const boxOf = list => (!list.length ? null : { x0: Math.min(...list.map(b => b.x0)), x1: Math.max(...list.map(b => b.x1)), top: Math.min(...list.map(b => b.top)), bottom: Math.max(...list.map(b => b.bottom)) });

/**
 * Totals printed beyond stacked bars: per group (one stack each), the number just past the stack's end whose value is
 * the sum of its pieces (printed ones as printed). Most stacks must have one, or there are none.
 */
function stackTotals(axis, groups, tokens, taken) {
  const v = axis.vertical;
  const used = new Set(groups.flatMap(g => g.bars.flatMap(b => b.segments.map(s => s.printed)).filter(Boolean)));
  const free = tokens.filter(t => t.num && !t.angle && !t.tick && !taken.has(t) && !used.has(t));
  const found = groups.map(g => {
    if (g.bars.length !== 1 || g.bars[0].segments.length < 2) return null;
    const b = g.bars[0], segs = b.segments;
    const sum = segs.reduce((n, s) => n + (s.printed && !s.share ? s.printed.num.value : s.value), 0);
    const end = v ? Math.min(...segs.map(s => Math.min(s.far, s.near))) : Math.max(...segs.map(s => Math.max(s.far, s.near)));
    const near = free.filter(t => (v ? t.cx >= b.c0 - 2 && t.cx <= b.c1 + 2 && t.base <= end + 1 && end - t.base <= t.size * 1.5 + 4
      : t.cy >= b.c0 - 2 && t.cy <= b.c1 + 2 && t.x0 >= end - 1 && t.x0 - end <= t.size * 2 + 4));
    const t = near.sort((p, q) => (v ? end - p.base - (end - q.base) : p.x0 - q.x0))[0];
    return t && Math.abs(t.num.value - sum) <= Math.max(Math.abs(sum) * 0.03, axis.step * 0.2) ? t : null;
  });
  const stacks = groups.filter(g => g.bars.length === 1 && g.bars[0].segments.length >= 2).length;
  const hits = found.filter(Boolean).length;
  return hits >= 2 && hits >= stacks * 0.6 ? found : null;
}

/**
 * Rows of figures printed under a chart's category labels, one under each category, named at the left ("Returns to
 * shareholders  $2.7  $2.2  …", an Excel chart's data table): columns of the chart's table.
 */
function dataRows(slots, labels, tokens, taken) {
  const own = labels.filter(Boolean).flatMap(l => l.tokens);
  if (!own.length) return [];
  const bottom = Math.max(...own.map(t => t.box.bottom)), size = median(own.map(t => t.size));
  const from = slots[0][0], to = slots.at(-1)[1];
  const below = tokens.filter(t => !taken.has(t) && !own.includes(t) && !t.angle && t.top >= bottom - 1 && t.top <= bottom + size * 8);
  const lines = [];
  for (const t of below.filter(t => t.num).sort((a, b) => a.base - b.base)) {
    const l = lines.find(m => Math.abs(m[0].base - t.base) <= 1.5);
    if (l) l.push(t); else lines.push([t]);
  }
  const out = [];
  for (const line of lines) {
    const cells = slots.map(([s0, s1]) => line.filter(t => t.cx >= s0 && t.cx <= s1));
    if (cells.some(c => c.length > 1) || cells.filter(c => c.length).length < Math.max(2, labels.filter(Boolean).length * 0.6)) continue;
    // Its name: words left of the first category, level with the row (over one or two lines).
    const cy = line[0].cy;
    const name = tokens.filter(t => !taken.has(t) && !t.angle && !t.num && hasLetters(t.text) && t.x1 <= from + 2 && from - t.x1 <= 120 && Math.abs(t.cy - cy) <= t.size * 1.3)
      .sort((a, b) => a.top - b.top || a.x0 - b.x0);
    if (!name.length) continue;
    out.push({ name: name.map(t => t.text).join(' '), tokens: [...name, ...line], cells: cells.map(c => c[0] || null) });
  }
  return out;
}

/**
 * Stacks whose pieces carry each its share of the stack (30%, 25%, 44% on a stack of £ amounts): when most stacks'
 * percents add up to 100, the shares are what is printed, and the table gives them.
 */
function sharesPrinted(axis, groups, tokens, taken) {
  const v = axis.vertical;
  const stacks = groups.flatMap(g => g.bars).filter(b => b.segments.every(s => !s.printed));
  const found = stacks.map(b => {
    const picks = b.segments.map(seg => {
      const lo = Math.min(seg.far, seg.near), hi = Math.max(seg.far, seg.near), r = seg.rect;
      return tokens.filter(t => t.num?.percent && !t.angle && !taken.has(t) && (v ? t.cx >= r.x0 && t.cx <= r.x1 && t.cy >= lo && t.cy <= hi : t.cy >= r.y0 && t.cy <= r.y1 && t.cx >= lo && t.cx <= hi));
    });
    if (picks.some(p => p.length !== 1)) return null;
    const sum = picks.reduce((n, p) => n + p[0].num.value, 0);
    return Math.abs(sum - 100) <= 2 ? picks.map(p => p[0]) : null;
  });
  if (found.filter(Boolean).length < Math.max(2, stacks.length * 0.6)) return;
  stacks.forEach((b, i) => { if (found[i]) b.segments.forEach((seg, k) => { seg.printed = found[i][k]; seg.share = true; }); });
}

function barChart(axis, plot, legend, tokens, taken, axes = []) {
  const read = readBars(axis, plot, legend);
  if (!read) return null;
  let { groups } = read;
  const { stacked } = read;
  const v = axis.vertical;
  let slots = groups.map((g, i) => {
    const prev = groups[i - 1], next = groups[i + 1], pitch = next ? next.c0 - g.c1 : prev ? g.c0 - prev.c1 : g.c1 - g.c0;
    return [prev ? (prev.c1 + g.c0) / 2 : g.c0 - pitch / 2, next ? (g.c1 + next.c0) / 2 : g.c1 + pitch / 2];
  });
  // Labels start beyond the bars and the axis's last tick (under them, or left of them).
  const ends = read.bars.flatMap(b => b.segments.map(seg => (v ? Math.max(seg.far, seg.near) : Math.min(seg.far, seg.near))));
  const base = plot.labelsFrom ?? (v ? Math.max(...ends, ...axis.ticks.map(t => t.cy), plot.gridEnd ?? -Infinity) : Math.min(...ends, plot.zero, plot.gridEnd ?? Infinity));
  const legendTokens = new Set(legend.flatMap(e => e.tokens));
  let labels = categoryLabels(axis, plot, slots, tokens.filter(t => !legendTokens.has(t) && !t[v ? 'tickV' : 'tickH']), taken, base);
  // Bars of different colours side by side under one label centred beneath them all: one category, a bar per series.
  if (!stacked && groups.length > 1 && groups.every(g => g.bars.length === 1) && new Set(groups.map(g => g.bars[0].segments[0].color)).size === groups.length && labels.filter(Boolean).length <= 1) {
    const span = [[groups[0].c0 - 2, groups.at(-1).c1 + 2]];
    const [one] = categoryLabels(axis, plot, span, tokens.filter(t => !legendTokens.has(t) && !t[v ? 'tickV' : 'tickH']), taken, base);
    const middle = (span[0][0] + span[0][1]) / 2, at = one && (v ? (Math.min(...one.tokens.map(t => t.box.x0)) + Math.max(...one.tokens.map(t => t.box.x1))) / 2 : middle);
    if (one && Math.abs(at - middle) <= (span[0][1] - span[0][0]) * 0.15) {
      groups = [{ c0: groups[0].c0, c1: groups.at(-1).c1, bars: groups.map(g => g.bars[0]) }];
      slots = span;
      labels = [one];
    }
  }
  // Bars that all hang down from zero carry their labels above the zero line.
  if (v && labels.filter(Boolean).length < groups.length * 0.6 && read.bars.every(b => b.segments.every(seg => seg.far >= seg.near - 0.5))) {
    labels = labelsAbove(slots, tokens.filter(t => !legendTokens.has(t) && !t.tickV && !t.num), taken, Math.min(...read.bars.flatMap(b => b.segments.map(seg => seg.near))));
  }
  // Where the labels are years, a figure that isn't one (a value printed under a bar that dips below zero) isn't a label.
  if (labels.filter(l => l && isYear(chartNumber(l.text))).length >= 2) labels = labels.map(l => (l && chartNumber(l.text) && !isYear(chartNumber(l.text)) ? null : l));
  // Years under every few bars: the bars between them are the years between (evenly spaced bars only).
  const known = labels.map((l, i) => (l && isYear(chartNumber(l.text)) ? [(groups[i].c0 + groups[i].c1) / 2, chartNumber(l.text).value] : null)).filter(Boolean);
  if (known.length >= 2 && known.length < groups.length && labels.every(l => !l || isYear(chartNumber(l.text)))) {
    const line = fit(known), pitch = median(groups.slice(1).map((g, i) => g.c0 - groups[i].c0));
    if (line.miss < 0.2 && Math.abs(line.b * pitch - 1) < 0.15) groups.forEach((g, i) => {
      if (!labels[i]) labels[i] = { text: String(Math.round(line.a + line.b * (g.c0 + g.c1) / 2)), tokens: [] };
    });
  }
  // A second row of labels, each over a run of bars (countries under repeated months): each label says both.
  const outer = v ? outerLabels(slots, labels, tokens.filter(t => !legendTokens.has(t) && !t.tickV), taken) || outerLabels(slots, labels, tokens.filter(t => !legendTokens.has(t) && !t.tickV), taken, plot.box.top) : sideLabels(slots, labels, tokens.filter(t => !legendTokens.has(t) && !t.tickH), taken);
  if (outer) {
    // A first label's lines that are the second row's words were read as its next line: they leave it.
    const words = new Set(outer.tokens);
    labels = labels.map((l, i) => {
      if (!l) return l;
      const own = l.tokens.filter(t => !words.has(t));
      const text = l.tokens.some(t => words.has(t)) ? own.map(t => t.text).join(' ') : l.text;
      return { text: `${outer.names[i]} ${text}`, tokens: own };
    });
  }
  const labelled = labels.filter(Boolean).length;
  // Labels under every second (or third) bar, evenly: the bars between them stay unlabelled and are left out (so are
  // the unlabelled bars of a run under a second row of labels).
  const at = labels.map((l, i) => (l ? i : -1)).filter(i => i >= 0), every = at.length >= 3 && at.slice(1).every((v, k) => v - at[k] === at[1] - at[0]) ? at[1] - at[0] : 0;
  // One category of bars side by side, each a series the legend names, is a chart too (checked in solid()).
  const lone = groups.length === 1 && groups[0].bars.length >= 2;
  if (!outer && labelled < Math.max(lone ? 1 : 2, groups.length * 0.6) && !(every >= 2 && every <= 3 && labelled >= groups.length / every - 1)) return null;
  // Series: one per colour; names from the legend.
  const colors = [];
  for (const g of groups) for (const b of g.bars) for (const s of b.segments) if (!colors.includes(s.color)) colors.push(s.color);
  const single = !stacked && groups.every(g => g.bars.length === 1);
  const named = colors.map(c => seriesName(legend, plot.box, c));
  // Bars of one colour named by one entry of a key whose other entries' colours are nowhere in this plot: that key is
  // another chart's (Finland's line beside a chart of all markets in Finland's colour).
  if (colors.length === 1 && named[0]) {
    const b = named[0].box, gap = e => Math.max(0, b.x0 - e.box.x1, e.box.x0 - b.x1) + Math.max(0, b.top - e.box.bottom, e.box.top - b.bottom);
    const row = legend.filter(e => e !== named[0] && e.name !== named[0].name && gap(e) <= 60);
    const drawn = c => (plot.marks || []).some(m => sameColour(m.kind === 'line' ? m.line.color : m.color, c)) || (plot.dots || []).some(d => sameColour(d.color, c));
    if (row.length >= 2 && !row.some(e => drawn(e.color))) named[0] = null;
  }
  // One series the legend doesn't name by colour, and one entry beside the chart that names nothing else: they go together.
  if (named.filter(n => !n).length === 1 && colors.length > 1) {
    const box = plot.box, near = e => Math.max(0, box.x0 - e.box.x1, e.box.x0 - box.x1) + Math.max(0, box.top - e.box.bottom, e.box.top - box.bottom) < 60;
    const spare = legend.filter(e => !e.line && near(e) && !named.includes(e) && !legend.some(o => o !== e && o.name === e.name && named.includes(o)));
    if (spare.length === 1) named[named.indexOf(null)] = spare[0];
  }
  // Colours the legend names in a slightly different shade (a dark navy drawn #191d64 in the bars, #26193e in the
  // key): the legend entries no other colour took, each given to the unnamed colour nearest it, the pairing with the
  // least colour difference.
  const unnamed = colors.map((c, i) => i).filter(i => !named[i]);
  if (unnamed.length && named.some(Boolean)) {
    const used = new Set(named.filter(Boolean).map(n => n.name));
    const spare = [...new Map(legend.filter(e => !e.line && !named.includes(e) && !used.has(e.name)).map(e => [e.name, e])).values()];
    if (spare.length === unnamed.length && spare.length <= 6) {
      const cost = unnamed.map(i => spare.map(e => colourGap(colors[i], e.color)));
      const pairing = cheapestPairing(cost);
      if (pairing && pairing.every((j, k) => cost[k][j] <= 90)) pairing.forEach((j, k) => { named[unnamed[k]] = spare[j]; });
    }
  }
  // Stacked bars named beside the last stack: words just past it, level with one of its pieces, name that piece's colour.
  if (stacked && named.some(n => !n)) {
    const last = read.bars.at(-1), c = v ? last.c1 : null;
    for (const seg of last.segments) {
      const k = colors.indexOf(seg.color);
      if (k < 0 || named[k]) continue;
      const lo = Math.min(seg.far, seg.near), hi = Math.max(seg.far, seg.near);
      const words = v ? tokens.filter(t => !taken.has(t) && !t.angle && !t.num && hasLetters(t.text) && t.x0 > c && t.x0 - c <= 150 && t.cy >= lo && t.cy <= hi) : [];
      if (!words.length) continue;
      const first = words.sort((a, b) => a.x0 - b.x0 || a.top - b.top)[0];
      const run = words.filter(t => Math.abs(t.base - first.base) <= 1).sort((a, b) => a.x0 - b.x0);
      const name = run.map(t => t.text).join(' ');
      if (named.some(n => n?.name === name)) continue;
      named[k] = { name, tokens: run, box: boxOf(run.map(t => t.box)) };
    }
  }
  let series;
  // One bar per category in different colours: one column, unless the legend names each colour (a series each, the
  // other cells empty).
  const eachNamed = colors.length > 1 && named.every(Boolean) && new Set(named.map(n => n.name)).size === colors.length;
  if (single && !(colors.length === 1 && named[0]) && !eachNamed) series = [{ name: 'Value', colors }];
  else series = colors.map((c, i) => ({ name: named[i]?.name || (colors.length === 1 ? 'Value' : 'Unlabelled'), colors: [c] }));
  // One colour the legend doesn't name is said to be unlabelled; more than one, and the series can't be told apart.
  if (series.length > 1 && named.filter(n => !n).length > 1) return null; // series we can't name: not reliably read
  for (const n of named) if (n) n.tokens.forEach(t => taken.add(t));
  printedValues(axis, groups, tokens, taken);
  if (stacked && !axis.percent) sharesPrinted(axis, groups, tokens, taken);
  // A line drawn over vertical bars on the same axis (a total, a trend), named in the legend: read at each bar group.
  // ...and markers drawn over the bars (a second measure per bar), named in the legend: read at the bar they stand on.
  // A line over the bars may be read on a second scale, on the plot's far side; markers too, when their name or
  // colour or the scale's title says which scale is theirs.
  const other = v ? otherSide(axis, plot, axes) : null;
  // An axis's title is read from the words over it, other than the legend's names.
  const inLegend = new Set(legend.flatMap(e => e.tokens || [])), titles = tokens.filter(t => !inLegend.has(t));
  const overlays = v ? [...plotLines(plot, legend), ...plotDots(plot, legend).map(d => ({ ...d, marker: true }))]
    .filter(l => !colors.some(c => sameColour(c, l.color))).map(l => ({ ...l, entry: seriesName(legend, plot.box, l.color, l.dash, !l.dots) })).filter(l => l.entry)
    .map(l => { const c = axisChoice(l.entry.name, l.color, axis, other, plot.side, titles); return { ...l, axis: c.axis, sure: c.sure }; })
    .filter(l => !l.marker || !other || l.sure) : [];
  twinShades(overlays, overlays.map(l => l.entry), legend);
  for (const l of overlays) l.entry.tokens.forEach(t => taken.add(t));
  const rows = [], categories = [];
  let measured = overlays.length > 0;
  // A number just beyond a stack, equal to the sum of its pieces, is the stack's total: a column of its own.
  const totals = stacked ? stackTotals(axis, groups, tokens, taken) : null;
  const extra = v ? dataRows(slots, labels, tokens, new Set([...taken, ...(totals || []).filter(Boolean)])) : [];
  groups.forEach((g, i) => {
    if (!labels[i]) return;
    const across = overlays.map(l => {
      const y = l.dots ? l.pts.find(p => p[0] >= g.c0 - 1 && p[0] <= g.c1 + 1)?.[1] : lineAt(l.pts, (g.c0 + g.c1) / 2);
      return y == null ? '' : formatValue(l.axis, valueAt(l.axis, y));
    });
    const values = series.map(s => {
      const segs = g.bars.flatMap(b => b.segments).filter(seg => s.colors.includes(seg.color));
      if (segs.length !== 1) return '';
      const seg = segs[0];
      if (seg.printed) return printedText(seg.printed);
      measured = true;
      return formatValue(axis, seg.value);
    });
    categories.push(labels[i].text);
    rows.push([labels[i].text, ...values, ...across, ...(totals ? [totals[i] ? totals[i].text.replace(/\s+/g, '') : ''] : []), ...extra.map(e => (e.cells[i] ? printedText(e.cells[i]) : ''))]);
  });
  if (totals) totals.forEach(t => t && taken.add(t));
  for (const l of labels) if (l) l.tokens.forEach(t => taken.add(t));
  if (outer) outer.tokens.forEach(t => taken.add(t));
  for (const g of groups) for (const b of g.bars) for (const s of b.segments) if (s.printed) taken.add(s.printed);
  axis.ticks.forEach(t => taken.add(t));
  if (other && overlays.some(l => l.axis === other)) other.ticks.forEach(t => taken.add(t));
  const parts = [boxOf(read.bars.flatMap(b => b.segments.map(({ rect: r }) => ({ x0: r.x0, x1: r.x1, top: r.y0, bottom: r.y1 })))), boxOf(axis.ticks.map(t => t.box)), ...labels.filter(Boolean).flatMap(l => l.tokens.map(t => t.box)), ...read.bars.flatMap(b => b.segments.filter(seg => seg.printed).map(seg => seg.printed.box)), ...(outer ? outer.tokens.map(t => t.box) : []), ...(totals ? totals.filter(Boolean).map(t => t.box) : []), ...extra.flatMap(e => e.tokens.map(t => t.box))].filter(Boolean);
  addLegend(parts, named);
  for (const e of extra) e.tokens.forEach(t => taken.add(t));
  const names = [...series.map(s => s.name), ...overlays.map(l => l.entry.name), ...(totals ? ['Total'] : []), ...extra.map(e => e.name)];
  unitsToHeadings(names, rows);
  fullYears(rows);
  return { kind: 'bar', box: boxOf(parts), series: names, rows, categories: rows.map(r => r[0]), measured };
}

/**
 * Series drawn as markers only (a dot plot): markers of one colour, three or more, at different places across the
 * plot, or short level dashes of one colour, one per place. Read only where a marker stands (never between markers).
 */
function plotDots(plot, legend, taken) {
  const swatches = new Set(legend.map(e => e.swatch));
  const byColour = new Map();
  // White (hollow) markers count when the legend keys them with a white marker of their own.
  const whiteKey = legend.some(e => e.swatch?.points && isWhite(e.color));
  for (const d of plot.dots || []) if (!swatches.has(d) && (!isWhite(d.color) || whiteKey) && d.x1 - d.x0 <= 16 && d.y1 - d.y0 <= 16) {
    if (!byColour.has(d.color)) byColour.set(d.color, []);
    byColour.get(d.color).push(d);
  }
  // Short level strokes of one colour, one per place (a "total" drawn as a dash across each category), count as
  // markers at their middles when they are short beside the spacing between them; so do flat filled dashes.
  const swatchLines = new Set(legend.filter(e => e.line).map(e => e.line));
  const dashes = new Map();
  for (const m of plot.marks || []) {
    // (Or flat filled bars a few points high, a high and a low drawn as short thick dashes.)
    if (m.kind === 'rect' && !swatches.has(m.rect) && !isWhite(m.color) && m.y1 - m.y0 <= Math.min(4, (m.x1 - m.x0) / 4) && m.x1 - m.x0 >= 3) {
      if (!dashes.has(m.color)) dashes.set(m.color, []);
      dashes.get(m.color).push({ x0: m.x0, x1: m.x1, y0: (m.y0 + m.y1) / 2, y1: (m.y0 + m.y1) / 2 });
      continue;
    }
    const pts = m.kind === 'line' && !swatchLines.has(m.line) && !isWhite(m.line.color) && m.line.pts.length === 2 ? m.line.pts : null;
    if (!pts || Math.abs(pts[0][1] - pts[1][1]) > 0.5 || Math.abs(pts[0][0] - pts[1][0]) < 2) continue;
    if (!dashes.has(m.line.color)) dashes.set(m.line.color, []);
    dashes.get(m.line.color).push({ x0: Math.min(pts[0][0], pts[1][0]), x1: Math.max(pts[0][0], pts[1][0]), y0: pts[0][1], y1: pts[0][1] });
  }
  for (const [color, all] of dashes) {
    // (Of one colour, the dashes as long as most of them: an axis line across the plot, or its tick marks one over
    // another at the plot's edge, are not markers.)
    const typical = median(all.map(d => d.x1 - d.x0)), at = d => Math.round((d.x0 + d.x1) / 2);
    const list = all.filter(d => Math.abs(d.x1 - d.x0 - typical) <= typical * 0.3 && all.filter(o => at(o) === at(d)).length === 1);
    if (list.length < 3 || byColour.has(color)) continue;
    const mids = list.map(d => (d.x0 + d.x1) / 2).sort((a, b) => a - b), spacing = median(mids.slice(1).map((x, k) => x - mids[k]));
    if (spacing > 0 && list.every(d => d.x1 - d.x0 <= spacing * 0.6)) byColour.set(color, list);
  }
  const width = plot.box.x1 - plot.box.x0, out = [];
  for (const [color, list] of byColour) {
    const pts = list.map(d => [(d.x0 + d.x1) / 2, (d.y0 + d.y1) / 2]).sort((a, b) => a[0] - b[0]);
    // One marker per place: two of one colour at the same x can't be told apart.
    if (pts.length < 3 || pts.some((p, k) => k && p[0] - pts[k - 1][0] < 1) || pts.at(-1)[0] - pts[0][0] < width * 0.2) continue;
    out.push({ color, dash: false, pts, dots: true });
  }
  return out;
}

/** The value axis on the far side of a plot (a second scale), if any. */
function otherSide(axis, plot, axes) {
  const { box, side } = plot;
  return axes.filter(o => o !== axis && o.vertical === axis.vertical && o.top < axis.bottom && o.bottom > axis.top
    && (side > 0 ? o.x0 >= box.x1 - 30 && o.x0 <= box.x1 + 40 : o.x1 <= box.x0 + 30 && o.x1 >= box.x0 - 40)
    // (Numbers set flush against a plot beyond them are that next panel's own axis, not this plot's second scale.)
    && o.align !== side)
    .sort((a, b) => b.ticks.length - a.ticks.length)[0] || null;
}

const SAYS_RIGHT = /\((?:rhs?|r|right(?: axis| scale)?)\)|\brhs\b|\bright[- ]hand (?:axis|scale|side)\b|\bright (?:axis|scale)\b/i;
const SAYS_LEFT = /\((?:lhs?|l|left(?: axis| scale)?)\)|\blhs\b|\bleft[- ]hand (?:axis|scale|side)\b|\bleft (?:axis|scale)\b/i;

/**
 * The axis a series is read on when the plot has a scale on each side: the one its name says ("(RHS)", "right
 * axis"), or the one whose numbers are printed in its colour; otherwise the plot's own axis.
 */
function axisOf(name, color, axis, other, side, tokens = null) {
  return axisChoice(name, color, axis, other, side, tokens).axis;
}

/** The words over a value axis (its title: "GHG intensity" over the right-hand numbers), lower case. */
function axisWords(axis, tokens) {
  const over = tokens.filter(t => !t.angle && !t.num && hasLetters(t.text) && t.base <= axis.top + 1 && axis.top - t.base <= 30 && t.x1 >= axis.x0 - 60 && t.x0 <= axis.x1 + 60);
  return new Set(over.flatMap(t => t.text.toLowerCase().match(/\p{L}{4,}/gu) || []));
}

/** axisOf, and whether something said so (a name, a colour, the axis's title) rather than the plot's own axis by default. */
function axisChoice(name, color, axis, other, side, tokens = null) {
  if (!other) return { axis, sure: true };
  const right = side > 0 ? other : axis, left = side > 0 ? axis : other;
  if (SAYS_RIGHT.test(name || '') && !SAYS_LEFT.test(name || '')) return { axis: right, sure: true };
  if (SAYS_LEFT.test(name || '') && !SAYS_RIGHT.test(name || '')) return { axis: left, sure: true };
  const inColour = a => a.ticks.every(t => t.items.every(i => i.color && sameColour(i.color, color)));
  if (color && !isWhite(color) && inColour(other) && !inColour(axis)) return { axis: other, sure: true };
  // A series named in the words of one axis's title (and not the other's) is read on that axis.
  if (tokens && name) {
    const words = new Set(name.toLowerCase().match(/\p{L}{4,}/gu) || []);
    const hits = a => [...axisWords(a, tokens)].filter(w => words.has(w)).length;
    const mine = hits(axis), theirs = hits(other);
    if (theirs > mine) return { axis: other, sure: true };
    if (mine > theirs) return { axis, sure: true };
  }
  return { axis, sure: false };
}

/**
 * Names set in a column just right of where the lines end, moved apart so they don't overlap: as many as there are
 * lines, they keep the lines' order from top to bottom (the name nearest a line's end may belong to the next line).
 */
function stackedEndNames(lines, tokens, taken) {
  const ends = lines.map(l => l.pts.at(-1)), right = Math.max(...ends.map(e => e[0]));
  if (ends.some(e => right - e[0] > 6)) return null;
  const top = Math.min(...ends.map(e => e[1])), bottom = Math.max(...ends.map(e => e[1]));
  const words = tokens.filter(t => !t.angle && !t.num && !taken.has(t) && hasLetters(t.text) && t.x0 >= right - 2 && t.x0 - right <= 30 && t.cy >= top - 30 && t.cy <= bottom + 30)
    .sort((a, b) => a.base - b.base || a.x0 - b.x0);
  const names = [];
  for (const t of words) {
    const n = names.find(m => Math.abs(m.at(-1).base - t.base) <= 1 && t.x0 > m.at(-1).x1 - 0.5 && t.x0 - m.at(-1).x1 <= t.size * 0.6);
    if (n) n.push(t); else names.push([t]);
  }
  const left = median(names.map(n => n[0].x0));
  const column = names.filter(n => Math.abs(n[0].x0 - left) <= 4);
  if (column.length !== lines.length) return null;
  const order = lines.map((l, i) => i).sort((a, b) => ends[a][1] - ends[b][1]);
  const out = [];
  for (const [k, i] of order.entries()) {
    const n = column[k], cy = (n[0].box.top + n[0].box.bottom) / 2;
    if (Math.abs(cy - ends[i][1]) > n[0].size * 3 + 6) return null;
    out[i] = { name: n.map(t => t.text).join(' '), tokens: n, box: boxOf(n.map(t => t.box)) };
  }
  return out;
}

/** The pairing of rows to columns with the least total cost (every one, for the few series a chart has). */
function cheapestPairing(cost) {
  const n = cost.length;
  let best = null, bestCost = Infinity;
  const used = new Array(n).fill(false), pick = [];
  const walk = (i, sum) => {
    if (sum >= bestCost) return;
    if (i === n) { best = [...pick]; bestCost = sum; return; }
    for (let j = 0; j < n; j++) if (!used[j]) { used[j] = true; pick.push(j); walk(i + 1, sum + cost[i][j]); pick.pop(); used[j] = false; }
  };
  walk(0, 0);
  return best;
}

/**
 * Names written inside the plot beside their lines ("all U.S. manufacturing" over one line, "energy companies" under
 * the other): as many names as lines, each line given the name nearest it, the pairing with the least distance.
 */
function namesBesideLines(lines, plot, tokens, taken) {
  const { box } = plot;
  if (lines.length > 6) return null;
  const words = tokens.filter(t => !t.angle && !t.num && !t.tick && !taken.has(t) && hasLetters(t.text) && t.cx > box.x0 && t.cx < box.x1 && t.cy > box.top && t.cy < box.bottom)
    .sort((a, b) => a.base - b.base || a.x0 - b.x0);
  const rows = [];
  for (const t of words) {
    const n = rows.find(m => Math.abs(m.at(-1).base - t.base) <= 1 && t.x0 > m.at(-1).x1 - 0.5 && t.x0 - m.at(-1).x1 <= t.size * 0.6);
    if (n) n.push(t); else rows.push([t]);
  }
  // A name set over two or three lines ("Avg Annual / Inflation / 1930-Present"): lines just under one another, overlapping.
  const names = [];
  for (const r of rows) {
    const x0 = r[0].x0, x1 = r.at(-1).x1;
    const n = names.find(m => { const l = m.at(-1); return r[0].top >= l[0].base - 1 && r[0].top - l[0].base <= r[0].size * 0.6 && x0 < l.at(-1).x1 && x1 > l[0].x0; });
    if (n) n.push(r); else names.push([r]);
  }
  // As many names as lines, or one fewer (one line, the chart's own measure, needs no name).
  if (!names.length || (names.length !== lines.length && names.length !== lines.length - 1)) return null;
  const far = (box.bottom - box.top) * 0.3;
  const centre = n => { const all = n.flat(); return [(Math.min(...all.map(t => t.x0)) + Math.max(...all.map(t => t.x1))) / 2, (Math.min(...all.map(t => t.box.top)) + Math.max(...all.map(t => t.box.bottom))) / 2]; };
  const gap = (l, n) => {
    const [x, y] = centre(n), at = lineAt(l.pts, x);
    return at == null ? Math.min(...l.pts.map(p => Math.hypot(p[0] - x, p[1] - y))) : Math.abs(at - y);
  };
  const cost = lines.map(l => [...names.map(n => gap(l, n)), ...(names.length < lines.length ? [far] : [])]);
  const pairing = cheapestPairing(cost);
  if (!pairing || pairing.some((j, i) => j < names.length && cost[i][j] > far)) return null;
  return pairing.map(j => (j < names.length ? { name: names[j].map(r => r.map(t => t.text).join(' ')).join(' '), tokens: names[j].flat(), box: boxOf(names[j].flat().map(t => t.box)) }
    : { name: 'Value', tokens: [], box: { ...box } }));
}

/** The legend keys this name with two swatches side by side (hollow and filled), one series in two shades. */
function twinKey(legend, name) {
  const keys = legend.filter(e => e.name === name && e.swatch);
  return keys.length === 2 && Math.abs((keys[0].swatch.y0 + keys[0].swatch.y1) - (keys[1].swatch.y0 + keys[1].swatch.y1)) / 2 <= 2
    && Math.abs(keys[0].swatch.x0 - keys[1].swatch.x0) <= 4 * Math.max(keys[0].swatch.x1 - keys[0].swatch.x0, keys[1].swatch.x1 - keys[1].swatch.x0, 4);
}

/**
 * A key of two swatches before one name (hollow and filled: "darker colours denote significant differences") draws
 * one series in two shades: its markers, one per category in either shade, are put together (in place, in `lines`
 * and `named`). Not when both shades stand at one category, which two series would.
 */
function twinShades(lines, named, legend) {
  for (let i = 0; i < lines.length; i++) {
    for (let j = lines.length - 1; j > i; j--) {
      const a = lines[i], b = lines[j];
      if (!a.dots || !b.dots || !named[i] || !named[j] || named[i].name !== named[j].name) continue;
      if (!twinKey(legend, named[i].name)) continue;
      const near = Math.min(...[a, b].map(l => l.pts.length > 1 ? Math.min(...l.pts.slice(1).map((p, k) => p[0] - l.pts[k][0])) : Infinity));
      const width = Math.max(2, Math.min(near, Infinity) / 3);
      if (a.pts.some(p => b.pts.some(q => Math.abs(p[0] - q[0]) < width))) continue;
      lines[i] = { ...a, pts: [...a.pts, ...b.pts].sort((p, q) => p[0] - q[0]) };
      lines.splice(j, 1);
      named.splice(j, 1);
    }
  }
}

function lineChart(axis, plot, legend, tokens, taken, axes = []) {
  if (!axis.vertical) return null;
  // Markers count as series only when no second value axis could be theirs.
  const second = axes.some(o => o !== axis && o.vertical && Math.abs(o.x0 - axis.x0) > 30 && o.bottom > plot.box.top && o.top < plot.box.bottom);
  const drawn = plotLines(plot, legend);
  // Areas count when the legend names them (a shaded band behind lines, unnamed, is not a series) or stand alone.
  const areas = areaSeries(axis, plot).filter(a => seriesName(legend, plot.box, a.color) || !drawn.length);
  drawn.push(...areas.filter(a => areas.length === 1 || seriesName(legend, plot.box, a.color)));
  const lines = [...drawn, ...(second ? [] : plotDots(plot, legend).filter(d => !drawn.some(l => l.color === d.color)))];
  if (!lines.length) return null;
  // Labels start under the lowest tick or line.
  const base = Math.max(...axis.ticks.map(t => t.cy), ...lines.flatMap(l => l.pts.map(p => p[1])), plot.gridEnd ?? -Infinity);
  const legendTokens = new Set(legend.flatMap(e => e.tokens));
  const cats = lineCategories(plot, tokens.filter(t => !legendTokens.has(t)), taken, axis, base);
  if (!cats) return null;
  const named = lines.map(l => seriesName(legend, plot.box, l.color, l.dash, true));
  twinShades(lines, named, legend);
  // Lines named where they end (a label just right of the last point) rather than in a legend.
  lines.forEach((l, i) => {
    if (named[i]) return;
    const [x, y] = l.pts.at(-1);
    const parts = tokens.filter(t => !t.angle && !t.num && !taken.has(t) && hasLetters(t.text) && t.x0 >= x - 1 && t.x0 - x <= 25 && Math.abs(t.cy - y) <= t.size * 1.2).sort((a, b) => a.x0 - b.x0);
    if (!parts.length) return;
    const run = [parts[0]];
    for (const t of [...tokens].sort((a, b) => a.x0 - b.x0)) if (t !== parts[0] && !t.angle && Math.abs(t.base - parts[0].base) <= 1 && t.x0 > run.at(-1).x1 - 0.5 && t.x0 - run.at(-1).x1 <= t.size * 0.6) run.push(t);
    named[i] = { name: run.map(t => t.text).join(' '), tokens: run, box: boxOf(run.map(t => t.box)) };
  });
  // Names that don't tell the lines apart (one name for two, or a line unnamed): names stacked where the lines end.
  const clash = new Set(named.filter(Boolean).map(n => n.name)).size < named.filter(Boolean).length || named.some(n => !n);
  const grey = c => { const v = rgbOf(c); return v && Math.max(...v) - Math.min(...v) <= 24; };
  if (lines.length > 1 && clash) {
    const stacked = stackedEndNames(lines, tokens, taken);
    if (stacked) stacked.forEach((n, i) => { named[i] = n; });
    else if (named.every(n => !n)) {
      // Names in the plot go to the coloured lines; grey ones are guides (an axis drawn with its ticks, a level).
      const coloured = lines.map((l, i) => i).filter(i => !grey(lines[i].color));
      if (coloured.length > 1) namesBesideLines(coloured.map(i => lines[i]), plot, tokens, taken)?.forEach((n, k) => { named[coloured[k]] = n; });
    }
  }
  if (new Set(named.filter(Boolean).map(n => n.name)).size < named.filter(Boolean).length) return null; // one name for two lines
  // A grey line no legend names, beside named ones, is a guide (a reference level, an average band), not a series.
  const kept = lines.map((l, i) => i).filter(i => named[i] || lines.length === 1 || !grey(lines[i].color) || lines.every(l => grey(l.color)));
  if (kept.length > 1 && kept.some(i => !named[i])) return null;
  const other = otherSide(axis, plot, axes);
  const series = kept.map(i => ({ ...lines[i], name: named[i]?.name || 'Value', axis: axisOf(named[i]?.name, lines[i].color, axis, other, plot.side) }));
  // Category positions: each year a line has a point at (years read as a scale), or each label.
  let points; // [{ label, x }]
  if (cats.years) {
    // A line with a point every year, evenly spaced: its own spacing is the year scale (labels a little off their
    // ticks would drift by a year or more across a century of points), set at the labels.
    const dense = series.filter(s => !s.dots).map(s => s.pts.map(p => p[0])).sort((a, b) => b.length - a.length)[0];
    if (dense && dense.length >= 6) {
      const steps = dense.slice(1).map((x, k) => x - dense[k]), d = (dense.at(-1) - dense[0]) / (dense.length - 1);
      if (d > 0 && steps.every(s => Math.abs(s - d) <= d * 0.15) && Math.abs(d * Math.abs(cats.years.b) - 1) < 0.2) {
        const first = Math.round(median(cats.labels.map(l => l.token.num.value - (l.x - dense[0]) / d)));
        const scale = { a: first - dense[0] / d, b: 1 / d };
        // Labels centred a little off their ticks: within a twentieth of the years between labels.
        const every = median(cats.labels.slice(1).map((l, k) => l.token.num.value - cats.labels[k].token.num.value));
        if (cats.labels.every(l => Math.abs(scale.a + scale.b * l.x - l.token.num.value) < Math.max(0.5, every * 0.05))) cats.years = { ...cats.years, ...scale };
      }
    }
    const xs = new Map();
    for (const s of series) for (const [x] of s.pts) {
      const year = cats.years.a + cats.years.b * x, whole = Math.round(year);
      if (Math.abs(year - whole) <= 0.2 && (!xs.has(whole) || Math.abs(xs.get(whole) - (whole - cats.years.a) / cats.years.b) > Math.abs(x - (whole - cats.years.a) / cats.years.b))) xs.set(whole, x);
    }
    // Points a year apart (or more): finer data (months, days) isn't read as years.
    const spacing = median(series.flatMap(s => s.pts.slice(1).map((p, k) => p[0] - s.pts[k][0])));
    if (spacing < cats.spacing * 0.7) points = cats.labels.map(l => ({ label: l.text, x: l.x }));
    else points = [...xs].sort((a, b) => a[0] - b[0]).map(([year]) => ({ label: String(year), x: (year - cats.years.a) / cats.years.b }));
    // Many years (a century of yearly points): the labelled years, each tenth year, the first and the last.
    if (points.length > 60) {
      const labelled = new Set(cats.labels.map(l => l.token.num.value));
      points = points.filter((p, i) => !i || i === points.length - 1 || labelled.has(Number(p.label)) || Number(p.label) % 10 === 0);
    }
    // Points that fall between years (dates within a year): read the lines at the labelled years.
    if (points.length < Math.min(3, cats.labels.length)) points = cats.labels.map(l => ({ label: l.text, x: l.x }));
  } else points = cats.labels.map(l => ({ label: l.text, x: l.x }));
  if (points.length < 2) return null;
  // Numbers printed beside a line's points (often at its ends) are used as they are when they agree.
  const free = tokens.filter(t => t.num && !t.angle && !taken.has(t) && !t.tick && !legendTokens.has(t));
  const spacing = median(points.slice(1).map((p, k) => p.x - points[k].x)) || 20;
  const cells = points.map(p => series.map(s => {
    // Snap to the line's own point when one is close; otherwise read between points.
    // The nearest point (points closer together than the snap would otherwise give an earlier one).
    const reach = s.dots ? spacing * 0.35 : Math.min(1.5, spacing * 0.45);
    let close = null;
    for (const q of s.pts) if (Math.abs(q[0] - p.x) <= reach && (!close || Math.abs(q[0] - p.x) < Math.abs(close[0] - p.x))) close = q;
    const y = close ? close[1] : s.dots ? null : lineAt(s.pts, p.x);
    return y == null ? null : { x: close ? close[0] : p.x, y, value: valueAt(s.axis, y), axis: s.axis };
  }));
  // Every marker of a dot series belongs to a category: markers left over mean the categories weren't found.
  if (series.some((s, k) => s.dots && cells.filter(row => row[k]).length < s.pts.length * 0.6)) return null;
  const claims = [];
  for (const row of cells) for (const c of row) if (c) for (const t of free) {
    const dx = Math.max(0, t.x0 - c.x, c.x - t.x1), dy = Math.abs(t.cy - c.y);
    if (dx > t.size * 2.5 || dy > t.size * 1.2) continue;
    if (Math.abs(t.num.value - c.value) > Math.max((c.axis.max - c.axis.min) * 0.03, c.axis.step * 0.15)) continue;
    claims.push({ c, t, d: dx + dy });
  }
  const used = new Set();
  for (const { c, t } of claims.sort((a, b) => a.d - b.d)) if (!c.printed && !used.has(t)) { c.printed = t; used.add(t); taken.add(t); }
  const rows = [];
  points.forEach((p, i) => {
    const values = cells[i].map(c => (!c ? '' : c.printed ? printedText(c.printed) : formatValue(c.axis, c.value)));
    if (values.some(Boolean)) rows.push([p.label, ...values]);
  });
  if (rows.length < 2) return null;
  for (const n of named) if (n) n.tokens.forEach(t => taken.add(t));
  cats.labels.forEach(l => taken.add(l.token));
  axis.ticks.forEach(t => taken.add(t));
  if (other && series.some(x => x.axis === other)) other.ticks.forEach(t => taken.add(t));
  const parts = [boxOf(series.map(l => ({ x0: l.pts[0][0], x1: l.pts.at(-1)[0], top: Math.min(...l.pts.map(p => p[1])), bottom: Math.max(...l.pts.map(p => p[1])) }))), boxOf(axis.ticks.map(t => t.box)), ...cats.labels.map(l => l.token.box)];
  addLegend(parts, named);
  const names = series.map(s => s.name);
  unitsToHeadings(names, rows);
  fullYears(rows);
  return { kind: 'line', box: boxOf(parts), series: names, rows, categories: rows.map(r => r[0]), measured: true };
}

/**
 * Bar charts drawn without a value axis, a number printed at the end of each bar: bars standing on one base line (or
 * starting from one left edge), most with a number just beyond (or inside) their end, the numbers in proportion to the
 * bars' lengths. The scale those numbers set stands in for the axis, so the chart reads like one with an axis; the
 * printed numbers are the values.
 * @returns {{axis: object, plot: object}[]}
 */
function impliedAxes(tokens, shapes, page) {
  // (Numbers of a value axis no chart was read from may be values printed in a row across the bars: they count.)
  const nums = tokens.filter(t => t.num && !t.angle && !isYear(t.num));
  if (!nums.length) return [];
  const rects = shapes.rects.filter(r => !isPaper(r.color) && r.x1 - r.x0 >= 2 && r.y1 - r.y0 >= 2 && Math.min(r.x1 - r.x0, r.y1 - r.y0) <= Math.min(page.width, page.height) * 0.2 && r.x1 - r.x0 <= page.width * 0.9 && r.y1 - r.y0 <= page.height * 0.9);
  const out = [];
  for (const vertical of [true, false]) {
    // Bars sharing a base: the bottom edge of vertical bars, the left edge of horizontal ones.
    const baseOf = r => (vertical ? r.y1 : r.x0), farOf = r => (vertical ? r.y0 : r.x1);
    const buckets = [];
    for (const r of [...rects].sort((a, b) => baseOf(a) - baseOf(b))) {
      const b = buckets.at(-1);
      if (b && Math.abs(baseOf(r) - b.base) <= 0.8) b.bars.push(r); else buckets.push({ base: baseOf(r), bars: [r] });
    }
    for (const { base, bars: all } of buckets) {
      // Bars side by side: no two overlap across the base.
      const c0 = r => (vertical ? r.x0 : r.y0), c1 = r => (vertical ? r.x1 : r.y1);
      const level = (q, r) => q !== r && Math.abs(c0(q) - c0(r)) <= 0.8 && Math.abs(c1(q) - c1(r)) <= 0.8;
      // A piece stacked on another stands on that one, not on the base.
      const standing = all.filter(r => !all.some(q => q !== r && Math.min(c1(q), c1(r)) - Math.max(c0(q), c0(r)) > 0.5) && !rects.some(q => level(q, r) && Math.abs(farOf(q) - baseOf(r)) <= 1));
      // Bars of one chart are drawn one width (a flag or an icon on the same line is not one of them).
      const width = median(standing.map(r => c1(r) - c0(r)));
      const bars = standing.filter(r => Math.abs(c1(r) - c0(r) - width) <= width * 0.3);
      if (bars.length < 3) continue;
      // Each bar with the pieces stacked on it; each piece with the number printed in it (the last also just beyond).
      const pairs = [];
      for (const r of bars) {
        const chain = [r];
        for (let next; (next = rects.find(q => level(q, r) && !chain.includes(q) && Math.abs(baseOf(q) - farOf(chain.at(-1))) <= 1));) chain.push(next);
        chain.forEach((piece, k) => {
          const near = baseOf(piece), far = farOf(piece), length = Math.abs(far - near), last = k === chain.length - 1;
          const found = nums.filter(t => {
            const across = vertical ? t.cx : t.cy;
            if (across < c0(r) - 1.5 || across > c1(r) + 1.5) return false;
            if (vertical) return (last && t.base <= far + 1 && far - t.base <= t.size * 1.5 + 2) || (t.top >= far - 1 && t.base <= near + 1);
            return (last && t.x0 >= far - 1 && t.x0 - far <= t.size * 2 + 2) || (t.x0 >= near - 1 && t.x1 <= far + 1);
          });
          // A number in the piece before one past its end (on a stack, the one past the top is the total).
          const within = t => (vertical ? t.top >= far - 1 && t.base <= near + 1 : t.x0 >= near - 1 && t.x1 <= far + 1);
          const t = (chain.length > 1 && found.some(within) ? found.filter(within) : found)
            .sort((a, b) => Math.abs((vertical ? a.base : a.x0) - far) - Math.abs((vertical ? b.base : b.x0) - far))[0];
          if (t && t.num.value > 0 && length >= 1 && (k === 0 || pairs.some(p => p.r === r))) pairs.push({ r, t, length });
        });
      }
      const paired = new Set(pairs.map(p => p.r)).size;
      if (paired < 3 || paired < bars.length * 0.6) continue;
      const k = median(pairs.map(p => p.t.num.value / p.length));
      const max = Math.max(...pairs.map(p => p.t.num.value));
      const fits = pairs.filter(p => Math.abs(p.t.num.value - k * p.length) <= Math.max(max * 0.05, k * 1.5));
      if (fits.length < pairs.length * 0.8 || new Set(pairs.map(p => p.t.num.value)).size < 2) continue;
      const step = max / 5;
      const axis = {
        vertical, implied: true, ticks: [], a: vertical ? k * base : -k * base, b: vertical ? -k : k, step, gap: step / k, min: 0, max,
        decimals: Math.max(...pairs.map(p => p.t.num.decimals)), percent: pairs.some(p => p.t.num.percent),
      };
      // Pieces stacked on a bar (the same width, each starting where the one under it ends) are part of the plot.
      const tops = bars.map(r => {
        let end = farOf(r);
        for (let next; (next = rects.find(q => Math.abs(c0(q) - c0(r)) <= 0.8 && Math.abs(c1(q) - c1(r)) <= 0.8 && Math.abs(baseOf(q) - end) <= 1 && q !== r));) end = farOf(next);
        return end;
      });
      const reach = vertical ? Math.min(...tops) : Math.max(...tops);
      const box = vertical ? { x0: Math.min(...bars.map(r => r.x0)) - 2, x1: Math.max(...bars.map(r => r.x1)) + 2, top: reach - 2, bottom: base + 2 }
        : { x0: base - 2, x1: reach + 2, top: Math.min(...bars.map(r => r.y0)) - 2, bottom: Math.max(...bars.map(r => r.y1)) + 2 };
      const within = m => m.x0 >= box.x0 - 2 && m.x1 <= box.x1 + 2 && m.y0 >= box.top - 2 && m.y1 <= box.bottom + 2;
      const marks = shapes.rects.filter(within).map(r => ({ ...r, kind: 'rect', rect: r }));
      // An axis line drawn across the bars a little inside their base (the bars run on under it, cut by a clip): the
      // labels start there.
      const axisLine = vertical ? shapes.lines.find(l => l.pts.length === 2 && Math.abs(l.pts[0][1] - l.pts[1][1]) < 0.5 && l.pts[0][1] < base - 1 && base - l.pts[0][1] <= 20
        && Math.min(l.pts[0][0], l.pts[1][0]) <= box.x0 + 4 && Math.max(l.pts[0][0], l.pts[1][0]) >= box.x1 - 4) : null;
      out.push({ axis, plot: { box, side: 1, zero: base, marks, ...(axisLine && { labelsFrom: axisLine.pts[0][1] }) } });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------- pies

const PIE_MIN = 30; // points across: a smaller disc is an icon or a marker
const MAX_PIE_FILLS = 2000;

/** Angle of a point about a centre in degrees (0 to 360), counter-clockwise from the right as the page shows it. */
const angleOf = (c, [x, y]) => (Math.atan2(c[1] - y, x - c[0]) * 180 / Math.PI + 360) % 360;
/** How far an angle is from an arc (0 inside it). */
const offArc = (a, arc) => { const d = (a - arc.start + 360) % 360; return d <= arc.span ? 0 : Math.min(d - arc.span, 360 - d); };

/** The arc a filled shape covers about a centre: where it starts and how far it goes (degrees), from its outline. */
function arcOf(fill, c, R) {
  const angles = fill.pts.filter(p => Math.hypot(p[0] - c[0], p[1] - c[1]) >= R * 0.25).map(p => angleOf(c, p)).sort((a, b) => a - b);
  if (angles.length < 2) return null;
  let gap = 360 - angles.at(-1) + angles[0], start = angles[0];
  for (let k = 1; k < angles.length; k++) if (angles[k] - angles[k - 1] > gap) { gap = angles[k] - angles[k - 1]; start = angles[k]; }
  return { start, span: 360 - gap };
}

/** Arcs joined where they overlap or touch: [{start, span}]. */
function unionArcs(arcs) {
  if (arcs.length === 1) return arcs;
  if (arcs.some(a => a.span >= 355)) return [{ start: 0, span: 360 }];
  // Cut the circle where no arc is, then join along it.
  const cut = arcs.map(a => (a.start + a.span) % 360).find(e => !arcs.some(a => offArc((e + 0.5) % 360, a) === 0));
  if (cut == null) return [{ start: 0, span: 360 }];
  const spans = arcs.map(a => { const s = (a.start - cut + 360) % 360; return [s, s + a.span]; }).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [s, e] of spans) { const last = out.at(-1); if (last && s <= last[1] + 1) last[1] = Math.max(last[1], e); else out.push([s, e]); }
  return out.map(([s, e]) => ({ start: (s + cut) % 360, span: e - s }));
}

/**
 * Pies and donuts: filled shapes that touch one another and together make a disc (as wide as high, every outline
 * point within its radius), their arcs adding up to a full turn. A slice's share is its arc; a shape covering the
 * whole disc under the others (a base circle) has what the others leave. Slices of one colour side by side are one.
 * @returns {{box, centre: number[], R: number, hole: number, slices: {color, start, span, share}[]}[]}
 */
function findPies(fills, page) {
  const usable = fills.filter(f => !isWhite(f.color) && f.x1 - f.x0 <= page.width * 0.9 && f.y1 - f.y0 <= page.height * 0.9).slice(0, MAX_PIE_FILLS);
  // Slices drawn with curves, and pies drawn as polygons, each among their own kind (a shape drawn between two pies
  // doesn't join them).
  const pies = [...piesAmong(usable.filter(f => f.curved)), ...piesAmong(usable.filter(f => !f.curved && f.pts.length >= 8))];
  // A donut drawn as a pie with a disc over its middle (often white): the disc is its hole.
  for (const pie of pies) if (!pie.hole) {
    const disc = fills.find(f => f.curved && Math.abs((f.x0 + f.x1) / 2 - pie.centre[0]) < pie.R * 0.1 && Math.abs((f.y0 + f.y1) / 2 - pie.centre[1]) < pie.R * 0.1
      && Math.abs((f.x1 - f.x0) - (f.y1 - f.y0)) < pie.R * 0.1 && (f.x1 - f.x0) / 2 >= pie.R * 0.3 && (f.x1 - f.x0) / 2 <= pie.R * 0.9);
    if (disc) pie.hole = (disc.x1 - disc.x0) / 2;
  }
  return pies;
}

function piesAmong(list) {
  if (list.length < 2) return [];
  // Shapes that touch, together (union-find over boxes, swept left to right).
  const parent = list.map((_, k) => k), find = k => (parent[k] === k ? k : (parent[k] = find(parent[k])));
  const order = list.map((_, k) => k).sort((a, b) => list[a].x0 - list[b].x0);
  for (let i = 0; i < order.length; i++) {
    const a = list[order[i]];
    for (let j = i + 1; j < order.length && list[order[j]].x0 <= a.x1 + 1.5; j++) {
      const b = list[order[j]];
      if (b.y0 <= a.y1 + 1.5 && b.y1 >= a.y0 - 1.5) parent[find(order[i])] = find(order[j]);
    }
  }
  const groups = new Map();
  list.forEach((f, k) => { const r = find(k); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(f); });
  const pies = [];
  for (const group of groups.values()) {
    if (group.length < 2 || group.length > 60) continue;
    const box = { x0: Math.min(...group.map(f => f.x0)), x1: Math.max(...group.map(f => f.x1)), top: Math.min(...group.map(f => f.y0)), bottom: Math.max(...group.map(f => f.y1)) };
    const w = box.x1 - box.x0, h = box.bottom - box.top;
    if (Math.min(w, h) < PIE_MIN || Math.abs(w - h) > Math.max(w, h) * 0.12 + 2) continue;
    const c = [(box.x0 + box.x1) / 2, (box.top + box.bottom) / 2], R = Math.max(w, h) / 2;
    let far = 0, close = Infinity;
    for (const f of group) for (const p of f.pts) { const d = Math.hypot(p[0] - c[0], p[1] - c[1]); if (d > far) far = d; if (d < close) close = d; }
    // (A slice pulled out a little reaches beyond the others.)
    if (far > R * 1.15 + 1) continue;
    const hole = close >= R * 0.3 ? close : 0;
    // A colour drawn in pieces (or twice over): the arcs its pieces cover together.
    const colours = [];
    for (const f of group) { const arc = arcOf(f, c, R); if (!arc || arc.span <= 0.3) continue; const k = colours.find(x => sameColour(x.color, f.color)); if (k) k.arcs.push(arc); else colours.push({ color: f.color, arcs: [arc] }); }
    let slices = colours.flatMap(({ color, arcs }) => unionArcs(arcs).map(a => ({ color, ...a })));
    // A base circle under the others: the part they leave.
    const whole = slices.filter(s => s.span >= 355);
    if (whole.length > 1) continue;
    const others = slices.filter(s => s.span < 355);
    let total = others.reduce((n, s) => n + s.span, 0);
    if (whole.length) {
      if (total >= 355 || !others.length) continue;
      whole[0].span = 360 - total; total = 360;
      // It shows from the end of one slice to the start of the next where no other slice is.
      const ends = others.map(s => (s.start + s.span) % 360);
      whole[0].start = ends.find(e => !others.some(s => offArc((e + 1) % 360, s) === 0)) ?? ends[0];
      slices = [...others, whole[0]];
    }
    if (slices.length < 2 || total < 350 || total > 370) continue;
    // Clockwise from twelve o'clock, as pies are read; neighbours of one colour are one slice.
    const clock = s => (90 - (s.start + s.span) + 720.5) % 360;
    slices.sort((a, b) => clock(a) - clock(b));
    const merged = [];
    for (const s of slices) {
      const last = merged.at(-1);
      if (last && sameColour(last.color, s.color)) { last.span += s.span; last.start = s.start; } else merged.push({ ...s });
    }
    if (merged.length > 1 && sameColour(merged[0].color, merged.at(-1).color)) { const tail = merged.pop(); merged[0].span += tail.span; merged[0].start = tail.start; }
    if (merged.length < 2) continue;
    for (const s of merged) s.share = s.span / total * 100;
    pies.push({ box, centre: c, R, hole, slices: merged });
  }
  return pies;
}

/** A legend entry's name with the lines that continue it below (a long name set over two or three lines). */
function legendName(entry, tokens, legend) {
  const parts = [...entry.tokens.filter(t => hasLetters(t.text) || t.num)];
  const first = parts[0];
  if (!first) return { text: entry.name, tokens: entry.tokens };
  const others = new Set(legend.filter(e => e !== entry).flatMap(e => e.tokens));
  let last = parts;
  for (let k = 0; k < 6; k++) {
    const base = Math.max(...last.map(t => t.base));
    const line = tokens.filter(t => !t.angle && !others.has(t) && !parts.includes(t) && Math.abs(t.size - first.size) <= 1 && t.top >= base - first.size * 0.3 && t.top - base <= first.size * 0.5 && t.x0 >= first.x0 - 2 && t.x0 <= entry.box.x1 + first.size * 4).sort((a, b) => a.x0 - b.x0);
    if (!line.length || Math.abs(line[0].x0 - first.x0) > 2 || legend.some(e => e.swatch && Math.abs((e.swatch.y0 + e.swatch.y1) / 2 - line[0].cy) <= first.size * 0.6)) break;
    parts.push(...line); last = line;
  }
  return { text: parts.map(t => t.text).join(' '), tokens: [...entry.tokens, ...parts.filter(t => !entry.tokens.includes(t))] };
}

// A name with its number after it ("No change 39%", "Asia: 12.5").
const LABEL_NUMBER = /^(.*\p{L}.*?)[\s:,(]+([-+]?[$€£¥]?\d[\d,.]*\s?%?)\)?$/u;

/**
 * Pie charts read as data: each slice named by the legend entry of its colour, or by the words beside it (outside
 * the disc in its direction, or on it), its value the number printed on or beside it when the printed numbers agree
 * with the slices' sizes, otherwise its share measured from the drawing. Pies that share a legend become one table,
 * a column each, named by the words in the hole of a donut or a short line above the pie. `named` collects every
 * word a pie read (legend and labels included).
 */
function pieCharts(pies, tokens, legend, taken, named) {
  const charts = [], read = [];
  for (const pie of pies) {
    const { centre: c, R } = pie;
    // A ring showing one figure (41% in its hole, the slice of 41% coloured, the rest grey) is that figure, not a chart.
    const figure = tokens.find(t => t.num?.percent && Math.hypot(t.cx - c[0], t.cy - c[1]) < (pie.hole || R * 0.5) * 0.9);
    if (pie.slices.length === 2 && figure && pie.slices.some(s => Math.abs(s.share - figure.num.value) <= 2)) continue;
    const free = tokens.filter(t => !taken.has(t) && !t.angle);
    const near = free.map(t => ({ t, r: Math.hypot(t.cx - c[0], t.cy - c[1]), a: angleOf(c, [t.cx, t.cy]) })).filter(p => p.r <= R * 2.2 + 30 && p.r > (pie.hole ? pie.hole * 0.95 : 0));
    const used = new Set();
    const slices = pie.slices.map(s => ({ ...s, mid: (s.start + s.span / 2) % 360 }));
    const fromMid = (p, s) => Math.min(Math.abs(p.a - s.mid), 360 - Math.abs(p.a - s.mid));
    // Names: the legend entry of the slice's colour; when most slices have one, a slice left over takes the entry
    // left over nearest its colour (a swatch drawn a shade off); else words beside it.
    for (const s of slices) s.entry = seriesName(legend, pie.box, s.color);
    const named = slices.filter(s => s.entry);
    if (named.length >= slices.length / 2) {
      const spare = legend.filter(e => !named.some(s => s.entry === e) && Math.max(0, pie.box.x0 - e.box.x1, e.box.x0 - pie.box.x1) + Math.max(0, pie.box.top - e.box.bottom, e.box.top - pie.box.bottom) < 200);
      for (const s of slices.filter(x => !x.entry)) {
        const e = spare.sort((a, b) => colourGap(a.color, s.color) - colourGap(b.color, s.color))[0];
        if (e && colourGap(e.color, s.color) <= 90) { s.entry = e; spare.splice(spare.indexOf(e), 1); }
      }
    }
    for (const s of slices) {
      if (s.entry) { const name = legendName(s.entry, tokens, legend); s.label = name.text; s.labelTokens = name.tokens; continue; }
      // (Words in the slice's direction: within thirty degrees of its middle, or of its edges if it is narrower.)
      const around = { start: (s.mid - Math.min(s.span / 2, 30) - 10 + 360) % 360, span: Math.min(s.span, 60) + 20 };
      const words = near.filter(p => !used.has(p.t) && hasLetters(p.t.text) && offArc(p.a, around) === 0 && p.r <= R * 1.35 + 15).sort((a, b) => fromMid(a, s) - fromMid(b, s));
      if (!words.length) continue;
      // The words on its line and on the lines just above and below it, set the same size.
      const block = [words[0].t];
      const joins = (b, t) => (Math.abs(b.base - t.base) <= 1 && Math.max(t.x0 - b.x1, b.x0 - t.x1) <= b.size * 0.6)
        || (Math.abs(t.size - b.size) <= 1 && Math.max(t.x0, b.x0) < Math.min(t.x1, b.x1) && (t.top > b.top ? t.top - b.base : b.top - t.base) <= b.size * 0.5);
      for (let grown = true; grown && block.length < 12;) {
        grown = false;
        for (const p of near) if (!block.includes(p.t) && !used.has(p.t) && block.some(b => joins(b, p.t))) { block.push(p.t); grown = true; }
      }
      block.sort((a, b) => a.base - b.base || a.x0 - b.x0);
      // A label is a few words; a paragraph beside the pie isn't one.
      if (block.reduce((n, t) => n + t.text.split(/\s+/).length, 0) > 10) continue;
      const text = block.filter(t => !t.num).map(t => t.text).join(' ');
      const m = LABEL_NUMBER.exec(text);
      s.label = (m ? m[1] : text).trim();
      if (m && chartNumber(m[2])) s.printed = { text: m[2].replace(/\s+/g, ''), num: chartNumber(m[2]) };
      const number = block.find(t => t.num);
      if (!s.printed && number) s.printed = { text: number.text, num: number.num, token: number };
      s.labelTokens = block;
      block.forEach(t => used.add(t));
    }
    // Values printed on or beside a slice, nearest its middle.
    for (const s of slices) {
      if (s.printed) continue;
      const nums = near.filter(p => !used.has(p.t) && p.t.num && offArc(p.a, s) <= 6 && p.r <= R * 1.6 + 20).sort((a, b) => (a.r > R * 1.05) - (b.r > R * 1.05) || fromMid(a, s) - fromMid(b, s));
      if (nums.length) { s.printed = { text: nums[0].t.text, num: nums[0].t.num, token: nums[0].t }; used.add(nums[0].t); }
    }
    // Printed numbers count when they follow the slices' sizes (percentages near the shares, or numbers in proportion).
    const printed = slices.filter(s => s.printed);
    const ratios = printed.filter(p => !p.printed.num.percent && p.share > 0).map(p => p.printed.num.value / p.share), mid = median(ratios);
    const agree = s => (s.printed.num.percent ? Math.abs(s.printed.num.value - s.share) <= Math.max(3, s.share * 0.25) : mid > 0 && Math.abs(s.printed.num.value / s.share - mid) <= mid * 0.25);
    const trusted = printed.length >= Math.max(2, slices.length * 0.6) && printed.filter(agree).length >= printed.length * 0.7;
    for (const s of slices) s.value = trusted && s.printed && agree(s) ? s.printed.text.replace(/\s+/g, '') : `${Math.round(s.share * 10) / 10}%`;
    // The pie's own name: words in the hole of a donut.
    const inHole = pie.hole ? free.filter(t => !used.has(t) && Math.hypot(t.cx - c[0], t.cy - c[1]) < pie.hole * 0.9).sort((a, b) => a.base - b.base || a.x0 - b.x0) : [];
    read.push({ pie, slices, used, measured: !trusted || slices.some(s => !s.printed || !agree(s)), name: inHole.length ? { text: inHole.map(t => t.text).join(' '), tokens: inHole } : null });
  }
  // Pies of the same categories (one legend for all): one table, a column each, when each pie has a name of its
  // own; any other pie, a table of its own.
  const key = p => p.slices.map(s => s.label).sort().join('\n');
  const groups = [];
  for (const p of read) { const g = groups.find(x => key(x[0]) === key(p)); if (g) g.push(p); else groups.push([p]); }
  for (let k = 0; k < groups.length; k++) {
    const group = groups[k];
    if (group.length > 1) for (const p of group) if (!p.name) { const t = titleAbove(p.pie.box.top, p.pie.box, tokens, new Set(taken), true); if (t && t.text.length <= 60) p.name = t; }
    const names = group.map(p => p.name?.text || (group.length > 1 ? '' : 'Value'));
    if (group.length > 1 && (names.some(n => !n) || new Set(names).size < names.length)) { groups.push(...group.map(p => [p])); continue; }
    const trial = new Set(taken);
    if (group.some(p => p.slices.some(s => !s.label))) continue;
    const labels = [];
    for (const p of group) for (const s of p.slices) if (!labels.includes(s.label)) labels.push(s.label);
    const chart = { kind: 'pie', box: boxOf(group.map(p => p.pie.box)), series: names, rows: labels.map(l => [l, ...group.map(p => p.slices.find(s => s.label === l)?.value || '')]), categories: labels, measured: group.some(p => p.measured) };
    if (!solid(chart)) continue;
    // The chart is the discs: words on them (values, names in a hole) are its own; the legend, the labels beside
    // the slices and the title stay the page's text as well, as they are printed. Where they are is the chart's area.
    const parts = [chart.box];
    for (const p of group) {
      const own = t => Math.hypot(t.cx - p.pie.centre[0], t.cy - p.pie.centre[1]) <= p.pie.R;
      for (const t of [...p.used, ...(p.name?.tokens || []), ...p.slices.flatMap(s => [s.printed?.token, ...s.labelTokens])]) if (t) { if (own(t)) trial.add(t); named.add(t); parts.push(t.box); }
    }
    chart.area = boxOf(parts);
    if (group.length === 1) {
      const title = titleAbove(chart.box.top, chart.box, tokens, trial);
      if (title) chart.title = title.text;
    }
    trial.forEach(t => taken.add(t));
    chart.box = { x0: round(chart.box.x0), x1: round(chart.box.x1), top: round(chart.box.top), bottom: round(chart.box.bottom) };
    charts.push(chart);
  }
  return charts;
}

/**
 * A chart as a structure block (pdf-structure.js): its data as a table (a header row of series names, then a row
 * per category), the title, and whether the values were printed on the chart or measured from the drawing.
 */
export function chartBlock(chart) {
  const rows = [['', ...chart.series], ...chart.rows];
  return {
    type: 'chart', chart: chart.kind, ...(chart.title && { title: chart.title }), rows, header: true, headerRows: 1,
    values: chart.measured ? 'measured' : 'printed',
    text: [chart.title, ...rows.map(r => r.filter(Boolean).join(' | '))].filter(Boolean).join('\n'),
    bbox: [round(chart.box.x0), round(chart.box.top), round(chart.box.x1 - chart.box.x0), round(chart.box.bottom - chart.box.top)],
  };
}

/**
 * Charts on one page.
 * @param {object[]} items  text items (pageItems in pdf-structure.js)
 * @param {{rects: object[], lines: object[]}} shapes  filled rectangles and stroked lines with their colours
 * @param {{width: number, height: number}} page
 * @returns {{charts: {kind: 'bar'|'line', title?: string, box, rows: string[][], series: string[], categories: string[], measured: boolean}[], items: Set<object>}}
 *   `items` are the text items the charts read (axis numbers, labels, legend, title), to leave out of the page's text.
 */
export function findCharts(items, shapes, page) {
  // Reading a chart is a bonus: a drawing it can't make sense of leaves the page as it was, never an error.
  try { return readCharts(items, shapes && withoutLetters(items, shapes), page); } catch { return { charts: [], items: new Set() }; }
}

/**
 * Shapes that are letters a recognizer has read (words drawn as outlines, now text items): left out of the drawing,
 * so the digits beside an axis aren't taken for the plot's first marks.
 */
function withoutLetters(items, shapes) {
  // (A recognizer's box can stop short of a descender or an accent: a third of the size around it counts.)
  // (A lone letter read in a chart is as often a marker, a triangle read as "A": its shape stays.)
  const read = items.filter(i => i.ocr && i.width > 0 && i.size > 0 && (/\d/.test(i.text) || (i.text.match(/\p{L}/gu)?.length || 0) >= 2)).map(i => ({ ...itemBox(i), pad: Math.max(1, i.size * 0.35) }));
  if (!read.length) return shapes;
  // (Letters are set in black or grey: a coloured shape under a word read is a marker the recognizer took for one.)
  const grey = c => { const v = rgbOf(c); return !v || Math.max(...v) - Math.min(...v) <= 40; };
  const inside = m => grey(m.color ?? m.line?.color) && read.some(b => m.x0 >= b.x0 - b.pad && m.x1 <= b.x1 + b.pad && m.y0 >= b.y0 - b.pad && m.y1 <= b.y1 + b.pad);
  const box = l => { const xs = l.pts.map(p => p[0]), ys = l.pts.map(p => p[1]); return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) }; };
  return { ...shapes, rects: shapes.rects.filter(r => !inside(r)), lines: shapes.lines.filter(l => !inside({ ...box(l), color: l.color })), dots: (shapes.dots || []).filter(d => !inside(d)), fills: (shapes.fills || []).filter(f => !inside(f)) };
}

const MAX_BAR_RECTS = 3000; // a page with more filled rectangles than this is a map or a pattern, not bars to read by their labels

/**
 * A chart worth writing out: two or more categories with a value and distinct labels, at least a quarter of the cells filled (a series can start late).
 * Anything shakier is left as the page's text.
 */
function solid(chart) {
  chart.rows = chart.rows.filter(r => r.slice(1).some(Boolean)); // a category with no value read is left out
  chart.categories = chart.rows.map(r => r[0]);
  const cells = chart.rows.flatMap(r => r.slice(1));
  // One category takes two or more series, all named.
  const named = chart.series.length >= 2 && chart.series.every(n => n && n !== 'Value' && n !== 'Unlabelled');
  if (chart.rows.length < (named ? 1 : 2) || !cells.length || cells.filter(Boolean).length < cells.length * 0.25) return false;
  const labels = chart.rows.map(r => r[0]);
  return new Set(labels).size >= labels.length * 0.8 && labels.every(l => l && l.length <= 120);
}

/**
 * A filled outline that keeps to its box: every point on (or within a little of) the box's edges and the shape
 * covering nearly all of it. A bar drawn with extra points or cut corners.
 */
function boxy(f) {
  const w = f.x1 - f.x0, h = f.y1 - f.y0;
  if (w < 1 || h < 1 || f.pts.length < 5 || f.pts.length > 400 || isWhite(f.color)) return false;
  const tol = Math.max(0.6, Math.min(w, h) * 0.2);
  if (!f.pts.every(([x, y]) => x - f.x0 <= tol || f.x1 - x <= tol || y - f.y0 <= tol || f.y1 - y <= tol)) return false;
  let area = 0;
  for (let k = 0; k < f.pts.length; k++) { const [ax, ay] = f.pts[k], [bx, by] = f.pts[(k + 1) % f.pts.length]; area += ax * by - bx * ay; }
  return Math.abs(area) / 2 >= w * h * 0.85;
}

/** findCharts without its safety net (for tests). */
export function readCharts(items, shapes, page) {
  const none = { charts: [], items: new Set() };
  if (!shapes || items.length > MAX_TOKENS * 2) return none;
  // Pies and donuts (filled slices that make a disc) first: their slices are neither bars nor markers.
  const pies = shapes.fills?.length ? findPies(shapes.fills, page) : [];
  if (pies.length) {
    const inPie = d => pies.some(p => d.x0 >= p.box.x0 - 1 && d.x1 <= p.box.x1 + 1 && d.y0 >= p.box.top - 1 && d.y1 <= p.box.bottom + 1);
    shapes = { ...shapes, dots: (shapes.dots || []).filter(d => !inPie(d)) };
  }
  // Bars drawn with rounded (or cut) corners: a filled shape of a few points, larger than a marker, counts by its box.
  // (Reading bars from the box of any filled shape follows ChartDetective, BSD-2-Clause.)
  // So do bars drawn as outlines of more points that keep to their box (a polygon with extra corners).
  // (A shape whose outline doesn't keep to its box, an area or a slice, isn't a bar however few its points.)
  const key = b => `${Math.round(b.x0)},${Math.round(b.y0)},${Math.round(b.x1)},${Math.round(b.y1)}`;
  // (A white box is no bar, but it is no area or slice either: a white piece of a stack keeps its box.)
  const shaped = new Set((shapes.fills || []).filter(f => !isWhite(f.color) && !boxy(f)).map(key));
  const boxes = [...(shapes.dots || []).filter(d => d.points <= 24 && (d.x1 - d.x0 > 16 || d.y1 - d.y0 > 16) && !shaped.has(key(d))), ...(shapes.fills || []).filter(boxy)];
  if (boxes.length) {
    const seen = new Set();
    const inPie = d => pies.some(p => d.x0 >= p.box.x0 - 1 && d.x1 <= p.box.x1 + 1 && d.y0 >= p.box.top - 1 && d.y1 <= p.box.bottom + 1);
    const extra = boxes.filter(b => !inPie(b) && !seen.has(key(b)) && seen.add(key(b))).map(({ x0, y0, x1, y1, color }) => ({ x0, y0, x1, y1, color }));
    // Bar-shaped ones (longer one way, or large) are bars, not markers.
    const barred = new Set((shapes.fills || []).filter(f => boxy(f) && (Math.max(f.x1 - f.x0, f.y1 - f.y0) > 12 || Math.max(f.x1 - f.x0, f.y1 - f.y0) > Math.min(f.x1 - f.x0, f.y1 - f.y0) * 1.6)).map(key));
    shapes = { ...shapes, rects: [...shapes.rects, ...extra], dots: (shapes.dots || []).filter(d => !barred.has(key(d))) };
  }
  // Cheap checks first: a chart needs something drawn and at least three numbers for an axis (a pie, neither).
  if (!pies.length) {
    if (!(shapes.rects.length + shapes.lines.length)) return none;
    let numbers = 0;
    for (const i of items) if (/\d/.test(i.text) && i.text.length <= 12 && ++numbers >= 3) break;
    if (numbers < 3) return none;
  }
  const tokens = tokensOf(items);
  if (tokens.length > MAX_TOKENS) return none;
  const axes = [...valueAxes(tokens, true), ...valueAxes(tokens, false)];
  // Numbers of a value axis aren't labels; a row of numbers taken for a value axis may still be the category labels
  // of bars standing on it (96, 97, 98 under the bars), so for those only the other direction's axes count.
  for (const a of axes) for (const t of a.ticks) t[a.vertical ? 'tickV' : 'tickH'] = t.tick = true;
  const legend = legendEntries(tokens, shapes);
  const taken = new Set(), charts = [], unread = [];
  if (pies.length) {
    const named = new Set();
    charts.push(...pieCharts(pies, tokens, legend, taken, named));
    // A legend a pie has read names its slices, not the series of another chart.
    legend.splice(0, legend.length, ...legend.filter(e => !e.tokens.some(t => named.has(t))));
  }
  for (const axis of axes) {
    if (axis.ticks.some(t => taken.has(t))) continue;
    const plot = plotOf(axis, axes, shapes, page);
    if (!plot) continue;
    let trial = new Set(taken);
    let chart = barChart(axis, plot, legend, tokens, trial, axes);
    if (!chart) { trial = new Set(taken); chart = lineChart(axis, plot, legend, tokens, trial, axes); }
    if (!chart || !solid(chart)) { unread.push({ axis, plot }); continue; }
    const title = panelTitle(chart.box, plot.box, tokens, trial) || titleAbove(chart.box.top, chart.box, tokens, trial);
    if (title) { chart.title = title.text; title.tokens.forEach(t => trial.add(t)); }
    // Numbers left inside the plot (data labels that weren't matched) would read as stray figures.
    for (const t of tokens) if (t.num && !t.angle && t.cx > plot.box.x0 && t.cx < plot.box.x1 && t.cy > plot.box.top && t.cy < plot.box.bottom) trial.add(t);
    trial.forEach(t => taken.add(t));
    chart.box = { x0: round(chart.box.x0), x1: round(chart.box.x1), top: round(chart.box.top), bottom: round(chart.box.bottom) };
    charts.push(chart);
  }
  // Bar charts with a number on each bar and no value axis, where no chart was read.
  const inChart = r => charts.some(c => r.x0 >= c.box.x0 - 2 && r.x1 <= c.box.x1 + 2 && r.y0 >= c.box.top - 2 && r.y1 <= c.box.bottom + 2);
  const implied = shapes.rects.length <= MAX_BAR_RECTS ? impliedAxes(tokens.filter(t => !taken.has(t)), { ...shapes, rects: shapes.rects.filter(r => !inChart(r)) }, page) : [];
  for (const { axis, plot } of implied) {
    if (plot.marks.some(m => inChart(m))) continue;
    const trial = new Set(taken);
    const chart = barChart(axis, plot, legend, tokens, trial);
    if (!chart || !solid(chart)) continue;
    const title = titleAbove(chart.box.top, chart.box, tokens, trial);
    if (title) { chart.title = title.text; title.tokens.forEach(t => trial.add(t)); }
    trial.forEach(t => taken.add(t));
    chart.box = { x0: round(chart.box.x0), x1: round(chart.box.x1), top: round(chart.box.top), bottom: round(chart.box.bottom) };
    charts.push(chart);
  }
  // Line charts with a number at each point and no value axis.
  charts.push(...impliedLineCharts(tokens, shapes, legend, taken, inChart));
  return { charts, items: new Set([...taken].flatMap(t => t.items)), strips: labelStrips(unread, charts, tokens, legend, page), plots: [...unread.map(u => u.plot.box), ...charts.filter(c => c.area).map(c => c.area)] };
}

// ---------------------------------------------------------------------------------------------- charts as pictures

const MAX_CHART_PICTURES = 3;

/**
 * Pictures that may be charts: placed images at least 120 by 80 points, not the whole page (a scan), with almost
 * none of the page's text over them. Each is read with OCR and its pixels (chartPictureShapes) as a chart.
 * Boxes {x0, y0, x1, y1} in page points.
 */
export function chartPictures(boxes, items, page) {
  const out = [];
  for (const [x, y, w, h] of boxes || []) {
    if (w < 120 || h < 80 || w * h > page.width * page.height * 0.85) continue;
    const box = { x0: Math.max(0, x), y0: Math.max(0, y), x1: Math.min(page.width, x + w), y1: Math.min(page.height, y + h) };
    if (items.filter(i => i.x + i.width / 2 > box.x0 && i.x + i.width / 2 < box.x1 && i.y + i.size / 2 > box.y0 && i.y + i.size / 2 < box.y1).length > 2) continue;
    if (out.some(o => o.x0 < box.x1 && o.x1 > box.x0 && o.y0 < box.y1 && o.y1 > box.y0)) continue;
    out.push(box);
  }
  return out.sort((a, b) => (b.x1 - b.x0) * (b.y1 - b.y0) - (a.x1 - a.x0) * (a.y1 - a.y0)).slice(0, MAX_CHART_PICTURES);
}

/**
 * The bars of a chart drawn as a picture: areas of one colour (not white) that fill their box (four fifths of it or
 * more), as filled rectangles in page points with their colour, so the picture reads like a chart drawn as shapes.
 * Pixels are looked at two by two (one by one in a picture drawn at 144 dpi or less); runs of one colour (give or take a little) on a row join the runs of like colour
 * they touch on the row above.
 * (Bars found as same-coloured connected regions follow DeepRule's Bar.py, BSD-3-Clause, and ReVision, MIT; ideas
 * only.) `pixels`: {width, height, scale, data (RGBA)}; `region`: where the picture was drawn from, in page points.
 */
export function chartPictureShapes(pixels, region) {
  const { width, height, scale, data } = pixels, step = scale >= 2 ? 2 : 1, cols = Math.floor(width / step), rows = Math.floor(height / step);
  const at = (cx, cy) => (cy * step * width + cx * step) * 4;
  const near = (k, c) => Math.abs(data[k] - c[0]) + Math.abs(data[k + 1] - c[1]) + Math.abs(data[k + 2] - c[2]) <= 30;
  const parent = [], find = i => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const runs = [];
  let prev = [];
  for (let cy = 0; cy < rows; cy++) {
    const row = [];
    for (let cx = 0; cx < cols;) {
      const k = at(cx, cy), c = [data[k], data[k + 1], data[k + 2]];
      let end = cx + 1;
      while (end < cols && near(at(end, cy), c)) end++;
      // White (the background) is no shape.
      if (!(c[0] >= 235 && c[1] >= 235 && c[2] >= 235)) {
        const id = runs.length;
        parent.push(id);
        runs.push({ x0: cx, x1: end - 1, y: cy, c });
        row.push(id);
        for (const p of prev) {
          const q = runs[p];
          if (q.x0 <= end - 1 && q.x1 >= cx && Math.abs(q.c[0] - c[0]) + Math.abs(q.c[1] - c[1]) + Math.abs(q.c[2] - c[2]) <= 30) { const a = find(p), b = find(id); if (a !== b) parent[b] = a; }
        }
      }
      cx = end;
    }
    prev = row;
    if (runs.length > 300000) return [];
  }
  const merged = new Map();
  runs.forEach((r, i) => {
    const root = find(i), n = r.x1 - r.x0 + 1, m = merged.get(root);
    if (!m) merged.set(root, { x0: r.x0, x1: r.x1, y0: r.y, y1: r.y, n, c: [r.c[0] * n, r.c[1] * n, r.c[2] * n] });
    else { m.x0 = Math.min(m.x0, r.x0); m.x1 = Math.max(m.x1, r.x1); m.y0 = Math.min(m.y0, r.y); m.y1 = Math.max(m.y1, r.y); m.n += n; for (let k = 0; k < 3; k++) m.c[k] += r.c[k] * n; }
  });
  const rects = [];
  for (const m of merged.values()) {
    const w = m.x1 - m.x0 + 1, h = m.y1 - m.y0 + 1;
    if (w < 3 || h < 3 || m.n < w * h * 0.8 || (w >= cols * 0.95 && h >= rows * 0.95)) continue;
    const color = '#' + m.c.map(v => Math.round(v / m.n).toString(16).padStart(2, '0')).join('');
    const toX = cx => region.x0 + cx * step / scale, toY = cy => region.y0 + cy * step / scale;
    rects.push({ x0: round(toX(m.x0)), y0: round(toY(m.y0)), x1: round(toX(m.x1 + 1)), y1: round(toY(m.y1 + 1)), color });
    if (rects.length > MAX_BAR_RECTS) return [];
  }
  return rects;
}

/** Bars enough to be a chart: three or more areas of one colour, two of them the same colour (not a photo). */
export function looksLikeBars(rects) {
  if (rects.length < 3) return false;
  return rects.some((r, k) => rects.some((o, j) => j > k && sameColour(r.color, o.color) && (r.x1 - r.x0 > 3 || r.y1 - r.y0 > 3)));
}

// ---------------------------------------------------------------------------------------------- text as outlines

/**
 * Of the words OCR read in such an area, those over letter outlines and clear of the page's own text: what the
 * outlines say (the page's text read again, or a swatch read as letters, is left out).
 */
export function outlinedWords(words, marks, items) {
  const glyphs = (marks || []).filter(m => !m.stroked && !m.light && m.y1 - m.y0 <= 16 && m.x1 - m.x0 <= 16 && (!m.rect || m.x1 - m.x0 < (m.y1 - m.y0) * 0.4));
  const text = items.map(i => ({ x0: i.x - 1, y0: i.y - 1, x1: i.x + i.width + 1, y1: i.y + i.size + 1 }));
  return words.filter(w => {
    const b = w.angle ? (() => { const a = w.angle * Math.PI / 180, ex = w.x + Math.cos(a) * w.width, ey = w.y + w.size - Math.sin(a) * w.width; return { x0: Math.min(w.x, ex) - w.size, x1: Math.max(w.x, ex) + w.size, y0: Math.min(w.y, ey - w.size), y1: Math.max(w.y + w.size, ey) }; })() : { x0: w.x, x1: w.x + w.width, y0: w.y, y1: w.y + w.size };
    const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
    if (text.some(t => cx >= t.x0 && cx <= t.x1 && cy >= t.y0 && cy <= t.y1)) return false;
    return glyphs.some(g => { const gx = (g.x0 + g.x1) / 2, gy = (g.y0 + g.y1) / 2; return gx >= b.x0 && gx <= b.x1 && gy >= b.y0 && gy <= b.y1; });
  });
}

const MAX_OUTLINE_AREAS = 3;

/**
 * Charts whose words and numbers are drawn as letter outlines (filled shapes, not text): where they are, to read
 * with OCR. Letter-sized filled shapes, most of them curved, gathered while they are within 45 points of one another
 * (an axis's numbers, its labels and the legend of one chart come together), twenty letters or more, not mostly
 * under the page's own text. Areas {x0, y0, x1, y1} in page points, the fullest first.
 */
export function outlineTextAreas(marks, items, page) {
  if (!marks?.length || marks.length > 20000) return [];
  const glyphs = marks.filter(m => !m.stroked && !m.light && m.y1 - m.y0 <= 16 && m.x1 - m.x0 <= 16 && Math.max(m.x1 - m.x0, m.y1 - m.y0) >= 1.5);
  if (glyphs.filter(m => m.curved).length < 20 || glyphs.length > 4000) return [];
  const parent = glyphs.map((_, k) => k), find = k => (parent[k] === k ? k : (parent[k] = find(parent[k])));
  const order = glyphs.map((_, k) => k).sort((a, b) => glyphs[a].x0 - glyphs[b].x0), GAP = 45;
  for (let i = 0; i < order.length; i++) {
    const a = glyphs[order[i]];
    for (let j = i + 1; j < order.length && glyphs[order[j]].x0 <= a.x1 + GAP; j++) {
      const b = glyphs[order[j]];
      if (b.y0 <= a.y1 + GAP && b.y1 >= a.y0 - GAP) parent[find(order[i])] = find(order[j]);
    }
  }
  const groups = new Map();
  glyphs.forEach((g, k) => { const r = find(k); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(g); });
  const text = items.map(i => ({ x0: i.x, y0: i.y, x1: i.x + i.width, y1: i.y + i.size }));
  const areas = [];
  for (const list of groups.values()) {
    if (list.length < 20 || list.filter(g => g.curved).length < 10) continue;
    const a = { x0: Math.min(...list.map(g => g.x0)) - 4, y0: Math.min(...list.map(g => g.y0)) - 4, x1: Math.max(...list.map(g => g.x1)) + 4, y1: Math.max(...list.map(g => g.y1)) + 4 };
    // Letters mostly under the page's own text are that text's, not a chart's.
    if (text.filter(t => t.x0 < a.x1 && t.x1 > a.x0 && t.y0 < a.y1 && t.y1 > a.y0).length > list.length / 4) continue;
    areas.push({ x0: Math.max(0, a.x0), y0: Math.max(0, a.y0), x1: Math.min(page.width, a.x1), y1: Math.min(page.height, a.y1), n: list.length });
  }
  return areas.sort((a, b) => b.n - a.n).slice(0, MAX_OUTLINE_AREAS).map(({ n, ...a }) => a);
}

/**
 * Where a chart's category labels should be but no text is: under the bars (or lines) of a plot that was found but
 * not read, a band as wide as the plot and up to 90 points deep. The labels there are drawn as shapes or pictures,
 * so they can be read with OCR (extractStructure) and the chart read again. [{x0, y0, x1, y1}] in page points.
 */
function labelStrips(unread, charts, tokens, legend, page) {
  const strips = [];
  for (const { axis, plot } of unread) {
    if (!axis.vertical || axis.implied) continue;
    const bars = readBars(axis, plot, legend), lines = bars ? [] : plotLines(plot, legend);
    if (!(bars?.bars.length >= 2) && !lines.length) continue;
    const ends = bars ? bars.bars.flatMap(b => b.segments.map(seg => Math.max(seg.far, seg.near))) : lines.flatMap(l => l.pts.map(p => p[1]));
    const x0 = bars ? Math.min(...bars.bars.map(b => b.c0)) - 4 : plot.box.x0, x1 = bars ? Math.max(...bars.bars.map(b => b.c1)) + 4 : plot.box.x1;
    // Down to the first line of text under it (a note, a source) or 90 points, whichever comes first.
    // (Below a gridline past the last label too: the strip starts under the plot.)
    const y0 = Math.max(...ends, ...axis.ticks.map(t => t.cy), plot.gridEnd ?? -Infinity) + 1;
    const below = tokens.filter(t => !t.tick && t.box.top > y0 + 6 && t.box.x1 > x0 && t.box.x0 < x1 && t.box.x1 - t.box.x0 > 40).map(t => t.box.top);
    const y1 = Math.min(page.height, y0 + 90, ...below.map(top => top - 1));
    const strip = { x0: round(x0), y0: round(y0), x1: round(x1), y1: round(y1) };
    if (strip.x1 - strip.x0 < 40) continue;
    // Labels that are text (three or more words just under the plot, just not read) are not this case; nor is a strip
    // a chart already covers.
    if (tokens.filter(t => !t.tick && t.cx > strip.x0 && t.cx < strip.x1 && t.box.top < y0 + 20 && t.box.bottom > y0).length >= 3) continue;
    if (charts.some(c => c.box.x0 < strip.x1 && c.box.x1 > strip.x0 && c.box.top < strip.y1 && c.box.bottom > strip.y0)) continue;
    if (strips.some(o => o.x0 < strip.x1 && o.x1 > strip.x0 && o.y0 < strip.y1 && o.y1 > strip.y0)) continue;
    strips.push(strip);
  }
  return strips;
}

/**
 * Text items from Tesseract's reading of a strip of a page (its `data` with words). The strip was drawn at `scale` pixels
 * per point (`width` x `height` pixels) and turned `angle` degrees clockwise about its middle before reading (so labels
 * set at that angle, reading upwards, read level); each word is turned back to where it is on the page, as an item set
 * at that angle. Words under 50 confidence, or without a letter or digit, are left out.
 */
export function stripItems(data, { region, scale, angle = 0, width, height, sure = 50 }) {
  const items = [], rad = angle * Math.PI / 180, cos = Math.cos(rad), sin = Math.sin(rad);
  // The turned drawing's size, and the reading direction and "up" of a word on the page (y runs down).
  const tw = width * cos + height * sin, th = width * sin + height * cos;
  const dir = [cos, -sin], up = [-sin, -cos];
  for (const b of data?.blocks || []) for (const p of b.paragraphs || []) for (const l of p.lines || []) for (const w of l.words || []) {
    if (w.confidence < sure || !/[\p{L}\p{N}]/u.test(w.text || '')) continue;
    const { x0, y0, x1, y1 } = w.bbox;
    // The word's middle, turned back by the angle about the strip's middle, in page points.
    const mx = (x0 + x1) / 2 - tw / 2, my = (y0 + y1) / 2 - th / 2;
    const cx = region.x0 + (width / 2 + mx * cos + my * sin) / scale, cy = region.y0 + (height / 2 - mx * sin + my * cos) / scale;
    const length = (x1 - x0) / scale, size = (y1 - y0) / scale;
    // Its baseline starts half a length back along the reading direction and half a size down from the middle.
    const ox = cx - dir[0] * length / 2 - up[0] * size / 2, oy = cy - dir[1] * length / 2 - up[1] * size / 2;
    items.push(Object.defineProperty({ text: w.text, x: ox, y: oy - size, width: length, size, font: '', bold: false, italic: false, ...(angle && { angle }), ocr: true }, 'confidence', { value: w.confidence, enumerable: false }));
  }
  return items;
}

/** A text item's box on the page, its angle followed (items as stripItems makes them: baseline start at y + size). */
function itemBox(i) {
  const rad = (i.angle || 0) * Math.PI / 180, dir = [Math.cos(rad), -Math.sin(rad)], up = [-Math.sin(rad), -Math.cos(rad)];
  const ox = i.x, oy = i.y + i.size, pts = [[ox, oy], [ox + dir[0] * i.width, oy + dir[1] * i.width], [ox + up[0] * i.size, oy + up[1] * i.size], [ox + dir[0] * i.width + up[0] * i.size, oy + dir[1] * i.width + up[1] * i.size]];
  return { x0: Math.min(...pts.map(p => p[0])), x1: Math.max(...pts.map(p => p[0])), y0: Math.min(...pts.map(p => p[1])), y1: Math.max(...pts.map(p => p[1])) };
}
const overlaps = (a, b) => Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) > 0.5 && Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) > 0.5;

/** Two read words on top of each other: measured along and across their lines when set at one angle (slanted labels
 *  side by side have boxes that overlap on the page though the words don't), by their boxes otherwise. */
function clash(a, b, bBox) {
  // (Words read at another angle count as clashing when near: one read askew lands a little off where it is.)
  if ((a.angle || 0) !== (b.angle || 0)) { const m = Math.max(a.size, b.size); return overlaps({ x0: a.box.x0 - m, x1: a.box.x1 + m, y0: a.box.y0 - m, y1: a.box.y1 + m }, bBox); }
  const rad = (a.angle || 0) * Math.PI / 180, dir = [Math.cos(rad), -Math.sin(rad)], up = [-Math.sin(rad), -Math.cos(rad)];
  const span = (i, v) => { const p = i.x * v[0] + (i.y + i.size) * v[1]; return [p, p + (v === dir ? i.width : i.size)]; };
  const [a0, a1] = span(a, dir), [b0, b1] = span(b, dir), [c0, c1] = span(a, up), [d0, d1] = span(b, up);
  return Math.min(a1, b1) - Math.max(a0, b0) > 0.5 && Math.min(c1, d1) - Math.max(c0, d0) > 0.5;
}

/** How well a strip reads: the letters and digits of its confidently read words of two or more of them (noise, read the
 *  wrong way round, comes out as scattered single marks). */
export function stripScore(data) {
  let n = 0;
  for (const b of data?.blocks || []) for (const p of b.paragraphs || []) for (const l of p.lines || []) for (const w of l.words || []) {
    const chars = (w.text || '').match(/[\p{L}\p{N}]/gu)?.length || 0;
    if (w.confidence >= 70 && chars >= 2) n += chars;
  }
  return n;
}

/**
 * OCR of a strip of a page (chart labels drawn as shapes): the strip drawn at 300 dpi and read level, turned a quarter
 * (labels set upright, reading upwards) and turned an eighth (slanted labels); the best reading kept, as text items on
 * the page. Shared by the app (ocr.js) and Node (pdf-node.js), which pass their canvas and Tesseract engine:
 * `createCanvas(w, h)`, `recognize(image)` resolving to Tesseract's data with blocks, and `toImage(canvas)` for what
 * recognize takes.
 */
export async function readStrip(page, region, { createCanvas, recognize, toImage = canvas => canvas }) {
  // (Pixels alone, to tell whether a picture holds bars, are looked at in less detail: 72 dpi.)
  const scale = (region.pixels && region.text === false ? 72 : 300) / 72;
  const width = Math.ceil((region.x1 - region.x0) * scale), height = Math.ceil((region.y1 - region.y0) * scale);
  const canvas = createCanvas(width, height), made = [canvas];
  try {
    const viewport = page.getViewport({ scale, offsetX: -region.x0 * scale, offsetY: -region.y0 * scale });
    await page.render({ canvasContext: canvas.getContext('2d'), canvas, viewport, background: '#fff' }).promise;
    // A picture of a chart (region.pixels): its pixels go back with the words, read level only; with
    // region.text false, the pixels alone (no reading).
    const pixels = region.pixels ? { width, height, scale, data: canvas.getContext('2d').getImageData(0, 0, width, height).data } : null;
    if (pixels && region.text === false) return Object.assign([], { pixels });
    let best = null;
    const readings = [];
    for (const angle of region.pixels ? [0] : [0, 90, 45]) {
      let image = canvas;
      if (angle) {
        const rad = angle * Math.PI / 180, tw = Math.ceil(width * Math.cos(rad) + height * Math.sin(rad)), th = Math.ceil(width * Math.sin(rad) + height * Math.cos(rad));
        image = createCanvas(tw, th); made.push(image);
        const ctx = image.getContext('2d');
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, tw, th);
        ctx.translate(tw / 2, th / 2); ctx.rotate(rad); ctx.drawImage(canvas, -width / 2, -height / 2);
      }
      const data = await recognize(await toImage(image));
      const score = stripScore(data);
      readings.push({ score, data, angle });
      if (!best || score > best.score) best = { score, data, angle, image };
    }
    // A strip may hold words at more than one angle (upright labels along the bottom, level numbers up the side): the
    // best reading's words and the other readings' sure ones, the weightiest first (letters and digits by confidence),
    // each where no weightier word is.
    // (The best reading's words of three or more letters and digits, with a letter, all go in first; its scraps and
    // numbers vie with the others' words: a number read sideways is a scrap of one.)
    const chars = w => w.text.match(/[\p{L}\p{N}]/gu)?.length || 0;
    const words = readings.flatMap(r => stripItems(r.data, { region, scale, angle: r.angle, width, height, sure: r.angle === best.angle ? 50 : 70 }).map(w => Object.defineProperty(w, 'first', { value: r.angle === best.angle && chars(w) >= 3 && /\p{L}/u.test(w.text), enumerable: false })));
    const weight = w => chars(w) * (w.confidence ?? 50);
    const items = [];
    for (const w of words.sort((a, b) => b.first - a.first || weight(b) - weight(a))) {
      const box = itemBox(w);
      if (w.first || !items.some(o => clash(o, w, box))) items.push(Object.defineProperty(w, 'box', { value: box, enumerable: false }));
    }
    if (pixels) items.pixels = pixels;
    return items;
  } finally { for (const c of made) c.width = c.height = 0; }
}
