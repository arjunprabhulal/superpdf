// The SDK (import ... from '@superpdf/cli'): every tool is a function, in step with the contracts and the generated
// types, and the functions run on real PDFs inside the folders they are given.
import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as sdk from '@superpdf/cli';
import { contracts } from '../contracts/tools.js';
import { buildTypes, functionName, TYPES_FILE } from '../scripts/sdk-types.js';

const EXAMPLE = new URL('../examples/quarterly-report.pdf', import.meta.url);

async function folder() {
  const dir = await mkdtemp(join(tmpdir(), 'superpdf-sdk-'));
  await copyFile(EXAMPLE, join(dir, 'report.pdf'));
  return dir;
}

test('every tool is an SDK function, and nothing else is', () => {
  const expected = contracts.map(c => functionName(c.name)).sort();
  const extras = ['SuperPDFError', 'exportJson', 'exportPages', 'exportPdf', 'runTool', 'tools'];
  assert.deepEqual(Object.keys(sdk).filter(name => !extras.includes(name)).sort(), expected);
  for (const name of expected) assert.equal(typeof sdk[name], 'function', name);
});

test('sdk/index.d.ts matches the contracts (run npm run sdk:types after changing a tool)', async () => {
  assert.equal(await readFile(TYPES_FILE, 'utf8'), await buildTypes());
});

test('tools run on real PDFs with paths relative to the current folder', async () => {
  const dir = await folder();
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    assert.equal((await sdk.info({ input: 'report.pdf' })).pages, 1);
    const word = await sdk.toDocx({ input: 'report.pdf', output: 'report.docx' });
    assert.equal(word.tables, 2);
    assert.equal(word.output, join(await (await import('node:fs/promises')).realpath(dir), 'report.docx'));
    const merged = await sdk.merge({ inputs: ['report.pdf', 'report.pdf'], output: 'two.pdf' });
    assert.equal(merged.pages, 2);
    const progress = [];
    await sdk.runBatch(
      { inputs: ['report.pdf', 'two.pdf'], steps: [{ action: 'watermark', options: { text: 'DRAFT' } }], output_folder: 'drafts' },
      { onProgress: (done, total, message) => progress.push([done, total, message]) },
    );
    assert.deepEqual(progress.at(-1).slice(0, 2), [2, 2]);
  } finally {
    process.chdir(cwd);
  }
});

test('export reads paths and bytes, page by page and as JSON', async () => {
  const dir = await folder();
  const file = join(dir, 'report.pdf');
  const pages = await sdk.exportPages(file);
  assert.equal(pages.length, 1);
  assert.match(pages[0].markdown, /# Quarterly report/);
  assert.match(await sdk.exportPdf(await readFile(file), { tables: 'html' }), /<table>/);
  assert.equal((await sdk.exportJson(file)).sections[0].title, 'Quarterly report');
});

test('errors are SuperPDFError with the API problem codes', async () => {
  const dir = await folder();
  const file = join(dir, 'report.pdf');
  await assert.rejects(sdk.rotatePages({ input: file, angle: 45, output: join(dir, 'r.pdf') }),
    error => error instanceof sdk.SuperPDFError && error.code === 'validation' && /angle: use 90, 180 or 270/.test(error.message));
  await sdk.toDocx({ input: file, output: join(dir, 'taken.docx') });
  await assert.rejects(sdk.toDocx({ input: file, output: join(dir, 'taken.docx') }),
    error => error.code === 'conflict' && /already exists/.test(error.message));
  await assert.rejects(sdk.runTool('pdf_nope', {}), error => error.code === 'not_found');
  await assert.rejects(sdk.exportPdf(join(dir, 'missing.pdf')), error => error instanceof sdk.SuperPDFError && /No file at/.test(error.message));
});

test('allowDirs limits a call to the folders it names', async () => {
  const dir = await folder();
  const elsewhere = await mkdtemp(join(tmpdir(), 'superpdf-sdk-other-'));
  await assert.rejects(
    sdk.info({ input: join(dir, 'report.pdf') }, { allowDirs: [elsewhere] }),
    error => error.code === 'validation' && /outside the allowed folders/.test(error.message),
  );
});
