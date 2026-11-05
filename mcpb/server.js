// Entry point of the Claude Desktop extension (superpdf.mcpb, built by scripts/mcpb.js). Claude Desktop passes the
// folders picked in the extension's settings as plain arguments; the MCP server takes each as --allow-dir.
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/** ['/a', '/b'] -> ['--allow-dir', '/a', '--allow-dir', '/b'] */
export const allowDirArgs = dirs => dirs.flatMap(dir => ['--allow-dir', dir]);

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const { main } = await import('../mcp/server.js');
  main(allowDirArgs(process.argv.slice(2))).catch(error => { process.stderr.write(`superPDF: ${error.message}\n`); process.exitCode = 1; });
}
