"""`python -m superpdf ...` runs the superPDF command-line tool with the bundled Node.js."""

from __future__ import annotations

import subprocess
import sys

from ._cli import SuperPDFError, command


def main() -> int:
    try:
        return subprocess.call([*command(), *sys.argv[1:]])
    except SuperPDFError as error:
        print(f"superPDF: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
