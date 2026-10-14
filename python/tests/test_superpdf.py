from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest

import superpdf
from superpdf import _cli

ROOT = Path(__file__).resolve().parents[2]
EXAMPLE = ROOT / "examples" / "quarterly-report.pdf"
TWO_PAGES = "# One\n\nFirst page.\n\n<!-- end of page 1 -->\n\nSecond page.\n\n<!-- end of page 2 -->\n"


class Recorder:
    """Stands in for subprocess.run and records each command."""

    def __init__(self, stdout: str = "", stderr: str = "", returncode: int = 0) -> None:
        self.calls: list[list[str]] = []
        self.result = subprocess.CompletedProcess([], returncode, stdout, stderr)

    def __call__(self, cmd: list[str], **kwargs: Any) -> subprocess.CompletedProcess[str]:
        assert kwargs.get("shell") in (None, False)
        self.calls.append(cmd)
        return self.result


@pytest.fixture
def fake(monkeypatch: pytest.MonkeyPatch) -> Recorder:
    recorder = Recorder(stdout=TWO_PAGES)
    monkeypatch.setattr(_cli, "command", lambda: ["superpdf"])
    monkeypatch.setattr(_cli.subprocess, "run", recorder)
    return recorder


def test_export_passes_the_options(fake: Recorder) -> None:
    superpdf.export("a.pdf", pages="1,3-5", tables="html", ocr=False)
    assert fake.calls == [
        ["superpdf", "export", "a.pdf", "--format", "markdown", "--pages", "1,3-5", "--tables", "html", "--no-ocr"]
    ]


def test_export_accepts_paths(fake: Recorder) -> None:
    superpdf.export(Path("dir") / "b.pdf", "html")
    assert fake.calls[0][2:5] == [os.fspath(Path("dir") / "b.pdf"), "--format", "html"]


@pytest.mark.parametrize(
    "kwargs",
    [{"format": "docx"}, {"tables": "csv"}, {"format": "json", "tables": "html"}],
)
def test_export_rejects_bad_options(fake: Recorder, kwargs: dict[str, Any]) -> None:
    with pytest.raises(ValueError):
        superpdf.export("a.pdf", **kwargs)
    assert fake.calls == []


def test_export_pages_splits_on_page_markers(fake: Recorder) -> None:
    assert superpdf.export_pages("a.pdf") == [
        {"page": 1, "markdown": "# One\n\nFirst page."},
        {"page": 2, "markdown": "Second page."},
    ]


def test_export_json_parses_the_structure(fake: Recorder) -> None:
    fake.result = subprocess.CompletedProcess([], 0, json.dumps({"title": "T", "pageCount": 1, "pages": []}), "")
    assert superpdf.export_json("a.pdf")["pageCount"] == 1
    assert fake.calls[0][3:5] == ["--format", "json"]


def test_errors_carry_the_last_stderr_line(fake: Recorder) -> None:
    fake.result = subprocess.CompletedProcess([], 1, "", "superPDF: reading page 1\nsuperPDF: No file at a.pdf.\n")
    with pytest.raises(superpdf.SuperPDFError, match=r"^No file at a\.pdf\.$"):
        superpdf.export("a.pdf")


def test_timeout_becomes_a_superpdf_error(monkeypatch: pytest.MonkeyPatch) -> None:
    def slow(cmd: list[str], **kwargs: Any) -> None:
        raise subprocess.TimeoutExpired(cmd, kwargs["timeout"])

    monkeypatch.setattr(_cli, "command", lambda: ["superpdf"])
    monkeypatch.setattr(_cli.subprocess, "run", slow)
    with pytest.raises(superpdf.SuperPDFError, match="within 5 seconds"):
        superpdf.export("a.pdf", timeout=5)


# Finding and installing the CLI


def test_superpdf_bin_wins(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    binary = tmp_path / "superpdf"
    binary.write_text("")
    monkeypatch.setenv("SUPERPDF_BIN", str(binary))
    assert _cli.command() == [str(binary)]


def test_superpdf_bin_js_runs_with_node(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    script = tmp_path / "superpdf.js"
    script.write_text("")
    monkeypatch.setenv("SUPERPDF_BIN", str(script))
    monkeypatch.setattr(_cli, "_node", lambda: ("/opt/node", None))
    assert _cli.command() == ["/opt/node", str(script)]


def test_missing_superpdf_bin_is_explained(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("SUPERPDF_BIN", str(tmp_path / "nope"))
    with pytest.raises(superpdf.SuperPDFError, match="doesn't exist"):
        _cli.command()


def test_cache_dir_can_be_set(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("SUPERPDF_CACHE_DIR", str(tmp_path))
    assert _cli.cache_dir() == tmp_path


@pytest.fixture
def npm_install(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> list[list[str]]:
    """A fake npm that 'installs' the CLI into --prefix, in a temporary cache folder."""
    calls: list[list[str]] = []

    def fake_run(cmd: list[str], **kwargs: Any) -> subprocess.CompletedProcess[str]:
        calls.append(cmd)
        prefix = Path(cmd[cmd.index("--prefix") + 1])
        script = prefix / "node_modules" / "@superpdf" / "cli" / "bin" / "superpdf.js"
        script.parent.mkdir(parents=True)
        script.write_text("")
        return subprocess.CompletedProcess(cmd, 0, "", "")

    monkeypatch.delenv("SUPERPDF_BIN", raising=False)
    monkeypatch.setenv("SUPERPDF_CACHE_DIR", str(tmp_path))
    monkeypatch.setattr(_cli, "_node", lambda: ("/opt/node", ["/opt/node", "/opt/npm-cli.js"]))
    monkeypatch.setattr(_cli.subprocess, "run", fake_run)
    return calls


def test_cli_is_installed_once_at_the_pinned_version(npm_install: list[list[str]], tmp_path: Path) -> None:
    first = _cli.command()
    second = _cli.command()
    assert first == second == ["/opt/node", str(_cli._script(tmp_path / f"cli-{_cli.CLI_VERSION}"))]
    assert len(npm_install) == 1
    install = npm_install[0]
    assert install[:3] == ["/opt/node", "/opt/npm-cli.js", "install"]
    assert install[-1] == f"@superpdf/cli@{_cli.CLI_VERSION}"
    assert "--ignore-scripts" in install
    assert not [p for p in tmp_path.iterdir() if p.name.startswith(".cli-")]  # no staging folder left behind


def test_failed_install_is_explained_and_leaves_nothing(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.delenv("SUPERPDF_BIN", raising=False)
    monkeypatch.setenv("SUPERPDF_CACHE_DIR", str(tmp_path))
    monkeypatch.setattr(_cli, "_node", lambda: ("/opt/node", ["npm"]))
    monkeypatch.setattr(
        _cli.subprocess, "run", lambda cmd, **kw: subprocess.CompletedProcess(cmd, 1, "", "npm error network\n")
    )
    with pytest.raises(superpdf.SuperPDFError, match=r"Couldn't install @superpdf/cli@.*npm error network"):
        superpdf.install_cli()
    assert list(tmp_path.iterdir()) == []


def test_missing_node_is_explained(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setitem(sys.modules, "nodejs_wheel", None)  # as if nodejs-wheel-binaries weren't installed
    monkeypatch.setattr(_cli.shutil, "which", lambda name: None)
    with pytest.raises(superpdf.SuperPDFError, match=r"Node\.js wasn't found"):
        _cli._node()


def test_old_node_is_explained(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setitem(sys.modules, "nodejs_wheel", None)
    monkeypatch.setattr(_cli.shutil, "which", {"node": "/usr/bin/node"}.get)
    monkeypatch.setattr(_cli, "_output", lambda cmd, timeout: "v18.19.0\n")
    with pytest.raises(superpdf.SuperPDFError, match=r"this computer has v18\.19\.0"):
        _cli._node()


def _wheel(root: Path, files: list[str]) -> Path:
    for name in files:
        (root / name).parent.mkdir(parents=True, exist_ok=True)
        (root / name).write_text("")
    return root


@pytest.mark.parametrize(
    ("windows", "node", "npm"),
    [
        (True, "node.exe", "lib/node_modules/npm/bin/npm-cli.js"),  # the Windows wheel (24.x)
        (False, "bin/node", "lib/node_modules/npm/bin/npm-cli.js"),  # macOS and Linux wheels
        (True, "node.exe", "node_modules/npm/bin/npm-cli.js"),  # an older Windows layout
    ],
)
def test_bundled_layouts(tmp_path: Path, windows: bool, node: str, npm: str) -> None:
    root = _wheel(tmp_path, [node, npm])
    assert _cli._bundled(root, windows=windows) == (str(root / node), [str(root / node), str(root / npm)])


def test_bundled_without_node_is_skipped(tmp_path: Path) -> None:
    assert _cli._bundled(_wheel(tmp_path, ["lib/node_modules/npm/bin/npm-cli.js"]), windows=True) is None


def test_real_windows_wheel_layout(tmp_path: Path) -> None:
    """The file names inside the published win_amd64 wheel, when it has been downloaded for this check."""
    import zipfile

    wheel = os.environ.get("SUPERPDF_WINDOWS_WHEEL")
    if not wheel:
        pytest.skip("set SUPERPDF_WINDOWS_WHEEL to a nodejs_wheel_binaries win_amd64 wheel to check its layout")
    names = [
        n.removeprefix("nodejs_wheel/") for n in zipfile.ZipFile(wheel).namelist() if n.startswith("nodejs_wheel/")
    ]
    wanted = [
        n for n in names if n in ("node.exe", "lib/node_modules/npm/bin/npm-cli.js", "node_modules/npm/bin/npm-cli.js")
    ]
    found = _cli._bundled(_wheel(tmp_path, wanted), windows=True)
    assert found is not None and found[1] is not None


def test_bundled_node_is_used() -> None:
    pytest.importorskip("nodejs_wheel")
    node, npm = _cli._node()
    assert Path(node).exists() and npm is not None
    assert int(_cli._output([node, "--version"], timeout=30).lstrip("v").split(".")[0]) >= _cli.NODE_MAJOR


# Loaders


def test_langchain_loader(fake: Recorder) -> None:
    pytest.importorskip("langchain_core")
    from superpdf.langchain import SuperPDFLoader

    docs = SuperPDFLoader("a.pdf", ocr=False).load()
    assert [d.metadata for d in docs] == [{"source": "a.pdf", "page": 1}, {"source": "a.pdf", "page": 2}]
    assert docs[1].page_content == "Second page."
    assert "--no-ocr" in fake.calls[0]


def test_llama_index_reader(fake: Recorder) -> None:
    pytest.importorskip("llama_index.core")
    from superpdf.llama_index import SuperPDFReader

    docs = SuperPDFReader().load_data("a.pdf", extra_info={"team": "finance"})
    assert [d.metadata for d in docs] == [
        {"file_path": "a.pdf", "page": 1, "team": "finance"},
        {"file_path": "a.pdf", "page": 2, "team": "finance"},
    ]


# The real CLI: the repository's own bin/superpdf.js, or an installed superpdf.


@pytest.fixture
def real_cli(monkeypatch: pytest.MonkeyPatch) -> None:
    # A source checkout with its dependencies installed tests that code; otherwise the pinned npm release is
    # installed with the bundled Node.js, exactly as for users.
    local = ROOT / "bin" / "superpdf.js"
    if not os.environ.get("SUPERPDF_BIN") and local.exists() and (ROOT / "node_modules").exists():
        monkeypatch.setenv("SUPERPDF_BIN", str(local))


@pytest.mark.integration
def test_real_export(real_cli: None) -> None:
    pages = superpdf.export_pages(EXAMPLE)
    assert [p["page"] for p in pages] == [1]
    assert "# Quarterly report" in pages[0]["markdown"]
    assert "| North | 120 | 150 | +25% |" in pages[0]["markdown"]


@pytest.mark.integration
def test_real_html_tables_and_json(real_cli: None) -> None:
    html = superpdf.export(EXAMPLE, tables="html")
    assert "<tr><td>North</td><td>120</td><td>150</td><td>+25%</td></tr>" in html
    structure = superpdf.export_json(EXAMPLE)
    assert structure["pageCount"] == 1
    assert {block["type"] for block in structure["pages"][0]["blocks"]} >= {"heading", "table"}


@pytest.mark.integration
def test_real_error(real_cli: None, tmp_path: Path) -> None:
    with pytest.raises(superpdf.SuperPDFError, match="No file at"):
        superpdf.export(tmp_path / "missing.pdf")
