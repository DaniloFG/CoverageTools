import { expect, test } from 'vitest';
import { RunnablePathsContext, runnableContextValue } from '../../../src/vscode/runnablePaths';

/** Stands in for `vscode.Uri.file(p).fsPath` on Windows: lower-case drive letter, backslashes. */
const winFsPath = (p: string): string => p.replace(/\//g, '\\').replace(/^([A-Z]):/, (_, d: string) => `${d.toLowerCase()}:`);

test('the context value maps each normalized path to true', () => {
  expect(runnableContextValue(['C:/w/api/Api.Tests.csproj', 'C:\\w\\api'], winFsPath)).toEqual({
    'c:\\w\\api\\Api.Tests.csproj': true,
    'c:\\w\\api': true,
  });
  expect(runnableContextValue(['/w/web/src/a.test.js'], p => p)).toEqual({ '/w/web/src/a.test.js': true });
});

test('the context key is set only when the set of paths changed', () => {
  const values: Array<Record<string, true>> = [];
  const ctx = new RunnablePathsContext(p => p, v => values.push(v));
  expect(ctx.update(new Set(['/w/a', '/w/a/x.test.js']))).toBe(true);
  expect(ctx.update(new Set(['/w/a/x.test.js', '/w/a']))).toBe(false);
  expect(ctx.update(new Set(['/w/a']))).toBe(true);
  expect(ctx.update(new Set(['/w/a']))).toBe(false);
  expect(ctx.update(new Set(['/w/b']))).toBe(true);
  expect(values).toEqual([{ '/w/a': true, '/w/a/x.test.js': true }, { '/w/a': true }, { '/w/b': true }]);
});

test('paths that normalize to the same spelling count once', () => {
  const values: Array<Record<string, true>> = [];
  const ctx = new RunnablePathsContext(winFsPath, v => values.push(v));
  ctx.update(new Set(['C:/w/a']));
  expect(ctx.update(new Set(['c:\\w\\a']))).toBe(false);
  expect(values).toEqual([{ 'c:\\w\\a': true }]);
});

test('an empty first set is still published, so the menu state is known', () => {
  const values: Array<Record<string, true>> = [];
  const ctx = new RunnablePathsContext(p => p, v => values.push(v));
  expect(ctx.update(new Set())).toBe(true);
  expect(ctx.update(new Set())).toBe(false);
  expect(values).toEqual([{}]);
});
