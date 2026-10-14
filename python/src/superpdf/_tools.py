"""Every superPDF tool as a Python function.

These run the same tools as the MCP server and the local API (`superpdf tool <name>` in the CLI), with the same
validation and results. Outputs are always new files: a function refuses to overwrite an existing one.

Each call lets superPDF use only the folders of the files it is given (inputs, outputs and output folders).
"""

from __future__ import annotations

import json
import os
from collections.abc import Sequence
from pathlib import Path
from typing import Any, Literal, TypedDict, cast

from ._cli import run

PathLike = str | os.PathLike[str]

__all__ = [
    "BatchResult",
    "FileEntry",
    "Folder",
    "PdfInfo",
    "PipelineStep",
    "RepairResult",
    "Section",
    "SplitResult",
    "Structure",
    "Text",
    "TextPage",
    "Written",
    "add_page_labels",
    "add_watermark",
    "extract_pages",
    "extract_structure",
    "from_office",
    "info",
    "list_files",
    "merge",
    "protect",
    "read_text",
    "remove_metadata",
    "remove_pages",
    "repair",
    "rotate_pages",
    "run_batch",
    "run_pipeline",
    "run_tool",
    "split",
    "tools",
    "unlock",
]


# Results


class Written(TypedDict):
    """A new PDF: its path, page count and size in bytes."""

    output: str
    pages: int
    bytes: int


class FileEntry(TypedDict):
    path: str
    bytes: int
    modified: str


class Folder(TypedDict):
    folder: str
    files: list[FileEntry]


class PageSize(TypedDict):
    page: int
    width: float
    height: float
    rotation: int


class PdfInfo(TypedDict, total=False):
    pages: int
    title: str
    author: str
    subject: str
    keywords: str
    creator: str
    producer: str
    forms: list[dict[str, Any]]
    dimensions: list[PageSize]


class TextPage(TypedDict):
    page: int
    text: str


class Text(TypedDict):
    total_pages: int
    has_text: bool
    truncated: bool
    pages: list[TextPage]


class Section(TypedDict, total=False):
    id: str
    title: str
    level: int
    startPage: int
    endPage: int
    children: list[Section]


class Structure(TypedDict):
    format: str
    total_pages: int
    has_text: bool
    truncated: bool
    content: str
    sections: list[Section]


class SplitResult(TypedDict):
    outputs: list[Written]


class OfficeResult(Written):
    engine: str


class RepairResult(Written):
    fixed: list[str]


class BatchOutput(Written):
    input: str


class BatchFailure(TypedDict):
    input: str
    error: str


class BatchResult(TypedDict):
    outputs: list[BatchOutput]
    failed: list[BatchFailure]


class PipelineStep(TypedDict, total=False):
    """One step: {"action": "rotate", "options": {"pages": "1-2", "angle": 90}}.

    Actions and their options: extract (pages), remove (pages), rotate (pages, angle), crop (pages, margin),
    scale (pages, factor), flatten, labels (pages, text, position), watermark (pages, text), metadata-clear.
    """

    action: str
    options: dict[str, Any]


# Running a tool


def _existing(path: Path) -> Path:
    """The nearest folder that exists: the path itself if it is a folder, else its closest existing parent."""
    for candidate in (path, *path.parents):
        if candidate.is_dir():
            return candidate
    return Path.cwd()


def run_tool(
    name: str,
    arguments: dict[str, Any],
    *,
    allow: Sequence[PathLike] = (),
    timeout: float | None = 600,
) -> Any:
    """Run any superPDF tool by name (see `tools()`) and return its result.

    `allow` lists the folders it may use; the typed functions in this module fill it in from their paths.
    """
    folders = list(dict.fromkeys(str(_existing(Path(p).expanduser().resolve())) for p in allow)) or [os.getcwd()]
    args = ["tool", name, "--input", "-"]
    for folder in folders:
        args += ["--allow-dir", folder]
    result = json.loads(run(args, timeout=timeout, stdin=json.dumps(arguments)))
    return result["value"]


def tools() -> list[dict[str, Any]]:
    """Every tool with its name, title, description and JSON input schema."""
    return cast("list[dict[str, Any]]", json.loads(run(["tools"])))


def _path(value: PathLike) -> str:
    return str(Path(value).expanduser().resolve())


def _call(name: str, arguments: dict[str, Any], paths: Sequence[str], timeout: float | None = 600) -> Any:
    # Leave out options that weren't given, so each tool applies its own default.
    given = {key: value for key, value in arguments.items() if value is not None}
    return run_tool(name, given, allow=paths, timeout=timeout)


# Reading


def list_files(folder: PathLike = ".") -> Folder:
    """The PDFs in a folder, with their sizes and modification times."""
    path = _path(folder)
    return cast(Folder, _call("pdf_list_files", {"folder": path}, [path]))


def info(path: PathLike) -> PdfInfo:
    """Page count, page sizes and rotation, form fields and document properties."""
    pdf = _path(path)
    return cast(PdfInfo, _call("pdf_info", {"input": pdf}, [pdf]))


def read_text(path: PathLike, *, pages: str | None = None, max_chars: int | None = None) -> Text:
    """The text layer, page by page (no OCR). `max_chars` (100-400,000, default 60,000) caps the total."""
    pdf = _path(path)
    return cast(Text, _call("pdf_read_text", {"input": pdf, "pages": pages, "max_chars": max_chars}, [pdf]))


def extract_structure(
    path: PathLike,
    *,
    pages: str | None = None,
    format: Literal["markdown", "html", "json"] | None = None,
    max_chars: int | None = None,
) -> Structure:
    """Markdown, HTML or JSON with headings, tables, charts and lists, plus the outline (`sections`).

    Scanned pages are read with OCR. For a whole document without a size cap, use `superpdf.export`.
    """
    pdf = _path(path)
    arguments = {"input": pdf, "pages": pages, "format": format, "max_chars": max_chars}
    return cast(Structure, _call("pdf_extract_structure", arguments, [pdf]))


# New PDFs from pages


def merge(inputs: Sequence[PathLike], output: PathLike) -> Written:
    """Combine PDFs, in order, into a new PDF."""
    files, out = [_path(p) for p in inputs], _path(output)
    return cast(Written, _call("pdf_merge", {"inputs": files, "output": out}, [*files, out]))


def extract_pages(path: PathLike, pages: str, output: PathLike) -> Written:
    """A new PDF with only the given pages, such as "1, 3-5"."""
    pdf, out = _path(path), _path(output)
    return cast(Written, _call("pdf_extract_pages", {"input": pdf, "pages": pages, "output": out}, [pdf, out]))


def remove_pages(path: PathLike, pages: str, output: PathLike) -> Written:
    """A new PDF without the given pages."""
    pdf, out = _path(path), _path(output)
    return cast(Written, _call("pdf_remove_pages", {"input": pdf, "pages": pages, "output": out}, [pdf, out]))


def rotate_pages(
    path: PathLike, output: PathLike, *, pages: str | None = None, angle: Literal[90, 180, 270] | None = None
) -> Written:
    """Rotate pages clockwise (default 90 degrees; all pages when `pages` is omitted)."""
    pdf, out = _path(path), _path(output)
    arguments = {"input": pdf, "pages": pages, "angle": angle, "output": out}
    return cast(Written, _call("pdf_rotate_pages", arguments, [pdf, out]))


def split(
    path: PathLike, output_folder: PathLike, *, pages: str | None = None, mode: Literal["ranges", "pages"] | None = None
) -> SplitResult:
    """Split into several PDFs in `output_folder` (created if missing).

    mode "ranges" (default) makes one file per range in `pages`; "pages" makes one file per page.
    """
    pdf, folder = _path(path), _path(output_folder)
    arguments = {"input": pdf, "pages": pages, "mode": mode, "output_folder": folder}
    return cast(SplitResult, _call("pdf_split", arguments, [pdf, folder]))


# Changing a PDF


def add_page_labels(path: PathLike, output: PathLike, *, pages: str | None = None, text: str | None = None) -> Written:
    """Add page numbers or a footer. `text` may use {page} and {total} (default "{page} / {total}")."""
    pdf, out = _path(path), _path(output)
    arguments = {"input": pdf, "pages": pages, "text": text, "output": out}
    return cast(Written, _call("pdf_add_page_labels", arguments, [pdf, out]))


def add_watermark(path: PathLike, text: str, output: PathLike, *, pages: str | None = None) -> Written:
    """Stamp `text` (up to 60 characters, such as DRAFT or CONFIDENTIAL) diagonally across the pages."""
    pdf, out = _path(path), _path(output)
    arguments = {"input": pdf, "pages": pages, "text": text, "output": out}
    return cast(Written, _call("pdf_add_watermark", arguments, [pdf, out]))


def remove_metadata(path: PathLike, output: PathLike) -> Written:
    """A copy without document properties (title, author, dates, producer and so on)."""
    pdf, out = _path(path), _path(output)
    return cast(Written, _call("pdf_remove_metadata", {"input": pdf, "output": out}, [pdf, out]))


def repair(path: PathLike, output: PathLike) -> RepairResult:
    """Rebuild a damaged PDF; `fixed` lists what was repaired."""
    pdf, out = _path(path), _path(output)
    return cast(RepairResult, _call("pdf_repair", {"input": pdf, "output": out}, [pdf, out]))


def protect(path: PathLike, password: str, output: PathLike) -> Written:
    """Encrypt with a password (AES-256)."""
    pdf, out = _path(path), _path(output)
    arguments = {"input": pdf, "password": password, "output": out}
    return cast(Written, _call("pdf_protect", arguments, [pdf, out]))


def unlock(path: PathLike, output: PathLike, *, password: str | None = None) -> Written:
    """A decrypted copy, using a password you know (or none, for owner-only restrictions). Never guesses."""
    pdf, out = _path(path), _path(output)
    arguments = {"input": pdf, "password": password, "output": out}
    return cast(Written, _call("pdf_unlock", arguments, [pdf, out]))


def from_office(path: PathLike, output: PathLike, *, timeout: float | None = 600) -> OfficeResult:
    """Word, Excel or PowerPoint (also OpenDocument) to PDF. Needs LibreOffice on this computer."""
    doc, out = _path(path), _path(output)
    return cast(OfficeResult, _call("pdf_from_office", {"input": doc, "output": out}, [doc, out], timeout))


# Several steps or files


def run_pipeline(path: PathLike, steps: Sequence[PipelineStep], output: PathLike) -> Written:
    """Up to 10 steps on one PDF, saved once: e.g. [{"action": "extract", "options": {"pages": "1-3"}}]."""
    pdf, out = _path(path), _path(output)
    arguments = {"input": pdf, "steps": list(steps), "output": out}
    return cast(Written, _call("pdf_run_pipeline", arguments, [pdf, out]))


def run_batch(
    inputs: Sequence[PathLike],
    steps: Sequence[PipelineStep],
    output_folder: PathLike,
    *,
    suffix: str | None = None,
    timeout: float | None = 1800,
) -> BatchResult:
    """The same 1-10 steps on each of up to 50 PDFs, written to `output_folder` as <name>-<suffix>.pdf.

    `suffix` defaults to "processed". A file that fails is listed in `failed` and the rest continue.
    """
    files, folder = [_path(p) for p in inputs], _path(output_folder)
    arguments = {"inputs": files, "steps": list(steps), "output_folder": folder, "suffix": suffix}
    return cast(BatchResult, _call("pdf_run_batch", arguments, [*files, folder], timeout))
