import * as vscode from 'vscode';
import type { Adapter, FsReader, Project } from '../adapters/types';
import { discover, MARKER_FILE, refreshFile, type DiscoveryState, type TestFileCache } from '../discovery';
import type { Settings } from '../settings';
import { isWithin } from '../watcher/attribution';
import type { FileEvent, FileEventSource } from './fileEvents';
import type { VSCodeFsReader } from './fsReader';

/** Quiet time after the last change that can add or remove a project before discovery runs again. */
const REDISCOVER_DEBOUNCE_MS = 750;
/** Files that may be test files (Node, .NET, Python), re-evaluated one by one with `refreshFile`. */
const CANDIDATE = /\.(?:cs|py|jsx?|tsx?|[cm][jt]s)$/i;
const CSHARP = /\.cs$/i;
const NODE_SOURCE = /\.(?:jsx?|tsx?|[cm][jt]s)$/i;
const PYTHON_TEST = /^(?:test_.*|.*_test)\.py$/;
/** More paths than this waiting for `refreshFile`: one new discovery instead. */
const MAX_PENDING = 200;
/** Node and Python adapters decide by name alone; this reader makes sure that asking them reads nothing. */
const NO_FS: FsReader = { readText: async () => undefined, exists: async () => false, find: async () => [] };
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
  /**
   * Every file event seen, for the trace log level (tests use it to know the watcher is live). The
   * message is built only when the callee asks for it.
   */
  trace?(msg: () => string): void;
  /** The workspace's file events (one watcher per folder, shared with the report watcher). */
  events: FileEventSource;
  /** A new state: after each discovery and after a refresh that changed something. */
  onState(state: DiscoveryState): void;
}

/**
 * Keeps the discovered projects up to date, in the background: a first discovery when `start` is
 * called (after activation), a new one (debounced) when a marker file, the workspace folders or a
 * discovery setting change, and a `refreshFile` for a test file created, changed or deleted inside a
 * project. Events are sorted out by name with no file access: only a path that a containing project
 * could take as a test file (any `.cs` file of a .NET test project, a name a Node or Python adapter
 * accepts), a Python test name anywhere, or an extension-less path created or deleted (a folder moved
 * in or out) is re-evaluated; a burst of more than MAX_PENDING such paths becomes one discovery. The
 * only timer is the debounce.
 */
export class ProjectDiscovery {
  private state: DiscoveryState | undefined;
  readonly ready: Promise<void>;
  private resolveReady!: () => void;
  private readonly subscriptions: vscode.Disposable[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private rerun = false;
  private refreshing = false;
  /** Paths to re-evaluate, with the event that brought each (its one stat is shared with the report watcher). */
  private readonly pending = new Map<string, FileEvent | undefined>();
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

  /** Starts listening and runs the first discovery. */
  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    this.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration(e => {
        if (DISCOVERY_SETTINGS.some(s => e.affectsConfiguration(s))) this.schedule();
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.schedule()),
      this.deps.events.onDidFileEvent(e => this.onEvent(e)),
    );
    void this.discoverNow();
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    for (const d of this.subscriptions) d.dispose();
    this.pending.clear();
    this.resolveReady();
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

  /** Excluded paths and `.git` never get here (see `WorkspaceFileEvents`). */
  private onEvent(e: FileEvent): void {
    if (this.disposed) return;
    this.deps.trace?.(() => `File event (${e.kind}): ${e.path}`);
    const { name, path: p } = e;
    if (MARKER_FILE.test(name)) {
      this.schedule();
      return;
    }
    // A discovery is due: it will see this change too.
    if (this.timer !== undefined) return;
    // A name without an extension may be a directory moved in or deleted; directories do not "change".
    if ((!name.includes('.') && e.kind !== 'change' && e.rel !== '') || PYTHON_TEST.test(name)) {
      this.enqueue(e);
      return;
    }
    if (!CANDIDATE.test(name)) return;
    const state = this.state;
    if (state === undefined) {
      this.enqueue(e); // Sorted out once the first discovery has finished.
      return;
    }
    for (const project of state.projects) {
      if (!project.supportsPartial || !isWithin(project.dir, p)) continue;
      if (project.ecosystem === 'dotnet') {
        // Content decides for .NET (test attributes): any C# file of a test project.
        if (CSHARP.test(name)) return this.enqueue(e);
      } else if (project.ecosystem === 'node' && NODE_SOURCE.test(name)) {
        const adapter = this.deps.adapters.find(a => a.id === project.adapter);
        void adapter?.isTestFile(project, p, NO_FS).then(isTest => { if (isTest) this.enqueue(e); }, () => undefined);
      }
    }
  }

  private enqueue(e: FileEvent): void {
    if (this.disposed || this.timer !== undefined) return;
    this.pending.set(e.path, e);
    if (this.pending.size > MAX_PENDING) {
      // A build or a checkout: one discovery is cheaper than this many refreshes. While the first
      // discovery is still running it sees these changes itself: no second one.
      this.pending.clear();
      if (this.state !== undefined) this.schedule();
      return;
    }
    void this.drainRefreshes();
  }

  /** Re-evaluates pending paths one at a time, between discoveries (a discovery covers them all). */
  private async drainRefreshes(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      while (!this.disposed && !this.running && this.state !== undefined && this.pending.size > 0) {
        const [p, event] = this.pending.entries().next().value as [string, FileEvent | undefined];
        this.pending.delete(p);
        const base = this.state;
        let result;
        try {
          const fs = this.deps.makeFs();
          // The event's stat answers for the path itself, so that it is stat'ed once for both consumers.
          const kindOf = event === undefined ? fs.kindOf : (q: string) => (q === p ? event.kindOnDisk() : fs.kindOf(q));
          result = await refreshFile(base, p, { ...fs, kindOf });
        } catch (e) {
          this.deps.log(`Could not re-evaluate ${p}: ${e instanceof Error ? e.message : String(e)}`);
          continue;
        }
        if (this.disposed) return;
        if (this.state !== base) {
          this.pending.set(p, undefined); // A discovery replaced the state meanwhile: evaluate against the new one.
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
