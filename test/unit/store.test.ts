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
