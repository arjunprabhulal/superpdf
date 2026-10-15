// Generate sdk/index.d.ts, the SDK's TypeScript types, from the shared Zod contracts: one input and one result type
// per tool, and a declaration for each function. `npm run sdk:types` writes it; tests/sdk.test.js fails on drift.
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as z from 'zod';
import { compile } from 'json-schema-to-typescript';
import { contracts } from '../contracts/tools.js';

export const TYPES_FILE = new URL('../sdk/index.d.ts', import.meta.url);

/** The SDK function for a tool: pdf_to_docx → toDocx. */
export const functionName = tool => tool.replace(/^pdf_/, '').replace(/_([a-z])/g, (_, c) => c.toUpperCase());
const typeName = (tool, suffix) => functionName(tool).replace(/^./, c => c.toUpperCase()) + suffix;

/** One TypeScript declaration from a JSON Schema, with its description as a doc comment. */
// The SDK resolves relative paths against the current folder (the MCP server and the API, against the first
// allowed folder), so the path fields' descriptions say so.
const sdkDescriptions = schema => JSON.parse(JSON.stringify(schema).replaceAll('(absolute, or relative to the first allowed folder)', '(absolute, or relative to the current folder)').replaceAll('Omit for the first allowed folder.', 'Omit for the current folder.'));

async function declare(schema, name) {
  const { $schema, ...rest } = sdkDescriptions(schema);
  const text = await compile(rest, name, {
    bannerComment: '',
    additionalProperties: false,
    declareExternallyReferenced: true,
    format: true,
    strictIndexSignatures: true,
    maxItems: -1, // plain arrays for bounded lists (steps: 1-10), not every tuple length
    style: { singleQuote: true },
  });
  return text.trim();
}

const HEADER = `// superPDF AI SDK types, generated from the tool schemas by scripts/sdk-types.js. Do not edit by hand.

/** Options for every tool function. */
export interface ToolOptions {
  /** The folders this call may use. By default, the folders of the paths in the input. */
  allowDirs?: string[];
  /** Progress for long tools: steps done, steps in all, and what is happening. */
  onProgress?: (done: number, total: number, message: string) => void;
}

/** A tool refused its input or could not finish. \`code\` matches the local API's problem codes. */
export declare class SuperPDFError extends Error {
  name: 'SuperPDFError';
  /** validation, conflict, not_found, busy or operation_failed. */
  code: string;
  /** The HTTP status the local API answers with for the same problem. */
  status: number;
  /** One entry per field that was refused, when the input was invalid. */
  errors?: { field: string; message: string }[];
}

/** Options for exportPdf, exportJson and exportPages. */
export interface ExportOptions {
  /** markdown (default), html or json. exportJson and exportPages set it themselves. */
  format?: 'markdown' | 'html' | 'json';
  /** Pages to read, such as "1, 3-5"; all pages when omitted. */
  pages?: string;
  /** "html" writes Markdown tables as HTML, keeping merged header cells. */
  tables?: 'markdown' | 'html';
  /** Read scanned pages (no text layer) with OCR. Default true. */
  ocr?: boolean;
  /** Progress and notes about scanned pages. */
  onMessage?: (text: string) => void;
}

/** A tool as tools() lists it. */
export interface ToolDescription {
  name: string;
  title: string;
  description: string;
  annotations: Record<string, unknown>;
  input_schema: Record<string, unknown>;
}

/** Read a PDF (a path or its bytes) into Markdown, HTML or JSON text, as \`superpdf export\` does. */
export declare function exportPdf(source: string | Uint8Array, options?: ExportOptions): Promise<string>;
/** The document's structure as an object: title, pages with their blocks, and sections. */
export declare function exportJson(source: string | Uint8Array, options?: Omit<ExportOptions, 'format'>): Promise<Record<string, unknown>>;
/** Markdown per page, pages counted from 1. */
export declare function exportPages(source: string | Uint8Array, options?: Omit<ExportOptions, 'format'>): Promise<{ page: number; markdown: string }[]>;
/** Every tool with its name, title, description, MCP annotations and JSON input schema. */
export declare function tools(): ToolDescription[];
/** Run any tool by name with its JSON input, as the MCP server and the local API do. */
export declare function runTool(name: string, input?: Record<string, unknown>, options?: ToolOptions): Promise<unknown>;
`;

export async function buildTypes() {
  const parts = [HEADER];
  for (const c of contracts) {
    const input = typeName(c.name, 'Input');
    const result = typeName(c.name, 'Result');
    parts.push(await declare(z.toJSONSchema(c.input, { io: 'input' }), input));
    parts.push(await declare(z.toJSONSchema(c.output, { io: 'output' }), result));
    const summary = c.description.replace(/\*\//g, '* /');
    parts.push(`/** ${c.title}. ${summary} (Tool ${c.name}.) */\nexport declare function ${functionName(c.name)}(input: ${input}, options?: ToolOptions): Promise<${result}>;`);
  }
  return `${parts.join('\n\n')}\n`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await writeFile(TYPES_FILE, await buildTypes());
  process.stdout.write(`Wrote ${path.relative(process.cwd(), fileURLToPath(TYPES_FILE))}\n`);
}
