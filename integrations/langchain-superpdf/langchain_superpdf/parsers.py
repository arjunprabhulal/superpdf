"""superPDF AI blob parser for LangChain."""

from __future__ import annotations

import os
import tempfile
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any, Literal

import superpdf
from langchain_core.document_loaders import BaseBlobParser
from langchain_core.documents import Document
from langchain_core.documents.base import Blob

DEFAULT_PAGES_DELIMITER = "\n-----\n\n"


class SuperPDFParser(BaseBlobParser):
    """Parse PDF blobs into Markdown Documents with superPDF AI, on your computer.

    Use it with ``GenericLoader`` or any blob loader. ``SuperPDFLoader`` uses it for local files.

    .. code-block:: python

        from langchain_community.document_loaders.generic import GenericLoader
        from langchain_superpdf import SuperPDFParser

        loader = GenericLoader.from_filesystem("papers", glob="**/*.pdf", parser=SuperPDFParser())
        docs = loader.load()
    """

    def __init__(
        self,
        *,
        mode: Literal["page", "single"] = "page",
        pages_delimiter: str = DEFAULT_PAGES_DELIMITER,
        pages: str | None = None,
        tables: Literal["markdown", "html"] = "markdown",
        ocr: bool = True,
        timeout: float | None = 600,
    ) -> None:
        """Initialize the parser.

        Args:
            mode: ``"page"`` for one Document per page (the default), ``"single"`` for one per PDF.
            pages_delimiter: Text placed between pages in ``"single"`` mode.
            pages: Pages to read, such as ``"1, 3-5"``; all pages when omitted.
            tables: ``"html"`` writes tables as HTML, keeping merged header cells.
            ocr: Read scanned pages (pages without a text layer) with OCR.
            timeout: Seconds before giving up on one PDF.
        """
        if mode not in ("page", "single"):
            raise ValueError(f'mode must be "page" or "single", not {mode!r}')
        if tables not in ("markdown", "html"):
            raise ValueError(f'tables must be "markdown" or "html", not {tables!r}')
        self.mode = mode
        self.pages_delimiter = pages_delimiter
        self.pages = pages
        self.tables = tables
        self.ocr = ocr
        self.timeout = timeout

    def lazy_parse(self, blob: Blob) -> Iterator[Document]:
        """Read one PDF: one Document per page, or one for the whole PDF with ``mode="single"``."""
        source = str(blob.source or blob.path or "")
        with _local_file(blob) as path:
            info = superpdf.info(path)
            read = superpdf.export_pages(
                path,
                pages=self.pages,
                tables="html" if self.tables == "html" else None,
                ocr=self.ocr,
                timeout=self.timeout,
            )
        metadata = _document_metadata(source, info)
        if self.mode == "single":
            text = self.pages_delimiter.join(page["markdown"] for page in read)
            yield Document(page_content=text, metadata=metadata)
            return
        for page in read:
            yield Document(
                page_content=page["markdown"],
                metadata={**metadata, "page": page["page"] - 1, "page_label": str(page["page"])},
            )


def _document_metadata(source: str, info: superpdf.PdfInfo) -> dict[str, Any]:
    """LangChain's standard PDF metadata: source, total_pages, creationdate, creator and producer, plus any
    title, author, subject and keywords the PDF sets. superPDF doesn't report dates, so creationdate is empty."""
    metadata: dict[str, Any] = {
        "source": source,
        "total_pages": info.get("pages", 0),
        "creationdate": "",
        "creator": info.get("creator") or "superPDF AI",
        "producer": info.get("producer") or "superPDF AI",
    }
    for key in ("title", "author", "subject", "keywords"):
        value = info.get(key)
        if value:
            metadata[key] = value
    return metadata


@contextmanager
def _local_file(blob: Blob) -> Iterator[str]:
    """A path to the blob's bytes: its own file when it has one, else a temporary copy (deleted afterwards)."""
    if blob.path is not None and blob.data is None and os.path.isfile(blob.path):
        yield os.fspath(blob.path)
        return
    handle, path = tempfile.mkstemp(suffix=".pdf")
    try:
        with os.fdopen(handle, "wb") as file:
            file.write(blob.as_bytes())
        yield path
    finally:
        os.unlink(path)
