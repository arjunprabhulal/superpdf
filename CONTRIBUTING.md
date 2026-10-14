# Contributing to superPDF AI

Thank you for helping. Reading problems with real PDFs are the most useful contribution: every fix starts from one.

## Report a reading problem

Open an issue with the "Reading problem" form. Attach the PDF (or one page of it) and say what you expected. Only share
files you are allowed to share publicly; one page that shows the problem is enough.

## Set up

```bash
git clone https://github.com/arjunprabhulal/superpdf.git
cd superpdf
npm install
npm test
node bin/superpdf.js export examples/quarterly-report.pdf --output report.md
```

You need Node.js 22 or later. The code is plain JavaScript (ES modules), with no build step.

## Where things are

| Folder | What's in it |
|---|---|
| `bin/` | The `superpdf` command |
| `lib/` | The PDF reader and PDF operations: `pdf-structure.js`, `pdf-layout.js`, `pdf-charts.js`, `pdf-text-fixes.js`, `pdf-core.js` |
| `contracts/` | The tool definitions shared by the CLI, the MCP server and the API |
| `mcp/` | The MCP server, including the folder rules for `--allow-dir` |
| `api/` | The local REST API, jobs and webhooks |
| `tests/` | End-to-end tests (`npm test`) |

## Pull requests

- Keep each pull request to one change, with a test that fails without it.
- For reader changes, describe the PDF it fixes and check that other documents still read the same.
- Rules and algorithms only: the reader doesn't use AI models. Code adapted from another project must have a permissive
  licence (MIT, BSD, Apache-2.0) and be credited in NOTICE; copyleft code (GPL, AGPL, LGPL) can't be accepted.
- By contributing, you agree that your contribution is licensed under Apache-2.0.

## Conduct

Everyone taking part is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
