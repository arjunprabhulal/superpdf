// Build the Claude Desktop extension: dist/superpdf-<version>.mcpb, an MCP Bundle (https://github.com/modelcontextprotocol/mcpb)
// that installs the superPDF MCP server with a double-click. `npm run mcpb` stages the published package files with
// production dependencies only, writes manifest.json from package.json and the tool contracts (so the version and the
// 30 tools never drift), and packs it with the mcpb CLI. The user picks the allowed folders in Claude Desktop's settings.
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { contracts } from '../contracts/tools.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MCPB_CLI = '@anthropic-ai/mcpb@2.1.2';

/** manifest.json for the bundle (MCPB manifest spec 0.3). */
export function manifest(pkg) {
  return {
    manifest_version: '0.3',
    name: 'superpdf',
    display_name: 'superPDF AI',
    version: pkg.version,
    description: 'Read, convert, edit and compare PDFs on your computer. Nothing is uploaded.',
    long_description: [
      'superPDF gives Claude 30 PDF tools that run on your computer: read PDFs as Markdown with tables, charts and OCR for scans,',
      'convert to Word, PowerPoint and EPUB, extract tables to Excel, fill forms, merge, split, compare, protect and unlock.',
      '',
      'It only reads and writes inside the folders you choose, never overwrites a file and never connects to the internet.',
    ].join('\n'),
    author: { name: 'Arjun Prabhulal', url: 'https://arjunprabhulal.com' },
    repository: { type: 'git', url: 'https://github.com/arjunprabhulal/superpdf' },
    homepage: 'https://superpdf.ai',
    documentation: 'https://superpdf.ai/docs/mcp-api/mcp-tool-access',
    support: 'https://github.com/arjunprabhulal/superpdf/issues',
    icon: 'icon.png',
    server: {
      type: 'node',
      entry_point: 'mcpb/server.js',
      mcp_config: { command: 'node', args: ['${__dirname}/mcpb/server.js', '${user_config.allowed_directories}'] },
    },
    user_config: {
      allowed_directories: {
        type: 'directory',
        title: 'Folders superPDF may use',
        description: 'superPDF reads PDFs from these folders and writes new files into them. It can’t see anything else.',
        multiple: true,
        required: true,
      },
    },
    tools: contracts.map(c => ({ name: c.name, description: c.description })),
    keywords: ['pdf', 'pdf to markdown', 'ocr', 'pdf to word', 'pdf to excel', 'merge pdf', 'split pdf', 'pdf forms', 'local'],
    license: pkg.license,
    compatibility: { platforms: ['darwin', 'win32', 'linux'], runtimes: { node: pkg.engines.node.replace(/^>=(\d+)$/, '>=$1.0.0') } },
  };
}

async function build() {
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const stage = path.join(root, 'build', 'mcpb'), out = path.join(root, 'dist', `superpdf-${pkg.version}.mcpb`);
  await rm(stage, { recursive: true, force: true });
  await mkdir(stage, { recursive: true });
  await mkdir(path.dirname(out), { recursive: true });
  // The files npm publishes, plus the lock file so the bundle's dependencies are the tested ones.
  for (const entry of [...pkg.files, 'package.json', 'package-lock.json', 'mcpb']) await cp(path.join(root, entry), path.join(stage, entry), { recursive: true });
  await cp(path.join(root, 'mcpb', 'icon.png'), path.join(stage, 'icon.png'));
  // Under `npm run`, npm passes its own settings down as npm_config_* variables; a nested install would read them as
  // command-line flags (and refuses --allow-scripts there), so the staged install reads the user's npm config instead.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^npm_config_/i.test(key)));
  execFileSync('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], { cwd: stage, stdio: 'inherit', env });
  await writeFile(path.join(stage, 'manifest.json'), `${JSON.stringify(manifest(pkg), null, 2)}\n`);
  execFileSync('npx', ['-y', MCPB_CLI, 'validate', path.join(stage, 'manifest.json')], { stdio: 'inherit' });
  await rm(out, { force: true });
  execFileSync('npx', ['-y', MCPB_CLI, 'pack', stage, out], { stdio: 'inherit' });
  process.stdout.write(`mcpb: wrote ${path.relative(root, out)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) await build();
