import { expect, test } from 'vitest';
import type { Project, RunTarget } from '../../../src/adapters/types';
import {
  batchNotices, failureDetails, InFlight, lineLogger, loggedRun, outcomeNotice, progressMessage, runBatch, type RunItem,
} from '../../../src/runner/batch';
import { RunQueue } from '../../../src/runner/queue';
import type { RunOutcome } from '../../../src/runner/runProject';

function project(name: string): Project {
  return {
    key: `project:/w/${name}`, adapter: 'jest', ecosystem: 'node', dir: `/w/${name}`, name,
    supportsPartial: true, meta: {},
  };
}
const full: RunTarget = { kind: 'full' };
const item = (name: string): RunItem => ({ project: project(name), target: full });

/** A fake runProject: each call waits until the test settles it; an aborted signal returns `cancelled` at once. */
function fakeRunner() {
  const calls: Array<{ name: string; signal: AbortSignal; settle(o: RunOutcome): void }> = [];
  const run = (it: RunItem, signal: AbortSignal): Promise<RunOutcome> => {
    if (signal.aborted) return Promise.resolve({ status: 'cancelled' });
    return new Promise(resolve => {
      const call = { name: it.project.name, signal, settle: resolve };
      calls.push(call);
      signal.addEventListener('abort', () => resolve({ status: 'cancelled' }));
    });
  };
  return { calls, run };
}

const tick = () => new Promise(r => setImmediate(r));

test('runBatch runs every item one at a time, in order, reporting n/N as each starts', async () => {
  const queue = new RunQueue();
  const runner = fakeRunner();
  const started: string[] = [];
  const done = runBatch([item('a'), item('b'), item('c')], {
    queue, run: runner.run, onStart: (it, n, total) => started.push(progressMessage(it.project.name, n, total)),
  });
  await tick();
  expect(runner.calls.map(c => c.name)).toEqual(['a']);
  expect(started).toEqual(['Running coverage: a (1/3)']);
  runner.calls[0].settle({ status: 'ok' });
  await tick();
  expect(runner.calls.map(c => c.name)).toEqual(['a', 'b']);
  runner.calls[1].settle({ status: 'tests-failed', message: 'A step exited with code 1' });
  await tick();
  runner.calls[2].settle({ status: 'no-report', hint: 'Install it.' });
  const results = await done;
  expect(results.map(r => [r.item.project.name, r.outcome.status])).toEqual([['a', 'ok'], ['b', 'tests-failed'], ['c', 'no-report']]);
  expect(started).toEqual(['Running coverage: a (1/3)', 'Running coverage: b (2/3)', 'Running coverage: c (3/3)']);
  expect(queue.busy).toBe(false);
});

test('cancelling the queue stops the running item and cancels the queued ones without starting them', async () => {
  const queue = new RunQueue();
  const runner = fakeRunner();
  const started: string[] = [];
  const done = runBatch([item('a'), item('b'), item('c')], { queue, run: runner.run, onStart: it => started.push(it.project.name) });
  await tick();
  queue.cancelAll();
  const results = await done;
  expect(results.map(r => r.outcome.status)).toEqual(['cancelled', 'cancelled', 'cancelled']);
  expect(runner.calls.map(c => c.name)).toEqual(['a']);
  expect(runner.calls[0].signal.aborted).toBe(true);
  expect(started).toEqual(['a']);
  expect(queue.busy).toBe(false);
});

test('two overlapping batches share the queue: never two runs at once, the second waits for the first', async () => {
  const queue = new RunQueue();
  let running = 0;
  let maxRunning = 0;
  const order: string[] = [];
  const run = async (it: RunItem): Promise<RunOutcome> => {
    running++;
    maxRunning = Math.max(maxRunning, running);
    order.push(it.project.name);
    await tick();
    running--;
    return { status: 'ok' };
  };
  const first = runBatch([item('a'), item('b')], { queue, run });
  const second = runBatch([item('a'), item('b')], { queue, run });
  await Promise.all([first, second]);
  expect(maxRunning).toBe(1);
  expect(order).toEqual(['a', 'b', 'a', 'b']);
});

test('a run that throws counts as a spawn error of that item only', async () => {
  const queue = new RunQueue();
  const results = await runBatch([item('a'), item('b')], {
    queue,
    run: async it => {
      if (it.project.name === 'a') throw new Error('boom');
      return { status: 'ok' };
    },
  });
  expect(results.map(r => r.outcome)).toEqual([{ status: 'spawn-error', message: 'boom' }, { status: 'ok' }]);
});

test('each outcome maps to its message', () => {
  expect(outcomeNotice('web', { status: 'ok' })).toBeUndefined();
  expect(outcomeNotice('web', { status: 'cancelled' })).toBeUndefined();
  expect(outcomeNotice('web', { status: 'tests-failed', message: 'A step exited with code 1' })).toEqual({
    severity: 'warning', text: 'Tests failed in web; coverage was still loaded.', showOutput: false,
  });
  expect(outcomeNotice('web', { status: 'no-report', hint: 'Install @vitest/coverage-v8.' })).toEqual({
    severity: 'error', text: 'Coverage failed for web: Install @vitest/coverage-v8.', showOutput: true,
  });
  expect(outcomeNotice('web', { status: 'bad-report', message: '/t/lcov.info: bad' })).toEqual({
    severity: 'error', text: 'Coverage failed for web: /t/lcov.info: bad', showOutput: true,
  });
  expect(outcomeNotice('web', { status: 'spawn-error', message: 'Could not start yarn: ENOENT', hint: 'Install yarn.' })).toEqual({
    severity: 'error', text: 'Coverage failed for web: Could not start yarn: ENOENT Install yarn.', showOutput: true,
  });
  expect(outcomeNotice('web', { status: 'no-report' })?.text).toBe('Coverage failed for web: no coverage report was found.');
});

test('the details of a failure name the project, the status, the message and the hint', () => {
  expect(failureDetails('web', { status: 'spawn-error', message: 'Could not start yarn: ENOENT', hint: 'Install yarn.' }))
    .toBe('Coverage failed for web (spawn-error): Could not start yarn: ENOENT Install yarn.');
  expect(failureDetails('web', { status: 'ok' })).toBeUndefined();
  expect(failureDetails('web', { status: 'cancelled' })).toBeUndefined();
  expect(failureDetails('web', { status: 'tests-failed', message: 'A step exited with code 1' }))
    .toBe('Tests failed in web (tests-failed): A step exited with code 1');
});

test('a single run shows its own message; several runs show at most one warning and one summary error', () => {
  const r = (name: string, outcome: RunOutcome) => ({ item: item(name), outcome });
  expect(batchNotices([r('a', { status: 'no-report', hint: 'Install it.' })])).toEqual([
    { severity: 'error', text: 'Coverage failed for a: Install it.', showOutput: true },
  ]);
  expect(batchNotices([r('a', { status: 'ok' }), r('b', { status: 'ok' })])).toEqual([]);
  expect(batchNotices([
    r('a', { status: 'tests-failed' }),
    r('b', { status: 'no-report', hint: 'x' }),
    r('c', { status: 'tests-failed' }),
    r('d', { status: 'spawn-error', message: 'y' }),
    r('e', { status: 'cancelled' }),
    r('f', { status: 'ok' }),
  ])).toEqual([
    { severity: 'warning', text: 'Tests failed in a, c; coverage was still loaded.', showOutput: false },
    { severity: 'error', text: 'Coverage failed for 2 project(s): b, d. See the output for details.', showOutput: true },
  ]);
});

/** What a command does with the shared InFlight: claim, then run what is new. */
function request(queue: RunQueue, inFlight: InFlight, run: (it: RunItem, signal: AbortSignal) => Promise<RunOutcome>, items: RunItem[]) {
  return runBatch(inFlight.claim(items), { queue, run, inFlight });
}

test('two Run All requests in a row run each project once', async () => {
  const queue = new RunQueue();
  const inFlight = new InFlight();
  const ran: string[] = [];
  const run = async (it: RunItem): Promise<RunOutcome> => {
    ran.push(it.project.name);
    await tick();
    return { status: 'ok' };
  };
  const first = request(queue, inFlight, run, [item('a'), item('b')]);
  const second = request(queue, inFlight, run, [item('a'), item('b')]);
  expect(await second).toEqual([]);
  await first;
  expect(ran).toEqual(['a', 'b']);
  // Once they have finished, the same request runs them again.
  await request(queue, inFlight, run, [item('a')]);
  expect(ran).toEqual(['a', 'b', 'a']);
});

test('Run Coverage Here on a project Run All queued is not added again; another target of it is', async () => {
  const queue = new RunQueue();
  const inFlight = new InFlight();
  const runner = fakeRunner();
  const all = request(queue, inFlight, runner.run, [item('a'), item('b')]);
  const partial = (paths: string[]): RunItem => ({ project: project('b'), target: { kind: 'partial', paths } });
  expect(inFlight.claim([item('b')])).toEqual([]);
  expect(inFlight.claim([partial(['/w/b/x.test.js']), partial(['/w/b/x.test.js'])])).toEqual([partial(['/w/b/x.test.js'])]);
  expect(inFlight.claim([partial(['/w/b/y.test.js'])])).toHaveLength(1);
  queue.cancelAll();
  await all;
  // The full runs were released when they settled; the claimed partial ones were never queued here.
  expect(inFlight.claim([item('a'), item('b')])).toHaveLength(2);
});

test('loggedRun logs the start, the output line by line and the end', async () => {
  const logs: string[] = [];
  const outcome = await loggedRun(item('web'), new AbortController().signal, m => logs.push(m), async output => {
    output('one\ntw');
    output('o\r\nthree');
    return { status: 'tests-failed' };
  });
  expect(outcome).toEqual({ status: 'tests-failed' });
  expect(logs).toEqual(['Running coverage for web (all tests).', 'one', 'two', 'three', 'Finished coverage for web: tests-failed.']);
});

test('loggedRun still flushes the output and writes the end line when the run throws', async () => {
  const logs: string[] = [];
  const outcome = await loggedRun(
    { project: project('web'), target: { kind: 'partial', paths: ['/w/web/a.test.js'] } }, new AbortController().signal, m => logs.push(m),
    async output => {
      output('partial line');
      throw new Error('boom');
    },
  );
  expect(outcome).toEqual({ status: 'spawn-error', message: 'Unexpected error: boom' });
  expect(logs).toEqual(['Running coverage for web (/w/web/a.test.js).', 'partial line', 'Finished coverage for web: spawn-error.']);
});

test('loggedRun of a run cancelled before it started only logs its end', async () => {
  const logs: string[] = [];
  const aborted = new AbortController();
  aborted.abort();
  await loggedRun(item('web'), aborted.signal, m => logs.push(m), async () => ({ status: 'cancelled' }));
  expect(logs).toEqual(['Finished coverage for web: cancelled.']);
});

test('lineLogger keeps an unfinished line until flush', () => {
  const logs: string[] = [];
  const l = lineLogger(m => logs.push(m));
  l.write('a\nb');
  expect(logs).toEqual(['a']);
  l.flush();
  l.flush();
  expect(logs).toEqual(['a', 'b']);
});
