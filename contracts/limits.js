// How many tool calls run at once in one superPDF process (MCP server or local API, including its jobs).
// Every PDF tool takes a slot from `work`; pdf_from_office also takes one from `office` first, since each
// LibreOffice conversion is a separate heavyweight process. Calls beyond the limit wait their turn in
// order; when too many are already waiting, the call fails at once with BusyError (HTTP 429). Background jobs the
// API has already accepted (202) pass `wait: true`: they wait however long the queue is (the job queue bounds them).

/** Raised when a limit's queue is full. The API answers 429 `busy`; MCP returns the message as a tool error. */
export class BusyError extends Error {}

/** A counting semaphore with a bounded FIFO queue. `max` and `maxWaiting` can be changed (tests do). */
export function createLimit(name, { max, maxWaiting }) {
  const waiting = [];
  let active = 0;
  const limit = {
    name, max, maxWaiting,
    get active() { return active; },
    get waiting() { return waiting.length; },
    async run(fn, { wait = false } = {}) {
      if (active >= limit.max) {
        if (!wait && waiting.length >= limit.maxWaiting) throw new BusyError(`superPDF is busy: ${active} ${name} running and ${waiting.length} waiting. Try again when some have finished.`);
        await new Promise(resolve => waiting.push(resolve));
      } else active++;
      try { return await fn(); }
      finally {
        // Hand the slot straight to the next caller (active stays the same), or free it.
        const next = waiting.shift();
        if (next) next(); else active--;
      }
    },
  };
  return limit;
}

export const LIMITS = {
  work: createLimit('tool calls', { max: 4, maxWaiting: 64 }),
  office: createLimit('LibreOffice conversions', { max: 2, maxWaiting: 16 }),
};

/** The limits a contract's calls go through, outermost first. Listing files is cheap and never waits. */
export function limitsFor(contract) {
  if (contract.name === 'pdf_list_files') return [];
  return contract.name === 'pdf_from_office' ? [LIMITS.office, LIMITS.work] : [LIMITS.work];
}
