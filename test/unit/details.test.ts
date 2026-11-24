import { expect, test } from 'vitest';
import { toDetails } from '../../src/details';
import { EOL, FileBuilder } from '../../src/model';
import { file } from './helpers';

test('line-only statements become a position at column 0, zero-based', () => {
  expect(toDetails(file('/w/a.ts', [[3, 2]]))).toEqual([
    { kind: 'statement', executed: 2, start: { line: 2, character: 0 }, branches: [] },
  ]);
});

test('range statements keep start and end; EOL maps to character 0x7fffffff', () => {
  const b = new FileBuilder('/w/a.ts');
  b.addStatement(2, 4, 2, 10, 1);
  b.addStatement(5, 0, 7, EOL, 0);
  expect(toDetails(b.build())).toEqual([
    { kind: 'statement', executed: 1, start: { line: 1, character: 4 }, end: { line: 1, character: 10 }, branches: [] },
    { kind: 'statement', executed: 0, start: { line: 4, character: 0 }, end: { line: 6, character: 0x7fffffff }, branches: [] },
  ]);
});

test('branches attach to the statement that starts on their line', () => {
  const b = new FileBuilder('/w/a.ts');
  b.addLine(5, 1);
  b.addLine(6, 3);
  b.addBranch(6, 0, 0, 0);
  b.addBranch(6, 0, 1, 3);
  expect(toDetails(b.build())).toEqual([
    { kind: 'statement', executed: 1, start: { line: 4, character: 0 }, branches: [] },
    {
      kind: 'statement', executed: 3, start: { line: 5, character: 0 },
      branches: [{ executed: 0, label: 'branch 1' }, { executed: 3, label: 'branch 2' }],
    },
  ]);
});

test('a branch on a line with no statement creates a statement with the summed count', () => {
  const b = new FileBuilder('/w/a.ts');
  b.addLine(2, 1);
  b.addLine(9, 0);
  b.addBranch(4, 0, 0, 2);
  b.addBranch(4, 0, 1, 5);
  b.addBranch(12, 3, 0, 0);
  expect(toDetails(b.build())).toEqual([
    { kind: 'statement', executed: 1, start: { line: 1, character: 0 }, branches: [] },
    {
      kind: 'statement', executed: 7, start: { line: 3, character: 0 },
      branches: [{ executed: 2, label: 'branch 1' }, { executed: 5, label: 'branch 2' }],
    },
    { kind: 'statement', executed: 0, start: { line: 8, character: 0 }, branches: [] },
    { kind: 'statement', executed: 0, start: { line: 11, character: 0 }, branches: [{ executed: 0, label: 'branch 1' }] },
  ]);
});

test('declarations carry name, count and position', () => {
  const b = new FileBuilder('/w/a.ts');
  b.addDeclaration('run', 3, 2, 8, 1, 4);
  b.addDeclaration('main', 10, 0, 0, 0, 0);
  expect(toDetails(b.build())).toEqual([
    { kind: 'declaration', name: 'main', executed: 0, start: { line: 9, character: 0 } },
    { kind: 'declaration', name: 'run', executed: 4, start: { line: 2, character: 2 }, end: { line: 7, character: 1 } },
  ]);
});

test('a declaration without a range (endLine 0) gets only a start position', () => {
  const b = new FileBuilder('/w/a.ts');
  b.addDeclaration('init', 7, 0, 0, 0, 2);
  expect(toDetails(b.build())).toEqual([
    { kind: 'declaration', name: 'init', executed: 2, start: { line: 6, character: 0 } },
  ]);
});
