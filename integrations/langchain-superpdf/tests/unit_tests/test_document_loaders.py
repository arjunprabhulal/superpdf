from __future__ import annotations

from pathlib import Path

import pytest
from langchain_core.document_loaders import BaseBlobParser, BaseLoader
from langchain_core.documents.base import Blob

from langchain_superpdf import SuperPDFLoader, SuperPDFParser, __version__
from tests.conftest import FakeSuperPDF

STANDARD_KEYS = {"source", "total_pages", "creationdate", "creator", "producer"}


def test_public_api() -> None:
    assert issubclass(SuperPDFLoader, BaseLoader)
    assert issubclass(SuperPDFParser, BaseBlobParser)
    assert __version__


def test_one_document_per_page_with_standard_pdf_metadata(fake: FakeSuperPDF, tmp_path: Path) -> None:
    pdf = tmp_path / "report.pdf"
    pdf.write_bytes(b"%PDF-1.7")
    docs = SuperPDFLoader(pdf).load()
    assert [d.page_content for d in docs] == ["# Quarterly report", "## Revenue"]
    first = docs[0].metadata
    assert set(first) >= STANDARD_KEYS
    assert first["source"] == str(pdf)
    assert (first["page"], first["page_label"], first["total_pages"]) == (0, "1", 3)
    assert isinstance(first["page"], int)
    assert first["creator"] == "Writer" and first["producer"] == "superPDF AI" and first["creationdate"] == ""
    assert first["title"] == "Quarterly report" and "author" not in first  # empty properties are left out


def test_single_mode_joins_pages_with_the_delimiter(fake: FakeSuperPDF, tmp_path: Path) -> None:
    pdf = tmp_path / "report.pdf"
    pdf.write_bytes(b"%PDF-1.7")
    [doc] = SuperPDFLoader(pdf, mode="single", pages_delimiter="\n\n---\n\n").load()
    assert doc.page_content == "# Quarterly report\n\n---\n\n## Revenue"
    assert "page" not in doc.metadata and doc.metadata["total_pages"] == 3


def test_options_reach_superpdf(fake: FakeSuperPDF, tmp_path: Path) -> None:
    pdf = tmp_path / "report.pdf"
    pdf.write_bytes(b"%PDF-1.7")
    SuperPDFLoader(pdf, pages="1-2", tables="html", ocr=False, timeout=30).load()
    _, _, options = next(call for call in fake.calls if call[0] == "export_pages")
    assert options == {"pages": "1-2", "tables": "html", "ocr": False, "timeout": 30}


def test_several_files_in_order(fake: FakeSuperPDF, tmp_path: Path) -> None:
    paths = []
    for name in ("a.pdf", "b.pdf"):
        (tmp_path / name).write_bytes(b"%PDF-1.7")
        paths.append(tmp_path / name)
    docs = SuperPDFLoader(paths).load()
    assert [Path(d.metadata["source"]).name for d in docs] == ["a.pdf", "a.pdf", "b.pdf", "b.pdf"]


def test_a_missing_file_is_named(fake: FakeSuperPDF, tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError, match=r"missing\.pdf"):
        SuperPDFLoader(tmp_path / "missing.pdf").load()


def test_invalid_options_are_refused() -> None:
    with pytest.raises(ValueError, match="mode"):
        SuperPDFParser(mode="pages")  # type: ignore[arg-type]
    with pytest.raises(ValueError, match="tables"):
        SuperPDFParser(tables="csv")  # type: ignore[arg-type]


def test_parser_reads_in_memory_blobs_through_a_temporary_file(fake: FakeSuperPDF) -> None:
    docs = list(SuperPDFParser().lazy_parse(Blob.from_data(b"%PDF-1.7", path="upload.pdf")))
    assert len(docs) == 2 and docs[0].metadata["source"] == "upload.pdf"
    temporary = fake.calls[0][1]
    assert temporary.endswith(".pdf") and not Path(temporary).exists()  # cleaned up
