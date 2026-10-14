// PDF → Word (.docx) with the docx library, one PDF page per Word page. structureToDocx writes the shared
// structure (headings, paragraphs with bold and italic, lists, tables); pagesToDocx writes plain page text as
// paragraphs. Images and page layout are not reconstructed. No DOM.
import { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType } from 'docx';
import { pageLines, paragraphs, xmlSafe } from './pdf-paragraphs.js';
import { blockRuns, BULLET, CHART_NOTE } from './pdf-structure.js';

/**
 * @param {{page: number, text: string}[]} pages  per-page text from extractText
 * @param {{title?: string}} options
 * @returns {Promise<{bytes: Uint8Array, paragraphs: number, emptyPages: number}>}
 */
export async function pagesToDocx(pages, { title = 'Document' } = {}) {
  // Only pages with no text at all need OCR PDF. When page numbers are the only text, they are kept.
  if (!pages.some(p => String(p.text || '').trim())) throw new Error('This PDF has no readable text layer. Run OCR PDF first, then convert the result.');
  let perPage = pages.map(p => paragraphs(pageLines(p.text)));
  if (perPage.every(p => !p.length)) perPage = pages.map(p => paragraphs(String(p.text || '').split('\n').map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean)));
  const emptyPages = perPage.filter(p => !p.length).length;
  const children = [];
  perPage.forEach((paras, i) => {
    // Pages without text keep an empty page so page numbers still line up with the PDF.
    (paras.length ? paras : [{ text: '' }]).forEach((p, n) => children.push(new Paragraph({
      pageBreakBefore: i > 0 && n === 0,
      spacing: { after: 160 },
      children: [new TextRun(xmlSafe(p.text))],
    })));
  });
  const doc = new Document({
    title: xmlSafe(title),
    creator: 'superPDF',
    description: 'Text converted from a PDF by superPDF',
    styles: { default: { document: { run: { font: 'Calibri', size: 22 } } } },
    sections: [{ children }],
  });
  const bytes = new Uint8Array(await Packer.toArrayBuffer(doc));
  return { bytes, paragraphs: perPage.reduce((n, p) => n + p.length, 0), emptyPages };
}

const HEADINGS = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3];

/** Word runs from a block's runs (bold, italic, superscript, subscript). */
const wordRuns = runs => runs.map(r => new TextRun({ text: xmlSafe(r.text), ...(r.bold && { bold: true }), ...(r.italic && { italics: true }), ...(r.sup && { superScript: true }), ...(r.sub && { subScript: true }), ...(r.underline && { underline: {} }), ...(r.strike && { strike: true }) }));

function wordTable(block) {
  const spanAt = new Map((block.spans || []).map(([r, c, n]) => [`${r},${c}`, n]));
  // Cells that span rows (`rowSpans`: [row, column, rows]) are merged down, as tableHtml (pdf-structure.js) does;
  // the docx library adds the merged cells' continuations (as wide as the cell) in the rows below.
  const downAt = new Map((block.rowSpans || []).map(([r, c, n]) => [`${r},${c}`, n]));
  const covered = new Set();
  for (const [r, c, n] of block.rowSpans || []) for (let k = 1; k < n; k++) for (let w = 0; w < (spanAt.get(`${r},${c}`) || 1); w++) covered.add(`${r + k},${c + w}`);
  const headerRows = block.headerRows ?? (block.header ? 1 : 0);
  const strong = new Set((block.bold || []).map(([r, c]) => `${r},${c}`));
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: block.rows.map((row, r) => {
      const cells = [];
      for (let c = 0; c < row.length; c++) {
        if (covered.has(`${r},${c}`)) continue;
        const n = spanAt.get(`${r},${c}`) || 1, down = downAt.get(`${r},${c}`) || 1;
        cells.push(new TableCell({ ...(n > 1 && { columnSpan: n }), ...(down > 1 && { rowSpan: down }), children: [new Paragraph({ children: [new TextRun({ text: xmlSafe(row[c]), ...((r < headerRows || strong.has(`${r},${c}`)) && { bold: true }) })] })] }));
        c += n - 1;
      }
      return new TableRow({ tableHeader: r < headerRows, children: cells });
    }),
  });
}

/**
 * The structure of a PDF (pdf-structure.js) → Word (.docx): headings as Word headings, paragraphs with their bold,
 * italic, superscript and subscript text, bulleted lists, and tables as Word tables, one PDF page per Word page.
 * Page headers and footers (page numbers, running titles) are left out, unless the document has no other text. Images and page layout are not reconstructed.
 * @returns {Promise<{bytes: Uint8Array, paragraphs: number, tables: number, emptyPages: number}>}
 */
export async function structureToDocx(structure, { title = 'Document' } = {}) {
  const children = [];
  let paragraphs = 0, tables = 0, emptyPages = 0;
  // A line in the same place on every page is read as a running header; when the document has no other text
  // (a one-line certificate or caption per page), those lines are its content and are kept.
  const furniture = b => b.type === 'header' || b.type === 'footer';
  const bodyless = !structure.pages.some(page => page.blocks.some(b => !furniture(b)));
  structure.pages.forEach((page, i) => {
    const blocks = bodyless ? page.blocks : page.blocks.filter(b => !furniture(b));
    if (!blocks.length) emptyPages++;
    // Each PDF page starts a new Word page; a page that starts with a table gets an empty paragraph to break on.
    let breakNext = i > 0;
    const startsPage = () => { const value = breakNext; breakNext = false; return value; };
    if (!blocks.length || (breakNext && (blocks[0].type === 'table' || blocks[0].type === 'chart'))) children.push(new Paragraph({ pageBreakBefore: startsPage(), children: [] }));
    for (const block of blocks) {
      if (block.type === 'table') { children.push(wordTable(block), new Paragraph({ children: [] })); tables++; continue; }
      // A chart read as data: its title, its table, and a note when the values were measured from the drawing.
      if (block.type === 'chart') {
        if (block.title) children.push(new Paragraph({ children: [new TextRun({ text: xmlSafe(block.title), bold: true })] }));
        children.push(wordTable(block));
        children.push(new Paragraph({ spacing: { after: 160 }, children: block.values === 'measured' ? [new TextRun({ text: CHART_NOTE, italics: true })] : [] }));
        tables++;
        continue;
      }
      paragraphs++;
      if (block.type === 'heading') { children.push(new Paragraph({ pageBreakBefore: startsPage(), heading: HEADINGS[(block.level || 1) - 1], children: [new TextRun(xmlSafe(block.text))] })); continue; }
      const runs = blockRuns(block);
      const bullet = block.type === 'list' && BULLET.test(block.text);
      if (bullet && runs[0]) runs[0].text = runs[0].text.replace(BULLET, '').trimStart();
      children.push(new Paragraph({ pageBreakBefore: startsPage(), spacing: { after: bullet ? 60 : 160 }, ...(bullet && { bullet: { level: 0 } }), children: wordRuns(runs.filter(r => r.text)) }));
    }
  });
  if (!paragraphs && !tables) throw new Error('This PDF has no readable text layer. Run OCR PDF first, then convert the result.');
  const doc = new Document({
    title: xmlSafe(title),
    creator: 'superPDF',
    description: 'Text converted from a PDF by superPDF',
    styles: { default: { document: { run: { font: 'Calibri', size: 22 } } } },
    sections: [{ children }],
  });
  return { bytes: new Uint8Array(await Packer.toArrayBuffer(doc)), paragraphs, tables, emptyPages };
}
