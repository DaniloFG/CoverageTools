import nodePath from 'node:path';
import * as vscode from 'vscode';
import type { Project } from '../adapters/types';
import { matchesAny } from '../glob';
import { formatOf } from '../parsers/load';
import { NotCoverageReportError, ReportParseError, type ParsedReport } from '../parsers/types';
import type { Settings } from '../settings';
import type { CoverageStore } from '../store';
import { isWithin, ownerOf, unownedKey } from '../watcher/attribution';
import { ReportBatcher, type IngestResult } from '../watcher/batcher';

/** Quiet time after the last event of a group before its report is read. */
const WATCH_DEBOUNCE_MS = 750;
/** Delay before the one new attempt at a report that could not be read (it may still be being written). */
const RETRY_MS = 1_000;

export interface ReportWatcherDeps {
  store: CoverageStore;
  parser: { parse(reportPath: string, roots: readonly string[]): Promise<ParsedReport> };
  settingsOf(folder: vscode.Uri): Settings;
  projects(): readonly Project[];
  /** Whether reports of this group (a project key, or `dir:<directory>`) are to be ignored for now. */
  isSuppressed(key: string): boolean;
  log(msg: string): void;
}

/**
 * Picks up coverage reports written outside the extension (terminal, tasks, scripts): one file
 * system watcher per workspace folder and report glob, debounced per project, then parsed in the
 * worker and stored under the owning project (or under an `unowned:` key). Reports already on
 * disk are not loaded. Creating the watchers reads no file and starts no timer.
 */
export class ReportWatcher {
  private readonly batcher: ReportBatcher;
  private watchers: vscode.Disposable[] = [];
  private readonly subscriptions: vscode.Disposable[];
  private disposed = false;

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
    for (const d of [...this.subscriptions, ...this.watchers]) d.dispose();
    this.watchers = [];
    this.batcher.dispose();
  }

  private rebuild(): void {
    for (const w of this.watchers) w.dispose();
    this.watchers = [];
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const settings = this.deps.settingsOf(folder.uri);
      if (!settings.watchEnabled) continue;
      for (const glob of settings.watchGlobs) {
        // Deletions are of no interest: they never bring coverage.
        const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, glob), false, false, true);
        const onEvent = (uri: vscode.Uri): void => this.onEvent(uri);
        this.watchers.push(watcher, watcher.onDidCreate(onEvent), watcher.onDidChange(onEvent));
      }
    }
  }

  private onEvent(uri: vscode.Uri): void {
    if (this.disposed || uri.scheme !== 'file') return;
    const path = uri.fsPath;
    const folder = this.folderOf(path);
    if (!folder) return;
    const relative = nodePath.relative(folder.uri.fsPath, path);
    if (matchesAny(relative, this.deps.settingsOf(folder.uri).exclude)) return;
    this.batcher.push(path);
  }

  /** The innermost workspace folder that holds `path`; undefined for paths outside all of them. */
  private folderOf(path: string): vscode.WorkspaceFolder | undefined {
    let best: vscode.WorkspaceFolder | undefined;
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      if (!isWithin(folder.uri.fsPath, path)) continue;
      if (!best || folder.uri.fsPath.length > best.uri.fsPath.length) best = folder;
    }
    return best;
  }

  private groupOf(path: string): string {
    return ownerOf(path, this.deps.projects())?.key ?? `dir:${nodePath.dirname(path)}`;
  }

  private async ingest(path: string): Promise<IngestResult> {
    // coverage.py data files need converting first, which arrives with Python support.
    if (formatOf(path) === 'coveragepy') return 'drop';
    const roots = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);
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
    const owner = ownerOf(path, this.deps.projects());
    this.deps.store.replace(owner ? owner.key : unownedKey(path, report.signature), report.files);
    return 'ok';
  }
}
