// In-memory background jobs for the local API. Jobs run one at a time in the order received, report
// progress, and are forgotten an hour after they finish (or when the server stops). A job's input is
// dropped as soon as it has run, so passwords are never kept or shown.
import { randomUUID } from 'node:crypto';

export const MAX_PENDING_JOBS = 100;
const MAX_KEPT_JOBS = 500;
const TTL_MS = 60 * 60 * 1000;

/** Raised when too many jobs are queued; the server answers 429. */
export class TooManyJobsError extends Error {}

/**
 * execute(tool, input, progress) → { value, files } runs one tool call.
 * toProblem(error, jobId) → an RFC 9457 problem object for a failed job.
 * webhooks (optional) delivers completion events to the job's callback_url.
 */
export function createJobQueue({ execute, toProblem, webhooks }) {
  const jobs = new Map(), queue = [], deliveries = new Set();
  let running = false;
  const now = () => new Date().toISOString();

  const view = job => ({
    id: job.id, tool: job.tool, status: job.status, progress: job.progress,
    created_at: job.created_at, started_at: job.started_at, finished_at: job.finished_at,
    ...(job.status === 'succeeded' ? { result: job.result } : {}),
    ...(job.error ? { error: job.error } : {}),
    ...(job.callback ? { callback: { ...job.callback } } : {}),
  });

  // A job whose callback is still being delivered is kept, so its delivery status can still be read.
  function prune() {
    const cutoff = Date.now() - TTL_MS;
    const done = job => job.finished_at && job.callback?.status !== 'delivering';
    for (const [id, job] of jobs) if (done(job) && Date.parse(job.finished_at) < cutoff) jobs.delete(id);
    const finished = [...jobs.values()].filter(done);
    for (const job of finished.slice(0, Math.max(0, jobs.size - MAX_KEPT_JOBS))) jobs.delete(job.id);
  }

  function notify(job) {
    const event = {
      type: `job.${job.status}`,
      timestamp: now(),
      data: {
        job_id: job.id, tool: job.tool, status: job.status, created_at: job.created_at, finished_at: job.finished_at,
        outputs: job.files || [],
        ...(job.error ? { error: { code: job.error.code, detail: job.error.detail } } : {}),
      },
    };
    job.callback.status = 'delivering';
    const delivery = webhooks.deliver(job.callback.url, event, (attempt, status) => { job.callback.attempts = attempt; job.callback.last_status = status; })
      .then(outcome => { job.callback.status = outcome.delivered ? 'delivered' : 'failed'; })
      .finally(() => deliveries.delete(delivery));
    deliveries.add(delivery);
  }

  async function run(job) {
    job.status = 'running'; job.started_at = now();
    try {
      const { value, files } = await execute(job.tool, job.input, (progress, total, message) => { job.progress = { progress, total, ...(message ? { message } : {}) }; });
      Object.assign(job, { status: 'succeeded', result: value, files });
    } catch (error) {
      Object.assign(job, { status: 'failed', error: toProblem(error, job.id) });
    }
    job.finished_at = now();
    delete job.input;
    if (job.callback) notify(job);
  }

  async function pump() {
    if (running) return;
    running = true;
    try { while (queue.length) await run(queue.shift()); }
    finally { running = false; }
  }

  return {
    /** Queue a validated tool call. callbackUrl must already be checked by webhooks.check(). */
    submit({ tool, input, callbackUrl }) {
      prune();
      if (queue.length + (running ? 1 : 0) >= MAX_PENDING_JOBS) throw new TooManyJobsError(`${MAX_PENDING_JOBS} jobs are already waiting. Try again when some have finished.`);
      const job = {
        id: `job_${randomUUID()}`, tool, input, status: 'queued', progress: null,
        created_at: now(), started_at: null, finished_at: null,
        ...(callbackUrl ? { callback: { url: callbackUrl, status: 'pending', attempts: 0, last_status: null } } : {}),
      };
      jobs.set(job.id, job);
      queue.push(job);
      pump();
      return view(job);
    },
    get(id) { prune(); const job = jobs.get(id); return job && view(job); },
    /** Newest first. */
    list() { prune(); return [...jobs.values()].reverse().map(view); },
    /** Resolves when the queue is empty and no callback is being delivered (used by tests and shutdown). */
    async idle() { while (running || queue.length || deliveries.size) await Promise.race([new Promise(r => setTimeout(r, 10)), ...deliveries]); },
  };
}
