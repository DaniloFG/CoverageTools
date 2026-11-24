import { expect, test } from 'vitest';
import { DEFAULT_SETTINGS } from '../../src/settings';

test('defaults watch the usual report names and exclude dependency and build folders', () => {
  expect(DEFAULT_SETTINGS.watchEnabled).toBe(true);
  expect(DEFAULT_SETTINGS.watchGlobs).toEqual([
    '**/TestResults/**/*.cobertura.xml',
    '**/coverage/coverage-final.json',
    '**/coverage/lcov.info',
    '**/coverage/cobertura-coverage.xml',
    '**/coverage.xml',
    '**/coverage.lcov',
    '**/.coverage',
  ]);
  expect(DEFAULT_SETTINGS.exclude).toEqual(['**/node_modules/**', '**/bin/**', '**/obj/**', '**/.venv/**', '**/venv/**', '**/__pycache__/**']);
  expect(DEFAULT_SETTINGS.nestedProjects).toBe('inner');
  expect(DEFAULT_SETTINGS).toMatchObject({
    dotnetCollector: '', dotnetExtraArgs: [], nodeExtraArgs: [], pythonInterpreter: '', pythonExtraArgs: [], commands: {},
  });
});
