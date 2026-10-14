from __future__ import annotations

from typing import TYPE_CHECKING

from langchain_superpdf import SuperPDFLoader

if TYPE_CHECKING:
    from pathlib import Path


def test_reads_the_example_report(example_pdf: Path) -> None:
    [page] = SuperPDFLoader(example_pdf).load()
    assert "# Quarterly report" in page.page_content
    assert "| North |" in page.page_content  # the table, as Markdown
    assert page.metadata["page"] == 0
    assert page.metadata["page_label"] == "1"
    assert page.metadata["total_pages"] == 1
    assert page.metadata["producer"]


def test_html_tables_and_single_mode(example_pdf: Path) -> None:
    [doc] = SuperPDFLoader(example_pdf, mode="single", tables="html").load()
    assert "<table>" in doc.page_content
    assert "page" not in doc.metadata
