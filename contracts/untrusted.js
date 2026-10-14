// Text taken from a PDF (page text, metadata, bookmarks, form field names) is untrusted. Before it leaves
// superPDF (MCP results, HTTP API responses, job results, CLI output) it goes through cleanText(): control
// characters that a terminal would act on (ESC sequences, C1 controls such as CSI, backspace, bell) and
// bidirectional overrides and isolates that reorder what is displayed (U+202A–U+202E, U+2066–U+2069) are
// removed. Newlines and tabs are kept; a carriage return becomes a newline, so it can't overwrite a line.
const UNSAFE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F‪-‮⁦-⁩]/g;

/** `text` without terminal controls or bidi overrides (newlines and tabs kept). */
export const cleanText = text => String(text).replace(/\r\n?/g, '\n').replace(UNSAFE, '');

const plain = value => { const proto = Object.getPrototypeOf(value); return proto === Object.prototype || proto === null; };

/** A copy of a JSON-like value with every string (and object key) passed through cleanText. */
export function cleanValue(value) {
  if (typeof value === 'string') return cleanText(value);
  if (Array.isArray(value)) return value.map(cleanValue);
  if (value && typeof value === 'object' && plain(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [cleanText(key), cleanValue(item)]));
  return value;
}
