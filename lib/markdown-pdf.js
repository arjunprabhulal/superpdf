// Markdown → PDF: parse with marked, lay out with pdf-lib standard fonts. No DOM, so it runs in Node tests too.
// Supports headings, paragraphs, emphasis, inline code, links, lists (nested, ordered, task), block quotes,
// code blocks, rules and simple tables. Images and raw HTML are shown as text; nothing is fetched.
import { Lexer } from 'marked';
import { PDFDocument, PDFString, StandardFonts, rgb } from 'pdf-lib';

export const PAGE_SIZES = { A4: [595.28, 841.89], Letter: [612, 792] };
const MARGIN = 56, BODY = 10.5, LEADING = 1.45, CODE = 9;
const HEADING = [0, 22, 17, 14, 12, 11, 10.5];
const INK = rgb(0.12, 0.12, 0.14), MUTED = rgb(0.38, 0.38, 0.42), LINK = rgb(0.05, 0.33, 0.75);
const RULE = rgb(0.82, 0.82, 0.85), SHADE = rgb(0.95, 0.95, 0.96), HEAD_SHADE = rgb(0.91, 0.91, 0.93);
// Characters the standard fonts can't draw get a readable stand-in where one exists, otherwise "?".
const SUBSTITUTES = { '→': '->', '←': '<-', '↔': '<->', '⇒': '=>', '✓': 'x', '✔': 'x', '✗': 'x', '☐': '[ ]', '☑': '[x]', '−': '-', '≤': '<=', '≥': '>=', '≠': '!=', ' ': ' ', ' ': ' ', '​': '', '﻿': '' };
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', trade: '™', hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', bull: '•', middot: '·', deg: '°', times: '×', euro: '€' };
// Numeric references outside Unicode (or to NUL) become "?", as an unknown character does.
const decode = s => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
  if (e[0] !== '#') return ENTITIES[e.toLowerCase()] ?? m;
  const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
  return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '?';
});
// Real HTML markup only: comments, script and style elements with their content, doctype and processing
// instructions, and start/end tags (a letter right after "<", attributes may be quoted and contain ">").
// A "<" or ">" in text, as in "if x < 10 and y > 20", is not a tag and stays.
const TAG = /<!--[\s\S]*?(?:-->|$)|<(script|style)\b(?:"[^"]*"|'[^']*'|[^'">])*>[\s\S]*?(?:<\/\1\s*>|$)|<\/?[a-z][\w:-]*(?:\s+[^\s"'<>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*\s*\/?>|<![a-z][^>]*>|<\?[\s\S]*?\?>/gi;
const stripTags = s => s.replace(TAG, '');

/**
 * Convert Markdown text to a PDF.
 * @param {string} markdown
 * @param {{pageSize?: 'A4'|'Letter', title?: string}} options
 * @returns {Promise<{bytes: Uint8Array, pages: number, replaced: number, title: string}>}
 */
export async function markdownToPdf(markdown, { pageSize = 'A4', title } = {}) {
  const size = PAGE_SIZES[pageSize];
  if (!size) throw new Error('Choose A4 or Letter.');
  const tokens = new Lexer({ gfm: true }).lex(String(markdown).replace(/\r\n?/g, '\n'));
  if (!tokens.some(t => t.type !== 'space')) throw new Error('This file is empty.');

  const pdf = await PDFDocument.create();
  const fonts = {
    regular: await pdf.embedFont(StandardFonts.Helvetica),
    bold: await pdf.embedFont(StandardFonts.HelveticaBold),
    italic: await pdf.embedFont(StandardFonts.HelveticaOblique),
    boldItalic: await pdf.embedFont(StandardFonts.HelveticaBoldOblique),
    mono: await pdf.embedFont(StandardFonts.Courier),
    monoBold: await pdf.embedFont(StandardFonts.CourierBold),
  };
  const supported = new Set(fonts.regular.getCharacterSet());
  let replaced = 0;
  const clean = text => [...text.replace(/\t/g, '    ')].map(c => {
    if (supported.has(c.codePointAt(0)) || c === '\n') return c;
    if (c in SUBSTITUTES) return SUBSTITUTES[c];
    replaced++;
    return '?';
  }).join('');
  const fontFor = s => s.code ? (s.bold ? fonts.monoBold : fonts.mono) : s.bold && s.italic ? fonts.boldItalic : s.bold ? fonts.bold : s.italic ? fonts.italic : fonts.regular;

  // Page state. `y` is the baseline cursor, measured from the bottom like PDF coordinates.
  const [pageWidth, pageHeight] = size, bottom = MARGIN + 14;
  let page, y;
  const newPage = () => { page = pdf.addPage(size); y = pageHeight - MARGIN; };
  newPage();
  const ensure = height => { if (y - height < bottom) newPage(); };
  const gap = space => { if (y < pageHeight - MARGIN) y -= space; };

  // Inline tokens → styled runs.
  function runs(tokens, style = {}, out = []) {
    for (const t of tokens || []) {
      switch (t.type) {
        case 'strong': runs(t.tokens, { ...style, bold: true }, out); break;
        case 'em': runs(t.tokens, { ...style, italic: true }, out); break;
        case 'del': runs(t.tokens, { ...style, strike: true }, out); break;
        case 'codespan': out.push({ text: decode(t.text), style: { ...style, code: true } }); break;
        case 'link': runs(t.tokens, { ...style, link: /^(https?:|mailto:)/i.test(t.href) ? t.href : style.link }, out); break;
        case 'image': out.push({ text: `[Image: ${t.text || t.href}]`, style: { ...style, italic: true, muted: true } }); break;
        case 'br': out.push({ text: '\n', style }); break;
        case 'html': out.push({ text: decode(stripTags(t.text)), style }); break;
        case 'checkbox': break;
        default:
          if (t.tokens) runs(t.tokens, style, out);
          else out.push({ text: decode(t.text ?? ''), style });
      }
    }
    return out;
  }

  // Runs → wrapped lines. Breaks only at whitespace (or inside a word that is wider than the line).
  function wrap(runList, width, size) {
    const lines = [[]];
    let x = 0, pendingSpace = null;
    const line = () => lines[lines.length - 1];
    const measure = (text, style) => fontFor(style).widthOfTextAtSize(text, style.code ? size * 0.92 : size);
    for (const { text, style } of runList) {
      for (const piece of clean(text).split(/(\n|[ \t]+)/)) {
        if (!piece) continue;
        if (piece === '\n') { lines.push([]); x = 0; pendingSpace = null; continue; }
        if (/^\s+$/.test(piece)) { if (line().length) pendingSpace = style; continue; }
        let word = piece, w = measure(word, style);
        const spaceW = pendingSpace ? measure(' ', pendingSpace) : 0;
        if (line().length && x + spaceW + w > width) { lines.push([]); x = 0; pendingSpace = null; }
        else if (pendingSpace) { line().push({ text: ' ', style: pendingSpace, width: spaceW }); x += spaceW; }
        pendingSpace = null;
        while (w > width - x) { // hard-break an over-long word
          let n = word.length - 1;
          while (n > 1 && measure(word.slice(0, n), style) > width - x) n--;
          if (x > 0 && n <= 1) { lines.push([]); x = 0; continue; }
          line().push({ text: word.slice(0, n), style, width: measure(word.slice(0, n), style) });
          lines.push([]); x = 0; word = word.slice(n); w = measure(word, style);
        }
        line().push({ text: word, style, width: w });
        x += w;
      }
    }
    return lines;
  }

  function drawLine(parts, x, baseline, size, color, align = 'left', width = 0) {
    const total = parts.reduce((sum, p) => sum + p.width, 0);
    if (align === 'right') x += width - total;
    else if (align === 'center') x += (width - total) / 2;
    for (const { text, style, width: w } of parts) {
      const fontSize = style.code ? size * 0.92 : size;
      const ink = style.link ? LINK : style.muted ? MUTED : color;
      if (style.code && text.trim()) page.drawRectangle({ x: x - 1, y: baseline - size * 0.25, width: w + 2, height: size * 1.1, color: SHADE });
      if (text.trim()) page.drawText(text, { x, y: baseline, size: fontSize, font: fontFor(style), color: ink });
      if (style.strike) page.drawLine({ start: { x, y: baseline + size * 0.3 }, end: { x: x + w, y: baseline + size * 0.3 }, thickness: 0.6, color: ink });
      if (style.link) {
        page.drawLine({ start: { x, y: baseline - 1.5 }, end: { x: x + w, y: baseline - 1.5 }, thickness: 0.5, color: LINK });
        addLink(x, baseline - size * 0.25, w, size * 1.15, style.link);
      }
      x += w;
    }
  }
  function addLink(x, yy, width, height, uri) {
    page.node.addAnnot(pdf.context.register(pdf.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [x, yy, x + width, yy + height], Border: [0, 0, 0], A: { Type: 'Action', S: 'URI', URI: PDFString.of(uri) } })));
  }

  // Paint a block of wrapped lines, breaking pages between lines. `decorate` draws quote bars per line.
  function paragraph(runList, ctx, { size = BODY, color = INK, before = 0, after = size * 0.7, keepWithNext = 0 } = {}) {
    const lines = wrap(runList, ctx.width, size), lineHeight = size * LEADING;
    gap(before);
    ensure(lineHeight * Math.min(lines.length, 2) + keepWithNext);
    for (const parts of lines) {
      ensure(lineHeight);
      ctx.decorate?.(y, lineHeight);
      drawLine(parts, ctx.left, y - size, size, ctx.color || color);
      y -= lineHeight;
    }
    y -= after;
  }

  // Code keeps its spacing and wraps by character (Courier is monospaced: 0.6 em per character).
  function codeBlock(text, ctx) {
    const lineHeight = CODE * 1.5, pad = 6, perLine = Math.max(8, Math.floor((ctx.width - pad * 2) / (CODE * 0.6)));
    const lines = clean(text.replace(/\n+$/, '')).split('\n').flatMap(l => l.length ? l.match(new RegExp(`.{1,${perLine}}`, 'g')) : ['']);
    const band = height => { page.drawRectangle({ x: ctx.left, y: y - height, width: ctx.width, height, color: SHADE }); ctx.decorate?.(y, height); y -= height; };
    gap(4);
    ensure(lineHeight * Math.min(lines.length, 3) + pad * 2);
    band(pad);
    for (const line of lines) {
      if (y - lineHeight < bottom) { newPage(); band(pad); }
      page.drawRectangle({ x: ctx.left, y: y - lineHeight, width: ctx.width, height: lineHeight, color: SHADE });
      ctx.decorate?.(y, lineHeight);
      if (line.trim()) page.drawText(line, { x: ctx.left + pad, y: y - CODE * 1.15, size: CODE, font: fonts.mono, color: INK });
      y -= lineHeight;
    }
    band(pad);
    y -= BODY * 0.8;
  }

  function table(token, ctx) {
    const size = BODY * 0.92, lineHeight = size * 1.4, pad = 5, cols = token.header.length;
    const cellRuns = (cell, header) => runs(cell.tokens, header ? { bold: true } : {});
    // Column widths: proportional to the longest unwrapped cell, each at least a fair share of a third.
    const natural = token.header.map((h, i) => Math.max(...[h, ...token.rows.map(r => r[i])].map((c, k) =>
      c ? cellRuns(c, k === 0).reduce((s, r) => s + fontFor(r.style).widthOfTextAtSize(clean(r.text), size), 0) : 0)) + pad * 2);
    const min = ctx.width / cols / 3, sum = natural.reduce((a, b) => a + Math.max(b, min), 0);
    const widths = natural.map(w => sum <= ctx.width ? Math.max(w, min) : Math.max(w, min) / sum * ctx.width);
    const rowLayout = (cells, header) => {
      const wrapped = cells.map((c, i) => wrap(c ? cellRuns(c, header) : [], widths[i] - pad * 2, size));
      return { wrapped, height: Math.max(1, ...wrapped.map(l => l.length)) * lineHeight + pad * 2, header };
    };
    const head = rowLayout(token.header, true);
    const drawRow = row => {
      let x = ctx.left;
      page.drawRectangle({ x, y: y - row.height, width: widths.reduce((a, b) => a + b, 0), height: row.height, color: row.header ? HEAD_SHADE : undefined, borderColor: RULE, borderWidth: 0.6 });
      row.wrapped.forEach((lines, i) => {
        if (i) page.drawLine({ start: { x, y }, end: { x, y: y - row.height }, thickness: 0.6, color: RULE });
        lines.forEach((parts, n) => drawLine(parts, x + pad, y - pad - size - n * lineHeight, size, INK, token.align[i] || 'left', widths[i] - pad * 2));
        x += widths[i];
      });
      y -= row.height;
    };
    gap(4);
    ensure(head.height + lineHeight * 2);
    drawRow(head);
    for (const cells of token.rows) {
      const row = rowLayout(cells, false);
      if (y - row.height < bottom) { newPage(); drawRow(head); }
      drawRow(row);
    }
    y -= BODY;
  }

  function blocks(tokens, ctx, list) {
    for (const t of tokens) {
      switch (t.type) {
        case 'space': case 'checkbox': break;
        case 'heading': {
          const size = HEADING[t.depth];
          paragraph(runs(t.tokens, { bold: true }), ctx, { size, before: size * (t.depth <= 2 ? 0.9 : 0.7), after: t.depth <= 2 ? size * 0.25 : size * 0.4, keepWithNext: BODY * LEADING * 2 });
          if (t.depth <= 2) { page.drawLine({ start: { x: ctx.left, y: y + 2 }, end: { x: ctx.left + ctx.width, y: y + 2 }, thickness: t.depth === 1 ? 1 : 0.5, color: RULE }); y -= size * 0.45; }
          break;
        }
        case 'paragraph': paragraph(runs(t.tokens), ctx, { after: list ? BODY * 0.3 : BODY * 0.75 }); break;
        case 'text': paragraph(runs(t.tokens || [t]), ctx, { after: list ? BODY * 0.3 : BODY * 0.75 }); break;
        case 'html': { const text = decode(stripTags(t.text)).trim(); if (text) paragraph([{ text, style: {} }], ctx); break; }
        case 'code': codeBlock(decode(t.text), ctx); break;
        case 'hr': gap(BODY * 0.5); ensure(BODY); page.drawLine({ start: { x: ctx.left, y: y - BODY / 2 }, end: { x: ctx.left + ctx.width, y: y - BODY / 2 }, thickness: 0.8, color: RULE }); y -= BODY * 1.5; break;
        case 'blockquote': {
          const inner = { left: ctx.left + 14, width: ctx.width - 14, color: MUTED, decorate: (top, h) => { ctx.decorate?.(top, h); page.drawRectangle({ x: ctx.left + 2, y: top - h, width: 2.5, height: h, color: RULE }); } };
          blocks(t.tokens, inner);
          break;
        }
        case 'list': {
          const indent = 18;
          t.items.forEach((item, i) => {
            const marker = item.task ? (item.checked ? '[x]' : '[ ]') : t.ordered ? `${(Number(t.start) || 1) + i}.` : (ctx.depth || 0) % 2 ? '–' : '•';
            const font = item.task ? fonts.mono : fonts.regular;
            const inner = { ...ctx, left: ctx.left + indent + (item.task ? 6 : 0), width: ctx.width - indent - (item.task ? 6 : 0), depth: (ctx.depth || 0) + 1 };
            ensure(BODY * LEADING * 2);
            page.drawText(marker, { x: inner.left - font.widthOfTextAtSize(marker, BODY) - 5, y: y - BODY, size: BODY, font, color: ctx.color || INK });
            blocks(item.tokens, inner, true);
          });
          if (!list) y -= BODY * 0.45;
          break;
        }
        case 'table': table(t, ctx); break;
        default: if (t.tokens) blocks(t.tokens, ctx, list); else if (t.text) paragraph([{ text: decode(t.text), style: {} }], ctx);
      }
    }
  }

  blocks(tokens, { left: MARGIN, width: pageWidth - MARGIN * 2 });

  const heading = tokens.find(t => t.type === 'heading');
  const docTitle = clean((title || (heading ? decode(heading.text).replace(/[*_`]/g, '') : '') || 'Document').trim());
  pdf.setTitle(docTitle);
  pdf.setCreator('superPDF');
  pdf.setProducer('superPDF (pdf-lib)');
  const pages = pdf.getPages();
  if (pages.length > 1) pages.forEach((p, i) => {
    const label = `${i + 1} / ${pages.length}`, w = fonts.regular.widthOfTextAtSize(label, 8);
    p.drawText(label, { x: (pageWidth - w) / 2, y: MARGIN / 2, size: 8, font: fonts.regular, color: MUTED });
  });
  return { bytes: await pdf.save(), pages: pages.length, replaced, title: docTitle };
}
