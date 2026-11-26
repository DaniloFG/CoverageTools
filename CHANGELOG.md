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

- Nothing yet.

### In progress

- Nothing yet.

### Done

- Nothing yet.

## [0.1.0] - 2026-11-25

### Added

- Accumulated coverage for every project in the workspace, shown through VS
  Code's native Test Coverage UI: per-file and per-folder percentages,
  coverage bars and line-by-line highlighting. Running one project updates
  only that project's numbers.
- `Run All Coverage` runs every test project in the workspace, one at a time,
  with progress and cancellation (Command Palette and Testing view title).
- `Run Coverage Here` in the Explorer right-click menu runs a test project,
  solution, folder or test file; it appears only where there are tests to run,
  and partial runs add to the project's coverage.
- Automatic detection of coverage reports written by runs made outside the
  extension (terminal, tasks, scripts): Cobertura, Istanbul JSON and LCOV,
  whatever tool wrote them, and coverage.py `.coverage` data files.
- .NET (C#) support for VSTest test projects, using the coverage collector
  the project already has, and for Microsoft.Testing.Platform test projects
  (MSTest, NUnit, xUnit v3, TUnit) through the platform's code coverage
  extension.
- Node support for Jest and Vitest, with or without a `test` script, and for
  any other tool (Mocha, AVA, `node --test`, …) through a bundled c8.
- Python support for pytest and `unittest`, through pytest-cov or
  coverage.py.
- Single projects and monorepos handled without configuration
  (`coverageTools.nestedProjects` for nested projects), and a custom coverage
  command per project (`coverageTools.commands`).
- A status bar item with the accumulated total, showing the same percentage
  as the root of the Test Coverage view, with a per-project tooltip; a click
  brings the accumulated coverage back after another extension's run.
- `Show Coverage` and `Clear Coverage` commands.
- Read-only behaviour in untrusted workspaces: no command runs, reports are
  still read.
- Lightweight operation: no work at startup or at rest, one file watcher per
  workspace folder, and report parsing off the main extension thread.
- Usage screenshots in the README, captured from the sample workspace.
- Automatic releases: every new version is published to the VS Code
  Marketplace (and Open VSX) and attached as a .vsix to its GitHub release.
