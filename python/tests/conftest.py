"""Shared test setup: the example PDF and the real superPDF CLI."""

from __future__ import annotations

import os
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
EXAMPLE = ROOT / "examples" / "quarterly-report.pdf"


@pytest.fixture
def real_cli(monkeypatch: pytest.MonkeyPatch) -> None:
    """The repository's own bin/superpdf.js when its dependencies are installed (as in CI), so a change is tested on
    its own code; otherwise the pinned npm release, installed with the bundled Node.js as for users."""
    local = ROOT / "bin" / "superpdf.js"
    if not os.environ.get("SUPERPDF_BIN") and local.exists() and (ROOT / "node_modules").exists():
        monkeypatch.setenv("SUPERPDF_BIN", str(local))
