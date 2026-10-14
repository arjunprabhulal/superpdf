// Filesystem scope for the MCP server: the agent may only read and write inside the folders the user
// passed with --allow-dir. Paths are checked after resolving symlinks, outputs must be new files.
import { realpath, stat, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import { parseArgs } from 'node:util';

/** Expand a leading ~ (agents' JSON/TOML configs pass paths without a shell, so nothing else expands it). */
export const expandHome = value => typeof value === 'string' && /^~(?=$|[\\/])/.test(value) ? path.join(homedir(), value.slice(1)) : value;


/** An input problem the calling model can fix; reported as a tool error naming the field. */
export class InputError extends Error {
  constructor(field, message) { super(`${field}: ${message}`); this.field = field; this.reason = message; }
}
/** The output already exists. superPDF never overwrites, so the caller must pick a new name (HTTP 409). */
export class ConflictError extends InputError {}

/**
 * Parse a local server command's options: repeatable --allow-dir plus any extra options for that command.
 * Returns parseArgs values with `dirs` (the --allow-dir folders) and `help`.
 */
export function parseAllowDirs(argv, command, extra = {}) {
  let values;
  try {
    ({ values } = parseArgs({ args: argv, strict: true, allowPositionals: false, options: { 'allow-dir': { type: 'string', multiple: true }, help: { type: 'boolean', short: 'h' }, ...extra } }));
  } catch (error) { throw new Error(`${error.message.replace(/\. To specify.*$/s, '')} (superpdf ${command} --help lists the options)`); }
  return { ...values, dirs: values['allow-dir'] || [], help: !!values.help };
}

const inside = (root, target) => {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

export async function createScope(dirs) {
  if (!dirs?.length) throw new Error('Pass at least one --allow-dir folder. The server can only use files inside the folders you allow.');
  const roots = [];
  for (const dir of dirs) {
    let resolved;
    try { resolved = await realpath(path.resolve(expandHome(dir))); } catch { throw new Error(`--allow-dir ${dir} does not exist.`); }
    if (!(await stat(resolved)).isDirectory()) throw new Error(`--allow-dir ${dir} is not a folder.`);
    roots.push(resolved);
  }
  const resolve = value => path.resolve(roots[0], expandHome(value)); // relative paths are relative to the first folder
  const allowed = target => roots.some(root => inside(root, target));
  const describe = () => roots.join(', ');

  return {
    roots,
    describe,
    /** An existing PDF inside the allowed folders. */
    async input(value, field) {
      if (typeof value !== 'string' || !value.trim()) throw new InputError(field, 'give a file path.');
      let real;
      try { real = await realpath(resolve(value)); } catch { throw new InputError(field, `no file at ${value}. Use pdf_list_files to see available PDFs.`); }
      if (!allowed(real)) throw new InputError(field, `${value} is outside the allowed folders (${describe()}).`);
      const info = await stat(real);
      if (!info.isFile()) throw new InputError(field, `${value} is not a file.`);
      return real;
    },
    /** A new file path inside the allowed folders; the parent folder must exist and the file must not. */
    async output(value, field, extension = '.pdf') {
      if (typeof value !== 'string' || !value.trim()) throw new InputError(field, 'give a new file path.');
      const target = resolve(value);
      if (path.extname(target).toLowerCase() !== extension) throw new InputError(field, `use a file name ending in ${extension}.`);
      let parent;
      try { parent = await realpath(path.dirname(target)); } catch { throw new InputError(field, `the folder for ${value} does not exist.`); }
      const real = path.join(parent, path.basename(target));
      if (!allowed(real)) throw new InputError(field, `${value} is outside the allowed folders (${describe()}).`);
      try { await stat(real); throw new ConflictError(field, `${value} already exists. superPDF never overwrites files; choose a new name.`); }
      catch (error) { if (error instanceof InputError) throw error; }
      return real;
    },
    /**
     * An existing folder inside the allowed folders, checked after resolving symlinks (the folder itself, not
     * just its parent). With `create` (tools that write), a missing folder is created, one level only.
     */
    async folder(value, field, { create = false } = {}) {
      if (typeof value !== 'string' || !value.trim()) throw new InputError(field, 'give a folder path.');
      const target = resolve(value);
      const outside = () => new InputError(field, `${value} is outside the allowed folders (${describe()}).`);
      let real = await realpath(target).catch(() => null);
      if (!real) {
        if (!create) throw new InputError(field, `the folder ${value} does not exist.`);
        let parent;
        try { parent = await realpath(path.dirname(target)); } catch { throw new InputError(field, `the parent folder of ${value} does not exist.`); }
        if (!allowed(path.join(parent, path.basename(target)))) throw outside();
        await mkdir(path.join(parent, path.basename(target))).catch(error => { if (error.code !== 'EEXIST') throw error; });
        // Resolve again: whatever is there now (a dangling link, or one created meanwhile) must still be inside.
        try { real = await realpath(path.join(parent, path.basename(target))); } catch { throw new InputError(field, `the folder ${value} does not exist.`); }
      }
      if (!allowed(real)) throw outside();
      if (!(await stat(real)).isDirectory()) throw new InputError(field, `${value} is not a folder.`);
      return real;
    },
  };
}
