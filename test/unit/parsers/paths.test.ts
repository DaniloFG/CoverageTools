import path from 'node:path';
import { expect, test } from 'vitest';
import { resolveReportPath } from '../../../src/parsers/paths';
import type { ParseContext } from '../../../src/parsers/types';

function ctxOf(existing: readonly string[], reportDir: string, roots: readonly string[]): ParseContext {
  const set = new Set(existing);
  return { reportDir, roots, fileExists: p => set.has(p) };
}

const ctx = ctxOf(
  ['/w/src/a.cs', '/w/TestResults/x/a.cs', '/w/meu código/a.cs'],
  '/w/TestResults/x',
  ['/w'],
);

test.each([
  ['absolute existing path', '/w/src/a.cs', [], '/w/src/a.cs'],
  ['relative to a <source>', 'src/a.cs', ['/w'], '/w/src/a.cs'],
  ['relative to the report directory', 'a.cs', [], '/w/TestResults/x/a.cs'],
  ['relative to a workspace root', 'src/a.cs', [], '/w/src/a.cs'],
  ['deterministic build prefix /_/', '/_/src/a.cs', [], '/w/src/a.cs'],
  ['path with spaces and accents', 'meu código/a.cs', ['/w'], '/w/meu código/a.cs'],
])('%s', (_n, raw, sources, expected) => {
  expect(resolveReportPath(raw, sources, ctx, path.posix)).toBe(expected);
});

test('a <source> is tried before the report directory and the roots', () => {
  const c = ctxOf(['/s/a.cs', '/w/TestResults/x/a.cs', '/w/a.cs'], '/w/TestResults/x', ['/w']);
  expect(resolveReportPath('a.cs', ['/missing', '/s'], c, path.posix)).toBe('/s/a.cs');
});

test('a deterministic <source> maps to the workspace roots', () => {
  const c = ctxOf(['/w/proj/src/a.cs'], '/r', ['/w']);
  expect(resolveReportPath('src/a.cs', ['/_/proj/'], c, path.posix)).toBe('/w/proj/src/a.cs');
});

test('numbered deterministic prefixes /_1/, /_2/ and bare /_/ sources map to the workspace roots', () => {
  const c = ctxOf(['/w/src/a.cs', '/w/lib/b.cs'], '/r', ['/w']);
  expect(resolveReportPath('/_1/src/a.cs', [], c, path.posix)).toBe('/w/src/a.cs');
  expect(resolveReportPath('/_12/lib/b.cs', [], c, path.posix)).toBe('/w/lib/b.cs');
  expect(resolveReportPath('src/a.cs', ['/_/'], c, path.posix)).toBe('/w/src/a.cs');
  expect(resolveReportPath('src/a.cs', ['/_'], c, path.posix)).toBe('/w/src/a.cs');
  expect(resolveReportPath('lib/b.cs', ['/_3/'], c, path.posix)).toBe('/w/lib/b.cs');
  expect(resolveReportPath('/_x/src/a.cs', [], c, path.posix)).toBeUndefined();
});

test('Windows: numbered deterministic prefixes with backslashes', () => {
  const c = ctxOf(['C:\\w\\lib\\b.cs'], 'C:\\r', ['C:\\w']);
  expect(resolveReportPath('\\_2\\lib\\b.cs', [], c, path.win32)).toBe('C:\\w\\lib\\b.cs');
  expect(resolveReportPath('lib\\b.cs', ['/_1/'], c, path.win32)).toBe('C:\\w\\lib\\b.cs');
});

test('with two roots that both have the file, the root holding the report wins', () => {
  const c = ctxOf(['/a/src/calc.js', '/b/src/calc.js'], '/b/coverage', ['/a', '/b']);
  expect(resolveReportPath('src/calc.js', [], c, path.posix)).toBe('/b/src/calc.js');
});

test('a report below a root resolves from its own project directory upward', () => {
  const c = ctxOf(['/w/src/a.js', '/w/packages/app/src/a.js', '/w/packages/app/only-here.js', '/w/top.js'],
    '/w/packages/app/coverage', ['/w']);
  expect(resolveReportPath('src/a.js', [], c, path.posix)).toBe('/w/packages/app/src/a.js');
  expect(resolveReportPath('only-here.js', [], c, path.posix)).toBe('/w/packages/app/only-here.js');
  expect(resolveReportPath('top.js', [], c, path.posix)).toBe('/w/top.js');
});

test('the upward walk stops at the innermost root that contains the report', () => {
  const c = ctxOf(['/w/x.js', '/other/x.js'], '/w/inner/coverage', ['/other', '/w/inner', '/w']);
  // /w is not an ancestor tried before the roots: the walk stops at /w/inner, then roots go in order.
  expect(resolveReportPath('x.js', [], c, path.posix)).toBe('/other/x.js');
});

test('a report outside every root: the first root that has the file wins', () => {
  const c = ctxOf(['/a/src/calc.js', '/b/src/calc.js'], '/tmp/run-1/coverage', ['/b', '/a']);
  expect(resolveReportPath('src/calc.js', [], c, path.posix)).toBe('/b/src/calc.js');
  const deep = ctxOf(['/src/calc.js', '/a/src/calc.js'], '/1/2/3/4/5/6/7/8/9/10', ['/a']);
  // Only 8 ancestors are tried outside the roots, so the filesystem root is not reached.
  expect(resolveReportPath('src/calc.js', [], deep, path.posix)).toBe('/a/src/calc.js');
});

test('deterministic remainders are tried from the report directory upward before the roots', () => {
  const c = ctxOf(['/a/src/a.cs', '/b/proj/src/a.cs'], '/b/proj/TestResults/x', ['/a', '/b']);
  expect(resolveReportPath('/_/src/a.cs', [], c, path.posix)).toBe('/b/proj/src/a.cs');
});

test('Windows: the root holding the report wins and a nested project resolves upward', () => {
  const c = ctxOf(['C:\\a\\src\\calc.js', 'D:\\b\\src\\calc.js', 'D:\\b\\pkg\\src\\calc.js'],
    'd:\\b\\coverage', ['C:\\a', 'D:\\b']);
  expect(resolveReportPath('src/calc.js', [], c, path.win32)).toBe('D:\\b\\src\\calc.js');
  const nested = { ...c, reportDir: 'D:\\b\\pkg\\coverage' };
  expect(resolveReportPath('src\\calc.js', [], nested, path.win32)).toBe('D:\\b\\pkg\\src\\calc.js');
});

test('a path that exists nowhere resolves to undefined', () => {
  expect(resolveReportPath('src/missing.cs', ['/w'], ctx, path.posix)).toBeUndefined();
  expect(resolveReportPath('/elsewhere/missing.cs', [], ctx, path.posix)).toBeUndefined();
  expect(resolveReportPath('/_/missing.cs', [], ctx, path.posix)).toBeUndefined();
});

test('Windows: backslashes and drive-letter case are normalized', () => {
  const c = ctxOf(['C:\\w\\src\\a.cs'], 'C:\\w\\TestResults', ['C:\\w']);
  expect(resolveReportPath('c:\\w\\src\\a.cs', ['C:\\w'], c, path.win32)).toBe('C:\\w\\src\\a.cs');
  expect(resolveReportPath('src/a.cs', ['c:\\w'], c, path.win32)).toBe('C:\\w\\src\\a.cs');
  expect(resolveReportPath('/_/src/a.cs', [], c, path.win32)).toBe('C:\\w\\src\\a.cs');
});

test('a report outside every root tries the roots before the report directory\'s ancestors', () => {
  const c = ctxOf(['/tmp/src/a.js', '/w/src/a.js', '/tmp/run-1/only-up.js'], '/tmp/run-1/cov', ['/w']);
  expect(resolveReportPath('src/a.js', [], c, path.posix)).toBe('/w/src/a.js');
  // Ancestors are still a last resort for a file no root has.
  expect(resolveReportPath('only-up.js', [], c, path.posix)).toBe('/tmp/run-1/only-up.js');
});
