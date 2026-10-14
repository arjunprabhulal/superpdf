// Zod schemas for the local HTTP API's own resources: problems, jobs, webhook events and the tool list.
// The server validates with them and scripts/openapi.js documents them, alongside the tool contracts.
import * as z from 'zod';
import { contracts } from '../contracts/tools.js';
import { PROBLEM_TITLES } from '../contracts/errors.js';

export const problem = z.object({
  type: z.string().describe('Stable problem type URI: urn:superpdf:problem:<code>.'),
  title: z.string(),
  status: z.number().int().min(400).max(599),
  detail: z.string().describe('What went wrong and how to fix it.'),
  instance: z.string().describe('URN for this problem occurrence.'),
  code: z.enum(Object.keys(PROBLEM_TITLES)),
  request_id: z.string(),
  errors: z.array(z.object({ field: z.string(), message: z.string() })).optional().describe('The fields to fix, for validation and conflict problems.'),
}).describe('RFC 9457 Problem Details.');

const timestamp = z.string().describe('ISO 8601 time.');
const progress = z.object({ progress: z.number(), total: z.number(), message: z.string().optional() });

export const callbackUrl = z.string().max(2048).describe('Where to POST a signed event when the job finishes. Loopback addresses (127.0.0.1, localhost, [::1]) are allowed by default; other origins only when the API was started with --webhook-allow <origin>.');

/** POST /v1/jobs body: one variant per tool, so each tool's input schema is checked and documented. */
export const jobRequest = z.discriminatedUnion('tool', contracts.map(c => z.object({
  tool: z.literal(c.name),
  input: c.input,
  callback_url: callbackUrl.optional(),
}))).describe('A tool call to run in the background.');

export const job = z.object({
  id: z.string(),
  tool: z.string(),
  status: z.enum(['queued', 'running', 'succeeded', 'failed']),
  progress: progress.nullable().describe('Latest progress from tools that report it (merge, split, pipelines, batches).'),
  created_at: timestamp,
  started_at: timestamp.nullable(),
  finished_at: timestamp.nullable(),
  result: z.unknown().optional().describe('Once succeeded: the same result POST /v1/tools/{tool} returns.'),
  error: problem.optional().describe('Once failed: why.'),
  callback: z.object({
    url: z.string(),
    status: z.enum(['pending', 'delivering', 'delivered', 'failed']),
    attempts: z.number().int(),
    last_status: z.number().int().nullable().describe('HTTP status of the last attempt; null when the receiver could not be reached.'),
  }).optional(),
});

export const jobList = z.object({ jobs: z.array(job) });

export const webhookEvent = z.object({
  type: z.enum(['job.succeeded', 'job.failed']),
  timestamp,
  data: z.object({
    job_id: z.string(),
    tool: z.string(),
    status: z.enum(['succeeded', 'failed']),
    created_at: timestamp,
    finished_at: timestamp,
    outputs: z.array(z.string()).describe('Paths of the files the job wrote. Document contents are never included; fetch the job for its result.'),
    error: z.object({ code: z.string(), detail: z.string() }).optional(),
  }),
}).describe('Sent as JSON with webhook-id, webhook-timestamp and webhook-signature headers (Standard Webhooks: v1, HMAC-SHA256 of "<id>.<timestamp>.<body>").');

export const toolList = z.object({
  tools: z.array(z.object({
    name: z.string(),
    title: z.string(),
    description: z.string(),
    reports_progress: z.boolean(),
    annotations: z.record(z.string(), z.boolean()),
  })),
});

/** Zod issues → [{ field, message }], with fields written as in tool errors: inputs[0], input.pages. */
export function issuesToErrors(issues) {
  return issues.map(issue => ({
    field: issue.path.map((part, i) => typeof part === 'number' ? `[${part}]` : i ? `.${String(part)}` : String(part)).join('') || '(body)',
    message: issue.message,
  }));
}
