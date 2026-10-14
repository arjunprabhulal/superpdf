"""LangChain document loader: one Document per PDF page, read by superPDF.

pip install "superpdf[langchain]"
"""

from __future__ import annotations

import os
from collections.abc import Iterator
from typing import Any

try:
    from langchain_core.document_loaders import BaseLoader
    from langchain_core.documents import Document
except ImportError as error:  # pragma: no cover
    raise ImportError('SuperPDFLoader needs langchain-core: pip install "superpdf[langchain]"') from error

from . import export_pages


class SuperPDFLoader(BaseLoader):
    """Loads a PDF as Markdown, one Document per page, with `source` and `page` in the metadata.

    Options are passed to superpdf.export: pages="1-3", tables="html", ocr=False.
    """

    def __init__(self, file_path: str | os.PathLike[str], **options: Any) -> None:
        self.file_path = os.fspath(file_path)
        self.options = options

    def lazy_load(self) -> Iterator[Document]:
        for page in export_pages(self.file_path, **self.options):
            yield Document(page_content=page["markdown"], metadata={"source": self.file_path, "page": page["page"]})
