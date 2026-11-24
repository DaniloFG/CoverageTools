import { expect, test } from 'vitest';
import { ReportBatcher } from '../../../src/watcher/batcher';

type Result = 'ok' | 'retry' | 'drop';

/** Manual timers: `advance` runs due callbacks in order and lets the promises they start settle. */
function fakeTimers() {
  let now = 0;
  let nextId = 1;
  const due = new Map<number, { at: number; fn: () => void }>();
  const settle = () => new Promise<void>(r => setImmediate(r));
  return {
    set(fn: () => void, ms: number): unknown {
      const id = nextId++;
      due.set(id, { at: now + ms, fn });
      return id;
    },
    clear(h: unknown): void {
      due.delete(h as number);
    },
    get pending(): number {
      return due.size;
    },
    async advance(ms: number): Promise<void> {
      const target = now + ms;
      for (;;) {
        let first: [number, { at: number; fn: () => void }] | undefined;
        for (const entry of due) if (entry[1].at <= target && (!first || entry[1].at < first[1].at)) first = entry;
        if (!first) break;
        due.delete(first[0]);
        now = first[1].at;
        first[1].fn();
        await settle();
      }
      now = target;
      await settle();
    },
  };
}

function setup(opts: { result?: () => Result | Promise<Result>; suppressed?: (group: string) => boolean } = {}) {
  const timers = fakeTimers();
  const calls: Array<[string, string]> = [];
  const batcher = new ReportBatcher({
    debounceMs: 750,
    retryMs: 1000,
    groupOf: path => path.slice(0, path.indexOf('/', 1)),
    isSuppressed: opts.suppressed ?? (() => false),
    ingest: async (group, reportPath) => {
      calls.push([group, reportPath]);
      return (opts.result ?? (() => 'ok'))();
    },
    timers,
  });
  return { timers, calls, batcher };
}

test('events for one group within 750 ms are ingested once', async () => {
  const { timers, calls, batcher } = setup();
  batcher.push('/a/coverage/lcov.info');
  await timers.advance(500);
  batcher.push('/a/coverage/lcov.info');
  await timers.advance(749);
  expect(calls).toEqual([]);
  await timers.advance(1);
  expect(calls).toEqual([['/a', '/a/coverage/lcov.info']]);
  await timers.advance(5000);
  expect(calls).toHaveLength(1);
});

test('groups are debounced independently', async () => {
  const { timers, calls, batcher } = setup();
  batcher.push('/a/coverage/lcov.info');
  await timers.advance(400);
  batcher.push('/b/coverage/lcov.info');
  await timers.advance(350);
  expect(calls).toEqual([['/a', '/a/coverage/lcov.info']]);
  await timers.advance(400);
  expect(calls).toEqual([['/a', '/a/coverage/lcov.info'], ['/b', '/b/coverage/lcov.info']]);
});

test('when several formats arrive together, the highest priority one is ingested', async () => {
  const { timers, calls, batcher } = setup();
  batcher.push('/a/coverage/lcov.info');
  batcher.push('/a/coverage/coverage-final.json');
  batcher.push('/a/coverage/cobertura-coverage.xml');
  await timers.advance(750);
  expect(calls).toEqual([['/a', '/a/coverage/coverage-final.json']]);
});

test('among same-format reports, the most recently pushed wins', async () => {
  const { timers, calls, batcher } = setup();
  batcher.push('/a/TestResults/g1/coverage.cobertura.xml');
  batcher.push('/a/TestResults/g2/coverage.cobertura.xml');
  await timers.advance(750);
  batcher.push('/a/TestResults/g2/coverage.cobertura.xml');
  batcher.push('/a/TestResults/g1/coverage.cobertura.xml');
  await timers.advance(750);
  expect(calls.map(c => c[1])).toEqual(['/a/TestResults/g2/coverage.cobertura.xml', '/a/TestResults/g1/coverage.cobertura.xml']);
});

test('events for a suppressed group are discarded', async () => {
  const { timers, calls, batcher } = setup({ suppressed: group => group === '/a' });
  batcher.push('/a/coverage/lcov.info');
  expect(timers.pending).toBe(0);
  batcher.push('/b/coverage/lcov.info');
  await timers.advance(750);
  expect(calls).toEqual([['/b', '/b/coverage/lcov.info']]);
});

test('a group suppressed while its events wait is not ingested', async () => {
  let suppressed = false;
  const { timers, calls, batcher } = setup({ suppressed: () => suppressed });
  batcher.push('/a/coverage/lcov.info');
  suppressed = true;
  await timers.advance(750);
  expect(calls).toEqual([]);
  expect(timers.pending).toBe(0);
});

test('a "retry" result re-ingests once after 1000 ms and then gives up', async () => {
  const { timers, calls, batcher } = setup({ result: () => 'retry' });
  batcher.push('/a/coverage/coverage-final.json');
  await timers.advance(750);
  expect(calls).toHaveLength(1);
  await timers.advance(999);
  expect(calls).toHaveLength(1);
  await timers.advance(1);
  expect(calls).toEqual([['/a', '/a/coverage/coverage-final.json'], ['/a', '/a/coverage/coverage-final.json']]);
  await timers.advance(10_000);
  expect(calls).toHaveLength(2);
  expect(timers.pending).toBe(0);
});

test('a new event for the group replaces a pending retry', async () => {
  const results: Result[] = ['retry', 'ok'];
  const { timers, calls, batcher } = setup({ result: () => results.shift() ?? 'ok' });
  batcher.push('/a/coverage/coverage-final.json');
  await timers.advance(750);
  batcher.push('/a/coverage/coverage-final.json');
  await timers.advance(750);
  expect(calls).toHaveLength(2);
  await timers.advance(10_000);
  expect(calls).toHaveLength(2);
  expect(timers.pending).toBe(0);
});

test('ingestions of one group never overlap; a flush during one waits for it', async () => {
  let release!: () => void;
  let active = 0;
  let maxActive = 0;
  const { timers, calls, batcher } = setup({
    result: async (): Promise<Result> => {
      active++;
      maxActive = Math.max(maxActive, active);
      if (calls.length === 1) await new Promise<void>(r => { release = r; });
      active--;
      return 'ok';
    },
  });
  batcher.push('/a/coverage/lcov.info');
  await timers.advance(750);
  batcher.push('/a/coverage/coverage-final.json');
  await timers.advance(750);
  expect(calls).toHaveLength(1);
  release();
  await timers.advance(0);
  expect(calls.map(c => c[1])).toEqual(['/a/coverage/lcov.info', '/a/coverage/coverage-final.json']);
  expect(maxActive).toBe(1);
});

test('no timer is left pending after the last flush', async () => {
  const { timers, batcher } = setup();
  batcher.push('/a/coverage/lcov.info');
  batcher.push('/b/coverage/lcov.info');
  expect(timers.pending).toBe(2);
  await timers.advance(750);
  expect(timers.pending).toBe(0);
});

test('an ingest that throws is treated as dropped', async () => {
  const { timers, calls, batcher } = setup({ result: () => { throw new Error('boom'); } });
  batcher.push('/a/coverage/lcov.info');
  await timers.advance(5000);
  expect(calls).toHaveLength(1);
  expect(timers.pending).toBe(0);
});

test('dispose cancels pending work and ignores later events', async () => {
  const { timers, calls, batcher } = setup();
  batcher.push('/a/coverage/lcov.info');
  batcher.dispose();
  expect(timers.pending).toBe(0);
  batcher.push('/a/coverage/lcov.info');
  await timers.advance(5000);
  expect(calls).toEqual([]);
});
