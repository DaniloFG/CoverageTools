import { expect, test } from 'vitest';
import { formatPercent, keyPath } from '../../src/format';

test('percentages round down to one decimal and drop a zero decimal', () => {
  expect(formatPercent(9996, 10000)).toBe('99.9%');
  expect(formatPercent(1, 3)).toBe('33.3%');
  expect(formatPercent(1, 2)).toBe('50%');
  expect(formatPercent(3, 3)).toBe('100%');
  expect(formatPercent(0, 7)).toBe('0%');
});

test('a zero total is shown as 0%', () => {
  expect(formatPercent(0, 0)).toBe('0%');
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
