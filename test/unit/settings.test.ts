import { expect, test } from 'vitest';
import { DEFAULT_RUN_SETTINGS, DEFAULT_SETTINGS, runSettingsFrom } from '../../src/settings';

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
  expect(DEFAULT_SETTINGS.exclude).toEqual(['**/node_modules/**', '**/bin/**', '**/obj/**', '**/.venv/**', '**/venv/**', '**/.tox/**', '**/.nox/**', '**/.conda/**', '**/site-packages/**', '**/build/lib/**', '**/__pycache__/**']);
  expect(DEFAULT_SETTINGS.nestedProjects).toBe('inner');
  expect(DEFAULT_SETTINGS).toMatchObject({
    dotnetCollector: '', dotnetExtraArgs: [], nodeExtraArgs: [], pythonInterpreter: '', pythonExtraArgs: [], commands: {},
  });
});

test('defaults are deeply frozen so no consumer can change them for the others', () => {
  expect(Object.isFrozen(DEFAULT_SETTINGS)).toBe(true);
  expect(Object.isFrozen(DEFAULT_SETTINGS.watchGlobs)).toBe(true);
  expect(Object.isFrozen(DEFAULT_SETTINGS.exclude)).toBe(true);
  expect(Object.isFrozen(DEFAULT_SETTINGS.commands)).toBe(true);
  expect(() => DEFAULT_SETTINGS.exclude.push('x')).toThrow(TypeError);
  const copy = { ...DEFAULT_SETTINGS, exclude: [...DEFAULT_SETTINGS.exclude, '**/dist/**'] };
  expect(copy.exclude).toHaveLength(DEFAULT_SETTINGS.exclude.length + 1);
  expect(DEFAULT_SETTINGS.exclude).toHaveLength(11);
});

test('runs are sequential by default, with the parallel limit chosen from the machine', () => {
  expect(DEFAULT_RUN_SETTINGS).toEqual({ mode: 'sequential', maxParallel: 0 });
  expect(Object.isFrozen(DEFAULT_RUN_SETTINGS)).toBe(true);
});

test('run settings fall back to the defaults for anything unset or invalid', () => {
  expect(runSettingsFrom('parallel', 3)).toEqual({ mode: 'parallel', maxParallel: 3 });
  expect(runSettingsFrom(undefined, undefined)).toEqual(DEFAULT_RUN_SETTINGS);
  expect(runSettingsFrom('fast', '4')).toEqual(DEFAULT_RUN_SETTINGS);
  expect(runSettingsFrom('parallel', -2).maxParallel).toBe(0);
  expect(runSettingsFrom('parallel', 2.9).maxParallel).toBe(2);
  expect(runSettingsFrom('parallel', Number.NaN).maxParallel).toBe(0);
});
