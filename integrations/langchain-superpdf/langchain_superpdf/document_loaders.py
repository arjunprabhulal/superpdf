"""superPDF AI document loader for LangChain."""

from __future__ import annotations

import os
from collections.abc import Iterable, Iterator
from typing import Literal

from langchain_core.document_loaders import BaseLoader
from langchain_core.documents import Document
from langchain_core.documents.base import Blob

from langchain_superpdf.parsers import DEFAULT_PAGES_DELIMITER, SuperPDFParser

PathLike = str | os.PathLike[str]


class SuperPDFLoader(BaseLoader):
    """Load local PDFs as Markdown with superPDF AI, on your computer.

    Headings, lists and tables come out as Markdown (tables optionally as HTML), charts drawn in the PDF as tables
    of their values, and scanned pages are read with OCR. Nothing is uploaded.

    Setup:
        Install ``langchain-superpdf``. Node.js comes with it; the first load installs the superPDF reader once.

        .. code-block:: bash

            pip install -U langchain-superpdf

    Instantiate:
        .. code-block:: python

            from langchain_superpdf import SuperPDFLoader

            loader = SuperPDFLoader(
                "report.pdf",
                # mode="single",     # one Document for the whole PDF
                # pages="1-3",       # only some pages
                # tables="html",     # tables as HTML, keeping merged header cells
                # ocr=False,         # skip OCR on scanned pages
            )

    Lazy load:
        .. code-block:: python

            for doc in loader.lazy_load():
                print(doc.metadata["page"], doc.page_content[:80])

    Load:
        .. code-block:: python

            docs = loader.load()
            docs[0].metadata
            # {"source": "report.pdf", "total_pages": 4, "creationdate": "", "creator": "…",
            #  "producer": "…", "page": 0, "page_label": "1"}
    """

    def __init__(
        self,
        file_path: PathLike | Iterable[PathLike],
        *,
        mode: Literal["page", "single"] = "page",
        pages_delimiter: str = DEFAULT_PAGES_DELIMITER,
        pages: str | None = None,
        tables: Literal["markdown", "html"] = "markdown",
        ocr: bool = True,
        timeout: float | None = 600,
    ) -> None:
        """Initialize the loader.

        Args:
            file_path: A local PDF path, or several.
            mode: ``"page"`` for one Document per page (the default), ``"single"`` for one per PDF.
            pages_delimiter: Text placed between pages in ``"single"`` mode.
            pages: Pages to read, such as ``"1, 3-5"``; all pages when omitted.
            tables: ``"html"`` writes tables as HTML, keeping merged header cells.
            ocr: Read scanned pages (pages without a text layer) with OCR.
            timeout: Seconds before giving up on one PDF.
        """
        paths = [file_path] if isinstance(file_path, (str, os.PathLike)) else list(file_path)
        self.file_paths = [os.fspath(path) for path in paths]
        self.parser = SuperPDFParser(
            mode=mode, pages_delimiter=pages_delimiter, pages=pages, tables=tables, ocr=ocr, timeout=timeout
        )

    def lazy_load(self) -> Iterator[Document]:
        """Load each PDF in turn."""
        for path in self.file_paths:
            if not os.path.isfile(path):
                raise FileNotFoundError(f"No PDF at {path}")
            yield from self.parser.lazy_parse(Blob.from_path(path))
