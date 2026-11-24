import { expect, test } from 'vitest';
import { RunQueue } from '../../../src/runner/queue';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}

const tick = () => new Promise(r => setTimeout(r, 0));

test('jobs run one at a time, in order', async () => {
  const q = new RunQueue();
  const log: string[] = [];
  const gates = [deferred(), deferred(), deferred()];
  const results = gates.map((gate, i) => q.enqueue(async () => {
    log.push(`start ${i}`);
    await gate.promise;
    log.push(`end ${i}`);
    return i * 10;
  }));
  await tick();
  expect(log).toEqual(['start 0']);
  gates[1].resolve();
  await tick();
  expect(log).toEqual(['start 0']);
  gates[0].resolve();
  await tick();
  expect(log).toEqual(['start 0', 'end 0', 'start 1', 'end 1', 'start 2']);
  gates[2].resolve();
  expect(await Promise.all(results)).toEqual([0, 10, 20]);
});

test('a failing job rejects its own promise and the next job still runs', async () => {
  const q = new RunQueue();
  const a = q.enqueue(async () => { throw new Error('boom'); });
  const b = q.enqueue(async () => 'b');
  await expect(a).rejects.toThrow('boom');
  expect(await b).toBe('b');
  expect(q.busy).toBe(false);
});

test('busy toggles true while a job runs and false when the queue drains', async () => {
  const q = new RunQueue();
  const changes: boolean[] = [];
  const sub = q.onDidChangeBusy(b => changes.push(b));
  expect(q.busy).toBe(false);
  const gate = deferred();
  const a = q.enqueue(() => gate.promise);
  const b = q.enqueue(async () => undefined);
  expect(q.busy).toBe(true);
  gate.resolve();
  await Promise.all([a, b]);
  await tick();
  expect(q.busy).toBe(false);
  expect(changes).toEqual([true, false]);

  sub.dispose();
  await q.enqueue(async () => undefined);
  expect(changes).toEqual([true, false]);
});

test('cancelAll aborts the running job and drops queued ones, which resolve as cancelled', async () => {
  const q = new RunQueue();
  const started: number[] = [];
  const job = (i: number) => (signal: AbortSignal) => {
    if (signal.aborted) return Promise.resolve(`cancelled ${i}`);
    started.push(i);
    return new Promise<string>(resolve => signal.addEventListener('abort', () => resolve(`cancelled ${i}`)));
  };
  const a = q.enqueue(job(0));
  const b = q.enqueue(job(1));
  const c = q.enqueue(job(2));
  await tick();
  expect(started).toEqual([0]);
  q.cancelAll();
  expect(await Promise.all([a, b, c])).toEqual(['cancelled 0', 'cancelled 1', 'cancelled 2']);
  expect(started).toEqual([0]);
  await tick();
  expect(q.busy).toBe(false);

  // The queue keeps working after a cancel, with a fresh signal.
  expect(await q.enqueue(async signal => signal.aborted)).toBe(false);
});
