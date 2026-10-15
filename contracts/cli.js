// `superpdf tools` and `superpdf tool <name>`: the shared contracts (the same ones the MCP server and the local HTTP API
// run) from the command line, for scripts and the Python package. Input is JSON (an argument or stdin); the result is
// JSON on stdout: { value, files }. Paths must be inside the --allow-dir folders (default: the current folder).
import { parseArgs } from 'node:util';
import * as z from 'zod';
import { contracts, contractByName, runContract } from './tools.js';
import { classify } from './errors.js';
import { createScope } from '../mcp/scope.js';

const usage = `superpdf tools                                   (every tool, with its JSON input schema)
superpdf tool <name> --input '<json>' [--allow-dir <folder>]...
superpdf tool <name> --input - < input.json       (the JSON from stdin)

Runs one tool, such as pdf_merge or pdf_protect, the same way the MCP server and the local API do, and prints
{ "value": ..., "files": [...] } as JSON. Files must be inside the --allow-dir folders (the current folder if none).`;

const readStdin = async () => {
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  return text;
};

/** Every tool with its title, description, annotations and JSON Schemas, for scripts and code generators. */
export function describeTools() {
  return contracts.map(c => ({
    name: c.name,
    title: c.title,
    description: c.description,
    annotations: c.annotations,
    input_schema: z.toJSONSchema(c.input, { io: 'input' }),
  }));
}

/**
 * The first problem with a tool's input, as one sentence: "Invalid input. angle: use 90, 180 or 270." Names the
 * allowed values when the schema lists them. Shared with the SDK (sdk/index.js).
 */
export function invalidInput(contract, zodError) {
  const issue = zodError.issues[0];
  const field = issue.path.join('.') || 'input';
  const property = z.toJSONSchema(contract.input, { io: 'input' }).properties?.[issue.path[0]];
  const choices = property?.enum ?? property?.anyOf?.map(option => option.const).filter(value => value !== undefined);
  const hint = choices?.length ? `use ${choices.slice(0, -1).join(', ')}${choices.length > 1 ? ' or ' : ''}${choices.at(-1)}` : issue.message;
  return { field, detail: `Invalid input. ${field}: ${hint}.`, errors: zodError.issues.map(i => ({ field: i.path.join('.') || 'input', message: i.message })) };
}

export async function main(argv) {
  const [command, ...rest] = argv;
  if (command === 'tools') {
    process.stdout.write(`${JSON.stringify(describeTools(), null, 2)}\n`);
    return;
  }
  let values, positionals;
  try {
    ({ values, positionals } = parseArgs({
      args: rest, allowPositionals: true, strict: true,
      options: { input: { type: 'string' }, 'allow-dir': { type: 'string', multiple: true }, help: { type: 'boolean', short: 'h' } },
    }));
  } catch (error) { throw new Error(`${error.message.replace(/\. To specify.*$/s, '')}\n${usage}`); }
  if (values.help || !positionals.length) { process.stdout.write(`${usage}\n`); return; }
  if (positionals.length > 1) throw new Error(`Give one tool name.\n${usage}`);
  const contract = contractByName.get(positionals[0]);
  if (!contract) throw new Error(`There's no tool called ${positionals[0]}. superpdf tools lists them.`);
  const text = values.input === '-' ? await readStdin() : values.input ?? '{}';
  let raw;
  try { raw = JSON.parse(text); } catch { throw new Error('--input must be JSON, such as {"input": "report.pdf"}.'); }
  const parsed = contract.input.safeParse(raw);
  if (!parsed.success) throw new Error(invalidInput(contract, parsed.error).detail);
  const scope = await createScope(values['allow-dir']?.length ? values['allow-dir'] : [process.cwd()]);
  try {
    const { value, files } = await runContract(contract, parsed.data, { scope });
    process.stdout.write(`${JSON.stringify({ value, files })}\n`);
  } catch (error) {
    throw new Error(classify(error).detail);
  }
}
