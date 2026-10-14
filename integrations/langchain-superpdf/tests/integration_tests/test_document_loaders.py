from __future__ import annotations

from pathlib import Path

import pytest

from langchain_superpdf import SuperPDFLoader


@pytest.mark.integration
def test_reads_the_example_report(real_cli: Path) -> None:
    [page] = SuperPDFLoader(real_cli).load()
    assert page.page_content.startswith("Q2 2026") or "# Quarterly report" in page.page_content
    assert "| North |" in page.page_content  # the table, as Markdown
    assert (page.metadata["page"], page.metadata["page_label"], page.metadata["total_pages"]) == (0, "1", 1)
    assert page.metadata["producer"]


@pytest.mark.integration
def test_html_tables_and_single_mode(real_cli: Path) -> None:
    [doc] = SuperPDFLoader(real_cli, mode="single", tables="html").load()
    assert "<table>" in doc.page_content and "page" not in doc.metadata
