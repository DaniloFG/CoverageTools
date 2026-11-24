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
  expect(resolveReportPath(raw, sources, ctx)).toBe(expected);
});

test('a <source> is tried before the report directory and the roots', () => {
  const c = ctxOf(['/s/a.cs', '/w/TestResults/x/a.cs', '/w/a.cs'], '/w/TestResults/x', ['/w']);
  expect(resolveReportPath('a.cs', ['/missing', '/s'], c)).toBe('/s/a.cs');
});

test('a deterministic <source> maps to the workspace roots', () => {
  const c = ctxOf(['/w/proj/src/a.cs'], '/r', ['/w']);
  expect(resolveReportPath('src/a.cs', ['/_/proj/'], c)).toBe('/w/proj/src/a.cs');
});

test('numbered deterministic prefixes /_1/, /_2/ and bare /_/ sources map to the workspace roots', () => {
  const c = ctxOf(['/w/src/a.cs', '/w/lib/b.cs'], '/r', ['/w']);
  expect(resolveReportPath('/_1/src/a.cs', [], c)).toBe('/w/src/a.cs');
  expect(resolveReportPath('/_12/lib/b.cs', [], c)).toBe('/w/lib/b.cs');
  expect(resolveReportPath('src/a.cs', ['/_/'], c)).toBe('/w/src/a.cs');
  expect(resolveReportPath('src/a.cs', ['/_'], c)).toBe('/w/src/a.cs');
  expect(resolveReportPath('lib/b.cs', ['/_3/'], c)).toBe('/w/lib/b.cs');
  expect(resolveReportPath('/_x/src/a.cs', [], c)).toBeUndefined();
});

test('Windows: numbered deterministic prefixes with backslashes', () => {
  const c = ctxOf(['C:\\w\\lib\\b.cs'], 'C:\\r', ['C:\\w']);
  expect(resolveReportPath('\\_2\\lib\\b.cs', [], c, path.win32)).toBe('C:\\w\\lib\\b.cs');
  expect(resolveReportPath('lib\\b.cs', ['/_1/'], c, path.win32)).toBe('C:\\w\\lib\\b.cs');
});

test('a path that exists nowhere resolves to undefined', () => {
  expect(resolveReportPath('src/missing.cs', ['/w'], ctx)).toBeUndefined();
  expect(resolveReportPath('/elsewhere/missing.cs', [], ctx)).toBeUndefined();
  expect(resolveReportPath('/_/missing.cs', [], ctx)).toBeUndefined();
});

test('Windows: backslashes and drive-letter case are normalized', () => {
  const c = ctxOf(['C:\\w\\src\\a.cs'], 'C:\\w\\TestResults', ['C:\\w']);
  expect(resolveReportPath('c:\\w\\src\\a.cs', ['C:\\w'], c, path.win32)).toBe('C:\\w\\src\\a.cs');
  expect(resolveReportPath('src/a.cs', ['c:\\w'], c, path.win32)).toBe('C:\\w\\src\\a.cs');
  expect(resolveReportPath('/_/src/a.cs', [], c, path.win32)).toBe('C:\\w\\src\\a.cs');
});
