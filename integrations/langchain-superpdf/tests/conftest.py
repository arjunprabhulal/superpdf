"""Shared test setup: a stand-in for superpdf (unit tests) and the repository's real CLI (integration tests)."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import pytest
import superpdf

ROOT = Path(__file__).resolve().parents[3]
EXAMPLE = ROOT / "examples" / "quarterly-report.pdf"

INFO: superpdf.PdfInfo = {"pages": 3, "title": "Quarterly report", "author": "", "creator": "Writer", "producer": ""}
PAGES = [{"page": 1, "markdown": "# Quarterly report"}, {"page": 2, "markdown": "## Revenue"}]


class FakeSuperPDF:
    """Records each call and returns fixed results, so unit tests need neither Node.js nor a PDF engine."""

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
def real_cli(monkeypatch: pytest.MonkeyPatch) -> Path:
    """This repository's bin/superpdf.js when its dependencies are installed (as in CI), else the pinned release."""
    local = ROOT / "bin" / "superpdf.js"
    if not os.environ.get("SUPERPDF_BIN") and local.exists() and (ROOT / "node_modules").exists():
        monkeypatch.setenv("SUPERPDF_BIN", str(local))
    return EXAMPLE
