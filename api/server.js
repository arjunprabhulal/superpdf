// superPDF local HTTP API: `superpdf serve --allow-dir <folder>`. Listens on 127.0.0.1 only, checks the
// Host and Origin headers (against DNS rebinding and other websites), and requires the bearer token
// printed at start. Tools come from the same contract registry as the MCP server, with the same folder
// scope and no-overwrite rules. Errors are RFC 9457 problem+json. Documents never leave the computer;
// the only outbound requests are job callbacks to addresses the user allowed.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { contracts, contractByName, runContract } from '../contracts/tools.js';
import { classify, PROBLEM_TITLES } from '../contracts/errors.js';
import { createScope, parseAllowDirs, InputError } from '../mcp/scope.js';
import { jobRequest, issuesToErrors } from './schemas.js';
import { createJobQueue, TooManyJobsError } from './jobs.js';
import { createWebhooks, newSecret, parseAllowedOrigins } from './webhooks.js';

export const DEFAULT_PORT = 7341;
const MAX_BODY_BYTES = 1024 * 1024;
const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const OPENAPI_FILE = new URL('../openapi.json', import.meta.url);

/** An error the server answers with a specific problem. */
class HttpProblem extends Error {
  constructor(status, code, detail, extra = {}) { super(detail); Object.assign(this, { status, code, extra }); }
}

const problemBody = (status, code, detail, requestId, extra = {}) => ({
  type: `urn:superpdf:problem:${code}`, title: PROBLEM_TITLES[code], status, detail,
  instance: `urn:superpdf:request:${requestId}`, code, request_id: requestId, ...extra,
});
/** A failed tool call as a problem object (used for sync calls and failed jobs alike). */
export function toolProblem(error, requestId) {
  const { status, code, detail, errors } = classify(error);
  return problemBody(status, code, detail, requestId, errors ? { errors } : {});
}

const digest = value => createHash('sha256').update(value).digest();
const sameToken = (given, expected) => timingSafeEqual(digest(given), digest(expected));

/**
 * Start the API. Returns { url, port, token, webhookSecret, jobs, close() }.
 * `webhookOptions` (attempts, backoffMs, timeoutMs) exists for tests.
 */
export async function startApi({ scope, port = DEFAULT_PORT, token = randomBytes(32).toString('base64url'), allowOrigins = [], webhookAllow = [], webhookSecret = newSecret(), webhookOptions = {} }) {
  const origins = new Set(allowOrigins.map(o => new URL(o).origin));
  const webhooks = createWebhooks({ allow: webhookAllow, secret: webhookSecret, userAgent: `superPDF/${version}`, ...webhookOptions });
  // A job was accepted (202), so it waits for a free slot rather than failing busy like a direct call.
  const execute = (tool, input, progress) => runContract(contractByName.get(tool), input, { scope, progress, wait: true });
  const jobs = createJobQueue({ execute, toProblem: toolProblem, webhooks });
  const openapi = JSON.parse(await readFile(OPENAPI_FILE, 'utf8'));
  let hosts = new Set();

  async function readJson(req) {
    if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) throw new HttpProblem(415, 'unsupported_media_type', 'Send the request body as JSON with Content-Type: application/json.');
    const chunks = []; let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) throw new HttpProblem(413, 'payload_too_large', 'The request body is larger than 1 MB. Send file paths, not file contents.');
      chunks.push(chunk);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'); }
    catch { throw new HttpProblem(400, 'bad_request', 'The request body is not valid JSON.'); }
  }
  const validate = (schema, body) => {
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw new HttpProblem(422, 'validation', 'Invalid input. Check the fields listed in errors.', { errors: issuesToErrors(parsed.error.issues) });
    return parsed.data;
  };

  function authorize(req) {
    const header = req.headers.authorization || '';
    const match = /^Bearer\s+(\S+)$/i.exec(header);
    if (!match || !sameToken(match[1], token)) {
      throw new HttpProblem(401, 'unauthorized', header ? 'The bearer token is not valid for this server. Use the token printed when superpdf serve started.' : 'Send the token printed when superpdf serve started, as Authorization: Bearer <token>.',
        { challenge: header ? 'Bearer realm="superPDF", error="invalid_token"' : 'Bearer realm="superPDF"' });
    }
  }

  async function route(req, res, requestId) {
    const { pathname } = new URL(req.url, 'http://127.0.0.1');
    const allow = methods => { if (!methods.includes(req.method)) throw new HttpProblem(405, 'method_not_allowed', `${req.method} is not supported here. Use ${methods.join(' or ')}.`, { allow: methods.join(', ') }); };

    if (pathname === '/openapi.json') { allow(['GET']); return [200, openapi]; }
    if (!pathname.startsWith('/v1/')) throw new HttpProblem(404, 'not_found', `Nothing at ${pathname}. See /openapi.json for the API.`);
    authorize(req);

    if (pathname === '/v1/tools') {
      allow(['GET']);
      return [200, { tools: contracts.map(c => ({ name: c.name, title: c.title, description: c.description, reports_progress: !!c.long, annotations: c.annotations })) }];
    }
    const tool = /^\/v1\/tools\/([a-z_]+)$/.exec(pathname);
    if (tool) {
      const contract = contractByName.get(tool[1]);
      if (!contract) throw new HttpProblem(404, 'not_found', `There is no tool named ${tool[1]}. GET /v1/tools lists them.`);
      allow(['POST']);
      const input = validate(contract.input, await readJson(req));
      try { return [200, (await runContract(contract, input, { scope })).value]; }
      catch (error) { return [null, toolProblem(error, requestId)]; }
    }
    if (pathname === '/v1/jobs') {
      allow(['GET', 'POST']);
      if (req.method === 'GET') return [200, { jobs: jobs.list() }];
      const { tool: name, input, callback_url } = validate(jobRequest, await readJson(req));
      let callbackUrl;
      try { callbackUrl = callback_url && webhooks.check(callback_url); }
      catch (error) { if (error instanceof InputError) return [null, toolProblem(error, requestId)]; throw error; }
      let job;
      try { job = jobs.submit({ tool: name, input, callbackUrl }); }
      catch (error) { if (error instanceof TooManyJobsError) throw new HttpProblem(429, 'too_many_jobs', error.message); throw error; }
      res.setHeader('Location', `/v1/jobs/${job.id}`);
      return [202, job];
    }
    const jobPath = /^\/v1\/jobs\/([A-Za-z0-9_-]+)$/.exec(pathname);
    if (jobPath) {
      allow(['GET']);
      const job = jobs.get(jobPath[1]);
      if (!job) throw new HttpProblem(404, 'not_found', `No job ${jobPath[1]}. Jobs are kept for an hour after they finish, and until the server stops.`);
      return [200, job];
    }
    throw new HttpProblem(404, 'not_found', `Nothing at ${pathname}. See /openapi.json for the API.`);
  }

  async function handle(req, res) {
    const requestId = randomUUID();
    res.setHeader('X-Request-Id', requestId);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const send = (status, body, type = 'application/json') => { res.writeHead(status, { 'Content-Type': type }); res.end(JSON.stringify(body)); };
    const sendProblem = problem => {
      if (problem.challenge) res.setHeader('WWW-Authenticate', problem.challenge);
      if (problem.allow) res.setHeader('Allow', problem.allow);
      const { challenge, allow, ...body } = problem;
      send(body.status, body, 'application/problem+json');
    };
    try {
      // Host: only the loopback names this server listens on, so a rebinding DNS name can't reach it.
      if (!hosts.has((req.headers.host || '').toLowerCase())) throw new HttpProblem(403, 'forbidden', `Host ${req.headers.host || '(none)'} is not allowed. Use ${[...hosts][0] ? `http://${[...hosts][0]}` : 'the address printed at start'}.`);
      // Origin: websites can't call the API unless the user allowed that origin with --allow-origin.
      const origin = req.headers.origin;
      if (origin) {
        if (!origins.has(origin)) throw new HttpProblem(403, 'forbidden', `Requests from ${origin} are not allowed. Start the API with --allow-origin ${origin} to allow that website.`);
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Expose-Headers', 'Location, X-Request-Id');
        if (req.method === 'OPTIONS') {
          res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Max-Age': '600' });
          return res.end();
        }
      }
      const [status, body] = await route(req, res, requestId);
      if (status === null) sendProblem(body); else send(status, body);
    } catch (error) {
      if (error instanceof HttpProblem) sendProblem({ ...problemBody(error.status, error.code, error.message, requestId, error.extra.errors ? { errors: error.extra.errors } : {}), challenge: error.extra.challenge, allow: error.extra.allow });
      else { process.stderr.write(`superPDF API: ${error?.stack || error}\n`); sendProblem(problemBody(500, 'internal', 'The server failed unexpectedly. Details are in the terminal running superpdf serve.', requestId)); }
    }
  }

  const server = http.createServer((req, res) => { handle(req, res); });
  server.requestTimeout = 5 * 60 * 1000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const actual = server.address().port;
  hosts = new Set([`127.0.0.1:${actual}`, `localhost:${actual}`]);
  const url = `http://127.0.0.1:${actual}`;
  openapi.servers = [{ url, description: 'This superpdf serve process' }];
  return {
    url, port: actual, token, webhookSecret, jobs,
    async close() { webhooks.close(); server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); },
  };
}

const usage = `Usage: superpdf serve --allow-dir <folder> [--allow-dir <folder>] [--port ${DEFAULT_PORT}]
                      [--allow-origin <origin>] [--webhook-allow <origin>]

Starts the superPDF API on http://127.0.0.1:<port> (this computer only).
  --allow-dir       Folder the API may read and write. Repeat for more folders.
  --port            Port to listen on (default ${DEFAULT_PORT}; 0 picks a free one).
  --allow-origin    Website origin allowed to call the API from a browser.
  --webhook-allow   Origin allowed to receive job callbacks, besides localhost.
Environment:
  SUPERPDF_API_TOKEN       Use this bearer token (at least 32 characters) instead of a new one.
  SUPERPDF_WEBHOOK_SECRET  Use this secret to sign job callbacks instead of a new one.
`;

/** `superpdf serve`: start the API and print the address, token and webhook secret. */
export async function main(argv) {
  const options = parseAllowDirs(argv, 'serve', { port: { type: 'string' }, 'allow-origin': { type: 'string', multiple: true }, 'webhook-allow': { type: 'string', multiple: true } });
  if (options.help) { process.stdout.write(usage); return; }
  const port = options.port === undefined ? DEFAULT_PORT : Number(options.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`--port ${options.port} is not a port number (0–65535).`);
  const allowOrigins = (options['allow-origin'] || []).map(value => {
    try { return new URL(value).origin; } catch { throw new Error(`--allow-origin ${value} is not an origin such as http://localhost:5173.`); }
  });
  const envToken = process.env.SUPERPDF_API_TOKEN || undefined, envSecret = process.env.SUPERPDF_WEBHOOK_SECRET || undefined;
  if (envToken !== undefined && envToken.length < 32) throw new Error('SUPERPDF_API_TOKEN must be at least 32 characters.');
  const scope = await createScope(options.dirs);
  const api = await startApi({
    scope, port, allowOrigins, webhookAllow: parseAllowedOrigins(options['webhook-allow']),
    ...(envToken ? { token: envToken } : {}), ...(envSecret ? { webhookSecret: envSecret } : {}),
  }).catch(error => { throw error.code === 'EADDRINUSE' ? new Error(`Port ${port} is in use. Choose another with --port.`) : error; });
  process.stdout.write(`superPDF API ${version} listening on ${api.url} (this computer only)
Allowed folders: ${scope.describe()}
Token: ${envToken ? '(from SUPERPDF_API_TOKEN)' : api.token}
Webhook secret: ${envSecret ? '(from SUPERPDF_WEBHOOK_SECRET)' : api.webhookSecret}
OpenAPI: ${api.url}/openapi.json
Send the token as "Authorization: Bearer <token>". Press Ctrl+C to stop.
`);
  const stop = async () => { await api.close(); process.exit(0); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main(process.argv.slice(2)).catch(error => { process.stderr.write(`superPDF: ${error.message}\n`); process.exitCode = 1; });
}
