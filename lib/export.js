// Markdown, HTML or JSON from a PDF, as superpdf export and the SDK's exportPdf produce it: the shared structure
// reader (lib/pdf-structure.js), with superPDF OCR for pages that have no text, as the app's exports do.
import { cleanValue } from '../contracts/untrusted.js';
import { plainMessage } from '../contracts/errors.js';

export const EXPORT_FORMATS = ['markdown', 'html', 'json'];

/**
 * Markdown as toMarkdown (lib/pdf-structure.js) writes it, with each table as the HTML export's table (colspans and
 * header rows kept), page by page.
 */
async function markdownHtmlTables(structure) {
  const { blockMarkdown, tableHtml } = await import('./pdf-structure.js');
  const out = [];
  for (const page of structure.pages) {
    let previous = null;
    for (const block of page.blocks) {
      const md = block.type === 'table' ? tableHtml(block) : blockMarkdown(block);
      if (!md) continue;
      if (block.type === 'list' && previous === 'list') out[out.length - 1] += `\n${md}`;
      else out.push(md);
      previous = block.type;
    }
    out.push(`<!-- end of page ${page.page} -->`);
  }
  return out.join('\n\n') + '\n';
}

/**
 * Read a PDF into Markdown, HTML or JSON.
 * @param {Uint8Array} bytes The PDF.
 * @param {{format?: 'markdown'|'html'|'json', pages?: string, tables?: 'markdown'|'html', ocr?: boolean,
 *   onMessage?: (text: string) => void}} options `onMessage` receives progress and notes about scanned pages.
 * @returns {Promise<{content: string, format: string, pages: number}>}
 */
export async function exportDocument(bytes, { format = 'markdown', pages = '', tables = 'markdown', ocr = true, onMessage = () => {} } = {}) {
  if (!EXPORT_FORMATS.includes(format)) throw new Error('Use format markdown, html or json.');
  if (!['markdown', 'html'].includes(tables)) throw new Error('Use tables markdown or html.');
  if (tables === 'html' && format !== 'markdown') throw new Error('tables applies to Markdown.');
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const { extractStructure, buildPageIndex, toMarkdown, toHtml } = await import('./pdf-structure.js');
  const { pageIndices } = await import('./pdf-core.js');
  const { documentOptions, scannedPageReader } = await import('./pdf-node.js');
  const reader = ocr ? scannedPageReader({ progress: onMessage }) : null;
  const task = pdfjs.getDocument(documentOptions(new Uint8Array(bytes)));
  try {
    const doc = await task.promise;
    if (reader) reader.documentLanguage = (await doc.getMetadata().catch(() => ({}))).info?.Language;
    const read = await extractStructure(pdfjs, doc, {
      pages: pageIndices(pages || '', doc.numPages),
      recognize: reader && ((page, index, options) => reader.recognize(page, index, options)),
    });
    if (reader?.pages) {
      const { languageOf } = await import('./ocr-languages.js');
      onMessage(`${reader.pages === 1 ? '1 scanned page was' : `${reader.pages} scanned pages were`} recognized with OCR (${languageOf(reader.language).name}), so check ${reader.pages === 1 ? 'its' : 'their'} text.`);
    }
    if (reader?.missed) onMessage(`OCR couldn’t read ${reader.missed === 1 ? '1 scanned page' : `${reader.missed} scanned pages`} (${plainMessage(reader.failed)}), so ${reader.missed === 1 ? 'it is' : 'they are'} left without text.`);
    const scanned = read.pages.filter(p => !p.blocks.length).length;
    if (scanned) onMessage(`${scanned} page${scanned === 1 ? ' has' : 's have'} no text${reader ? ', even after OCR' : ` layer (probably scanned). Run without --no-ocr to recognize ${scanned === 1 ? 'it' : 'them'} with superPDF OCR`}.`);
    const structure = cleanValue(read);
    const content = format === 'html' ? toHtml(structure)
      : format === 'json' ? JSON.stringify({ ...structure, sections: cleanValue(await buildPageIndex(doc, structure)) }, null, 2)
      : tables === 'html' ? await markdownHtmlTables(structure)
      : toMarkdown(structure);
    return { content, format, pages: structure.pages.length };
  } finally {
    await reader?.close();
    await task.destroy();
  }
}
