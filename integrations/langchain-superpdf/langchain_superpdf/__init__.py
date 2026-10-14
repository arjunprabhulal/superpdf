"""LangChain integration for superPDF AI: local PDFs as Markdown, page by page."""

from langchain_superpdf._version import __version__
from langchain_superpdf.document_loaders import SuperPDFLoader
from langchain_superpdf.parsers import SuperPDFParser

__all__ = [
    "SuperPDFLoader",
    "SuperPDFParser",
    "__version__",
]
