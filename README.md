# Coverage Tools

**See the test coverage of your whole workspace at once, in VS Code's native coverage UI.**

> **Status: in design — not released yet.**
> No version of the extension has shipped. This README describes how the first
> release is meant to behave and is updated as features land. See
> [Feature status](#feature-status) for what exists today and
> [CHANGELOG.md](CHANGELOG.md) for what changed and what is coming.

## The problem

VS Code can show test coverage natively: the **Test Coverage** view, a
percentage and a red/yellow/green bar per file, and covered/uncovered lines in
the editor. But it shows **one test run at a time**. In a workspace with
several projects, or several folders (multi-root), running coverage for
project B makes project A's coverage disappear. To know where the whole
workspace stands you have to keep re-running and switching between projects.

## What Coverage Tools does

Coverage Tools is an **accumulator**. It keeps the coverage of every project
in your workspace in memory and shows all of it together through the same
native UI:

```
TEST COVERAGE
▾ api            (workspace folder 1)
    Services/OrderService.cs      █████████░  91%
    Services/TaxService.cs        ███░░░░░░░  34%
▾ web            (workspace folder 2)
    components/Cart.tsx           ████████░░  80%
```

- **Accumulates across projects.** Running one project updates only that
  project's numbers. Everything else stays on screen.
- **Looks native, because it is.** It publishes through VS Code's Testing API:
  per-file and per-folder percentages, coverage bars, and line-by-line
  highlighting in the editor. Bar colors follow VS Code's own
  `testing.coverageBarThresholds` setting.
- **Picks up coverage runs automatically.** Run your tests with coverage from
  the terminal, a task, or a script, and the result is loaded as soon as the
  report is written.
- **Runs everything in one go.** One command runs coverage for every test
  project in the workspace.
- **Runs just what you point at.** Right-click a test project, a folder, or a
  test file in the Explorer to run coverage for that target only. The menu
  item appears only where there are tests to run.
- **Stays until you replace it.** Coverage remains displayed until a new
  coverage run updates it or VS Code restarts. Nothing is saved between
  sessions.

## Supported test stacks

| Stack | How coverage is collected | Report format read |
|-------|---------------------------|--------------------|
| .NET (`dotnet test`, VSTest-based projects) | `--collect:"XPlat Code Coverage"` (coverlet) | Cobertura XML |
| Jest (via `yarn`, `npm`, or `pnpm`) | `--coverage` | Istanbul JSON, LCOV, Cobertura XML |

A coverage run only produces data if it writes a report. Plain `dotnet test`
or `yarn test` without coverage options is ignored.

## Commands

| Command | Where | What it does |
|---------|-------|--------------|
| `Coverage Tools: Run All Coverage` | Command Palette, Testing view title | Runs coverage for every discovered test project, one at a time |
| `Coverage Tools: Run Coverage Here` | Explorer right-click menu | Runs coverage for the selected project, folder, or test file |
| `Coverage Tools: Show Coverage` | Command Palette, status bar | Brings the accumulated coverage back on screen |
| `Coverage Tools: Clear Coverage` | Command Palette | Empties the accumulated coverage and closes the native view |

A status bar item shows the accumulated total and whether a run is in
progress.

## How accumulation works

- A **full run of a project** replaces that project's data.
- A **partial run from the right-click menu** (a folder or a single test file)
  adds to that project's data, so nothing already covered is lost.
- If two test projects cover the same source file, their counts are combined
  in the display.
- A coverage run detected from outside the extension is treated as a full run
  of its project.

## Settings

| Setting | Default | Purpose |
|---------|---------|---------|
| `coverageTools.watch.enabled` | `true` | Detect coverage runs made outside the extension |
| `coverageTools.watch.globs` | `**/TestResults/**/*.cobertura.xml`, `**/coverage/coverage-final.json`, `**/coverage/lcov.info`, `**/coverage/cobertura-coverage.xml` | Where to look for coverage reports |
| `coverageTools.exclude` | `**/node_modules/**`, `**/bin/**`, `**/obj/**` | Ignored during discovery and watching |
| `coverageTools.dotnet.collector` | `XPlat Code Coverage` | Value passed to `--collect` |
| `coverageTools.dotnet.extraArgs` | `[]` | Extra arguments for `dotnet test` |
| `coverageTools.jest.command` | `""` (auto: `<package manager> test`) | Base command used to run Jest |
| `coverageTools.jest.extraArgs` | `[]` | Extra arguments for Jest |

## Requirements

- VS Code 1.90 or later.
- For .NET: the .NET SDK, and the `coverlet.collector` package in each test
  project (included by the standard xUnit, NUnit, and MSTest templates).
- For Jest: Jest installed in the project, runnable through its `test` script.

## Known limitations

- **Other extensions can take over the display.** If you run coverage through
  C# Dev Kit or the Jest extension, VS Code switches to that run. Your
  accumulated coverage is still held; use `Coverage Tools: Show Coverage` to
  bring it back.
- **Coverage can go stale.** If you edit a file after a run, the highlighted
  lines may no longer match until you run again. Native coverage behaves the
  same way.
- **Partial runs from the terminal count as full runs** and replace the
  project's data. Use the right-click menu for partial runs that add up.
- **.NET projects on Microsoft.Testing.Platform** are not run by the extension
  in the first release.
- **Nothing is persisted.** Coverage starts empty every time VS Code starts.

## Feature status

| Feature | Status |
|---------|--------|
| Design specification | Written, awaiting approval |
| Accumulated coverage in the native UI | Planned |
| Automatic detection of coverage reports | Planned |
| Run All Coverage | Planned |
| Run Coverage Here (Explorer right-click) | Planned |
| .NET support (Cobertura) | Planned |
| Jest support (Istanbul JSON, LCOV) | Planned |
| Status bar total | Planned |

## Installation

Not available yet. The first release will be distributed as a `.vsix` file
attached to a GitHub release.

## Changelog

See [CHANGELOG.md](CHANGELOG.md).

## License

[MIT](LICENSE)
