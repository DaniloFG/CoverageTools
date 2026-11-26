import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { customAdapter, customProject } from '../../src/adapters/custom';
import { runBatch } from '../../src/runner/batch';
import { ParallelGovernor, type Machine } from '../../src/runner/capacity';
import { RunQueue } from '../../src/runner/queue';
import { runProject } from '../../src/runner/runProject';
import type { RunSettings } from '../../src/settings';
import { createRealDeps, linesOf, type RealDeps } from './helpers';

const NAMES = ['a', 'b', 'c'];
/** How long each fake test run takes: long enough for overlapping runs to be seen as such. */
const RUN_MS = 1_200;
const GIB = 1024 ** 3;

/** A "test tool": logs when it starts and ends, takes RUN_MS, and writes an LCOV report covering src.js. */
const TOOL = `
const fs = require('node:fs');
const path = require('node:path');
const [dir, log, name] = process.argv.slice(2);
fs.appendFileSync(log, 'start ' + name + '\\n');
setTimeout(() => {
  fs.writeFileSync(path.join(dir, 'lcov.info'), 'SF:src.js\\nDA:1,1\\nDA:2,0\\nLF:2\\nLH:1\\nend_of_record\\n');
  fs.appendFileSync(log, 'end ' + name + '\\n');
}, ${RUN_MS});
`;

let root: string;
let real: RealDeps;

beforeAll(async () => {
  root = await mkdtemp(path.join(await realpath(os.tmpdir()), 'coverage-tools-parallel-'));
  for (const name of NAMES) {
    await mkdir(path.join(root, name));
    await writeFile(path.join(root, name, 'src.js'), 'exports.one = 1;\nexports.two = 2;\n');
    await writeFile(path.join(root, name, 'tool.js'), TOOL);
  }
  real = createRealDeps([root], {}, [customAdapter]);
});

afterAll(async () => {
  await real.dispose();
  await rm(root, { recursive: true, force: true });
});

/** Runs the three projects through a queue governed as the extension's is, and returns the order of their starts and ends. */
async function runAll(settings: RunSettings, machine: Machine): Promise<string[]> {
  const log = path.join(root, `${settings.mode}-${machine.cores}.log`);
  const queue = new RunQueue(new ParallelGovernor({ settings: () => settings, machine: () => machine, log: () => undefined }));
  const items = NAMES.map(name => ({
    project: customProject(path.join(root, name), `node tool.js "\${coverageDir}" "${log}" ${name}`, root),
    target: { kind: 'full' as const },
  }));
  real.store.clear();
  const results = await runBatch(items, { queue, run: (item, signal) => runProject(item.project, item.target, real.deps, signal) });
  expect(results.map(r => r.outcome.status)).toEqual(['ok', 'ok', 'ok']);
  // Every project's report was loaded, whatever order the runs ended in.
  for (const name of NAMES) expect(linesOf(real.store, path.join(root, name, 'src.js'))).toEqual([[1, 1], [2, 0]]);
  return (await readFile(log, 'utf8')).trim().split('\n');
}

const machine = (cores: number, freeGib: number): Machine => ({ cores, totalMemory: 16 * GIB, freeMemory: freeGib * GIB });

test('sequential mode runs real processes strictly one after another', async () => {
  expect(await runAll({ mode: 'sequential', maxParallel: 0 }, machine(8, 12))).toEqual(['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
});

test('parallel mode on a machine with room for two overlaps two runs and holds the third back', async () => {
  const events = await runAll({ mode: 'parallel', maxParallel: 0 }, machine(4, 12));
  expect(events.slice(0, 2).sort()).toEqual(['start a', 'start b']);
  expect(events.indexOf('start c')).toBeGreaterThan(Math.min(events.indexOf('end a'), events.indexOf('end b')));
  expect(events).toHaveLength(6);
});

test('parallel mode on a machine without room runs in sequence', async () => {
  expect(await runAll({ mode: 'parallel', maxParallel: 0 }, machine(2, 12))).toEqual(['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
  expect(await runAll({ mode: 'parallel', maxParallel: 4 }, machine(8, 2))).toEqual(['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
});
