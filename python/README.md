# superPDF AI for Python (`superpdf`)

[![PyPI](https://img.shields.io/pypi/v/superpdf?style=flat-square&color=4338ca)](https://pypi.org/project/superpdf/) [![Python](https://img.shields.io/pypi/pyversions/superpdf?style=flat-square)](https://pypi.org/project/superpdf/) [![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-555555?style=flat-square)](https://github.com/arjunprabhulal/superpdf/blob/main/LICENSE)

**[superpdf.ai](https://superpdf.ai) · [Python docs](https://superpdf.ai/docs/python) · [GitHub](https://github.com/arjunprabhulal/superpdf) · [Changelog](https://github.com/arjunprabhulal/superpdf/blob/main/python/CHANGELOG.md)**

Read, convert, edit and compare PDFs on your computer: Markdown, HTML or JSON with headings, tables, charts as data
and OCR for scanned pages; Word, PowerPoint, Excel and EPUB; forms, signatures, merging and splitting. Nothing is
uploaded.

This package is a thin Python wrapper around the [superPDF command-line tool](https://github.com/arjunprabhulal/superpdf)
(npm package `@superpdf/cli`), so you get exactly what `superpdf export` produces. Every superPDF tool is a typed
Python function (Word, PowerPoint and EPUB export, tables to Excel or CSV, forms, merge, split, rotate, page
numbers, watermark, protect, compare, Office to PDF, pipelines and batches), and it includes a LangChain document loader and a LlamaIndex reader.

## Requirements

Python 3.10 or later on macOS, Linux or Windows. Nothing else: Node.js comes with the package through
[`nodejs-wheel-binaries`](https://pypi.org/project/nodejs-wheel-binaries/).

The first call installs the superPDF reader (`@superpdf/cli`, about 220 MB with its PDF engine and OCR language
data) from npm into your cache folder, once. To do that ahead of time, for example in a Docker image or before going offline:

```bash
python -c "import superpdf; superpdf.install_cli()"
```

## Install

```bash
pip install superpdf
pip install "superpdf[langchain]"      # with the LangChain loader
pip install "superpdf[llama-index]"    # with the LlamaIndex reader
uv add superpdf                        # in a uv project
```

Or run the command without installing anything:

```bash
uvx superpdf export report.pdf --output report.md
pipx run superpdf export report.pdf --output report.md
```

## Use

```python
import superpdf

markdown = superpdf.export("report.pdf")  # the whole document as Markdown
html = superpdf.export("report.pdf", "html")
structure = superpdf.export_json("report.pdf")  # pages, blocks with type and position, sections

for page in superpdf.export_pages("report.pdf"):  # Markdown per page
    print(page["page"], page["markdown"][:80])

superpdf.export("report.pdf", pages="1,3-5", tables="html", ocr=False)
```

| Option | Meaning |
|---|---|
| `format` | `"markdown"` (default), `"html"` or `"json"` |
| `pages` | A selection such as `"1,3-5"`; all pages when omitted |
| `tables` | `"html"` writes Markdown tables as HTML, keeping merged header cells (Markdown only) |
| `ocr` | `True` (default) reads scanned pages with OCR in 15 languages; `False` skips it |
| `timeout` | Seconds before giving up (default 600) |

Errors raise `superpdf.SuperPDFError` with superPDF's own message, for example `No file at report.pdf.`

### Every PDF tool

Every superPDF tool is a Python function: the same 30 tools as the MCP server and the local API, with the same
validation and results. Each returns a typed dict; outputs are always new files (an existing file is never
overwritten), and a call only touches the folders of the files you give it.

```python
import superpdf

superpdf.merge(["a.pdf", "b.pdf"], "combined.pdf")  # {"output": ..., "pages": 7, "bytes": ...}
superpdf.extract_pages("report.pdf", "1, 3-5", "selected.pdf")
superpdf.rotate_pages("scan.pdf", "upright.pdf", pages="2", angle=180)
superpdf.split("book.pdf", "chapters/", pages="1-10, 11-20")  # one PDF per range
superpdf.add_page_labels("report.pdf", "numbered.pdf", text="Page {page} of {total}")
superpdf.add_watermark("contract.pdf", "DRAFT", "draft.pdf")
superpdf.protect("payslip.pdf", "a long password", "locked.pdf")  # AES-256
superpdf.unlock("locked.pdf", "open.pdf", password="a long password")
superpdf.from_office("slides.pptx", "slides.pdf")  # needs LibreOffice

superpdf.to_docx("report.pdf", "report.docx")  # editable Word: headings, lists, tables
superpdf.extract_tables("report.pdf", "tables.xlsx")  # or tables.csv with format="csv"
superpdf.fill_form("form.pdf", {"Name": "Ada Lovelace", "Agree": True}, "filled.pdf")
superpdf.add_text("contract.pdf", "Signed: Ada Lovelace", "signed.pdf", pages="3", x=72, y=96)
changes = superpdf.compare("v1.pdf", "v2.pdf")  # per page: same, changed, added or removed

info = superpdf.info("report.pdf")  # pages, sizes, form fields, properties
text = superpdf.read_text("report.pdf", pages="1-2")  # the text layer, page by page
```

| Function | What it does | Returns |
|---|---|---|
| `info(path)` | Page count, page sizes and rotation, form fields, properties | `PdfInfo` |
| `list_files(folder=".")` | The PDFs in a folder | `Folder` |
| `read_text(path, pages=, max_chars=)` | The text layer, page by page | `Text` |
| `extract_structure(path, pages=, format=, max_chars=)` | Markdown, HTML or JSON plus the outline; OCR for scans | `Structure` |
| `merge(inputs, output)` | Combine PDFs in order | `Written` |
| `extract_pages(path, pages, output)` | Keep only some pages | `Written` |
| `remove_pages(path, pages, output)` | Drop pages | `Written` |
| `rotate_pages(path, output, pages=, angle=90\|180\|270)` | Rotate clockwise | `Written` |
| `split(path, output_folder, pages=, mode="ranges"\|"pages")` | One PDF per range or per page | `SplitResult` |
| `add_page_labels(path, output, pages=, text="{page} / {total}", position="bottom"\|"top")` | Page numbers, a footer or a header | `Written` |
| `add_watermark(path, text, output, pages=)` | Stamp text such as DRAFT diagonally | `Written` |
| `remove_metadata(path, output)` | Strip document properties | `Written` |
| `repair(path, output)` | Rebuild a damaged PDF | `RepairResult` |
| `protect(path, password, output)` | Encrypt with AES-256 | `Written` |
| `unlock(path, output, password=)` | Decrypt with a password you know | `Written` |
| `from_office(path, output)` | Word, Excel, PowerPoint or OpenDocument to PDF (LibreOffice) | `OfficeResult` |
| `add_text(path, text, output, pages=, x=36, y=36, size=12)` | Draw text such as a typed signature (points from bottom-left) | `Written` |
| `resize_pages(path, output, mode="crop"\|"scale", pages=, margin=24, factor=1)` | Crop a margin from each edge, or scale | `Written` |
| `fill_form(path, values, output, flatten=False)` | Fill form fields by name (`info` lists them) | `Written` |
| `flatten(path, output)` | Make form fields part of the page | `Written` |
| `to_docx(path, output, pages=)` | Editable Word: headings, bold and italic, lists, tables; OCR for scans | `WordResult` |
| `to_pptx(path, output, pages=)` | PowerPoint, one slide per page, text as text boxes | `SlidesResult` |
| `to_epub(path, output, title=, author=, language="en", split="headings"\|"pages")` | EPUB 3 e-book in chapters | `EpubResult` |
| `extract_tables(path, output, pages=, format="xlsx"\|"csv"\|"json"\|"markdown")` | Tables and vector charts; `output` ends in the format's extension | `TablesResult` |
| `from_images(inputs, output)` | JPG or PNG images to PDF, one page each | `Written` |
| `from_markdown(path, output, page_size="A4"\|"Letter", title=)` | Typeset a Markdown file as a PDF | `Written` |
| `compare(before, after, max_chars=20000)` | The words that changed, page by page, marked `[-old-]` and `{+new+}` | `Comparison` |
| `outline(path, format="markdown"\|"json")` | The outline, with the pages each section covers | `Outline` |
| `run_pipeline(path, steps, output)` | Up to 10 steps on one PDF, saved once | `Written` |
| `run_batch(inputs, steps, output_folder, suffix=)` | The same steps on up to 50 PDFs; failures listed, not raised | `BatchResult` |

`pages` takes numbers and ranges such as `"1, 3-5"`. Pipeline and batch steps are dicts such as
`{"action": "rotate", "options": {"pages": "1", "angle": 90}}`; the actions are extract, remove, rotate, crop
(margin), scale (factor), flatten, labels, watermark and metadata-clear.

`superpdf.tools()` lists every tool with its JSON input schema, and `superpdf.run_tool(name, arguments, allow=[...])`
runs any of them by name, for tools added to the CLI before this package catches up.

### LangChain and LlamaIndex

For new projects, install the integration packages, whose metadata matches each framework's other PDF loaders:
[`langchain-superpdf`](https://pypi.org/project/langchain-superpdf/) and
[`llama-index-readers-superpdf`](https://pypi.org/project/llama-index-readers-superpdf/). Guide:
[superpdf.ai/docs/python/langchain-llamaindex](https://superpdf.ai/docs/python/langchain-llamaindex).

The extras below keep working, with simpler metadata (`page` counted from 1).

#### LangChain extra

```python
from superpdf.langchain import SuperPDFLoader

docs = SuperPDFLoader("report.pdf").load()  # one Document per page
docs[0].metadata  # {"source": "report.pdf", "page": 1}
```

#### LlamaIndex extra

```python
from superpdf.llama_index import SuperPDFReader

docs = SuperPDFReader(tables="html").load_data("report.pdf")  # one Document per page
```

## Command line

The package installs a `superpdf` command that runs the full CLI (the same as `python -m superpdf`):

```bash
superpdf export report.pdf --output report.md
superpdf export report.pdf --tables html --output report.md
superpdf help
```

`uvx superpdf …` and `pipx run superpdf …` run it in a temporary environment, with nothing to install first.

<img src="https://raw.githubusercontent.com/arjunprabhulal/superpdf/main/docs/assets/cli-help.png" alt="uvx superpdf in a terminal: commands grouped under Read and convert, Edit pages, and For AI agents and code, then examples and notes" width="820">

## How it works

Each call runs `superpdf export` in a subprocess (no shell) with the bundled Node.js and reads its output as UTF-8.
The reader is `@superpdf/cli` at the version this package is tested with, installed once into your cache folder:
`~/Library/Caches/superpdf` on macOS, `~/.cache/superpdf` on Linux and `%LOCALAPPDATA%\superpdf\Cache` on Windows
(set `SUPERPDF_CACHE_DIR` to change it). To use your own build instead, set `SUPERPDF_BIN` to a `superpdf` command or
`superpdf.js`. The reader, its tables, charts and OCR are described in the
[main README](https://github.com/arjunprabhulal/superpdf#readme).

## License

[Apache-2.0](https://github.com/arjunprabhulal/superpdf/blob/main/LICENSE).
