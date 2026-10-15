// Markdown tables (lib/pdf-structure.js tableMarkdown): every cell reads back exactly as it went in, whatever
// backslashes and pipes it holds.
import test from 'node:test';
import assert from 'node:assert/strict';
import { marked } from 'marked';
import { tableMarkdown } from '../lib/pdf-structure.js';

test('cells with backslashes and pipes stay whole', () => {
  const rows = [['Path', 'Value'], ['C:\\temp\\report.pdf', 'a|b'], ['ends with \\', 'y\\|z'], ['\\\\server', '||']];
  const table = marked.lexer(tableMarkdown(rows)).find(token => token.type === 'table');
  assert.deepEqual([table.header.map(c => c.text), ...table.rows.map(r => r.map(c => c.text))].map(r => r.map(t => t.replace(/\\(.)/g, '$1'))), rows);
  assert.equal(table.rows.length, 3, 'no row gained or lost a column');
  for (const row of table.rows) assert.equal(row.length, 2);
});
