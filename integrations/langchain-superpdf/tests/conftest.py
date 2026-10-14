"""Shared test setup.

A stand-in for superpdf (unit tests) and this repository's CLI (integration tests).
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import pytest
import superpdf

ROOT = Path(__file__).resolve().parents[3]
EXAMPLE = ROOT / "examples" / "quarterly-report.pdf"

INFO: superpdf.PdfInfo = {
    "pages": 3,
    "title": "Quarterly report",
    "author": "",
    "creator": "Writer",
    "producer": "",
}
PAGES = [
    {"page": 1, "markdown": "# Quarterly report"},
    {"page": 2, "markdown": "## Revenue"},
]


class FakeSuperPDF:
    """Records each call and returns fixed results (no Node.js, no PDF engine)."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, str, dict[str, Any]]] = []

    def info(self, path: str) -> superpdf.PdfInfo:
        self.calls.append(("info", path, {}))
        return INFO

    def export_pages(self, path: str, **options: Any) -> list[dict[str, Any]]:
        self.calls.append(("export_pages", path, options))
        return PAGES


@pytest.fixture
def fake(monkeypatch: pytest.MonkeyPatch) -> FakeSuperPDF:
    stand_in = FakeSuperPDF()
    monkeypatch.setattr(superpdf, "info", stand_in.info)
    monkeypatch.setattr(superpdf, "export_pages", stand_in.export_pages)
    return stand_in


@pytest.fixture
def pdf(tmp_path: Path) -> Path:
    path = tmp_path / "report.pdf"
    path.write_bytes(b"%PDF-1.7")
    return path


@pytest.fixture
def example_pdf(monkeypatch: pytest.MonkeyPatch) -> Path:
    """The example report, read with this repository's CLI when it is built."""
    local = ROOT / "bin" / "superpdf.js"
    if (
        not os.environ.get("SUPERPDF_BIN")
        and local.exists()
        and (ROOT / "node_modules").exists()
    ):
        monkeypatch.setenv("SUPERPDF_BIN", str(local))
    return EXAMPLE
