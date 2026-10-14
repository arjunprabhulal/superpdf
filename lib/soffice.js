// Office to PDF with LibreOffice installed on this computer (Node only: the CLI, the MCP server, the local HTTP
// API and the desktop app's main process). The website never loads this; it uses the in-browser converter in
// ./office/. `npm run cli:build` copies this file into packages/cli/lib/.
//
// Each conversion runs `soffice --headless` with a throwaway user profile in a new temporary folder, so it neither
// touches nor waits for the user's own LibreOffice session, and the folder is deleted afterwards.
import { spawn as nodeSpawn } from 'node:child_process';
import { access, constants, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// LibreOffice settings for every conversion: no macros, and never load linked content (images, sections, OLE)
// from outside the document, so a file can neither call a web address nor pull in a file from this computer.
const item = (path, prop, type, value) => `<item oor:path="${path}"><prop oor:name="${prop}" oor:op="fuse"><value>${value}</value></prop></item>`;
export const XCU = `<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
${item('/org.openoffice.Office.Common/Security/Scripting', 'BlockUntrustedRefererLinks', 'xs:boolean', 'true')}
${item('/org.openoffice.Office.Common/Security/Scripting', 'MacroSecurityLevel', 'xs:int', '3')}
${item('/org.openoffice.Office.Common/Security/Scripting', 'DisableMacrosExecution', 'xs:boolean', 'true')}
${item('/org.openoffice.Office.Writer/Content/Update', 'Link', 'xs:int', '2')}
${item('/org.openoffice.Office.Calc/Content/Update', 'Link', 'xs:int', '2')}
${item('/org.openoffice.Office.Impress/Content/Update', 'Link', 'xs:int', '2')}
</oor:items>
`;
export const OFFICE_EXTENSIONS = ['.docx', '.xlsx', '.pptx', '.odt', '.ods', '.odp'];
export const TIMEOUT_MS = 120_000;
export const INSTALL_HINT = 'LibreOffice isn’t installed. Install it with `brew install --cask libreoffice` (or from libreoffice.org), then try again.';

const executable = async file => { try { await access(file, constants.X_OK); return true; } catch { return false; } };

/** Places LibreOffice is looked for, in order: $SUPERPDF_SOFFICE, each PATH folder, then the macOS app bundles. */
export function sofficeCandidates({ env = process.env, platform = process.platform, home = homedir() } = {}) {
  if (env.SUPERPDF_SOFFICE !== undefined) return env.SUPERPDF_SOFFICE ? [env.SUPERPDF_SOFFICE] : []; // explicit path; empty turns it off
  const names = platform === 'win32' ? ['soffice.exe', 'soffice.com'] : ['soffice'];
  const list = (env.PATH || '').split(path.delimiter).filter(Boolean).flatMap(dir => names.map(name => path.join(dir, name)));
  if (platform === 'darwin') list.push('/Applications/LibreOffice.app/Contents/MacOS/soffice', path.join(home, 'Applications/LibreOffice.app/Contents/MacOS/soffice'));
  return list;
}

/** Path to LibreOffice's soffice, or null when it isn't installed. */
export async function findSoffice(options = {}) {
  const exists = options.exists || executable;
  for (const candidate of sofficeCandidates(options)) if (await exists(candidate)) return candidate;
  return null;
}

/** Command-line arguments for one headless conversion of `input` into `outdir`. */
export function sofficeArgs({ input, outdir, profile }) {
  return [`-env:UserInstallation=${pathToFileURL(profile).href}`, '--headless', '--norestore', '--nologo', '--nodefault', '--nolockcheck', '--convert-to', 'pdf', '--outdir', outdir, input];
}

/** The lower-case extension if it's one LibreOffice is used for here, otherwise an Error to throw. */
export function officeExtension(fileName) {
  const ext = path.extname(String(fileName || '')).toLowerCase();
  if (!OFFICE_EXTENSIONS.includes(ext)) throw new Error(`Choose a ${OFFICE_EXTENSIONS.join(', ')} file.`);
  return ext;
}

/**
 * Convert Office file bytes to PDF bytes with LibreOffice.
 * options: soffice (path; found when omitted), timeoutMs, spawn (for tests).
 * Throws an Error with a plain message when LibreOffice is missing, times out or produces nothing.
 */
export async function convertWithSoffice(bytes, fileName, { soffice, timeoutMs = TIMEOUT_MS, spawn = nodeSpawn } = {}) {
  const ext = officeExtension(fileName);
  if (!bytes?.length) throw new Error('The file is empty.');
  soffice ??= await findSoffice();
  if (!soffice) throw new Error(INSTALL_HINT);
  const dir = await mkdtemp(path.join(tmpdir(), 'superpdf-office-'));
  try {
    // A fixed input name keeps the user's file name out of the command line.
    const input = path.join(dir, `input${ext}`), outdir = path.join(dir, 'out'), profile = path.join(dir, 'lo-profile');
    await writeFile(input, bytes);
    // Hardened profile: never load linked content (images, sections, OLE) from outside the document.
    await mkdir(path.join(profile, 'user'), { recursive: true });
    await writeFile(path.join(profile, 'user', 'registrymodifications.xcu'), XCU);
    const { code, stderr, timedOut } = await new Promise((resolve, reject) => {
      // soffice is a launcher that starts soffice.bin, which inherits stderr. Run it in its own process group
      // (not on Windows) so a timeout can kill the whole tree; killing only the launcher would leave
      // soffice.bin running and holding stderr open, so 'close' would never fire.
      const detached = process.platform !== 'win32';
      const child = spawn(soffice, sofficeArgs({ input, outdir, profile }), { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, HOME: process.env.HOME || dir }, detached });
      let err = '', timedOut = false, settled = false;
      const settle = (fn, value) => { if (settled) return; settled = true; clearTimeout(timer); fn(value); };
      child.stderr?.on('data', chunk => { if (err.length < 4000) err += chunk; });
      const timer = setTimeout(() => {
        timedOut = true;
        try { if (detached && child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); }
        catch { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
        child.stderr?.destroy?.();
      }, timeoutMs);
      child.on('error', error => settle(reject, error.code === 'ENOENT' ? new Error(INSTALL_HINT) : error));
      // After a timeout, settle as soon as the launcher exits instead of waiting for stdio to close.
      child.on('exit', code => { if (timedOut) settle(resolve, { code, stderr: err, timedOut }); });
      child.on('close', code => settle(resolve, { code, stderr: err, timedOut }));
    });
    if (timedOut) throw new Error(`LibreOffice didn’t finish within ${Math.round(timeoutMs / 1000)} seconds, so the conversion was stopped.`);
    let pdf;
    try { pdf = new Uint8Array(await readFile(path.join(outdir, 'input.pdf'))); } catch {
      const detail = stderr.trim().split('\n').filter(line => !/^(warn|javaldx)/i.test(line)).slice(-1)[0];
      throw new Error(`LibreOffice couldn’t convert this file${code ? ` (exit code ${code})` : ''}. It may be damaged or password-protected.${detail ? ` LibreOffice said: ${detail.slice(0, 200)}` : ''}`);
    }
    if (pdf[0] !== 0x25 || pdf[1] !== 0x50) throw new Error('LibreOffice didn’t produce a PDF.');
    return pdf;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
