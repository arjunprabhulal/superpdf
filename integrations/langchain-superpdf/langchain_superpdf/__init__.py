"""LangChain integration for superPDF AI: local PDFs as Markdown, page by page."""

from langchain_superpdf.document_loaders import SuperPDFLoader
from langchain_superpdf.parsers import SuperPDFParser

__version__ = "0.1.0"
__all__ = ["SuperPDFLoader", "SuperPDFParser", "__version__"]
