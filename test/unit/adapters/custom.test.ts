import path from 'node:path';
import { expect, test } from 'vitest';
import { customAdapter, customProject } from '../../../src/adapters/custom';
import type { PlanContext } from '../../../src/adapters/types';
import { DEFAULT_SETTINGS } from '../../../src/settings';
import { memoryFs } from './memoryFs';

const folder = path.resolve('/w');
const dir = path.join(folder, 'tools', 'legacy app');
const tmp = path.resolve('/tmp/ct 1');

function ctx(): PlanContext {
  return { tmpDir: tmp, fs: memoryFs({}), settings: { ...DEFAULT_SETTINGS }, c8Bin: '/c8.js', probe: async () => ({ code: 0, stdout: '' }) };
}

test('customProject builds a full-run-only project of the custom adapter', () => {
  expect(customProject(dir, 'make cov', folder)).toEqual({
    key: `project:${dir}`,
    adapter: 'custom',
    ecosystem: 'custom',
    dir,
    name: 'legacy app',
    supportsPartial: false,
    meta: { command: 'make cov', workspaceFolder: folder },
  });
});

test('the plan runs the command line through a shell with ${coverageDir} replaced by the temp directory', async () => {
  const project = customProject(dir, 'python -m coverage run -m unittest && python -m coverage xml -o "${coverageDir}/coverage.xml" # ${coverageDir}', folder);
  const plan = await customAdapter.plan(project, { kind: 'full' }, ctx());
  expect(plan.steps).toEqual([
    {
      command: `python -m coverage run -m unittest && python -m coverage xml -o "${tmp}/coverage.xml" # ${tmp}`,
      args: [],
      cwd: dir,
      shell: true,
    },
  ]);
  expect(plan.reportSearchDir).toBe(tmp);
  expect(plan.hint).toContain('${coverageDir}');
});

test('without ${coverageDir} the report is searched for in the project directory', async () => {
  const plan = await customAdapter.plan(customProject(dir, 'make coverage', folder), { kind: 'full' }, ctx());
  expect(plan.steps[0].command).toBe('make coverage');
  expect(plan.reportSearchDir).toBe(dir);
});

test('supportsPartial is false', async () => {
  const project = customProject(dir, 'make cov', folder);
  expect(project.supportsPartial).toBe(false);
  expect(await customAdapter.isTestFile(project, path.join(dir, 'test_a.py'), memoryFs({}))).toBe(false);
  // A partial target still runs the whole command.
  const plan = await customAdapter.plan(project, { kind: 'partial', paths: [path.join(dir, 'x')] }, ctx());
  expect(plan.steps).toHaveLength(1);
});

test('detect recognizes nothing: custom projects come from the settings only', async () => {
  expect(await customAdapter.detect(dir, memoryFs({ [path.join(dir, 'package.json')]: '{}' }))).toBeUndefined();
});
