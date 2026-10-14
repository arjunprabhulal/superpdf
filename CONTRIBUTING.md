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
| `contracts/` | The tool definitions shared by the CLI, the MCP server, the API and the Python package. After changing one, run `npm run openapi` to rebuild `openapi.json` |
| `mcp/` | The MCP server, including the folder rules for `--allow-dir` |
| `api/` | The local REST API, jobs and webhooks |
| `scripts/` | `openapi.js`, which writes `openapi.json` from the tool definitions |
| `python/` | The Python package (`pip install superpdf`); see [python/README.md](python/README.md) |
| `tests/` | End-to-end tests (`npm test`) |

## Pull requests

- Keep each pull request to one change, with a test that fails without it.
- For reader changes, describe the PDF it fixes and check that other documents still read the same.
- Rules and algorithms only: the reader doesn't use AI models. Code adapted from another project must have a permissive
  licence (MIT, BSD, Apache-2.0) and be credited in NOTICE; copyleft code (GPL, AGPL, LGPL) can't be accepted.
- By contributing, you agree that your contribution is licensed under Apache-2.0.

## Releasing

Maintainers publish from GitHub: publishing a release runs [`release.yml`](.github/workflows/release.yml), which runs
the tests, checks that the tag matches `package.json`, and stages the package on npm with provenance through npm
trusted publishing. No npm token is stored in the repository.

1. Bump the version without creating a tag: `npm version 0.2.0 --no-git-tag-version` (use the next patch, minor or
   major version).
2. Add a section for the new version at the top of [CHANGELOG.md](CHANGELOG.md).
3. Commit both files as `chore(release): 0.2.0`, push to `main` and wait for CI to pass.
4. Tag and push the tag: `git tag -a v0.2.0 -m "superPDF AI 0.2.0"`, then `git push origin v0.2.0`.
5. Create a GitHub release from that tag, with the changelog section as the notes, and publish it. Mark it as a
   pre-release to publish under the `next` dist-tag instead of `latest`.
6. When the Release workflow has finished, approve the staged version on npmjs.com (Staged Packages tab), or with
   `npm stage list` and `npm stage approve <stage-id>`. Approval needs two-factor authentication.
7. Check that `npm view @superpdf/cli version` shows the new version and that the package page shows its provenance.

The tag must be `v` followed by the exact `package.json` version, or the workflow stops before publishing. A version
can only be published once: if something is wrong after staging, reject the staged version and release the next patch
version.

### One-time npm setup

On npmjs.com, open the `@superpdf/cli` package, then Settings, and add a trusted publisher for GitHub Actions:

- Organization or user: `arjunprabhulal`
- Repository: `superpdf`
- Workflow filename: `release.yml`
- Environment name: leave empty
- Allowed actions: `npm stage publish` only (leave `npm publish` unchecked)

npm doesn't check these values when you save them; a mistake shows up as an error when the workflow publishes. A new
trusted publisher expires if it isn't used for a successful publish within two days, so add it shortly before a
release. Once a release has gone through it, set Publishing access to "Require two-factor authentication and disallow
tokens".

## Conduct

Everyone taking part is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
