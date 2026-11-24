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
native UI, whatever mix of .NET, Node, and Python projects you have open:

```
TEST COVERAGE
▾ api            (workspace folder 1, .NET)
    Services/OrderService.cs      █████████░  91%
    Services/TaxService.cs        ███░░░░░░░  34%
▾ web            (workspace folder 2, Node)
    components/Cart.tsx           ████████░░  80%
▾ jobs           (workspace folder 3, Python)
    jobs/cleanup.py               ██████░░░░  62%
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

| Ecosystem | Test tool | How the extension runs it | Run a single file or folder |
|-----------|-----------|---------------------------|-----------------------------|
| .NET (C#) | `dotnet test` (VSTest-based projects) | `--collect:"XPlat Code Coverage"` (coverlet) | Yes |
| Node | Jest | the project's `test` script with `--coverage` | Yes |
| Node | Vitest | the project's `test` script with `--coverage` | Yes |
| Node | Anything else run by the `test` script (Mocha, AVA, `node --test`, Jasmine, tap, …) | the `test` script wrapped in a bundled [c8](https://github.com/bcoe/c8) | No, whole project only |
| Python | pytest | `pytest --cov` (pytest-cov) | Yes |

For anything the table does not cover, you can give the extension your own
command per project with the `coverageTools.commands` setting.

Coverage runs made outside the extension are detected by the report they
write, whatever tool wrote it:

| Report | Format | Typically written by |
|--------|--------|----------------------|
| `**/TestResults/**/*.cobertura.xml` | Cobertura | `dotnet test` with a collector |
| `**/coverage/coverage-final.json` | Istanbul JSON | Jest, Vitest, nyc, c8 |
| `**/coverage/lcov.info` | LCOV | Jest, Vitest, nyc, c8, `node --test` |
| `**/coverage/cobertura-coverage.xml` | Cobertura | Jest, Vitest, nyc, c8 |
| `**/coverage.xml` | Cobertura | pytest-cov, coverage.py |
| `**/coverage.lcov` | LCOV | pytest-cov, coverage.py |
| `**/.coverage` | coverage.py data | `pytest --cov`, `coverage run` |

A test run only produces data if it writes one of these. A plain
`dotnet test`, `yarn test`, or `pytest` without coverage options is ignored.

## Usage

Screenshots for each step will be added here once the extension runs; they
will be real captures, taken from the sample workspace in this repository.

1. **Run everything.** Open the Command Palette and run
   `Coverage Tools: Run All Coverage`. Every test project in the workspace
   runs, one at a time, and the Test Coverage view fills in as each finishes.
2. **Read the result.** The Test Coverage view lists every covered file from
   every project, with its percentage and bar.
3. **See it line by line.** Open any listed file to see covered and uncovered
   lines in the editor.
4. **Run one target.** Right-click a test project, a folder, or a test file in
   the Explorer and choose `Run Coverage Here`.
5. **Or just use your terminal.** Run your tests with coverage as you always
   do. The view updates when the report is written.
6. **Bring it back.** If another extension's test run replaces the display,
   click the Coverage Tools item in the status bar, or run
   `Coverage Tools: Show Coverage`.

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
| `coverageTools.watch.globs` | the report patterns listed above | Where to look for coverage reports |
| `coverageTools.exclude` | `**/node_modules/**`, `**/bin/**`, `**/obj/**`, `**/.venv/**`, `**/venv/**`, `**/__pycache__/**` | Ignored during discovery and watching |
| `coverageTools.dotnet.collector` | `XPlat Code Coverage` | Value passed to `--collect` |
| `coverageTools.dotnet.extraArgs` | `[]` | Extra arguments for `dotnet test` |
| `coverageTools.node.extraArgs` | `[]` | Extra arguments for the Node test command |
| `coverageTools.python.interpreter` | `""` (auto-detect) | Python interpreter to use |
| `coverageTools.python.extraArgs` | `[]` | Extra arguments for pytest |
| `coverageTools.commands` | `{}` | Your own coverage command for a project, keyed by its path; `${coverageDir}` is replaced with the folder the report must be written to |

## Requirements

- VS Code 1.90 or later.
- **.NET:** the .NET SDK, and the `coverlet.collector` package in each test
  project (included by the standard xUnit, NUnit, and MSTest templates).
- **Node:** Node.js and the project's own test tool, runnable through the
  `test` script in `package.json`. Vitest also needs its coverage provider
  (`@vitest/coverage-v8`).
- **Python:** pytest and the `pytest-cov` plugin in the project's environment.

## Known limitations

- **Other extensions can take over the display.** If you run coverage through
  C# Dev Kit, the Jest extension, or the Python extension, VS Code switches to
  that run. Your accumulated coverage is still held; use
  `Coverage Tools: Show Coverage` to bring it back.
- **Coverage can go stale.** If you edit a file after a run, the highlighted
  lines may no longer match until you run again. Native coverage behaves the
  same way.
- **Partial runs from the terminal count as full runs** and replace the
  project's data. Use the right-click menu for partial runs that add up.
- **.NET projects on Microsoft.Testing.Platform** are not run by the extension
  in the first release. Reports they write are still picked up.
- **Node tools other than Jest and Vitest** run as a whole project only.
- **Nothing is persisted.** Coverage starts empty every time VS Code starts.

## Feature status

| Feature | Status |
|---------|--------|
| Design specification | Written, awaiting approval |
| Accumulated coverage in the native UI | Planned |
| Automatic detection of coverage reports | Planned |
| Run All Coverage | Planned |
| Run Coverage Here (Explorer right-click) | Planned |
| .NET support | Planned |
| Node support: Jest | Planned |
| Node support: Vitest | Planned |
| Node support: any other tool, through c8 | Planned |
| Python support: pytest | Planned |
| Custom command per project | Planned |
| Status bar total | Planned |
| Usage screenshots in this README | Planned |

## Installation

Not available yet. The first release will be distributed as a `.vsix` file
attached to a GitHub release.

## Changelog

See [CHANGELOG.md](CHANGELOG.md).

## License

[MIT](LICENSE)
