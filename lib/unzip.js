// Reading zip archives that come from people (Office documents, EPUB): limits on the number of entries, on
// each entry's size and on the total, so a small file that expands to gigabytes (a "zip bomb") fails with a
// clear message instead of filling memory. Entries are read from the central directory and inflated in
// chunks with fflate; the sizes are counted from the actual output, so an entry that claims to be small
// but keeps expanding is stopped as soon as it passes its declared size. No DOM, so it runs in Node too.
import { Inflate, strFromU8 } from 'fflate';

export const ZIP_LIMITS = { entries: 10_000, entrySize: 100 * 2 ** 20, totalSize: 150 * 2 ** 20 };

/** A zip that breaks a limit. Its message is meant for people, so callers pass it on unchanged. */
export class ZipLimitError extends Error {}

const u16 = (b, i) => b[i] | b[i + 1] << 8;
const u32 = (b, i) => (b[i] | b[i + 1] << 8 | b[i + 2] << 16 | b[i + 3] << 24) >>> 0;
const u64 = (b, i) => u32(b, i) + u32(b, i + 4) * 2 ** 32;
const megabytes = n => `${Math.round(n / 2 ** 20)} MB`;
const CHUNK = 1 << 20;

/**
 * Unzip `bytes` into a Map of entry name → Uint8Array (directories included, empty), in central-directory order.
 * Throws ZipLimitError when a limit is passed and a plain Error when the archive is damaged or unsupported.
 */
export function unzipLimited(bytes, { entries: maxEntries = ZIP_LIMITS.entries, entrySize = ZIP_LIMITS.entrySize, totalSize = ZIP_LIMITS.totalSize } = {}) {
  const damaged = () => new Error('The zip archive is damaged.');
  // Every offset read from the archive is checked against its length before it is used.
  const need = (at, length) => { if (!(at >= 0 && at + length <= bytes.length)) throw damaged(); };
  // End of central directory: the last record, before a comment of up to 65,535 bytes.
  let end = bytes.length - 22;
  while (end >= 0 && u32(bytes, end) !== 0x06054b50) { if (bytes.length - end > 65_557) end = -1; else end--; }
  if (end < 0) throw new Error('This is not a zip archive.');
  need(end + 22, u16(bytes, end + 20)); // the comment
  let count = u16(bytes, end + 10), at = u32(bytes, end + 16);
  if (end >= 20 && u32(bytes, end - 20) === 0x07064b50) { // ZIP64
    const z = u64(bytes, end - 12);
    need(z, 56);
    if (u32(bytes, z) === 0x06064b50) { count = u64(bytes, z + 32); at = u64(bytes, z + 48); }
  }
  if (count > maxEntries) throw new ZipLimitError(`It contains more than ${maxEntries.toLocaleString('en-US')} files.`);

  const files = new Map();
  let total = 0;
  for (let n = 0; n < count; n++) {
    need(at, 46);
    if (u32(bytes, at) !== 0x02014b50) throw damaged();
    const flags = u16(bytes, at + 8), method = u16(bytes, at + 10), nameLength = u16(bytes, at + 28), extraLength = u16(bytes, at + 30);
    let packed = u32(bytes, at + 20), size = u32(bytes, at + 24), local = u32(bytes, at + 42);
    need(at + 46, nameLength + extraLength + u16(bytes, at + 32));
    const name = strFromU8(bytes.subarray(at + 46, at + 46 + nameLength), !(flags & 2048));
    // ZIP64 extra field: the 64-bit values for the fields set to 0xFFFFFFFF, in this order.
    const extraEnd = at + 46 + nameLength + extraLength;
    for (let e = at + 46 + nameLength; e + 4 <= extraEnd; e += 4 + u16(bytes, e + 2)) {
      if (u16(bytes, e) !== 1) continue;
      let f = e + 4;
      const field = () => { if (f + 8 > extraEnd) throw damaged(); f += 8; return u64(bytes, f - 8); };
      if (size === 0xffffffff) size = field();
      if (packed === 0xffffffff) packed = field();
      if (local === 0xffffffff) local = field();
    }
    at = extraEnd + u16(bytes, at + 32);
    if (flags & 1) throw new Error('The zip archive is password-protected.');
    if (size > entrySize) throw new ZipLimitError(`“${name}” inside it would expand to ${megabytes(size)}; the limit is ${megabytes(entrySize)}.`);
    if (total + size > totalSize) throw new ZipLimitError(`Its contents would expand to more than ${megabytes(totalSize)}.`);
    need(local, 30);
    if (u32(bytes, local) !== 0x04034b50) throw damaged();
    const start = local + 30 + u16(bytes, local + 26) + u16(bytes, local + 28);
    need(start, packed);
    const data = bytes.subarray(start, start + packed);
    let file;
    if (method === 0) { if (packed !== size) throw damaged(); file = data.slice(); }
    else if (method === 8) file = inflate(data, size, name);
    else throw new Error(`“${name}” uses a compression method superPDF can’t read.`);
    files.set(name, file);
    total += file.length;
  }
  return files;
}

/**
 * Inflate one entry, stopping as soon as the output passes the size its header declares. Memory grows with
 * the actual output, never with the declared size, and the result has no larger buffer behind it.
 */
function inflate(data, size, name) {
  const chunks = [];
  let length = 0;
  const inflater = new Inflate(chunk => {
    if (length + chunk.length > size) throw new ZipLimitError(`“${name}” inside it expands to more than its declared size.`);
    chunks.push(chunk);
    length += chunk.length;
  });
  if (!data.length) inflater.push(data, true);
  for (let i = 0; i < data.length; i += CHUNK) inflater.push(data.subarray(i, i + CHUNK), i + CHUNK >= data.length);
  if (chunks.length === 1 && chunks[0].byteLength === chunks[0].buffer.byteLength) return chunks[0];
  const out = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) { out.set(chunk, at); at += chunk.length; }
  return out;
}
