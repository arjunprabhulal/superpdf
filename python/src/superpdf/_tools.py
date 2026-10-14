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
    "Comparison",
    "EpubResult",
    "FileEntry",
    "Folder",
    "OfficeResult",
    "Outline",
    "PageChange",
    "PdfInfo",
    "PipelineStep",
    "RepairResult",
    "SavedFile",
    "Section",
    "SlidesResult",
    "SplitResult",
    "Structure",
    "TablesResult",
    "Text",
    "TextPage",
    "WordResult",
    "Written",
    "add_page_labels",
    "add_text",
    "add_watermark",
    "compare",
    "extract_pages",
    "extract_structure",
    "extract_tables",
    "fill_form",
    "flatten",
    "from_images",
    "from_markdown",
    "from_office",
    "info",
    "list_files",
    "merge",
    "outline",
    "protect",
    "read_text",
    "remove_metadata",
    "remove_pages",
    "repair",
    "resize_pages",
    "rotate_pages",
    "run_batch",
    "run_pipeline",
    "run_tool",
    "split",
    "to_docx",
    "to_epub",
    "to_pptx",
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


class SavedFile(TypedDict):
    """A new file that isn't a PDF (Word, Excel, CSV and so on): its path and size in bytes."""

    output: str
    bytes: int


class WordResult(SavedFile):
    pages: int
    paragraphs: int
    tables: int


class TablesResult(SavedFile):
    format: str
    tables: int


class SlidesResult(SavedFile):
    slides: int
    empty_pages: list[int]


class EpubResult(SavedFile):
    chapters: int


class PageChange(TypedDict):
    page: int
    status: Literal["same", "changed", "added", "removed"]
    words_removed: int
    words_added: int
    changes: str


class Comparison(TypedDict):
    summary: str
    pages: list[PageChange]


class Outline(TypedDict):
    format: str
    content: str
    sections: list[Section]


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


def add_page_labels(
    path: PathLike,
    output: PathLike,
    *,
    pages: str | None = None,
    text: str | None = None,
    position: Literal["top", "bottom"] | None = None,
) -> Written:
    """Add page numbers or a footer (or header, with position "top").

    `text` may use {page} and {total} (default "{page} / {total}").
    """
    pdf, out = _path(path), _path(output)
    arguments = {"input": pdf, "pages": pages, "text": text, "position": position, "output": out}
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


def add_text(
    path: PathLike,
    text: str,
    output: PathLike,
    *,
    pages: str | None = None,
    x: float | None = None,
    y: float | None = None,
    size: float | None = None,
) -> Written:
    """Draw text, such as a typed signature or a date, on the pages (Latin characters, up to 200).

    `x` and `y` are points from the bottom-left corner (default 36, 36); `size` is 6-72 points (default 12).
    """
    pdf, out = _path(path), _path(output)
    arguments = {"input": pdf, "pages": pages, "text": text, "x": x, "y": y, "size": size, "output": out}
    return cast(Written, _call("pdf_add_text", arguments, [pdf, out]))


def fill_form(
    path: PathLike, values: dict[str, str | int | float | bool], output: PathLike, *, flatten: bool | None = None
) -> Written:
    """Fill form fields by name (`info` lists them): text fields take text, check boxes True or False.

    With `flatten`, the values become part of the page and can no longer be edited.
    """
    pdf, out = _path(path), _path(output)
    arguments = {"input": pdf, "values": values, "flatten": flatten, "output": out}
    return cast(Written, _call("pdf_fill_form", arguments, [pdf, out]))


def flatten(path: PathLike, output: PathLike) -> Written:
    """Make form fields part of the page, so their values show everywhere and can't be edited."""
    pdf, out = _path(path), _path(output)
    return cast(Written, _call("pdf_flatten", {"input": pdf, "output": out}, [pdf, out]))


def resize_pages(
    path: PathLike,
    output: PathLike,
    *,
    mode: Literal["crop", "scale"],
    pages: str | None = None,
    margin: float | None = None,
    factor: float | None = None,
) -> Written:
    """Crop `margin` points (0-500, default 24) from each edge, or scale the content by `factor` (0.1-4)."""
    pdf, out = _path(path), _path(output)
    arguments = {"input": pdf, "pages": pages, "mode": mode, "margin": margin, "factor": factor, "output": out}
    return cast(Written, _call("pdf_resize_pages", arguments, [pdf, out]))


# Converting


def to_docx(path: PathLike, output: PathLike, *, pages: str | None = None, timeout: float | None = 600) -> WordResult:
    """An editable Word document (.docx): headings, paragraphs with bold and italic, lists and tables.

    Scanned pages are read with OCR. Page layout and images are not reconstructed.
    """
    pdf, out = _path(path), _path(output)
    arguments = {"input": pdf, "pages": pages, "output": out}
    return cast(WordResult, _call("pdf_to_docx", arguments, [pdf, out], timeout))


def extract_tables(
    path: PathLike,
    output: PathLike,
    *,
    pages: str | None = None,
    format: Literal["xlsx", "csv", "json", "markdown"] | None = None,
    timeout: float | None = 600,
) -> TablesResult:
    """The tables (and vector charts, as tables of their values) as Excel, CSV, JSON or Markdown.

    `format` defaults to "xlsx" (one sheet per table); `output` must end in .xlsx, .csv, .json or .md to match.
    """
    pdf, out = _path(path), _path(output)
    arguments = {"input": pdf, "pages": pages, "format": format, "output": out}
    return cast(TablesResult, _call("pdf_extract_tables", arguments, [pdf, out], timeout))


def to_pptx(path: PathLike, output: PathLike, *, pages: str | None = None, timeout: float | None = 600) -> SlidesResult:
    """A PowerPoint file (.pptx), one slide per page, with the text as editable text boxes."""
    pdf, out = _path(path), _path(output)
    arguments = {"input": pdf, "pages": pages, "output": out}
    return cast(SlidesResult, _call("pdf_to_pptx", arguments, [pdf, out], timeout))


def to_epub(
    path: PathLike,
    output: PathLike,
    *,
    title: str | None = None,
    author: str | None = None,
    language: str | None = None,
    split: Literal["headings", "pages"] | None = None,
    timeout: float | None = 600,
) -> EpubResult:
    """An EPUB 3 e-book of the text, in chapters at headings (default) or every few pages.

    `language` is a tag such as "en" (default) or "pt-BR".
    """
    pdf, out = _path(path), _path(output)
    arguments = {"input": pdf, "title": title, "author": author, "language": language, "split": split, "output": out}
    return cast(EpubResult, _call("pdf_to_epub", arguments, [pdf, out], timeout))


def from_images(inputs: Sequence[PathLike], output: PathLike, *, timeout: float | None = 600) -> Written:
    """A PDF from 1-200 JPG or PNG images, one page per image, in order."""
    files, out = [_path(p) for p in inputs], _path(output)
    return cast(Written, _call("pdf_from_images", {"inputs": files, "output": out}, [*files, out], timeout))


def from_markdown(
    path: PathLike,
    output: PathLike,
    *,
    page_size: Literal["A4", "Letter"] | None = None,
    title: str | None = None,
) -> Written:
    """Typeset a Markdown file (headings, lists, tables, code, links) as a PDF on A4 (default) or Letter."""
    md, out = _path(path), _path(output)
    arguments = {"input": md, "page_size": page_size, "title": title, "output": out}
    return cast(Written, _call("pdf_from_markdown", arguments, [md, out]))


def from_office(path: PathLike, output: PathLike, *, timeout: float | None = 600) -> OfficeResult:
    """Word, Excel or PowerPoint (also OpenDocument) to PDF. Needs LibreOffice on this computer."""
    doc, out = _path(path), _path(output)
    return cast(OfficeResult, _call("pdf_from_office", {"input": doc, "output": out}, [doc, out], timeout))


# Comparing


def compare(
    before: PathLike, after: PathLike, *, max_chars: int | None = None, timeout: float | None = 600
) -> Comparison:
    """Compare the text of two versions page by page.

    Each page is "same", "changed", "added" or "removed"; `changes` marks the words as [-removed-] and {+added+}
    (up to `max_chars` per page, default 20,000).
    """
    a, b = _path(before), _path(after)
    return cast(Comparison, _call("pdf_compare", {"before": a, "after": b, "max_chars": max_chars}, [a, b], timeout))


def outline(
    path: PathLike, *, format: Literal["markdown", "json"] | None = None, timeout: float | None = 600
) -> Outline:
    """The outline (bookmarks or detected headings) as a Markdown list or JSON tree, with each section's pages."""
    pdf = _path(path)
    return cast(Outline, _call("pdf_outline", {"input": pdf, "format": format}, [pdf], timeout))


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
