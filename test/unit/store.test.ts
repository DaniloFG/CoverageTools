import { expect, test } from 'vitest';
import { CoverageStore } from '../../src/store';
import { file, lines } from './helpers';

test('replace swaps one project and leaves the others untouched', () => {
  const s = new CoverageStore();
  s.replace('p1', [file('/w/a.ts', [[1, 1]])]);
  s.replace('p2', [file('/w/b.ts', [[1, 0]])]);
  s.replace('p1', [file('/w/c.ts', [[1, 1]])]);
  expect(s.merged().map(e => e.path)).toEqual(['/w/b.ts', '/w/c.ts']);
});

test('union adds to a project without dropping what was covered', () => {
  const s = new CoverageStore();
  s.replace('p1', [file('/w/a.ts', [[1, 1], [2, 0]])]);
  s.union('p1', [file('/w/a.ts', [[2, 1]])]);
  expect(s.merged()[0].summary.statements).toEqual({ covered: 2, total: 2 });
});

test('a file covered by two projects shows the union and lists both parts', () => {
  const s = new CoverageStore();
  s.replace('p1', [file('/w/a.ts', [[1, 1], [2, 0]])]);
  s.replace('p2', [file('/w/a.ts', [[2, 3], [3, 0]])]);
  const merged = s.merged();
  expect(merged).toHaveLength(1);
  expect(merged[0].path).toBe('/w/a.ts');
  expect(merged[0].parts.length).toBe(2);
  expect(merged[0].parts.map(lines)).toEqual([[[1, 1], [2, 0]], [[2, 3], [3, 0]]]);
  expect(merged[0].summary.statements).toEqual({ covered: 2, total: 3 });
});

test('replace with an empty list empties the project', () => {
  const s = new CoverageStore();
  s.replace('p1', [file('/w/a.ts', [[1, 1]])]);
  s.replace('p1', []);
  expect(s.merged()).toEqual([]);
  expect(s.keys()).toContain('p1');
});

test('totals sums statements across merged files', () => {
  const s = new CoverageStore();
  s.replace('p1', [file('/w/a.ts', [[1, 1], [2, 0]])]);
  s.replace('p2', [file('/w/b.ts', [[1, 1], [2, 1], [3, 0]])]);
  expect(s.totals()).toEqual({ covered: 3, total: 5 });
});

test('clear(key) removes one project; clear() removes all', () => {
  const s = new CoverageStore();
  s.replace('p1', [file('/w/a.ts', [[1, 1]])]);
  s.replace('p2', [file('/w/b.ts', [[1, 0]])]);
  s.clear('p1');
  expect(s.keys()).toEqual(['p2']);
  expect(s.merged().map(e => e.path)).toEqual(['/w/b.ts']);
  s.clear();
  expect(s.keys()).toEqual([]);
  expect(s.merged()).toEqual([]);
  expect(s.totals()).toEqual({ covered: 0, total: 0 });
});

test('onDidChange fires once per mutation and not when nothing changed', () => {
  const s = new CoverageStore();
  let fired = 0;
  const sub = s.onDidChange(() => fired++);
  s.clear();
  s.clear('missing');
  expect(fired).toBe(0);
  s.replace('p1', [file('/w/a.ts', [[1, 1]])]);
  expect(fired).toBe(1);
  s.union('p1', [file('/w/a.ts', [[2, 1]])]);
  expect(fired).toBe(2);
  s.union('p1', []);
  expect(fired).toBe(2);
  s.clear('p1');
  expect(fired).toBe(3);
  s.replace('p2', [file('/w/b.ts', [[1, 1]])]);
  s.clear();
  expect(fired).toBe(5);
  s.clear();
  expect(fired).toBe(5);
  sub.dispose();
  s.replace('p3', [file('/w/c.ts', [[1, 1]])]);
  expect(fired).toBe(5);
});

test('merged() returns the same array until the next mutation', () => {
  const s = new CoverageStore();
  s.replace('p1', [file('/w/a.ts', [[1, 1]])]);
  const first = s.merged();
  expect(s.merged()).toBe(first);
  s.clear('missing');
  expect(s.merged()).toBe(first);
  s.union('p1', [file('/w/b.ts', [[1, 0]])]);
  const second = s.merged();
  expect(second).not.toBe(first);
  expect(second.map(e => e.path)).toEqual(['/w/a.ts', '/w/b.ts']);
});

test('a throwing listener neither stops the others nor escapes the mutation', () => {
  const s = new CoverageStore();
  let fired = 0;
  s.onDidChange(() => { throw new Error('listener failure'); });
  s.onDidChange(() => fired++);
  expect(() => s.replace('p1', [file('/w/a.ts', [[1, 1]])])).not.toThrow();
  expect(() => s.union('p1', [file('/w/a.ts', [[2, 1]])])).not.toThrow();
  expect(() => s.clear()).not.toThrow();
  expect(fired).toBe(3);
});

test('totalsOf gives the statement totals of one project, or undefined for an unknown key', () => {
  const s = new CoverageStore();
  s.replace('p1', [file('/w/a.ts', [[1, 1], [2, 0]]), file('/w/b.ts', [[1, 1]])]);
  s.replace('p2', [file('/w/a.ts', [[2, 1]])]);
  expect(s.totalsOf('p1')).toEqual({ covered: 2, total: 3 });
  expect(s.totalsOf('p2')).toEqual({ covered: 1, total: 1 });
  expect(s.totalsOf('nope')).toBeUndefined();
  s.union('p2', [file('/w/c.ts', [[1, 0]])]);
  expect(s.totalsOf('p2')).toEqual({ covered: 1, total: 2 });
});

test('unionInSlices gives what union gives, yields between slices, and changes the store once', async () => {
  const many = (n: number, hits: number) => Array.from({ length: n }, (_, i) => file(`/w/f${String(i).padStart(4, '0')}.ts`, [[1, hits], [2, 0]]));
  const sync = new CoverageStore();
  sync.replace('p', many(600, 1));
  sync.union('p', many(600, 2));

  const store = new CoverageStore();
  store.replace('p', many(600, 1));
  let changes = 0;
  store.onDidChange(() => changes++);
  let yields = 0;
  const done = store.unionInSlices('p', many(600, 2), { sliceMs: 0, yieldToLoop: async () => { yields++; } });
  expect(changes).toBe(0);
  await done;
  expect(changes).toBe(1);
  expect(yields).toBeGreaterThan(1);
  expect(store.merged().map(e => [e.path, lines(e.parts[0])])).toEqual(sync.merged().map(e => [e.path, lines(e.parts[0])]));
});

test('unionInSlices starts again from what the project holds when it changed meanwhile', async () => {
  const store = new CoverageStore();
  const others = Array.from({ length: 31 }, (_, i) => file(`/w/z${i}.ts`, [[1, 1]]));
  store.replace('p', [file('/w/a.ts', [[1, 1]])]);
  let first = true;
  await store.unionInSlices('p', [file('/w/a.ts', [[1, 2]]), ...others], {
    sliceMs: 0,
    yieldToLoop: async () => {
      if (first) store.replace('p', [file('/w/a.ts', [[1, 10]])]);
      first = false;
    },
  });
  expect(lines(store.merged()[0].parts[0])).toEqual([[1, 12]]);
});

test('a throwing listener is reported once, and the others still run', () => {
  const messages: string[] = [];
  const store = new CoverageStore(m => messages.push(m));
  let ran = 0;
  store.onDidChange(() => { throw new Error('boom'); });
  store.onDidChange(() => { ran++; });
  store.replace('a', [file('/a.ts', [[1, 1]])]);
  store.replace('b', [file('/b.ts', [[1, 1]])]);
  expect(ran).toBe(2);
  expect(messages).toHaveLength(1);
  expect(messages[0]).toContain('boom');
});
