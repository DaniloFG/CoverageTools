// Shared helpers of the lightness tests: loading the built bundle with the fake `vscode`, and
// robust sampling.
//
// Sampling method (other processes share this machine and the CI runners, so one sample is noise):
// - time budgets: the MEDIAN of several runs (`median`);
// - main-thread block budgets: the maximum event-loop delay over a run, measured with
//   `monitorEventLoopDelay`, repeated 3 times; the BEST (lowest) maximum is the figure (`bestMaxBlock`).
//   A block the code causes shows up in every repetition; a pause caused by another process
//   rarely hits all three.
// Limits are never loosened to make a test pass.
import { createRequire } from 'node:module';
import nodePath from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { fakeContext, installFakeVscode, type FakeVscode } from './fakeVscode';

export const ROOT = nodePath.resolve(__dirname, '../..');
export const EXTENSION_JS = nodePath.join(ROOT, 'dist', 'extension.js');
export const WORKER_JS = nodePath.join(ROOT, 'dist', 'worker.js');

const nodeRequire = createRequire(__filename);

export interface ExtensionApi {
  store: import('../../src/store').CoverageStore;
  ready: Promise<void>;
  watching: Promise<void>;
}

export interface LoadedExtension {
  api: ExtensionApi;
  context: ReturnType<typeof fakeContext>;
  /** Disposes the extension's subscriptions and restores `require('vscode')`. */
  dispose(): void;
}

/** A fresh copy of `dist/extension.js` (not the module cache's), with `vscode` replaced by `fake`. */
export function requireBundle(fake: FakeVscode): { activate(context: unknown): ExtensionApi; uninstall(): void } {
  const uninstall = installFakeVscode(fake);
  delete nodeRequire.cache[EXTENSION_JS];
  const mod = nodeRequire(EXTENSION_JS) as { activate(context: unknown): ExtensionApi };
  return { activate: mod.activate, uninstall };
}

/** Loads and activates the bundle against `fake`. */
export function activateBundle(fake: FakeVscode): LoadedExtension {
  const { activate, uninstall } = requireBundle(fake);
  const context = fakeContext(ROOT);
  const api = activate(context);
  return {
    api,
    context,
    dispose() {
      context.dispose();
      uninstall();
    },
  };
}

/** A fake `ExtensionContext` whose extension directory is the repository (so `dist/worker.js` is found). */
export const fakeContextFor = (): ReturnType<typeof fakeContext> => fakeContext(ROOT);

export interface Stats { min: number; median: number; max: number; samples: number }

export function stats(values: readonly number[]): Stats {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const median = sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return { min: sorted[0], median, max: sorted[sorted.length - 1], samples: sorted.length };
}

export function format(s: Stats, unit: string): string {
  const n = (v: number) => (v < 10 ? v.toFixed(2) : v.toFixed(1));
  return `min ${n(s.min)} / median ${n(s.median)} / max ${n(s.max)} ${unit} (${s.samples} samples)`;
}

/** Prints a measured figure, so that the numbers can be quoted from the test output. */
export function report(name: string, s: Stats, unit: string, limit: number): void {
  console.log(`[perf] ${name}: ${format(s, unit)}; limit ${limit} ${unit}`);
}

/**
 * The longest main-thread block while `work` runs, in ms: the maximum event-loop delay sampled
 * every 5 ms (`monitorEventLoopDelay`). The histogram measures how late its timer fires, so a
 * synchronous stretch of N ms shows up as about N ms.
 */
export async function maxBlock(work: () => Promise<void>): Promise<number> {
  const h = monitorEventLoopDelay({ resolution: 5 });
  // Let the sampler's timer start before the work does.
  await new Promise(resolve => setTimeout(resolve, 20));
  h.enable();
  try {
    await work();
    // One more sample after the work, so that a block at its very end is recorded.
    await new Promise(resolve => setTimeout(resolve, 20));
  } finally {
    h.disable();
  }
  return h.max / 1e6;
}

/** `maxBlock` over `runs` repetitions (each with fresh state from `work`). */
export async function maxBlocks(work: () => Promise<void>, runs = 3): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < runs; i++) out.push(await maxBlock(work));
  return out;
}

export function gc(): void {
  const collect = (globalThis as { gc?: () => void }).gc;
  if (collect === undefined) throw new Error('The perf tests need --expose-gc (see the perf project in vitest.config.ts)');
  // Twice: finalizers of the first collection free more on the second.
  collect();
  collect();
}

/**
 * Heap plus memory held outside it (typed arrays' buffers included), in bytes. `external`, not
 * `arrayBuffers`: buffers transferred from the parser worker were allocated by the worker and only
 * show up in `external`.
 */
export function usedMemory(): number {
  const m = process.memoryUsage();
  return m.heapUsed + m.external;
}

/** Resolves after `ms`; the timer is gone by the time the promise settles. */
export const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** Polls `condition` every 10 ms until it holds or `timeoutMs` passes. */
export async function waitFor(condition: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await sleep(10);
  }
}

/** Resource types (`process.getActiveResourcesInfo`) that mean work is pending: timers and threads. */
export function pendingResources(): string[] {
  return process.getActiveResourcesInfo().filter(r => r === 'Timeout' || r === 'Immediate' || r === 'Worker' || r === 'MessagePort');
}
