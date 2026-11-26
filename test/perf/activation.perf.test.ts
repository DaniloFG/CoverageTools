// Lightness budgets of activation and rest (design 6.1), measured on the BUILT bundle
// (dist/extension.js, `npm run build`) with `vscode` replaced by the fake in fakeVscode.ts.
// Sampling: see helpers.ts.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import nodePath from 'node:path';
import workerThreads from 'node:worker_threads';
import * as esbuild from 'esbuild';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { createFakeVscode } from './fakeVscode';
import { EXTENSION_JS, ROOT, fakeContextFor, report, requireBundle, stats } from './helpers';

const ACTIVATION_RUNS = 20;
const ACTIVATION_LIMIT_MS = 20;

let tmp: string;
let childJs: string;

beforeAll(async () => {
  if (!fs.existsSync(EXTENSION_JS)) throw new Error('dist/extension.js not found: run "npm run build" first');
  tmp = mkdtempSync(nodePath.join(os.tmpdir(), 'coverage-tools-perf-'));
  childJs = nodePath.join(tmp, 'child.js');
  await esbuild.build({
    entryPoints: [nodePath.join(__dirname, 'child.ts')], outfile: childJs, bundle: true, platform: 'node', format: 'cjs', target: 'node20', logLevel: 'warning',
  });
});

afterAll(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

function child(...args: string[]): Record<string, unknown> {
  const out = execFileSync(process.execPath, [childJs, ...args], { encoding: 'utf8', timeout: 60_000 });
  return JSON.parse(out.trim().split('\n').pop() ?? '{}') as Record<string, unknown>;
}

/** Wraps every function of `target` so that calls are counted while `counting.on` is set. */
function countCalls(target: Record<string, unknown>, name: string, counting: { on: boolean; calls: string[] }): () => void {
  const originals: Array<[string, unknown]> = [];
  for (const key of Object.keys(target)) {
    const fn = target[key];
    if (typeof fn !== 'function' || /^[A-Z]/.test(key)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    if (!descriptor?.writable && !descriptor?.set) continue;
    originals.push([key, fn]);
    target[key] = function (this: unknown, ...args: unknown[]) {
      if (counting.on) counting.calls.push(`${name}.${key}`);
      return (fn as (...a: unknown[]) => unknown).apply(this, args);
    };
  }
  return () => { for (const [key, fn] of originals) target[key] = fn; };
}

test('activate performs no file reads, creates no watcher, timer or worker', () => {
  const fake = createFakeVscode({ folders: [nodePath.join(ROOT, 'samples')] });
  const { activate, uninstall } = requireBundle(fake);
  const counting = { on: false, calls: [] as string[] };
  const g = globalThis as unknown as Record<string, unknown>;
  const restore = [
    countCalls(fs as unknown as Record<string, unknown>, 'fs', counting),
    countCalls(fs.promises as unknown as Record<string, unknown>, 'fs.promises', counting),
    countCalls(workerThreads as unknown as Record<string, unknown>, 'worker_threads', counting),
  ];
  const timerOriginals = ['setTimeout', 'setInterval'].map(k => [k, g[k]] as const);
  for (const [k, fn] of timerOriginals) {
    g[k] = (...args: unknown[]) => {
      if (counting.on) counting.calls.push(k);
      return (fn as (...a: unknown[]) => unknown)(...args);
    };
  }
  const OriginalWorker = workerThreads.Worker;
  let workers = 0;
  (workerThreads as { Worker: unknown }).Worker = class extends OriginalWorker {
    constructor(...args: ConstructorParameters<typeof OriginalWorker>) {
      super(...args);
      workers++;
    }
  };
  const context = fakeContextFor();
  try {
    counting.on = true;
    activate(context);
    counting.on = false;
  } finally {
    counting.on = false;
    for (const r of restore) r();
    for (const [k, fn] of timerOriginals) g[k] = fn;
    (workerThreads as { Worker: unknown }).Worker = OriginalWorker;
    context.dispose();
    uninstall();
  }
  expect(counting.calls).toEqual([]);
  expect(fake.fileCalls).toEqual([]);
  expect(workers).toBe(0);
});

test('activate returns in under 20 ms (code loading included; median of 20 fresh processes)', () => {
  const total: number[] = [];
  const activateOnly: number[] = [];
  for (let i = 0; i < ACTIVATION_RUNS; i++) {
    const r = child('activate', ROOT) as { ms: number; activateMs: number };
    total.push(r.ms);
    activateOnly.push(r.activateMs);
  }
  const s = stats(total);
  report('activation (require + activate)', s, 'ms', ACTIVATION_LIMIT_MS);
  report('activation (activate call only)', stats(activateOnly), 'ms', ACTIVATION_LIMIT_MS);
  expect(s.median).toBeLessThan(ACTIVATION_LIMIT_MS);
});

test('no timer is pending once discovery has settled on an empty workspace', () => {
  const ws = mkdtempSync(nodePath.join(tmp, 'empty-'));
  const r = child('idle', ROOT, ws) as { first: string[]; second: string[]; workersAlive: number; workersStarted: number; output: string[] };
  expect(r.output).toContain('Discovery finished: 0 project(s).');
  expect(r.first).toEqual([]);
  expect(r.second).toEqual([]);
  expect(r.workersStarted).toBe(0);
});

test('nothing is left running at rest after a report was loaded and published (no timer, no worker thread)', () => {
  const ws = mkdtempSync(nodePath.join(tmp, 'report-'));
  mkdirSync(nodePath.join(ws, 'coverage'));
  writeFileSync(nodePath.join(ws, 'a.js'), 'module.exports = 1;\n');
  const lcov = nodePath.join(ws, 'coverage', 'lcov.info');
  writeFileSync(lcov, `TN:\nSF:${nodePath.join(ws, 'a.js')}\nDA:1,1\nend_of_record\n`);
  const r = child('idle', ROOT, ws, lcov) as { published: boolean; first: string[]; second: string[]; workersAlive: number; workersStarted: number; output: string[] };
  expect(r.output).toContain(`Loaded ${lcov} (1 file(s)).`);
  expect(r.published).toBe(true);
  expect(r.workersStarted).toBe(1);
  expect(r.workersAlive).toBe(0);
  expect(r.first).toEqual([]);
  expect(r.second).toEqual([]);
});
