// Lightness budgets of ingestion (design 6.1): a synthetic Cobertura report of 5,000 files × 200
// lines (scripts/gen-big-report.mjs, written to a temp dir, never committed). The end-to-end
// paths run the BUILT bundle with the fake `vscode`; the store and merge paths use the sources.
// Sampling: see helpers.ts.
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import nodePath from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import type { FileCoverageData } from '../../src/model';
import { CoverageStore } from '../../src/store';
import { ParserClient } from '../../src/worker/client';
import { generateBigReport } from '../../scripts/gen-big-report.mjs';
import { createFakeVscode, Uri } from './fakeVscode';
import { WORKER_JS, activateBundle, gc, maxBlocks, report, stats, usedMemory, waitFor } from './helpers';

const FILES = 5_000;
const BLOCK_LIMIT_MS = 50;
const MEMORY_LIMIT_MB = 50;
const MB = 1024 * 1024;

let dir: string;
let fullReport: string;
let partialReport: string;

beforeAll(() => {
  dir = mkdtempSync(nodePath.join(os.tmpdir(), 'coverage-tools-big-'));
  fullReport = generateBigReport(dir, { files: FILES });
  partialReport = generateBigReport(dir, { files: FILES, variant: 1 });
}, 120_000);

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

async function parse(path: string): Promise<FileCoverageData[]> {
  const client = new ParserClient(WORKER_JS);
  try {
    return (await client.parse(path, [dir])).files;
  } finally {
    client.dispose();
    await client.idle();
  }
}

/** The whole extension: the report watcher sees the report, the worker parses it, the store takes it, the publisher publishes it. */
async function ingestThroughExtension(): Promise<{ fake: ReturnType<typeof createFakeVscode>; dispose(): void }> {
  const fake = createFakeVscode({ folders: [dir] });
  const ext = activateBundle(fake);
  await ext.api.ready;
  fake.fire('create', [Uri.file(fullReport)]);
  await waitFor(() => fake.runs.some(r => r.ended && r.coverage.length === FILES), 60_000, 'the 5,000-file run to be published');
  return { fake, dispose: () => ext.dispose() };
}

test('ingesting 5,000 files never blocks the main thread for 50 ms (watcher → worker → store → publish)', async () => {
  const blocks = await maxBlocks(async () => {
    const { fake, dispose } = await ingestThroughExtension();
    expect(fake.output).toContain(`Loaded ${fullReport} (${FILES} file(s)).`);
    dispose();
  });
  const s = stats(blocks);
  report('max main-thread block, 5,000-file ingest (best of 3)', s, 'ms', BLOCK_LIMIT_MS);
  expect(s.min).toBeLessThan(BLOCK_LIMIT_MS);
}, 300_000);

test('ingesting 5,000 files never blocks the main thread for 50 ms (parse → store.replace → merged → totals)', async () => {
  const blocks = await maxBlocks(async () => {
    const files = await parse(fullReport);
    const store = new CoverageStore();
    store.replace('project:a', files);
    await new Promise(resolve => setImmediate(resolve));
    expect(store.merged()).toHaveLength(FILES);
    expect(store.totals().total).toBe(FILES * 200);
  });
  const s = stats(blocks);
  report('max main-thread block, parse + replace + merged (best of 3)', s, 'ms', BLOCK_LIMIT_MS);
  expect(s.min).toBeLessThan(BLOCK_LIMIT_MS);
}, 300_000);

test('a partial-run union over 5,000 files stays under the same 50 ms bound, and so do merged() and totals() after it', async () => {
  const full = await parse(fullReport);
  const blocks = await maxBlocks(async () => {
    const store = new CoverageStore();
    store.replace('project:a', full);
    store.merged();
    const partial = await parse(partialReport);
    await store.unionInSlices('project:a', partial);
    await new Promise(resolve => setImmediate(resolve));
    const merged = store.merged();
    await new Promise(resolve => setImmediate(resolve));
    const totals = store.totals();
    expect(merged).toHaveLength(FILES);
    expect(totals.total).toBe(FILES * 200);
    expect(totals.covered).toBeGreaterThan(0);
  });
  const s = stats(blocks);
  report('max main-thread block, partial-run union + merged + totals (best of 3)', s, 'ms', BLOCK_LIMIT_MS);
  expect(s.min).toBeLessThan(BLOCK_LIMIT_MS);
}, 300_000);

/** One sample of the memory the extension keeps for the 5,000-file report, at rest after publishing. */
async function accumulatedSample(): Promise<number> {
  const fake = createFakeVscode({ folders: [dir] });
  const ext = activateBundle(fake);
  await ext.api.ready;
  await gc();
  const before = usedMemory();
  fake.fire('create', [Uri.file(fullReport)]);
  await waitFor(() => fake.runs.some(r => r.ended && r.coverage.length === FILES), 60_000, 'the run to be published');
  // At rest: the worker has exited and its messages are gone.
  await new Promise(resolve => setTimeout(resolve, 200));
  await gc();
  const delta = (usedMemory() - before) / MB;
  expect(ext.api.store.merged()).toHaveLength(FILES);
  ext.dispose();
  return delta;
}

test('5,000 accumulated files add less than 50 MB (the extension at rest, published run included)', async () => {
  // Each sample in a frame of its own, so that nothing of one sample is alive in the next.
  const deltas: number[] = [];
  for (let i = 0; i < 3; i++) deltas.push(await accumulatedSample());
  const s = stats(deltas);
  report('additional memory, 5,000 files accumulated and published', s, 'MB', MEMORY_LIMIT_MB);
  expect(s.median).toBeLessThan(MEMORY_LIMIT_MB);
}, 300_000);

/** A re-run of the same tests: new arrays with the same records and one count changed. */
function rerun(files: readonly FileCoverageData[], n: number): FileCoverageData[] {
  return files.map(f => {
    const statements = f.statements.slice();
    if (statements.length > 0) statements[4] = n;
    return { ...f, statements, branches: f.branches.slice(), declarations: f.declarations.slice() };
  });
}

/**
 * After 5,000 files in 50 projects of 100, republishes 50 times, each after a change to one project,
 * with VS Code keeping the files of the last 64 runs. `fresh`: the change is a re-run (new data for
 * the project's 100 files, as a real run brings). Otherwise the project is replaced by the data it
 * already held (what the extension itself adds per publication). Returns the additional MB.
 */
async function republishSample(all: readonly FileCoverageData[], fresh: boolean): Promise<number> {
  const PROJECTS = 50;
  const perProject = all.length / PROJECTS;
  const fake = createFakeVscode({ folders: [dir], retainRuns: 64 });
  const ext = activateBundle(fake);
  await ext.api.ready;
  await gc();
  const before = usedMemory();
  // Only the extension holds the data from here on, so that what is measured is what it keeps.
  for (let p = 0; p < PROJECTS; p++) ext.api.store.replace(`project:p${p}`, rerun(all.slice(p * perProject, (p + 1) * perProject), 1));
  await fake.run('coverageTools.show');
  for (let i = 0; i < REPUBLISH; i++) {
    const p = i % PROJECTS;
    const key = `project:p${p}`;
    const paths = new Set(all.slice(p * perProject, (p + 1) * perProject).map(f => f.path));
    const held = ext.api.store.merged().filter(e => paths.has(e.path)).map(e => e.parts[0]);
    const next = fresh ? rerun(held, i + 2) : held;
    ext.api.store.clear(key);
    ext.api.store.replace(key, next);
    await fake.run('coverageTools.show');
  }
  expect(fake.runsCreated).toBe(REPUBLISH + 1);
  expect(fake.runs.every(r => r.coverage.length === FILES)).toBe(true);
  await new Promise(resolve => setTimeout(resolve, 200));
  await gc();
  const delta = (usedMemory() - before) / MB;
  ext.dispose();
  return delta;
}

const REPUBLISH = 50;

/** Three samples, each in a frame of its own, so that nothing of one sample is alive in the next. */
async function republishSamples(fresh: boolean): Promise<number[]> {
  // Copied here: buffers transferred from the worker are accounted to `external` late.
  const all = rerun(await parse(fullReport), 0);
  const deltas: number[] = [];
  for (let sample = 0; sample < 3; sample++) deltas.push(await republishSample(all, fresh));
  return deltas;
}

test('50 republications after 5,000 files, with VS Code keeping the last 64 runs, add under 50 MB (unchanged data)', async () => {
  const s = stats(await republishSamples(false));
  report(`additional memory, 5,000 files + ${REPUBLISH} republications, same data (history of 64 runs)`, s, 'MB', MEMORY_LIMIT_MB);
  expect(s.median).toBeLessThan(MEMORY_LIMIT_MB);
}, 300_000);

test('50 republications after 5,000 files, each re-running a 100-file project, with VS Code keeping the last 64 runs, add under 50 MB', async () => {
  const s = stats(await republishSamples(true));
  report(`additional memory, 5,000 files + ${REPUBLISH} republications, each a re-run of 100 files (history of 64 runs)`, s, 'MB', MEMORY_LIMIT_MB);
  expect(s.median).toBeLessThan(MEMORY_LIMIT_MB);
}, 300_000);
