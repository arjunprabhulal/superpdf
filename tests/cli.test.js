// End-to-end tests of the superpdf command, the MCP server and the local API, on PDFs made here (no fixtures).
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { PDFDocument, StandardFonts, degrees } from 'pdf-lib';

const run = promisify(execFile);
const BIN = fileURLToPath(new URL('../bin/superpdf.js', import.meta.url));
const cli = (args, cwd) => run(process.execPath, [BIN, ...args], { cwd });

async function samplePdf(dir, name, pages, title = 'Report') {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica), bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  for (let i = 1; i <= pages; i++) {
    const page = pdf.addPage([612, 792]);
    page.drawText(`${title} section ${i}`, { x: 72, y: 700, size: 20, font: bold });
    page.drawText(`This paragraph on page ${i} explains the quarterly results in plain words.`, { x: 72, y: 660, size: 11, font });
  }
  const path = join(dir, name);
  await writeFile(path, await pdf.save());
  return path;
}

const workdir = async () => mkdtemp(join(tmpdir(), 'superpdf-test-'));

test('PDF.js data folders end in / on every platform, Windows paths included', async () => {
  const { pdfjsResources } = await import('../lib/pdf-node.js');
  const windows = pdfjsResources('C:\\Users\\me\\node_modules\\pdfjs-dist', '\\');
  assert.equal(windows.cMapUrl, 'C:/Users/me/node_modules/pdfjs-dist/cmaps/');
  assert.equal(windows.standardFontDataUrl, 'C:/Users/me/node_modules/pdfjs-dist/standard_fonts/');
  for (const value of Object.values(pdfjsResources())) {
    if (typeof value === 'string') assert.ok(value.endsWith('/') && !value.includes('\\'), value);
  }
});

test('version and help', async () => {
  const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal((await cli(['--version'])).stdout.trim(), version);
  assert.match((await cli(['help'])).stdout, /Usage: superpdf <command>/);
});

test('merge, extract, rotate and pipeline write new PDFs with the right pages', async () => {
  const dir = await workdir();
  await samplePdf(dir, 'a.pdf', 2); await samplePdf(dir, 'b.pdf', 3);
  assert.equal(JSON.parse((await cli(['merge', 'a.pdf', 'b.pdf', '--output', 'm.pdf'], dir)).stdout).pages, 5);
  assert.equal(JSON.parse((await cli(['extract', 'm.pdf', '--pages', '1,4-5', '--output', 'e.pdf'], dir)).stdout).pages, 3);
  await cli(['rotate', 'e.pdf', '--pages', '2', '--angle', '90', '--output', 'r.pdf'], dir);
  const rotated = await PDFDocument.load(await readFile(join(dir, 'r.pdf')));
  assert.deepEqual(rotated.getPages().map(p => p.getRotation().angle), [0, 90, 0]);
  await writeFile(join(dir, 'steps.json'), JSON.stringify([{ action: 'extract', options: { pages: '1-2' } }, { action: 'rotate', options: { angle: 180 } }]));
  await cli(['pipeline', 'm.pdf', '--steps', 'steps.json', '--output', 'p.pdf'], dir);
  const piped = await PDFDocument.load(await readFile(join(dir, 'p.pdf')));
  assert.deepEqual(piped.getPages().map(p => p.getRotation().angle), [180, 180]);
  assert.ok(degrees);
});

test('export reads headings and paragraphs into Markdown, HTML and JSON', async () => {
  const dir = await workdir();
  await samplePdf(dir, 'r.pdf', 2, 'Annual report');
  await cli(['export', 'r.pdf', '--output', 'r.md'], dir);
  const md = await readFile(join(dir, 'r.md'), 'utf8');
  assert.match(md, /Annual report section 1/);
  assert.match(md, /quarterly results/);
  await cli(['export', 'r.pdf', '--output', 'r.html'], dir);
  assert.match(await readFile(join(dir, 'r.html'), 'utf8'), /<section class="page" data-page="2">/);
  await cli(['export', 'r.pdf', '--format', 'json', '--output', 'r.json'], dir);
  assert.equal(JSON.parse(await readFile(join(dir, 'r.json'), 'utf8')).pages.length, 2);
});

test('outputs are never overwritten and missing files are explained', async () => {
  const dir = await workdir();
  await samplePdf(dir, 'a.pdf', 1);
  await cli(['merge', 'a.pdf', 'a.pdf', '--output', 'm.pdf'], dir);
  await assert.rejects(cli(['merge', 'a.pdf', 'a.pdf', '--output', 'm.pdf'], dir), /already exists/);
  await assert.rejects(cli(['info', 'nope.pdf'], dir), /No file at (.*[\\/])?nope\.pdf\./);
});

test('MCP server lists its tools and reads only inside --allow-dir', async () => {
  const dir = await workdir();
  const file = await samplePdf(dir, 'a.pdf', 3);
  const server = spawn(process.execPath, [BIN, 'mcp', '--allow-dir', dir], { stdio: ['pipe', 'pipe', 'ignore'] });
  const replies = new Map();
  let buffer = '';
  server.stdout.on('data', chunk => {
    buffer += chunk;
    const lines = buffer.split('\n'); buffer = lines.pop();
    for (const line of lines) { try { const m = JSON.parse(line); if (m.id) replies.get(m.id)?.(m); } catch {} }
  });
  const call = (id, method, params) => new Promise(resolve => { replies.set(id, resolve); server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
  try {
    await call(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    const tools = (await call(2, 'tools/list', {})).result.tools.map(t => t.name);
    assert.ok(tools.includes('pdf_info') && tools.includes('pdf_extract_structure'));
    const info = await call(3, 'tools/call', { name: 'pdf_info', arguments: { input: file } });
    assert.equal(JSON.parse(info.result.content[0].text).pages, 3);
    const outside = await call(4, 'tools/call', { name: 'pdf_info', arguments: { input: '/etc/hosts' } });
    assert.equal(outside.result.isError, true);
  } finally { server.kill(); }
});

test('local API needs its token and stays inside --allow-dir', async () => {
  const dir = await workdir();
  const file = await samplePdf(dir, 'a.pdf', 2);
  const token = randomBytes(24).toString('hex');
  const server = spawn(process.execPath, [BIN, 'serve', '--allow-dir', dir, '--port', '0'], { env: { ...process.env, SUPERPDF_API_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const url = await new Promise((resolve, reject) => {
      const seen = data => { const m = String(data).match(/http:\/\/127\.0\.0\.1:\d+/); if (m) resolve(m[0]); };
      server.stdout.on('data', seen); server.stderr.on('data', seen);
      setTimeout(() => reject(new Error('the API did not start')), 15000);
    });
    const post = (body, auth = true) => fetch(`${url}/v1/tools/pdf_info`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(auth && { Authorization: `Bearer ${token}` }) }, body: JSON.stringify(body) });
    assert.equal((await post({ input: file }, false)).status, 401);
    const ok = await post({ input: file });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).pages, 2);
    assert.ok((await post({ input: '/etc/hosts' })).status >= 400);
  } finally { server.kill(); }
});

test('tools lists every tool and tool runs one, inside --allow-dir only', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'superpdf-test-'));
  await samplePdf(dir, 'a.pdf', 2);
  const { stdout } = await cli(['tools'], dir);
  const tools = JSON.parse(stdout);
  assert.equal(tools.length, 18);
  assert.ok(tools.every(t => t.name.startsWith('pdf_') && t.input_schema.type === 'object'));
  const merged = JSON.parse((await cli(['tool', 'pdf_merge', '--input', JSON.stringify({ inputs: ['a.pdf', 'a.pdf'], output: 'b.pdf' })], dir)).stdout);
  assert.equal(merged.value.pages, 4);
  await assert.rejects(cli(['tool', 'pdf_rotate_pages', '--input', '{"input":"a.pdf","angle":45,"output":"c.pdf"}'], dir), /angle: use 90, 180 or 270/);
  await assert.rejects(cli(['tool', 'pdf_info', '--input', JSON.stringify({ input: BIN })], dir), /outside the allowed folders/);
  await assert.rejects(cli(['tool', 'pdf_nope'], dir), /no tool called pdf_nope/);
});
