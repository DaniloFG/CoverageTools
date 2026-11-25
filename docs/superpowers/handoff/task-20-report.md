# Task 20 report: lightness budgets (with the Task 19 review fixes)

**Status:** DONE_WITH_CONCERNS. One budget is exceeded and its test is red: republication memory when each change is a re-run (60 MB against a 50 MB limit). The 5,000-file ingest block is tight.

## Commits
- `29eaafe` fix: bound the work done per file-system event (the Task 19 review fixes)
- `4684258` perf: union partial runs in slices and reuse unchanged published files (Task 20 remedies)
- `0f62e74` test: enforce the lightweight budgets (perf suite, generator, vitest perf project, CI job)

Only my own hunks were staged, using explicit paths and `git update-index` with prepared blobs. The working tree still holds another agent's uncommitted `store.ts` `summary()` work, plus `statusBar.ts`, `format.ts`, `storeSummary.test.ts` and UI tests. I did not commit or touch any of it.

## Budget table (final run, `npm run build && npm run test:perf`, this machine under load from other agents)

| Budget | Limit | Measured (min / median / max, samples) | Test | Status |
|---|---|---|---|---|
| Activation time (require + activate) | < 20 ms (median) | 11.5 / 12.1 / 14.1 ms, 20 fresh processes. The activate call alone: 1.02 / 1.11 / 1.53 ms | activation › activate returns in under 20 ms | pass, not tight (61%) |
| File reads, watchers, timers, workers during activate | 0 | 0 (node:fs sync, callback and promises; worker_threads; setTimeout/setInterval; fake workspace.fs/findFiles/createFileSystemWatcher; Worker constructions) | activation › activate performs no file reads, creates no watcher, timer or worker | pass |
| Timers at rest, empty workspace | 0 | 0 Timeout/Immediate (checked twice, 1 s apart), 0 workers started | activation › no timer is pending once discovery has settled | pass |
| At rest after a report was loaded and published | 0 timers, 0 workers | 0 / 0 (1 worker started, then exited) | activation › nothing is left running at rest… | pass |
| Main-thread block, 5,000-file ingest end to end (watcher → worker → store → publish, bundle) | < 50 ms (best of 3) | 41.5 / 42.9 / 48.5 ms. Earlier runs: 29.9 / 39.3 / 42.1 and 38.4 / 43.4 / 74.1 | ingest › …(watcher → worker → store → publish) | pass, **TIGHT (83%)** |
| Main-thread block, parse → replace → merged → totals (sources) | < 50 ms | 17.4 / 29.1 / 29.9 ms | ingest › …(parse → store.replace → merged → totals) | pass |
| Main-thread block, partial-run union + merged() + totals() | < 50 ms | 20.5 / 21.5 / 21.7 ms (before the remedy: 87.4 / 89.5 / 147.7) | ingest › a partial-run union over 5,000 files… | pass |
| Memory, 5,000 files accumulated and published | < 50 MB (median of 3) | 31.8 / 31.8 / 31.8 MB | ingest › 5,000 accumulated files add less than 50 MB | pass (64%) |
| Memory, 5,000 files + 50 republications, same data, 64-run history | < 50 MB | 32.5 / 32.6 / 32.6 MB | ingest › 50 republications … (unchanged data) | pass |
| Memory, 5,000 files + 50 republications, each re-running a 100-file project, 64-run history | < 50 MB | **60.0 / 60.0 / 60.1 MB** (before the remedy: 161.3) | ingest › 50 republications … each re-running a 100-file project … | **FAIL, limit kept** |
| Watcher hot path: 50,000 irrelevant events | < 100 ms total (median of 5) | 18.7 / 23.5 / 43.8 ms (before the fix: 153.3 / 155.3 / 286.5). 0 file calls, no timer added | watch › 50,000 irrelevant file events… | pass |
| Relevant burst: 2,000 excluded events ×2 + 200 new extension-less paths | ≤ 1 stat per distinct new path, 0 for excluded paths, ≤ 1 rediscovery | 200 stats for 200 paths (each stat shared by both consumers), 0 excluded, 200 searches (100 folders × 2 consumers, report-name glob, capped at 50), 0 rediscoveries | watch › a relevant burst… | pass |
| Discovery over 20,000 files / 30 projects | < 50 ms block (best of 3). Finds = 1 per folder + 1 per partial Node/.NET project. `.cs` reads only in test projects, ≤ 20 at a time | 13.1 / 13.3 / 15.7 ms. 21 finds (1 + 15 Node + 5 .NET). 500 `.cs` reads, all in `*.Tests`, at most 20 in flight | discovery.perf › discovery over 20,000 files… | pass |
| Bundle size | < 200 KB | 96,710 bytes (extension 81,650 + worker 15,060) | `npm run check:size` | pass |

Two budgets are within 30% of their limit: the 5,000-file end-to-end ingest block (41–48 ms best-of-3 in the last runs) and, on the other side of the limit, the re-run republication memory.

Sampling method (documented in `test/perf/helpers.ts`):
- Time budgets use the median of N runs.
- Block budgets use `monitorEventLoopDelay({ resolution: 5 })`. The work is repeated 3 times and the assertion is on the best (lowest) maximum.
- Memory is `heapUsed + external` after a double `gc()`. `external` and not `arrayBuffers`, because buffers transferred from the worker only show up in `external`. With `arrayBuffers` the 5,000-file figure read a false 8.5 MB.

## Concerns (decisions for you)
1. **Republication memory with re-runs: 60 MB against a 50 MB limit.** The extension's own cost per republication is now about 0.7 MB over 50 runs (same-data case: 32.5 MB against a 31.8 MB baseline). The other ~28 MB is the superseded data that each kept run still references. The design requires this: "each published FileCoverage carries the detail of that instant", so old runs in the history show what was true. With 50 re-runs of a 100-file project that is about 50 × 100 × 5.5 KB.
   - Options: accept this scenario as outside the 50 MB budget (the budget is for "5,000 files accumulated", which passes at 31.8 MB); drop per-instant detail for old runs; or retain less history.
   - I did not loosen the limit. The test stays red, so the CI `perf` job will fail until you decide.
   - The scenario's parameters are mine: 50 projects × 100 files, one project re-run per republication, 64 runs retained (the controller's number). For comparison, VS Code 1.147's ext host keeps `publishedCoverage` per run until `$disposeRun`, which the workbench sends when a result leaves its history.
2. **End-to-end ingest block is tight: 30–48 ms best-of-3 here.** A 2-core GitHub runner is slower, and I have no evidence either way that it holds there.
   - The largest synchronous chunks are the worker message's structured-clone deserialization, and `merged()` plus 5,000 `FileCoverage` constructions in `publishNow`.
   - The next remedy, if needed, is to add coverage to the open run in slices, or to send the worker's result as fewer, larger buffers.
   - I stopped at the two remedies that were needed to pass.
3. Controller bound for discovery finds said "one per partial-capable Node project". The code also searches once per partial .NET test project (`findInFolder` for `.cs`), so the asserted bound is 1 + Node + .NET (21 here).
4. Burst stats: "at most one per distinct path" holds overall. Each created path is stat'ed once and that one stat is shared by both consumers (`FileEvent.kindOnDisk()`). Each created folder is then searched once by each consumer: 2 searches per folder.

## Task 19 review fixes (all in `29eaafe`)
1. **Created-folder scan bounded** (`reportWatcher.ts`).
   - `.git` and excluded paths are dropped before any stat.
   - Created extension-less paths are collected over one 750 ms quiet period (one timer, which exists only while paths are pending), and only the outermost ones are scanned (at most 200 per period).
   - Each is stat'ed once (the shared stat). If it is a folder, it is searched with `findFiles(RelativePattern(dir, '**/{<last segment of each report glob>}'), excludes, 50)`, never `**/*`.
   - **Choice:** a report found that way loads only if its mtime is within the last 60 s. A moved-in or copied-in folder's old reports are not loaded, consistent with "reports already on disk are not loaded".
   - The CI-flake case (create `two/coverage/` and write right away) still loads, about 1.5 s later. The watch UI tests pass.
2. **Discovery events filtered by ecosystem and name** (`projects.ts`).
   - A path is queued only if a containing partial-capable project can take it: `.cs` in a .NET test project, a Node name accepted by the adapter's (pure) `isTestFile` called with a no-I/O reader, a Python test name, or an extension-less create/delete. Everything else costs zero I/O.
   - While a rediscovery is scheduled, events are dropped.
   - More than 200 pending paths become one rediscovery.
   - `refreshFile` accepts `kindOf` on its reader (one stat, replacing `exists`) and searches a path as a moved-in directory only when it is a directory.
   - `globToRegExp` is memoized (512 entries).
3. **`projects.ts` unit suite** (`test/unit/vscode/projects.test.ts`, 7 tests). It covers: node_modules / `.git` / excluded paths; saves outside projects or of non-test sources; a test-file save without a search; marker debounce (exactly one discovery); one rerun when requested during a discovery; a burst over the threshold becoming one rediscovery; dispose clearing the timer.
4. `.git` segments are skipped before any work, centrally in `WorkspaceFileEvents`.
5. The trace message is built only when `channel.logLevel === LogLevel.Trace`. The UI harness probe works: it launches with `--log …:trace`, and the UI suite passes.
6. The Coverage profile's run handler is a no-op, with the requested comment. Covered by a unit test in `test/unit/vscode/publisher.test.ts`.
7. The reportWatcher test was renamed to "…a created extension-less path costs one stat and no search". New tests cover: excluded / `.git` folders neither stat'ed nor searched; nested creates searched once from the outermost; moved-in old reports not loaded; the search uses report names with maxResults 50.
- **Watchers merged:** `src/vscode/fileEvents.ts` `WorkspaceFileEvents` is ONE `**/*` watcher per workspace folder, created in the post-activation `setImmediate` (before "Watching for coverage reports."). It computes folder, rel and name once and applies the excludes once, as one combined RegExp. Both consumers subscribe. Wiring is in `src/extension.ts` (about 10 lines; the other agent's edits there were already committed when I staged).
- Behaviour change: the report watcher no longer creates a watcher per folder of its own. With `watch.enabled: false` the shared watcher still exists for discovery, and the report watcher ignores its events.

### RED / GREEN
- glob memo:
  - RED: `npx vitest run --project unit test/unit/glob.test.ts` failed with "expected /…/ to be /…/ // Object.is equality" and "globCacheSize is not a function".
  - GREEN: 10 passed.
- refreshFile file-not-searched:
  - RED: `npx vitest run --project unit test/unit/discovery.test.ts -t "moved in only"` failed with "expected [ …(4) ] to deeply equal []" (4 finds).
  - GREEN: 33 passed.
- reportWatcher:
  - RED: with HEAD's `reportWatcher.ts` swapped back in, 5 of 13 failed (watcher count, report-name search, outermost-once, moved-in, excluded / `.git`).
  - GREEN: 13 passed.
- projects:
  - RED: with HEAD's `projects.ts`, 2 of 7 failed ("…costs nothing", "burst…one discovery"). The other 5 characterize behaviour that already held.
  - GREEN: 7 passed.
- publisher no-op:
  - RED: "expected 1 to be +0" (runs created by the handler).
  - GREEN: passed.
- fileEvents: written with its module (RED was "module missing"); 5 passed.
- Remedies (`4684258`):
  - store `unionInSlices`: RED "unionInSlices is not a function" (2 failed); GREEN 12 passed.
  - publisher reuse: RED "expected AccumulatedFileCoverage{…} to be AccumulatedFileCoverage{…}"; GREEN 2 passed.
  - Perf proof: the union block went from 87.4 to 20.5 ms best-of-3, the hot path from 155 to 23.5 ms median, republication memory from 161 to 60 MB.

## What else was implemented
- `test/perf/fakeVscode.ts` is a fake `vscode` module:
  - Uri shaped like VS Code's (fsPath cached), RelativePattern, an in-memory `workspace.fs` and `findFiles`, configuration (`changeSettings` fires the change event), watchers (`fire(kind, uris)`), output channel, commands, and a test controller that keeps the last `retainRuns` runs' FileCoverage objects.
  - It records `fs.stat` / `readFile` / `readDirectory`, `findFiles` and `createFileSystemWatcher`.
  - `installFakeVscode` hooks `Module._load`.
- `test/perf/child.ts` is bundled with esbuild in `beforeAll`. It runs the fresh-process activation timing and the idle checks: `getActiveResourcesInfo` Timeout/Immediate, and live Worker threads tracked by wrapping `worker_threads.Worker`.
- `test/perf/helpers.ts` loads the bundle and holds the sampling helpers.
- Test files:
  - `activation.perf.test.ts`: 4 tests (brief plus scenario f).
  - `ingest.perf.test.ts`: 6 tests (brief, scenario c split into same-data and re-run, scenario e).
  - `watch.perf.test.ts`: scenarios a and b.
  - `discovery.perf.test.ts`: scenario d. The in-memory reader answers on later loop turns, and the search runs in slices, so its own cost is not counted.
- `scripts/gen-big-report.mjs` (+ `.d.mts`) writes N empty source files and `coverage.xml` / `coverage-<variant>.xml`: 54 MB for 5,000 × 200 lines, with methods and branches.
- `vitest.config.ts` perf project: `pool: 'forks'`, `execArgv: ['--expose-gc']`, `fileParallelism: false`, `maxWorkers: 1`, 120 s timeouts.
- `.github/workflows/ci.yml` has a `perf` job (Node 20): `npm ci`, `npm run build`, `npm run test:perf`.

## Verification
- `npm run lint`: clean.
- `npm test`: 44 files, 647 passed.
- `npm run check:size`: 96,710 bytes.
- `xvfb-run -a npm run test:ui`: 25/25 passed (second run, after all fixes). The first run, mid-work, had 1 failure in `harness.ui.test.ts` ("closeAll while the VS Code process is starting"). That file was being changed by the other agent at the time, and the other agent then committed `dd14038 test: make the pending-launch harness test deterministic`.
- `npm run build && npm run test:perf`: 12 passed, 1 failed (concern 1), 49 s.

## For the README/CHANGELOG (numbers to quote)
- Activation 12 ms median (code loading included; the activate call itself is about 1 ms). Activation does no file access and creates no watcher, timer or worker.
- At rest: no timer and no worker thread.
- One file watcher per workspace folder. 50,000 irrelevant file events cost about 24 ms in total.
- 5,000-file Cobertura report (54 MB): longest main-thread block about 42 ms; 32 MB of memory with it accumulated and published.
- Partial-run union over 5,000 files: longest block about 21 ms.
- Discovery of 20,000 files / 30 projects: longest block about 13 ms.
- Bundle 97 KB (extension + worker).

## Budget rulings (controller round)

**Commits:**
- `8c05d12` perf: publish files without coverage data and read detail from the store
- `c379369` perf: send parsed reports from the worker in chunks
- `a8c0693` test: measure perf memory samples in isolation

### 1. Republication memory: published files pin no data
- `AccumulatedFileCoverage(uri, summary, path)` holds only the uri, the three `TestCoverageCount`s and the path.
- `loadDetailedCoverage` looks the path up in the current `store.merged()`. It uses a path index that is dropped on every store change, so it never keeps superseded entries. It returns `[]` when the path has left the store.
- A file whose counts are unchanged is republished as the same object. A changed file keeps its Uri.
- Documented consequence: an old Coverage Tools run opened from the Test Results history shows the current line detail. The design doc (section 6, "Publicação pela API nativa") is updated.
- Unit tests in `test/unit/vscode/publisher.test.ts`:
  - The detail comes from the current store, even for a file published before the change.
  - A path that left the store yields `[]`.
  - A published object has no property, to a depth of 4, holding a typed array or ArrayBuffer.
  - Reuse when counts are unchanged.
  - Sliced publication.
- RED (with HEAD's publisher, same test): 59.2 / 60.1 / 60.2 MB, failed. GREEN: **32.8 / 32.8 / 32.8 MB against the 50 MB limit: a margin of 17.2 MB (34%)**. The scenario is unchanged: 50 re-runs of a 100-file project, 64 runs retained.
- Measurement fix in the test harness (`a8c0693`). In an earlier sample, the test or the async frame still held data, which blurred the later samples' figures. Now:
  - each sample runs in its own function;
  - each bundle loads through its own `createRequire`, so the parent's `children` no longer keeps old bundles, fakes and stores;
  - `gc()` repeats until `external` holds still, because the array-buffer sweeper frees memory after the collection;
  - the republication test holds no data of its own.

### 2. Ingest block
I measured the main-thread chunks of a 5,000-file ingest here:
- structured-clone deserialization of the single worker message: 12–14 ms (best);
- `merged()` + summaries: 9–11 ms;
- the publish loop (5,000 `FileCoverage` + `addCoverage`): 25–46 ms (the dominant one);
- `store.replace`: 1–6 ms.

Cut:
- The publish loop now adds coverage in slices of at most 8 ms, with yields in between. It is one run, ended once; a newer publication or a close supersedes a slice in progress. `settled` fires when it is done, and `publishNow()` returns a Promise that Show Coverage awaits.
- The worker answers in `files` messages of at most 250 files, then `end`. The parse signature and semantics are unchanged. Unit tests cover order, two interleaved requests, an error mid-stream (one rejection, nothing pending, a fresh worker next), a crash mid-stream, and `toResponses` splitting. RED with HEAD's client: 10 failed.
- I could not slice `store.merged()`: `store.ts` belonged to another agent. Its ~10 ms is what remains.

Result, best-of-3 maximum, over three suite runs: **23.3 / 22.8 / 24.0 ms** (per-run min/median/max: 23.3/25.7/47.8, 22.8/22.8/37.5, 24.0/24.3/31.1). This meets "about 25 ms", but only just.

### Updated budget table (last full run: `npm run test:perf`, 13/13 passed)

| Budget | Limit | Measured (min / median / max, samples) | Test |
|---|---|---|---|
| Activation (require + activate) | < 20 ms median | 11.7 / 12.5 / 15.9 ms, 20 fresh processes (another run under load: 11.8 / 16.3 / 19.6). The activate call alone: 1.16 / 1.26 / 1.80 | activation › activate returns in under 20 ms |
| Reads, watchers, timers, workers in activate | 0 | 0 | activation › activate performs no file reads… |
| At rest (empty workspace; after ingest + publish) | 0 timers, 0 workers | 0 / 0 | activation › no timer… / nothing is left running… |
| Ingest block end to end | < 50 ms (best of 3) | 24.0 / 24.3 / 31.1 ms | ingest › …(watcher → worker → store → publish) |
| Parse → replace → merged | < 50 ms | 19.3 / 30.7 / 30.7 ms | ingest › …(parse → store.replace → merged → totals) |
| Partial-run union + merged + totals | < 50 ms | 22.9 / 24.9 / 34.1 ms | ingest › a partial-run union… |
| Memory, 5,000 files accumulated + published | < 50 MB | 31.8 / 31.8 / 31.8 MB | ingest › 5,000 accumulated files… |
| Memory, + 50 republications, same data | < 50 MB | 32.2 / 32.3 / 32.3 MB | ingest › 50 republications… (unchanged data) |
| Memory, + 50 republications, each a 100-file re-run | < 50 MB | 32.8 / 32.8 / 32.8 MB | ingest › 50 republications… each re-running… |
| Watcher hot path, 50,000 events | < 100 ms total, median of 5 | 28.4 / 30.5 / 46.5 ms | watch › 50,000 irrelevant file events… |
| Relevant burst | ≤ 1 stat per new path, ≤ 1 rediscovery | 200 stats / 200 paths, 0 rediscoveries | watch › a relevant burst… |
| Discovery, 20,000 files / 30 projects | < 50 ms | 12.4 / 13.3 / 16.3 ms | discovery.perf › … |
| Bundle | < 200 KB | 99,669 bytes | `npm run check:size` |

Tight (within 30% of the limit): none by the asserted figure. The activation median reached 16.3 ms (82%) in one run while the machine was loaded, against 12–13 ms otherwise.

### Verification
- `npm run lint`: clean.
- `npm test`: 664 passed.
- `npm run test:perf`: 13/13, twice.
- `xvfb-run -a npm run test:ui`: 27/27.
- `npm run check:size`: 99,669 bytes.

### For the README/CHANGELOG
- 5,000-file report: longest main-thread block about 24 ms; 32 MB of memory, which stays at about 33 MB after 50 republications.
- Activation about 12 ms.
- 50,000 file events: about 25–30 ms in total.
