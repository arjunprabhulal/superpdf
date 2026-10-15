// Compiled with `tsc -p tests/types` (npm test): the SDK's types as a TypeScript project sees them, imported by
// package name through package.json "exports". Nothing here runs.
import {
  exportPages,
  extractTables,
  fillForm,
  merge,
  rotatePages,
  runBatch,
  SuperPDFError,
  toDocx,
  tools,
  type ToDocxResult,
} from '@superpdf/cli';

export async function examples(): Promise<void> {
  const word: ToDocxResult = await toDocx({ input: 'report.pdf', output: 'report.docx' });
  const tableCount: number = word.tables;
  const pages = await exportPages('report.pdf', { tables: 'html' });
  const first: string = pages[0].markdown;
  const merged = await merge({ inputs: ['a.pdf', 'b.pdf'], output: 'ab.pdf' }, { allowDirs: ['.'] });
  const count: number = merged.pages;
  await extractTables({ input: 'report.pdf', format: 'csv', output: 'tables.csv' });
  await fillForm({ input: 'form.pdf', values: { Name: 'Ada', Agree: true }, output: 'filled.pdf' });
  await runBatch({ inputs: ['a.pdf'], steps: [{ action: 'watermark', options: { text: 'DRAFT' } }], output_folder: 'out' });
  const names: string[] = tools().map(tool => tool.name);
  void [tableCount, first, count, names];

  // @ts-expect-error angle is 90, 180 or 270
  await rotatePages({ input: 'report.pdf', angle: 45, output: 'r.pdf' });
  // @ts-expect-error output is required
  await toDocx({ input: 'report.pdf' });
  // @ts-expect-error steps needs at least one step
  await runBatch({ inputs: ['a.pdf'], steps: [], output_folder: 'out' });
  // @ts-expect-error unknown option
  await merge({ inputs: ['a.pdf', 'b.pdf'], output: 'ab.pdf', overwrite: true });

  try {
    await toDocx({ input: 'missing.pdf', output: 'x.docx' });
  } catch (error) {
    if (error instanceof SuperPDFError) {
      const code: string = error.code;
      const fields = error.errors?.map(e => e.field);
      void [code, fields];
    }
  }
}
