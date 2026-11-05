// The Claude Desktop extension (scripts/mcpb.js, mcpb/server.js): its manifest follows package.json and lists every
// tool, and the folders Claude Desktop passes become --allow-dir options for the MCP server.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { manifest } from '../scripts/mcpb.js';
import { allowDirArgs } from '../mcpb/server.js';
import { contracts } from '../contracts/tools.js';

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

test('mcpb: the manifest has the package version, licence and Node version, and every tool', () => {
  const m = manifest(pkg);
  assert.equal(m.manifest_version, '0.3');
  assert.equal(m.version, pkg.version);
  assert.equal(m.license, pkg.license);
  assert.equal(m.compatibility.runtimes.node, '>=22.0.0');
  assert.deepEqual(m.tools.map(t => t.name), contracts.map(c => c.name));
  for (const t of m.tools) assert.ok(t.description, t.name);
  assert.equal(m.server.entry_point, 'mcpb/server.js');
  assert.deepEqual(m.server.mcp_config.args, ['${__dirname}/mcpb/server.js', '${user_config.allowed_directories}']);
  assert.equal(m.user_config.allowed_directories.type, 'directory');
  assert.equal(m.user_config.allowed_directories.required, true);
});

test('mcpb: each folder Claude Desktop passes becomes an --allow-dir option', () => {
  assert.deepEqual(allowDirArgs(['/a', '/b c']), ['--allow-dir', '/a', '--allow-dir', '/b c']);
  assert.deepEqual(allowDirArgs([]), []);
});
