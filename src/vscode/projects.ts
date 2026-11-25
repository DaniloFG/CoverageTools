import nodePath from 'node:path';
import * as vscode from 'vscode';
import type { Adapter, Project } from '../adapters/types';
import { discover, MARKER_FILE, refreshFile, type DiscoveryState, type TestFileCache } from '../discovery';
import { globToRegExp } from '../glob';
import type { Settings } from '../settings';
import { isWithin } from '../watcher/attribution';
import type { VSCodeFsReader } from './fsReader';

/** Quiet time after the last change that can add or remove a project before discovery runs again. */
const REDISCOVER_DEBOUNCE_MS = 750;
/** Files that may be test files (Node, .NET, Python), re-evaluated one by one with `refreshFile`. */
const CANDIDATE = /\.(?:cs|py|jsx?|tsx?|[cm][jt]s)$/i;
const PYTHON_TEST = /^(?:test_.*|.*_test)\.py$/;
const DISCOVERY_SETTINGS = ['coverageTools.exclude', 'coverageTools.nestedProjects', 'coverageTools.commands'];

export interface ProjectDiscoveryDeps {
  /**
   * A new reader for each discovery pass and each refresh: adapters cache imported files per reader
   * object, so a reader kept for the whole session would serve files the user has edited since.
   */
  makeFs(): VSCodeFsReader;
  adapters: readonly Adapter[];
  settingsOf(scope: vscode.Uri): Settings;
  log(msg: string): void;
  /** Logged only at the trace log level: every file event seen (tests use it to know the watcher is live). */
  trace?(msg: string): void;
  /** A new state: after each discovery and after a refresh that changed something. */
  onState(state: DiscoveryState): void;
}

/**
 * Keeps the discovered projects up to date, in the background: a first discovery when `start` is
 * called (after activation), a new one (debounced) when a marker file, the workspace folders or a
 * discovery setting change, and a `refreshFile` for a test file created, changed or deleted inside a
 * project. One file system watcher per workspace folder; the only timer is the debounce.
 */
export class ProjectDiscovery {
  private state: DiscoveryState | undefined;
  readonly ready: Promise<void>;
  private resolveReady!: () => void;
  private watchers: vscode.Disposable[] = [];
  private readonly subscriptions: vscode.Disposable[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private rerun = false;
  private refreshing = false;
  private readonly pending = new Set<string>();
  /** Per workspace folder, its compiled excludes, so that each file event is cheap. */
  private excludes = new Map<string, RegExp[]>();
  private readonly cache: TestFileCache = new Map();
  private started = false;
  private disposed = false;

  constructor(private readonly deps: ProjectDiscoveryDeps) {
    this.ready = new Promise(resolve => { this.resolveReady = resolve; });
  }

  get current(): DiscoveryState | undefined {
    return this.state;
  }

  projects(): readonly Project[] {
    return this.state?.projects ?? [];
  }

  /** Starts watching and runs the first discovery. */
  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    this.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration(e => {
        if (DISCOVERY_SETTINGS.some(s => e.affectsConfiguration(s))) this.schedule();
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this.rebuildWatchers();
        this.schedule();
      }),
    );
    this.rebuildWatchers();
    void this.discoverNow();
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    for (const d of [...this.subscriptions, ...this.watchers]) d.dispose();
    this.watchers = [];
    this.pending.clear();
    this.resolveReady();
  }

  private rebuildWatchers(): void {
    for (const w of this.watchers) w.dispose();
    this.watchers = [];
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      if (folder.uri.scheme !== 'file') continue;
      // Every path, directories included (a project folder moved in or deleted); events are sorted out cheaply below.
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, '**/*'));
      this.watchers.push(
        watcher,
        watcher.onDidCreate(uri => this.onEvent(uri, 'create')),
        watcher.onDidChange(uri => this.onEvent(uri, 'change')),
        watcher.onDidDelete(uri => this.onEvent(uri, 'delete')),
      );
    }
  }

  private schedule(): void {
    if (this.disposed) return;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.discoverNow();
    }, REDISCOVER_DEBOUNCE_MS);
  }

  private async discoverNow(): Promise<void> {
    if (this.running) {
      this.rerun = true;
      return;
    }
    this.running = true;
    try {
      do {
        this.rerun = false;
        const folders = (vscode.workspace.workspaceFolders ?? []).filter(f => f.uri.scheme === 'file').map(f => f.uri.fsPath);
        const settings = new Map(folders.map(f => [f, this.deps.settingsOf(vscode.Uri.file(f))]));
        this.excludes = new Map([...settings].map(([f, s]) => [f, s.exclude.map(globToRegExp)]));
        const settingsOf = (f: string): Settings => settings.get(f) ?? this.deps.settingsOf(vscode.Uri.file(f));
        let state: DiscoveryState | undefined;
        try {
          // A fresh reader per pass (see `makeFs`).
          const fs = this.deps.makeFs();
          state = await discover(folders, fs, settingsOf, this.deps.adapters, { statMtime: p => fs.statMtime(p), testFileCache: this.cache });
        } catch (e) {
          this.deps.log(`Project discovery failed: ${e instanceof Error ? e.message : String(e)}`);
        }
        if (this.disposed) return;
        if (state !== undefined) {
          this.state = state;
          this.deps.onState(state);
          this.deps.log(`Discovery finished: ${state.projects.length} project(s).`);
        }
      } while (this.rerun && !this.disposed);
    } finally {
      this.running = false;
      this.resolveReady();
    }
    void this.drainRefreshes();
  }

  private onEvent(uri: vscode.Uri, kind: 'create' | 'change' | 'delete'): void {
    if (this.disposed || uri.scheme !== 'file') return;
    const p = uri.fsPath;
    this.deps.trace?.(`File event (${kind}): ${p}`);
    const folder = this.folderOf(p);
    if (folder === undefined) return;
    const rel = nodePath.relative(folder, p).split(nodePath.sep).join('/');
    if (rel.split('/').includes('.git') || (this.excludes.get(folder) ?? []).some(re => re.test(rel))) return;
    const name = nodePath.basename(p);
    if (MARKER_FILE.test(name)) {
      this.schedule();
      return;
    }
    // A name without an extension may be a directory moved in or deleted; directories do not "change".
    const dirLike = !name.includes('.') && kind !== 'change';
    if (!CANDIDATE.test(name) && !dirLike) return;
    const state = this.state;
    if (state !== undefined && !PYTHON_TEST.test(name) && !dirLike && !state.projects.some(x => isWithin(x.dir, p))) return;
    this.pending.add(p);
    void this.drainRefreshes();
  }

  private folderOf(p: string): string | undefined {
    let best: string | undefined;
    for (const f of vscode.workspace.workspaceFolders ?? []) {
      const dir = f.uri.fsPath;
      if (f.uri.scheme === 'file' && isWithin(dir, p) && (best === undefined || dir.length > best.length)) best = dir;
    }
    return best;
  }

  /** Re-evaluates pending paths one at a time, between discoveries (a discovery covers them all). */
  private async drainRefreshes(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      while (!this.disposed && !this.running && this.state !== undefined && this.pending.size > 0) {
        const p: string = this.pending.values().next().value as string;
        this.pending.delete(p);
        const base = this.state;
        let result;
        try {
          result = await refreshFile(base, p, this.deps.makeFs());
        } catch (e) {
          this.deps.log(`Could not re-evaluate ${p}: ${e instanceof Error ? e.message : String(e)}`);
          continue;
        }
        if (this.disposed) return;
        if (this.state !== base) {
          this.pending.add(p); // A discovery replaced the state meanwhile: evaluate against the new one.
          continue;
        }
        if (result.rediscover) this.schedule();
        else if (result.state !== base) {
          this.state = result.state;
          this.deps.onState(result.state);
        }
      }
    } finally {
      this.refreshing = false;
    }
  }
}
