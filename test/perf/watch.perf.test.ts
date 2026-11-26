// The file-event hot path of the BUILT bundle (dist/extension.js) with the fake `vscode`: the
// extension watches every path of each workspace folder (one watcher per folder, shared by project
// discovery and the report watcher), so the cost per event must stay negligible.
// Sampling: see helpers.ts.
import { expect, test } from 'vitest';
import { createFakeVscode, Uri } from './fakeVscode';
import { activateBundle, report, sleep, stats } from './helpers';

const WS = '/ws';
const EVENTS = 50_000;
const HOT_PATH_LIMIT_MS = 100;

/** Paths that are neither reports nor of interest to discovery: sources, dependencies, build output, git. */
function irrelevantPaths(n: number): Uri[] {
  const shapes = [
    (i: number) => `src/feature${i % 50}/a${i}.ts`,
    (i: number) => `src/b${i}.py`,
    (i: number) => `node_modules/pkg${i % 300}/lib/index${i}.js`,
    (i: number) => `node_modules/.bin/tool${i}`,
    (i: number) => `bin/Debug/net8.0/App${i}.dll`,
    (i: number) => `obj/Debug/net8.0/App${i}.AssemblyInfo.cs`,
    (i: number) => `.git/objects/${(i % 256).toString(16)}/${i.toString(16).padStart(38, '0')}`,
    (i: number) => `.git/refs/heads/branch${i}`,
    (i: number) => `docs/page${i}.md`,
  ];
  const out: Uri[] = [];
  for (let i = 0; i < n; i++) out.push(Uri.file(`${WS}/${shapes[i % shapes.length](i)}`));
  for (const u of out) void u.fsPath; // VS Code hands over Uris whose fsPath is computed once; not ours to time.
  return out;
}

const pendingTimers = (): string[] => process.getActiveResourcesInfo().filter(r => r === 'Timeout' || r === 'Immediate');

test('50,000 irrelevant file events take under 100 ms in all, with no file access and no timer (median of 5)', async () => {
  const fake = createFakeVscode({ folders: [WS] });
  const ext = activateBundle(fake);
  await ext.api.ready;
  await sleep(10);
  expect(fake.watcherCount).toBe(1);
  const callsBefore = fake.fileCalls.length;
  const timersBefore = pendingTimers().length;
  const uris = irrelevantPaths(EVENTS);
  const kinds = ['change', 'create', 'delete'] as const;
  const times: number[] = [];
  for (let run = 0; run < 5; run++) {
    const t0 = performance.now();
    fake.fire(kinds[run % 3], uris);
    times.push(performance.now() - t0);
    // Whatever the events started must be done (or never started) by now.
    await sleep(1_000);
  }
  const s = stats(times);
  report(`${EVENTS} irrelevant file events`, s, 'ms', HOT_PATH_LIMIT_MS);
  expect(fake.fileCalls.slice(callsBefore)).toEqual([]);
  // In this process the test runner has timers of its own: none may be added.
  expect(pendingTimers().length).toBeLessThanOrEqual(timersBefore);
  expect(fake.output.filter(l => l.startsWith('Discovery finished'))).toHaveLength(1);
  expect(s.median).toBeLessThan(HOT_PATH_LIMIT_MS);
  ext.dispose();
}, 60_000);

test('a relevant burst (2,000 excluded files, 200 new extension-less paths) costs one stat per new path and at most one discovery', async () => {
  // Half the new paths are folders (with a source file inside), half are plain files.
  const files = new Map<string, string>();
  for (let i = 0; i < 100; i++) files.set(`${WS}/dir${i}/x.txt`, '');
  for (let i = 100; i < 200; i++) files.set(`${WS}/dir${i}`, '');
  const fake = createFakeVscode({ folders: [WS], files });
  const ext = activateBundle(fake);
  await ext.api.ready;
  const discoveries = () => fake.output.filter(l => l.startsWith('Discovery finished')).length;
  const firstCalls = fake.fileCalls.length;
  const timersBefore = pendingTimers().length;
  const excluded: Uri[] = [];
  const roots = ['node_modules/pkg', 'bin/Debug', 'obj/Debug', '.venv/lib', 'sub/node_modules/x'];
  for (let i = 0; i < 2_000; i++) excluded.push(Uri.file(`${WS}/${roots[i % roots.length]}/f${i}${i % 2 ? '' : '.js'}`));
  const created: Uri[] = [];
  for (let i = 0; i < 200; i++) created.push(Uri.file(`${WS}/dir${i}`));
  fake.fire('create', excluded);
  fake.fire('create', created);
  fake.fire('create', excluded);
  await sleep(3_000);
  const calls = fake.fileCalls.slice(firstCalls);
  const stats = calls.filter(c => c.api === 'fs.stat').map(c => c.path);
  const finds = calls.filter(c => c.api === 'findFiles').map(c => c.path);
  console.log(`[perf] relevant burst: ${stats.length} stat(s) for ${created.length} new paths, ${finds.length} search(es), ${discoveries() - 1} rediscover(ies)`);
  // At most one stat per distinct new path (shared by discovery and the report watcher), none excluded.
  expect(new Set(stats).size).toBe(stats.length);
  expect(stats.every(p => /^\/ws\/dir\d+$/.test(p))).toBe(true);
  expect(stats.length).toBeLessThanOrEqual(created.length);
  // Searches: one per created folder by the report watcher (report names only), plus at most one discovery.
  expect(finds.filter(p => p === WS).length).toBeLessThanOrEqual(1);
  expect(finds.filter(p => p !== WS).length).toBeLessThanOrEqual(2 * 100);
  expect(discoveries() - 1).toBeLessThanOrEqual(1);
  expect(pendingTimers().length).toBeLessThanOrEqual(timersBefore);
  ext.dispose();
}, 60_000);
