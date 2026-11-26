import { rmSync } from 'node:fs';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import nodePath from 'node:path';
import * as vscode from 'vscode';
import { resolveInterpreter } from '../adapters/python';
import type { FsReader, Project } from '../adapters/types';
import { globToRegExp, oneGlob } from '../glob';
import { formatOf } from '../parsers/load';
import { NotCoverageReportError, ReportParseError, type ParsedReport } from '../parsers/types';
import { exec } from '../runner/exec';
import type { Settings } from '../settings';
import type { CoverageStore } from '../store';
import { applyReport } from '../watcher/apply';
import { ownerOf, ownersOf, resultsRootOf, unownedKey } from '../watcher/attribution';
import { ReportBatcher, type IngestResult } from '../watcher/batcher';
import { ingestCoverageData } from '../watcher/coveragepy';
import { anyOf, type FileEvent, type FileEventSource } from './fileEvents';

/** Quiet time after the last event of a group before its report is read. */
const WATCH_DEBOUNCE_MS = 750;
/** Delay before the one new attempt at a report that could not be read (it may still be being written). */
const RETRY_MS = 1_000;
/** At most this many reports are searched for in one created folder. */
const MAX_FOLDER_RESULTS = 50;
/** At most this many created folders are searched per quiet period (the outermost ones). */
const MAX_FOLDER_SCANS = 200;
/**
 * A report found in a created folder is loaded only if it was written this recently: a folder moved
 * or copied in brings old reports, and reports already on disk are never loaded.
 */
const RECENT_REPORT_MS = 60_000;

export interface ReportWatcherDeps {
  store: CoverageStore;
  parser: { parse(reportPath: string, roots: readonly string[]): Promise<ParsedReport> };
  /** The settings that apply to a workspace folder or a file in it. */
  settingsOf(scope: vscode.Uri): Settings;
  /** The discovered projects; a report belongs to the nearest one above it. */
  projects(): readonly Project[];
  /** Whether reports of this group (a project key, or `dir:<results root>`) are to be ignored for now. */
  isSuppressed(key: string): boolean;
  /** Workspace Trust; coverage.py data files are only converted in a trusted workspace. */
  isTrusted(): boolean;
  /** The interpreter selected in the Python extension for a file, if it is installed and active. */
  pythonSelection(uri: vscode.Uri): string | undefined;
  /** What interpreter resolution reads (whether a venv interpreter exists). */
  fs: FsReader;
  log(msg: string): void;
  /** The workspace's file events (one watcher per folder, shared with project discovery). */
  events: FileEventSource;
  /** The workspace folders; `vscode.workspace.workspaceFolders` unless a test injects them. */
  folders?(): readonly vscode.WorkspaceFolder[];
  /** The clock for "recently written"; `Date.now` unless a test injects one. */
  now?(): number;
}

interface Matcher {
  globs: RegExp | undefined;
  exclude: RegExp[];
  excludeGlob: string | undefined;
  /** What a created folder is searched for: the last segment of each report glob, under any directory. */
  folderGlob: string | undefined;
}

const posixRelative = (from: string, to: string): string => nodePath.relative(from, to).split(nodePath.sep).join('/');

/**
 * Picks up coverage reports written outside the extension (terminal, tasks, scripts): the shared
 * file events of each workspace folder, matched against the report globs, debounced per project, then
 * parsed in the worker and stored under the owning project (or under an `unowned:` key). coverage.py
 * data files (`.coverage`) are first converted to Cobertura with the project's interpreter, in trusted
 * workspaces only. Reports already on disk are not loaded. Construction reads no file, starts no
 * timer and probes no interpreter.
 *
 * A folder created with reports already inside comes as one event for the folder (VS Code drops the
 * children's). Created extension-less paths are collected over one quiet period; then only the
 * outermost ones are stat'ed and, if they are folders, searched for report names (at most
 * MAX_FOLDER_RESULTS each). Of what is found, only reports written in the last RECENT_REPORT_MS are
 * loaded: a folder moved or copied in brings its old reports, which are not loaded.
 */
export class ReportWatcher {
  private readonly batcher: ReportBatcher;
  /** Per watched workspace folder: its report globs and excludes, compiled once. */
  private readonly matchers = new Map<string, Matcher>();
  /** Created extension-less paths waiting for the quiet period to end, with their event. */
  private readonly createdDirs = new Map<string, FileEvent>();
  private scanTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly subscriptions: vscode.Disposable[];
  private disposed = false;
  /** Aborted on dispose: stops a running coverage.py conversion. */
  private readonly abort = new AbortController();

  constructor(private readonly deps: ReportWatcherDeps) {
    this.batcher = new ReportBatcher({
      debounceMs: WATCH_DEBOUNCE_MS,
      retryMs: RETRY_MS,
      groupOf: path => this.groupOf(path),
      ingestsMany: group => group.startsWith('dir:'),
      isSuppressed: group => deps.isSuppressed(group),
      ingest: (_group, path) => this.ingest(path),
      timers: { set: (fn, ms) => setTimeout(fn, ms), clear: h => clearTimeout(h as ReturnType<typeof setTimeout>) },
    });
    this.subscriptions = [
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('coverageTools.watch') || e.affectsConfiguration('coverageTools.exclude')) this.rebuild();
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.rebuild()),
      // Deletions are of no interest: they never bring coverage.
      deps.events.onDidFileEvent(e => {
        if (e.kind !== 'delete') this.onEvent(e);
      }),
    ];
    this.rebuild();
  }

  dispose(): void {
    this.disposed = true;
    this.abort.abort();
    for (const d of this.subscriptions) d.dispose();
    this.clearScan();
    this.batcher.dispose();
  }

  private rebuild(): void {
    this.matchers.clear();
    this.clearScan();
    for (const folder of this.folders()) {
      const settings = this.deps.settingsOf(folder.uri);
      if (!settings.watchEnabled) continue;
      const names = [...new Set(settings.watchGlobs.map(lastSegment))];
      this.matchers.set(folder.uri.fsPath, {
        globs: anyOf(settings.watchGlobs),
        exclude: settings.exclude.map(globToRegExp),
        excludeGlob: oneGlob(settings.exclude),
        folderGlob: oneGlob(names.map(n => `**/${n}`)),
      });
    }
  }

  /** Excluded paths and `.git` never get here (see `WorkspaceFileEvents`). */
  private onEvent(e: FileEvent): void {
    if (this.disposed) return;
    const matcher = this.matchers.get(e.folder);
    if (matcher === undefined || matcher.globs === undefined) return;
    if (matcher.globs.test(e.rel)) this.batcher.push(e.path);
    // A name without an extension may be a folder created with reports in it (`coverage`, a TestResults run).
    else if (e.kind === 'create' && e.rel !== '' && !e.name.includes('.')) this.queueCreated(e);
  }

  private queueCreated(e: FileEvent): void {
    this.createdDirs.set(e.path, e);
    if (this.scanTimer !== undefined) clearTimeout(this.scanTimer);
    this.scanTimer = setTimeout(() => {
      this.scanTimer = undefined;
      void this.scanCreated();
    }, WATCH_DEBOUNCE_MS);
  }

  private clearScan(): void {
    if (this.scanTimer !== undefined) clearTimeout(this.scanTimer);
    this.scanTimer = undefined;
    this.createdDirs.clear();
  }

  /** Searches the outermost of the folders created during the quiet period. */
  private async scanCreated(): Promise<void> {
    const created = [...this.createdDirs];
    this.createdDirs.clear();
    const dirs = new Set(created.map(([dir]) => dir));
    const outermost = created.filter(([dir]) => {
      for (let d = nodePath.dirname(dir); d !== nodePath.dirname(d); d = nodePath.dirname(d)) if (dirs.has(d)) return false;
      return true;
    });
    for (const [, event] of outermost.slice(0, MAX_FOLDER_SCANS)) {
      if (this.disposed) return;
      await this.scanCreatedFolder(event);
    }
  }

  /** Pushes the recently written reports inside the created path when it is a folder. */
  private async scanCreatedFolder(e: FileEvent): Promise<void> {
    const { folder, path: dir } = e;
    const matcher = this.matchers.get(folder);
    if (matcher?.globs === undefined || matcher.folderGlob === undefined) return;
    const now = this.deps.now?.() ?? Date.now();
    const found: string[] = [];
    try {
      // The event's one stat, shared with project discovery.
      if ((await e.kindOnDisk()) !== 'directory') return;
      const uris = await vscode.workspace.findFiles(
        new vscode.RelativePattern(vscode.Uri.file(dir), matcher.folderGlob), matcher.excludeGlob ?? null, MAX_FOLDER_RESULTS);
      for (const uri of uris) {
        const relative = posixRelative(folder, uri.fsPath);
        if (!matcher.globs.test(relative) || matcher.exclude.some(re => re.test(relative))) continue;
        const { mtime } = await vscode.workspace.fs.stat(uri);
        if (now - mtime <= RECENT_REPORT_MS) found.push(uri.fsPath);
      }
    } catch {
      return; // Gone again, or not readable.
    }
    if (this.disposed || this.matchers.get(folder) !== matcher) return;
    for (const p of found) this.batcher.push(p);
  }

  private folders(): readonly vscode.WorkspaceFolder[] {
    return this.deps.folders?.() ?? vscode.workspace.workspaceFolders ?? [];
  }

  /** Same results root, same group: as the store key of an unowned report (`unownedKey`). */
  private groupOf(path: string): string {
    return this.ownerKeyOf(path) ?? `dir:${resultsRootOf(path)}`;
  }

  private roots(): string[] {
    return this.folders().map(f => f.uri.fsPath);
  }

  private keyOf(path: string, signature: string): string {
    return this.ownerKeyOf(path) ?? unownedKey(path, signature);
  }

  /**
   * The owning project's key. When projects share a directory (Node and Python at one root) and the
   * report's format does not tell them apart, each format gets its own key, so that their reports
   * do not replace each other; the store unions them when it merges.
   */
  private ownerKeyOf(path: string): string | undefined {
    const format = formatOf(path);
    const owners = ownersOf(path, this.deps.projects(), nodePath, format);
    if (owners.length === 0) return undefined;
    return owners.length > 1 && format !== undefined ? `${owners[0].key}#${format}` : owners[0].key;
  }

  /** coverage.py data: converted with the interpreter of the owning project, or of the file's directory. */
  private ingestCoverageData(path: string): Promise<IngestResult> {
    return ingestCoverageData(path, {
      isTrusted: () => this.deps.isTrusted(),
      interpreterFor: file => {
        const uri = vscode.Uri.file(file);
        const dir = ownerOf(file, this.deps.projects(), nodePath, 'coveragepy')?.dir ?? nodePath.dirname(file);
        return resolveInterpreter(dir, this.deps.settingsOf(uri), this.deps.fs, this.deps.pythonSelection(uri));
      },
      exec,
      parse: (report, roots) => this.deps.parser.parse(report, roots),
      makeTempDir: async () => mkdtemp(nodePath.join(await realpath(os.tmpdir()), 'coverage-tools-')),
      removeDir: dir => rm(dir, { recursive: true, force: true }),
      removeDirNow: dir => {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          // Removed again, asynchronously, once the conversion has ended.
        }
      },
      store: this.deps.store,
      keyOf: (file, signature) => this.keyOf(file, signature),
      roots: () => this.roots(),
      log: msg => this.deps.log(msg),
      signal: this.abort.signal,
      timers: { set: (fn, ms) => setTimeout(fn, ms), clear: h => clearTimeout(h as ReturnType<typeof setTimeout>) },
    });
  }

  private async ingest(path: string): Promise<IngestResult> {
    if (formatOf(path) === 'coveragepy') {
      const result = await this.ingestCoverageData(path);
      if (result === 'ok' && !this.disposed) this.deps.log(`Loaded ${path} (converted with coverage.py).`);
      return result;
    }
    const roots = this.roots();
    let report: ParsedReport;
    try {
      report = await this.deps.parser.parse(path, roots);
    } catch (error) {
      if (this.disposed || error instanceof NotCoverageReportError) return 'drop';
      if (error instanceof ReportParseError) {
        this.deps.log(`Could not read the coverage report ${path} yet: ${error.message}`);
        return 'retry';
      }
      this.deps.log(`Could not load the coverage report ${path}: ${error instanceof Error ? error.message : String(error)}`);
      return 'drop';
    }
    if (this.disposed) return 'drop';
    if (!applyReport(this.deps.store, this.keyOf(path, report.signature), report, path, msg => this.deps.log(msg))) return 'ok';
    // Tells when a report was taken in (tests wait on this line too).
    this.deps.log(`Loaded ${path} (${report.files.length} file(s)).`);
    return 'ok';
  }
}

// The last segment of a glob (`lcov.info` for the LCOV default); `*` when it is a double star.
function lastSegment(glob: string): string {
  const last = glob.replace(/\\/g, '/').split('/').pop() ?? '';
  return last === '' || last === '**' ? '*' : last;
}
