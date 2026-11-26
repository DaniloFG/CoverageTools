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

/** Jobs that stay running until the test settles them, logging their start. */
function gated(q: RunQueue, started: string[]) {
  const gates = new Map<string, () => void>();
  const add = (name: string, exclusive?: string): Promise<string> => q.enqueue(async () => {
    started.push(name);
    await new Promise<void>(resolve => gates.set(name, resolve));
    return name;
  }, exclusive);
  return { add, finish: (name: string) => gates.get(name)?.() };
}

test('with an admission that allows it, jobs run at once up to what it admits, and the next starts as one ends', async () => {
  const asked: number[] = [];
  const q = new RunQueue({ more: running => (asked.push(running), running < 2) });
  const started: string[] = [];
  const jobs = gated(q, started);
  const all = ['a', 'b', 'c', 'd'].map(n => jobs.add(n));
  await tick();
  expect(started).toEqual(['a', 'b']);
  jobs.finish('a');
  await tick();
  expect(started).toEqual(['a', 'b', 'c']);
  jobs.finish('b');
  jobs.finish('c');
  await tick();
  expect(started).toEqual(['a', 'b', 'c', 'd']);
  expect(q.busy).toBe(true);
  jobs.finish('d');
  expect(await Promise.all(all)).toEqual(['a', 'b', 'c', 'd']);
  await tick();
  expect(q.busy).toBe(false);
  // Never asked whether the first job may start: a job always runs when nothing else does.
  expect(asked.every(n => n >= 1)).toBe(true);
});

test('begin is told each time the queue leaves idle, before its first job starts', async () => {
  const log: string[] = [];
  const q = new RunQueue({ begin: () => log.push('begin'), more: () => true });
  await Promise.all([q.enqueue(async () => log.push('a')), q.enqueue(async () => log.push('b'))]);
  await tick();
  await q.enqueue(async () => log.push('c'));
  expect(log).toEqual(['begin', 'a', 'b', 'begin', 'c']);
});

test('jobs with the same exclusive key never run at once; a later job with another key starts meanwhile', async () => {
  const q = new RunQueue({ more: () => true });
  const started: string[] = [];
  const jobs = gated(q, started);
  const all = [jobs.add('net1', 'dotnet'), jobs.add('net2', 'dotnet'), jobs.add('web', '/w/web'), jobs.add('free')];
  await tick();
  expect(started).toEqual(['net1', 'web', 'free']);
  jobs.finish('web');
  await tick();
  expect(started).toEqual(['net1', 'web', 'free']);
  jobs.finish('net1');
  await tick();
  expect(started).toEqual(['net1', 'web', 'free', 'net2']);
  jobs.finish('net2');
  jobs.finish('free');
  await Promise.all(all);
});

test('an admission that throws or refuses keeps the queue running one job at a time', async () => {
  const q = new RunQueue({ begin: () => { throw new Error('begin'); }, more: () => { throw new Error('more'); } });
  const started: string[] = [];
  const jobs = gated(q, started);
  const all = [jobs.add('a'), jobs.add('b')];
  await tick();
  expect(started).toEqual(['a']);
  jobs.finish('a');
  await tick();
  expect(started).toEqual(['a', 'b']);
  jobs.finish('b');
  await Promise.all(all);
});

test('cancelAll aborts every running job and drops the queued ones', async () => {
  const q = new RunQueue({ more: running => running < 2 });
  const started: number[] = [];
  const job = (i: number) => (signal: AbortSignal) => {
    if (signal.aborted) return Promise.resolve(`cancelled ${i}`);
    started.push(i);
    return new Promise<string>(resolve => signal.addEventListener('abort', () => resolve(`cancelled ${i}`)));
  };
  const all = [q.enqueue(job(0)), q.enqueue(job(1)), q.enqueue(job(2))];
  await tick();
  expect(started).toEqual([0, 1]);
  q.cancelAll();
  expect(await Promise.all(all)).toEqual(['cancelled 0', 'cancelled 1', 'cancelled 2']);
  expect(started).toEqual([0, 1]);
  await tick();
  expect(q.busy).toBe(false);
});
