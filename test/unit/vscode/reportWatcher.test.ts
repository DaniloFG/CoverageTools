import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { Project } from '../../../src/adapters/types';
import { FileBuilder } from '../../../src/model';
import { NotCoverageReportError, ReportParseError, type ParsedReport } from '../../../src/parsers/types';
import { DEFAULT_SETTINGS } from '../../../src/settings';
import { CoverageStore } from '../../../src/store';

interface FakeUri { scheme: string; fsPath: string }
interface FakeWatcher { pattern: { base: { uri: FakeUri }; pattern: string }; create?: (u: FakeUri) => void; change?: (u: FakeUri) => void }

const h = vi.hoisted(() => ({
  watchers: [] as FakeWatcher[],
  /** Directory → the files `findFiles` returns under it. */
  dirs: new Map<string, string[]>(),
  /** File → its modification time. */
  mtimes: new Map<string, number>(),
  finds: [] as Array<{ base: string; pattern: string; maxResults: number | undefined }>,
  stats: [] as string[],
}));

vi.mock('vscode', () => {
  const disposable = { dispose() {} };
  return {
    Uri: { file: (p: string) => ({ scheme: 'file', fsPath: p }) },
    FileType: { File: 1, Directory: 2 },
    RelativePattern: class {
      constructor(public base: unknown, public pattern: string) {}
    },
    workspace: {
      workspaceFolders: undefined,
      fs: {
        stat: async (u: FakeUri) => {
          h.stats.push(u.fsPath);
          if (h.dirs.has(u.fsPath)) return { type: 2, mtime: 0 };
          const mtime = h.mtimes.get(u.fsPath);
          if (mtime !== undefined) return { type: 1, mtime };
          throw new Error('ENOENT');
        },
      },
      findFiles: async (pattern: { base: FakeUri; pattern: string }, _exclude: unknown, maxResults?: number) => {
        h.finds.push({ base: pattern.base.fsPath, pattern: pattern.pattern, maxResults });
        return (h.dirs.get(pattern.base.fsPath) ?? []).map(p => ({ scheme: 'file', fsPath: p }));
      },
      onDidChangeConfiguration: () => disposable,
      onDidChangeWorkspaceFolders: () => disposable,
      createFileSystemWatcher: (pattern: FakeWatcher['pattern']) => {
        const w: FakeWatcher = { pattern };
        h.watchers.push(w);
        return {
          onDidCreate: (fn: (u: FakeUri) => void) => { w.create = fn; return disposable; },
          onDidChange: (fn: (u: FakeUri) => void) => { w.change = fn; return disposable; },
          onDidDelete: () => disposable,
          dispose() {},
        };
      },
    },
  };
});

const { ReportWatcher } = await import('../../../src/vscode/reportWatcher');
const { WorkspaceFileEvents } = await import('../../../src/vscode/fileEvents');

const folder = (p: string, index: number) => ({ uri: { scheme: 'file', fsPath: p }, name: p.split('/').pop(), index });
const FOLDERS = [folder('/w/one', 0), folder('/w/two', 1)];

function report(path: string): ParsedReport {
  const b = new FileBuilder(path);
  b.addLine(1, 1);
  return { files: [b.build()], signature: '', dropped: 0 };
}

let store: CoverageStore;
let logs: string[];
let parse: ReturnType<typeof vi.fn<(reportPath: string, roots: readonly string[]) => Promise<ParsedReport>>>;
let projects: Project[];
let suppressed: Set<string>;
let watcher: InstanceType<typeof ReportWatcher>;
let events: InstanceType<typeof WorkspaceFileEvents>;

beforeEach(() => {
  vi.useFakeTimers();
  h.watchers.length = 0;
  h.dirs.clear();
  h.mtimes.clear();
  h.finds.length = 0;
  h.stats.length = 0;
  events = new WorkspaceFileEvents({ settingsOf: () => DEFAULT_SETTINGS, folders: () => FOLDERS as never });
  store = new CoverageStore();
  logs = [];
  projects = [];
  suppressed = new Set();
  parse = vi.fn(async () => report('/w/one/a.js'));
  watcher = new ReportWatcher({
    store,
    parser: { parse },
    settingsOf: () => DEFAULT_SETTINGS,
    projects: () => projects,
    isSuppressed: key => suppressed.has(key),
    isTrusted: () => false,
    pythonSelection: () => undefined,
    fs: { readText: async () => undefined, exists: async () => false, find: async () => [] },
    log: msg => logs.push(msg),
    events,
    folders: () => FOLDERS as never,
  });
  events.start();
});

afterEach(() => {
  watcher.dispose();
  events.dispose();
  vi.useRealTimers();
});

/** A file event from the watcher of the folder that holds `path` (or of the first folder). */
function fire(path: string): void {
  fireCreate(path);
}

function fireCreate(path: string): void {
  const w = h.watchers.find(x => path.startsWith(`${x.pattern.base.uri.fsPath}/`)) ?? h.watchers[0];
  w.create?.({ scheme: 'file', fsPath: path });
}

/** A file written now (its modification time). */
function written(path: string, ageMs = 0): string {
  h.mtimes.set(path, Date.now() - ageMs);
  return path;
}

test('one watcher per folder is created, and nothing is read', () => {
  expect(h.watchers.map(w => [w.pattern.base.uri.fsPath, w.pattern.pattern])).toEqual([['/w/one', '**/*'], ['/w/two', '**/*']]);
  expect(parse).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

test('a file that is not a coverage report is dropped silently', async () => {
  parse.mockRejectedValue(new NotCoverageReportError('not a report'));
  fire('/w/one/coverage.xml');
  await vi.advanceTimersByTimeAsync(5_000);
  expect(parse).toHaveBeenCalledTimes(1);
  expect(logs).toEqual([]);
  expect(store.keys()).toEqual([]);
});

test('an unreadable report is logged and tried once more after 1 s', async () => {
  parse.mockRejectedValue(new ReportParseError('unexpected end'));
  fire('/w/one/coverage/lcov.info');
  await vi.advanceTimersByTimeAsync(750);
  expect(parse).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(parse).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(parse).toHaveBeenCalledTimes(2);
  expect(logs).toEqual([
    'Could not read the coverage report /w/one/coverage/lcov.info yet: unexpected end',
    'Could not read the coverage report /w/one/coverage/lcov.info yet: unexpected end',
  ]);
});

test('any other error is logged once and the report dropped', async () => {
  parse.mockRejectedValue(new Error('worker crashed'));
  fire('/w/one/coverage/lcov.info');
  await vi.advanceTimersByTimeAsync(5_000);
  expect(parse).toHaveBeenCalledTimes(1);
  expect(logs).toEqual(['Could not load the coverage report /w/one/coverage/lcov.info: worker crashed']);
});

test('a .coverage file in an untrusted workspace is skipped with a log line and nothing is run', async () => {
  fire('/w/one/.coverage');
  await vi.advanceTimersByTimeAsync(5_000);
  expect(parse).not.toHaveBeenCalled();
  expect(logs).toHaveLength(1);
  expect(logs[0]).toMatch(/^Skipped \/w\/one\/\.coverage: the workspace is not trusted/);
});

test('a path outside every workspace folder, or excluded, is ignored', async () => {
  fire('/elsewhere/coverage/lcov.info');
  fire('/w/one/node_modules/pkg/coverage/lcov.info');
  await vi.advanceTimersByTimeAsync(5_000);
  expect(parse).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

test('reports of two result folders under one TestResults form one group and one store key', async () => {
  parse.mockResolvedValue({ ...report('/w/one/api/A.cs'), signature: 'Api' });
  fire('/w/one/api/TestResults/1111/coverage.cobertura.xml');
  fire('/w/one/api/TestResults/2222/coverage.cobertura.xml');
  await vi.advanceTimersByTimeAsync(750);
  expect(parse.mock.calls.map(c => c[0])).toEqual(['/w/one/api/TestResults/2222/coverage.cobertura.xml']);
  expect(store.keys()).toEqual(['unowned:/w/one/api/TestResults#Api']);
});

test('a report inside a discovered project is stored under its key, and ignored while the project is suppressed', async () => {
  projects = [{
    key: 'project:/w/one/web/package.json', adapter: 'jest', ecosystem: 'node', dir: '/w/one/web',
    definingFile: '/w/one/web/package.json', name: 'web', supportsPartial: true, meta: {},
  }];
  suppressed.add('project:/w/one/web/package.json');
  fire('/w/one/web/coverage/lcov.info');
  await vi.advanceTimersByTimeAsync(5_000);
  expect(parse).not.toHaveBeenCalled();
  suppressed.clear();
  fire('/w/one/web/coverage/lcov.info');
  await vi.advanceTimersByTimeAsync(750);
  expect(parse).toHaveBeenCalledTimes(1);
  expect(store.keys()).toEqual(['project:/w/one/web/package.json']);
  expect(logs).toEqual(['Loaded /w/one/web/coverage/lcov.info (1 file(s)).']);
});

test('a file that matches no report glob is not read; a created extension-less path costs one stat and no search', async () => {
  fire('/w/one/src/a.js');
  fire('/w/one/README');
  await vi.advanceTimersByTimeAsync(5_000);
  expect(parse).not.toHaveBeenCalled();
  expect(h.stats).toEqual(['/w/one/README']);
  expect(h.finds).toEqual([]);
});

test('a folder created with reports already inside is searched for report names only, and its reports are loaded', async () => {
  h.dirs.set('/w/one/coverage', [written('/w/one/coverage/lcov.info'), written('/w/one/coverage/lcov-report/index.html')]);
  fire('/w/one/coverage');
  await vi.advanceTimersByTimeAsync(1_500);
  expect(parse.mock.calls.map(c => c[0])).toEqual(['/w/one/coverage/lcov.info']);
  expect(logs).toEqual(['Loaded /w/one/coverage/lcov.info (1 file(s)).']);
  expect(h.finds).toHaveLength(1);
  expect(h.finds[0].base).toBe('/w/one/coverage');
  expect(h.finds[0].maxResults).toBe(50);
  expect(h.finds[0].pattern).not.toContain('**/*}');
  expect(h.finds[0].pattern).toContain('lcov.info');
});

test('folders created in one burst are searched once, from the outermost', async () => {
  h.dirs.set('/w/one/out', [written('/w/one/out/coverage/lcov.info')]);
  h.dirs.set('/w/one/out/coverage', [written('/w/one/out/coverage/lcov.info')]);
  fire('/w/one/out');
  fire('/w/one/out/coverage');
  await vi.advanceTimersByTimeAsync(1_500);
  expect(h.finds.map(f => f.base)).toEqual(['/w/one/out']);
  expect(h.stats.filter(p => !p.endsWith('.info'))).toEqual(['/w/one/out']);
  expect(parse).toHaveBeenCalledTimes(1);
});

test('a folder moved in with old reports does not load them', async () => {
  h.dirs.set('/w/one/moved', [written('/w/one/moved/coverage/lcov.info', 5 * 60_000)]);
  fire('/w/one/moved');
  await vi.advanceTimersByTimeAsync(5_000);
  expect(h.finds).toHaveLength(1);
  expect(parse).not.toHaveBeenCalled();
});

test('a folder created in an excluded path or under .git is neither stat\'ed nor searched', async () => {
  for (const p of ['/w/one/node_modules/pkg/coverage', '/w/one/.git/refs/heads/x', '/w/one/.git/FETCH_HEAD', '/w/one/sub/.git/objects/ab']) {
    h.dirs.set(p, [written(`${p}/lcov.info`)]);
    fire(p);
  }
  await vi.advanceTimersByTimeAsync(5_000);
  expect(h.stats).toEqual([]);
  expect(h.finds).toEqual([]);
  expect(parse).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
