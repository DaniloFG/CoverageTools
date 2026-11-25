// A fake of the `vscode` module, just big enough for the extension's activation and the paths the
// lightness tests measure. It records every call that could read files (`workspace.fs.*`,
// `workspace.findFiles`, `createFileSystemWatcher`), lets a test fire file events and configuration
// changes, and keeps the coverage runs the way VS Code's test history does (the last `retainRuns`).
// It is loaded in place of `vscode` by `installFakeVscode`, both in the test process and, bundled
// with esbuild, in the fresh processes the activation-time test starts.
import Module from 'node:module';
import nodePath from 'node:path';
import { globToRegExp } from '../../src/glob';

export interface FileCall { api: 'fs.stat' | 'fs.readFile' | 'fs.readDirectory' | 'findFiles' | 'createFileSystemWatcher'; path: string }

type Listener<T> = (e: T) => unknown;

class Emitter<T> {
  private listeners: Array<Listener<T>> = [];
  readonly event = (listener: Listener<T>): Disposable => {
    this.listeners.push(listener);
    return new Disposable(() => { this.listeners = this.listeners.filter(l => l !== listener); });
  };
  fire(e: T): void {
    for (const l of this.listeners) l(e);
  }
  get size(): number {
    return this.listeners.length;
  }
}

export class Disposable {
  constructor(private readonly fn: () => void) {}
  static from(...items: Array<{ dispose(): unknown }>): Disposable {
    return new Disposable(() => { for (const i of items) i.dispose(); });
  }
  dispose(): void {
    this.fn();
  }
}

/** Shaped like VS Code's `Uri` (the same fields, `fsPath` computed once), so that memory figures compare. */
export class Uri {
  private _fsPath: string | undefined;
  private _formatted: string | undefined;
  private constructor(readonly scheme: string, readonly authority: string, readonly path: string, readonly query: string, readonly fragment: string) {}
  static file(p: string): Uri {
    return new Uri('file', '', nodePath.resolve(p).split(nodePath.sep).join('/'), '', '');
  }
  get fsPath(): string {
    return (this._fsPath ??= this.path.split('/').join(nodePath.sep));
  }
  toString(): string {
    return (this._formatted ??= `${this.scheme}://${this.path}`);
  }
}

export interface WorkspaceFolder { uri: Uri; name: string; index: number }

export class RelativePattern {
  readonly baseUri: Uri;
  constructor(base: WorkspaceFolder | Uri | string, readonly pattern: string) {
    this.baseUri = typeof base === 'string' ? Uri.file(base) : base instanceof Uri ? base : base.uri;
  }
}

export class Position {
  constructor(readonly line: number, readonly character: number) {}
}
export class Range {
  constructor(readonly start: Position, readonly end: Position) {}
}
export class TestCoverageCount {
  constructor(public covered: number, public total: number) {}
}
/** As VS Code's: the fields its constructor sets. */
export class FileCoverage {
  constructor(
    readonly uri: Uri,
    public statementCoverage: TestCoverageCount,
    public branchCoverage?: TestCoverageCount,
    public declarationCoverage?: TestCoverageCount,
    public includesTests: unknown[] = [],
  ) {}
}
export class StatementCoverage {
  constructor(public executed: number | boolean, public location: Position | Range, public branches: BranchCoverage[] = []) {}
}
export class BranchCoverage {
  constructor(public executed: number | boolean, public location?: Position | Range, public label?: string) {}
}
export class DeclarationCoverage {
  constructor(public name: string, public executed: number | boolean, public location: Position | Range) {}
}
export class TestRunRequest {
  constructor(readonly include?: unknown, readonly exclude?: unknown, readonly profile?: unknown) {}
}

export interface FakeRun { coverage: FileCoverage[]; ended: boolean }

interface Watcher {
  base: string;
  creates: Array<Listener<Uri>>;
  changes: Array<Listener<Uri>>;
  deletes: Array<Listener<Uri>>;
  disposed: boolean;
}

export interface FakeOptions {
  /** Workspace folder paths; none means no folder open. */
  folders?: readonly string[];
  /** In-memory files (absolute path → content) served by `workspace.fs` and `findFiles`. */
  files?: ReadonlyMap<string, string>;
  /** `section.key` → value, for `getConfiguration`; unset keys read as undefined (the extension's defaults). */
  settings?: ReadonlyMap<string, unknown>;
  /** How many coverage runs the fake history keeps (VS Code's history: the last 64). */
  retainRuns?: number;
}

export type FakeVscode = ReturnType<typeof createFakeVscode>;

/** A fresh fake; `module` is what `require('vscode')` returns. */
export function createFakeVscode(options: FakeOptions = {}) {
  const files = new Map(options.files ?? []);
  const settings = new Map(options.settings ?? []);
  const retainRuns = options.retainRuns ?? 64;
  const fileCalls: FileCall[] = [];
  const output: string[] = [];
  const commands = new Map<string, (...args: unknown[]) => unknown>();
  const executed: Array<{ id: string; args: unknown[] }> = [];
  const watchers: Watcher[] = [];
  const runs: FakeRun[] = [];
  let runsCreated = 0;
  const configuration = new Emitter<{ affectsConfiguration(section: string): boolean }>();
  const workspaceFoldersChanged = new Emitter<unknown>();
  const folders = (options.folders ?? []).map((p, index): WorkspaceFolder => ({ uri: Uri.file(p), name: nodePath.basename(p), index }));
  const record = (api: FileCall['api'], path: string): void => { fileCalls.push({ api, path }); };

  const enoent = (p: string): Error => Object.assign(new Error(`ENOENT: ${p}`), { code: 'FileNotFound' });
  const isDir = (p: string): boolean => {
    const prefix = p.endsWith(nodePath.sep) ? p : p + nodePath.sep;
    for (const f of files.keys()) if (f.startsWith(prefix)) return true;
    return false;
  };

  const workspace = {
    get workspaceFolders(): WorkspaceFolder[] | undefined {
      return folders.length > 0 ? folders : undefined;
    },
    isTrusted: true,
    fs: {
      async stat(uri: Uri) {
        record('fs.stat', uri.fsPath);
        if (files.has(uri.fsPath)) return { type: 1, ctime: 0, mtime: 1, size: files.get(uri.fsPath)!.length };
        if (isDir(uri.fsPath)) return { type: 2, ctime: 0, mtime: 1, size: 0 };
        throw enoent(uri.fsPath);
      },
      async readFile(uri: Uri) {
        record('fs.readFile', uri.fsPath);
        const text = files.get(uri.fsPath);
        if (text === undefined) throw enoent(uri.fsPath);
        return new TextEncoder().encode(text);
      },
      async readDirectory(uri: Uri) {
        record('fs.readDirectory', uri.fsPath);
        return [];
      },
    },
    async findFiles(include: RelativePattern | string, exclude?: string | null) {
      const pattern = typeof include === 'string' ? new RelativePattern(folders[0]?.uri ?? Uri.file('/'), include) : include;
      const base = pattern.baseUri.fsPath;
      record('findFiles', base);
      const inc = globToRegExp(pattern.pattern);
      const exc = exclude ? globToRegExp(exclude) : undefined;
      const out: Uri[] = [];
      for (const f of files.keys()) {
        const rel = nodePath.relative(base, f).split(nodePath.sep).join('/');
        if (rel.startsWith('..') || nodePath.isAbsolute(rel)) continue;
        if (inc.test(rel) && !exc?.test(rel)) out.push(Uri.file(f));
      }
      return out;
    },
    getConfiguration(section: string) {
      return {
        get: (key: string) => settings.get(`${section}.${key}`),
        has: (key: string) => settings.has(`${section}.${key}`),
      };
    },
    onDidChangeConfiguration: configuration.event,
    onDidChangeWorkspaceFolders: workspaceFoldersChanged.event,
    onDidGrantWorkspaceTrust: new Emitter<void>().event,
    asRelativePath(p: string | Uri) {
      const fsPath = typeof p === 'string' ? p : p.fsPath;
      const folder = folders.find(f => fsPath.startsWith(f.uri.fsPath + nodePath.sep));
      return folder ? nodePath.relative(folder.uri.fsPath, fsPath) : fsPath;
    },
    createFileSystemWatcher(pattern: RelativePattern, ignoreCreate = false, ignoreChange = false, ignoreDelete = false) {
      record('createFileSystemWatcher', pattern.baseUri.fsPath);
      const w: Watcher = { base: pattern.baseUri.fsPath, creates: [], changes: [], deletes: [], disposed: false };
      watchers.push(w);
      const on = (list: Array<Listener<Uri>>, ignored: boolean) => (listener: Listener<Uri>): Disposable => {
        if (!ignored) list.push(listener);
        return new Disposable(() => { list.splice(list.indexOf(listener) >>> 0, 1); });
      };
      return {
        onDidCreate: on(w.creates, ignoreCreate),
        onDidChange: on(w.changes, ignoreChange),
        onDidDelete: on(w.deletes, ignoreDelete),
        dispose() { w.disposed = true; },
      };
    },
  };

  const channel = (name: string) => ({
    name,
    // Info, the default: trace messages are not wanted.
    logLevel: 3,
    info: (msg: string) => { output.push(msg); },
    warn: (msg: string) => { output.push(msg); },
    error: (msg: string) => { output.push(String(msg)); },
    debug: () => {},
    // Off, as at the default log level: the extension only calls it.
    trace: () => {},
    append: (msg: string) => { output.push(msg); },
    appendLine: (msg: string) => { output.push(msg); },
    show: () => {},
    hide: () => {},
    clear: () => {},
    dispose: () => {},
    onDidChangeLogLevel: new Emitter<number>().event,
  });

  const module = {
    Uri, RelativePattern, Position, Range, Disposable, TestCoverageCount, FileCoverage, StatementCoverage,
    BranchCoverage, DeclarationCoverage, TestRunRequest,
    EventEmitter: Emitter,
    FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
    LogLevel: { Off: 0, Trace: 1, Debug: 2, Info: 3, Warning: 4, Error: 5 },
    TestRunProfileKind: { Run: 1, Debug: 2, Coverage: 3 },
    StatusBarAlignment: { Left: 1, Right: 2 },
    ProgressLocation: { SourceControl: 1, Window: 10, Notification: 15 },
    workspace,
    window: {
      activeTextEditor: undefined,
      createOutputChannel: channel,
      createStatusBarItem: () => ({ text: '', tooltip: '', command: '', name: '', show() {}, hide() {}, dispose() {} }),
      showInformationMessage: async () => undefined,
      showWarningMessage: async () => undefined,
      showErrorMessage: async () => undefined,
      withProgress: async <T>(_o: unknown, task: (p: { report(v: unknown): void }, t: unknown) => Promise<T>) =>
        task({ report() {} }, { isCancellationRequested: false, onCancellationRequested: () => new Disposable(() => {}) }),
    },
    commands: {
      registerCommand(id: string, fn: (...args: unknown[]) => unknown) {
        commands.set(id, fn);
        return new Disposable(() => commands.delete(id));
      },
      async executeCommand(id: string, ...args: unknown[]) {
        executed.push({ id, args });
        return commands.get(id)?.(...args);
      },
    },
    extensions: { getExtension: () => undefined },
    tests: {
      createTestController(id: string, label: string) {
        return {
          id, label,
          createRunProfile(profileLabel: string, kind: number, handler: unknown, isDefault?: boolean) {
            return { label: profileLabel, kind, handler, isDefault, loadDetailedCoverage: undefined as unknown, dispose() {} };
          },
          createTestRun() {
            const run: FakeRun = { coverage: [], ended: false };
            runsCreated++;
            runs.push(run);
            // VS Code disposes a run (and drops its coverage) once it leaves the results history.
            if (runs.length > retainRuns) runs.shift();
            return {
              addCoverage(c: FileCoverage) { run.coverage.push(c); },
              appendOutput() {},
              end() { run.ended = true; },
            };
          },
          dispose() {},
        };
      },
    },
  };

  return {
    module,
    fileCalls,
    output,
    commands,
    executed,
    runs,
    get runsCreated() { return runsCreated; },
    /** Active (not disposed) file system watchers. */
    get watcherCount() { return watchers.filter(w => !w.disposed).length; },
    /**
     * Delivers file events to the watchers whose folder holds each path, as VS Code does (they all
     * watch `**` + `/*`). Synchronous, so that a test can time the listeners.
     */
    fire(kind: 'create' | 'change' | 'delete', uris: readonly Uri[]): void {
      const live = watchers.filter(w => !w.disposed).map(w => ({ prefix: w.base + nodePath.sep, list: kind === 'create' ? w.creates : kind === 'change' ? w.changes : w.deletes }));
      for (const uri of uris) {
        const p = uri.fsPath;
        for (const w of live) if (p.startsWith(w.prefix)) for (const l of w.list) l(uri);
      }
    },
    /** Fires `onDidChangeConfiguration` for these `section.key` names, after storing their new values. */
    changeSettings(values: ReadonlyMap<string, unknown>): void {
      for (const [k, v] of values) settings.set(k, v);
      const keys = [...values.keys()];
      configuration.fire({ affectsConfiguration: s => keys.some(k => k === s || k.startsWith(`${s}.`)) });
    },
    /** Calls a registered command's handler. */
    run(id: string, ...args: unknown[]): unknown {
      const fn = commands.get(id);
      if (fn === undefined) throw new Error(`Command ${id} is not registered`);
      return fn(...args);
    },
  };
}

type LoadFn = (request: string, parent: unknown, isMain: boolean) => unknown;
const moduleInternals = Module as unknown as { _load: LoadFn };

/** Makes `require('vscode')` return `fake.module` until the returned function is called. */
export function installFakeVscode(fake: { module: unknown }): () => void {
  const original = moduleInternals._load;
  moduleInternals._load = function (request, parent, isMain) {
    if (request === 'vscode') return fake.module;
    return original.call(this, request, parent, isMain);
  };
  return () => { moduleInternals._load = original; };
}

/** A fake `ExtensionContext` for `activate`. */
export function fakeContext(extensionPath: string): { subscriptions: Array<{ dispose(): unknown }>; extensionPath: string; dispose(): void } {
  const subscriptions: Array<{ dispose(): unknown }> = [];
  return {
    subscriptions,
    extensionPath,
    dispose() {
      for (const s of subscriptions.splice(0)) s.dispose();
    },
  };
}
