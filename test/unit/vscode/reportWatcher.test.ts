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
  findCalls: 0,
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
          if (h.dirs.has(u.fsPath)) return { type: 2 };
          throw new Error('ENOENT');
        },
      },
      findFiles: async (pattern: { base: FakeUri }) => {
        h.findCalls++;
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
          dispose() {},
        };
      },
    },
  };
});

const { ReportWatcher } = await import('../../../src/vscode/reportWatcher');

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

beforeEach(() => {
  vi.useFakeTimers();
  h.watchers.length = 0;
  h.dirs.clear();
  h.findCalls = 0;
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
    folders: () => FOLDERS as never,
  });
});

afterEach(() => {
  watcher.dispose();
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

test('a file that matches no report glob is ignored without any file access', async () => {
  fire('/w/one/src/a.js');
  fire('/w/one/README');
  await vi.advanceTimersByTimeAsync(5_000);
  expect(parse).not.toHaveBeenCalled();
  expect(h.findCalls).toBe(0);
});

test('a folder created with reports already inside is searched, and its reports are loaded', async () => {
  h.dirs.set('/w/one/coverage', ['/w/one/coverage/lcov.info', '/w/one/coverage/lcov-report/index.html']);
  fire('/w/one/coverage');
  await vi.advanceTimersByTimeAsync(750);
  expect(parse.mock.calls.map(c => c[0])).toEqual(['/w/one/coverage/lcov.info']);
  expect(logs).toEqual(['Loaded /w/one/coverage/lcov.info (1 file(s)).']);
});
