# Changelog

## 0.4.1

- Uses `@superpdf/cli` 0.4.1, which fixes Markdown table cells that hold a backslash before a pipe. No change to the
  Python API; the version matches the npm package.

## 0.4.0

- Uses `@superpdf/cli` 0.4.0, which adds the JavaScript and TypeScript SDK. No change to the Python API; the
  version matches the npm package.

## 0.3.1

The first 0.3 release on PyPI, numbered to match `@superpdf/cli` 0.3.1 (0.3.0 was never published).

- 12 new functions, the tools added in `@superpdf/cli` 0.3.0: `to_docx`, `to_pptx`, `to_epub`, `extract_tables`,
  `from_images`, `from_markdown`, `fill_form`, `flatten`, `add_text`, `resize_pages`, `compare` and `outline`, with
  typed results (`WordResult`, `SlidesResult`, `EpubResult`, `TablesResult`, `Comparison`, `Outline`, `SavedFile`).
- `add_page_labels` takes `position` (`"top"` or `"bottom"`).
- `OfficeResult` is exported.
- Uses `@superpdf/cli` 0.3.1.
- Tested on Python 3.15 as well.

## 0.2.0

- Every superPDF tool as a typed Python function: `info`, `list_files`, `read_text`, `extract_structure`, `merge`,
  `extract_pages`, `remove_pages`, `rotate_pages`, `split`, `add_page_labels`, `add_watermark`, `remove_metadata`,
  `repair`, `protect`, `unlock`, `from_office`, `run_pipeline` and `run_batch`, with typed results.
- `tools()` lists every tool with its JSON input schema; `run_tool(name, arguments, allow=...)` runs any by name.
- Uses `@superpdf/cli` 0.2.0. A test keeps each function's parameters and allowed values in step with the CLI's
  schemas.

## 0.1.0

First release.

- `superpdf.export`, `export_json` and `export_pages`: Markdown, HTML or JSON from the superPDF CLI
  (`@superpdf/cli` 0.1.3), with page selection, HTML tables and OCR on or off.
- `superpdf.langchain.SuperPDFLoader` and `superpdf.llama_index.SuperPDFReader`: one document per page.
- `superpdf` command (also `python -m superpdf`), so `uvx superpdf …` and `pipx run superpdf …` work.
- Node.js comes from `nodejs-wheel-binaries`; the CLI installs once into the user cache. Clear errors when it
  can't be installed or found.
