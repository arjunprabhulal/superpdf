# Changelog

## 0.1.0

First release.

- `superpdf.export`, `export_json` and `export_pages`: Markdown, HTML or JSON from the superPDF CLI
  (`@superpdf/cli` 0.1.3), with page selection, HTML tables and OCR on or off.
- `superpdf.langchain.SuperPDFLoader` and `superpdf.llama_index.SuperPDFReader`: one document per page.
- `superpdf` command (also `python -m superpdf`), so `uvx superpdf …` and `pipx run superpdf …` work.
- Node.js comes from `nodejs-wheel-binaries`; the CLI installs once into the user cache. Clear errors when it
  can't be installed or found.
