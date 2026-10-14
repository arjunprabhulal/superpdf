"""superPDF AI blob parser for LangChain."""

from __future__ import annotations

import os
import tempfile
from contextlib import contextmanager
from pathlib import Path
from typing import TYPE_CHECKING, Any, Literal

import superpdf
from langchain_core.document_loaders import BaseBlobParser
from langchain_core.documents import Document

if TYPE_CHECKING:
    from collections.abc import Iterator

    from langchain_core.documents.base import Blob

# The same delimiter as LangChain's own PDF parsers.
DEFAULT_PAGES_DELIMITER = "\n\f"
_MODES = ("page", "single")
_TABLES = ("markdown", "html")


class SuperPDFParser(BaseBlobParser):
    """Parse PDF blobs into Markdown Documents with superPDF AI, on your computer.

    Use it for PDFs that arrive as bytes, or with any blob loader;
    ``SuperPDFLoader`` uses it for local files.

    Example:
        .. code-block:: python

            from langchain_core.documents.base import Blob
            from langchain_superpdf import SuperPDFParser

            blob = Blob.from_data(pdf_bytes, path="upload.pdf")
            docs = list(SuperPDFParser().lazy_parse(blob))
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
            mode: ``"page"`` for one Document per page (the default), or
                ``"single"`` for one Document per PDF.
            pages_delimiter: Text placed between pages in ``"single"`` mode.
            pages: Pages to read, such as ``"1, 3-5"``; all pages when omitted.
            tables: ``"html"`` writes tables as HTML, keeping merged header cells.
            ocr: Read scanned pages (pages without a text layer) with OCR.
            timeout: Seconds before giving up on one PDF.

        Raises:
            ValueError: If ``mode`` or ``tables`` is not one of its values.
        """
        if mode not in _MODES:
            msg = f'mode must be "page" or "single", not {mode!r}'
            raise ValueError(msg)
        if tables not in _TABLES:
            msg = f'tables must be "markdown" or "html", not {tables!r}'
            raise ValueError(msg)
        self.mode = mode
        self.pages_delimiter = pages_delimiter
        self.pages = pages
        self.tables = tables
        self.ocr = ocr
        self.timeout = timeout

    def lazy_parse(self, blob: Blob) -> Iterator[Document]:
        """Read one PDF: one Document per page, or one with ``mode="single"``.

        Args:
            blob: The PDF, as a file path or bytes.

        Yields:
            Documents with LangChain's standard PDF metadata.
        """
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
            number = page["page"]
            yield Document(
                page_content=page["markdown"],
                metadata={**metadata, "page": number - 1, "page_label": str(number)},
            )


def _document_metadata(source: str, info: superpdf.PdfInfo) -> dict[str, Any]:
    """LangChain's standard PDF metadata for one PDF.

    The standard keys (source, total_pages, creationdate, creator and producer),
    plus any title, author, subject and keywords the PDF sets. superPDF doesn't
    report dates, so creationdate is empty, as LangChain's parsers leave it when
    a PDF has none.
    """
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
    """A path to the blob's PDF: its own file, or a temporary copy of its bytes."""
    if blob.path is not None and blob.data is None and Path(blob.path).is_file():
        yield os.fspath(blob.path)
        return
    handle, name = tempfile.mkstemp(suffix=".pdf")
    path = Path(name)
    try:
        with os.fdopen(handle, "wb") as file:
            file.write(blob.as_bytes())
        yield name
    finally:
        path.unlink(missing_ok=True)
