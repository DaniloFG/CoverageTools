import path from 'node:path';
import { expect, test } from 'vitest';
import { jestAdapter } from '../../../src/adapters/jest';
import type { FsReader, PlanContext, Project } from '../../../src/adapters/types';
import { DEFAULT_SETTINGS, type Settings } from '../../../src/settings';
import { memoryFs } from './memoryFs';

const dir = path.resolve('/w/app');
const pkgFile = path.join(dir, 'package.json');
const tmp = path.resolve('/tmp/ct-1');

function pkg(value: object): string {
  return JSON.stringify(value);
}

function ctx(fs: FsReader, settings: Partial<Settings> = {}): PlanContext {
  return {
    tmpDir: tmp, fs, settings: { ...DEFAULT_SETTINGS, ...settings }, c8Bin: '/c8.js',
    probe: async () => ({ code: 0, stdout: '' }),
  };
}

async function detected(files: Record<string, string>, candidate = pkgFile): Promise<Project | undefined> {
  return jestAdapter.detect(candidate, memoryFs(files));
}

const COVERAGE_ARGS = ['--coverage', '--coverageReporters=json', `--coverageDirectory=${tmp}`];

test('detects by jest key, jest.config.*, or a test script that ends in jest or react-scripts test', async () => {
  const byKey = await detected({ [pkgFile]: pkg({ name: 'app', jest: {} }) });
  expect(byKey).toEqual({
    key: `project:${pkgFile}`, adapter: 'jest', ecosystem: 'node', dir, definingFile: pkgFile,
    name: 'app', supportsPartial: true, meta: {},
  });
  for (const config of ['jest.config.js', 'jest.config.ts', 'jest.config.mjs', 'jest.config.cjs', 'jest.config.json']) {
    expect((await detected({ [pkgFile]: pkg({}), [path.join(dir, config)]: '' }))?.adapter).toBe('jest');
  }
  expect((await detected({ [pkgFile]: pkg({ scripts: { test: 'jest --ci' } }) }))?.adapter).toBe('jest');
  expect((await detected({ [pkgFile]: pkg({ scripts: { test: 'react-scripts test' } }) }))?.adapter).toBe('jest');
  // A directory candidate reads its package.json; the name defaults to the directory's.
  expect((await detected({ [pkgFile]: pkg({ jest: {} }) }, dir))?.name).toBe('app');
  expect(await detected({ [pkgFile]: pkg({ scripts: { test: 'vitest' } }) })).toBeUndefined();
  expect(await detected({ [pkgFile]: '{ not json' })).toBeUndefined();
  expect(await detected({})).toBeUndefined();
  expect(await detected({ [path.join(dir, 'app.csproj')]: '' }, path.join(dir, 'app.csproj'))).toBeUndefined();
});

test('jest only in devDependencies is not a Jest project', async () => {
  expect(await detected({ [pkgFile]: pkg({ devDependencies: { jest: '^29.0.0' }, scripts: { test: 'node test.js' } }) })).toBeUndefined();
});

async function projectOf(files: Record<string, string>): Promise<{ project: Project; fs: FsReader }> {
  const fs = memoryFs(files);
  const project = await jestAdapter.detect(pkgFile, fs);
  if (project === undefined) throw new Error('not detected');
  return { project, fs };
}

test('full plan uses the script when it tail-calls jest', async () => {
  const { project, fs } = await projectOf({ [pkgFile]: pkg({ scripts: { test: 'jest --ci' } }), [path.join(dir, 'yarn.lock')]: '' });
  const plan = await jestAdapter.plan(project, { kind: 'full' }, ctx(fs));
  expect(plan.steps).toEqual([{ command: 'yarn', args: ['run', 'test', ...COVERAGE_ARGS], cwd: dir, env: { CI: 'true' } }]);
  expect(plan.reportSearchDir).toBe(tmp);
  expect(plan.hint).toBe('Jest did not write a coverage report. Check that the project\'s tests run with "--coverage".');

  const npm = await projectOf({ [pkgFile]: pkg({ scripts: { test: 'npm run unit', unit: 'jest' } }) });
  const npmPlan = await jestAdapter.plan(npm.project, { kind: 'full' }, ctx(npm.fs));
  expect(npmPlan.steps[0].command).toBe('npm');
  expect(npmPlan.steps[0].args).toEqual(['run', 'unit', '--', ...COVERAGE_ARGS]);
  expect(npmPlan.steps[0].env?.CI).toBe('true');
});

test('full plan calls the local binary when there is no usable script', async () => {
  const { project, fs } = await projectOf({
    [pkgFile]: pkg({ jest: {}, scripts: { test: 'jest && eslint .' } }), [path.join(dir, 'pnpm-lock.yaml')]: '',
  });
  const plan = await jestAdapter.plan(project, { kind: 'full' }, ctx(fs, { nodeExtraArgs: ['--runInBand'] }));
  expect(plan.steps).toEqual([{ command: 'pnpm', args: ['exec', 'jest', ...COVERAGE_ARGS, '--runInBand'], cwd: dir, env: { CI: 'true' } }]);

  const npm = await projectOf({ [pkgFile]: pkg({ jest: {} }) });
  expect((await jestAdapter.plan(npm.project, { kind: 'full' }, ctx(npm.fs))).steps[0]).toMatchObject({
    command: 'npx', args: ['--no-install', 'jest', ...COVERAGE_ARGS],
  });
});

test('partial plan appends the paths relative to the project, with forward slashes, after extra args', async () => {
  const { project, fs } = await projectOf({ [pkgFile]: pkg({ scripts: { test: 'jest' } }), [path.join(dir, 'yarn.lock')]: '' });
  const paths = [path.join(dir, 'src', 'a.test.js'), path.join(dir, 'src', 'deep', '__tests__', 'b.js')];
  const plan = await jestAdapter.plan(project, { kind: 'partial', paths }, ctx(fs, { nodeExtraArgs: ['--silent'] }));
  expect(plan.steps[0].args).toEqual(['run', 'test', ...COVERAGE_ARGS, '--silent', 'src/a.test.js', 'src/deep/__tests__/b.js']);
});

test('isTestFile follows the default Jest patterns including .mjs/.cjs/.mts/.cts', async () => {
  const { project, fs } = await projectOf({ [pkgFile]: pkg({ jest: {} }) });
  const yes = ['src/a.test.js', 'src/a.spec.jsx', 'a.test.ts', 'a.test.tsx', 'a.test.mjs', 'a.test.cjs', 'a.test.mts', 'a.test.cts', 'src/__tests__/x.js'];
  const no = ['src/a.js', 'src/a.test.json', 'node_modules/lib/a.test.js', '../other/a.test.js'];
  for (const p of yes) expect(await jestAdapter.isTestFile(project, path.join(dir, p), fs), p).toBe(true);
  for (const p of no) expect(await jestAdapter.isTestFile(project, path.join(dir, p), fs), p).toBe(false);
});
