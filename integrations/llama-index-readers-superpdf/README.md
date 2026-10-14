# llama-index-readers-superpdf

[![PyPI](https://img.shields.io/pypi/v/llama-index-readers-superpdf?style=flat-square&color=4338ca)](https://pypi.org/project/llama-index-readers-superpdf/) [![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-555555?style=flat-square)](https://github.com/arjunprabhulal/superpdf/blob/main/LICENSE)

**[superpdf.ai](https://superpdf.ai) · [Docs](https://superpdf.ai/docs/python/langchain-llamaindex) · [GitHub](https://github.com/arjunprabhulal/superpdf)**

The LlamaIndex reader for **superPDF AI**: local PDFs as Markdown, page by page, ready for RAG. Headings stay
Markdown headings, tables stay tables, charts drawn in the PDF come out as tables of their values, and scanned pages
are read with OCR in 15 languages. Everything runs on your computer; nothing is uploaded.

## Install

```bash
pip install -U llama-index-readers-superpdf
```

Python 3.10 or later on macOS, Linux or Windows. Node.js comes with the package; the first load installs the
superPDF reader (about 220 MB) into your cache folder, once.

## Use

```python
from llama_index.readers.superpdf import SuperPDFReader

docs = SuperPDFReader().load_data("report.pdf")  # one Document per page
docs[0].metadata  # {"page_label": "1", "file_name": "report.pdf"}
```

| Option | Effect |
|---|---|
| `return_full_document=True` | One Document for the whole PDF |
| `pages="1-3"` | Only these pages |
| `tables="html"` | Tables as HTML, keeping merged header cells |
| `ocr=False` | Skip OCR on scanned pages |
| `timeout=1200` | Seconds before giving up on one PDF (default 600) |

With `SimpleDirectoryReader`:

```python
from llama_index.core import SimpleDirectoryReader

reader = SimpleDirectoryReader("papers", file_extractor={".pdf": SuperPDFReader()})
docs = reader.load_data()
```

Split by section with `MarkdownNodeParser`, which records each node's `header_path`:

```python
from llama_index.core.node_parser import MarkdownNodeParser

nodes = MarkdownNodeParser().get_nodes_from_documents(docs)
```

More: [superpdf.ai/docs/python/langchain-llamaindex](https://superpdf.ai/docs/python/langchain-llamaindex).

## License

[Apache-2.0](https://github.com/arjunprabhulal/superpdf/blob/main/LICENSE). Part of
[superPDF AI](https://github.com/arjunprabhulal/superpdf).
