from __future__ import annotations

from pathlib import Path

import fsspec
import pytest
from llama_index.core import SimpleDirectoryReader
from llama_index.core.readers.base import BaseReader

from llama_index.readers.superpdf import SuperPDFReader, __version__
from tests.conftest import FakeSuperPDF


def _pdf(folder: Path, name: str = "report.pdf") -> Path:
    path = folder / name
    path.write_bytes(b"%PDF-1.7")
    return path


def test_class() -> None:
    names_of_base_classes = [b.__name__ for b in SuperPDFReader.__mro__]
    assert BaseReader.__name__ in names_of_base_classes
    assert SuperPDFReader.class_name() == "SuperPDFReader" and __version__


def test_one_document_per_page_with_page_label_and_file_name(fake: FakeSuperPDF, tmp_path: Path) -> None:
    docs = SuperPDFReader().load_data(_pdf(tmp_path), extra_info={"team": "finance"})
    assert [d.text for d in docs] == ["# Quarterly report", "## Revenue"]
    assert docs[0].metadata == {"page_label": "1", "file_name": "report.pdf", "team": "finance"}


def test_full_document(fake: FakeSuperPDF, tmp_path: Path) -> None:
    [doc] = SuperPDFReader(return_full_document=True).load_data(_pdf(tmp_path))
    assert doc.text == "# Quarterly report\n\n## Revenue" and doc.metadata == {"file_name": "report.pdf"}


def test_options_reach_superpdf(fake: FakeSuperPDF, tmp_path: Path) -> None:
    SuperPDFReader(pages="1-2", tables="html", ocr=False, timeout=30).load_data(_pdf(tmp_path))
    assert fake.calls[0][1] == {"pages": "1-2", "tables": "html", "ocr": False, "timeout": 30}


def test_several_files_and_lazy_loading(fake: FakeSuperPDF, tmp_path: Path) -> None:
    files = [_pdf(tmp_path, "a.pdf"), _pdf(tmp_path, "b.pdf")]
    lazy = SuperPDFReader().lazy_load_data(files)
    assert not fake.calls  # nothing is read until iterated
    assert [d.metadata["file_name"] for d in lazy] == ["a.pdf", "a.pdf", "b.pdf", "b.pdf"]


def test_simple_directory_reader(fake: FakeSuperPDF, tmp_path: Path) -> None:
    _pdf(tmp_path, "a.pdf")
    docs = SimpleDirectoryReader(str(tmp_path), file_extractor={".pdf": SuperPDFReader()}).load_data()
    assert len(docs) == 2
    assert docs[0].metadata["page_label"] == "1" and docs[0].metadata["file_name"] == "a.pdf"


def test_other_filesystems_go_through_a_temporary_copy(fake: FakeSuperPDF) -> None:
    memory = fsspec.filesystem("memory")
    memory.pipe("/inbox/remote.pdf", b"%PDF-1.7")
    docs = SuperPDFReader().load_data("/inbox/remote.pdf", fs=memory)
    assert docs[0].metadata["file_name"] == "remote.pdf"
    temporary = fake.calls[0][0]
    assert temporary.endswith(".pdf") and not Path(temporary).exists()  # cleaned up


def test_a_missing_file_is_named(fake: FakeSuperPDF, tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError, match=r"missing\.pdf"):
        SuperPDFReader().load_data(tmp_path / "missing.pdf")


@pytest.mark.integration
def test_reads_the_example_report(real_cli: Path) -> None:
    [page] = SuperPDFReader().load_data(real_cli)
    assert "# Quarterly report" in page.text and "| North |" in page.text
    assert page.metadata == {"page_label": "1", "file_name": "quarterly-report.pdf"}
    [html] = SuperPDFReader(tables="html", return_full_document=True).load_data(real_cli)
    assert "<table>" in html.text
