"""superPDF for Python: read, convert, edit and compare PDFs on your computer.

A typed wrapper around the superPDF command-line tool (npm package @superpdf/cli): `export` gives the same results
as `superpdf export`, and every other function runs one of the tools the MCP server and the local API run.
Node.js comes with the package (nodejs-wheel-binaries).
"""

from __future__ import annotations

import json
import os
import re
from typing import Any

from ._cli import CLI_VERSION, SuperPDFError, install_cli, run
from ._tools import (
    BatchResult,
    Comparison,
    EpubResult,
    FileEntry,
    Folder,
    OfficeResult,
    Outline,
    PageChange,
    PdfInfo,
    PipelineStep,
    RepairResult,
    SavedFile,
    Section,
    SlidesResult,
    SplitResult,
    Structure,
    TablesResult,
    Text,
    TextPage,
    WordResult,
    Written,
    add_page_labels,
    add_text,
    add_watermark,
    compare,
    extract_pages,
    extract_structure,
    extract_tables,
    fill_form,
    flatten,
    from_images,
    from_markdown,
    from_office,
    info,
    list_files,
    merge,
    outline,
    protect,
    read_text,
    remove_metadata,
    remove_pages,
    repair,
    resize_pages,
    rotate_pages,
    run_batch,
    run_pipeline,
    run_tool,
    split,
    to_docx,
    to_epub,
    to_pptx,
    tools,
    unlock,
)

__all__ = [
    "CLI_VERSION",
    "BatchResult",
    "Comparison",
    "EpubResult",
    "FileEntry",
    "Folder",
    "OfficeResult",
    "Outline",
    "PageChange",
    "PdfInfo",
    "PipelineStep",
    "RepairResult",
    "SavedFile",
    "Section",
    "SlidesResult",
    "SplitResult",
    "Structure",
    "SuperPDFError",
    "TablesResult",
    "Text",
    "TextPage",
    "WordResult",
    "Written",
    "add_page_labels",
    "add_text",
    "add_watermark",
    "compare",
    "export",
    "export_json",
    "export_pages",
    "extract_pages",
    "extract_structure",
    "extract_tables",
    "fill_form",
    "flatten",
    "from_images",
    "from_markdown",
    "from_office",
    "info",
    "install_cli",
    "list_files",
    "merge",
    "outline",
    "protect",
    "read_text",
    "remove_metadata",
    "remove_pages",
    "repair",
    "resize_pages",
    "rotate_pages",
    "run_batch",
    "run_pipeline",
    "run_tool",
    "split",
    "to_docx",
    "to_epub",
    "to_pptx",
    "tools",
    "unlock",
]
__version__ = "0.3.0"

_PAGE_END = re.compile(r"^<!-- end of page (\d+) -->\s*$", re.MULTILINE)


def _args(path: str | os.PathLike[str], fmt: str, pages: str | None, tables: str | None, ocr: bool) -> list[str]:
    args = ["export", os.fspath(path), "--format", fmt]
    if pages:
        args += ["--pages", pages]
    if tables:
        args += ["--tables", tables]
    if not ocr:
        args.append("--no-ocr")
    return args


def export(
    path: str | os.PathLike[str],
    format: str = "markdown",
    *,
    pages: str | None = None,
    tables: str | None = None,
    ocr: bool = True,
    timeout: float | None = 600,
) -> str:
    """Read a PDF and return it as Markdown, HTML or JSON text.

    pages: a selection such as "1,3-5" (all pages when omitted).
    tables: "html" writes Markdown tables as HTML, keeping merged header cells (Markdown only).
    ocr: read scanned pages with superPDF OCR (Tesseract, 15 languages); False skips it.
    """
    if format not in ("markdown", "html", "json"):
        raise ValueError("format must be 'markdown', 'html' or 'json'.")
    if tables not in (None, "markdown", "html"):
        raise ValueError("tables must be 'markdown' or 'html'.")
    if tables and format != "markdown":
        raise ValueError("tables applies to Markdown only.")
    return run(_args(path, format, pages, tables, ocr), timeout=timeout)


def export_json(path: str | os.PathLike[str], **options: Any) -> dict[str, Any]:
    """The document's structure as a dict: title, pageCount, pages (blocks with type and bbox) and sections."""
    structure: dict[str, Any] = json.loads(export(path, "json", **options))
    return structure


def export_pages(path: str | os.PathLike[str], **options: Any) -> list[dict[str, Any]]:
    """Markdown per page: a list of {"page": number, "markdown": text}."""
    text = export(path, "markdown", **options)
    result, start = [], 0
    for match in _PAGE_END.finditer(text):
        result.append({"page": int(match.group(1)), "markdown": text[start : match.start()].strip()})
        start = match.end()
    return result
