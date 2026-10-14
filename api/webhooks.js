// Job completion callbacks for the local API. Events go only to loopback addresses unless the user
// allows another origin with --webhook-allow. Payloads are signed in the Standard Webhooks format
// (webhook-id, webhook-timestamp, webhook-signature: v1,<base64 HMAC-SHA256 of "id.timestamp.body">)
// and retried with exponential backoff. Redirects are never followed.
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { InputError } from '../mcp/scope.js';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** A new random secret, `whsec_` + base64 of 32 bytes (the key is the decoded bytes). */
export const newSecret = () => `whsec_${randomBytes(32).toString('base64')}`;
const keyBytes = secret => secret.startsWith('whsec_') ? Buffer.from(secret.slice(6), 'base64') : Buffer.from(secret, 'utf8');

export function sign(secret, id, timestamp, body) {
  return `v1,${createHmac('sha256', keyBytes(secret)).update(`${id}.${timestamp}.${body}`).digest('base64')}`;
}

/** Check a received event: signature over the raw body, and a timestamp within `toleranceSeconds`. */
export function verify(secret, headers, body, { toleranceSeconds = 300, now = Date.now() } = {}) {
  const id = headers['webhook-id'], timestamp = Number(headers['webhook-timestamp']), given = headers['webhook-signature'] || '';
  if (!id || !Number.isFinite(timestamp) || Math.abs(now / 1000 - timestamp) > toleranceSeconds) return false;
  const expected = Buffer.from(sign(secret, id, timestamp, body));
  return given.split(' ').some(candidate => {
    const actual = Buffer.from(candidate);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  });
}

/** Normalise --webhook-allow values to origins, rejecting anything that isn't an http(s) origin. */
export function parseAllowedOrigins(values = []) {
  return values.map(value => {
    let url;
    try { url = new URL(value); } catch { throw new Error(`--webhook-allow ${value} is not a URL. Use an origin such as https://hooks.example.com.`); }
    if (!/^https?:$/.test(url.protocol)) throw new Error(`--webhook-allow ${value} must use http or https.`);
    return url.origin;
  });
}

export function createWebhooks({ allow = [], secret, userAgent = 'superPDF', attempts = 5, backoffMs = 1000, timeoutMs = 10_000 }) {
  const allowed = new Set(allow);
  const closing = new AbortController();
  return {
    /** The callback URL if it may receive events; otherwise an InputError on callback_url. */
    check(value) {
      let url;
      try { url = new URL(value); } catch { throw new InputError('callback_url', 'use an absolute http or https URL.'); }
      if (!/^https?:$/.test(url.protocol)) throw new InputError('callback_url', 'use an http or https URL.');
      if (url.username || url.password) throw new InputError('callback_url', 'leave credentials out of the URL; check the webhook-signature header instead.');
      if (LOOPBACK.has(url.hostname) || allowed.has(url.origin)) return url.href;
      throw new InputError('callback_url', `${url.origin} isn't allowed. Events go to this computer (localhost) unless the API is started with --webhook-allow ${url.origin}.`);
    },
    /**
     * POST one event, retrying on network errors, timeouts, 408, 429 and 5xx: up to `attempts` tries,
     * waiting backoffMs, 2×, 4×… between them. Other statuses (including redirects) stop at once.
     */
    async deliver(url, event, onAttempt = () => {}) {
      const id = `msg_${randomUUID()}`, body = JSON.stringify(event);
      let status = null;
      for (let attempt = 1; attempt <= attempts; attempt++) {
        const timestamp = Math.floor(Date.now() / 1000);
        let retry = true;
        status = null;
        try {
          const response = await fetch(url, {
            method: 'POST', body, redirect: 'manual',
            signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), closing.signal]),
            headers: { 'content-type': 'application/json', 'user-agent': userAgent, 'webhook-id': id, 'webhook-timestamp': String(timestamp), 'webhook-signature': sign(secret, id, timestamp, body) },
          });
          status = response.status;
          await response.body?.cancel().catch(() => {});
          if (status >= 200 && status < 300) { onAttempt(attempt, status); return { delivered: true, attempts: attempt, status }; }
          retry = status === 408 || status === 429 || status >= 500;
        } catch { /* unreachable or timed out: retry */ }
        onAttempt(attempt, status);
        if (closing.signal.aborted || !retry || attempt === attempts) return { delivered: false, attempts: attempt, status };
        try { await sleep(backoffMs * 2 ** (attempt - 1), undefined, { signal: closing.signal }); }
        catch { return { delivered: false, attempts: attempt, status }; }
      }
      return { delivered: false, attempts, status };
    },
    close() { closing.abort(); },
  };
}
