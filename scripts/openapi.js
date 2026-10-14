// Generate the OpenAPI 3.1 contract for `superpdf serve` from the shared Zod contracts (zod-openapi).
// `npm run openapi` writes openapi.json, which the API serves at /openapi.json. tests/openapi.test.js fails on drift.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDocument } from 'zod-openapi';
import * as z from 'zod';
import { contracts, written, pipelineStep } from '../contracts/tools.js';
import { problem, job, jobList, jobRequest, toolList, webhookEvent } from '../api/schemas.js';

export const OPENAPI_FILES = [new URL('../openapi.json', import.meta.url)];
const PORT = 7341;

const problems = list => Object.fromEntries(list.map(([status, description]) => [status, { description, content: { 'application/problem+json': { schema: problem } } }]));
const AUTH = [['401', 'The bearer token is missing or wrong.'], ['403', 'The Host or Origin header is not allowed.']];
const BODY = [['400', 'The body is not valid JSON.'], ['413', 'The body is larger than 1 MB.'], ['415', 'The body is not application/json.']];
const pascal = name => name.replace(/(^|_)([a-z])/g, (_, __, c) => c.toUpperCase());

export async function buildOpenApi() {
  const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const paths = {};
  const schemas = { Problem: problem, Job: job, JobRequest: jobRequest, WebhookEvent: webhookEvent, NewFile: written, PipelineStep: pipelineStep };
  for (const c of contracts) {
    schemas[`${pascal(c.name)}Input`] = c.input;
    if (!Object.values(schemas).includes(c.output)) schemas[`${pascal(c.name)}Result`] = c.output;
    paths[`/v1/tools/${c.name}`] = {
      post: {
        operationId: c.name, summary: c.title, tags: ['Tools'],
        description: `${c.description}\n\nSame tool as the MCP server's ${c.name}. Runs before responding; for long work, POST /v1/jobs instead.`,
        requestBody: { required: true, content: { 'application/json': { schema: c.input } } },
        responses: {
          200: { description: 'The result. Any new files are written inside the allowed folders.', content: { 'application/json': { schema: c.output } } },
          ...problems([...BODY, ...AUTH,
            ['409', 'The output file already exists. superPDF never overwrites; choose a new name.'],
            ['422', 'Invalid input (errors names each field), a path outside the allowed folders, or a document the tool could not process.'],
            ['429', 'Too many tool calls are running and waiting (4 at once, 2 of them LibreOffice conversions; 64 more wait their turn).'],
            ['500', 'Unexpected server failure.']]),
        },
      },
    };
  }
  paths['/v1/tools'] = {
    get: {
      operationId: 'list_tools', summary: 'List tools', tags: ['Tools'],
      responses: { 200: { description: 'Every tool, with its MCP annotations.', content: { 'application/json': { schema: toolList } } }, ...problems(AUTH) },
    },
  };
  paths['/v1/jobs'] = {
    post: {
      operationId: 'create_job', summary: 'Run a tool in the background', tags: ['Jobs'],
      description: 'Queues a tool call and returns at once with the job. Jobs run one at a time. Poll GET /v1/jobs/{id}, or pass callback_url to receive a signed event when it finishes. Failed callback deliveries are retried up to 5 times with exponential backoff (1, 2, 4 and 8 seconds).',
      requestBody: { required: true, content: { 'application/json': { schema: jobRequest } } },
      responses: {
        202: { description: 'Queued.', headers: { Location: { description: 'The job URL.', schema: { type: 'string' } } }, content: { 'application/json': { schema: job } } },
        ...problems([...BODY, ...AUTH, ['422', 'Invalid input, or a callback_url that is not allowed.'], ['429', 'Too many jobs are waiting.']]),
      },
      callbacks: {
        jobFinished: {
          '{$request.body#/callback_url}': {
            post: {
              summary: 'Job finished',
              description: 'Headers: webhook-id (the same on every retry), webhook-timestamp (Unix seconds) and webhook-signature: "v1," + base64 HMAC-SHA256 of "<webhook-id>.<webhook-timestamp>.<raw body>". The key is the base64-decoded part of the whsec_ secret printed at start (or SUPERPDF_WEBHOOK_SECRET). Reject events whose timestamp is more than 5 minutes off.',
              requestBody: { required: true, content: { 'application/json': { schema: webhookEvent } } },
              responses: { '2XX': { description: 'Received. Any other status, or no answer within 10 seconds, is retried for 408, 429, 5xx and network errors.' } },
            },
          },
        },
      },
    },
    get: {
      operationId: 'list_jobs', summary: 'List jobs', tags: ['Jobs'],
      responses: { 200: { description: 'Jobs from this server process, newest first. Finished jobs are kept for an hour.', content: { 'application/json': { schema: jobList } } }, ...problems(AUTH) },
    },
  };
  paths['/v1/jobs/{id}'] = {
    get: {
      operationId: 'get_job', summary: 'Get a job', tags: ['Jobs'],
      requestParams: { path: z.object({ id: z.string().describe('The job id from POST /v1/jobs.') }) },
      responses: { 200: { description: 'The job, with its result once it has succeeded.', content: { 'application/json': { schema: job } } }, ...problems([...AUTH, ['404', 'No such job.']]) },
    },
  };
  paths['/openapi.json'] = {
    get: {
      operationId: 'get_openapi', summary: 'This document', tags: ['Meta'], security: [],
      responses: { 200: { description: 'The OpenAPI 3.1 document. No token needed.', content: { 'application/json': { schema: z.record(z.string(), z.unknown()) } } }, ...problems([['403', 'The Host or Origin header is not allowed.']]) },
    },
  };
  return tidy(createDocument({
    openapi: '3.1.0',
    info: {
      title: 'superPDF local API',
      version,
      description: 'The superPDF tools over HTTP, served by `superpdf serve --allow-dir <folder>` on this computer only (127.0.0.1). The same tools, schemas, folder scope and no-overwrite rules as the superPDF MCP server. Documents never leave the computer: requests carry file paths inside the allowed folders, not file contents. Errors are RFC 9457 problem details.',
    },
    servers: [{ url: `http://127.0.0.1:${PORT}`, description: 'superpdf serve on the default port' }],
    security: [{ bearer: [] }],
    tags: [{ name: 'Tools', description: 'One operation per MCP tool.' }, { name: 'Jobs', description: 'Background tool calls with progress and signed completion callbacks.' }, { name: 'Meta' }],
    paths,
    components: {
      securitySchemes: { bearer: { type: 'http', scheme: 'bearer', description: 'The token superpdf serve prints when it starts (or SUPERPDF_API_TOKEN). It changes every launch.' } },
      schemas,
    },
  }));
}

/**
 * zod-openapi renders every registered component for both requests and responses (`X` and `XOutput`).
 * Keep only the components something references, and drop the Output suffix where no twin is left.
 */
function tidy(doc) {
  const schemas = doc.components.schemas;
  const refs = () => new Set([...JSON.stringify(doc).matchAll(/"#\/components\/schemas\/([^"]+)"/g)].map(m => m[1]));
  for (let used = refs(), before = -1; before !== used.size; before = used.size, used = refs()) {
    for (const name of Object.keys(schemas)) if (!used.has(name)) delete schemas[name];
  }
  let text = JSON.stringify(doc);
  for (const name of Object.keys(schemas)) {
    const base = name.replace(/Output$/, '');
    if (base !== name && !schemas[base]) text = text.replaceAll(`"#/components/schemas/${name}"`, `"#/components/schemas/${base}"`).replace(`"${name}":{`, `"${base}":{`);
  }
  const result = JSON.parse(text);
  result.components.schemas = Object.fromEntries(Object.entries(result.components.schemas).sort(([a], [b]) => a.localeCompare(b)));
  return result;
}

export const serialize = doc => `${JSON.stringify(doc, null, 2)}\n`;

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const text = serialize(await buildOpenApi());
  for (const file of OPENAPI_FILES) await writeFile(file, text);
  process.stdout.write(`Wrote ${OPENAPI_FILES.map(f => path.relative(process.cwd(), fileURLToPath(f))).join(' and ')}\n`);
}
