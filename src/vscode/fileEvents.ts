import nodePath from 'node:path';
import * as vscode from 'vscode';
import { globToRegExp } from '../glob';
import type { Settings } from '../settings';

export type FileEventKind = 'create' | 'change' | 'delete';

/** A file system event inside a workspace folder, with what every consumer needs computed once. */
export interface FileEvent {
  readonly kind: FileEventKind;
  readonly uri: vscode.Uri;
  /** `uri.fsPath`. */
  readonly path: string;
  /** The innermost workspace folder that holds the path (its `fsPath`). */
  readonly folder: string;
  /** The path relative to `folder`, with forward slashes; '' for the folder itself. */
  readonly rel: string;
  /** The last segment of the path. */
  readonly name: string;
  /**
   * What the path is now: one `stat` through VS Code, made on the first call and shared by every
   * consumer of the event; undefined when it is gone or cannot be read.
   */
  kindOnDisk(): Promise<PathKind>;
}

export type PathKind = 'file' | 'directory' | undefined;

/** The kind of a path through `workspace.fs.stat`; undefined when it is gone or cannot be read. */
export async function statKind(uri: vscode.Uri): Promise<PathKind> {
  try {
    return ((await vscode.workspace.fs.stat(uri)).type & vscode.FileType.Directory) !== 0 ? 'directory' : 'file';
  } catch {
    return undefined;
  }
}

class Event implements FileEvent {
  private kindPromise: Promise<PathKind> | undefined;
  constructor(
    readonly kind: FileEventKind, readonly uri: vscode.Uri, readonly path: string, readonly folder: string,
    readonly rel: string, readonly name: string,
  ) {}
  kindOnDisk(): Promise<PathKind> {
    return (this.kindPromise ??= statKind(this.uri));
  }
}

/** What consumers subscribe to (tests pass their own). */
export interface FileEventSource {
  onDidFileEvent(listener: (e: FileEvent) => void): vscode.Disposable;
}

export interface WorkspaceFileEventsDeps {
  /** The settings of a workspace folder; its `exclude` globs drop events before any consumer sees them. */
  settingsOf(scope: vscode.Uri): Settings;
  /** The workspace folders; `vscode.workspace.workspaceFolders` unless a test injects them. */
  folders?(): readonly vscode.WorkspaceFolder[];
}

interface Folder { path: string; prefix: string; compare: string; exclude: RegExp | undefined }

const CASE_INSENSITIVE = process.platform === 'win32';
const toPosix = nodePath.sep === '/' ? (s: string): string => s : (s: string): string => s.split(nodePath.sep).join('/');

/** Whether a forward-slash relative path has a `.git` segment. */
export function inGitDir(rel: string): boolean {
  return rel === '.git' || rel.startsWith('.git/') || rel.includes('/.git/') || rel.endsWith('/.git');
}

/** One expression for a list of globs (each already anchored); undefined for none. */
export function anyOf(globs: readonly string[]): RegExp | undefined {
  return globs.length === 0 ? undefined : new RegExp(globs.map(g => globToRegExp(g).source).join('|'));
}

/**
 * The one file system watcher per workspace folder (every path, directories included) that both
 * project discovery and the report watcher listen to. Per event it finds the folder, the relative
 * path and the name once, and drops, before any consumer sees them, events outside every folder,
 * under a `.git` directory or matching the folder's `coverageTools.exclude`. No watcher exists
 * until `start` (called after activation); no timer ever.
 */
export class WorkspaceFileEvents implements FileEventSource {
  private readonly listeners = new Set<(e: FileEvent) => void>();
  private watchers: vscode.Disposable[] = [];
  private subscriptions: vscode.Disposable[] = [];
  /** Innermost first, so that the first match is the innermost folder. */
  private folders: Folder[] = [];
  /** The last event of a path inside nested folders, to drop the copy the other watcher delivers. */
  private lastNested = '';
  private started = false;
  private disposed = false;

  constructor(private readonly deps: WorkspaceFileEventsDeps) {}

  onDidFileEvent(listener: (e: FileEvent) => void): vscode.Disposable {
    const wrapped = (e: FileEvent): void => listener(e);
    this.listeners.add(wrapped);
    return { dispose: () => { this.listeners.delete(wrapped); } };
  }

  /** Creates the watchers. */
  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    this.subscriptions = [
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('coverageTools.exclude')) this.compileFolders();
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.rebuild()),
    ];
    this.rebuild();
  }

  dispose(): void {
    this.disposed = true;
    for (const d of [...this.subscriptions, ...this.watchers]) d.dispose();
    this.subscriptions = [];
    this.watchers = [];
    this.listeners.clear();
  }

  private workspaceFolders(): readonly vscode.WorkspaceFolder[] {
    return (this.deps.folders?.() ?? vscode.workspace.workspaceFolders ?? []).filter(f => f.uri.scheme === 'file');
  }

  private rebuild(): void {
    for (const w of this.watchers) w.dispose();
    this.watchers = [];
    this.compileFolders();
    for (const folder of this.workspaceFolders()) {
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, '**/*'));
      this.watchers.push(
        watcher,
        watcher.onDidCreate(uri => this.onEvent(uri, 'create')),
        watcher.onDidChange(uri => this.onEvent(uri, 'change')),
        watcher.onDidDelete(uri => this.onEvent(uri, 'delete')),
      );
    }
  }

  private compileFolders(): void {
    this.folders = this.workspaceFolders()
      .map((f): Folder => {
        const path = f.uri.fsPath;
        const prefix = path.endsWith(nodePath.sep) ? path : path + nodePath.sep;
        return { path, prefix, compare: CASE_INSENSITIVE ? prefix.toLowerCase() : prefix, exclude: anyOf(this.deps.settingsOf(f.uri).exclude) };
      })
      .sort((a, b) => b.prefix.length - a.prefix.length);
  }

  private onEvent(uri: vscode.Uri, kind: FileEventKind): void {
    if (this.disposed || uri.scheme !== 'file' || this.listeners.size === 0) return;
    const path = uri.fsPath;
    const compare = CASE_INSENSITIVE ? path.toLowerCase() : path;
    let folder: Folder | undefined;
    for (const f of this.folders) {
      if (compare.startsWith(f.compare) || compare + nodePath.sep === f.compare) {
        folder = f;
        break;
      }
    }
    if (folder === undefined) return;
    const rel = path.length < folder.prefix.length ? '' : toPosix(path.slice(folder.prefix.length));
    if (inGitDir(rel) || (folder.exclude !== undefined && folder.exclude.test(rel))) return;
    // Nested workspace folders have overlapping watchers: the same event arrives once per watcher.
    if (this.folders.length > 1 && this.folders.some(f => f !== folder && compare.startsWith(f.compare))) {
      const id = `${kind}\0${path}`;
      if (id === this.lastNested) return;
      this.lastNested = id;
    }
    const event = new Event(kind, uri, path, folder.path, rel, rel.slice(rel.lastIndexOf('/') + 1));
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // One failing consumer must not keep the others from the event.
      }
    }
  }
}
