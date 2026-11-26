import { expect, test } from 'vitest';
import { applyReport } from '../../../src/watcher/apply';

test('a report whose paths are all unresolvable keeps the earlier coverage and logs once', async () => {
  const replaced: string[] = [];
  const logs: string[] = [];
  const store = { replace: (k: string) => void replaced.push(k) };
  expect(await applyReport(store, 'k', { files: [], dropped: 3 }, '/r/lcov.info', m => logs.push(m))).toBe(false);
  expect(replaced).toEqual([]);
  expect(logs).toHaveLength(1);
  expect(logs[0]).toContain('3 file(s)');
});

test('an empty report without dropped files, or one with files, replaces', async () => {
  const replaced: string[] = [];
  const store = { replace: (k: string) => void replaced.push(k) };
  expect(await applyReport(store, 'a', { files: [], dropped: 0 }, '/r', () => undefined)).toBe(true);
  expect(await applyReport(store, 'b', { files: [{} as never], dropped: 2 }, '/r', () => undefined)).toBe(true);
  expect(replaced).toEqual(['a', 'b']);
});
