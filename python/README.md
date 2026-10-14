# superpdf (Python)

[![PyPI](https://img.shields.io/pypi/v/superpdf?style=flat-square&color=4338ca)](https://pypi.org/project/superpdf/) [![Python](https://img.shields.io/pypi/pyversions/superpdf?style=flat-square)](https://pypi.org/project/superpdf/) [![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-555555?style=flat-square)](LICENSE)

Read PDFs into Markdown, HTML or JSON on your computer: headings, tables, charts as data and OCR for scanned
pages. Nothing is uploaded.

This package is a thin Python wrapper around the [superPDF command-line tool](https://github.com/arjunprabhulal/superpdf)
(npm package `@superpdf/cli`), so you get exactly what `superpdf export` produces. It includes a LangChain document
loader and a LlamaIndex reader.

## Requirements

Python 3.10 or later on macOS, Linux or Windows. Nothing else: Node.js comes with the package through
[`nodejs-wheel-binaries`](https://pypi.org/project/nodejs-wheel-binaries/).

The first call installs the superPDF reader (`@superpdf/cli`, about 185 MB with its PDF engine and OCR language
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

### LangChain

```python
from superpdf.langchain import SuperPDFLoader

docs = SuperPDFLoader("report.pdf").load()  # one Document per page
docs[0].metadata  # {"source": "report.pdf", "page": 1}
```

### LlamaIndex

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

## How it works

Each call runs `superpdf export` in a subprocess (no shell) with the bundled Node.js and reads its output as UTF-8.
The reader is `@superpdf/cli` at the version this package is tested with, installed once into your cache folder:
`~/Library/Caches/superpdf` on macOS, `~/.cache/superpdf` on Linux and `%LOCALAPPDATA%\superpdf\Cache` on Windows
(set `SUPERPDF_CACHE_DIR` to change it). To use your own build instead, set `SUPERPDF_BIN` to a `superpdf` command or
`superpdf.js`. The reader, its tables, charts and OCR are described in the
[main README](https://github.com/arjunprabhulal/superpdf#readme).

## License

[Apache-2.0](LICENSE).
