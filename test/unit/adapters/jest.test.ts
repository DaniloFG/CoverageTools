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

test('partial plan runs exactly the given test files with --runTestsByPath, after extra args', async () => {
  const a = path.join(dir, 'src', 'a.test.js');
  const slug = path.join(dir, 'app', '[slug]', 'page.test.tsx');
  const { project, fs } = await projectOf({
    [pkgFile]: pkg({ scripts: { test: 'jest' } }), [path.join(dir, 'yarn.lock')]: '', [a]: '', [slug]: '',
  });
  const plan = await jestAdapter.plan(project, { kind: 'partial', paths: [a, slug] }, ctx(fs, { nodeExtraArgs: ['--silent'] }));
  expect(plan.steps[0].args).toEqual(['run', 'test', ...COVERAGE_ARGS, '--silent', '--runTestsByPath', 'app/[slug]/page.test.tsx', 'src/a.test.js']);
});

test('partial plan with a positional pattern in the script still runs only the given files', async () => {
  const a = path.join(dir, 'src', 'a.test.js');
  const { project, fs } = await projectOf({ [pkgFile]: pkg({ scripts: { test: 'jest --ci src' } }), [a]: '' });
  const plan = await jestAdapter.plan(project, { kind: 'partial', paths: [a] }, ctx(fs));
  // With --runTestsByPath every positional argument is an exact path, so the script's `src` selects nothing more.
  expect(plan.steps[0].args).toEqual(['run', 'test', '--', ...COVERAGE_ARGS, '--runTestsByPath', 'src/a.test.js']);
});

test('partial plan for a directory passes its test files; an empty directory has no steps', async () => {
  const deep = path.join(dir, 'src', 'deep');
  const { project, fs } = await projectOf({
    [pkgFile]: pkg({ jest: {} }),
    [path.join(deep, 'b.test.js')]: '', [path.join(deep, 'x', '__tests__', 'c.js')]: '', [path.join(deep, 'util.js')]: '',
    [path.join(deep, 'node_modules', 'lib', 'd.test.js')]: '', [path.join(dir, 'docs', 'readme.md')]: '',
  });
  const plan = await jestAdapter.plan(project, { kind: 'partial', paths: [deep] }, ctx(fs));
  expect(plan.steps[0].args).toEqual(['--no-install', 'jest', ...COVERAGE_ARGS, '--runTestsByPath', 'src/deep/b.test.js', 'src/deep/x/__tests__/c.js']);

  const empty = await jestAdapter.plan(project, { kind: 'partial', paths: [path.join(dir, 'docs')] }, ctx(fs));
  expect(empty.steps).toEqual([]);
  expect(empty.hint).toBe('No test files were found in the selected folder.');
});

test('the outer script runs when it forwards arguments; a bare npm redirection carries its env to the target', async () => {
  const forwarded = await projectOf({ [pkgFile]: pkg({ scripts: { test: 'npm run unit -- --ci', unit: 'jest' } }) });
  expect((await jestAdapter.plan(forwarded.project, { kind: 'full' }, ctx(forwarded.fs))).steps[0]).toEqual({
    command: 'npm', args: ['run', 'test', '--', ...COVERAGE_ARGS], cwd: dir, env: { CI: 'true' },
  });
  const yarn = await projectOf({
    [pkgFile]: pkg({ scripts: { test: 'TZ=UTC NODE_ENV=test yarn unit', unit: 'jest' } }), [path.join(dir, 'yarn.lock')]: '',
  });
  expect((await jestAdapter.plan(yarn.project, { kind: 'full' }, ctx(yarn.fs))).steps[0]).toEqual({
    command: 'yarn', args: ['run', 'test', ...COVERAGE_ARGS], cwd: dir, env: { CI: 'true' },
  });
  const bare = await projectOf({ [pkgFile]: pkg({ scripts: { test: 'TZ=UTC NODE_ENV=test npm run unit', unit: 'jest' } }) });
  expect((await jestAdapter.plan(bare.project, { kind: 'full' }, ctx(bare.fs))).steps[0]).toEqual({
    command: 'npm', args: ['run', 'unit', '--', ...COVERAGE_ARGS], cwd: dir, env: { TZ: 'UTC', NODE_ENV: 'test', CI: 'true' },
  });
});

test('a script in watch mode is detected but not used: the local binary runs instead', async () => {
  for (const test of ['jest --watchAll', 'jest --watch', 'yarn unit --watch']) {
    const { project, fs } = await projectOf({ [pkgFile]: pkg({ scripts: { test, unit: 'jest' } }) });
    expect((await jestAdapter.plan(project, { kind: 'full' }, ctx(fs))).steps[0], test).toMatchObject({
      command: 'npx', args: ['--no-install', 'jest', ...COVERAGE_ARGS],
    });
  }
});

test('the lockfile search stops at project.meta.workspaceFolder', async () => {
  const fs = memoryFs({ [pkgFile]: pkg({ jest: {} }), [path.resolve('/w/yarn.lock')]: '' });
  const project = await jestAdapter.detect(pkgFile, fs);
  if (project === undefined) throw new Error('not detected');
  expect((await jestAdapter.plan(project, { kind: 'full' }, ctx(fs))).steps[0].command).toBe('yarn');
  const bounded = { ...project, meta: { workspaceFolder: dir } };
  expect((await jestAdapter.plan(bounded, { kind: 'full' }, ctx(fs))).steps[0].command).toBe('npx');
});

test('isTestFile follows the default Jest patterns including .mjs/.cjs/.mts/.cts', async () => {
  const { project, fs } = await projectOf({ [pkgFile]: pkg({ jest: {} }) });
  const yes = ['src/a.test.js', 'src/a.spec.jsx', 'a.test.ts', 'a.test.tsx', 'a.test.mjs', 'a.test.cjs', 'a.test.mts', 'a.test.cts', 'src/__tests__/x.js'];
  const no = ['src/a.js', 'src/a.test.json', 'node_modules/lib/a.test.js', '../other/a.test.js'];
  for (const p of yes) expect(await jestAdapter.isTestFile(project, path.join(dir, p), fs), p).toBe(true);
  for (const p of no) expect(await jestAdapter.isTestFile(project, path.join(dir, p), fs), p).toBe(false);
});

test('a selection too long for one command line is split into several runs, each with its own coverage directory', async () => {
  const names = Array.from({ length: 6 }, (_, i) => `src/module-number-${i}.test.ts`);
  const abs = (rel: string): string => path.join(dir, ...rel.split('/'));
  const { project, fs } = await projectOf({ [pkgFile]: pkg({ scripts: { test: 'jest' } }), ...Object.fromEntries(names.map(n => [abs(n), ''])) });
  const small: PlanContext = { ...ctx(fs), commandLineLimit: 250 };
  const plan = await jestAdapter.plan(project, { kind: 'partial', paths: [path.join(dir, 'src')] }, small);
  expect(plan.steps.length).toBeGreaterThan(1);
  expect(plan.unionReports).toBe(true);
  const files = plan.steps.flatMap(s => s.args.slice(s.args.indexOf('--runTestsByPath') + 1));
  expect(files).toEqual(names);
  const dirs = plan.steps.map(s => s.args.find(a => a.startsWith('--coverageDirectory='))!);
  expect(new Set(dirs).size).toBe(plan.steps.length);
  for (const d of dirs) expect(d.startsWith(`--coverageDirectory=${tmp}`)).toBe(true);
  for (const s of plan.steps) expect(s.args.join(' ').length).toBeLessThanOrEqual(250);
  // A selection that fits stays one step with the plain coverage directory.
  const roomy = await jestAdapter.plan(project, { kind: 'partial', paths: [path.join(dir, 'src')] }, { ...ctx(fs), commandLineLimit: 100_000 });
  expect(roomy.steps).toHaveLength(1);
  expect(roomy.unionReports).toBeUndefined();
  expect(roomy.steps[0].args).toContain(`--coverageDirectory=${tmp}`);
});
