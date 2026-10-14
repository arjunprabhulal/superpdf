from pathlib import Path

import pytest

from langchain_superpdf import __version__


def test_version_matches_pyproject() -> None:
    tomllib = pytest.importorskip("tomllib")  # Python 3.11+
    pyproject = Path(__file__).resolve().parents[2] / "pyproject.toml"
    with pyproject.open("rb") as file:
        assert tomllib.load(file)["project"]["version"] == __version__
