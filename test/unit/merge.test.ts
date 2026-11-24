import { expect, test } from 'vitest';
import { EOL, FileBuilder } from '../../src/model';
import { unionFileLists, unionFiles } from '../../src/merge';
import { decls, file, lines } from './helpers';

test('union sums matching records and keeps unmatched ones from both sides', () => {
  const a = file('/w/a.ts', [[1, 1], [2, 0]]);
  const b = file('/w/a.ts', [[2, 4], [9, 1]]);
  expect(lines(unionFiles([a, b]))).toEqual([[1, 1], [2, 4], [9, 1]]);
});

test('a line record and a range record on the same line are different statements', () => {
  const a = file('/w/a.ts', [[1, 1]]);
  const rb = new FileBuilder('/w/a.ts');
  rb.addStatement(1, 0, 1, EOL, 2);
  const u = unionFiles([a, rb.build()]);
  expect(Array.from(u.statements)).toEqual([1, 0, 0, 0, 1, 1, 0, 1, EOL, 2]);
});

test('declarations match by name and start line; branches by line, col and arm', () => {
  const ab = new FileBuilder('/w/a.ts');
  ab.addBranch(1, 0, 0, 1); ab.addBranch(1, 0, 1, 0);
  ab.addDeclaration('f', 1, 0, 3, 1, 1);
  ab.addDeclaration('g', 5, 0, 6, 1, 0);
  const bb = new FileBuilder('/w/a.ts');
  bb.addBranch(1, 0, 1, 2); bb.addBranch(1, 4, 0, 1);
  bb.addDeclaration('f', 1, 0, 3, 1, 2);
  bb.addDeclaration('f', 9, 0, 9, EOL, 1);
  bb.addDeclaration('g', 5, 0, 6, 1, 3);
  bb.addDeclaration('h', 2, 0, 2, EOL, 0);
  const u = unionFiles([ab.build(), bb.build()]);
  expect(Array.from(u.branches)).toEqual([1, 0, 0, 1, 1, 0, 1, 2, 1, 4, 0, 1]);
  expect(decls(u)).toEqual([['f', 1, 3], ['f', 9, 1], ['g', 5, 3], ['h', 2, 0]]);
  expect(u.names).toEqual(['f', 'g', 'h']);
});

test('union of three parts sums all of them and saturates', () => {
  const u = unionFiles([
    file('/w/a.ts', [[1, 0xfffffff0]]), file('/w/a.ts', [[1, 0x20], [2, 1]]), file('/w/a.ts', [[2, 2]]),
  ]);
  expect(u.path).toBe('/w/a.ts');
  expect(lines(u)).toEqual([[1, 0xffffffff], [2, 3]]);
});

test('unionFileLists unions by path and keeps files present on one side only', () => {
  const left = [file('/w/a.ts', [[1, 1]]), file('/w/b.ts', [[1, 0], [2, 1]])];
  const right = [file('/w/b.ts', [[1, 2]]), file('/w/c.ts', [[4, 1]])];
  const u = unionFileLists(left, right);
  expect(u.map(f => [f.path, lines(f)])).toEqual([
    ['/w/a.ts', [[1, 1]]],
    ['/w/b.ts', [[1, 2], [2, 1]]],
    ['/w/c.ts', [[4, 1]]],
  ]);
});

test('unionFiles does not mutate its inputs', () => {
  const mk = (n: number) => {
    const b = new FileBuilder('/w/a.ts');
    b.addLine(1, n); b.addLine(n + 1, 1);
    b.addBranch(1, 0, 0, n);
    b.addDeclaration(`f${n}`, 1, 0, 2, 0, n);
    return b.build();
  };
  const parts = [mk(1), mk(2)];
  const snapshot = () => parts.map(p => ({
    statements: Array.from(p.statements), branches: Array.from(p.branches),
    declarations: Array.from(p.declarations), names: [...p.names],
  }));
  const before = snapshot();
  const u = unionFiles(parts);
  expect(snapshot()).toEqual(before);
  expect(u.statements).not.toBe(parts[0].statements);
  expect(lines(u)).toEqual([[1, 3], [2, 1], [3, 1]]);
});
