# Security

superPDF reads files from your computer and, through the MCP server and the API, lets other programs ask it to. Problems
that let it read or write outside the `--allow-dir` folders, overwrite files, reach the network unexpectedly or run
code from a PDF are security issues.

## Report a problem

Please report privately through GitHub: **Security → Report a vulnerability** on this repository
(https://github.com/arjunprabhulal/superpdf/security/advisories/new). Don't open a public issue.

Include the version (`superpdf --version`), what you did, and what happened. You'll get a reply within a few days, and
a fix is released as soon as it's ready. Reporters are credited unless they prefer not to be.

## Supported versions

Fixes go into the latest release on npm (`@superpdf/cli`).
