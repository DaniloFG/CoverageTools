# Changelog

All notable changes to Coverage Tools are recorded in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## How to read this file

- **[Unreleased]** covers work that has not shipped in a version yet. It has
  three parts:
  - **Planned** — agreed on, not started.
  - **In progress** — being built now.
  - **Done** — finished and merged, waiting for the next release.
- Each released version lists its changes under the standard headings:
  **Added**, **Changed**, **Deprecated**, **Removed**, **Fixed**, **Security**.

## [Unreleased]

### Planned

- Accumulated coverage for every project in the workspace, shown through VS
  Code's native Test Coverage UI (per-file percentage, coverage bars,
  line-by-line highlighting).
- Automatic detection of coverage reports written by runs made outside the
  extension (terminal, tasks, scripts).
- `Run All Coverage` command to run every test project in the workspace.
- `Run Coverage Here` in the Explorer right-click menu for a test project,
  folder, or test file.
- `Show Coverage` and `Clear Coverage` commands.
- .NET (C#) support through `dotnet test` and Cobertura reports.
- Node support for Jest and Vitest through `yarn`, `npm`, or `pnpm`, and for
  any other tool run by the `test` script (Mocha, AVA, `node --test`, …)
  through a bundled c8.
- Python support through pytest and pytest-cov, including detection of
  coverage.py `.coverage` data files.
- Reading of Cobertura, Istanbul JSON, and LCOV reports, whatever tool wrote
  them.
- Custom coverage command per project (`coverageTools.commands`).
- Status bar item with the accumulated total.
- Usage screenshots in the README, captured from the sample workspace.

### In progress

- Design specification for the first release.

### Done

- Nothing yet.
