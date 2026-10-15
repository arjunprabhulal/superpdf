// server.json (the MCP Registry entry, published with mcp-publisher) stays in step with package.json.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = file => JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'));

test('server.json names this package at its version', () => {
  const pkg = read('package.json'), server = read('server.json');
  assert.equal(server.name, pkg.mcpName, 'the registry checks mcpName in the published package against this name');
  assert.equal(server.version, pkg.version);
  const [npm] = server.packages;
  assert.equal(npm.identifier, pkg.name);
  assert.equal(npm.version, pkg.version);
  assert.ok(server.description.length <= 100, 'the registry allows 100 characters');
  assert.deepEqual(npm.packageArguments.map(a => a.value ?? a.name), ['mcp', '--allow-dir'], 'the arguments `superpdf mcp --allow-dir <folder>` takes');
});
