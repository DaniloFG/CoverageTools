# Task 19 report — Run All Coverage, Run Coverage Here, trust, remaining settings

**Status:** DONE_WITH_CONCERNS (minor; see "Concerns")

## Commits
- `e23daae` fix: keep a # in the results root of unowned report labels (`src/format.ts` keyPath cuts at the LAST `#`, unit-tested)
- `55870a6` feat: add Run All Coverage and Run Coverage Here

My one-line edit to `src/discovery.ts` (`export const MARKER_FILE`) was committed by the discovery agent inside their `107aab9` (they committed the whole file while it was in my working tree). It is in HEAD.

## What was implemented
- **`src/vscode/fsReader.ts`** `vscodeFsReader(): VSCodeFsReader` = `FsReader` + `statMtime(path)`. `find` = one `workspace.findFiles(RelativePattern(dir, oneGlob(include)), oneGlob(exclude) ?? null)`; results also filtered with the excludes relative to `dir` (precompiled). `readText`/`exists` through `workspace.fs`; every failure reads as absent.
- **`src/glob.ts`** `expandBraces(glob)` and `oneGlob(globs)` (VS Code's matcher does not nest braces).
- **`src/vscode/projects.ts`** `ProjectDiscovery`: `start()` (called from `setImmediate` after `activate`) registers watchers and runs the first `discover`; `ready` resolves after it. One `FileSystemWatcher(RelativePattern(folder, '**/*'))` per workspace folder. Per event (cheap, compiled excludes per folder, `.git` segments skipped): `MARKER_FILE` name → debounced (750 ms) rediscovery; a candidate test file (`.cs/.py/js/ts…`) inside a discovered project, a `test_*.py`/`*_test.py` anywhere, or an extensionless created/deleted path (a folder moved in or deleted) → `refreshFile`, serialized, `rediscover` → debounce. Workspace folder changes and `coverageTools.exclude|nestedProjects|commands` changes → debounce. Discoveries never overlap (a request during one reruns it once). The `.cs` mtime cache (`testFileCache`) is kept across passes. The only timer is the debounce.
- **`src/vscode/runnablePaths.ts`** (no `vscode` import) `RunnablePathsContext`: sets `coverageTools.runnablePaths` (`{ [Uri.file(p).fsPath]: true }`) only when the key set changed.
- **`src/runner/suppression.ts`** `RunSuppressions`: suppressed from `suppress(key)` until 2,000 ms after the last `release()`; a timer exists only during a tail; new run during the tail cancels it; double release counts once; `dispose` clears tails.
- **`src/runner/batch.ts`** (pure): `runBatch(items, { queue, run, onStart })` enqueues every item at once (later requests queue behind), `onStart` not called for items cancelled before start, a throwing run → `spawn-error`. `progressMessage` → `Running coverage: <name> (n/N)`. `outcomeNotice`, `failureDetails`, `batchNotices`: one run → its own message; several → at most one warning `Tests failed in a, c; coverage was still loaded.` and one error `Coverage failed for N project(s): b, d. See the output for details.` (Show Output). Single-run error text: `Coverage failed for <name>: <message> <hint>`.
- **`src/vscode/commands.ts`** `registerCommands(deps)`: `runAll` (waits `ready`; none → `No test projects found in this workspace.`), `runHere(uri, selectedUris)` (multi-select, falls back to the active editor; `workspace.fs.stat` for file/folder; `resolveTarget`; duplicates dropped; none → `No tests to run here.`). Both run under `withProgress({ Notification, title: 'Coverage Tools', cancellable: true })`; cancel → `queue.cancelAll()`. Untrusted → warning `Coverage Tools runs no tests in an untrusted workspace.` (guard behind the `enablement`).
- **`src/extension.ts`**: adapters = `ADAPTERS` with Python replaced by `createPythonAdapter({ selectedInterpreter: dir => selectedPythonInterpreter(Uri.file(dir)) })` (resolved at plan time); runner map = those + `customAdapter`. `RunQueue` → `StatusBar(store, publisher, queue)`. Per run: fresh `vscodeFsReader()`, `readSettings(Uri.file(project.dir))`, workspace roots, `c8Bin = <ext>/node_modules/c8/bin/c8.js`, process output logged line by line, `suppress` → `RunSuppressions`. `ExtensionApi { store, ready, watching }`. `activate` reads nothing and starts no timer; the `setImmediate` callback logs `Watching for coverage reports.`, resolves `watching`, starts discovery.
- **`src/adapters/index.ts`**: `dotnetMtpAdapter` appended (it was committed in `018e1ce`).
- **`src/vscode/reportWatcher.ts`**: `projects()` = discovered projects; `isSuppressed` = `RunSuppressions`; unowned group `dir:${resultsRootOf(path)}`; `.coverage` interpreter from the owner's dir (already coded, now effective); injectable `folders()` and `fs`; ONE watcher per folder (`**/*`, globs matched in the extension, compiled once) instead of one per glob; **a created extensionless path is stat'ed and, if it is a folder, searched for reports** (see "Flaky watch test"); logs `Loaded <path> (<n> file(s)).` / `Loaded <path> (converted with coverage.py).`.
- **`package.json`**: commands `coverageTools.runAll` (`Run All Coverage`, icon `$(run-all-coverage)`) and `coverageTools.runHere` (`Run Coverage Here`), both `enablement: isWorkspaceTrusted`; menus `commandPalette` (runHere `when: false`), `explorer/context` (`isWorkspaceTrusted && resourcePath in coverageTools.runnablePaths`, group `2_workspace@90`), `view/title` (`view == workbench.view.testing`, `navigation@90`). Settings `nestedProjects`, `dotnet.collector`, `dotnet.extraArgs`, `node.extraArgs`, `python.interpreter`, `python.extraArgs`, `commands` (markdownDescription explains `${coverageDir}`), all `scope: resource`. The smoke test now checks every key's scope, description and default against `DEFAULT_SETTINGS`, and the commands/menus.
- **README/CHANGELOG** as ruled (MTP left In progress; limitations added; settings table synced).

## Tests and results
- Unit (new): `test/unit/runner/suppression.test.ts` (6, fake timers), `test/unit/runner/batch.test.ts` (7: order and n/N, cancel, two overlapping batches never run concurrently, throwing run, outcome mapping, details, summary), `test/unit/vscode/runnablePaths.test.ts` (4), `test/unit/vscode/reportWatcher.test.ts` (10, `vi.mock('vscode')`, injected folders: NotCoverage silent drop, ReportParseError retry once, generic error logged, `.coverage` untrusted, outside every folder / excluded, two GUID folders → one group and one key, owned + suppressed, non-report file needs no file access, folder created with a report inside), glob (2), format (1), smoke (rewritten).
- `npm run lint`: clean. `npm test`: 41 files, 619 tests passed. `npm run check:size`: 92,260 bytes (extension ~77 KB + worker 15 KB; limit 204,800).
- `xvfb-run -a npm run test:ui`: **25/25 passed in 5 min 17 s** (run 9 in 142 s, watch 7 in 89 s, publish 5 in 56 s, python 2 in 25 s, harness 2 in 1.4 s). The samples in the repository are left as they were (only the pre-existing ignored `bin/obj/.venv/node_modules/caches`).
- New `test/ui/run.ui.test.ts` (temp copies of the samples):
  1. Run All from the **Testing view title button** (it lives in the side bar title, since Test Explorer is the container's only view) → progress `Running coverage: … (n/3)` → 3 × `ok`; calc.js 100.00%, calc.py 83.33%, Calculator.cs present; then Run Coverage Here on the `node-jest` folder row → calc.py and Calculator.cs rows unchanged. (The brief's "running one project again keeps the other two" is merged into this test to build .NET once.)
  2. Explorer menu: absent on calc.js and the library Calc.csproj; present on calc.test.js, Calc.Tests.csproj and the Calc.Tests folder; `Coverage Tools: Run Coverage Here` not in the palette.
  3. Partial run on calc.test.js gives 0 < calc.js < 100%, then other.test.js → 100.00%.
  4. A folder `apps` holding node-jest and python-pytest → both run.
  5. Suppression: python-pytest copy whose `conftest.py` writes a 0% `coverage/lcov.info` into the workspace on every pytest run; after a partial run of test_calc.py and a 4 s wait, calc.py stays 50.00% and no `Loaded <that lcov>` line exists.
  6. Cancel: two custom `sleep 120` projects; Cancel on the notification → both `cancelled`, `b` never started, notification closes.
  7. No projects → `No test projects found in this workspace.`
  8. Custom `exit 3` → error toast `Coverage failed for a: The custom command wrote no coverage report…`; Show Output opens the channel with `Coverage failed for a (no-report)`.
  9. Untrusted (`trusted: false`): Run All not in the palette, Run Coverage Here not in the Explorer menu, a written LCOV is loaded (40.00%), nothing ran.
- Harness tests made deterministic with `LaunchOptions.onStage('launched' | 'window')`: closeAll at each stage, both paths every time.

## TDD evidence
- format: RED `npx vitest run --project unit test/unit/format.test.ts` → `Expected "/w/C#/Api/TestResults" Received "/w/C"` (with `indexOf`); GREEN 4 passed.
- suppression: RED `Cannot find module '../../../src/runner/suppression'`; GREEN 6 passed.
- reportWatcher grouping: RED with `dir:${dirname}` restored → 1 failed (two GUID folders ingested separately); GREEN 8 passed (later 10).
- batch / runnablePaths: test and module written together (RED was "module missing"); GREEN 7 and 4.
- UI: the first runs failed exactly on the missing pieces (event lost for a file in a new folder; menu click not taken; header actions hidden; copies without `.bin`), each fixed and re-run until 25/25.

## Flaky watch test on CI
**Cause: product (cause 1 in a different form), plus test timing.** Evidence from the trace lines I added (see below), captured on a failing local run before the fix:
```
[trace] File event (create): <ws>/one/coverage
[trace] File event (create): <ws>/one/coverage          ← no event for one/coverage/lcov.info, no "Loaded" line
```
When a folder is created and a file written into it right away (`writeReport` does `mkdir -p` + write; so do Jest, c8, pytest-cov, `dotnet test`), VS Code's watcher coalesces the burst into the folder's create event and drops the children's. The old per-glob watchers never matched the folder, so the report was lost; whether it happened depended on timing (CI under load). The test hit it on `two/coverage/lcov.info`, the first write into a new `two/coverage` folder. `writeReportUntil` hid it elsewhere (the second write is a change in an existing folder).
- **Fix (product):** the watcher stats a created extensionless path and, if it is a folder, searches it (one `findFiles`) for reports matching the globs. Unit-tested and covered by every watch UI test now (they write once into new folders).
- **Display switching (hypothesis 1 proper):** I read VS Code 1.147's `TestCoverageService`: on every completed result with coverage it calls `openCoverage(task, false)` (selects the new run, no focus), so a new publish always replaces ours on screen once the service exists; no change to `publisher.ts` was needed. What can vary is whether the *Test Coverage view* is visible: the harness now uses `Testing: Focus on Test Coverage View` when coverage is selected but the view is hidden, and `Test: Open Coverage` only when nothing is selected.
- **Test robustness:** `Loaded …` line; watcher-driven waits are 30 s; `waitForLoaded` says "no Loaded line: the file event or the ingestion never happened"; `waitForCoverageRow` reports the last row/view text ("the view did not update"); on failure `closeAll` writes `test-results/ui/<test>.output.txt` (the channel) next to the screenshot (the CI artifact uploads `test-results/`).
- **Watcher start-up:** `Watching for coverage reports.` alone was not enough: VS Code's own folder watcher can still be starting. `waitUntilWatching(s, folders)` writes a probe file `.coverage-tools-probe` in each folder until the extension logs its trace event, then deletes it.

## Reader lifetime
`vscodeFsReader()` objects: a fresh one per discovery pass (`ProjectDiscovery` takes `makeFs`, called per pass), per `refreshFile`, and per `runProject` call (built inside the run wrapper in `extension.ts`, with a comment). The report watcher keeps one reader for the session, used only for `exists` on venv interpreters by `resolveInterpreter` (commented); no adapter caches anything on it. No extra test (not cheap to observe).

## For the next tasks
- **Output-channel signal lines** (info level): `Watching for coverage reports.` (watchers registered, before discovery starts), `Discovery finished: N project(s).` (after each discovery), `Loaded <abs path> (<n> file(s)).` / `Loaded <abs path> (converted with coverage.py).`, `Running coverage for <name> (all tests | <paths>).`, `> <command line>`, tool output line by line, `Finished coverage for <name>: <status>.`, `Coverage failed for <name> (<status>): …`, `Tests failed in <name> (tests-failed): …`. Trace level (only with `--log=DaniloFG.coverage-tools:trace`, which the harness passes): `File event (create|change|delete): <path>`.
- **Log file**: `<user-data>/logs/<session>/window1/exthost/DaniloFG.coverage-tools/Coverage Tools.log`; the harness reads it (`outputChannelText` no longer drives the UI).
- **New harness helpers**: `copySamples(names)` (skips bin/obj/TestResults/caches outside `node_modules`/`.venv`, keeps symlinks verbatim), `makeWorkspace(files)`, `waitUntilWatching(s, folders)`, `waitForDiscovery(s, nth?)` → project count, `waitForLoaded(s, path)`, `waitForOutput(s, text | RegExp | predicate)`, `revealInExplorer(s, name, query?)`, `explorerMenu(s, label)` → item labels, `runFromExplorer(s, label, item)` (hover + Enter: a plain click on a menu item is not always taken), `notificationTexts(s)`, `openFile(name, query?)`, `runCommand(title, { timeoutMs })`, `session.userDataDir`, `LaunchOptions.onStage`. `writeReportUntil` remains only for the `watch.enabled` toggle (a rebuild on a setting change logs nothing).
- **Samples workspace**: `samples/samples.code-workspace` with folders `node-jest`, `python-pytest`, `dotnet-vstest-coverlet`; project names `node-jest-sample`, `python-pytest`, `Calc.Tests`; Run All gives calc.js 100.00%, calc.py 83.33%, Calculator.cs. A cold .NET build in a fresh copy took ~10–15 s here; the whole Run All test 26 s.
- **Selectors**: Run All button `.part.sidebar .action-label[aria-label="Run All Coverage"]:visible`; Explorer rows `.explorer-folders-view .monaco-list-row[aria-label="<name>"]` (aria-level = depth, root folder rows level 1); context menu items `.monaco-menu .action-item .action-label`; toasts `.notifications-toasts .notification-list-item` (buttons `.monaco-button` `Cancel`, `Show Output`).
- UI suite: ~5 min 20 s locally for 25 tests.

## Concerns / deviations
- **Watchers**: two `**/*` watchers per workspace folder (discovery and reports) instead of one brace glob; directories must be seen (folder create/delete), which a brace glob of file names cannot match. This also replaces the report watcher's 7 per folder. Events are filtered in O(1)–O(projects) with compiled regexes.
- **Created extensionless paths** cost one `stat` each (report watcher) and may cost one `refreshFile` (discovery) — e.g. creating `Makefile`; changes (saves) never do.
- **Explorer item only in trusted workspaces** (`isWorkspaceTrusted` in its `when`), so nothing needs refreshing on `onDidGrantWorkspaceTrust`; discovery runs in untrusted workspaces too (it only reads files) so watcher ownership works.
- **Icon** `$(run-all-coverage)` exists in VS Code 1.147; I could not verify it in 1.90 (if absent there, the title button shows no glyph but works; the overflow/palette entries are unaffected).
- **Native "Run Tests with Coverage"** appears in the Explorer menu (and palette) because our controller has a Coverage profile; its handler only republishes. Pre-existing behaviour, worth a look.
- **Brief's suppression test** used `python-pytest-configured`, which the CI `ui` job does not set up and which writes no report into the workspace; I used a python-pytest copy with a `conftest.py` that writes one (same intent, deterministic).
- Single-run error text is prefixed `Coverage failed for <name>: ` before the message/hint; the progress title is `Coverage Tools`.
- Some brief tests are merged (Run All + run one again) to build .NET once.

## Fix round 1

Commits:
- `dd14038` test: make the pending-launch harness test deterministic
- `59d5079` fix: never queue the same run twice and always log the end of a run

I did not edit `reportWatcher.ts`, `projects.ts`, `publisher.ts` or `discovery.ts`. Other agents had uncommitted changes in `src/extension.ts` and `test/ui/harness.ts` (`WorkspaceFileEvents` wiring, the `installed`/`args` launch options). For those two files I staged only my own hunks: I built each file from HEAD plus my changes, then ran `git hash-object` / `update-index`. I exported the index to a temp directory, where `tsc` was clean and the unit tests for runner and smoke passed (65 tests).

1. **Pending-launch test (Important).**
   - **Change:**
     - The `onStage` callback now records the stage and awaits `closeAll`.
     - The launch reports a new stage, `'closed-while-launching'`, right before it closes the process it received after the session was already closed.
     - The new `LaunchStage` type is exported.
   - **What the tests assert:**
     - The 'launched' test asserts the stages `['launched', 'closed-while-launching']`.
     - The 'window' test asserts `['launched', 'window']`.
     - Both assert that the launch rejected.
   - **Mutation check:** with the `closed-while-launching` notification removed, the 'launched' test fails (`expected [ 'launched' ] to deeply equal [ Array(2) ]`). Restored, both pass.
   - **Process check:** the test used to require that no `coverage-tools-ui-` process existed beforehand. That check failed once because another agent's VS Code was running at the same time. The test now records the processes that exist before the launch and only waits for its own to exit.
2. **Suppression UI test.** It now has a positive control. After the wait, the test itself writes the same `coverage/lcov.info` (outside any run, after the tail). It then calls `waitForLoaded` and checks that calc.py drops to 0.00%.
3. **End of a run always logged.** The logging moved to `loggedRun(item, signal, log, start)` in `src/runner/batch.ts`, together with `lineLogger`.
   - **Behaviour:** the last unfinished output line is flushed in `finally`. A run that rejects becomes `{ status: 'spawn-error', message: 'Unexpected error: …' }`. The `Finished coverage for <name>: <status>.` line is always written. `extension.ts` uses `loggedRun`.
   - **Unit tests:** normal run with split lines and CRLF; a throwing run (flush plus end line); a run cancelled before it started (end line only); `lineLogger`.
4. **No duplicate runs.**
   - **Change:** a new class `InFlight` in `batch.ts` tracks runs by project key plus target. `claim(items)` returns only the runs not already queued or running (it also removes duplicates within one request). `runBatch({ inFlight })` releases each run when it settles. `commands.ts` holds one `InFlight` per registration and returns silently when nothing is new. The older per-call deduplication in `runHere` is replaced by this.
   - **Unit tests:**
     - Two Run All requests in a row run each project once, and the same request runs it again after it has finished.
     - Run Coverage Here for a project already queued in full is not added, while a different partial target is added (once).
     - The full runs are released after a cancel.
   - **Mutation check:** without the release, 2 tests fail.
5. **Icon.** I downloaded VS Code 1.90.0 with `@vscode/test-electron`. Its `workbench.desktop.main.js` registers `runAllCoverage:(0,t.$Uj)("run-all-coverage",60461)`, along with `run-coverage` and `debug-coverage`. So `$(run-all-coverage)` exists in 1.90 and I kept it. I deleted the download afterwards.
6. **Probe signal.** This was the coordinator's note. `waitUntilWatching` now accepts any output line that names the probe file, so a change of wording or mechanism in `projects.ts` keeps working as long as some line names the path. I saw that the performance agent's working copy makes the trace message lazy (`channel.logLevel === Trace`). The harness still launches with `--log=DaniloFG.coverage-tools:trace`.

Verification:
- `npm run lint`: my files are clean. `tsc` passed once the performance agent's work in progress compiled again (at one point their `src/vscode/reportWatcher.ts` had a syntax error). `eslint` reports 1 error, in their `test/perf/explore.perf.test.ts`.
- `npm test`: 41 files, 627 tests passed.
- `xvfb-run -a npm run test:ui`: 25/25 passed in 5 min 28 s (run 9, watch 7, publish 5, python 2, harness 2). This ran on the working tree, which includes the performance agent's uncommitted watcher changes.
