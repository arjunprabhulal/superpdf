// PDF to mind map: a mind map of a PDF's sections, and a flowchart of one section drawn by the on-device
// model as Mermaid code. Pure (no DOM), tested in Node. Section titles come from the PDF and the Mermaid
// code from a model, so both are untrusted: titles are escaped before markmap shows them as HTML, and
// model code is cleaned of anything that isn't diagram structure before Mermaid parses it.

const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clean = s => String(s ?? '').replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
/** Long headings are cut to `max` characters in the picture (the outline keeps them whole). */
const short = (s, max = 90) => s.length > max ? `${s.slice(0, max - 1).replace(/\s+\S*$/, '')}…` : s;

/** "p. 3", "pp. 3–5". */
export const pagesLabel = node => node.startPage === node.endPage || !node.endPage ? `p. ${node.startPage}` : `pp. ${node.startPage}–${node.endPage}`;

/** Count of nodes in a section tree. */
export const countNodes = tree => tree.reduce((n, node) => n + 1 + countNodes(node.children || []), 0);

/**
 * markmap data (INode: {content, children}) for a section tree from buildPageIndex(). `content` is HTML in
 * markmap, so every title is escaped here. At most `max` sections are kept, in reading order.
 */
export function mindMapData(tree, { title = 'Document', max = 400 } = {}) {
  let left = max;
  const walk = nodes => nodes.flatMap(node => {
    if (left <= 0) return [];
    left--;
    return [{ content: `${escapeHtml(short(clean(node.title)) || 'Untitled section')} <span class="mm-pages">${pagesLabel(node)}</span>`, children: walk(node.children || []) }];
  });
  return { content: escapeHtml(clean(title) || 'Document'), children: walk(tree) };
}

/** The section tree as a Markdown outline: a heading for the document, nested bullets for sections. */
export function mindMapMarkdown(tree, { title = 'Document' } = {}) {
  const md = s => clean(s).replace(/([\\`*_[\]#<>|~])/g, '\\$1');
  const lines = [`# ${md(title) || 'Document'}`, ''];
  const walk = (nodes, depth) => { for (const node of nodes) { lines.push(`${'  '.repeat(depth)}- ${md(node.title) || 'Untitled section'} (${pagesLabel(node)})`); walk(node.children || [], depth + 1); } };
  walk(tree, 0);
  return `${lines.join('\n')}\n`;
}

/** The section tree as nested HTML lists (escaped), for the exported page and for screen readers. */
export function outlineHtml(tree) {
  if (!tree.length) return '';
  return `<ul>${tree.map(node => `<li>${escapeHtml(clean(node.title) || 'Untitled section')} <small>${pagesLabel(node)}</small>${outlineHtml(node.children || [])}</li>`).join('')}</ul>`;
}

/** A self-contained HTML page with the mind map picture and the outline. No scripts. */
export function mindMapPage({ title, svg, tree }) {
  const name = escapeHtml(clean(title) || 'Document');
  return `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width,initial-scale=1">\n<title>${name}: mind map</title>\n<style>body{font:16px/1.5 system-ui,sans-serif;margin:2rem auto;max-width:72rem;padding:0 1rem;color:#141922}figure{margin:0 0 2rem;overflow:auto;border:1px solid #e4e7ec;border-radius:8px}figure svg{display:block;max-width:none;height:auto}small{color:#5b6472}</style>\n</head>\n<body>\n<h1>${name}</h1>\n<figure>${svg}</figure>\n<h2>Sections</h2>\n${outlineHtml(tree)}\n<p><small>Made with superPDF from the document’s ${'bookmarks or headings'}.</small></p>\n</body>\n</html>\n`;
}

/** Sections a person can pick for a flowchart: flattened tree, or groups of pages when there is no tree. */
export function sectionChoices(tree, pageCount, { group = 3 } = {}) {
  const out = [];
  const walk = (nodes, depth) => { for (const node of nodes) { out.push({ label: `${'– '.repeat(depth)}${clean(node.title) || 'Untitled section'} (${pagesLabel(node)})`, title: clean(node.title) || 'Untitled section', startPage: node.startPage, endPage: node.endPage, depth }); walk(node.children || [], depth + 1); } };
  walk(tree, 0);
  if (!out.length) for (let p = 1; p <= pageCount; p += group) {
    const end = Math.min(pageCount, p + group - 1);
    out.push({ label: p === end ? `Page ${p}` : `Pages ${p}–${end}`, title: p === end ? `Page ${p}` : `Pages ${p}–${end}`, startPage: p, endPage: end });
  }
  return out;
}

/**
 * The text of one section, from pdf-structure.js pages: from the section's heading to the next heading that
 * isn't inside it (subsections are included). Page ranges overlap where headings start mid-page, so this
 * keeps a neighbouring section's text out. When the heading isn't found as a block (bookmark titles can
 * differ from the page), the whole page range is used.
 */
export function sectionText(pages, choices, index) {
  const section = choices[index];
  const next = choices.slice(index + 1).find(c => c.depth <= section.depth);
  const same = (block, c) => block.type === 'heading' && clean(block.text).toLowerCase() === c.title.toLowerCase();
  const inRange = pages.filter(p => p.page >= section.startPage && p.page <= section.endPage);
  const whole = () => inRange.flatMap(p => p.blocks.map(b => b.text)).join('\n').trim();
  const start = inRange.find(p => p.page === section.startPage)?.blocks.findIndex(b => same(b, section)) ?? -1;
  if (start < 0) return whole();
  const out = [];
  for (const page of inRange) {
    for (const [i, block] of page.blocks.entries()) {
      if (page.page === section.startPage && i <= start) continue;
      if (next && page.page === next.startPage && same(block, next)) return out.join('\n').trim();
      out.push(block.text);
    }
  }
  return out.join('\n').trim();
}

// Mermaid from the model

const SHAPE = /^(?:flowchart|graph)\s+(?:TD|TB|BT|LR|RL)\b/i;

/**
 * Take the Mermaid flowchart out of a model reply and keep only diagram structure: the code block (or the
 * text from the first "flowchart" line), without init directives, click handlers, links, styles or HTML.
 * Unquoted labels are quoted, because brackets and parentheses inside them are the most common reason
 * small models' code fails to parse. Returns '' when there is no flowchart.
 */
export function cleanMermaid(reply) {
  let text = String(reply ?? '').replace(/\r/g, '');
  const fenced = text.match(/```(?:mermaid)?\s*\n([\s\S]*?)(?:```|$)/i);
  if (fenced) text = fenced[1];
  const lines = text.split('\n');
  const start = lines.findIndex(l => SHAPE.test(l.trim()));
  if (start < 0) return '';
  const body = [];
  for (const raw of lines.slice(start + 1)) {
    const line = raw.trim();
    if (!line) continue;
    if (/^```/.test(line)) break;
    if (/^%%/.test(line)) continue; // comments and %%{init}%% directives
    if (/^(?:click|style|classDef|class|linkStyle|href|callback)\b/i.test(line)) continue;
    if (/javascript:|<\s*\/?\s*(?:script|iframe|img|a|foreignobject|style)\b|\bon\w+\s*=/i.test(line)) continue;
    body.push(`    ${quoteLabels(line.replace(/;+\s*$/, ''))}`);
  }
  const header = lines[start].trim().replace(/;+\s*$/, '').replace(/^graph/i, 'flowchart');
  return body.length ? `${header.match(SHAPE)[0]}\n${body.join('\n')}` : '';
}

// A node: an id, then a shape opener and its closer, such as A[label], B{question}, C((circle)).
const SHAPES = [['[[', ']]'], ['[(', ')]'], ['[/', '/]'], ['[\\', '\\]'], ['(((', ')))'], ['((', '))'], ['([', '])'], ['[', ']'], ['(', ')'], ['{{', '}}'], ['{', '}'], ['>', ']']];
// Links between nodes: -->, ---, -.->, ==>, <-->, with an optional |label|.
const LINK = /(\s*(?:<?-{2,}[->ox]?|<?={2,}[=>ox]?|<?-\.+-[->ox]?|~~~)\s*(?:\|[^|\n]*\|)?\s*)/;

/** One node expression → {id, open, label, close}, or {id} for a bare id, or null. */
function parseNode(text) {
  const match = text.trim().match(/^([A-Za-z_][\w-]*)(?:\s*:::\s*[\w-]+)?\s*([\s\S]*)$/);
  if (!match) return null;
  const [, id, rest] = match;
  if (!rest) return { id };
  for (const [open, close] of SHAPES) if (rest.startsWith(open) && rest.endsWith(close) && rest.length >= open.length + close.length) return { id, open, label: rest.slice(open.length, rest.length - close.length), close };
  return null;
}

/** Quote node labels that aren't quoted: A[Start (now)] → A["Start (now)"]. */
export function quoteLabels(line) {
  return line.split(LINK).map((part, i) => {
    if (i % 2) return part; // a link
    return part.split(/(\s*&\s*)/).map((piece, j) => {
      if (j % 2) return piece;
      const node = parseNode(piece);
      if (!node?.open || /^".*"$/s.test(node.label.trim())) return piece;
      const label = node.label.replace(/"/g, "'").trim() || ' ';
      return `${piece.match(/^\s*/)[0]}${node.id}${node.open}"${label}"${node.close}`;
    }).join('');
  }).join('');
}

/** Node ids in flowchart code, for the size check. */
export function flowchartNodes(code) {
  const ids = new Set();
  for (const line of String(code).split('\n').slice(1)) {
    if (/^\s*(?:subgraph|end|direction)\b/.test(line)) continue;
    line.split(LINK).forEach((part, i) => { if (i % 2 === 0) for (const piece of part.split(/\s*&\s*/)) { const node = parseNode(piece); if (node) ids.add(node.id); } });
  }
  return ids;
}

/**
 * Check flowchart code. `parse` is mermaid.parse (it throws on syntax errors). Resolves with {ok, error}.
 * Too many nodes is refused too: a small model that loops writes hundreds.
 */
export async function validateFlowchart(code, parse, { maxNodes = 40 } = {}) {
  if (!code) return { ok: false, error: 'The reply had no flowchart in it.' };
  const count = flowchartNodes(code).size;
  if (count < 2) return { ok: false, error: 'The flowchart needs at least two steps.' };
  if (count > maxNodes) return { ok: false, error: `The flowchart has ${count} steps; use at most ${maxNodes}.` };
  try {
    await parse(code);
    return { ok: true, error: '' };
  } catch (error) {
    return { ok: false, error: String(error?.message || error).split('\n').slice(0, 4).join(' ').slice(0, 300) };
  }
}
