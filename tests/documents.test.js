// The conversion, form, table, comparison and page tools (contracts/documents.js), run through the shared contracts
// exactly as the CLI, the MCP server and the local API run them, on files made here and the example report.
import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { contractByName, runContract } from '../contracts/tools.js';
import { createScope } from '../mcp/scope.js';

const EXAMPLE = new URL('../examples/quarterly-report.pdf', import.meta.url);

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'superpdf-documents-'));
  await copyFile(EXAMPLE, join(dir, 'report.pdf'));
  const scope = await createScope([dir]);
  const call = async (name, input) => {
    const contract = contractByName.get(name);
    return (await runContract(contract, contract.input.parse(input), { scope })).value;
  };
  return { dir, call };
}

/** A small solid-colour PNG (8-bit RGB), enough for an image page. */
function png(width, height, [r, g, b]) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const length = Buffer.alloc(4), sum = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    sum.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => [r, g, b]).flat())]);
  const pixels = deflateSync(Buffer.concat(Array.from({ length: height }, () => row)));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', pixels), chunk('IEND', Buffer.alloc(0))]);
}

const zipEntries = bytes => {
  const text = Buffer.from(bytes).toString('latin1');
  return [...text.matchAll(/PK\x01\x02[\s\S]{42}/g)].map(m => {
    const at = m.index, length = bytes.readUInt16LE(at + 28);
    return text.slice(at + 46, at + 46 + length);
  });
};

test('PDF to Word, PowerPoint and EPUB write real Office and EPUB files', async () => {
  const { dir, call } = await setup();
  const docx = await call('pdf_to_docx', { input: 'report.pdf', output: 'report.docx' });
  assert.ok(docx.paragraphs > 0 && docx.tables >= 1 && docx.pages === 1, JSON.stringify(docx));
  assert.ok(zipEntries(await readFile(join(dir, 'report.docx'))).includes('word/document.xml'));
  const pptx = await call('pdf_to_pptx', { input: 'report.pdf', output: 'report.pptx' });
  assert.equal(pptx.slides, 1);
  assert.ok(zipEntries(await readFile(join(dir, 'report.pptx'))).includes('ppt/presentation.xml'));
  const epub = await call('pdf_to_epub', { input: 'report.pdf', author: 'Northwind', output: 'report.epub' });
  assert.ok(epub.chapters >= 1);
  const book = await readFile(join(dir, 'report.epub'));
  assert.equal(book.subarray(30, 38).toString(), 'mimetype');
});

test('tables come out as Excel, CSV, Markdown and JSON, and the extension must match the format', async () => {
  const { dir, call } = await setup();
  assert.ok((await call('pdf_extract_tables', { input: 'report.pdf', output: 'tables.xlsx' })).tables >= 1);
  for (const [format, extension] of [['csv', 'csv'], ['markdown', 'md'], ['json', 'json']]) {
    const result = await call('pdf_extract_tables', { input: 'report.pdf', format, output: `tables.${extension}` });
    assert.equal(result.format, format);
    assert.ok(result.tables >= 1);
  }
  assert.match(await readFile(join(dir, 'tables.md'), 'utf8'), /^\|.+\|\n\|[- |]+\|/m);
  assert.ok(Array.isArray(JSON.parse(await readFile(join(dir, 'tables.json'), 'utf8'))));
  await assert.rejects(call('pdf_extract_tables', { input: 'report.pdf', format: 'csv', output: 'wrong.xlsx' }), /\.csv/);
});

test('forms are filled by field name, and flattening makes the values part of the page', async () => {
  const { dir, call } = await setup();
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([400, 300]);
  const form = pdf.getForm();
  form.createTextField('Name').addToPage(page, { x: 50, y: 200, width: 200, height: 24 });
  form.createCheckBox('Agree').addToPage(page, { x: 50, y: 150, width: 18, height: 18 });
  await writeFile(join(dir, 'form.pdf'), await pdf.save());

  await call('pdf_fill_form', { input: 'form.pdf', values: { Name: 'Ada Lovelace', Agree: true }, output: 'filled.pdf' });
  const filled = (await PDFDocument.load(await readFile(join(dir, 'filled.pdf')))).getForm();
  assert.equal(filled.getTextField('Name').getText(), 'Ada Lovelace');
  assert.ok(filled.getCheckBox('Agree').isChecked());

  await call('pdf_fill_form', { input: 'form.pdf', values: { Name: 'Ada' }, flatten: true, output: 'flat.pdf' });
  assert.equal((await PDFDocument.load(await readFile(join(dir, 'flat.pdf')))).getForm().getFields().length, 0);
  assert.match((await call('pdf_read_text', { input: 'flat.pdf' })).pages[0].text, /Ada/);
  await assert.rejects(call('pdf_fill_form', { input: 'form.pdf', values: { Nope: 'x' }, output: 'bad.pdf' }), /Nope/);
  assert.equal((await call('pdf_flatten', { input: 'filled.pdf', output: 'flattened.pdf' })).pages, 1);
});

test('text, crop, scale and page labels change the pages as asked', async () => {
  const { dir, call } = await setup();
  await call('pdf_add_text', { input: 'report.pdf', text: 'Signed: Ada Lovelace', x: 72, y: 100, output: 'signed.pdf' });
  assert.match((await call('pdf_read_text', { input: 'signed.pdf' })).pages[0].text, /Signed: Ada Lovelace/);

  const size = async name => (await PDFDocument.load(await readFile(join(dir, name)))).getPage(0);
  const original = await size('report.pdf');
  await call('pdf_resize_pages', { input: 'report.pdf', mode: 'crop', margin: 36, output: 'crop.pdf' });
  const cropped = (await size('crop.pdf')).getCropBox();
  assert.equal(Math.round(cropped.width), Math.round(original.getWidth() - 72));
  assert.equal((await call('pdf_resize_pages', { input: 'report.pdf', mode: 'scale', factor: 0.5, output: 'half.pdf' })).pages, 1);

  await call('pdf_merge', { inputs: ['report.pdf', 'report.pdf'], output: 'two.pdf' });
  await call('pdf_add_page_labels', { input: 'two.pdf', position: 'top', output: 'top.pdf' });
  const labelled = await call('pdf_read_text', { input: 'top.pdf' });
  assert.match(labelled.pages[1].text, /2/);
});

test('images and Markdown become PDFs', async () => {
  const { dir, call } = await setup();
  await writeFile(join(dir, 'red.png'), png(40, 30, [200, 30, 30]));
  await writeFile(join(dir, 'blue.png'), png(30, 40, [30, 30, 200]));
  assert.equal((await call('pdf_from_images', { inputs: ['red.png', 'blue.png'], output: 'images.pdf' })).pages, 2);
  await assert.rejects(call('pdf_from_images', { inputs: ['report.pdf'], output: 'nope.pdf' }), /inputs\[0\]/);

  await writeFile(join(dir, 'notes.md'), '# Launch notes\n\nsuperPDF **0.3** adds *more* tools.\n\n- Word\n- Excel\n\n| Tool | Output |\n|---|---|\n| docx | Word |\n');
  const made = await call('pdf_from_markdown', { input: 'notes.md', page_size: 'Letter', output: 'notes.pdf' });
  assert.equal(made.pages, 1);
  const page = (await PDFDocument.load(await readFile(join(dir, 'notes.pdf')))).getPage(0);
  assert.deepEqual([page.getWidth(), page.getHeight()], [612, 792]);
  assert.match((await call('pdf_read_text', { input: 'notes.pdf' })).pages[0].text, /Launch notes/);
});

test('compare finds added pages and words, and the outline lists the sections', async () => {
  const { dir, call } = await setup();
  const extra = await PDFDocument.create();
  extra.addPage([612, 792]).drawText('An appendix with new numbers', { x: 72, y: 700, size: 14, font: await extra.embedFont(StandardFonts.Helvetica) });
  await writeFile(join(dir, 'extra.pdf'), await extra.save());
  await call('pdf_merge', { inputs: ['report.pdf', 'extra.pdf'], output: 'longer.pdf' });

  const same = await call('pdf_compare', { before: 'report.pdf', after: 'report.pdf' });
  assert.ok(same.pages.every(p => p.status === 'same'), JSON.stringify(same.pages));
  const changed = await call('pdf_compare', { before: 'report.pdf', after: 'longer.pdf' });
  assert.deepEqual(changed.pages.map(p => p.status), ['same', 'added']);
  assert.ok(changed.pages[1].words_added > 0);

  const outline = await call('pdf_outline', { input: 'report.pdf' });
  assert.equal(outline.format, 'markdown');
  assert.match(outline.content, /Quarterly report/);
  assert.ok(outline.sections.length >= 1);
  assert.deepEqual(JSON.parse((await call('pdf_outline', { input: 'report.pdf', format: 'json' })).content), outline.sections);
});
