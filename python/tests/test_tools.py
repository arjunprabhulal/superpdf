"""The typed tool functions: in step with the CLI's schemas, and each one run for real on PDFs."""

from __future__ import annotations

import inspect
import json
import shutil
import subprocess
import types
import typing
import zipfile
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest

import superpdf
from superpdf import _cli

EXAMPLE = Path(__file__).resolve().parents[2] / "examples" / "quarterly-report.pdf"

# Each tool and its Python function. Python names the input file `path`; everything else keeps the tool's names.
FUNCTIONS: dict[str, Callable[..., Any]] = {
    "pdf_list_files": superpdf.list_files,
    "pdf_info": superpdf.info,
    "pdf_read_text": superpdf.read_text,
    "pdf_extract_structure": superpdf.extract_structure,
    "pdf_merge": superpdf.merge,
    "pdf_extract_pages": superpdf.extract_pages,
    "pdf_remove_pages": superpdf.remove_pages,
    "pdf_rotate_pages": superpdf.rotate_pages,
    "pdf_add_page_labels": superpdf.add_page_labels,
    "pdf_add_watermark": superpdf.add_watermark,
    "pdf_split": superpdf.split,
    "pdf_from_office": superpdf.from_office,
    "pdf_remove_metadata": superpdf.remove_metadata,
    "pdf_repair": superpdf.repair,
    "pdf_protect": superpdf.protect,
    "pdf_unlock": superpdf.unlock,
    "pdf_run_pipeline": superpdf.run_pipeline,
    "pdf_run_batch": superpdf.run_batch,
    "pdf_to_docx": superpdf.to_docx,
    "pdf_extract_tables": superpdf.extract_tables,
    "pdf_fill_form": superpdf.fill_form,
    "pdf_add_text": superpdf.add_text,
    "pdf_flatten": superpdf.flatten,
    "pdf_resize_pages": superpdf.resize_pages,
    "pdf_from_images": superpdf.from_images,
    "pdf_from_markdown": superpdf.from_markdown,
    "pdf_to_pptx": superpdf.to_pptx,
    "pdf_to_epub": superpdf.to_epub,
    "pdf_compare": superpdf.compare,
    "pdf_outline": superpdf.outline,
}
RENAMED = {"path": "input"}
PYTHON_ONLY = {"timeout"}


def _parameters(function: Callable[..., Any]) -> dict[str, inspect.Parameter]:
    return {
        RENAMED.get(name, name): p
        for name, p in inspect.signature(function).parameters.items()
        if name not in PYTHON_ONLY
    }


def _literals(annotation: Any) -> set[Any] | None:
    """The values of a Literal annotation (also inside `X | None`), else None."""
    if typing.get_origin(annotation) is typing.Literal:
        return set(typing.get_args(annotation))
    if typing.get_origin(annotation) in (typing.Union, types.UnionType):
        for arg in typing.get_args(annotation):
            values = _literals(arg)
            if values is not None:
                return values
    return None


@pytest.fixture(scope="module")
def schemas() -> dict[str, dict[str, Any]]:
    root = Path(__file__).resolve().parents[2]
    local = root / "bin" / "superpdf.js"
    if not (local.exists() and (root / "node_modules").exists()):
        pytest.skip("needs the repository's CLI with its dependencies (npm ci at the repository root)")
    node, _ = _cli._node()
    out = subprocess.run([node, str(local), "tools"], capture_output=True, check=True, encoding="utf-8").stdout
    return {tool["name"]: tool["input_schema"] for tool in json.loads(out)}


@pytest.mark.integration
def test_every_tool_has_a_function(schemas: dict[str, dict[str, Any]]) -> None:
    assert set(schemas) == set(FUNCTIONS)


@pytest.mark.integration
@pytest.mark.parametrize("name", sorted(FUNCTIONS))
def test_function_matches_the_schema(schemas: dict[str, dict[str, Any]], name: str) -> None:
    schema, params = schemas[name], _parameters(FUNCTIONS[name])
    fields = set(schema.get("properties", {}))
    assert set(params) == fields, f"{name}: Python parameters differ from the tool's fields"
    required = set(schema.get("required", []))
    python_required = {field for field, p in params.items() if p.default is inspect.Parameter.empty}
    assert python_required == required, f"{name}: required parameters differ"
    hints = typing.get_type_hints(FUNCTIONS[name])
    for field, prop in schema.get("properties", {}).items():
        allowed = prop.get("enum") or [o["const"] for o in prop.get("anyOf", []) if "const" in o] or None
        python_name = next(k for k, v in RENAMED.items() if v == field) if field in RENAMED.values() else field
        if allowed:
            assert _literals(hints[python_name]) == set(allowed), f"{name}.{field}: allowed values differ"


# How a call is made (no Node.js needed)


def test_run_tool_sends_json_on_stdin_and_allows_each_folder(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    calls: list[tuple[list[str], str | None]] = []

    def fake_run(args: list[str], timeout: float | None = 600, stdin: str | None = None) -> str:
        calls.append((args, stdin))
        return json.dumps({"value": {"output": "x", "pages": 1, "bytes": 1}, "files": []})

    monkeypatch.setattr(superpdf._tools, "run", fake_run)
    (tmp_path / "in").mkdir()
    pdf = tmp_path / "in" / "a.pdf"
    out = tmp_path / "new" / "deeper" / "b.pdf"  # folder doesn't exist yet: its nearest existing parent is allowed
    superpdf.rotate_pages(pdf, out, angle=180)
    args, stdin = calls[0]
    assert args[:4] == ["tool", "pdf_rotate_pages", "--input", "-"]
    allowed = [args[i + 1] for i, a in enumerate(args) if a == "--allow-dir"]
    assert allowed == [str((tmp_path / "in").resolve()), str(tmp_path.resolve())]
    assert json.loads(stdin or "") == {"input": str(pdf.resolve()), "angle": 180, "output": str(out.resolve())}


# Every tool, for real


@pytest.fixture
def work(real_cli: None, tmp_path: Path) -> Path:
    shutil.copy(EXAMPLE, tmp_path / "one.pdf")
    superpdf.merge([tmp_path / "one.pdf"] * 3, tmp_path / "three.pdf")
    return tmp_path


@pytest.mark.integration
def test_reading_tools(work: Path) -> None:
    assert superpdf.info(work / "three.pdf")["pages"] == 3
    names = [Path(f["path"]).name for f in superpdf.list_files(work)["files"]]
    assert {"one.pdf", "three.pdf"} <= set(names)
    text = superpdf.read_text(work / "one.pdf")
    assert text["has_text"] and "Quarterly report" in text["pages"][0]["text"]
    structure = superpdf.extract_structure(work / "one.pdf", format="html")
    assert structure["format"] == "html" and "<table" in structure["content"]
    assert structure["sections"][0]["title"] == "Quarterly report"


@pytest.mark.integration
def test_page_tools(work: Path) -> None:
    three = work / "three.pdf"
    assert superpdf.extract_pages(three, "2-3", work / "e.pdf")["pages"] == 2
    assert superpdf.remove_pages(three, "1", work / "r.pdf")["pages"] == 2
    superpdf.rotate_pages(three, work / "rot.pdf", pages="2", angle=180)
    assert [d["rotation"] for d in superpdf.info(work / "rot.pdf")["dimensions"]] == [0, 180, 0]
    parts = superpdf.split(three, work / "parts", mode="pages")["outputs"]
    assert len(parts) == 3 and all(Path(p["output"]).exists() for p in parts)


@pytest.mark.integration
def test_changing_tools(work: Path) -> None:
    one = work / "one.pdf"
    assert superpdf.add_page_labels(one, work / "l.pdf", text="Page {page} of {total}", position="top")["pages"] == 1
    assert superpdf.add_watermark(one, "DRAFT", work / "w.pdf")["pages"] == 1
    assert superpdf.remove_metadata(one, work / "m.pdf")["pages"] == 1
    assert superpdf.repair(one, work / "fixed.pdf")["fixed"] == []
    superpdf.protect(one, "correct horse battery", work / "locked.pdf")
    with pytest.raises(superpdf.SuperPDFError):
        superpdf.info(work / "locked.pdf")
    assert superpdf.unlock(work / "locked.pdf", work / "open.pdf", password="correct horse battery")["pages"] == 1
    assert superpdf.info(work / "open.pdf")["pages"] == 1


@pytest.mark.integration
def test_pipeline_and_batch(work: Path) -> None:
    steps: list[superpdf.PipelineStep] = [
        {"action": "extract", "options": {"pages": "1-2"}},
        {"action": "watermark", "options": {"text": "COPY"}},
    ]
    assert superpdf.run_pipeline(work / "three.pdf", steps, work / "p.pdf")["pages"] == 2
    result = superpdf.run_batch([work / "one.pdf", work / "three.pdf"], steps, work / "batch", suffix="copy")
    # one.pdf has a single page, so "extract 1-2" fails for it: it is listed in failed and the batch carries on.
    assert [Path(o["output"]).name for o in result["outputs"]] == ["three-copy.pdf"]
    assert [Path(f["input"]).name for f in result["failed"]] == ["one.pdf"]


@pytest.mark.integration
def test_converting_tools(work: Path) -> None:
    one = work / "one.pdf"
    word = superpdf.to_docx(one, work / "one.docx")
    assert word["tables"] >= 1 and zipfile.is_zipfile(word["output"])
    assert superpdf.to_pptx(one, work / "one.pptx")["slides"] == 1
    assert superpdf.to_epub(one, work / "one.epub", author="Northwind")["chapters"] >= 1
    assert superpdf.extract_tables(one, work / "tables.xlsx")["tables"] >= 1
    tables = superpdf.extract_tables(one, work / "tables.csv", format="csv")
    assert tables["format"] == "csv" and (work / "tables.csv").read_text(encoding="utf-8").strip()
    with pytest.raises(superpdf.SuperPDFError, match=r"\.md"):
        superpdf.extract_tables(one, work / "tables.txt", format="markdown")

    (work / "notes.md").write_text("# Launch notes\n\nsuperPDF converts *Markdown* too.\n", encoding="utf-8")
    assert superpdf.from_markdown(work / "notes.md", work / "notes.pdf", page_size="Letter")["pages"] == 1
    assert "Launch notes" in superpdf.read_text(work / "notes.pdf")["pages"][0]["text"]
    (work / "dot.png").write_bytes(_png())
    assert superpdf.from_images([work / "dot.png", work / "dot.png"], work / "images.pdf")["pages"] == 2


@pytest.mark.integration
def test_editing_and_comparing_tools(work: Path) -> None:
    one = work / "one.pdf"
    superpdf.add_text(one, "Signed: Ada Lovelace", work / "signed.pdf", x=72, y=100)
    assert "Signed: Ada Lovelace" in superpdf.read_text(work / "signed.pdf")["pages"][0]["text"]
    assert superpdf.resize_pages(one, work / "crop.pdf", mode="crop", margin=36)["pages"] == 1
    assert superpdf.resize_pages(one, work / "half.pdf", mode="scale", factor=0.5)["pages"] == 1
    assert superpdf.flatten(one, work / "flat.pdf")["pages"] == 1
    with pytest.raises(superpdf.SuperPDFError, match="Nope"):
        superpdf.fill_form(one, {"Nope": "x"}, work / "filled.pdf")

    same = superpdf.compare(one, one)
    assert {p["status"] for p in same["pages"]} == {"same"}
    longer = superpdf.compare(one, work / "three.pdf")
    assert [p["status"] for p in longer["pages"]] == ["same", "added", "added"]
    outline = superpdf.outline(one)
    assert outline["format"] == "markdown" and "Quarterly report" in outline["content"]
    assert json.loads(superpdf.outline(one, format="json")["content"]) == outline["sections"]


def _png() -> bytes:
    """A 2x2 white PNG."""
    import struct
    import zlib

    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))

    pixels = zlib.compress(b"\x00\xff\xff\xff\xff\xff\xff" * 2)
    header = struct.pack(">IIBBBBB", 2, 2, 8, 2, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", pixels) + chunk(b"IEND", b"")


OFFICE_DOCUMENT = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument"


def _minimal_docx(path: Path, text: str) -> None:
    """The smallest Word file LibreOffice opens: one paragraph."""
    with zipfile.ZipFile(path, "w") as docx:
        docx.writestr(
            "[Content_Types].xml",
            '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
            '<Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" '
            'ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
        )
        docx.writestr(
            "_rels/.rels",
            '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            f'<Relationship Id="r1" Type="{OFFICE_DOCUMENT}" '
            'Target="word/document.xml"/></Relationships>',
        )
        docx.writestr(
            "word/document.xml",
            '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
            f"<w:body><w:p><w:r><w:t>{text}</w:t></w:r></w:p></w:body></w:document>",
        )


@pytest.mark.integration
def test_from_office(real_cli: None, tmp_path: Path) -> None:
    if not (shutil.which("soffice") or Path("/Applications/LibreOffice.app").exists()):
        pytest.skip("LibreOffice isn't installed")
    _minimal_docx(tmp_path / "note.docx", "Converted by superPDF")
    result = superpdf.from_office(tmp_path / "note.docx", tmp_path / "note.pdf")
    assert result["pages"] == 1 and result["engine"]
    assert "Converted by superPDF" in superpdf.read_text(tmp_path / "note.pdf")["pages"][0]["text"]


@pytest.mark.integration
def test_safety(work: Path) -> None:
    with pytest.raises(superpdf.SuperPDFError, match="already exists"):
        superpdf.merge([work / "one.pdf", work / "one.pdf"], work / "three.pdf")
    with pytest.raises(superpdf.SuperPDFError, match=r"angle: use 90, 180 or 270"):
        superpdf.run_tool("pdf_rotate_pages", {"input": "one.pdf", "angle": 45, "output": "x.pdf"}, allow=[work])
    with pytest.raises(superpdf.SuperPDFError, match="no tool called"):
        superpdf.run_tool("pdf_nope", {}, allow=[work])
    assert {t["name"] for t in superpdf.tools()} == set(FUNCTIONS)
