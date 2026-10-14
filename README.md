# superPDF AI command-line tool

superPDF on your computer: PDF tools for Terminal, your own scripts, and AI assistants that support MCP (Claude Desktop, Claude Code, Cursor, VS Code and others). Everything runs on this computer, only in the folders you allow. Nothing is uploaded, and there's no account.

Needs Node.js 22 or later.

Try it without installing (npx downloads it once and runs it):

```sh
npx @superpdf/cli help
npx @superpdf/cli export document.pdf --output document.md
```

Or install the `superpdf` command once and run it from any folder:

```sh
npm install -g @superpdf/cli
superpdf help
```

To update later, run `npm install -g @superpdf/cli@latest`; to remove it, `npm uninstall -g @superpdf/cli`.

## In Terminal

```sh
superpdf info document.pdf
superpdf merge a.pdf b.pdf --output combined.pdf
superpdf extract document.pdf --pages 1,3-5 --output selected.pdf
superpdf rotate document.pdf --angle 90 --output rotated.pdf
superpdf export document.pdf --output document.md    # or .html / .json
superpdf convert report.docx --output report.pdf     # Word, Excel, PowerPoint; needs LibreOffice
superpdf pipeline document.pdf --steps steps.json --output result.pdf
```

Results are always written to a new file; existing files are never overwritten. There is no file size or page limit.

## Markdown, HTML and JSON

`export` uses the same reader as PDF to text on superpdf.ai, so it writes the same Markdown, HTML and JSON.

- Scanned pages (no text layer) are read with superPDF OCR, as in the browser: Tesseract (tesseract.js 7, Apache-2.0)
  with its English data (`eng.traineddata`, tessdata_best, Apache-2.0), which comes with this package, so nothing is
  downloaded. Pages are read one at a time with one engine per run. Add `--no-ocr` to skip it.
- Markdown writes tables as Markdown tables. `--tables html` writes them as HTML tables instead, as the HTML export
  does, so header rows and merged cells are kept.
- Chinese, Japanese and Korean text, and JPEG 2000 and JBIG2 scans, are read with PDF.js's own character maps, fonts
  and decoders from the installed `pdfjs-dist`.

```sh
superpdf export report.pdf --output report.md
superpdf export report.pdf --tables html --output report.md
superpdf export scan.pdf --no-ocr --output scan.md
```

## With your AI assistant (MCP)

Add superPDF to your assistant's MCP settings. For Claude Code:

```sh
claude mcp add --scope user superpdf -- superpdf mcp --allow-dir ~/Documents/superPDF
```

Then put a PDF in that folder and ask your assistant to merge, split, convert or protect it. The assistant can only use the folders you pass with `--allow-dir`.

Setup for other assistants: https://superpdf.ai/docs/mcp-api/mcp-tool-access

## From your own code (REST API)

```sh
superpdf serve --allow-dir ~/Documents/superPDF
```

This starts a private API on 127.0.0.1 that only this computer can reach, protected by a token it prints when it starts. Guide and reference: https://superpdf.ai/docs/api

## How the reader works

`export` is superPDF's own PDF reader: plain JavaScript with no AI model. It reads the text, fonts and drawings a PDF
already contains (PDF.js), then rebuilds the structure with rules: table grids from ruled lines and aligned text,
charts as data from the bars, lines and labels drawn on the page, headings and bold or italic text from the fonts,
and reading order across columns. Pages without a text layer are read with Tesseract OCR.

On ParseBench, in our own run of its open-source test suite on all 2,078 documents, it scores 65.0 (64.8 on documents
it was never tuned on). It is not on the official leaderboard yet. It is strongest on charts and formatting; cloud
services such as Azure Document Intelligence and AWS Textract read tables better, and AI models such as Claude Opus
5.5 and Gemini score higher overall. Details: https://superpdf.ai/performance

The reader lives in `lib/`: `pdf-structure.js` (pages to blocks), `pdf-layout.js` (lines, tables, reading order),
`pdf-charts.js` (charts) and `pdf-text-fixes.js` (text repairs). Ideas adapted from other open-source projects are
credited in NOTICE.

## Contributing

Issues and pull requests are welcome: https://github.com/arjunprabhulal/superpdf/issues. For a reading problem,
attach the PDF (or a page of it) and the output you expected.

## Learn more

- Documentation: https://superpdf.ai/docs
- superPDF in your browser: https://superpdf.ai

## Licence

Apache-2.0 (see LICENSE and NOTICE). "superPDF" and its logo are trademarks and are not covered by this licence.
