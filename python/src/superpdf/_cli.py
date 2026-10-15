"""Install and run the superPDF command-line tool (the npm package @superpdf/cli).

Node.js comes from the `nodejs-wheel-binaries` package, so `pip install superpdf` is all a user needs. The CLI
itself is installed once, at a pinned version, into a per-user cache folder.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

# The @superpdf/cli version this package is tested with.
CLI_VERSION = "0.4.0"
NODE_MAJOR = 22


class SuperPDFError(RuntimeError):
    """The superPDF command failed, or the CLI couldn't be found or installed."""


def _bundled(root: Path, windows: bool) -> tuple[str, list[str] | None] | None:
    """Node.js and npm inside a nodejs-wheel-binaries folder, or None if its node binary is missing.

    The wheel puts node.exe at the top on Windows and bin/node elsewhere; npm is under lib/node_modules on every
    platform (node_modules is checked too, for older layouts).
    """
    node = root / "node.exe" if windows else root / "bin" / "node"
    if not node.exists():
        return None
    candidates = (root / "lib" / "node_modules" / "npm", root / "node_modules" / "npm")
    npm = next((c / "bin" / "npm-cli.js" for c in candidates if (c / "bin" / "npm-cli.js").exists()), None)
    return str(node), [str(node), str(npm)] if npm else None


def _node() -> tuple[str, list[str] | None]:
    """The Node.js binary and the npm command: from nodejs-wheel-binaries, else Node.js 22+ on PATH."""
    try:
        import nodejs_wheel

        found = _bundled(Path(nodejs_wheel.__file__).parent, windows=os.name == "nt")
    except ImportError:
        found = None
    if found is not None:
        return found
    node_path = shutil.which("node")
    if node_path is None:
        raise SuperPDFError(
            "Node.js wasn't found. Reinstall superpdf (it brings Node.js through nodejs-wheel-binaries), "
            "or install Node.js 22 or later from https://nodejs.org."
        )
    version = _output([node_path, "--version"], timeout=30).strip()
    major = version.lstrip("v").split(".")[0]
    if not major.isdigit() or int(major) < NODE_MAJOR:
        raise SuperPDFError(
            f"superPDF needs Node.js {NODE_MAJOR} or later; this computer has {version or 'an unknown version'}."
        )
    npm_path = shutil.which("npm")
    return node_path, [npm_path] if npm_path else None


def _output(cmd: list[str], timeout: float | None) -> str:
    # The CLI writes UTF-8 on every platform; Python's default encoding on Windows is not UTF-8.
    return subprocess.run(
        cmd, capture_output=True, timeout=timeout, check=False, encoding="utf-8", errors="replace"
    ).stdout


def cache_dir() -> Path:
    """Where the CLI is installed: SUPERPDF_CACHE_DIR, else the platform's per-user cache folder."""
    configured = os.environ.get("SUPERPDF_CACHE_DIR")
    if configured:
        return Path(configured)
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Caches" / "superpdf"
    if os.name == "nt":
        return Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local")) / "superpdf" / "Cache"
    return Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache")) / "superpdf"


def _script(prefix: Path) -> Path:
    return prefix / "node_modules" / "@superpdf" / "cli" / "bin" / "superpdf.js"


def install_cli(version: str = CLI_VERSION, *, timeout: float = 600) -> Path:
    """Install @superpdf/cli (once) and return the path to its superpdf.js. Safe to call repeatedly."""
    target = cache_dir() / f"cli-{version}"
    if _script(target).exists():
        return _script(target)
    _, npm = _node()
    if npm is None:
        raise SuperPDFError("npm wasn't found to install the superPDF CLI. Set SUPERPDF_BIN to an installed superpdf.")
    target.parent.mkdir(parents=True, exist_ok=True)
    # Install into a temporary folder, then move it into place, so a failed or concurrent install never leaves a
    # half-written CLI behind.
    staging = Path(tempfile.mkdtemp(prefix=f".cli-{version}-", dir=target.parent))
    try:
        command = [
            *npm,
            "install",
            "--prefix",
            str(staging),
            "--omit=dev",
            "--ignore-scripts",
            "--no-audit",
            "--no-fund",
            "--no-package-lock",
            "--loglevel=error",
            f"@superpdf/cli@{version}",
        ]
        result = subprocess.run(
            command, capture_output=True, timeout=timeout, check=False, encoding="utf-8", errors="replace"
        )
        if result.returncode != 0 or not _script(staging).exists():
            detail = (result.stderr or result.stdout).strip().splitlines()[-1:] or ["no output"]
            raise SuperPDFError(f"Couldn't install @superpdf/cli@{version} from npm: {detail[0]}")
        try:
            os.replace(staging, target)
        except OSError:
            if not _script(target).exists():  # another process finished first; otherwise it is a real error
                raise
    except subprocess.TimeoutExpired as error:
        raise SuperPDFError(f"Installing @superpdf/cli@{version} took longer than {timeout:.0f} seconds.") from error
    finally:
        shutil.rmtree(staging, ignore_errors=True)
    return _script(target)


def command() -> list[str]:
    """The command that runs superPDF: SUPERPDF_BIN if set, else the pinned CLI with the bundled Node.js."""
    configured = os.environ.get("SUPERPDF_BIN")
    if configured:
        path = Path(configured)
        if not path.exists():
            raise SuperPDFError(f"SUPERPDF_BIN points to {configured}, which doesn't exist.")
        return [_node()[0], str(path)] if path.suffix == ".js" else [str(path)]
    script = install_cli()
    return [_node()[0], str(script)]


def run(args: list[str], timeout: float | None = 600, stdin: str | None = None) -> str:
    """Run superPDF with `args` (and `stdin`, if given) and return what it printed. Raises SuperPDFError on failure."""
    try:
        result = subprocess.run(
            [*command(), *args],
            input=stdin,
            capture_output=True,
            timeout=timeout,
            check=False,
            encoding="utf-8",
            errors="replace",
        )
    except subprocess.TimeoutExpired as error:
        raise SuperPDFError(f"superPDF didn't finish within {timeout:.0f} seconds.") from error
    if result.returncode != 0:
        # Progress notes (OCR) come first; the error is the last line.
        lines = [line for line in result.stderr.splitlines() if line.strip()]
        message = lines[-1].removeprefix("superPDF: ") if lines else f"superPDF exited with code {result.returncode}."
        raise SuperPDFError(message)
    return result.stdout
