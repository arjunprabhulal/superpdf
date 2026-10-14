"""superPDF AI document loader for LangChain."""

from __future__ import annotations

import os
from pathlib import Path
from typing import TYPE_CHECKING, Literal

from langchain_core.document_loaders import BaseLoader
from langchain_core.documents.base import Blob

from langchain_superpdf.parsers import DEFAULT_PAGES_DELIMITER, SuperPDFParser

if TYPE_CHECKING:
    from collections.abc import Iterable, Iterator

    from langchain_core.documents import Document

PathLike = str | os.PathLike[str]


class SuperPDFLoader(BaseLoader):
    r"""Load local PDFs as Markdown with superPDF AI, on your computer.

    Headings, lists and tables come out as Markdown (tables optionally as HTML),
    charts drawn in the PDF as tables of their values, and scanned pages are read
    with OCR. Nothing is uploaded.

    Examples:
        Setup:

        .. code-block:: bash

            pip install -U langchain-superpdf

        Instantiate the loader:

        .. code-block:: python

            from langchain_superpdf import SuperPDFLoader

            loader = SuperPDFLoader(
                "report.pdf",
                # mode="single",
                # pages_delimiter="\n\f",
                # pages="1-3",
                # tables="html",
                # ocr=False,
            )

        Lazy load documents:

        .. code-block:: python

            docs = []
            docs_lazy = loader.lazy_load()

            for doc in docs_lazy:
                docs.append(doc)
            print(docs[0].page_content[:100])
            print(docs[0].metadata)

        Load documents asynchronously:

        .. code-block:: python

            docs = await loader.aload()
            print(docs[0].page_content[:100])
            print(docs[0].metadata)
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
            mode: ``"page"`` for one Document per page (the default), or
                ``"single"`` for one Document per PDF.
            pages_delimiter: Text placed between pages in ``"single"`` mode.
            pages: Pages to read, such as ``"1, 3-5"``; all pages when omitted.
            tables: ``"html"`` writes tables as HTML, keeping merged header cells.
            ocr: Read scanned pages (pages without a text layer) with OCR.
            timeout: Seconds before giving up on one PDF.
        """
        paths = [file_path] if isinstance(file_path, (str, os.PathLike)) else file_path
        self.file_paths = [os.fspath(path) for path in paths]
        self.parser = SuperPDFParser(
            mode=mode,
            pages_delimiter=pages_delimiter,
            pages=pages,
            tables=tables,
            ocr=ocr,
            timeout=timeout,
        )

    def lazy_load(self) -> Iterator[Document]:
        """Load each PDF in turn.

        Yields:
            Documents with LangChain's standard PDF metadata.

        Raises:
            FileNotFoundError: If a path is not a file.
        """
        for path in self.file_paths:
            if not Path(path).is_file():
                msg = f"No PDF at {path}"
                raise FileNotFoundError(msg)
            yield from self.parser.lazy_parse(Blob.from_path(path))
