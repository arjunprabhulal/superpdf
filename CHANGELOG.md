# Changelog

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
