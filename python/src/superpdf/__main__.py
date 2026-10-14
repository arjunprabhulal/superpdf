"""The `superpdf` command (and `python -m superpdf`): the superPDF CLI, run with the bundled Node.js.

uvx superpdf export report.pdf --output report.md
pipx run superpdf help
"""

from __future__ import annotations

import os
import subprocess
import sys

from ._cli import SuperPDFError, command

# Set for the CLI it starts, so SUPERPDF_BIN pointing back at this command fails instead of starting itself forever.
_GUARD = "SUPERPDF_PYTHON_WRAPPER"


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    if os.environ.get(_GUARD):
        print(
            "superPDF: SUPERPDF_BIN points to the Python superpdf command; point it to the Node.js CLI.",
            file=sys.stderr,
        )
        return 1
    try:
        return subprocess.call([*command(), *args], env={**os.environ, _GUARD: "1"})
    except SuperPDFError as error:
        print(f"superPDF: {error}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    sys.exit(main())
