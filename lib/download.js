// A PDF from an https:// link, for `superpdf export <link>` only: the MCP server, the API and `superpdf tool` read
// files inside their --allow-dir folders and never take links. Hosts on this computer or the local network are
// refused at every hop, checked on the addresses the connection actually uses (so a name that resolves differently
// the second time can't slip through), and the download goes to a temporary file that is always removed.
import { lookup as dnsLookup } from 'node:dns';
import { createWriteStream, rmSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const MAX_BYTES = 2e9; // 2 GB, as for a PDF read from disk (readFile's own limit is 2 GiB less a byte)
export const TIMEOUT_MS = 60_000; // without a byte from the server, while connecting or downloading
export const MAX_REDIRECTS = 5;

const fail = message => Object.assign(new Error(message), { plain: true });

/** A link rather than a path: a scheme of two or more letters (so C:\report.pdf stays a path) and a colon. */
export const isLink = input => /^[a-z][a-z\d+.-]+:/i.test(input);

// Addresses that aren't on the public internet: this computer, private and shared networks, link-local (cloud
// metadata at 169.254.169.254), documentation and benchmarking ranges, multicast and reserved.
const local = new BlockList();
for (const [net, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]]) local.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of [['::', 96], ['100::', 64], ['2001::', 32], ['2001:db8::', 32], ['64:ff9b:1::', 48], ['fc00::', 7],
  ['fe80::', 10], ['fec0::', 10], ['ff00::', 8]]) local.addSubnet(net, prefix, 'ipv6');

/** The IPv4 address inside an IPv4-mapped (::ffff:a.b.c.d), NAT64 (64:ff9b::/96) or 6to4 (2002::/16) address. */
function embeddedIpv4(address) {
  const words = expandIpv6(address);
  if (!words) return null;
  const v4 = (hi, lo) => [hi >> 8, hi & 255, lo >> 8, lo & 255].join('.');
  if (words.slice(0, 5).every(w => w === 0) && words[5] === 0xffff) return v4(words[6], words[7]);
  if (words[0] === 0x64 && words[1] === 0xff9b && words.slice(2, 6).every(w => w === 0)) return v4(words[6], words[7]);
  if (words[0] === 0x2002) return v4(words[1], words[2]);
  return null;
}

/** An IPv6 address as eight 16-bit numbers, with a trailing dotted IPv4 part and :: expanded. */
function expandIpv6(address) {
  let text = address.split('%')[0];
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number);
    text = `${text.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = text.split('::');
  const parse = part => (part ? part.split(':').map(w => parseInt(w, 16)) : []);
  const before = parse(head), after = tail === undefined ? [] : parse(tail);
  const words = [...before, ...Array(8 - before.length - after.length).fill(0), ...after];
  return words.length === 8 && words.every(w => w >= 0 && w <= 0xffff) ? words : null;
}

/** True for an address on the public internet; false for this computer, the local network and reserved ranges. */
export function isPublicAddress(address) {
  const family = isIP(address);
  if (family === 4) return !local.check(address, 'ipv4');
  if (family !== 6) return false;
  const v4 = embeddedIpv4(address);
  if (v4) return isPublicAddress(v4);
  return !local.check(address.split('%')[0], 'ipv6');
}

/**
 * A `lookup` for the connection that resolves the name and refuses it when any of its addresses is local, so the
 * address checked is the address connected to. Every address is checked, since Node may try each in turn.
 */
export function publicLookup(resolve = dnsLookup) {
  return (hostname, options, callback) => {
    resolve(hostname, { ...options, all: true }, (error, addresses) => {
      if (error) return callback(error);
      const blocked = addresses.find(a => !isPublicAddress(a.address));
      if (blocked) return callback(fail(`Links to this computer or the local network aren’t downloaded (${hostname} is ${blocked.address}).`));
      if (options?.all) callback(null, addresses);
      else callback(null, addresses[0].address, addresses[0].family);
    });
  };
}

/** The link as a URL, or a plain error for anything but an https:// link to a public host. */
export function checkLink(link, base) {
  let url;
  try { url = new URL(link, base); } catch { throw fail(`${link} isn’t a valid link.`); }
  if (url.protocol !== 'https:') {
    const scheme = url.protocol.slice(0, -1);
    throw fail(base ? `${base.hostname} redirected to a link that isn’t https:// (${scheme}:). Only https:// links are downloaded.`
      : scheme === 'file' ? 'Only https:// links are read. For a file on this computer, give its path instead of a file: link.'
      : `Only https:// links are read, not ${scheme}:. Use the https:// link, or download the PDF and give its path.`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) && !isPublicAddress(host)) throw fail(`Links to this computer or the local network aren’t downloaded (${host}).`);
  return url;
}

/** True when the first bytes are a PDF header. PDF readers allow a little junk before it, up to 1024 bytes. */
const isPdfStart = head => head.subarray(0, 1024).includes('%PDF-');

/**
 * Download an https:// link to a temporary file, check it's a PDF, and return its bytes. The temporary file is
 * removed when this returns or fails, and if the process is interrupted (Ctrl-C) during the download.
 * Messages name the host only: the rest of a link can carry a signed token.
 * @param {string} link
 * @param {{resolve?: Function, request?: Function, timeout?: number, maxBytes?: number, maxRedirects?: number}} options
 *   `resolve` (as dns.lookup) and `request` (as https.request) are replaced in tests.
 * @returns {Promise<Buffer>}
 */
export async function downloadPdf(link, { resolve = dnsLookup, request = httpsRequest, timeout = TIMEOUT_MS, maxBytes = MAX_BYTES, maxRedirects = MAX_REDIRECTS } = {}) {
  let url = checkLink(link);
  const dir = await mkdtemp(join(tmpdir(), 'superpdf-download-'));
  const interrupted = signal => { rmSync(dir, { recursive: true, force: true }); process.exit(signal === 'SIGINT' ? 130 : 143); };
  process.once('SIGINT', interrupted).once('SIGTERM', interrupted);
  try {
    const file = join(dir, 'download.pdf');
    for (let hops = 0; ; hops++) {
      const next = await fetchTo(file, url, { lookup: publicLookup(resolve), request, timeout, maxBytes });
      if (!next) break;
      if (hops >= maxRedirects) throw fail(`${url.hostname} redirected more than ${maxRedirects} times, so the download stopped.`);
      url = checkLink(next, url);
    }
    return await readFile(file);
  } finally {
    process.off('SIGINT', interrupted).off('SIGTERM', interrupted);
    await rm(dir, { recursive: true, force: true });
  }
}

/** One request: writes a PDF response to `file` and returns undefined, or returns the Location of a redirect. */
function fetchTo(file, url, { lookup, request, timeout, maxBytes }) {
  const host = url.hostname;
  return new Promise((resolve, reject) => {
    let response;
    const req = request({
      hostname: host.replace(/^\[|\]$/g, ''), port: url.port || undefined,
      path: `${url.pathname}${url.search}`, method: 'GET', lookup, agent: false,
      headers: { Accept: 'application/pdf, */*;q=0.5', 'User-Agent': 'superPDF (+https://github.com/arjunprabhulal/superpdf)' },
    }, async res => {
      response = res;
      try {
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
          res.destroy();
          if (!res.headers.location) throw fail(`${host} answered ${res.statusCode} without saying where to, so the download stopped.`);
          return resolve(res.headers.location);
        }
        if (res.statusCode < 200 || res.statusCode > 299) {
          res.destroy();
          throw fail(`${host} answered ${res.statusCode}${res.statusMessage ? ` ${res.statusMessage.slice(0, 60)}` : ''}, so there is no PDF to read.`);
        }
        const length = Number(res.headers['content-length']);
        if (length > maxBytes) { res.destroy(); throw tooLarge(host, maxBytes); }
        const type = (res.headers['content-type'] || '').split(';')[0].trim().slice(0, 80);
        await pipeline(res, checkPdf(host, type, maxBytes), createWriteStream(file, { flags: 'wx' }));
        resolve();
      } catch (error) { reject(error.plain ? error : fail(`The download from ${host} stopped (${error.code || error.message}).`)); }
    });
    // Without a byte for `timeout`, while connecting or mid-download, the request and the response stop.
    req.setTimeout(timeout, () => {
      const error = fail(`${host} sent nothing for ${timeout / 1000} seconds, so the download stopped.`);
      req.destroy(error); response?.destroy(error);
    });
    req.on('error', error => reject(error.plain ? error
      : error.code === 'ENOTFOUND' ? fail(`Couldn’t find ${host}. Check the link and your connection.`)
      : fail(`Couldn’t download from ${host} (${error.code || error.message}).`)));
    req.end();
  });
}

const tooLarge = (host, maxBytes) => fail(`The file at ${host} is larger than ${maxBytes >= 1e9 ? `${maxBytes / 1e9} GB` : `${maxBytes} bytes`}, superPDF’s limit.`);

/** Passes the bytes through, stopping at the size limit, or as soon as the first bytes show it isn't a PDF. */
function checkPdf(host, type, maxBytes) {
  let size = 0, head = Buffer.alloc(0), checked = false;
  const notPdf = () => fail(`The link isn’t a PDF: ${host} sent ${type || 'a file with no content type'}${/pdf/i.test(type) ? ' that doesn’t start like a PDF' : ''}.`);
  return new Transform({
    transform(chunk, _encoding, done) {
      size += chunk.length;
      if (size > maxBytes) return done(tooLarge(host, maxBytes));
      if (!checked) {
        head = Buffer.concat([head, chunk]);
        if (isPdfStart(head)) checked = true;
        else if (head.length >= 1024) return done(notPdf());
      }
      done(null, chunk);
    },
    flush(done) { done(checked ? null : notPdf()); },
  });
}
