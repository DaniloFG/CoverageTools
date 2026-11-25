import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import type { Adapter, AdapterId, CommandSpec, FsReader, PlanContext, Project, RunPlan, RunTarget } from '../../../src/adapters/types';
import { loadReport } from '../../../src/parsers/load';
import { runProject, type RunDeps } from '../../../src/runner/runProject';
import { DEFAULT_SETTINGS } from '../../../src/settings';
import { CoverageStore } from '../../../src/store';
import type { ParserClient } from '../../../src/worker/client';
import { file, lines } from '../helpers';

const NODE = process.execPath;

let root: string;
let srcA: string;
let srcB: string;
let store: CoverageStore;
let events: string[];
let seenTmpDirs: string[];
let planFor: (ctx: PlanContext, target: RunTarget) => RunPlan;

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'ct-run-')));
  mkdirSync(path.join(root, 'src'));
  srcA = path.join(root, 'src', 'a.js');
  srcB = path.join(root, 'src', 'b.js');
  writeFileSync(srcA, 'a();\nb();\n');
  writeFileSync(srcB, 'c();\n');
  store = new CoverageStore();
  events = [];
  seenTmpDirs = [];
  planFor = ctx => ({ steps: [writeLcov(path.join(ctx.tmpDir, 'lcov.info'), 1)], reportSearchDir: ctx.tmpDir, hint: 'adapter hint' });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const project: Project = {
  key: 'project:/fake', adapter: 'node-generic', ecosystem: 'node', dir: '/fake', name: 'fake', supportsPartial: true, meta: {},
};

function lcov(count: number, complete = true): string {
  return `TN:\nSF:${srcA}\nDA:1,${count}\nDA:2,0\n${complete ? 'end_of_record\n' : ''}`;
}

/** A step that writes an LCOV report for src/a.js, then exits with `exitCode`. */
function writeLcov(reportPath: string, count: number, opts: { exitCode?: number; complete?: boolean; cwd?: string } = {}): CommandSpec {
  const script = `require("fs").writeFileSync(process.argv[1], process.argv[2]); console.log("wrote"); process.exit(${opts.exitCode ?? 0})`;
  return { command: NODE, args: ['-e', script, reportPath, lcov(count, opts.complete ?? true)], cwd: opts.cwd ?? root };
}

const fakeAdapter: Adapter = {
  id: 'node-generic',
  ecosystem: 'node',
  detect: async () => undefined,
  isTestFile: async () => false,
  plan: async (_p, target, ctx) => {
    seenTmpDirs.push(ctx.tmpDir);
    events.push('plan');
    return planFor(ctx, target);
  },
};

const fsReader: FsReader = { readText: async () => undefined, exists: async () => false, find: async () => [] };
const parser = { parse: async (p: string, roots: readonly string[]) => loadReport(p, roots) } as unknown as ParserClient;

function deps(over: Partial<RunDeps> = {}): RunDeps {
  return {
    adapters: new Map<AdapterId, Adapter>([['node-generic', fakeAdapter]]),
    store, parser, fs: fsReader, settings: DEFAULT_SETTINGS, roots: [root], c8Bin: '/c8',
    output: chunk => { if (/^wrote$/m.test(chunk)) events.push('step'); },
    suppress: key => { events.push(`suppress ${key}`); return { release: () => events.push('release') }; },
    ...over,
  };
}

const full: RunTarget = { kind: 'full' };
const partial = (): RunTarget => ({ kind: 'partial', paths: [srcA] });
const live = () => new AbortController().signal;
const linesOf = (p: string) => lines(store.merged().find(e => e.path === p)!.parts[0]);

test('full run replaces the project data', async () => {
  store.replace(project.key, [file(srcB, [[1, 1]])]);
  const outcome = await runProject(project, full, deps(), live());
  expect(outcome.status).toBe('ok');
  expect(store.merged().map(e => e.path)).toEqual([srcA]);
  expect(linesOf(srcA)).toEqual([[1, 1], [2, 0]]);
});

test('partial run unions into the project data', async () => {
  store.replace(project.key, [file(srcA, [[1, 2]]), file(srcB, [[1, 1]])]);
  planFor = ctx => ({ steps: [writeLcov(path.join(ctx.tmpDir, 'lcov.info'), 5)], reportSearchDir: ctx.tmpDir, hint: '' });
  const outcome = await runProject(project, partial(), deps(), live());
  expect(outcome.status).toBe('ok');
  expect(store.merged().map(e => e.path)).toEqual([srcA, srcB]);
  expect(linesOf(srcA)).toEqual([[1, 7], [2, 0]]);
});

test('non-zero exit with a report yields tests-failed and still ingests', async () => {
  planFor = ctx => ({ steps: [writeLcov(path.join(ctx.tmpDir, 'lcov.info'), 1, { exitCode: 1 })], reportSearchDir: ctx.tmpDir, hint: '' });
  const outcome = await runProject(project, full, deps(), live());
  expect(outcome.status).toBe('tests-failed');
  expect(store.merged().map(e => e.path)).toEqual([srcA]);
});

test('a non-zero exit does not stop the remaining steps', async () => {
  planFor = ctx => ({
    steps: [{ command: NODE, args: ['-e', 'process.exit(2)'], cwd: root }, writeLcov(path.join(ctx.tmpDir, 'lcov.info'), 1)],
    reportSearchDir: ctx.tmpDir,
    hint: '',
  });
  const outcome = await runProject(project, full, deps(), live());
  expect(outcome.status).toBe('tests-failed');
  expect(events.filter(e => e === 'step')).toHaveLength(1);
  expect(store.merged().map(e => e.path)).toEqual([srcA]);
});

test('no report yields no-report with the adapter hint', async () => {
  planFor = ctx => ({ steps: [{ command: NODE, args: ['-e', 'console.log("wrote")'], cwd: root }], reportSearchDir: ctx.tmpDir, hint: 'adapter hint' });
  store.replace(project.key, [file(srcB, [[1, 1]])]);
  const outcome = await runProject(project, full, deps(), live());
  expect(outcome).toMatchObject({ status: 'no-report', hint: 'adapter hint' });
  expect(store.merged().map(e => e.path)).toEqual([srcB]);
});

test('a plan with no steps runs nothing and yields no-report with the plan hint', async () => {
  planFor = ctx => ({ steps: [], reportSearchDir: ctx.tmpDir, hint: 'install the coverage tool' });
  let changes = 0;
  store.onDidChange(() => changes++);
  const outcome = await runProject(project, full, deps(), live());
  expect(outcome).toMatchObject({ status: 'no-report', hint: 'install the coverage tool' });
  expect(events).not.toContain('step');
  expect(changes).toBe(0);
});

test('an unreadable report yields bad-report and keeps the previous data', async () => {
  store.replace(project.key, [file(srcB, [[1, 1]])]);
  planFor = ctx => ({ steps: [writeLcov(path.join(ctx.tmpDir, 'lcov.info'), 1, { complete: false })], reportSearchDir: ctx.tmpDir, hint: '' });
  const outcome = await runProject(project, full, deps(), live());
  expect(outcome.status).toBe('bad-report');
  expect(outcome.message).toMatch(/Truncated LCOV/);
  expect(store.merged().map(e => e.path)).toEqual([srcB]);
  expect(seenTmpDirs.every(d => !existsSync(d))).toBe(true);
});

test('the report is picked by format priority, ignoring coverage.py data, then by modification time', async () => {
  const istanbul = (count: number) => JSON.stringify({
    [srcA]: { path: srcA, statementMap: { 0: { start: { line: 1, column: 0 }, end: { line: 1, column: 4 } } }, fnMap: {}, branchMap: {}, s: { 0: count }, f: {}, b: {} },
  });
  planFor = ctx => {
    const old = path.join(ctx.tmpDir, 'old', 'coverage-final.json');
    const recent = path.join(ctx.tmpDir, 'deep', 'er', 'coverage-final.json');
    mkdirSync(path.dirname(old), { recursive: true });
    mkdirSync(path.dirname(recent), { recursive: true });
    writeFileSync(old, istanbul(1));
    writeFileSync(recent, istanbul(9));
    utimesSync(old, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    writeFileSync(path.join(ctx.tmpDir, '.coverage'), 'SQLite format 3');
    return { steps: [writeLcov(path.join(ctx.tmpDir, 'lcov.info'), 1)], reportSearchDir: ctx.tmpDir, hint: '' };
  };
  const outcome = await runProject(project, full, deps(), live());
  expect(outcome.status).toBe('ok');
  const statements = store.merged()[0].parts[0].statements;
  expect(statements[4]).toBe(9);
});

test('outside the temp directory only reports written during the run count, and dependency folders are skipped', async () => {
  const scanned = path.join(root, 'scanned');
  mkdirSync(path.join(scanned, 'coverage'), { recursive: true });
  mkdirSync(path.join(scanned, 'node_modules', 'dep', 'coverage'), { recursive: true });
  const stale = path.join(scanned, 'coverage', 'lcov.info');
  writeFileSync(stale, lcov(1));
  utimesSync(stale, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
  planFor = () => ({
    steps: [writeLcov(path.join(scanned, 'node_modules', 'dep', 'coverage', 'lcov.info'), 3)],
    reportSearchDir: scanned,
    hint: 'scan hint',
  });
  expect(await runProject(project, full, deps(), live())).toMatchObject({ status: 'no-report', hint: 'scan hint' });

  planFor = () => ({ steps: [writeLcov(stale, 4)], reportSearchDir: scanned, hint: '' });
  expect((await runProject(project, full, deps(), live())).status).toBe('ok');
  expect(linesOf(srcA)).toEqual([[1, 4], [2, 0]]);
});

test('the temp directory is outside every root and removed afterwards', async () => {
  const outcome = await runProject(project, full, deps(), live());
  expect(outcome.status).toBe('ok');
  expect(seenTmpDirs).toHaveLength(1);
  const tmp = seenTmpDirs[0];
  expect(path.isAbsolute(tmp)).toBe(true);
  expect(tmp).toBe(realpathSync(path.dirname(tmp)) + path.sep + path.basename(tmp));
  for (const r of [root]) {
    const rel = path.relative(r, tmp);
    expect(rel.startsWith('..') || path.isAbsolute(rel)).toBe(true);
  }
  expect(existsSync(tmp)).toBe(false);
});

/** Runs `fn` with os.tmpdir() pointing at `base`. */
async function withTmpBase<T>(base: string, fn: () => Promise<T>): Promise<T> {
  const saved = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP };
  process.env.TMPDIR = process.env.TMP = process.env.TEMP = base;
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

test('a temp directory with spaces and non-ASCII characters works as the report directory', async () => {
  const base = path.join(root, 'temp base ção 日本');
  mkdirSync(base);
  const outcome = await withTmpBase(base, () => runProject(project, full, deps(), live()));
  expect(outcome.status).toBe('ok');
  expect(path.dirname(seenTmpDirs[0])).toBe(base);
  expect(store.merged().map(e => e.path)).toEqual([srcA]);
  expect(existsSync(seenTmpDirs[0])).toBe(false);
});

test('a suppress that throws still removes the temp directory and yields spawn-error', async () => {
  const base = path.join(root, 'tmpbase');
  mkdirSync(base);
  const outcome = await withTmpBase(base, () => runProject(project, full, deps({ suppress: () => { throw new Error('no watcher'); } }), live()));
  expect(outcome).toMatchObject({ status: 'spawn-error' });
  expect(outcome.message).toContain('no watcher');
  expect(readdirSync(base)).toEqual([]);
  expect(events).toEqual([]);
});

test('a temp directory that cannot be created yields spawn-error instead of rejecting', async () => {
  const outcome = await withTmpBase(path.join(root, 'does-not-exist'), () => runProject(project, full, deps(), live()));
  expect(outcome.status).toBe('spawn-error');
  expect(outcome.message).toMatch(/ENOENT/);
  expect(events).toEqual([]);
});

test('the project is suppressed during the run and released at the end, even on failure', async () => {
  await runProject(project, full, deps(), live());
  expect(events).toEqual([`suppress ${project.key}`, 'plan', 'step', 'release']);

  events = [];
  planFor = ctx => ({ steps: [{ command: 'ct-no-such-command-for-sure', args: [], cwd: root }], reportSearchDir: ctx.tmpDir, hint: '' });
  const outcome = await runProject(project, full, deps(), live());
  expect(outcome.status).toBe('spawn-error');
  expect(outcome.message).toContain('ct-no-such-command-for-sure');
  expect(events).toEqual([`suppress ${project.key}`, 'plan', 'release']);
  expect(seenTmpDirs.every(d => !existsSync(d))).toBe(true);

  events = [];
  const throwing: Adapter = { ...fakeAdapter, plan: async () => { events.push('plan'); throw new Error('plan failed'); } };
  const failed = await runProject(project, full, deps({ adapters: new Map([['node-generic', throwing]]) }), live());
  expect(failed).toMatchObject({ status: 'spawn-error', message: 'plan failed' });
  expect(events).toEqual([`suppress ${project.key}`, 'plan', 'release']);
});

test('a spawn error stops the remaining steps', async () => {
  planFor = ctx => ({
    steps: [{ command: 'ct-no-such-command-for-sure', args: [], cwd: root }, writeLcov(path.join(ctx.tmpDir, 'lcov.info'), 1)],
    reportSearchDir: ctx.tmpDir,
    hint: '',
  });
  expect((await runProject(project, full, deps(), live())).status).toBe('spawn-error');
  expect(events).not.toContain('step');
  expect(store.keys()).toEqual([]);
});

test('abort yields cancelled and changes nothing in the store', async () => {
  store.replace(project.key, [file(srcB, [[1, 1]])]);
  let changes = 0;
  store.onDidChange(() => changes++);
  const controller = new AbortController();
  planFor = ctx => ({
    steps: [{
      command: NODE,
      args: ['-e', `require("fs").writeFileSync(process.argv[1], process.argv[2]); console.log("wrote"); setInterval(() => {}, 1000)`, path.join(ctx.tmpDir, 'lcov.info'), lcov(1)],
      cwd: root,
    }],
    reportSearchDir: ctx.tmpDir,
    hint: '',
  });
  const run = runProject(project, full, deps({ output: chunk => { if (/^wrote$/m.test(chunk)) controller.abort(); } }), controller.signal);
  expect((await run).status).toBe('cancelled');
  expect(changes).toBe(0);
  expect(store.merged().map(e => e.path)).toEqual([srcB]);
  expect(seenTmpDirs.every(d => !existsSync(d))).toBe(true);

  const before = seenTmpDirs.length;
  events = [];
  expect((await runProject(project, full, deps(), controller.signal)).status).toBe('cancelled');
  expect(seenTmpDirs).toHaveLength(before);
  expect(events).toEqual([]);
});

test('raw V8 coverage under tmp is not taken for a report', async () => {
  planFor = ctx => {
    mkdirSync(path.join(ctx.tmpDir, 'tmp'));
    writeFileSync(path.join(ctx.tmpDir, 'tmp', 'coverage-123-456-0.json'), JSON.stringify({ result: [] }));
    writeFileSync(path.join(ctx.tmpDir, 'coverage-final.json.bak'), '{}');
    writeFileSync(path.join(ctx.tmpDir, 'results.json'), '{}');
    return { steps: [writeLcov(path.join(ctx.tmpDir, 'lcov.info'), 1)], reportSearchDir: ctx.tmpDir, hint: '' };
  };
  const outcome = await runProject(project, full, deps(), live());
  expect(outcome.status).toBe('ok');
  expect(linesOf(srcA)).toEqual([[1, 1], [2, 0]]);
});

test('a candidate that is not a coverage report gives way to the next one', async () => {
  planFor = ctx => {
    writeFileSync(path.join(ctx.tmpDir, 'coverage.xml'), '<?xml version="1.0"?><testsuites></testsuites>');
    return { steps: [writeLcov(path.join(ctx.tmpDir, 'lcov.info'), 2)], reportSearchDir: ctx.tmpDir, hint: '' };
  };
  const outcome = await runProject(project, full, deps(), live());
  expect(outcome.status).toBe('ok');
  expect(linesOf(srcA)).toEqual([[1, 2], [2, 0]]);
});

test('bad-report lists every candidate when none can be read', async () => {
  planFor = ctx => {
    writeFileSync(path.join(ctx.tmpDir, 'coverage.xml'), '<testsuites/>');
    return { steps: [writeLcov(path.join(ctx.tmpDir, 'lcov.info'), 1, { complete: false })], reportSearchDir: ctx.tmpDir, hint: '' };
  };
  const outcome = await runProject(project, full, deps(), live());
  expect(outcome.status).toBe('bad-report');
  expect(outcome.message).toContain('coverage.xml');
  expect(outcome.message).toContain('lcov.info');
  expect(store.keys()).toEqual([]);
});

test('a stale report written just before the run is not ingested', async () => {
  const scanned = path.join(root, 'scanned');
  mkdirSync(path.join(scanned, 'coverage'), { recursive: true });
  writeFileSync(path.join(scanned, 'coverage', 'lcov.info'), lcov(1));
  planFor = () => ({ steps: [{ command: NODE, args: ['-e', ''], cwd: root }], reportSearchDir: scanned, hint: 'stale hint' });
  expect(await runProject(project, full, deps(), live())).toMatchObject({ status: 'no-report', hint: 'stale hint' });
  expect(store.keys()).toEqual([]);
});

test('every cancelled outcome is a fresh object', async () => {
  const controller = new AbortController();
  controller.abort();
  const a = await runProject(project, full, deps(), controller.signal);
  const b = await runProject(project, full, deps(), controller.signal);
  expect(a).toEqual({ status: 'cancelled' });
  expect(a).not.toBe(b);
});

test('a report new to the run is ingested even when its mtime is older than the run start', async () => {
  const scanned = path.join(root, 'scanned');
  mkdirSync(path.join(scanned, 'coverage'), { recursive: true });
  const report = path.join(scanned, 'coverage', 'lcov.info');
  const script = 'const fs = require("fs"); fs.writeFileSync(process.argv[1], process.argv[2]); const t = new Date(Date.now() - 3600000); fs.utimesSync(process.argv[1], t, t)';
  planFor = () => ({ steps: [{ command: NODE, args: ['-e', script, report, lcov(6)], cwd: root }], reportSearchDir: scanned, hint: '' });
  expect((await runProject(project, full, deps(), live())).status).toBe('ok');
  expect(linesOf(srcA)).toEqual([[1, 6], [2, 0]]);
});

test('relative report paths resolve against the project that ran before the other roots', async () => {
  const rootA = path.join(root, 'first');
  const rootB = path.join(root, 'second');
  for (const r of [rootA, rootB]) {
    mkdirSync(path.join(r, 'src'), { recursive: true });
    writeFileSync(path.join(r, 'src', 'calc.js'), 'add();\n');
  }
  const inB: Project = { ...project, key: 'project:second', dir: rootB, meta: { workspaceFolder: root } };
  const relative = 'TN:\nSF:src/calc.js\nDA:1,3\nend_of_record\n';
  planFor = ctx => ({
    steps: [{ command: NODE, args: ['-e', 'require("fs").writeFileSync(process.argv[1], process.argv[2])', path.join(ctx.tmpDir, 'lcov.info'), relative], cwd: rootB }],
    reportSearchDir: ctx.tmpDir,
    hint: '',
  });
  let seenRoots: readonly string[] = [];
  const recording = { parse: async (p: string, roots: readonly string[]) => { seenRoots = roots; return loadReport(p, roots); } } as unknown as ParserClient;
  const outcome = await runProject(inB, full, deps({ roots: [rootA, rootB, root], parser: recording }), live());
  expect(outcome.status).toBe('ok');
  expect(store.merged().map(e => e.path)).toEqual([path.join(rootB, 'src', 'calc.js')]);
  expect(seenRoots).toEqual([rootB, root, rootA]);
});
