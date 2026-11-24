import path from 'node:path';
import { expect, test } from 'vitest';
import { c8BinPath, nodeGenericAdapter } from '../../../src/adapters/nodeGeneric';
import type { FsReader, PlanContext, Project } from '../../../src/adapters/types';
import { DEFAULT_SETTINGS, type Settings } from '../../../src/settings';
import { memoryFs } from './memoryFs';

const dir = path.resolve('/w/app');
const pkgFile = path.join(dir, 'package.json');
const tmp = path.resolve('/tmp/ct-1');
const c8 = path.resolve('/ext/node_modules/c8/bin/c8.js');
const PLACEHOLDER = 'echo "Error: no test specified" && exit 1';
const C8_ARGS = [c8, '--reporter=json', `--reports-dir=${tmp}`, `--temp-directory=${path.join(tmp, 'v8')}`];
const HINT = 'No coverage report was produced. Coverage for this project is collected with c8, which needs Node.js 18 or later.';
const OWN_TOOL_HINT = 'The test script runs its own coverage tool but wrote no report the extension can read. Add an "lcov" or "json" reporter.';

function pkg(value: object): string {
  return JSON.stringify(value);
}

function ctx(fs: FsReader, settings: Partial<Settings> = {}): PlanContext {
  return {
    tmpDir: tmp, fs, settings: { ...DEFAULT_SETTINGS, ...settings }, c8Bin: c8,
    probe: async () => ({ code: 0, stdout: '' }),
  };
}

async function detected(files: Record<string, string>, candidate = pkgFile): Promise<Project | undefined> {
  return nodeGenericAdapter.detect(candidate, memoryFs(files));
}

async function projectOf(files: Record<string, string>): Promise<{ project: Project; fs: FsReader }> {
  const fs = memoryFs(files);
  const project = await nodeGenericAdapter.detect(pkgFile, fs);
  if (project === undefined) throw new Error('not detected');
  return { project, fs };
}

test('detects a real test script or a .mocharc.* file; rejects the npm init placeholder', async () => {
  expect(await detected({ [pkgFile]: pkg({ name: 'app', scripts: { test: 'mocha' } }) })).toEqual({
    key: `project:${pkgFile}`, adapter: 'node-generic', ecosystem: 'node', dir, definingFile: pkgFile,
    name: 'app', supportsPartial: false, meta: {},
  });
  expect((await detected({ [pkgFile]: pkg({ scripts: { test: 'node --test' } }) }, dir))?.name).toBe('app');
  for (const ext of ['js', 'cjs', 'mjs', 'json', 'jsonc', 'yaml', 'yml']) {
    expect((await detected({ [pkgFile]: pkg({}), [path.join(dir, `.mocharc.${ext}`)]: '' }))?.adapter, ext).toBe('node-generic');
  }
  expect(await detected({ [pkgFile]: pkg({ scripts: { test: PLACEHOLDER } }) })).toBeUndefined();
  expect(await detected({ [pkgFile]: pkg({ scripts: { test: `  ${PLACEHOLDER} ` } }) })).toBeUndefined();
  expect(await detected({ [pkgFile]: pkg({ scripts: { test: '' } }) })).toBeUndefined();
  expect(await detected({ [pkgFile]: pkg({ scripts: { build: 'tsc' } }) })).toBeUndefined();
  expect(await detected({ [path.join(dir, '.mocharc.json')]: '{}' })).toBeUndefined();
  expect(await detected({ [pkgFile]: '{ not json' })).toBeUndefined();
});

test('Jest and Vitest projects are not generic Node projects', async () => {
  expect(await detected({ [pkgFile]: pkg({ scripts: { test: 'jest' } }) })).toBeUndefined();
  expect(await detected({ [pkgFile]: pkg({ jest: {}, scripts: { test: 'node t.js' } }) })).toBeUndefined();
  expect(await detected({ [pkgFile]: pkg({ scripts: { test: 'vitest run' } }) })).toBeUndefined();
  expect(await detected({ [pkgFile]: pkg({ scripts: { test: 'eslint . && mocha' } }), [path.join(dir, 'vitest.config.ts')]: '' })).toBeUndefined();
});

test('supportsPartial is false', async () => {
  const { project, fs } = await projectOf({ [pkgFile]: pkg({ scripts: { test: 'mocha' } }) });
  expect(project.supportsPartial).toBe(false);
  expect(await nodeGenericAdapter.isTestFile(project, path.join(dir, 'test', 'a.test.js'), fs)).toBe(false);
});

test('full plan wraps the test command in the bundled c8 run by node', async () => {
  const { project, fs } = await projectOf({ [pkgFile]: pkg({ scripts: { test: 'mocha' } }) });
  const plan = await nodeGenericAdapter.plan(project, { kind: 'full' }, ctx(fs));
  expect(plan).toEqual({
    steps: [{ command: 'node', args: [...C8_ARGS, 'npm', 'run', 'test'], cwd: dir }],
    reportSearchDir: tmp,
    hint: HINT,
  });
  const yarn = await projectOf({ [pkgFile]: pkg({ scripts: { test: 'eslint . && mocha' } }), [path.join(dir, 'yarn.lock')]: '' });
  expect((await nodeGenericAdapter.plan(yarn.project, { kind: 'full' }, ctx(yarn.fs, { nodeExtraArgs: ['--bail'] }))).steps).toEqual([
    { command: 'node', args: [...C8_ARGS, 'yarn', 'run', 'test', '--bail'], cwd: dir },
  ]);
  const npmExtra = await projectOf({ [pkgFile]: pkg({ scripts: { test: 'mocha' } }) });
  expect((await nodeGenericAdapter.plan(npmExtra.project, { kind: 'full' }, ctx(npmExtra.fs, { nodeExtraArgs: ['--bail'] }))).steps[0].args)
    .toEqual([...C8_ARGS, 'npm', 'run', 'test', '--', '--bail']);
});

test('without a script but with .mocharc.*, the wrapped command is the local mocha binary', async () => {
  const npm = await projectOf({ [pkgFile]: pkg({}), [path.join(dir, '.mocharc.yml')]: '' });
  expect((await nodeGenericAdapter.plan(npm.project, { kind: 'full' }, ctx(npm.fs))).steps).toEqual([
    { command: 'node', args: [...C8_ARGS, 'npx', '--no-install', 'mocha'], cwd: dir },
  ]);
  const pnpm = await projectOf({ [pkgFile]: pkg({ scripts: { test: PLACEHOLDER } }), [path.join(dir, '.mocharc.json')]: '', [path.join(dir, 'pnpm-lock.yaml')]: '' });
  expect((await nodeGenericAdapter.plan(pnpm.project, { kind: 'full' }, ctx(pnpm.fs))).steps[0].args).toEqual([...C8_ARGS, 'pnpm', 'exec', 'mocha']);
});

test('a script that already calls nyc or c8 is run unwrapped and the report is searched in the project', async () => {
  for (const test of ['nyc --reporter=lcov mocha', 'c8 node --test', 'cross-env NODE_ENV=test nyc mocha', 'npx nyc mocha',
    './node_modules/.bin/c8 --reporter=lcov mocha', 'mocha && nyc report --reporter=lcov', 'npm run cov', 'yarn cov']) {
    const { project, fs } = await projectOf({ [pkgFile]: pkg({ scripts: { test, cov: 'nyc mocha' } }) });
    const plan = await nodeGenericAdapter.plan(project, { kind: 'full' }, ctx(fs));
    expect(plan, test).toEqual({ steps: [{ command: 'npm', args: ['run', 'test'], cwd: dir }], reportSearchDir: dir, hint: OWN_TOOL_HINT });
  }
  // Paths and names that merely contain nyc or c8 are other tools.
  for (const test of ['my-nyc-thing mocha', 'mocha --reporter nyc-like', 'node scripts/c8.js', 'mocha test/nyc']) {
    const { project, fs } = await projectOf({ [pkgFile]: pkg({ scripts: { test } }) });
    expect((await nodeGenericAdapter.plan(project, { kind: 'full' }, ctx(fs))).steps[0].command, test).toBe('node');
  }
});

test('the lockfile search stops at project.meta.workspaceFolder', async () => {
  const { project, fs } = await projectOf({ [pkgFile]: pkg({ scripts: { test: 'mocha' } }), [path.resolve('/w/yarn.lock')]: '' });
  expect((await nodeGenericAdapter.plan(project, { kind: 'full' }, ctx(fs))).steps[0].args[C8_ARGS.length]).toBe('yarn');
  const bounded = { ...project, meta: { workspaceFolder: dir } };
  expect((await nodeGenericAdapter.plan(bounded, { kind: 'full' }, ctx(fs))).steps[0].args[C8_ARGS.length]).toBe('npm');
});

test('c8BinPath points into the extension\'s node_modules', () => {
  expect(c8BinPath(path.resolve('/ext'))).toBe(c8);
});
