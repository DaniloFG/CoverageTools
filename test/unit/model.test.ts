import { expect, test } from 'vitest';
import { EOL, FileBuilder, summarize } from '../../src/model';

test('builder sorts records, sums duplicates and summarizes', () => {
  const b = new FileBuilder('/w/a.ts');
  b.addLine(3, 0); b.addLine(1, 2); b.addLine(1, 1);
  b.addBranch(1, 0, 0, 1); b.addBranch(1, 0, 1, 0);
  b.addDeclaration('f', 1, 0, 0, 0, 3);
  const f = b.build();
  expect(Array.from(f.statements)).toEqual([1, 0, 0, 0, 3, 3, 0, 0, 0, 0]);
  expect(summarize(f)).toEqual({
    statements: { covered: 1, total: 2 }, branches: { covered: 1, total: 2 }, declarations: { covered: 1, total: 1 },
  });
});

test('counts saturate at 0xffffffff instead of wrapping', () => {
  const b = new FileBuilder('/w/a.ts'); b.addLine(1, 0xffffffff); b.addLine(1, 5);
  expect(b.build().statements[4]).toBe(0xffffffff);
});

test('statements sort by start line, start col, end line, end col', () => {
  const b = new FileBuilder('/w/a.ts');
  b.addStatement(2, 4, 2, EOL, 1);
  b.addStatement(2, 0, 3, 1, 2);
  b.addStatement(2, 0, 2, 9, 3);
  b.addLine(2, 4);
  expect(Array.from(b.build().statements)).toEqual([
    2, 0, 0, 0, 4,
    2, 0, 2, 9, 3,
    2, 0, 3, 1, 2,
    2, 4, 2, EOL, 1,
  ]);
});

test('branches sort by line, col and arm and sum duplicates', () => {
  const b = new FileBuilder('/w/a.ts');
  b.addBranch(5, 0, 1, 1); b.addBranch(2, 3, 0, 0); b.addBranch(5, 0, 0, 2); b.addBranch(5, 0, 1, 4);
  expect(Array.from(b.build().branches)).toEqual([2, 3, 0, 0, 5, 0, 0, 2, 5, 0, 1, 5]);
});

test('declarations sort by name then start line and sum duplicates', () => {
  const b = new FileBuilder('/w/a.ts');
  b.addDeclaration('zeta', 1, 0, 2, 1, 1);
  b.addDeclaration('alpha', 9, 2, 10, 1, 0);
  b.addDeclaration('alpha', 3, 0, 4, 1, 2);
  b.addDeclaration('zeta', 1, 0, 2, 1, 6);
  const f = b.build();
  expect(f.names).toEqual(['alpha', 'zeta']);
  expect(Array.from(f.declarations)).toEqual([
    3, 0, 4, 1, 2, 0,
    9, 2, 10, 1, 0, 0,
    1, 0, 2, 1, 7, 1,
  ]);
  expect(summarize(f).declarations).toEqual({ covered: 2, total: 3 });
});

test('an empty builder yields empty arrays and zero totals', () => {
  const f = new FileBuilder('/w/empty.ts').build();
  expect(f.path).toBe('/w/empty.ts');
  expect([f.statements.length, f.branches.length, f.declarations.length, f.names.length]).toEqual([0, 0, 0, 0]);
  expect(summarize(f)).toEqual({
    statements: { covered: 0, total: 0 }, branches: { covered: 0, total: 0 }, declarations: { covered: 0, total: 0 },
  });
});

test('coordinates are truncated before storing, so 3 and 3.7 are one record', () => {
  const b = new FileBuilder('/w/a.ts');
  b.addLine(3, 1); b.addLine(3.7, 2);
  b.addBranch(2, 1.5, 0, 1); b.addBranch(2, 1, 0.2, 4);
  b.addDeclaration('f', 3.7, 0, 4, 1, 1); b.addDeclaration('f', 3, 0.9, 4, 1, 2);
  const f = b.build();
  expect(Array.from(f.statements)).toEqual([3, 0, 0, 0, 3]);
  expect(Array.from(f.branches)).toEqual([2, 1, 0, 5]);
  expect(Array.from(f.declarations)).toEqual([3, 0, 4, 1, 3, 0]);
});

test('non-finite or negative coordinates become 0 and keep the output sorted', () => {
  const b = new FileBuilder('/w/a.ts');
  b.addLine(5, 1); b.addLine(NaN, 2); b.addLine(2, 3); b.addLine(-4, 4); b.addLine(Infinity, 5);
  b.addStatement(1, NaN, 1, 0x1ffffffff, 6);
  b.addBranch(NaN, 0, 0, 1); b.addBranch(1, 0, 0, 1);
  expect(Array.from(b.build().statements)).toEqual([
    0, 0, 0, 0, 11,
    1, 0, 1, EOL, 6,
    2, 0, 0, 0, 3,
    5, 0, 0, 0, 1,
  ]);
  expect(Array.from(b.build().branches)).toEqual([0, 0, 0, 1, 1, 0, 0, 1]);
});
