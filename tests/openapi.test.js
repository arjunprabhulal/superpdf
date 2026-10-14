// openapi.json is generated from the shared contracts (npm run openapi). This fails when they drift apart.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildOpenApi, serialize, OPENAPI_FILES } from '../scripts/openapi.js';
import { contracts } from '../contracts/tools.js';

test('openapi.json matches the contracts (run npm run openapi after changing a tool)', async () => {
  const doc = await buildOpenApi();
  for (const c of contracts) assert.ok(doc.paths[`/v1/tools/${c.name}`]?.post, `${c.name} has no operation`);
  const expected = serialize(doc);
  for (const file of OPENAPI_FILES) assert.equal(await readFile(file, 'utf8'), expected, `${file.pathname} is out of date: npm run openapi`);
});
