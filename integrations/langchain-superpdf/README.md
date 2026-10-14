# langchain-superpdf

[![PyPI](https://img.shields.io/pypi/v/langchain-superpdf?style=flat-square&color=4338ca)](https://pypi.org/project/langchain-superpdf/) [![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-555555?style=flat-square)](https://github.com/arjunprabhulal/superpdf/blob/main/LICENSE)

**[superpdf.ai](https://superpdf.ai) · [Docs](https://superpdf.ai/docs/python/langchain-llamaindex) · [GitHub](https://github.com/arjunprabhulal/superpdf)**

The LangChain document loader for **superPDF AI**: local PDFs as Markdown, page by page, ready for RAG. Headings stay
Markdown headings, tables stay tables, charts drawn in the PDF come out as tables of their values, and scanned pages
are read with OCR in 15 languages. Everything runs on your computer; nothing is uploaded.

## Install

```bash
pip install -U langchain-superpdf
```

Python 3.10 or later on macOS, Linux or Windows. Node.js comes with the package; the first load installs the
superPDF reader (about 220 MB) into your cache folder, once.

## Use

```python
from langchain_superpdf import SuperPDFLoader

docs = SuperPDFLoader("report.pdf").load()  # one Document per page
docs[0].page_content  # "# Quarterly report\n\nRevenue grew in every region…"
docs[0].metadata
# {"source": "report.pdf", "total_pages": 4, "creationdate": "", "creator": "…",
#  "producer": "…", "page": 0, "page_label": "1"}
```

`page` counts from 0 and `page_label` from 1, like LangChain's other PDF loaders.

| Option | Effect |
|---|---|
| `mode="single"` | One Document for the whole PDF, pages joined with `pages_delimiter` |
| `pages="1-3"` | Only these pages |
| `tables="html"` | Tables as HTML, keeping merged header cells |
| `ocr=False` | Skip OCR on scanned pages |
| `timeout=1200` | Seconds before giving up on one PDF (default 600) |

Several files at once: `SuperPDFLoader(["a.pdf", "b.pdf"])`. For a folder, or PDFs that arrive as bytes, use the
parser with any blob loader:

```python
from langchain_community.document_loaders.generic import GenericLoader
from langchain_superpdf import SuperPDFParser

docs = GenericLoader.from_filesystem("papers", glob="**/*.pdf", parser=SuperPDFParser()).load()
```

## Split by section

```python
from langchain_text_splitters import MarkdownHeaderTextSplitter

splitter = MarkdownHeaderTextSplitter([("#", "title"), ("##", "section")])
chunks = []
for doc in docs:
    for chunk in splitter.split_text(doc.page_content):
        chunk.metadata.update(doc.metadata)  # keep source and page for citations
        chunks.append(chunk)
```

## Agents (LangGraph)

For agents, use superPDF AI's MCP server: its 30 PDF tools (read, tables to Excel, Word export, merge, fill forms,
compare and more) load as LangChain tools through
[langchain-mcp-adapters](https://github.com/langchain-ai/langchain-mcp-adapters) and run in any LangGraph agent. The
tools can only use the folders you pass with `--allow-dir`.

```python
from langchain.agents import create_agent
from langchain_mcp_adapters.client import MultiServerMCPClient

client = MultiServerMCPClient(
    {
        "superpdf": {
            "command": "npx",
            "args": ["-y", "@superpdf/cli", "mcp", "--allow-dir", "/Users/you/Documents/superPDF"],
            "transport": "stdio",
        }
    }
)
tools = await client.get_tools()
agent = create_agent("anthropic:claude-sonnet-5-5", tools)
```

More, including search with page citations: [superpdf.ai/docs/python/langchain-llamaindex](https://superpdf.ai/docs/python/langchain-llamaindex).

## License

[Apache-2.0](https://github.com/arjunprabhulal/superpdf/blob/main/LICENSE). Part of
[superPDF AI](https://github.com/arjunprabhulal/superpdf).
