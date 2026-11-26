import path from 'node:path';
import { expect, test } from 'vitest';
import { coverageFraction, formatPercent, keyPath, projectLabel, type DisplayedPercent } from '../../src/format';
import type { FileSummary } from '../../src/model';

const summary = (statements: [number, number], branches: [number, number] = [0, 0], declarations: [number, number] = [0, 0]): FileSummary => ({
  statements: { covered: statements[0], total: statements[1] },
  branches: { covered: branches[0], total: branches[1] },
  declarations: { covered: declarations[0], total: declarations[1] },
});

test('the default fraction is VS Code\'s "totalCoverage": statements, branches and declarations added together', () => {
  // VS Code 1.148, workbench `e_e`: (s.covered + b.covered + d.covered) / (s.total + b.total + d.total).
  expect(coverageFraction(summary([3, 4], [1, 2], [1, 1]))).toBe(5 / 7);
  // The three samples after Run All (UI test): 23 of 26 statements (the status bar used to read 88.4%,
  // and 88.46% in "statement" mode) and 30 of 34 with branches and declarations: the native root row's 88.24%.
  const samples = summary([23, 26], [3, 4], [4, 4]);
  expect(formatPercent(coverageFraction(samples, 'statement'))).toBe('88.46%');
  expect(formatPercent(coverageFraction(samples))).toBe('88.24%');
});

test('the "statement" and "minimum" modes of testing.displayedCoveragePercent', () => {
  const s = summary([3, 4], [1, 2], [1, 1]);
  expect(coverageFraction(s, 'statement')).toBe(0.75);
  expect(coverageFraction(s, 'minimum')).toBe(0.5);
  // A kind with nothing to count is not published, so it never lowers the minimum.
  expect(coverageFraction(summary([3, 4]), 'minimum')).toBe(0.75);
  // An unknown mode reads as the default.
  expect(coverageFraction(s, 'other' as DisplayedPercent)).toBe(5 / 7);
});

test('nothing to count reads as full coverage, as in VS Code', () => {
  expect(coverageFraction(summary([0, 0]))).toBe(1);
  expect(coverageFraction(summary([0, 0]), 'statement')).toBe(1);
});

test('percentages have two decimals, and never read 100.00% below full coverage', () => {
  // VS Code 1.148, workbench `jTt`: (fraction * 100).toFixed(2), and 99.99% when that rounds a non-full value to 100.
  expect(formatPercent(1 / 3)).toBe('33.33%');
  expect(formatPercent(2 / 3)).toBe('66.67%');
  expect(formatPercent(0.5)).toBe('50.00%');
  expect(formatPercent(1)).toBe('100.00%');
  expect(formatPercent(0)).toBe('0.00%');
  expect(formatPercent(99999 / 100000)).toBe('99.99%');
  expect(formatPercent(1 - 1e-8)).toBe('100.00%');
});

test('a store key reads as its path, without the prefix or an unowned report signature', () => {
  expect(keyPath('project:/w/api/Api.Tests.csproj')).toBe('/w/api/Api.Tests.csproj');
  expect(keyPath('unowned:/w/api/TestResults#Api|Api.Core')).toBe('/w/api/TestResults');
  expect(keyPath('unowned:/w/web/coverage#')).toBe('/w/web/coverage');
  expect(keyPath('plain')).toBe('plain');
});

test('an unowned key keeps a results root that contains #', () => {
  expect(keyPath('unowned:/w/C#/Api/TestResults#Api')).toBe('/w/C#/Api/TestResults');
  expect(keyPath('unowned:/w/C#/web/coverage#')).toBe('/w/C#/web/coverage');
});

test('a project is labelled by its workspace folder name, then its path inside the folder', () => {
  const folders = [
    { name: 'python-pytest', fsPath: '/tmp/ws/samples/python-pytest' },
    { name: 'node-jest', fsPath: '/tmp/ws/samples/node-jest' },
    { name: 'web', fsPath: '/repo' },
    { name: 'inner', fsPath: '/repo/packages/inner' },
  ];
  const label = (location: string) => projectLabel(location, folders, path.posix);
  expect(label('/tmp/ws/samples/python-pytest')).toBe('python-pytest');
  expect(label('/tmp/ws/samples/node-jest/package.json')).toBe('node-jest/package.json');
  expect(label('/repo/api/Api.Tests/Api.Tests.csproj')).toBe('web/api/Api.Tests/Api.Tests.csproj');
  // The innermost folder wins.
  expect(label('/repo/packages/inner/package.json')).toBe('inner/package.json');
  expect(label('/repo/packages/inner')).toBe('inner');
  // A sibling whose name starts like a folder is not inside it; outside every folder: the path itself.
  expect(label('/repo-other/package.json')).toBe('/repo-other/package.json');
  expect(label('/elsewhere/coverage')).toBe('/elsewhere/coverage');
  expect(projectLabel('/repo/a', [], path.posix)).toBe('/repo/a');
});

test('on Windows the folder is matched without regard to case and the label uses forward slashes', () => {
  const folders = [{ name: 'api', fsPath: 'C:\\Work\\Api' }];
  expect(projectLabel('c:\\work\\api\\Api.Tests\\Api.Tests.csproj', folders, path.win32)).toBe('api/Api.Tests/Api.Tests.csproj');
  expect(projectLabel('C:\\Work\\Api', folders, path.win32)).toBe('api');
  expect(projectLabel('D:\\Work\\Api\\x', folders, path.win32)).toBe('D:\\Work\\Api\\x');
});
