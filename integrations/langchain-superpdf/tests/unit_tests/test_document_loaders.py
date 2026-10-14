from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING

import pytest
from langchain_core.document_loaders import BaseBlobParser, BaseLoader
from langchain_core.documents.base import Blob

from langchain_superpdf import SuperPDFLoader, SuperPDFParser

if TYPE_CHECKING:
    from tests.conftest import FakeSuperPDF

STANDARD_KEYS = {"source", "total_pages", "creationdate", "creator", "producer"}


def test_base_classes() -> None:
    assert issubclass(SuperPDFLoader, BaseLoader)
    assert issubclass(SuperPDFParser, BaseBlobParser)


@pytest.mark.usefixtures("fake")
def test_one_document_per_page_with_standard_metadata(pdf: Path) -> None:
    docs = SuperPDFLoader(pdf).load()
    assert [d.page_content for d in docs] == ["# Quarterly report", "## Revenue"]
    first = docs[0].metadata
    assert set(first) >= STANDARD_KEYS
    assert first["source"] == str(pdf)
    assert first["page"] == 0
    assert isinstance(first["page"], int)
    assert first["page_label"] == "1"
    assert first["total_pages"] == 3
    assert first["creator"] == "Writer"
    assert first["producer"] == "superPDF AI"
    assert first["creationdate"] == ""
    assert first["title"] == "Quarterly report"
    assert "author" not in first  # empty properties are left out


@pytest.mark.usefixtures("fake")
def test_single_mode_defaults_to_langchains_page_delimiter(pdf: Path) -> None:
    [doc] = SuperPDFLoader(pdf, mode="single").load()
    assert doc.page_content == "# Quarterly report\n\f## Revenue"
    assert "page" not in doc.metadata
    assert doc.metadata["total_pages"] == 3


@pytest.mark.usefixtures("fake")
def test_single_mode_with_a_custom_delimiter(pdf: Path) -> None:
    [doc] = SuperPDFLoader(pdf, mode="single", pages_delimiter="\n---\n").load()
    assert doc.page_content == "# Quarterly report\n---\n## Revenue"


def test_options_reach_superpdf(fake: FakeSuperPDF, pdf: Path) -> None:
    SuperPDFLoader(pdf, pages="1-2", tables="html", ocr=False, timeout=30).load()
    _, _, options = next(call for call in fake.calls if call[0] == "export_pages")
    assert options == {"pages": "1-2", "tables": "html", "ocr": False, "timeout": 30}


@pytest.mark.usefixtures("fake")
def test_several_files_in_order(tmp_path: Path) -> None:
    paths = []
    for name in ("a.pdf", "b.pdf"):
        (tmp_path / name).write_bytes(b"%PDF-1.7")
        paths.append(tmp_path / name)
    names = [Path(d.metadata["source"]).name for d in SuperPDFLoader(paths).load()]
    assert names == ["a.pdf", "a.pdf", "b.pdf", "b.pdf"]


@pytest.mark.usefixtures("fake")
def test_a_missing_file_is_named(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError, match=r"missing\.pdf"):
        SuperPDFLoader(tmp_path / "missing.pdf").load()


def test_invalid_options_are_refused() -> None:
    with pytest.raises(ValueError, match="mode"):
        SuperPDFParser(mode="pages")  # type: ignore[arg-type]
    with pytest.raises(ValueError, match="tables"):
        SuperPDFParser(tables="csv")  # type: ignore[arg-type]


def test_parser_reads_bytes_through_a_temporary_file(fake: FakeSuperPDF) -> None:
    blob = Blob.from_data(b"%PDF-1.7", path="upload.pdf")
    docs = list(SuperPDFParser().lazy_parse(blob))
    assert len(docs) == 2
    assert docs[0].metadata["source"] == "upload.pdf"
    temporary = fake.calls[0][1]
    assert temporary.endswith(".pdf")
    assert not Path(temporary).exists()  # removed afterwards


@pytest.mark.usefixtures("fake")
async def test_async_load(pdf: Path) -> None:
    docs = await SuperPDFLoader(pdf).aload()
    assert [doc.metadata["page_label"] for doc in docs] == ["1", "2"]
