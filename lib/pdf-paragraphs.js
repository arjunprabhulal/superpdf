// Rebuild paragraphs from a PDF page's text layer (one string per page, visual lines separated by "\n",
// as extractText in browser-pdf.js returns it). Shared by the EPUB and Word exporters. No DOM.

const PAGE_NUMBER = /^(page\s+)?(\d{1,4}|[ivxlcdm]{1,7})(\s*(of|\/)\s*\d{1,4})?$/i;

/** Visual lines of a page, trimmed, with blank lines and leading/trailing page numbers removed. */
export function pageLines(text) {
  const lines = String(text || '').split('\n').map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  while (lines.length && PAGE_NUMBER.test(lines[0])) lines.shift();
  while (lines.length && PAGE_NUMBER.test(lines[lines.length - 1])) lines.pop();
  return lines;
}

/**
 * Join visual lines into paragraphs. A paragraph ends after a line that is clearly shorter than the
 * page's full lines and ends a sentence or is followed by a capitalised line (titles), or at a line `isBreak` marks
 * (chapter headings). Hyphenated line ends are joined.
 * @returns {{text: string, heading?: boolean}[]}
 */
export function paragraphs(lines, { isBreak = () => false } = {}) {
  const full = Math.max(0, ...lines.map(l => l.length));
  const out = [];
  let current = '';
  const flush = () => { if (current) out.push({ text: current }); current = ''; };
  lines.forEach((line, i) => {
    if (isBreak(line)) { flush(); out.push({ text: line, heading: true }); return; }
    if (/[a-z]-$/i.test(current) && /^[a-z]/.test(line)) current = current.slice(0, -1) + line;
    else current = current ? `${current} ${line}` : line;
    // A short line ends its paragraph when it ends a sentence, or (titles) when the next line starts with a capital.
    if (line.length < full * 0.75 && (/[.!?:"”’)\]]$/.test(line) || /^[\p{Lu}\d"“‘']/u.test(lines[i + 1] || '') && !/[,;-]$/.test(line))) flush();
  });
  flush();
  return out;
}

/** True when the next page's first paragraph probably continues the previous one. */
export function continues(previous, next) {
  return !!previous && !!next && !previous.heading && !next.heading && (/[a-z,;-]$/i.test(previous.text) && /^[a-z]/.test(next.text));
}

export function joinContinued(previous, next) {
  previous.text = /[a-z]-$/i.test(previous.text) ? previous.text.slice(0, -1) + next.text : `${previous.text} ${next.text}`;
}

/** Remove characters that are not allowed in XML 1.0. */
export const xmlSafe = s => String(s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '');
export const escapeXml = s => xmlSafe(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
