// PDF tables → Excel (.xlsx). The tables are found by pdf-layout.js (shared with the Markdown, HTML, JSON and
// Word exports): tables drawn with lines are read cell by cell from their lines, the others from where the cells
// of several rows line up. Tables that run onto the next page are joined. No DOM: runs in the browser and in Node.
import writeXlsxFile from 'write-excel-file/universal';
import { pageItems, usable } from './pdf-structure.js';
import { fixPageText } from './pdf-text-fixes.js';
import { xmlSafe } from './pdf-paragraphs.js';
import { textRows, findTables, cellValue } from './pdf-layout.js';
import { findCharts, chartBlock } from './pdf-charts.js';

export { textRows, findTables, cellValue };

/** Excel sheet names: up to 31 characters, none of []:*?/\, unique. */
function sheetName(name, used) {
  let base = name.replace(/[[\]:*?/\\]/g, ' ').slice(0, 31).trim() || 'Sheet';
  let candidate = base, n = 2;
  while (used.has(candidate.toLowerCase())) candidate = `${base.slice(0, 27)} (${n++})`;
  used.add(candidate.toLowerCase());
  return candidate;
}

function sheetOf(name, rows, { header = false, headerRows = [] } = {}) {
  const width = Math.max(1, ...rows.map(r => r.length));
  const data = rows.map((row, r) => Array.from({ length: width }, (_, c) => {
    const text = xmlSafe(row[c] ?? '');
    if (!text) return null;
    const bold = (header && r === 0) || headerRows.includes(r);
    const value = cellValue(text);
    return typeof value === 'string' ? { value, type: String, ...(bold && { fontWeight: 'bold' }) } : { ...value, type: Number, ...(bold && { fontWeight: 'bold' }) };
  }));
  const columns = Array.from({ length: width }, (_, c) => ({ width: Math.min(60, Math.max(8, ...rows.map(r => String(r[c] ?? '').length + 2))) }));
  return { sheet: name, data: data.length ? data : [[null]], columns, ...(header && { stickyRowsCount: 1 }) };
}

/**
 * Write the tables to an .xlsx workbook.
 * @param {ReturnType<typeof findTables>} found
 * @param {{sheets?: 'table' | 'page'}} options  one sheet per table, or one per page with its other text
 *   in column A; per table falls back to per page when no tables were found.
 * @returns {Promise<{bytes: Uint8Array, sheets: string[], mode: 'table' | 'page'}>}
 */
export async function tablesToXlsx(found, { sheets = 'table' } = {}) {
  const mode = sheets === 'page' || !found.tables.length ? 'page' : 'table';
  const used = new Set(), list = [];
  if (mode === 'table') {
    found.tables.forEach((t, i) => {
      const where = t.pages.length > 1 ? `pages ${t.pages[0]}-${t.pages.at(-1)}` : `page ${t.pages[0]}`;
      list.push(sheetOf(sheetName(`${t.chart ? 'Chart' : 'Table'} ${i + 1} (${where})`, used), t.rows, { header: t.header }));
    });
  } else {
    for (const { page, blocks } of found.layouts) {
      if (!blocks.length) continue;
      const rows = [], headerRows = [];
      blocks.forEach((b, i) => {
        if (b.kind === 'text') { rows.push([b.text]); return; }
        if (i > 0 && rows.at(-1)?.some(Boolean)) rows.push([]);
        const table = found.tables[b.table];
        if (table.header && b.rows[0].join('\u0001') === table.rows[0].join('\u0001')) headerRows.push(rows.length);
        rows.push(...b.rows);
        if (i < blocks.length - 1) rows.push([]);
      });
      list.push(sheetOf(sheetName(`Page ${page}`, used), rows, { headerRows }));
    }
  }
  if (!list.length) throw new Error('This PDF has no readable text layer. Run OCR PDF first, then convert the result.');
  const blob = await writeXlsxFile(list, { fontFamily: 'Calibri', fontSize: 11 }).toBlob();
  return { bytes: new Uint8Array(await blob.arrayBuffer()), sheets: list.map(s => s.sheet), mode };
}

/**
 * Read the tables of a PDF.js document. `pages` is a list of 0-based page indices (default: all).
 * Shared by the browser tool and (later) the CLI.
 */
export async function readPdfTables(pdfjs, doc, { pages, progress = () => {} } = {}) {
  const indices = pages || [...Array(doc.numPages).keys()];
  const read = [];
  for (const [n, index] of indices.entries()) {
    progress(`Reading page ${n + 1} of ${indices.length}`);
    const page = await doc.getPage(index + 1);
    const { items: raw, rules, shapes, viewport } = await pageItems(pdfjs, page, { images: false });
    // Fixed as the other exports read it (pdf-structure.js readPage): ligatures, letter spacing, form field values.
    const items = (await fixPageText(page, viewport, raw, pdfjs)).filter(usable);
    page.cleanup?.();
    // Charts drawn as vectors become tables of their data (pdf-charts.js); their labels leave the page's text.
    const { charts, items: charted } = findCharts(items, shapes, viewport);
    const blocks = charts.map(chartBlock);
    read.push({ page: index + 1, items: charts.length ? items.filter(i => !charted.has(i)) : items, rules, charts: blocks, claimed: chartRegions(blocks) });
  }
  return findTables(read);
}

/**
 * The regions charts own on a page, as `claimed` for findTables / pageTables (pdf-layout.js): no table is found mostly
 * inside one. `charts` are chart blocks (bbox [x, y, width, height]); `extra` are more regions {x, y, width, height}, such
 * as the plot areas of charts that couldn't be read as data.
 */
export function chartRegions(charts = [], extra = []) {
  return [...charts.map(c => ({ x: c.bbox[0], y: c.bbox[1], width: c.bbox[2], height: c.bbox[3] })), ...extra];
}
