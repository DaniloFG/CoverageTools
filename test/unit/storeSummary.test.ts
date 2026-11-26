import { expect, test } from 'vitest';
import { FileBuilder } from '../../src/model';
import { CoverageStore } from '../../src/store';
import { file } from './helpers';

/** A file with line counts, one branch with two arms and one declaration. */
function withBranches(path: string, lines: ReadonlyArray<readonly [number, number]>, arms: [number, number], declared: number) {
  const b = new FileBuilder(path);
  for (const [line, count] of lines) b.addLine(line, count);
  b.addBranch(1, 0, 0, arms[0]);
  b.addBranch(1, 0, 1, arms[1]);
  b.addDeclaration('f', 1, 0, 2, 0, declared);
  return b.build();
}

test('summary adds statements, branches and declarations over the merged files', () => {
  const s = new CoverageStore();
  s.replace('p1', [withBranches('/w/a.ts', [[1, 1], [2, 0]], [1, 0], 1)]);
  s.replace('p2', [file('/w/b.ts', [[1, 1], [2, 1], [3, 0]])]);
  expect(s.summary()).toEqual({
    statements: { covered: 3, total: 5 },
    branches: { covered: 1, total: 2 },
    declarations: { covered: 1, total: 1 },
  });
  s.clear();
  expect(s.summary()).toEqual({ statements: { covered: 0, total: 0 }, branches: { covered: 0, total: 0 }, declarations: { covered: 0, total: 0 } });
});

test('summary counts a file covered by two projects once, as their union', () => {
  const s = new CoverageStore();
  s.replace('p1', [withBranches('/w/a.ts', [[1, 1], [2, 0]], [1, 0], 0)]);
  s.replace('p2', [withBranches('/w/a.ts', [[2, 1]], [0, 1], 1)]);
  expect(s.summary()).toEqual({
    statements: { covered: 2, total: 2 },
    branches: { covered: 2, total: 2 },
    declarations: { covered: 1, total: 1 },
  });
});

test('summaryOf gives one project\'s own totals, follows changes, and is undefined for an unknown key', () => {
  const s = new CoverageStore();
  s.replace('p1', [withBranches('/w/a.ts', [[1, 1], [2, 0]], [1, 0], 1), file('/w/b.ts', [[1, 1]])]);
  s.replace('p2', [file('/w/a.ts', [[2, 1]])]);
  expect(s.summaryOf('p1')).toEqual({
    statements: { covered: 2, total: 3 },
    branches: { covered: 1, total: 2 },
    declarations: { covered: 1, total: 1 },
  });
  expect(s.summaryOf('nope')).toBeUndefined();
  // The returned object is a copy: changing it does not change the store.
  s.summaryOf('p2')!.statements.covered = 99;
  expect(s.summaryOf('p2')?.statements).toEqual({ covered: 1, total: 1 });
  s.union('p2', [file('/w/c.ts', [[1, 0]])]);
  expect(s.summaryOf('p2')?.statements).toEqual({ covered: 1, total: 2 });
});
