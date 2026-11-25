import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { DEFAULT_SETTINGS, type Settings } from '../../../src/settings';

interface FakeUri { scheme: string; fsPath: string }
interface FakeWatcher { base: string; pattern: string; create?: (u: FakeUri) => void; change?: (u: FakeUri) => void; del?: (u: FakeUri) => void; disposed: boolean }

const h = vi.hoisted(() => ({
  watchers: [] as FakeWatcher[],
  config: [] as Array<(e: { affectsConfiguration(s: string): boolean }) => void>,
}));

vi.mock('vscode', () => {
  const disposable = { dispose() {} };
  return {
    Uri: { file: (p: string) => ({ scheme: 'file', fsPath: p }) },
    RelativePattern: class {
      constructor(public base: { uri: FakeUri }, public pattern: string) {}
    },
    workspace: {
      workspaceFolders: undefined,
      onDidChangeConfiguration: (fn: (e: { affectsConfiguration(s: string): boolean }) => void) => { h.config.push(fn); return disposable; },
      onDidChangeWorkspaceFolders: () => disposable,
      createFileSystemWatcher: (pattern: { base: { uri: FakeUri }; pattern: string }) => {
        const w: FakeWatcher = { base: pattern.base.uri.fsPath, pattern: pattern.pattern, disposed: false };
        h.watchers.push(w);
        return {
          onDidCreate: (fn: (u: FakeUri) => void) => { w.create = fn; return disposable; },
          onDidChange: (fn: (u: FakeUri) => void) => { w.change = fn; return disposable; },
          onDidDelete: (fn: (u: FakeUri) => void) => { w.del = fn; return disposable; },
          dispose() { w.disposed = true; },
        };
      },
    },
  };
});

const { WorkspaceFileEvents, inGitDir } = await import('../../../src/vscode/fileEvents');
import type { FileEvent } from '../../../src/vscode/fileEvents';

const folder = (p: string, index: number) => ({ uri: { scheme: 'file', fsPath: p }, name: p.split('/').pop(), index });

let settings: Settings;
let events: InstanceType<typeof WorkspaceFileEvents>;
let seen: FileEvent[];

beforeEach(() => {
  h.watchers.length = 0;
  h.config.length = 0;
  settings = DEFAULT_SETTINGS;
  seen = [];
  events = new WorkspaceFileEvents({ settingsOf: () => settings, folders: () => [folder('/w', 0), folder('/w/inner', 1)] as never });
  events.onDidFileEvent(e => seen.push(e));
});

afterEach(() => events.dispose());

const fire = (kind: 'create' | 'change' | 'delete', p: string): void => {
  for (const w of h.watchers.filter(x => !x.disposed && p.startsWith(`${x.base}/`))) (kind === 'create' ? w.create : kind === 'change' ? w.change : w.del)?.({ scheme: 'file', fsPath: p });
};

test('no watcher exists before start; then one per workspace folder, for every path', () => {
  expect(h.watchers).toEqual([]);
  events.start();
  expect(h.watchers.map(w => [w.base, w.pattern])).toEqual([['/w', '**/*'], ['/w/inner', '**/*']]);
});

test('each event carries the innermost folder, the relative path and the name, computed once for every listener', () => {
  events.start();
  const second: FileEvent[] = [];
  events.onDidFileEvent(e => second.push(e));
  fire('change', '/w/src/a.ts');
  // The outer folder's watcher sees inner paths too, as VS Code's does: one event each.
  fire('create', '/w/inner/lib/b.py');
  expect(seen.map(e => [e.kind, e.folder, e.rel, e.name])).toEqual([
    ['change', '/w', 'src/a.ts', 'a.ts'],
    ['create', '/w/inner', 'lib/b.py', 'b.py'],
    ['create', '/w/inner', 'lib/b.py', 'b.py'],
  ]);
  expect(second[0]).toBe(seen[0]);
});

test('paths under .git and excluded paths reach no listener', () => {
  events.start();
  for (const p of ['/w/.git/index', '/w/.git/refs/heads/x', '/w/sub/.git/FETCH_HEAD', '/w/.git', '/w/node_modules/p/i.js', '/w/node_modules', '/w/bin/Debug/x.dll', '/w/a/obj/y.json']) fire('create', p);
  expect(seen).toEqual([]);
  fire('create', '/w/.github/workflows/ci.yml');
  expect(seen.map(e => e.rel)).toEqual(['.github/workflows/ci.yml']);
});

test('the excludes follow the setting', () => {
  events.start();
  settings = { ...DEFAULT_SETTINGS, exclude: ['**/gen/**'] };
  for (const fn of h.config) fn({ affectsConfiguration: s => s === 'coverageTools.exclude' });
  fire('change', '/w/node_modules/p/i.js');
  fire('change', '/w/gen/x.ts');
  expect(seen.map(e => e.rel)).toEqual(['node_modules/p/i.js']);
});

test('inGitDir matches .git segments only', () => {
  expect(['.git', '.git/x', 'a/.git', 'a/.git/b'].map(inGitDir)).toEqual([true, true, true, true]);
  expect(['.github/x', 'a.git', 'x/.gitignore', 'git/x'].map(inGitDir)).toEqual([false, false, false, false]);
});
