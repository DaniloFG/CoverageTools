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
import { isWithin, ownerOf, resultsRootOf, unownedKey } from '../watcher/attribution';
import { ReportBatcher, type IngestResult } from '../watcher/batcher';
import { ingestCoverageData } from '../watcher/coveragepy';

/** Quiet time after the last event of a group before its report is read. */
const WATCH_DEBOUNCE_MS = 750;
/** Delay before the one new attempt at a report that could not be read (it may still be being written). */
const RETRY_MS = 1_000;

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
  /** The workspace folders; `vscode.workspace.workspaceFolders` unless a test injects them. */
  folders?(): readonly vscode.WorkspaceFolder[];
}

interface Matcher { globs: RegExp[]; exclude: RegExp[]; excludeGlob: string | undefined }

const posixRelative = (from: string, to: string): string => nodePath.relative(from, to).split(nodePath.sep).join('/');

/**
 * Picks up coverage reports written outside the extension (terminal, tasks, scripts): one file
 * system watcher per workspace folder, matched against the report globs, debounced per project, then parsed in the
 * worker and stored under the owning project (or under an `unowned:` key). coverage.py data files
 * (`.coverage`) are first converted to Cobertura with the project's interpreter, in trusted
 * workspaces only. Reports already on disk are not loaded. Creating the watchers reads no file,
 * starts no timer and probes no interpreter.
 */
export class ReportWatcher {
  private readonly batcher: ReportBatcher;
  private watchers: vscode.Disposable[] = [];
  /** Per watched workspace folder: its report globs and excludes, compiled once. */
  private readonly matchers = new Map<string, Matcher>();
  private readonly subscriptions: vscode.Disposable[];
  private disposed = false;
  /** Aborted on dispose: stops a running coverage.py conversion. */
  private readonly abort = new AbortController();

  constructor(private readonly deps: ReportWatcherDeps) {
    this.batcher = new ReportBatcher({
      debounceMs: WATCH_DEBOUNCE_MS,
      retryMs: RETRY_MS,
      groupOf: path => this.groupOf(path),
      isSuppressed: group => deps.isSuppressed(group),
      ingest: (_group, path) => this.ingest(path),
      timers: { set: (fn, ms) => setTimeout(fn, ms), clear: h => clearTimeout(h as ReturnType<typeof setTimeout>) },
    });
    this.subscriptions = [
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('coverageTools.watch')) this.rebuild();
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.rebuild()),
    ];
    this.rebuild();
  }

  dispose(): void {
    this.disposed = true;
    this.abort.abort();
    for (const d of [...this.subscriptions, ...this.watchers]) d.dispose();
    this.watchers = [];
    this.batcher.dispose();
  }

  private rebuild(): void {
    for (const w of this.watchers) w.dispose();
    this.watchers = [];
    this.matchers.clear();
    for (const folder of this.folders()) {
      const settings = this.deps.settingsOf(folder.uri);
      if (!settings.watchEnabled) continue;
      this.matchers.set(folder.uri.fsPath, {
        globs: settings.watchGlobs.map(globToRegExp),
        exclude: settings.exclude.map(globToRegExp),
        excludeGlob: oneGlob(settings.exclude),
      });
      // One watcher per folder for every path, matched against the globs here: a folder created with
      // reports already inside comes as one event for the folder (VS Code drops the children's).
      // Deletions are of no interest: they never bring coverage.
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, '**/*'), false, false, true);
      this.watchers.push(
        watcher,
        watcher.onDidCreate(uri => this.onEvent(uri, true)),
        watcher.onDidChange(uri => this.onEvent(uri, false)),
      );
    }
  }

  private onEvent(uri: vscode.Uri, created: boolean): void {
    if (this.disposed || uri.scheme !== 'file') return;
    const path = uri.fsPath;
    const folder = this.folderOf(path);
    const matcher = folder && this.matchers.get(folder.uri.fsPath);
    if (!folder || !matcher) return;
    const relative = posixRelative(folder.uri.fsPath, path);
    if (matcher.exclude.some(re => re.test(relative))) return;
    if (matcher.globs.some(re => re.test(relative))) this.batcher.push(path);
    // A name without an extension may be a folder created with reports in it (`coverage`, a TestResults run).
    else if (created && !nodePath.basename(path).includes('.')) void this.scanCreatedFolder(folder.uri.fsPath, path, matcher);
  }

  /** Pushes the reports inside `dir` when it is a folder that was just created. */
  private async scanCreatedFolder(folder: string, dir: string, matcher: Matcher): Promise<void> {
    let uris: vscode.Uri[];
    try {
      const stat = await vscode.workspace.fs.stat(vscode.Uri.file(dir));
      if ((stat.type & vscode.FileType.Directory) === 0) return;
      uris = await vscode.workspace.findFiles(new vscode.RelativePattern(vscode.Uri.file(dir), '**/*'), matcher.excludeGlob ?? null);
    } catch {
      return; // Gone again, or not readable.
    }
    if (this.disposed || this.matchers.get(folder) !== matcher) return;
    for (const uri of uris) {
      const relative = posixRelative(folder, uri.fsPath);
      if (matcher.globs.some(re => re.test(relative)) && !matcher.exclude.some(re => re.test(relative))) this.batcher.push(uri.fsPath);
    }
  }

  /** The innermost workspace folder that holds `path`; undefined for paths outside all of them. */
  private folderOf(path: string): vscode.WorkspaceFolder | undefined {
    let best: vscode.WorkspaceFolder | undefined;
    for (const folder of this.folders()) {
      if (!isWithin(folder.uri.fsPath, path)) continue;
      if (!best || folder.uri.fsPath.length > best.uri.fsPath.length) best = folder;
    }
    return best;
  }

  private folders(): readonly vscode.WorkspaceFolder[] {
    return this.deps.folders?.() ?? vscode.workspace.workspaceFolders ?? [];
  }

  /** Same results root, same group: as the store key of an unowned report (`unownedKey`). */
  private groupOf(path: string): string {
    return ownerOf(path, this.deps.projects())?.key ?? `dir:${resultsRootOf(path)}`;
  }

  private roots(): string[] {
    return this.folders().map(f => f.uri.fsPath);
  }

  private keyOf(path: string, signature: string): string {
    return ownerOf(path, this.deps.projects())?.key ?? unownedKey(path, signature);
  }

  /** coverage.py data: converted with the interpreter of the owning project, or of the file's directory. */
  private ingestCoverageData(path: string): Promise<IngestResult> {
    return ingestCoverageData(path, {
      isTrusted: () => this.deps.isTrusted(),
      interpreterFor: file => {
        const uri = vscode.Uri.file(file);
        const dir = ownerOf(file, this.deps.projects())?.dir ?? nodePath.dirname(file);
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
    this.deps.store.replace(this.keyOf(path, report.signature), report.files);
    // Tells when a report was taken in (tests wait on this line too).
    this.deps.log(`Loaded ${path} (${report.files.length} file(s)).`);
    return 'ok';
  }
}
