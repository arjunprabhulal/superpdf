// Conversions, forms, tables, comparison and page tools from the website's shared modules (lib/), run in Node.
// Each contract follows contracts/tools.js: inputs inside the allowed folders, outputs always new files.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as z from 'zod';
import { PDFDocument } from 'pdf-lib';
import { transformPdf, imagePagePdf, pageIndices } from '../lib/pdf-core.js';
import { InputError } from '../mcp/scope.js';
import { cleanText, cleanValue } from './untrusted.js';

/** A file other than a PDF, written new (never overwriting): its path and size. */
const savedFile = z.object({ output: z.string(), bytes: z.number().int() });
const outputOf = (extension, what) => z.string().min(1)
  .describe(`Path for the new ${what} (ending in ${extension}), inside an allowed folder. Must not exist yet.`);
const TABLE_FORMATS = { xlsx: '.xlsx', csv: '.csv', json: '.json', markdown: '.md' };

async function saveFile(file, bytes) {
  await writeFile(file, bytes, { flag: 'wx' });
  return { output: file, bytes: bytes.length };
}

/** Open a PDF with PDF.js (Node options from lib/pdf-node.js), run `fn(pdfjs, doc)`, and always close it. */
async function withDocument(bytes, fn) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const { documentOptions } = await import('../lib/pdf-node.js');
  const task = pdfjs.getDocument(documentOptions(bytes));
  try { return await fn(pdfjs, await task.promise); } finally { await task.destroy(); }
}

/** The structure the exports read (lib/pdf-structure.js), with OCR for pages that have no text. */
async function readStructure(bytes, pages) {
  const { extractStructure, buildPageIndex } = await import('../lib/pdf-structure.js');
  const { scannedPageReader } = await import('../lib/pdf-node.js');
  const ocr = scannedPageReader();
  try {
    return await withDocument(bytes, async (pdfjs, doc) => {
      ocr.documentLanguage = (await doc.getMetadata().catch(() => ({}))).info?.Language;
      const read = await extractStructure(pdfjs, doc, { pages: pageIndices(pages || '', doc.numPages), recognize: (page, index, options) => ocr.recognize(page, index, options) });
      const structure = cleanValue(read);
      return { structure, sections: cleanValue(await buildPageIndex(doc, structure)), title: cleanText((await doc.getMetadata().catch(() => ({}))).info?.Title || '') };
    });
  } finally { await ocr.close(); }
}

/** The text layer of each chosen page: [{page, text}]. */
async function pageTexts(bytes, pages) {
  return withDocument(bytes, async (pdfjs, doc) => {
    const out = [];
    for (const index of pageIndices(pages || '', doc.numPages)) {
      const page = await doc.getPage(index + 1);
      const content = await page.getTextContent();
      page.cleanup();
      let text = '';
      for (const item of content.items) if ('str' in item) text += item.str + (item.hasEOL ? '\n' : ' ');
      out.push({ page: index + 1, text: cleanText(text).trim() });
    }
    return out;
  });
}

const titleFrom = (title, file) => title || path.basename(file, path.extname(file));

/** Tables as CSV: one block per table, a blank line between them. */
function tablesCsv(tables) {
  const cell = value => { const s = String(value ?? ''); return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s; };
  return tables.map(t => t.rows.map(row => row.map(cell).join(',')).join('\r\n')).join('\r\n\r\n') + '\r\n';
}

/** Tables as Markdown: a heading per table, then a pipe table (its first row as the header). */
function tablesMarkdown(tables) {
  const cell = value => String(value ?? '').replaceAll('|', '\\|').replace(/\s*\n\s*/g, ' ');
  return tables.map((t, i) => {
    const where = t.pages.length > 1 ? `pages ${t.pages[0]}-${t.pages.at(-1)}` : `page ${t.pages[0]}`;
    const width = Math.max(...t.rows.map(r => r.length));
    const row = r => `| ${Array.from({ length: width }, (_, c) => cell(r[c])).join(' | ')} |`;
    return [`## ${t.chart ? 'Chart' : 'Table'} ${i + 1} (${where})`, '', row(t.rows[0]), `|${' --- |'.repeat(width)}`, ...t.rows.slice(1).map(row)].join('\n');
  }).join('\n\n') + '\n';
}

export function documentContracts({ READ, CREATE, inputField, outputField, pagesField, written, loadInput, save, one, asInput }) {
  const fileField = what => z.string().min(1).describe(`Path to a ${what} inside an allowed folder.`);
  return [
    {
      name: 'pdf_to_docx', title: 'PDF to Word', annotations: CREATE, long: true,
      description: 'Convert a PDF to an editable Word document (.docx): headings, paragraphs with bold and italic, lists and tables. Scanned pages are read with OCR. Page layout and images are not reconstructed.',
      input: z.object({ input: inputField, pages: pagesField, output: outputOf('.docx', 'Word document') }),
      output: savedFile.extend({ pages: z.number().int(), paragraphs: z.number().int(), tables: z.number().int() }),
      async run({ input, pages, output }, { scope }) {
        const { file, bytes } = await loadInput(scope, input);
        const target = await scope.output(output, 'output', '.docx');
        const { structureToDocx } = await import('../lib/docx-export.js');
        const { structure, title } = await readStructure(bytes, pages).catch(asInput('pages', /page/i));
        const docx = await structureToDocx(structure, { title: titleFrom(title, file) });
        const saved = await saveFile(target, docx.bytes);
        return { value: { ...saved, pages: structure.pages.length, paragraphs: docx.paragraphs, tables: docx.tables }, files: [saved.output] };
      },
    },
    {
      name: 'pdf_extract_tables', title: 'Extract tables from a PDF', annotations: CREATE, long: true,
      description: 'Find the tables in a PDF (ruled, shaded and borderless, plus charts drawn as vectors, as tables of their values) and write them as Excel (.xlsx, one sheet per table), CSV, JSON or Markdown. The output name must end in the format\'s extension (.xlsx, .csv, .json, .md).',
      input: z.object({ input: inputField, pages: pagesField, format: z.enum(['xlsx', 'csv', 'json', 'markdown']).default('xlsx'), output: z.string().min(1).describe('Path for the new file, ending in .xlsx, .csv, .json or .md to match the format, inside an allowed folder. Must not exist yet.') }),
      output: savedFile.extend({ format: z.string(), tables: z.number().int() }),
      async run({ input, pages, format, output }, { scope }) {
        const { bytes } = await loadInput(scope, input);
        const target = await scope.output(output, 'output', TABLE_FORMATS[format]);
        const { readPdfTables, tablesToXlsx } = await import('../lib/pdf-tables.js');
        const found = await withDocument(bytes, (pdfjs, doc) => readPdfTables(pdfjs, doc, { pages: pageIndices(pages || '', doc.numPages) })).catch(asInput('pages', /page/i));
        const tables = cleanValue(found.tables);
        if (format === 'xlsx') {
          const { bytes: xlsx } = await tablesToXlsx(found);
          const saved = await saveFile(target, xlsx);
          return { value: { ...saved, format, tables: tables.length }, files: [saved.output] };
        }
        if (!tables.length) throw new InputError('input', 'no tables were found on the chosen pages. For text without tables, use pdf_extract_structure.');
        const text = format === 'csv' ? tablesCsv(tables)
          : format === 'markdown' ? tablesMarkdown(tables)
          : `${JSON.stringify(tables.map((t, i) => ({ table: i + 1, pages: t.pages, header: Boolean(t.header), chart: Boolean(t.chart), rows: t.rows })), null, 2)}\n`;
        const saved = await saveFile(target, new TextEncoder().encode(text));
        return { value: { ...saved, format, tables: tables.length }, files: [saved.output] };
      },
    },
    {
      name: 'pdf_fill_form', title: 'Fill a PDF form', annotations: CREATE,
      description: 'Fill form fields by name (pdf_info lists them): text fields take text, check boxes true or false, choices one of their options. With flatten, the filled values become part of the page and can no longer be edited.',
      input: z.object({
        input: inputField,
        values: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).describe('Field name → value, such as {"Name": "Ada Lovelace", "Agree": true}.'),
        flatten: z.boolean().default(false).describe('Make the filled values part of the page (no longer editable).'),
        output: outputField,
      }),
      output: written,
      async run({ input, values, flatten, output }, { scope }) {
        const { bytes } = await loadInput(scope, input);
        const target = await scope.output(output, 'output');
        let filled = await transformPdf(bytes, 'fill', { values: JSON.stringify(values) }).catch(asInput('values'));
        if (flatten) filled = await transformPdf(filled, 'flatten');
        return one(await save(target, filled));
      },
    },
    {
      name: 'pdf_add_text', title: 'Add text or a typed signature', annotations: CREATE,
      description: 'Draw text (such as a typed signature, a date or a note) at a position on the chosen pages. x and y are in points from the bottom-left corner of the page. Latin characters only.',
      input: z.object({
        input: inputField, pages: pagesField,
        text: z.string().min(1).max(200),
        x: z.number().min(0).default(36).describe('Points from the left edge.'),
        y: z.number().min(0).default(36).describe('Points from the bottom edge.'),
        size: z.number().min(6).max(72).default(12).describe('Font size in points.'),
        output: outputField,
      }),
      output: written,
      async run({ input, output, ...options }, { scope }) {
        const { bytes } = await loadInput(scope, input);
        const target = await scope.output(output, 'output');
        return one(await save(target, await transformPdf(bytes, 'annotate', options).catch(asInput('text'))));
      },
    },
    {
      name: 'pdf_flatten', title: 'Flatten a PDF', annotations: CREATE,
      description: 'Make form fields part of the page, so their values show everywhere and can no longer be edited.',
      input: z.object({ input: inputField, output: outputField }),
      output: written,
      async run({ input, output }, { scope }) {
        const { bytes } = await loadInput(scope, input);
        const target = await scope.output(output, 'output');
        return one(await save(target, await transformPdf(bytes, 'flatten')));
      },
    },
    {
      name: 'pdf_resize_pages', title: 'Crop or scale pages', annotations: CREATE,
      description: 'Crop a margin from each edge (mode crop, margin in points) or scale page content (mode scale, factor 0.1–4).',
      input: z.object({
        input: inputField, pages: pagesField,
        mode: z.enum(['crop', 'scale']),
        margin: z.number().min(0).max(500).default(24).describe('Points trimmed from each edge (crop).'),
        factor: z.number().min(0.1).max(4).default(1).describe('Scale factor (scale).'),
        output: outputField,
      }),
      output: written,
      async run({ input, mode, output, ...options }, { scope }) {
        const { bytes } = await loadInput(scope, input);
        const target = await scope.output(output, 'output');
        return one(await save(target, await transformPdf(bytes, mode, options).catch(asInput(mode === 'crop' ? 'margin' : 'factor', /margin|scale|page/i))));
      },
    },
    {
      name: 'pdf_from_images', title: 'Images to PDF', annotations: CREATE, long: true,
      description: 'Make a PDF from JPG or PNG images, one page per image, in the order given.',
      input: z.object({ inputs: z.array(fileField('JPG or PNG image')).min(1).max(200), output: outputField }),
      output: written,
      async run({ inputs, output }, { scope, progress }) {
        const target = await scope.output(output, 'output');
        const pdf = await PDFDocument.create();
        for (const [i, value] of inputs.entries()) {
          const file = await scope.input(value, `inputs[${i}]`);
          const page = await imagePagePdf(new Uint8Array(await readFile(file))).catch(error => { throw new InputError(`inputs[${i}]`, error.message); });
          const [copied] = await pdf.copyPages(await PDFDocument.load(page), [0]);
          pdf.addPage(copied);
          progress(i + 1, inputs.length, `Image ${i + 1} of ${inputs.length}`);
        }
        return one(await save(target, await pdf.save()));
      },
    },
    {
      name: 'pdf_from_markdown', title: 'Markdown to PDF', annotations: CREATE,
      description: 'Typeset a Markdown file (headings, paragraphs, lists, tables, code, links) as a PDF on A4 or Letter pages.',
      input: z.object({ input: fileField('Markdown file (.md)'), page_size: z.enum(['A4', 'Letter']).default('A4'), title: z.string().max(200).optional(), output: outputField }),
      output: written,
      async run({ input, page_size, title, output }, { scope }) {
        const file = await scope.input(input, 'input');
        const target = await scope.output(output, 'output');
        const { markdownToPdf } = await import('../lib/markdown-pdf.js');
        const made = await markdownToPdf(await readFile(file, 'utf8'), { pageSize: page_size, title: title || path.basename(file, path.extname(file)) }).catch(asInput('input', /empty/i));
        return one(await save(target, made.bytes, made.pages));
      },
    },
    {
      name: 'pdf_to_pptx', title: 'PDF to PowerPoint', annotations: CREATE, long: true,
      description: 'Convert a PDF to a PowerPoint file (.pptx) with one slide per page and its text as editable text boxes.',
      input: z.object({ input: inputField, pages: pagesField, output: outputOf('.pptx', 'PowerPoint file') }),
      output: savedFile.extend({ slides: z.number().int(), empty_pages: z.array(z.number().int()) }),
      async run({ input, pages, output }, { scope }) {
        const { file, bytes } = await loadInput(scope, input);
        const target = await scope.output(output, 'output', '.pptx');
        const { readPdfSlides, slidesToPptx } = await import('../lib/pptx-export.js');
        const slides = await withDocument(bytes, (pdfjs, doc) => readPdfSlides(pdfjs, doc, { pages: pageIndices(pages || '', doc.numPages), mode: 'text' })).catch(asInput('pages', /page/i));
        const pptx = await slidesToPptx(slides, { mode: 'text', title: path.basename(file, path.extname(file)) }).catch(asInput('input', /text layer/i));
        const saved = await saveFile(target, pptx.bytes);
        return { value: { ...saved, slides: pptx.slides, empty_pages: pptx.emptyPages }, files: [saved.output] };
      },
    },
    {
      name: 'pdf_to_epub', title: 'PDF to EPUB', annotations: CREATE, long: true,
      description: 'Convert a PDF\'s text into an EPUB 3 e-book, split into chapters at headings (or every few pages).',
      input: z.object({
        input: inputField,
        title: z.string().max(200).optional(), author: z.string().max(200).optional(),
        language: z.string().regex(/^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/).default('en').describe('Language tag, such as en or pt-BR.'),
        split: z.enum(['headings', 'pages']).default('headings'),
        output: outputOf('.epub', 'e-book'),
      }),
      output: savedFile.extend({ chapters: z.number().int() }),
      async run({ input, title, author, language, split, output }, { scope }) {
        const { file, bytes } = await loadInput(scope, input);
        const target = await scope.output(output, 'output', '.epub');
        const { pagesToEpub } = await import('../lib/epub.js');
        const pages = await pageTexts(bytes);
        if (!pages.some(p => p.text)) throw new InputError('input', 'this PDF has no text layer. Read it with OCR first (pdf_extract_structure), then convert.');
        const book = pagesToEpub(pages, { title: title || path.basename(file, path.extname(file)), author, language, split });
        const saved = await saveFile(target, book.bytes);
        return { value: { ...saved, chapters: book.chapters }, files: [saved.output] };
      },
    },
    {
      name: 'pdf_compare', title: 'Compare two PDFs', annotations: READ, long: true,
      description: 'Compare the text of two versions of a PDF page by page: which pages changed, were added or removed, and the words that changed, marked [-removed-] and {+added+}.',
      input: z.object({
        before: z.string().min(1).describe('Path to the earlier PDF inside an allowed folder.'),
        after: z.string().min(1).describe('Path to the revised PDF inside an allowed folder.'),
        max_chars: z.number().int().min(100).max(400000).default(20000).describe('Most characters of marked text returned per page.'),
      }),
      output: z.object({ summary: z.string(), pages: z.array(z.object({ page: z.number().int(), status: z.enum(['same', 'changed', 'added', 'removed']), words_removed: z.number().int(), words_added: z.number().int(), changes: z.string() })) }),
      async run({ before, after, max_chars }, { scope }) {
        const { diffWords, diffStats, markText, summarize } = await import('../lib/compare.js');
        const a = await pageTexts((await loadInput(scope, before, 'before')).bytes);
        const b = await pageTexts((await loadInput(scope, after, 'after')).bytes);
        const pages = [];
        for (let i = 0; i < Math.max(a.length, b.length); i++) {
          const status = !a[i] ? 'added' : !b[i] ? 'removed' : null;
          const { ops } = diffWords(a[i]?.text ?? '', b[i]?.text ?? '');
          const { deleted, inserted } = diffStats(ops);
          const changed = status || (deleted || inserted ? 'changed' : 'same');
          pages.push({ page: i + 1, status: changed, words_removed: deleted, words_added: inserted, changes: changed === 'same' ? '' : markText(ops).slice(0, max_chars) });
        }
        return { value: { summary: summarize(pages), pages } };
      },
    },
    {
      name: 'pdf_outline', title: 'Outline of a PDF', annotations: READ, long: true,
      description: 'The document\'s outline (from bookmarks or detected headings) as a Markdown list or JSON tree, with the pages each section covers.',
      input: z.object({ input: inputField, format: z.enum(['markdown', 'json']).default('markdown') }),
      output: z.object({ format: z.string(), content: z.string(), sections: z.array(z.any()) }),
      async run({ input, format }, { scope }) {
        const { file, bytes } = await loadInput(scope, input);
        const { mindMapMarkdown } = await import('../lib/diagram.js');
        const { sections, title } = await readStructure(bytes);
        const name = titleFrom(title, file);
        return { value: { format, content: format === 'json' ? JSON.stringify(sections, null, 2) : mindMapMarkdown(sections, { title: name }), sections } };
      },
    },
  ];
}
