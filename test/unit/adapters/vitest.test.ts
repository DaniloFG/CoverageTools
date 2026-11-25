import path from 'node:path';
import { expect, test } from 'vitest';
import type { FsReader, PlanContext, Project } from '../../../src/adapters/types';
import { vitestAdapter } from '../../../src/adapters/vitest';
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
  return vitestAdapter.detect(candidate, memoryFs(files));
}

async function projectOf(files: Record<string, string>): Promise<{ project: Project; fs: FsReader }> {
  const fs = memoryFs(files);
  const project = await vitestAdapter.detect(pkgFile, fs);
  if (project === undefined) throw new Error('not detected');
  return { project, fs };
}

// --coverage.reportOnFailure: Vitest 4 writes no report when a test fails unless asked to.
const COVERAGE_ARGS = ['--coverage', '--coverage.reporter=json', `--coverage.reportsDirectory=${tmp}`, '--coverage.reportOnFailure'];
const HINT = 'Vitest did not write a coverage report. Install its coverage provider: "@vitest/coverage-v8".';

test('detects by vitest.config.*, a test block in vite.config.*, or a test script that ends in vitest', async () => {
  const byScript = await detected({ [pkgFile]: pkg({ name: 'app', scripts: { test: 'vitest' } }) });
  expect(byScript).toEqual({
    key: `project:${pkgFile}`, adapter: 'vitest', ecosystem: 'node', dir, definingFile: pkgFile,
    name: 'app', supportsPartial: true, meta: {},
  });
  expect((await detected({ [pkgFile]: pkg({ scripts: { test: 'cross-env TZ=UTC vitest run' } }) }))?.adapter).toBe('vitest');
  expect((await detected({ [pkgFile]: pkg({ scripts: { test: 'npm run unit', unit: 'vitest --run' } }) }))?.adapter).toBe('vitest');
  for (const ext of ['ts', 'mts', 'cts', 'js', 'mjs', 'cjs']) {
    expect((await detected({ [pkgFile]: pkg({}), [path.join(dir, `vitest.config.${ext}`)]: '' }))?.adapter, ext).toBe('vitest');
  }
  const viteWithTest = 'import { defineConfig } from "vite";\nexport default defineConfig({\n  plugins: [],\n  test: { environment: "jsdom" },\n});\n';
  for (const ext of ['ts', 'mts', 'js', 'mjs']) {
    expect((await detected({ [pkgFile]: pkg({}), [path.join(dir, `vite.config.${ext}`)]: viteWithTest }))?.adapter, ext).toBe('vitest');
  }
  // A vite.config without a test block is a plain Vite app.
  const viteOnly = 'export default { plugins: [], build: { outDir: "dist" } };\n';
  expect(await detected({ [pkgFile]: pkg({}), [path.join(dir, 'vite.config.ts')]: viteOnly })).toBeUndefined();
  // A directory candidate reads its package.json; the name defaults to the directory's.
  expect((await detected({ [pkgFile]: pkg({ scripts: { test: 'vitest' } }) }, dir))?.name).toBe('app');
  expect(await detected({ [pkgFile]: pkg({ scripts: { test: 'jest' } }) })).toBeUndefined();
  expect(await detected({ [pkgFile]: pkg({ scripts: { test: 'vitest-something' } }) })).toBeUndefined();
  expect(await detected({ [pkgFile]: pkg({ devDependencies: { vitest: '^4.0.0' }, scripts: { test: 'node t.js' } }) })).toBeUndefined();
  expect(await detected({ [pkgFile]: '{ not json' })).toBeUndefined();
  expect(await detected({})).toBeUndefined();
});

test('full plan passes --coverage, --coverage.reporter=json and --coverage.reportsDirectory=<tmp> with CI=true', async () => {
  const { project, fs } = await projectOf({ [pkgFile]: pkg({ scripts: { test: 'vitest' } }) });
  const plan = await vitestAdapter.plan(project, { kind: 'full' }, ctx(fs));
  expect(plan.steps).toEqual([{ command: 'npm', args: ['run', 'test', '--', ...COVERAGE_ARGS], cwd: dir, env: { CI: 'true' } }]);
  expect(plan.reportSearchDir).toBe(tmp);
  expect(plan.hint).toBe(HINT);

  const yarn = await projectOf({ [pkgFile]: pkg({ scripts: { test: 'yarn run unit', unit: 'vitest run' } }), [path.join(dir, 'yarn.lock')]: '' });
  expect((await vitestAdapter.plan(yarn.project, { kind: 'full' }, ctx(yarn.fs))).steps).toEqual([
    // yarn forwards appended arguments, so the outer script runs, keeping whatever it adds.
    { command: 'yarn', args: ['run', 'test', ...COVERAGE_ARGS], cwd: dir, env: { CI: 'true' } },
  ]);
});

test('when calling the local binary, the "run" subcommand is used', async () => {
  const npm = await projectOf({ [pkgFile]: pkg({ scripts: { test: 'vitest && eslint .' } }), [path.join(dir, 'vitest.config.ts')]: '' });
  expect((await vitestAdapter.plan(npm.project, { kind: 'full' }, ctx(npm.fs, { nodeExtraArgs: ['--silent'] }))).steps).toEqual([
    { command: 'npx', args: ['--no-install', 'vitest', 'run', ...COVERAGE_ARGS, '--silent'], cwd: dir, env: { CI: 'true' } },
  ]);
  const yarn = await projectOf({ [pkgFile]: pkg({}), [path.join(dir, 'vitest.config.ts')]: '', [path.join(dir, 'yarn.lock')]: '' });
  expect((await vitestAdapter.plan(yarn.project, { kind: 'full' }, ctx(yarn.fs))).steps[0]).toMatchObject({
    command: 'yarn', args: ['vitest', 'run', ...COVERAGE_ARGS],
  });
  const pnpm = await projectOf({ [pkgFile]: pkg({}), [path.join(dir, 'vitest.config.ts')]: '', [path.join(dir, 'pnpm-lock.yaml')]: '' });
  expect((await vitestAdapter.plan(pnpm.project, { kind: 'full' }, ctx(pnpm.fs))).steps[0]).toMatchObject({
    command: 'pnpm', args: ['exec', 'vitest', 'run', ...COVERAGE_ARGS],
  });
});

test('partial plan appends relative paths after extra args', async () => {
  const a = path.join(dir, 'src', 'a.test.ts');
  const deep = path.join(dir, 'src', 'deep');
  const { project, fs } = await projectOf({
    [pkgFile]: pkg({ scripts: { test: 'vitest' } }), [a]: '', [path.join(deep, 'b.test.ts')]: '', [path.join(deep, 'c.ts')]: '',
  });
  const plan = await vitestAdapter.plan(project, { kind: 'partial', paths: [a, deep] }, ctx(fs, { nodeExtraArgs: ['--silent'] }));
  expect(plan.steps[0].args).toEqual(['run', 'test', '--', ...COVERAGE_ARGS, '--silent', 'src/a.test.ts', 'src/deep/b.test.ts']);
});

test('partial plan excludes every other test file whose path contains a selected one', async () => {
  // Vitest's filters are case-insensitive substrings of the relative path.
  const files = ['src/calc.test.ts', 'extra/src/calc.test.ts', 'src/calc.test.tsx', 'SRC/Calc.test.ts', 'src/other.test.ts', 'app/[slug]/src/calc.test.ts'];
  const abs = (rel: string): string => path.join(dir, ...rel.split('/'));
  const { project, fs } = await projectOf({
    [pkgFile]: pkg({ scripts: { test: 'vitest' } }), ...Object.fromEntries(files.map(f => [abs(f), ''])),
    [path.join(dir, 'node_modules', 'x', 'src', 'calc.test.ts')]: '',
  });
  const plan = await vitestAdapter.plan(project, { kind: 'partial', paths: [abs('src/calc.test.ts')] }, ctx(fs));
  expect(plan.steps[0].args).toEqual([
    'run', 'test', '--', ...COVERAGE_ARGS,
    '--exclude=SRC/Calc.test.ts', '--exclude=app/\\[slug\\]/src/calc.test.ts', '--exclude=extra/src/calc.test.ts', '--exclude=src/calc.test.tsx',
    'src/calc.test.ts',
  ]);
});

test('partial plan for a folder without test files has no steps', async () => {
  const { project, fs } = await projectOf({ [pkgFile]: pkg({ scripts: { test: 'vitest' } }), [path.join(dir, 'docs', 'a.md')]: '' });
  const plan = await vitestAdapter.plan(project, { kind: 'partial', paths: [path.join(dir, 'docs')] }, ctx(fs));
  expect(plan.steps).toEqual([]);
  expect(plan.hint).toBe('No test files were found in the selected folder.');
});

test('a script in watch mode is detected but not used: the local binary runs instead', async () => {
  for (const test of ['vitest watch', 'vitest dev', 'vitest --watch', 'vitest -w', 'yarn unit --watch']) {
    const { project, fs } = await projectOf({ [pkgFile]: pkg({ scripts: { test, unit: 'vitest' } }) });
    expect((await vitestAdapter.plan(project, { kind: 'full' }, ctx(fs))).steps[0], test).toMatchObject({
      command: 'npx', args: ['--no-install', 'vitest', 'run', ...COVERAGE_ARGS],
    });
  }
});

test('a bare npm redirection carries its env to the target script', async () => {
  const { project, fs } = await projectOf({ [pkgFile]: pkg({ scripts: { test: 'TZ=UTC npm run unit', unit: 'vitest run' } }) });
  expect((await vitestAdapter.plan(project, { kind: 'full' }, ctx(fs))).steps[0]).toEqual({
    command: 'npm', args: ['run', 'unit', '--', ...COVERAGE_ARGS], cwd: dir, env: { TZ: 'UTC', CI: 'true' },
  });
});

test('the lockfile search stops at project.meta.workspaceFolder', async () => {
  const { project, fs } = await projectOf({ [pkgFile]: pkg({ scripts: { test: 'vitest' } }), [path.resolve('/w/yarn.lock')]: '' });
  expect((await vitestAdapter.plan(project, { kind: 'full' }, ctx(fs))).steps[0].command).toBe('yarn');
  const bounded = { ...project, meta: { workspaceFolder: dir } };
  expect((await vitestAdapter.plan(bounded, { kind: 'full' }, ctx(fs))).steps[0].command).toBe('npm');
});

test('isTestFile follows the default Vitest patterns', async () => {
  const { project, fs } = await projectOf({ [pkgFile]: pkg({ scripts: { test: 'vitest' } }) });
  const yes = ['src/a.test.ts', 'src/a.spec.tsx', 'a.test.js', 'a.test.mts', 'a.spec.cjs', 'src/__tests__/x.test.ts'];
  // Vitest's default include is only **/*.{test,spec}.?(c|m)[jt]s?(x): a plain file under __tests__ never runs.
  const no = ['src/a.ts', 'src/a.test.json', 'src/__tests__/x.ts', 'node_modules/lib/a.test.ts', '../other/a.test.ts'];
  for (const p of yes) expect(await vitestAdapter.isTestFile(project, path.join(dir, p), fs), p).toBe(true);
  for (const p of no) expect(await vitestAdapter.isTestFile(project, path.join(dir, p), fs), p).toBe(false);
});

test('a partial selection of files Vitest never runs has no steps', async () => {
  const plain = path.join(dir, 'src', '__tests__', 'x.ts');
  const { project, fs } = await projectOf({ [pkgFile]: pkg({ scripts: { test: 'vitest' } }), [plain]: '' });
  for (const paths of [[plain], [path.dirname(plain)]]) {
    const plan = await vitestAdapter.plan(project, { kind: 'partial', paths }, ctx(fs));
    expect(plan.steps).toEqual([]);
    expect(plan.hint).toBe('No test files were found in the selected folder.');
  }
});

test('only a top-level test key of a vite.config counts, outside comments', async () => {
  const viteOf = async (text: string) => detected({ [pkgFile]: pkg({}), [path.join(dir, 'vite.config.ts')]: text });
  expect((await viteOf('export default defineConfig(() => ({ plugins: [react()], test: { globals: true } }));'))?.adapter).toBe('vitest');
  expect((await viteOf("export default {\n  'test': {},\n};"))?.adapter).toBe('vitest');
  expect(await viteOf('export default { build: { rollupOptions: { input: { main: "a.html", test: "t.html" } } } };')).toBeUndefined();
  expect(await viteOf('export default {\n  // test: { environment: "jsdom" },\n  plugins: [],\n};')).toBeUndefined();
  expect(await viteOf('export default {\n  /* test: {} */ plugins: [],\n};')).toBeUndefined();
  expect(await viteOf('export default { plugins: [foo({ test: true })] };')).toBeUndefined();
  expect(await viteOf('export default { define: { "process.env.X": JSON.stringify("test: 1") } };')).toBeUndefined();
});

test('a vitest bench script is not a test script', async () => {
  expect(await detected({ [pkgFile]: pkg({ scripts: { test: 'vitest bench' } }) })).toBeUndefined();
  const { project, fs } = await projectOf({ [pkgFile]: pkg({ scripts: { test: 'vitest bench --run' } }), [path.join(dir, 'vitest.config.ts')]: '' });
  expect((await vitestAdapter.plan(project, { kind: 'full' }, ctx(fs))).steps[0]).toMatchObject({
    command: 'npx', args: ['--no-install', 'vitest', 'run', ...COVERAGE_ARGS],
  });
});
