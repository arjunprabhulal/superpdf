// Compare PDFs: the parts that don't need a browser, shared by runners/compare.js and the Node tests.
//   diffWords(before, after)       word-level text diff: {ops: [{type: 'equal'|'delete'|'insert', text}], coarse}
//   diffRegions(a, b, width, height)  areas that differ between two renders of the same size, as boxes
//   summarize(pages), textReport(…)   what changed, in a sentence and as a plain-text report
// Pages are paired by position: page 1 with page 1, and so on.

export const MAX_EDITS = 2000; // past this many word edits on a page, compare whole lines instead

const words = text => String(text ?? '').split(/\s+/).filter(Boolean);
const lines = text => String(text ?? '').split('\n').map(line => line.trim().replace(/\s+/g, ' ')).filter(Boolean);

/**
 * Myers' O(ND) shortest edit script between token arrays (common prefix and suffix already removed).
 * Returns [['equal'|'delete'|'insert', token], …], or null when more than `maxEdits` edits are needed,
 * which keeps time and memory bounded (memory grows with the square of the number of edits).
 */
function editScript(a, b, maxEdits) {
  const n = a.length, m = b.length, limit = Math.min(n + m, maxEdits);
  const off = limit + 1, v = new Int32Array(2 * limit + 3); // v[off + k]: furthest x reached on diagonal k
  const trace = [];
  for (let d = 0; d <= limit; d++) {
    trace.push(v.slice(off - d - 1, off + d + 2)); // the state before step d, for diagonals -d-1 … d+1
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[off + k] = x;
      if (x >= n && y >= m) return backtrack(trace, d, a, b);
    }
  }
  return null;
}

function backtrack(trace, edits, a, b) {
  const out = [];
  let x = a.length, y = b.length;
  for (let d = edits; d > 0; d--) {
    const state = trace[d], at = k => state[k + d + 1];
    const k = x - y;
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1)); // an insertion from diagonal k+1
    const prevK = down ? k + 1 : k - 1, prevX = at(prevK), prevY = prevX - prevK;
    while (x > prevX && y > prevY) out.push(['equal', a[--x], --y]);
    if (down) out.push(['insert', b[--y]]); else out.push(['delete', a[--x]]);
  }
  while (x > 0 && y > 0) { y--; out.push(['equal', a[--x]]); }
  return out.reverse();
}

/** Token-level diff as runs of the same kind: [{type, tokens}], or null when there are too many edits. */
function diffTokens(a, b, maxEdits) {
  let start = 0, endA = a.length, endB = b.length;
  while (start < endA && start < endB && a[start] === b[start]) start++;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const middle = editScript(a.slice(start, endA), b.slice(start, endB), maxEdits);
  if (!middle) return null;
  const runs = [];
  const push = (type, token) => { const last = runs.at(-1); if (last?.type === type) last.tokens.push(token); else runs.push({ type, tokens: [token] }); };
  for (const token of a.slice(0, start)) push('equal', token);
  // Within a changed stretch, show what was removed before what was added.
  let pending = { delete: [], insert: [] };
  const flush = () => { for (const t of pending.delete) push('delete', t); for (const t of pending.insert) push('insert', t); pending = { delete: [], insert: [] }; };
  for (const [type, token] of middle) { if (type === 'equal') { flush(); push('equal', token); } else pending[type].push(token); }
  flush();
  for (const token of a.slice(endA)) push('equal', token);
  return runs;
}

/**
 * Word-level diff of two texts. Whitespace only separates words, so reflowed text compares equal.
 * Very different texts fall back to whole lines (`coarse: true`), and beyond that to "all removed, all added".
 */
export function diffWords(before, after, { maxEdits = MAX_EDITS } = {}) {
  const join = (runs, sep) => runs.map(run => ({ type: run.type, text: run.tokens.join(sep) }));
  const runs = diffTokens(words(before), words(after), maxEdits);
  if (runs) return { ops: join(runs, ' '), coarse: false };
  const la = lines(before), lb = lines(after);
  const byLine = diffTokens(la, lb, maxEdits)
    || [{ type: 'delete', tokens: la }, { type: 'insert', tokens: lb }].filter(run => run.tokens.length);
  return { ops: join(byLine, '\n'), coarse: true };
}

/** Words removed and added in a diff. */
export function diffStats(ops) {
  const count = type => ops.filter(op => op.type === type).reduce((n, op) => n + words(op.text).length, 0);
  return { deleted: count('delete'), inserted: count('insert') };
}

/** The diff as text, with [-removed-] and {+added+} marks. */
export function markText(ops) {
  return ops.map(op => op.type === 'delete' ? `[-${op.text}-]` : op.type === 'insert' ? `{+${op.text}+}` : op.text).join(' ');
}

/**
 * Areas that differ between two RGBA images of the same size (canvas ImageData.data).
 * The image is divided into `cell`-pixel squares. A pixel counts as changed when any channel differs by more
 * than `threshold` (so faint anti-aliasing differences don't), and a square as changed when it has at least
 * `minPixels` changed pixels (so stray single pixels don't). Changed squares that touch, or are within `gap`
 * squares of each other, are merged, and the result is their bounding boxes in pixels, top to bottom.
 */
export function diffRegions(a, b, width, height, { cell = 16, threshold = 40, minPixels = 3, gap = 1 } = {}) {
  if (a.length !== b.length || a.length !== width * height * 4) throw new Error('Both images must be the same size.');
  const cols = Math.ceil(width / cell), rows = Math.ceil(height / cell);
  const counts = new Uint32Array(cols * rows);
  for (let y = 0; y < height; y++) {
    const row = Math.floor(y / cell) * cols;
    for (let x = 0, i = y * width * 4; x < width; x++, i += 4) {
      if (Math.abs(a[i] - b[i]) > threshold || Math.abs(a[i + 1] - b[i + 1]) > threshold || Math.abs(a[i + 2] - b[i + 2]) > threshold || Math.abs(a[i + 3] - b[i + 3]) > threshold) counts[row + Math.floor(x / cell)]++;
    }
  }
  // Group changed squares: flood fill, treating squares up to `gap` apart as neighbours.
  const seen = new Uint8Array(cols * rows), boxes = [], reach = gap + 1;
  for (let start = 0; start < counts.length; start++) {
    if (seen[start] || counts[start] < minPixels) continue;
    const box = { left: cols, top: rows, right: -1, bottom: -1 }, stack = [start];
    seen[start] = 1;
    while (stack.length) {
      const index = stack.pop(), cx = index % cols, cy = (index - cx) / cols;
      box.left = Math.min(box.left, cx); box.right = Math.max(box.right, cx); box.top = Math.min(box.top, cy); box.bottom = Math.max(box.bottom, cy);
      for (let ny = Math.max(0, cy - reach); ny <= Math.min(rows - 1, cy + reach); ny++) {
        for (let nx = Math.max(0, cx - reach); nx <= Math.min(cols - 1, cx + reach); nx++) {
          const j = ny * cols + nx;
          if (!seen[j] && counts[j] >= minPixels) { seen[j] = 1; stack.push(j); }
        }
      }
    }
    boxes.push(box);
  }
  // Bounding boxes of separate groups can still overlap (an L shape around another group): merge those.
  for (let merged = true; merged;) {
    merged = false;
    for (let i = 0; i < boxes.length && !merged; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const p = boxes[i], q = boxes[j];
        if (p.left <= q.right + reach && q.left <= p.right + reach && p.top <= q.bottom + reach && q.top <= p.bottom + reach) {
          boxes[i] = { left: Math.min(p.left, q.left), top: Math.min(p.top, q.top), right: Math.max(p.right, q.right), bottom: Math.max(p.bottom, q.bottom) };
          boxes.splice(j, 1);
          merged = true;
          break;
        }
      }
    }
  }
  return boxes
    .map(box => ({ x: box.left * cell, y: box.top * cell, width: Math.min(width, (box.right + 1) * cell) - box.left * cell, height: Math.min(height, (box.bottom + 1) * cell) - box.top * cell }))
    .sort((p, q) => p.y - q.y || p.x - q.x);
}

/** [2, 3, 4, 9] → "2–4, 9". */
export function pageList(numbers) {
  const parts = [];
  for (let i = 0; i < numbers.length; i++) {
    let j = i;
    while (j + 1 < numbers.length && numbers[j + 1] === numbers[j] + 1) j++;
    parts.push(j > i ? `${numbers[i]}–${numbers[j]}` : `${numbers[i]}`);
    i = j;
  }
  return parts.join(', ');
}

const pagesPhrase = list => `${list.length === 1 ? 'page' : 'pages'} ${pageList(list)}`;
const capital = s => s[0].toUpperCase() + s.slice(1);

/**
 * One-line summary from [{page, status: 'same'|'changed'|'added'|'removed'}], such as
 * "3 of 12 pages changed: pages 2, 5, 9. Page 13 added."
 */
export function summarize(pages) {
  const by = status => pages.filter(p => p.status === status).map(p => p.page);
  const changed = by('changed'), compared = pages.filter(p => p.status === 'same' || p.status === 'changed').length;
  const added = by('added'), removed = by('removed');
  const parts = [];
  if (!compared) parts.push('No pages to compare.');
  else if (!changed.length) parts.push(compared === 1 ? 'The page is the same in both versions.' : `All ${compared} pages are the same in both versions.`);
  else if (compared === 1) parts.push('The page changed.');
  else parts.push(`${changed.length} of ${compared} pages changed: ${pagesPhrase(changed)}.`);
  if (removed.length) parts.push(`${capital(pagesPhrase(removed))} removed.`);
  if (added.length) parts.push(`${capital(pagesPhrase(added))} added.`);
  return parts.join(' ');
}

/** What changed on one page, in words: "2 areas look different. Text: 3 words removed, 1 added." */
export function describePage({ status, regions = [], ops = [] }) {
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const { deleted, inserted } = diffStats(ops);
  if (status === 'added') return `Only in the revised version (${plural(inserted, 'word')}).`;
  if (status === 'removed') return `Only in the earlier version (${plural(deleted, 'word')}).`;
  const look = regions.length ? `${plural(regions.length, 'area')} ${regions.length === 1 ? 'looks' : 'look'} different.` : 'No visible difference.';
  const text = deleted || inserted ? `Text: ${[deleted && `${plural(deleted, 'word')} removed`, inserted && `${plural(inserted, 'word')} added`].filter(Boolean).join(', ')}.` : 'Same text.';
  return `${look} ${text}`;
}

/**
 * Plain-text report. `pages`: [{page, status, regions, ops}], `names`: {before, after} file names.
 * Changed, added and removed pages get their text with [-removed-] and {+added+} marks.
 */
export function textReport(pages, names) {
  const out = [`Comparison of ${names.before} (earlier) and ${names.after} (revised)`, summarize(pages), '', 'Marks: [-removed text-] {+added text+}', ''];
  for (const page of pages) {
    if (page.status === 'same') continue;
    out.push(`Page ${page.page}: ${describePage(page)}`);
    const text = markText(page.ops || []);
    out.push(text || '(no text on this page)', '');
  }
  return `${out.join('\n').trim()}\n`;
}
