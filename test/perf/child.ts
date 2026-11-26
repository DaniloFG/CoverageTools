// Runs in a fresh Node process (bundled with esbuild by the activation tests): loads the built
// extension with the fake `vscode` and prints one JSON line with what was measured.
//   node child.js activate <extension dir>             → { ms, codeMs, activateMs }
//   node child.js idle <extension dir> <workspace> [report]
//        → { resources, workers, output } once the extension has settled (after the report, if
//          given, was loaded and published)
import { performance } from 'node:perf_hooks';
import nodePath from 'node:path';
import workerThreads from 'node:worker_threads';
import { createRequire } from 'node:module';
import { createFakeVscode, fakeContext, installFakeVscode, Uri } from './fakeVscode';

interface Api { ready: Promise<void>; watching: Promise<void> }

const [mode, extensionDir, workspace, report] = process.argv.slice(2);
const nodeRequire = createRequire(__filename);
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** Counts the worker threads started and still alive. */
function trackWorkers(): { alive(): number; started(): number } {
  const Original = workerThreads.Worker;
  let alive = 0, started = 0;
  class Tracked extends Original {
    constructor(...args: ConstructorParameters<typeof Original>) {
      super(...args);
      alive++;
      started++;
      this.once('exit', () => { alive--; });
    }
  }
  (workerThreads as { Worker: typeof Original }).Worker = Tracked;
  return { alive: () => alive, started: () => started };
}

async function waitFor(condition: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) return false;
    await sleep(20);
  }
  return true;
}

/** What is pending once a timer callback has returned: every other timer, immediate and handle kind. */
async function settledResources(): Promise<string[]> {
  await sleep(1);
  return process.getActiveResourcesInfo().filter(r => r === 'Timeout' || r === 'Immediate');
}

async function main(): Promise<void> {
  const extensionJs = nodePath.join(extensionDir, 'dist', 'extension.js');
  if (mode === 'activate') {
    const fake = createFakeVscode({ folders: [] });
    installFakeVscode(fake);
    const t0 = performance.now();
    const mod = nodeRequire(extensionJs) as { activate(c: unknown): Api };
    const t1 = performance.now();
    mod.activate(fakeContext(extensionDir));
    const t2 = performance.now();
    process.stdout.write(`${JSON.stringify({ ms: t2 - t0, codeMs: t1 - t0, activateMs: t2 - t1 })}\n`);
    process.exit(0);
  }
  if (mode === 'idle') {
    const workers = trackWorkers();
    const fake = createFakeVscode({ folders: [workspace] });
    installFakeVscode(fake);
    const mod = nodeRequire(extensionJs) as { activate(c: unknown): Api };
    const context = fakeContext(extensionDir);
    const api = mod.activate(context);
    await api.ready;
    let published = true;
    if (report !== undefined) {
      fake.fire('create', [Uri.file(report)]);
      published = await waitFor(() => fake.runs.some(r => r.ended && r.coverage.length > 0), 10_000);
    }
    // Settled: every debounce has fired and the parser worker has exited.
    await waitFor(() => workers.alive() === 0, 5_000);
    await sleep(1_000);
    const first = await settledResources();
    // Still nothing a second later: no timer comes back on its own.
    await sleep(1_000);
    const second = await settledResources();
    process.stdout.write(`${JSON.stringify({
      published, first, second, workersAlive: workers.alive(), workersStarted: workers.started(), output: fake.output, fileCalls: fake.fileCalls,
    })}\n`);
    context.dispose();
    process.exit(0);
  }
  throw new Error(`Unknown mode ${mode}`);
}

void main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
