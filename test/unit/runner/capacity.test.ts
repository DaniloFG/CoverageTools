import { expect, test } from 'vitest';
import { MEMORY_PER_RUN, MIN_FREE_MEMORY, ParallelGovernor, parallelLimit, readMachine, type Machine } from '../../../src/runner/capacity';
import type { RunSettings } from '../../../src/settings';

const GIB = 1024 ** 3;
const machine = (cores: number, freeGib: number | undefined, totalGib = 16): Machine => ({
  cores, totalMemory: totalGib * GIB, freeMemory: freeGib === undefined ? undefined : freeGib * GIB,
});

test('the automatic limit is half the cores, at most 4, so the editor keeps the other half', () => {
  expect(parallelLimit(machine(4, 12), 0)).toBe(2);
  expect(parallelLimit(machine(8, 12), 0)).toBe(4);
  expect(parallelLimit(machine(32, 64, 128), 0)).toBe(4);
  expect(parallelLimit(machine(6, 12), 0)).toBe(3);
});

test('a machine with one or two cores runs one project at a time', () => {
  expect(parallelLimit(machine(1, 12), 0)).toBe(1);
  expect(parallelLimit(machine(2, 12), 0)).toBe(1);
  expect(parallelLimit(machine(0, 12), 0)).toBe(1);
});

test('the limit never exceeds what the free memory holds, one memory budget per run', () => {
  expect(MEMORY_PER_RUN).toBe(1.5 * GIB);
  expect(parallelLimit(machine(8, 3.2), 0)).toBe(2);
  expect(parallelLimit(machine(8, 2.9), 0)).toBe(1);
  expect(parallelLimit(machine(8, 0.3), 0)).toBe(1);
});

test('a configured maximum replaces the core rule but not the memory rule', () => {
  expect(parallelLimit(machine(4, 32, 64), 6)).toBe(6);
  expect(parallelLimit(machine(16, 32, 64), 2)).toBe(2);
  expect(parallelLimit(machine(16, 3.2), 6)).toBe(2);
  expect(parallelLimit(machine(2, 32, 64), 1)).toBe(1);
});

test('where free memory cannot be read, half of the installed memory is assumed free', () => {
  expect(parallelLimit(machine(8, undefined, 8), 0)).toBe(2);
  expect(parallelLimit(machine(8, undefined, 4), 0)).toBe(1);
});

test('readMachine reads cores and memory, and trusts no free-memory figure on macOS', () => {
  const os = { availableParallelism: () => 6, cpus: () => new Array(12), totalmem: () => 16 * GIB, freemem: () => 5 * GIB };
  expect(readMachine(os, 'linux')).toEqual({ cores: 6, totalMemory: 16 * GIB, freeMemory: 5 * GIB });
  expect(readMachine(os, 'win32').freeMemory).toBe(5 * GIB);
  // macOS counts only untouched pages as free, far less than what a process can get.
  expect(readMachine(os, 'darwin').freeMemory).toBeUndefined();
  expect(readMachine({ cpus: () => new Array(12), totalmem: os.totalmem, freemem: os.freemem }, 'linux').cores).toBe(12);
});

function governor(settings: RunSettings, machines: Machine[]) {
  const log: string[] = [];
  let i = 0;
  const g = new ParallelGovernor({
    settings: () => settings,
    machine: () => machines[Math.min(i++, machines.length - 1)],
    log: m => log.push(m),
  });
  return { g, log };
}

test('in sequential mode no second run is admitted, and the machine is not even read', () => {
  let reads = 0;
  const g = new ParallelGovernor({ settings: () => ({ mode: 'sequential', maxParallel: 0 }), machine: () => (reads++, machine(16, 32)), log: () => undefined });
  g.begin();
  expect(g.more(1)).toBe(false);
  expect(reads).toBe(0);
});

test('in parallel mode runs are admitted up to the limit measured when the queue left idle', () => {
  const { g, log } = governor({ mode: 'parallel', maxParallel: 0 }, [machine(8, 5)]);
  g.begin();
  expect(g.more(1)).toBe(true);
  expect(g.more(2)).toBe(true);
  expect(g.more(3)).toBe(false);
  expect(log).toEqual(['Parallel runs: up to 3 at a time on this machine (8 cores, 5.0 GB of memory free).']);
});

test('no further run is admitted while less than the minimum of memory is free', () => {
  expect(MIN_FREE_MEMORY).toBe(GIB);
  const { g } = governor({ mode: 'parallel', maxParallel: 0 }, [machine(8, 12), machine(8, 0.8), machine(8, 4)]);
  g.begin();
  expect(g.more(1)).toBe(true);
  expect(g.more(2)).toBe(false);
  expect(g.more(2)).toBe(true);
});

test('on a machine with room for one run, parallel mode says so once and runs in sequence', () => {
  const { g, log } = governor({ mode: 'parallel', maxParallel: 0 }, [machine(2, 1.2, 4)]);
  g.begin();
  expect(g.more(1)).toBe(false);
  expect(g.more(1)).toBe(false);
  expect(log).toEqual(['Parallel runs are on, but this machine has room for one run at a time (2 cores, 1.2 GB of memory free): running in sequence.']);
});

test('the limit is measured again each time the queue leaves idle', () => {
  const { g, log } = governor({ mode: 'parallel', maxParallel: 0 }, [machine(8, 12), machine(8, 2)]);
  g.begin();
  expect(g.more(1)).toBe(true);
  g.begin();
  expect(g.more(1)).toBe(false);
  expect(log).toHaveLength(2);
});
