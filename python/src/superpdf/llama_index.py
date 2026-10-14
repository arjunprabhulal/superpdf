"""LlamaIndex reader: one Document per PDF page, read by superPDF.

pip install "superpdf[llama-index]"
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

try:
    from llama_index.core.readers.base import BaseReader
    from llama_index.core.schema import Document
except ImportError as error:  # pragma: no cover
    raise ImportError('SuperPDFReader needs llama-index-core: pip install "superpdf[llama-index]"') from error

from . import export_pages


class SuperPDFReader(BaseReader):
    """Reads a PDF as Markdown, one Document per page, with `file_path` and `page` in the metadata.

    Options are passed to superpdf.export: pages="1-3", tables="html", ocr=False.
    """

    def __init__(self, **options: Any) -> None:
        super().__init__()
        self._options = options

    def load_data(
        self, file: str | os.PathLike[str] | Path, extra_info: dict[str, Any] | None = None
    ) -> list[Document]:
        path = os.fspath(file)
        return [
            Document(text=page["markdown"], metadata={"file_path": path, "page": page["page"], **(extra_info or {})})
            for page in export_pages(path, **self._options)
        ]
