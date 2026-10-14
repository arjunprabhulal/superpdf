// PDF to audio with macOS's built-in voice (`say`), for the CLI (`superpdf audio`) and the Mac app.
// Node only: `npm run cli:build` copies this file to packages/cli/lib/, and the desktop app loads it from
// there. The text goes to `say` in a temporary file (never on the command line), the audio comes back as
// AAC in an .m4a file, and the temporary folder is deleted afterwards. Nothing leaves the computer.
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const SAY = '/usr/bin/say';
/** Words per minute for each speed; `normal` leaves the system's own rate. */
export const RATES = { slower: 150, normal: null, faster: 230 };
export const MAX_CHARACTERS = 2_000_000;
export const UNAVAILABLE = 'Saving as audio with the system voice needs macOS (it uses the built-in `say` command).';

/** Is `say` available here? (macOS only.) */
export async function sayAvailable({ platform = process.platform, path = SAY } = {}) {
  if (platform !== 'darwin') return false;
  try { await access(path); return true; } catch { return false; }
}

/** Parse `say -v '?'` output ("Eddy (German (Germany)) de_DE    # Hallo!") into [{name, locale}]. */
export function parseVoices(listing) {
  return String(listing).split('\n').map(line => line.match(/^(.+?)\s+([a-z]{2,3}_[A-Za-z0-9]+)\s+#/)).filter(Boolean).map(([, name, locale]) => ({ name: name.trim(), locale }));
}

/** Installed voices, from `say -v '?'`. */
export function sayVoices({ sayPath = SAY, spawnImpl = spawn } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(sayPath, ['-v', '?'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.on('error', reject);
    child.on('close', () => resolve(parseVoices(out)));
  });
}

/** The arguments `say` gets: read the text file, write AAC in an .m4a container, at the chosen rate and voice. */
export function sayArguments({ textFile, output, speed = 'normal', voice = '' }) {
  const args = ['-f', textFile, '-o', output, '--file-format=m4af', '--data-format=aac'];
  const rate = RATES[speed];
  if (rate) args.push('-r', String(rate));
  if (voice) args.push('-v', voice);
  return args;
}

/** Check text for `say`: plain text, not empty, within the limit. Returns a reason it's refused, or null. */
export function checkText(text) {
  if (typeof text !== 'string' || !text.trim()) return 'There is no text to read.';
  if (text.length > MAX_CHARACTERS) return `The text is too long to read in one go (${text.length.toLocaleString('en')} characters; the limit is ${MAX_CHARACTERS.toLocaleString('en')}). Choose fewer pages.`;
  return null;
}

/**
 * Speak `text` into an .m4a file and return its bytes. `voice`: a voice name from `say -v '?'` (empty for
 * the system voice). Aborting `signal` stops `say`. `spawnImpl` is injectable for tests.
 */
export async function sayToFile(text, { speed = 'normal', voice = '', signal, sayPath = SAY, spawnImpl = spawn } = {}) {
  const refused = checkText(text);
  if (refused) throw new Error(refused);
  // `say` quietly uses the default voice for a name it doesn't know, so check the name first.
  if (voice && !(await sayVoices({ sayPath, spawnImpl })).some(v => v.name.toLowerCase() === voice.toLowerCase())) throw new Error(`The voice “${voice.slice(0, 64)}” isn’t installed. List the voices with: say -v '?'`);
  const dir = await mkdtemp(join(tmpdir(), 'superpdf-say-'));
  try {
    const textFile = join(dir, 'text.txt'), output = join(dir, 'audio.m4a');
    await writeFile(textFile, text.replace(/\r\n?/g, '\n'), 'utf8');
    await new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(Object.assign(new Error('Stopped.'), { name: 'AbortError' })); return; }
      const child = spawnImpl(sayPath, sayArguments({ textFile, output, speed, voice }), { stdio: ['ignore', 'ignore', 'pipe'] });
      let errors = '';
      child.stderr?.on('data', chunk => { errors += chunk; });
      const stop = () => child.kill('SIGTERM');
      signal?.addEventListener('abort', stop, { once: true });
      child.on('error', error => { signal?.removeEventListener('abort', stop); reject(error); });
      child.on('close', code => {
        signal?.removeEventListener('abort', stop);
        if (signal?.aborted) reject(Object.assign(new Error('Stopped.'), { name: 'AbortError' }));
        else if (code === 0) resolve();
        else reject(new Error(`The system voice couldn’t record the text${errors.trim() ? `: ${errors.trim().slice(0, 200)}` : '.'}`));
      });
    });
    return new Uint8Array(await readFile(output));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Text to read from pdf-structure.js output: headings and paragraphs in order, hyphenated line breaks joined. */
export function readingText(structure) {
  return structure.pages.flatMap(page => page.blocks.map(block => block.text.replace(/(\p{Ll})- (?=\p{Ll})/gu, '$1').trim()).filter(Boolean)).join('\n\n');
}
