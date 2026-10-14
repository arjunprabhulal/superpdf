"""superPDF AI reader for LlamaIndex: PDFs read on your computer as Markdown, page by page."""

from __future__ import annotations

import os
import tempfile
from collections.abc import Iterable, Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Literal

import superpdf
from fsspec import AbstractFileSystem
from llama_index.core.readers.base import BasePydanticReader
from llama_index.core.readers.file.base import is_default_fs
from llama_index.core.schema import Document

PathLike = str | Path


class SuperPDFReader(BasePydanticReader):
    """Read PDFs as Markdown with superPDF AI, on your computer.

    Headings, lists and tables come out as Markdown (tables optionally as HTML), charts drawn in the PDF as tables
    of their values, and scanned pages are read with OCR. Nothing is uploaded.

    One Document per page with ``page_label`` and ``file_name`` in the metadata, as LlamaIndex's PDFReader does, or
    one per PDF with ``return_full_document=True``. Works with ``SimpleDirectoryReader``:

    .. code-block:: python

        from llama_index.core import SimpleDirectoryReader
        from llama_index.readers.superpdf import SuperPDFReader

        reader = SimpleDirectoryReader("papers", file_extractor={".pdf": SuperPDFReader()})
        documents = reader.load_data()

    Args:
        return_full_document: One Document for the whole PDF instead of one per page.
        pages: Pages to read, such as ``"1, 3-5"``; all pages when omitted.
        tables: ``"html"`` writes tables as HTML, keeping merged header cells.
        ocr: Read scanned pages (pages without a text layer) with OCR.
        timeout: Seconds before giving up on one PDF.
    """

    is_remote: bool = False
    return_full_document: bool = False
    pages: str | None = None
    tables: Literal["markdown", "html"] = "markdown"
    ocr: bool = True
    timeout: float | None = 600

    @classmethod
    def class_name(cls) -> str:
        return "SuperPDFReader"

    def lazy_load_data(
        self,
        file: PathLike | Iterable[PathLike],
        extra_info: dict[str, Any] | None = None,
        fs: AbstractFileSystem | None = None,
    ) -> Iterator[Document]:
        """Read one PDF or several. ``extra_info`` is added to every Document's metadata."""
        files = [file] if isinstance(file, (str, os.PathLike)) else list(file)
        for one in files:
            name = Path(os.fspath(one)).name
            with _local_file(one, fs) as path:
                read = superpdf.export_pages(
                    path,
                    pages=self.pages,
                    tables="html" if self.tables == "html" else None,
                    ocr=self.ocr,
                    timeout=self.timeout,
                )
            if self.return_full_document:
                text = "\n\n".join(page["markdown"] for page in read)
                yield Document(text=text, metadata={"file_name": name, **(extra_info or {})})
                continue
            for page in read:
                metadata = {"page_label": str(page["page"]), "file_name": name, **(extra_info or {})}
                yield Document(text=page["markdown"], metadata=metadata)

    def load_data(
        self,
        file: PathLike | Iterable[PathLike],
        extra_info: dict[str, Any] | None = None,
        fs: AbstractFileSystem | None = None,
    ) -> list[Document]:
        """Read one PDF or several into a list of Documents."""
        return list(self.lazy_load_data(file, extra_info=extra_info, fs=fs))


@contextmanager
def _local_file(file: PathLike, fs: AbstractFileSystem | None) -> Iterator[str]:
    """A local path for the PDF: the file itself, or a temporary copy when it is on another filesystem."""
    if fs is None or is_default_fs(fs):
        path = os.fspath(file)
        if not os.path.isfile(path):
            raise FileNotFoundError(f"No PDF at {path}")
        yield path
        return
    handle, path = tempfile.mkstemp(suffix=".pdf")
    try:
        with os.fdopen(handle, "wb") as out, fs.open(str(file), "rb") as source:
            out.write(source.read())
        yield path
    finally:
        os.unlink(path)
