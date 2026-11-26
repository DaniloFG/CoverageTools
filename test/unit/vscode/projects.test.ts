import nodePath from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { dotnetVstestAdapter } from '../../../src/adapters/dotnetVstest';
import { jestAdapter } from '../../../src/adapters/jest';
import { pythonAdapter } from '../../../src/adapters/python';
import { matchesAny } from '../../../src/glob';
import { DEFAULT_SETTINGS } from '../../../src/settings';
import type { VSCodeFsReader } from '../../../src/vscode/fsReader';
import { nativePath as n } from '../helpers';

interface FakeUri { scheme: string; fsPath: string }
interface FakeWatcher { base: string; create?: (u: FakeUri) => void; change?: (u: FakeUri) => void; del?: (u: FakeUri) => void }

const h = vi.hoisted(() => ({ watchers: [] as FakeWatcher[], files: new Map<string, string>(), io: [] as string[] }));

vi.mock('vscode', () => {
  const disposable = { dispose() {} };
  const folder = { uri: { scheme: 'file', fsPath: n('/w') }, name: 'w', index: 0 };
  return {
    Uri: { file: (p: string) => ({ scheme: 'file', fsPath: p }) },
    RelativePattern: class {
      constructor(public base: { uri: FakeUri }, public pattern: string) {}
    },
    FileType: { File: 1, Directory: 2 },
    workspace: {
      workspaceFolders: [folder],
      fs: {
        stat: async (u: FakeUri) => {
          h.io.push(`stat ${u.fsPath}`);
          if (h.files.has(u.fsPath)) return { type: 1 };
          if ([...h.files.keys()].some(f => f.startsWith(`${u.fsPath}${nodePath.sep}`))) return { type: 2 };
          throw new Error('ENOENT');
        },
      },
      onDidChangeConfiguration: () => disposable,
      onDidChangeWorkspaceFolders: () => disposable,
      createFileSystemWatcher: (pattern: { base: { uri: FakeUri } }) => {
        const w: FakeWatcher = { base: pattern.base.uri.fsPath };
        h.watchers.push(w);
        return {
          onDidCreate: (fn: (u: FakeUri) => void) => { w.create = fn; return disposable; },
          onDidChange: (fn: (u: FakeUri) => void) => { w.change = fn; return disposable; },
          onDidDelete: (fn: (u: FakeUri) => void) => { w.del = fn; return disposable; },
          dispose() {},
        };
      },
    },
  };
});

const { ProjectDiscovery } = await import('../../../src/vscode/projects');
const { WorkspaceFileEvents } = await import('../../../src/vscode/fileEvents');

const JEST = JSON.stringify({ name: 'web', scripts: { test: 'jest' } });
const VSTEST_CSPROJ =
  '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.0.0" />' +
  '<PackageReference Include="xunit" Version="2.9.0" /></ItemGroup></Project>';

const files = h.files;
let readers: number;
/** While set, `find` waits for it (a slow search). */
let gate: Promise<void> | undefined;
let logs: string[];
let events: InstanceType<typeof WorkspaceFileEvents>;
let discovery: InstanceType<typeof ProjectDiscovery>;

function memoryFs(): VSCodeFsReader {
  readers++;
  return {
    async readText(p) { h.io.push(`read ${p}`); return files.get(p); },
    async exists(p) { h.io.push(`exists ${p}`); return files.has(p) || [...files.keys()].some(f => f.startsWith(`${p}${nodePath.sep}`)); },
    async find(dir, include, exclude) {
      h.io.push(`find ${dir}`);
      if (gate) await gate;
      return [...files.keys()].filter(f => f.startsWith(`${dir}${nodePath.sep}`)).filter(f => {
        const rel = nodePath.relative(dir, f).split(nodePath.sep).join('/');
        return matchesAny(rel, include) && !matchesAny(rel, exclude);
      }).sort();
    },
    async statMtime(p) { h.io.push(`stat ${p}`); return files.has(p) ? 1 : undefined; },
    async kindOf(p) {
      h.io.push(`stat ${p}`);
      return files.has(p) ? 'file' : [...files.keys()].some(f => f.startsWith(`${p}${nodePath.sep}`)) ? 'directory' : undefined;
    },
  };
}

const discoveries = (): number => logs.filter(l => l.startsWith('Discovery finished')).length;

function fire(kind: 'create' | 'change' | 'delete', p: string): void {
  for (const w of h.watchers) (kind === 'create' ? w.create : kind === 'change' ? w.change : w.del)?.({ scheme: 'file', fsPath: p });
}

beforeEach(async () => {
  vi.useFakeTimers();
  h.watchers.length = 0;
  files.clear();
  for (const [p, text] of Object.entries({
    [n('/w/web/package.json')]: JEST,
    [n('/w/web/a.test.js')]: '',
    [n('/w/web/src/util.js')]: '',
    [n('/w/T/T.csproj')]: VSTEST_CSPROJ,
    [n('/w/T/CalcTests.cs')]: 'public class CalcTests { [Fact] public void A() { } }',
  })) files.set(p, text);
  h.io.length = 0;
  readers = 0;
  gate = undefined;
  logs = [];
  events = new WorkspaceFileEvents({ settingsOf: () => DEFAULT_SETTINGS });
  discovery = new ProjectDiscovery({
    makeFs: memoryFs,
    adapters: [jestAdapter, pythonAdapter, dotnetVstestAdapter],
    settingsOf: () => DEFAULT_SETTINGS,
    log: msg => logs.push(msg),
    events,
    onState: () => {},
  });
  events.start();
  discovery.start();
  await vi.advanceTimersByTimeAsync(0);
  await discovery.ready;
  expect(discovery.projects().map(p => p.name)).toEqual(['T', 'web']);
  h.io.length = 0;
  readers = 0;
});

afterEach(() => {
  discovery.dispose();
  events.dispose();
  vi.useRealTimers();
});

test('events in node_modules, .git or an excluded path cost nothing', async () => {
  for (const p of [n('/w/web/node_modules/x/a.test.js'), n('/w/.git/refs/heads/main'), n('/w/T/bin/Debug/a.cs'), n('/w/T/obj/x.cs'), n('/w/web/node_modules/package.json')]) {
    fire('create', p);
    fire('change', p);
  }
  await vi.advanceTimersByTimeAsync(5_000);
  expect(h.io).toEqual([]);
  expect(readers).toBe(0);
  expect(discoveries()).toBe(1);
});

test('a save outside every project, or of a file no project there could take as a test file, costs nothing', async () => {
  for (const p of [n('/w/scripts/build.js'), n('/w/web/src/util.js'), n('/w/web/tools/gen.py'), n('/w/T/wwwroot/site.js'), n('/w/README.md')]) fire('change', p);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(h.io).toEqual([]);
  expect(readers).toBe(0);
});

test('a test file saved inside a project is re-evaluated without a search', async () => {
  files.set(n('/w/web/b.test.js'), '');
  fire('create', n('/w/web/b.test.js'));
  fire('change', n('/w/T/Helper.cs'));
  await vi.advanceTimersByTimeAsync(0);
  expect(readers).toBe(2);
  expect(h.io.filter(x => x.startsWith('find'))).toEqual([]);
  expect(discovery.current?.testFiles.get(`project:${n(n('/w/web/package.json'))}`)).toEqual([n('/w/web/a.test.js'), n('/w/web/b.test.js')]);
});

test('marker events make exactly one discovery, 750 ms after the last one', async () => {
  fire('change', n('/w/web/package.json'));
  fire('change', n('/w/T/T.csproj'));
  await vi.advanceTimersByTimeAsync(700);
  fire('create', n('/w/Directory.Build.props'));
  await vi.advanceTimersByTimeAsync(700);
  expect(discoveries()).toBe(1);
  await vi.advanceTimersByTimeAsync(100);
  expect(discoveries()).toBe(2);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(discoveries()).toBe(2);
});

test('a discovery requested while one runs makes exactly one more', async () => {
  let open!: () => void;
  gate = new Promise(resolve => { open = resolve; });
  fire('change', n('/w/web/package.json'));
  await vi.advanceTimersByTimeAsync(750);
  fire('change', n('/w/web/package.json'));
  await vi.advanceTimersByTimeAsync(750);
  fire('change', n('/w/web/package.json'));
  await vi.advanceTimersByTimeAsync(750);
  gate = undefined;
  open();
  await vi.advanceTimersByTimeAsync(5_000);
  expect(discoveries()).toBe(3);
});

test('a burst of more paths than the limit becomes one discovery instead of one refresh each', async () => {
  let open!: () => void;
  const slow = new Promise<void>(resolve => { open = resolve; });
  const make = memoryFs;
  // Each refresh waits, as one through VS Code's file system would, so the burst piles up.
  (discovery as unknown as { deps: { makeFs(): VSCodeFsReader } }).deps.makeFs = () => {
    const fs = make();
    return { ...fs, async readText(p) { await slow; return fs.readText(p); } };
  };
  for (let i = 0; i < 1_000; i++) fire('change', n(`/w/T/F${i}.cs`));
  open();
  await vi.advanceTimersByTimeAsync(5_000);
  expect(discoveries()).toBe(2);
  expect(readers).toBeLessThanOrEqual(3);
});

test('dispose clears the pending discovery', async () => {
  fire('change', n('/w/web/package.json'));
  expect(vi.getTimerCount()).toBe(1);
  discovery.dispose();
  expect(vi.getTimerCount()).toBe(0);
});

test('a burst of events before the first discovery finishes does not trigger a second discovery', async () => {
  const log: string[] = [];
  let open!: () => void;
  gate = new Promise<void>(resolve => { open = resolve; });
  const fresh = new ProjectDiscovery({
    makeFs: memoryFs, adapters: [jestAdapter, pythonAdapter, dotnetVstestAdapter], settingsOf: () => DEFAULT_SETTINGS,
    log: msg => log.push(msg), events, onState: () => {},
  });
  fresh.start();
  await vi.advanceTimersByTimeAsync(0);
  for (let i = 0; i < 1_000; i++) fire('change', n(`/w/T/F${i}.cs`));
  gate = undefined;
  open();
  await vi.advanceTimersByTimeAsync(5_000);
  expect(log.filter(l => l.startsWith('Discovery finished'))).toHaveLength(1);
  fresh.dispose();
});
