// One classification for tool failures, used by both adapters: the MCP server returns `detail` as the
// tool error text, and the HTTP API returns it as an RFC 9457 problem with the matching status.
import { InputError, ConflictError } from '../mcp/scope.js';
import { BusyError } from './limits.js';
import { cleanText } from './untrusted.js';

/** Problem codes and their RFC 9457 titles. The type URI is `urn:superpdf:problem:<code>`. */
export const PROBLEM_TITLES = {
  bad_request: 'Malformed request',
  unauthorized: 'Authentication required',
  forbidden: 'Request not allowed',
  not_found: 'Resource not found',
  method_not_allowed: 'Method not allowed',
  conflict: 'Output already exists',
  payload_too_large: 'Request body too large',
  unsupported_media_type: 'Unsupported media type',
  validation: 'Invalid input',
  operation_failed: 'Operation failed',
  too_many_jobs: 'Too many jobs',
  busy: 'Too many tool calls',
  internal: 'Internal error',
};

/** { code, status, detail, errors? } for an error thrown by a contract's run(). Messages can quote the document, so they're cleaned. */
export function classify(error) {
  const { detail, errors, ...rest } = classifyRaw(error);
  return { ...rest, detail: cleanText(detail), ...(errors ? { errors: errors.map(e => ({ field: cleanText(e.field), message: cleanText(e.message) })) } : {}) };
}

function classifyRaw(error) {
  if (error instanceof BusyError) return { code: 'busy', status: 429, detail: error.message };
  if (error instanceof ConflictError) return { code: 'conflict', status: 409, detail: `Invalid input. ${error.message}`, errors: [{ field: error.field, message: error.reason }] };
  if (error instanceof InputError) return { code: 'validation', status: 422, detail: `Invalid input. ${error.message}`, errors: [{ field: error.field, message: error.reason }] };
  // A file appearing between the scope check and the write: the `wx` flag refuses to overwrite it.
  if (error?.code === 'EEXIST') return { code: 'conflict', status: 409, detail: 'Invalid input. output: that file already exists. Choose a new name.', errors: [{ field: 'output', message: 'that file already exists. Choose a new name.' }] };
  return { code: 'operation_failed', status: 422, detail: plainMessage(error) };
}

// Words that only appear in pdf-lib's, pdf.js's or qpdf's own errors, or in JavaScript engine errors.
const PDF_INTERNALS = /No PDF header|Failed to parse|Invalid PDF|InvalidPDFException|startxref|\bxref\b|trailer|Invalid object ref|Expected instance of|PDFDict|PDFRef|MissingCatalog|MissingPageContents|Unexpected end of (?:input|stream)|expected n n obj|can['’]t find PDF header|zero bytes/i;
const ENGINE_ERRORS = /Cannot read propert|Cannot set propert|is not a function|is not iterable|is not defined|undefined is not|null is not|reading '|Maximum call stack|Invalid array length/i;
export const PLAIN = {
  encrypted: 'This PDF needs a password to open. Remove the password first (pdf_unlock with the password, or Unlock PDF in superPDF), then try again.',
  unreadable: 'This file couldn’t be read as a PDF. It may be damaged, cut short or not a PDF. Try repairing it first.',
};

/**
 * A library's error turned into a sentence people can act on. superPDF's own messages pass through; a
 * library detail in brackets after one ("superPDF couldn’t protect this PDF (expected n n obj).") is dropped.
 */
export function plainMessage(error) {
  const message = String(error?.message || error || '');
  if (/is encrypted|No password given|PasswordException|password required/i.test(message)) return PLAIN.encrypted;
  const own = message.match(/^(.*?[A-Za-z0-9’])\s*\(([^()]*)\)\.?$/s);
  if (own && /^[A-Z]/.test(own[1]) && !PDF_INTERNALS.test(own[1]) && !ENGINE_ERRORS.test(own[1]) && (PDF_INTERNALS.test(own[2]) || ENGINE_ERRORS.test(own[2]) || /\bqpdf\b|can['’]t find|unable to find|object \d+ \d+|offset \d+|no pages found/i.test(own[2]))) return `${own[1]}.`;
  if (PDF_INTERNALS.test(message) || ENGINE_ERRORS.test(message) || ['TypeError', 'RangeError'].includes(error?.name)) return PLAIN.unreadable;
  return message || 'The operation failed.';
}
