// superpdf export <https link>: which links are refused, and downloads from a local test server. Nothing goes to the
// network: names resolve through a fake DNS, and every connection, once its address has passed the check, goes to
// the test server on 127.0.0.1.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { downloadPdf, isLink, isPublicAddress } from '../lib/download.js';

const run = promisify(execFile);
const BIN = fileURLToPath(new URL('../bin/superpdf.js', import.meta.url));
const cli = (args, cwd) => run(process.execPath, [BIN, ...args], { cwd });
const PDF = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n');

// The fake DNS: names with public addresses (never connected to) and names with local ones.
const DNS = {
  'files.test': ['93.184.215.14'],
  'cdn.test': ['2606:2800:21f:cb07:6820:80da:af6b:8b2c'],
  'intranet.test': ['10.0.0.8'],
  'metadata.test': ['169.254.169.254'],
  'mixed.test': ['93.184.215.14', '127.0.0.1'],
};
const resolve = (hostname, options, callback) => {
  const addresses = DNS[hostname];
  if (!addresses) return callback(Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' }));
  callback(null, addresses.map(address => ({ address, family: address.includes(':') ? 6 : 4 })));
};

/** A test server, and a `request` that connects to it after the connection's own lookup has checked the address. */
async function testServer(handler) {
  const hits = [];
  const server = createServer((req, res) => { hits.push(`${req.headers.host.replace(/:\d+$/, '')}${req.url}`); handler(req, res); });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const { port } = server.address();
  const request = (options, onResponse) => httpRequest({
    ...options, agent: undefined,
    createConnection: (_options, created) => options.lookup(options.hostname, {}, error => (error ? created(error) : created(null, connect(port, '127.0.0.1')))),
  }, onResponse);
  return { hits, request, close: () => new Promise(done => { server.closeAllConnections(); server.close(done); }) };
}

const downloads = async () => (await readdir(tmpdir())).filter(name => name.startsWith('superpdf-download-'));

test('only https:// links count, and addresses on this computer or the local network are refused', () => {
  for (const link of ['https://example.com/a.pdf', 'http://example.com/a.pdf', 'file:///etc/hosts', 'data:application/pdf,x']) assert.ok(isLink(link), link);
  for (const path of ['report.pdf', './a:b.pdf', 'C:\\Users\\me\\report.pdf', 'C:/report.pdf']) assert.ok(!isLink(path), path);
  for (const address of ['93.184.215.14', '8.8.8.8', '2606:4700::1111', '::ffff:8.8.8.8']) assert.ok(isPublicAddress(address), address);
  for (const address of ['127.0.0.1', '127.1.2.3', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254',
    '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255', '::', '::1', 'fe80::1', 'fe80::1%en0', 'fd00::1', 'fc00::1', 'ff02::1',
    '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '64:ff9b::a00:1', '2002:c0a8:101::1', 'not an address']) assert.ok(!isPublicAddress(address), address);
});

test('export refuses other schemes and local hosts before connecting, and other commands refuse links', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'superpdf-test-'));
  for (const [link, message] of [
    ['http://example.com/a.pdf', /Only https:\/\/ links are read, not http:/],
    ['file:///etc/hosts', /give its path instead of a file: link/],
    ['data:application/pdf,%PDF-1.7', /not data:/],
    ['ftp://example.com/a.pdf', /not ftp:/],
    ['https://127.0.0.1/a.pdf', /local network aren’t downloaded \(127\.0\.0\.1\)/],
    ['https://[::1]/a.pdf', /local network aren’t downloaded \(::1\)/],
    ['https://169.254.169.254/latest/meta-data/', /local network aren’t downloaded/],
    ['https://[::ffff:192.168.0.1]/a.pdf', /local network aren’t downloaded/],
    ['https://0x7f000001/a.pdf', /local network aren’t downloaded \(127\.0\.0\.1\)/],
  ]) await assert.rejects(cli(['export', link, '--output', 'out.md'], dir), message, link);
  await assert.rejects(cli(['info', 'https://example.com/a.pdf'], dir), /Only superpdf export reads https:\/\/ links/);
  assert.match((await cli(['help'])).stdout, /export also reads https:\/\/ links: up to 2 GB/);
  // The existing output is caught before anything is downloaded.
  await writeFile(join(dir, 'taken.md'), 'mine');
  await assert.rejects(cli(['export', 'https://example.com/a.pdf', '--output', 'taken.md'], dir), /Output already exists/);
});

test('a PDF is downloaded to a temporary file that is removed afterwards', async () => {
  const server = await testServer((req, res) => {
    if (req.url === '/moved') { res.writeHead(302, { Location: '/report.pdf' }); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'application/pdf' }); res.end(PDF);
  });
  try {
    const before = await downloads();
    assert.deepEqual(await downloadPdf('https://files.test/moved', { resolve, request: server.request }), PDF);
    assert.deepEqual(await downloadPdf('https://cdn.test/report.pdf', { resolve, request: server.request }), PDF);
    assert.deepEqual(server.hits, ['files.test/moved', 'files.test/report.pdf', 'cdn.test/report.pdf']);
    assert.deepEqual(await downloads(), before);
  } finally { await server.close(); }
});

test('a name that resolves to a local address is refused, including after a redirect', async () => {
  const server = await testServer((req, res) => {
    const to = { '/to-intranet': 'https://intranet.test/a.pdf', '/to-loopback': 'https://127.0.0.1/a.pdf', '/to-ipv6': 'https://[fd00::1]/a.pdf',
      '/to-http': 'http://files.test/a.pdf', '/to-metadata': 'https://metadata.test/latest/', '/loop': '/loop' }[req.url];
    if (to) { res.writeHead(301, { Location: to }); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'application/pdf' }); res.end(PDF);
  });
  const get = (link, options) => downloadPdf(link, { resolve, request: server.request, ...options });
  try {
    const before = await downloads();
    await assert.rejects(get('https://intranet.test/a.pdf'), /local network aren’t downloaded \(intranet\.test is 10\.0\.0\.8\)/);
    await assert.rejects(get('https://mixed.test/a.pdf'), /mixed\.test is 127\.0\.0\.1/);
    await assert.rejects(get('https://files.test/to-intranet'), /intranet\.test is 10\.0\.0\.8/);
    await assert.rejects(get('https://files.test/to-metadata'), /metadata\.test is 169\.254\.169\.254/);
    await assert.rejects(get('https://files.test/to-loopback'), /local network aren’t downloaded \(127\.0\.0\.1\)/);
    await assert.rejects(get('https://files.test/to-ipv6'), /local network aren’t downloaded \(fd00::1\)/);
    await assert.rejects(get('https://files.test/to-http'), /files\.test redirected to a link that isn’t https:\/\/ \(http:\)/);
    await assert.rejects(get('https://files.test/loop'), /redirected more than 5 times/);
    await assert.rejects(get('https://nowhere.test/a.pdf'), /Couldn’t find nowhere\.test/);
    // Only the public hops reached the server; the local ones were refused before connecting.
    assert.ok(server.hits.every(hit => hit.startsWith('files.test/')), server.hits.join(', '));
    assert.deepEqual(await downloads(), before);
  } finally { await server.close(); }
});

test('a download that isn’t a PDF, is too large or stalls stops with a plain message', async () => {
  const server = await testServer((req, res) => {
    if (req.url === '/page') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end('<!doctype html><title>Sign in</title>'); }
    if (req.url === '/fake.pdf') { res.writeHead(200, { 'Content-Type': 'application/pdf' }); return res.end(Buffer.alloc(4096, 'x')); }
    if (req.url === '/missing') { res.writeHead(404); return res.end(); }
    if (req.url === '/big-declared') { res.writeHead(200, { 'Content-Length': '5000' }); return res.end(Buffer.concat([PDF, Buffer.alloc(5000 - PDF.length)])); }
    if (req.url === '/big') { res.writeHead(200); res.write(PDF); return res.end(Buffer.alloc(5000)); }
    if (req.url === '/cut') { res.writeHead(200, { 'Content-Length': '5000' }); res.write(PDF); return setTimeout(() => res.socket.destroy(), 20); }
    if (req.url === '/stall') { res.writeHead(200, { 'Content-Type': 'application/pdf' }); return res.write(PDF); }
  });
  const get = (link, options) => downloadPdf(link, { resolve, request: server.request, ...options });
  try {
    const before = await downloads();
    await assert.rejects(get('https://files.test/page'), /The link isn’t a PDF: files\.test sent text\/html\./);
    await assert.rejects(get('https://files.test/fake.pdf'), /files\.test sent application\/pdf that doesn’t start like a PDF/);
    await assert.rejects(get('https://files.test/missing'), /files\.test answered 404 Not Found/);
    await assert.rejects(get('https://files.test/big-declared', { maxBytes: 1000 }), /larger than 1000 bytes/);
    await assert.rejects(get('https://files.test/big', { maxBytes: 1000 }), /larger than 1000 bytes/);
    await assert.rejects(get('https://files.test/cut'), /The download from files\.test stopped/);
    await assert.rejects(get('https://files.test/stall', { timeout: 300 }), /files\.test sent nothing for 0\.3 seconds, so the download stopped/);
    assert.deepEqual(await downloads(), before);
  } finally { await server.close(); }
});
