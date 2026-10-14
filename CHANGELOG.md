# Changelog

## 0.3.1

- `superpdf help` is reorganised: commands grouped under Read and convert, Edit pages, and For AI agents and code,
  with aligned descriptions, examples and notes. Colour on a terminal only, off with `NO_COLOR` (on with `FORCE_COLOR`).
- The help no longer says "all 18 tools"; a test keeps any tool count out of it.
- The help is headed superPDF AI and ends with links to the docs, the Python package and the source.
- Security: CodeQL code scanning; every GitHub Action pinned to a commit SHA; checkouts don't keep the token;
  Dependabot also watches the Python package.
- npm keywords; the README lists every way to use superPDF AI (CLI, MCP, API, Python, uvx) with its docs.

## 0.3.0

- 12 new tools, in the CLI (`superpdf tool`), the MCP server, the local API and the Python package (30 in all):
  - `pdf_to_docx`, `pdf_to_pptx`, `pdf_to_epub`: editable Word (headings, bold and italic, lists, tables; OCR for
    scanned pages), PowerPoint with the text as text boxes, and EPUB 3 in chapters.
  - `pdf_extract_tables`: tables, and charts drawn as vectors, as Excel (one sheet per table), CSV, JSON or Markdown.
  - `pdf_from_images`, `pdf_from_markdown`: JPG and PNG images, or a Markdown file, to PDF.
  - `pdf_fill_form`, `pdf_flatten`: fill form fields by name; make fields part of the page.
  - `pdf_add_text`, `pdf_resize_pages`: draw text such as a typed signature; crop margins or scale pages.
  - `pdf_compare`, `pdf_outline`: the words that changed between two versions, page by page; the outline with the
    pages each section covers.
- `pdf_add_page_labels` takes `position` (`top` or `bottom`, the default).
- `openapi.json` is generated from the tool schemas with `npm run openapi`, and a test fails when it is out of date.
  The published 0.2.0 file still listed version 0.1.0.

## 0.2.0

- `superpdf tools` lists all 18 tools with their JSON input schemas; `superpdf tool <name> --input '<json>'` runs
  any of them (JSON on stdin with `--input -`) and prints the result as JSON. Same validation, folder scope and
  results as the MCP server and the local API. Used by the Python package.
- A wrong value now names the allowed ones, such as "angle: use 90, 180 or 270".

## 0.1.3

- Windows: exports work. PDF.js data folders were built with `\`, which PDF.js rejects ("Invalid factory url"); they now use `/`. macOS and Linux are unchanged.
- CI runs the tests on Windows as well as Linux and macOS.

## 0.1.3-rc.0 (pre-release)

- Same code as 0.1.2, published from GitHub Actions to test the release workflow. Installed only with `@superpdf/cli@next`.

## 0.1.2

- Tables: a data row whose numbers are one digit longer than the rows below is no longer marked as a header row in HTML output (`--tables html` and the HTML export).

## 0.1.1

- README: the benchmark comparison now comes before Quick start. No code changes.

## 0.1.0

First public release.

- `superpdf` command: `info`, `merge`, `extract`, `rotate`, `export` (Markdown, HTML, JSON), `convert` (Office files,
  with LibreOffice), `pipeline` and `audio` (macOS).
- The superPDF reader: tables, charts as data, headings, lists, reading order, and OCR for scanned pages in 15
  languages.
- MCP server with 18 tools, limited to the `--allow-dir` folders.
- Local REST API with jobs and signed webhooks, on 127.0.0.1 with a bearer token.
