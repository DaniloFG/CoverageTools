import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { readProjectFacts, hasTestAttributes } from '../../src/adapters/dotnetShared';
import { dotnetVstestAdapter } from '../../src/adapters/dotnetVstest';
import { ADAPTERS } from '../../src/adapters/index';
import { jestAdapter } from '../../src/adapters/jest';
import { nodeGenericAdapter } from '../../src/adapters/nodeGeneric';
import { pythonAdapter } from '../../src/adapters/python';
import type { Adapter, FsReader, Project } from '../../src/adapters/types';
import { vitestAdapter } from '../../src/adapters/vitest';
import { discover, refreshFile, resolveTarget, type DiscoveryState } from '../../src/discovery';
import { DEFAULT_SETTINGS, type Settings } from '../../src/settings';
import { nodeFsReader } from '../e2e/helpers';

/**
 * Stands in for the MTP adapter until it exists: a test project on Microsoft.Testing.Platform, with
 * partial runs only when its framework is known.
 */
const fakeMtpAdapter: Adapter = {
  id: 'dotnet-mtp',
  ecosystem: 'dotnet',
  async detect(candidate, fs) {
    if (!candidate.toLowerCase().endsWith('.csproj')) return undefined;
    const facts = await readProjectFacts(candidate, fs);
    if (!facts.isTest || !facts.usesMtp) return undefined;
    return {
      key: `project:${candidate}`, adapter: 'dotnet-mtp', ecosystem: 'dotnet', dir: path.dirname(candidate), definingFile: candidate,
      name: path.basename(candidate, '.csproj'), supportsPartial: facts.framework !== undefined, meta: {},
    };
  },
  async isTestFile(_project, file, fs) {
    const text = file.endsWith('.cs') ? await fs.readText(file) : undefined;
    return text !== undefined && hasTestAttributes(text);
  },
  async plan() {
    throw new Error('not used');
  },
};

const adapters: readonly Adapter[] = [jestAdapter, vitestAdapter, nodeGenericAdapter, pythonAdapter, dotnetVstestAdapter, fakeMtpAdapter];

const JEST = (name: string) => JSON.stringify({ name, scripts: { test: 'jest' } });
const VITEST = (name: string) => JSON.stringify({ name, scripts: { test: 'vitest' } });
const MOCHA = (name: string) => JSON.stringify({ name, scripts: { test: 'mocha' } });
const VSTEST_CSPROJ =
  '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.0.0" />' +
  '<PackageReference Include="xunit" Version="2.9.0" /></ItemGroup></Project>';
const MTP_UNKNOWN_CSPROJ =
  '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><IsTestProject>true</IsTestProject>' +
  '<UseMicrosoftTestingPlatformRunner>true</UseMicrosoftTestingPlatformRunner></PropertyGroup></Project>';
const LIBRARY_CSPROJ = '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>';
const TEST_CS = 'public class CalcTests { [Fact] public void Adds() { } }';
const HELPER_CS = 'public static class Helper { /* [Fact] */ public static string S = "[Fact]"; }';
const PY_TEST = 'def test_a():\n    assert True\n';
const sln = (...csprojs: string[]) =>
  csprojs.map((p, i) => `Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "P${i}", "${p}", "{${i}}"\nEndProject\n`).join('');

const temps: string[] = [];
afterEach(async () => {
  await Promise.all(temps.splice(0).map(t => rm(t, { recursive: true, force: true })));
});

/** Writes `files` (POSIX paths relative to a new temp directory) and returns the directory. */
async function tree(files: Record<string, string>, prefix = 'ct-discovery-'): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  temps.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, ...rel.split('/'));
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content);
  }
  return root;
}

function settings(overrides: Partial<Settings> = {}): Settings {
  return { ...DEFAULT_SETTINGS, exclude: [...DEFAULT_SETTINGS.exclude], commands: {}, ...overrides };
}

/** A node:fs reader that counts its calls. */
function countingFs(): FsReader & { finds: string[]; reads: string[] } {
  const fs = nodeFsReader();
  const finds: string[] = [];
  const reads: string[] = [];
  return {
    finds,
    reads,
    readText: p => {
      reads.push(p);
      return fs.readText(p);
    },
    exists: p => fs.exists(p),
    find: (dir, include, exclude) => {
      finds.push(dir);
      return fs.find(dir, include, exclude);
    },
  };
}

async function run(folders: string[], s: Settings | ((folder: string) => Settings) = settings(), fs: FsReader = nodeFsReader()) {
  return discover(folders, fs, typeof s === 'function' ? s : () => s, adapters);
}

function summary(state: DiscoveryState, root: string): Array<[string, string]> {
  return state.projects.map(p => [p.adapter, path.relative(root, p.dir).split(path.sep).join('/') || '.']);
}

const at = (root: string, rel: string) => path.join(root, ...rel.split('/'));

test('the registry lists the adapters that exist, in the order jest, vitest, node-generic, python, dotnet-vstest, dotnet-mtp', () => {
  const order = ['jest', 'vitest', 'node-generic', 'python', 'dotnet-vstest', 'dotnet-mtp'];
  const ids = ADAPTERS.map(a => a.id);
  expect(ids.slice(0, 5)).toEqual(order.slice(0, 5));
  expect(ids.every((id, i) => i === 0 || order.indexOf(id) > order.indexOf(ids[i - 1]))).toBe(true);
});

test('finds one project per ecosystem in a mixed workspace', async () => {
  const root = await tree({
    'web/package.json': JEST('web'),
    'web/src/a.test.ts': '',
    'py/pyproject.toml': '[project]\nname = "py"\n',
    'py/tests/test_a.py': PY_TEST,
    'net/Tests/Tests.csproj': VSTEST_CSPROJ,
    'net/Tests/CalcTests.cs': TEST_CS,
  });
  const state = await run([root]);
  expect(summary(state, root)).toEqual([
    ['dotnet-vstest', 'net/Tests'],
    ['python', 'py'],
    ['jest', 'web'],
  ]);
  for (const p of state.projects) expect(p.meta.workspaceFolder).toBe(root);
  expect(state.folders).toEqual([root]);
});

test('excluded directories are never searched', async () => {
  const root = await tree({
    'package.json': JSON.stringify({ name: 'root' }),
    'node_modules/dep/package.json': JEST('dep'),
    'node_modules/dep/a.test.js': '',
    'vendor/lib/package.json': JEST('vendored'),
    'src/bin/x/test_a.py': PY_TEST,
  });
  expect((await run([root])).projects.map(p => p.name)).toEqual(['vendored']);
  const custom = await run([root], settings({ exclude: [...DEFAULT_SETTINGS.exclude, '**/vendor/**'] }));
  expect(custom.projects).toEqual([]);
  expect(custom.runnablePaths.size).toBe(0);
});

test('lightness: one search per workspace folder plus one per partial Node or .NET test project, each file read once', async () => {
  const root = await tree({
    'a/package.json': JEST('a'),
    'b/package.json': MOCHA('b'),
    'py1/setup.py': '',
    'py1/test_x.py': PY_TEST,
    'py2/tox.ini': '',
    'py2/t/test_y.py': PY_TEST,
    'Directory.Build.props': '<Project></Project>',
    'net/T1/T1.csproj': VSTEST_CSPROJ,
    'net/T2/T2.csproj': VSTEST_CSPROJ,
    'net/Lib/Lib.csproj': LIBRARY_CSPROJ,
  });
  const fs = countingFs();
  const state = await run([root], settings(), fs);
  expect(state.projects).toHaveLength(6);
  // The folder, Jest project a, .NET T1 and T2; node-generic b and the Python projects need no search.
  expect(fs.finds.sort()).toEqual([root, at(root, 'a'), at(root, 'net/T1'), at(root, 'net/T2')].sort());
  const duplicates = fs.reads.filter((p, i) => fs.reads.indexOf(p) !== i);
  expect(duplicates).toEqual([]);
});

test('.cs files are read in batches with the event loop free in between, and their answer is cached by mtime', async () => {
  const files: Record<string, string> = { 'T/T.csproj': VSTEST_CSPROJ };
  for (let i = 0; i < 45; i++) files[`T/F${String(i).padStart(2, '0')}.cs`] = i % 2 === 0 ? TEST_CS : HELPER_CS;
  const root = await tree(files);
  const fs = countingFs();
  let stopped = false;
  let readsAtFirstYield = -1;
  const tick = (): void => {
    setImmediate(() => {
      if (readsAtFirstYield < 0 && fs.reads.some(r => r.endsWith('.cs'))) readsAtFirstYield = fs.reads.filter(r => r.endsWith('.cs')).length;
      if (!stopped) tick();
    });
  };
  tick();
  const mtimes = new Map<string, number>();
  const statMtime = async (p: string) => mtimes.get(p) ?? 1;
  const cache = new Map();
  const state = await discover([root], fs, () => settings(), adapters, { statMtime, testFileCache: cache });
  stopped = true;
  expect(state.testFiles.get(state.projects[0].key)).toHaveLength(23);
  expect(readsAtFirstYield).toBeGreaterThan(0);
  expect(readsAtFirstYield).toBeLessThanOrEqual(20);

  const csReads = () => fs.reads.filter(r => r.endsWith('.cs')).length;
  const before = csReads();
  await discover([root], fs, () => settings(), adapters, { statMtime, testFileCache: cache });
  expect(csReads()).toBe(before); // all answered from the cache
  mtimes.set(at(root, 'T/F01.cs'), 2);
  await discover([root], fs, () => settings(), adapters, { statMtime, testFileCache: cache });
  expect(csReads()).toBe(before + 1);
  // Without statMtime every discovery reads the files again.
  await discover([root], fs, () => settings(), adapters);
  expect(csReads()).toBe(before + 1 + 45);
});

test('in one Node directory the order is custom, jest, vitest, node-generic', async () => {
  const both = JSON.stringify({ name: 'both', scripts: { test: 'jest' } });
  const root = await tree({
    'both/package.json': both,
    'both/vitest.config.ts': 'export default {}',
    'vite/package.json': JSON.stringify({ name: 'vite', scripts: { test: 'mocha' } }),
    'vite/vitest.config.mjs': 'export default {}',
    'plain/package.json': MOCHA('plain'),
    'custom/package.json': JEST('custom'),
  });
  const state = await run([root], settings({ commands: { custom: 'make cov' } }));
  expect(summary(state, root)).toEqual([
    ['jest', 'both'],
    ['custom', 'custom'],
    ['node-generic', 'plain'],
    ['vitest', 'vite'],
  ]);
});

test('nested Node projects: inner by default, outer with nestedProjects "outer"', async () => {
  const files = {
    'package.json': JSON.stringify({ name: 'mono', private: true, workspaces: ['packages/*'], scripts: { test: 'yarn workspaces run test' } }),
    'yarn.lock': '',
    'packages/a/package.json': JEST('a'),
    'packages/a/src/a.test.js': '',
    'packages/b/package.json': JEST('b'),
    'packages/b/__tests__/b.js': '',
  };
  const root = await tree(files);
  const inner = await run([root]);
  expect(summary(inner, root)).toEqual([
    ['jest', 'packages/a'],
    ['jest', 'packages/b'],
  ]);
  expect(inner.runnablePaths.has(at(root, 'package.json'))).toBe(false);
  expect(inner.runnablePaths.has(root)).toBe(true);
  expect(resolveTarget(root, true, inner).map(t => t.project.name)).toEqual(['a', 'b']);

  const outer = await run([root], settings({ nestedProjects: 'outer' }));
  expect(summary(outer, root)).toEqual([['node-generic', '.']]);
  expect(outer.runnablePaths.has(at(root, 'package.json'))).toBe(true);
  // The outer project runs as a whole only: the test files of the packages are not runnable on their own.
  expect(outer.runnablePaths.has(at(root, 'packages/a/src/a.test.js'))).toBe(false);
  expect(resolveTarget(at(root, 'packages/a'), true, outer)).toEqual([]);
});

test('nesting is per ecosystem: a Python project inside a Node project keeps both', async () => {
  const root = await tree({
    'package.json': JEST('web'),
    'src/a.test.ts': '',
    'scripts/py/pyproject.toml': '',
    'scripts/py/test_tool.py': PY_TEST,
  });
  for (const nestedProjects of ['inner', 'outer'] as const) {
    const state = await run([root], settings({ nestedProjects }));
    expect(summary(state, root)).toEqual([
      ['jest', '.'],
      ['python', 'scripts/py'],
    ]);
  }
});

test('nested Python projects follow the nesting rule too', async () => {
  const root = await tree({
    'pyproject.toml': '',
    'test_root.py': PY_TEST,
    'sub/setup.cfg': '',
    'sub/test_sub.py': PY_TEST,
  });
  expect(summary(await run([root]), root)).toEqual([['python', 'sub']]);
  const outer = await run([root], settings({ nestedProjects: 'outer' }));
  expect(summary(outer, root)).toEqual([['python', '.']]);
  expect([...outer.testFiles.values()][0]).toEqual([at(root, 'sub/test_sub.py'), at(root, 'test_root.py')]);
});

test('.NET projects are never dropped by the nesting rule', async () => {
  const root = await tree({
    'Outer/Outer.csproj': VSTEST_CSPROJ,
    'Outer/OuterTests.cs': TEST_CS,
    'Outer/Inner/Inner.csproj': VSTEST_CSPROJ,
    'Outer/Inner/InnerTests.cs': TEST_CS,
  });
  for (const nestedProjects of ['inner', 'outer'] as const) {
    const state = await run([root], settings({ nestedProjects }));
    expect(summary(state, root)).toEqual([
      ['dotnet-vstest', 'Outer'],
      ['dotnet-vstest', 'Outer/Inner'],
    ]);
    const outer = state.projects[0];
    // Each .cs file belongs to the nearest project.
    expect(state.testFiles.get(outer.key)).toEqual([at(root, 'Outer/OuterTests.cs')]);
  }
});

test('Python: the project is the nearest marker directory above the test files; with no marker, the workspace folder', async () => {
  const withMarker = await tree({
    'svc/pytest.ini': '[pytest]\n',
    'svc/tests/unit/test_a.py': PY_TEST,
    'svc/tests/b_test.py': PY_TEST,
  });
  const a = await run([withMarker]);
  expect(summary(a, withMarker)).toEqual([['python', 'svc']]);
  expect(a.projects[0].definingFile).toBe(at(withMarker, 'svc/pytest.ini'));
  expect(a.testFiles.get(a.projects[0].key)).toEqual([at(withMarker, 'svc/tests/b_test.py'), at(withMarker, 'svc/tests/unit/test_a.py')]);

  const noMarker = await tree({ 'tests/test_a.py': PY_TEST, 'pkg/x/test_b.py': PY_TEST, 'pkg/mod.py': '' });
  const b = await run([noMarker]);
  expect(summary(b, noMarker)).toEqual([['python', '.']]);
  expect(b.projects[0].definingFile).toBeUndefined();
});

test('a custom command directory becomes a project and suppresses every discovered project inside it', async () => {
  const root = await tree({
    'legacy/package.json': JEST('legacy-web'),
    'legacy/web/package.json': JEST('legacy-inner'),
    'legacy/web/a.test.js': '',
    'legacy/py/pyproject.toml': '',
    'legacy/py/test_a.py': PY_TEST,
    'legacy/net/T.csproj': VSTEST_CSPROJ,
    'other/package.json': JEST('other'),
    'empty/.keep': '',
  });
  const state = await run([root], settings({ commands: { legacy: 'make coverage', missing: 'make x', empty: '  ' } }));
  expect(summary(state, root)).toEqual([
    ['custom', 'legacy'],
    ['jest', 'other'],
  ]);
  const custom = state.projects[0];
  expect(custom).toMatchObject({ ecosystem: 'custom', supportsPartial: false, meta: { command: 'make coverage', workspaceFolder: root } });
  expect(state.runnablePaths.has(at(root, 'legacy'))).toBe(true);
  expect(state.runnablePaths.has(at(root, 'legacy/web'))).toBe(false);
  expect(state.runnablePaths.has(at(root, 'legacy/web/a.test.js'))).toBe(false);
  expect(state.runnablePaths.has(at(root, 'legacy/py/test_a.py'))).toBe(false);
  expect(resolveTarget(at(root, 'legacy'), true, state)).toEqual([{ project: custom, target: { kind: 'full' } }]);
});

test('custom command keys are relative to their own workspace folder in a multi-root workspace', async () => {
  const one = await tree({ 'tools/x.txt': '', 'app/package.json': JEST('one-app') });
  const two = await tree({ 'tools/y.txt': '', 'app/package.json': JEST('two-app') });
  const byFolder = new Map([
    [one, settings({ commands: { tools: 'one-cmd' } })],
    [two, settings({ commands: { app: 'two-cmd' } })],
  ]);
  const state = await run([one, two], f => byFolder.get(f) ?? settings());
  expect(state.projects.map(p => [p.adapter, p.dir, p.meta.workspaceFolder])).toEqual([
    ['jest', at(one, 'app'), one],
    ['custom', at(one, 'tools'), one],
    ['custom', at(two, 'app'), two],
  ]);
  expect(state.projects[2].meta.command).toBe('two-cmd');
  expect(state.folders).toEqual([one, two]);
  expect(resolveTarget(two, true, state).map(t => t.project.meta.command)).toEqual(['two-cmd']);
});

test('paths with spaces and non-ASCII characters', async () => {
  const root = await tree(
    {
      'cliente web/package.json': JEST('café'),
      'cliente web/src/ação.test.ts': '',
      'serviço py/pyproject.toml': '',
      'serviço py/testes/test_ação.py': PY_TEST,
      'Testes Ünit/Testes Ünit.csproj': VSTEST_CSPROJ,
      'Testes Ünit/Cálculo Tests.cs': TEST_CS,
      'Solução.sln': sln('Testes Ünit\\Testes Ünit.csproj'),
    },
    'ct dïscovery ',
  );
  const state = await run([root], settings({ commands: { 'ferramentas ç': 'run "${coverageDir}"' } }));
  expect(summary(state, root)).toEqual([
    ['dotnet-vstest', 'Testes Ünit'],
    ['jest', 'cliente web'],
    ['python', 'serviço py'],
  ]);
  for (const p of [
    'cliente web/src/ação.test.ts',
    'cliente web/src',
    'serviço py/testes/test_ação.py',
    'serviço py/testes',
    'Testes Ünit/Cálculo Tests.cs',
    'Testes Ünit/Testes Ünit.csproj',
    'Solução.sln',
  ]) {
    expect(state.runnablePaths.has(at(root, p)), p).toBe(true);
  }
  expect(resolveTarget(at(root, 'Solução.sln'), false, state).map(t => t.project.name)).toEqual(['Testes Ünit']);
  expect(resolveTarget(at(root, 'cliente web/src/ação.test.ts'), false, state)).toEqual([
    { project: state.projects[1], target: { kind: 'partial', paths: [at(root, 'cliente web/src/ação.test.ts')] } },
  ]);
});

test('runnable paths', async () => {
  const root = await tree({
    'apps/web/package.json': JEST('web'),
    'apps/web/src/util.ts': '',
    'apps/web/src/deep/util.test.ts': '',
    'apps/cli/package.json': MOCHA('cli'),
    'apps/cli/test/cli.test.js': '',
    'py/pyproject.toml': '',
    'py/tests/test_a.py': PY_TEST,
    'py/tests/helpers.py': '',
    'net/All.sln': sln('Tests\\Tests.csproj', 'Lib\\Lib.csproj'),
    'net/Libs.sln': sln('Lib\\Lib.csproj'),
    'net/Tests/Tests.csproj': VSTEST_CSPROJ,
    'net/Tests/CalcTests.cs': TEST_CS,
    'net/Lib/Lib.csproj': LIBRARY_CSPROJ,
    'net/Lib/Calc.cs': '',
    'README.md': '',
  });
  const state = await run([root]);
  const runnable = (rel: string) => state.runnablePaths.has(rel === '.' ? root : at(root, rel));
  const yes = [
    'apps/web/package.json', 'apps/cli/package.json', 'py/pyproject.toml', 'net/Tests/Tests.csproj',
    'apps/web', 'apps/cli', 'py', 'net/Tests',
    'apps', 'net', '.',
    'net/All.sln',
    'apps/web/src/deep/util.test.ts', 'apps/web/src/deep', 'apps/web/src', 'py/tests/test_a.py', 'py/tests', 'net/Tests/CalcTests.cs',
  ];
  const no = [
    'apps/web/src/util.ts', 'py/tests/helpers.py', 'apps/cli/test/cli.test.js', 'apps/cli/test', 'net/Libs.sln',
    'net/Lib/Lib.csproj', 'net/Lib', 'net/Lib/Calc.cs', 'README.md', path.join('..', path.basename(root) + '-x'),
  ];
  for (const p of yes) expect(runnable(p), p).toBe(true);
  for (const p of no) expect(runnable(p), p).toBe(false);
  expect(state.runnablePaths.size).toBe(yes.length);
});

test('a .cs file without test attributes inside a test project is not runnable', async () => {
  const root = await tree({
    'T/T.csproj': VSTEST_CSPROJ,
    'T/CalcTests.cs': TEST_CS,
    'T/Helpers/Helper.cs': HELPER_CS,
    'T/obj/Generated.cs': TEST_CS,
  });
  const state = await run([root]);
  expect(state.runnablePaths.has(at(root, 'T/CalcTests.cs'))).toBe(true);
  expect(state.runnablePaths.has(at(root, 'T/Helpers/Helper.cs'))).toBe(false);
  expect(state.runnablePaths.has(at(root, 'T/Helpers'))).toBe(false);
  expect(state.runnablePaths.has(at(root, 'T/obj/Generated.cs'))).toBe(false);
  expect(resolveTarget(at(root, 'T/Helpers/Helper.cs'), false, state)).toEqual([]);
});

test('resolveTarget', async () => {
  const root = await tree({
    'pair/a/package.json': JEST('a'),
    'pair/a/src/x/one.test.js': '',
    'pair/a/src/x/two.test.js': '',
    'pair/a/src/plain.js': '',
    'pair/b/package.json': VITEST('b'),
    'pair/b/b.spec.ts': '',
    'gen/package.json': MOCHA('gen'),
    'gen/test/g.test.js': '',
    'net/S.slnx': '<Solution><Project Path="T1/T1.csproj" /><Project Path="T2/T2.csproj" /><Project Path="L/L.csproj" /></Solution>',
    'net/T1/T1.csproj': VSTEST_CSPROJ,
    'net/T2/T2.csproj': VSTEST_CSPROJ,
    'net/L/L.csproj': LIBRARY_CSPROJ,
    'both/package.json': JEST('both'),
    'both/both.test.js': '',
    'both/inner/pyproject.toml': '',
    'both/inner/test_i.py': PY_TEST,
  });
  const state = await run([root]);
  const byName = (name: string): Project => {
    const p = state.projects.find(x => x.name === name);
    if (p === undefined) throw new Error(name);
    return p;
  };
  const full = (name: string) => ({ project: byName(name), target: { kind: 'full' } });
  const partial = (name: string, ...rel: string[]) => ({ project: byName(name), target: { kind: 'partial', paths: rel.map(r => at(root, r)) } });

  expect(resolveTarget(at(root, 'pair/a/package.json'), false, state)).toEqual([full('a')]);
  expect(resolveTarget(at(root, 'net/S.slnx'), false, state)).toEqual([full('T1'), full('T2')]);
  expect(resolveTarget(at(root, 'pair'), true, state)).toEqual([full('a'), full('b')]);
  expect(resolveTarget(at(root, 'pair/a'), true, state)).toEqual([full('a')]);
  expect(resolveTarget(at(root, 'pair/a/src/x'), true, state)).toEqual([partial('a', 'pair/a/src/x')]);
  expect(resolveTarget(at(root, 'pair/a/src'), true, state)).toEqual([partial('a', 'pair/a/src')]);
  expect(resolveTarget(at(root, 'pair/a/src/x/one.test.js'), false, state)).toEqual([partial('a', 'pair/a/src/x/one.test.js')]);
  expect(resolveTarget(at(root, 'pair/b/b.spec.ts'), false, state)).toEqual([partial('b', 'pair/b/b.spec.ts')]);
  // A folder that is a project root and contains another project runs both as a whole.
  expect(resolveTarget(at(root, 'both'), true, state)).toEqual([full('both'), full('inner')]);
  // The workspace folder root runs everything in it.
  expect(resolveTarget(root, true, state)).toEqual(state.projects.map(p => ({ project: p, target: { kind: 'full' } })));
  // Not eligible.
  expect(resolveTarget(at(root, 'pair/a/src/plain.js'), false, state)).toEqual([]);
  expect(resolveTarget(at(root, 'gen/test/g.test.js'), false, state)).toEqual([]);
  expect(resolveTarget(at(root, 'gen/test'), true, state)).toEqual([]);
  expect(resolveTarget(at(root, 'net/L/L.csproj'), false, state)).toEqual([]);
  expect(resolveTarget(path.dirname(root), true, state)).toHaveLength(state.projects.length);
  expect(resolveTarget(at(root, 'nowhere'), true, state)).toEqual([]);
});

test('an MTP project with an unknown framework is runnable as a whole but its test files are not', async () => {
  const root = await tree({
    'M/M.csproj': MTP_UNKNOWN_CSPROJ,
    'M/MTests.cs': 'public class MTests { [Test] public void A() { } }',
  });
  const fs = countingFs();
  const state = await run([root], settings(), fs);
  expect(summary(state, root)).toEqual([['dotnet-mtp', 'M']]);
  expect(state.projects[0].supportsPartial).toBe(false);
  expect(state.runnablePaths.has(at(root, 'M/M.csproj'))).toBe(true);
  expect(state.runnablePaths.has(at(root, 'M'))).toBe(true);
  expect(state.runnablePaths.has(at(root, 'M/MTests.cs'))).toBe(false);
  expect(fs.reads.filter(r => r.endsWith('.cs'))).toEqual([]);
  expect(resolveTarget(at(root, 'M/MTests.cs'), false, state)).toEqual([]);
});

test('refreshFile updates one test file without a new discovery, and asks for one when a marker changes', async () => {
  const root = await tree({
    'web/package.json': JEST('web'),
    'web/a.test.js': '',
    'T/T.csproj': VSTEST_CSPROJ,
    'T/CalcTests.cs': TEST_CS,
    'T/Helper.cs': HELPER_CS,
    'py/setup.py': '',
    'py/test_a.py': PY_TEST,
  });
  const fs = countingFs();
  let state = await run([root], settings(), fs);
  const web = state.projects.find(p => p.name === 'web');
  const dotnet = state.projects.find(p => p.name === 'T');
  if (web === undefined || dotnet === undefined) throw new Error('missing');

  // A new Node test file.
  await writeFile(at(root, 'web/b.test.js'), '');
  fs.finds.length = 0;
  const result = await refreshFile(state, at(root, 'web/b.test.js'), fs);
  expect(result.rediscover).toBe(false);
  state = result.state;
  expect(state.testFiles.get(web.key)).toEqual([at(root, 'web/a.test.js'), at(root, 'web/b.test.js')]);
  expect(state.runnablePaths.has(at(root, 'web/b.test.js'))).toBe(true);
  expect(fs.finds).toEqual([]);

  // A helper that gains a test attribute, then a test file that is deleted.
  await writeFile(at(root, 'T/Helper.cs'), TEST_CS);
  state = (await refreshFile(state, at(root, 'T/Helper.cs'), fs)).state;
  expect(state.runnablePaths.has(at(root, 'T/Helper.cs'))).toBe(true);
  await unlink(at(root, 'T/CalcTests.cs'));
  state = (await refreshFile(state, at(root, 'T/CalcTests.cs'), fs)).state;
  expect(state.testFiles.get(dotnet.key)).toEqual([at(root, 'T/Helper.cs')]);
  expect(state.runnablePaths.has(at(root, 'T/CalcTests.cs'))).toBe(false);

  // A new test folder moved into a project.
  await mkdir(at(root, 'web/more'));
  await writeFile(at(root, 'web/more/c.test.js'), '');
  state = (await refreshFile(state, at(root, 'web/more'), fs)).state;
  expect(state.runnablePaths.has(at(root, 'web/more/c.test.js'))).toBe(true);
  expect(state.runnablePaths.has(at(root, 'web/more'))).toBe(true);

  // A file that is not a test file changes nothing.
  await writeFile(at(root, 'web/util.js'), '');
  const same = await refreshFile(state, at(root, 'web/util.js'), fs);
  expect(same).toEqual({ state, rediscover: false });

  // Marker files, a new Python test file without a project, and the last test file of a Python project.
  for (const marker of ['web/package.json', 'T/T.csproj', 'py/setup.py', 'web/jest.config.js', 'x.sln', 'Directory.Build.props']) {
    expect((await refreshFile(state, at(root, marker), fs)).rediscover, marker).toBe(true);
  }
  await writeFile(at(root, 'web/test_new.py'), PY_TEST);
  expect((await refreshFile(state, at(root, 'web/test_new.py'), fs)).rediscover).toBe(true);
  await unlink(at(root, 'py/test_a.py'));
  expect((await refreshFile(state, at(root, 'py/test_a.py'), fs)).rediscover).toBe(true);
  // A state discover did not build cannot be refreshed.
  expect((await refreshFile({ ...state }, at(root, 'web/a.test.js'), fs)).rediscover).toBe(true);
});

test('custom commands apply after the nesting rule', async () => {
  const files = {
    'package.json': JEST('root'),
    'root.test.js': '',
    'packages/a/package.json': JEST('a'),
    'packages/a/a.test.js': '',
  };
  const commands = { 'packages/a': 'make a' };
  const root = await tree(files);
  // inner: the root stays dropped as the orchestrator of a, as without the command; a becomes the
  // custom project, so the tests of a run exactly once in Run All.
  const inner = await run([root], settings({ commands }));
  expect(summary(inner, root)).toEqual([['custom', 'packages/a']]);
  // outer: the nesting rule keeps the root and drops a; the custom command, configured on
  // purpose, still adds its project. The root's test files inside it are not offered for partial runs.
  const outer = await run([root], settings({ commands, nestedProjects: 'outer' }));
  expect(summary(outer, root)).toEqual([
    ['jest', '.'],
    ['custom', 'packages/a'],
  ]);
  expect(outer.testFiles.get(outer.projects[0].key)).toEqual([at(root, 'root.test.js')]);
});

test('resolveTarget on a directory with nested projects also runs the tests of the enclosing project there', async () => {
  const root = await tree({
    'package.json': JEST('web'),
    'scripts/foo.test.js': '',
    'scripts/py/pyproject.toml': '',
    'scripts/py/test_tool.py': PY_TEST,
  });
  const state = await run([root]);
  const [jest, py] = state.projects;
  expect(resolveTarget(at(root, 'scripts'), true, state)).toEqual([
    { project: py, target: { kind: 'full' } },
    // A project lies under the directory, so the enclosing project gets its owned files there.
    { project: jest, target: { kind: 'partial', paths: [at(root, 'scripts/foo.test.js')] } },
  ]);
});

test('nested workspace folders: a path belongs to the innermost folder, whose settings apply', async () => {
  const outer = await tree({
    'package.json': JSON.stringify({ name: 'outer' }),
    'web/package.json': JEST('web'),
    'inner/app/package.json': JEST('app'),
    'inner/app/gen/x.test.js': '',
    'inner/app/a.test.js': '',
    'inner/tests/test_a.py': PY_TEST,
  });
  const inner = at(outer, 'inner');
  const byFolder = new Map([
    [outer, settings()],
    [inner, settings({ exclude: [...DEFAULT_SETTINGS.exclude, '**/gen/**'] })],
  ]);
  const fs = nodeFsReader();
  let state = await run([outer, inner], f => byFolder.get(f) ?? settings(), fs);
  expect(state.projects.map(p => [p.name, p.meta.workspaceFolder])).toEqual([
    ['web', outer],
    ['inner', inner], // Python without a marker: the (inner) workspace folder
    ['app', inner],
  ]);
  const app = state.projects[2];
  expect(state.testFiles.get(app.key)).toEqual([at(outer, 'inner/app/a.test.js')]);
  await writeFile(at(outer, 'inner/app/gen/y.test.js'), '');
  expect(await refreshFile(state, at(outer, 'inner/app/gen/y.test.js'), fs)).toEqual({ state, rediscover: false });
  await writeFile(at(outer, 'inner/app/b.test.js'), '');
  state = (await refreshFile(state, at(outer, 'inner/app/b.test.js'), fs)).state;
  expect(state.testFiles.get(app.key)).toEqual([at(outer, 'inner/app/a.test.js'), at(outer, 'inner/app/b.test.js')]);
});

test('refreshFile: projects or solutions in a directory moved in or deleted ask for a new discovery', async () => {
  const root = await tree({
    'package.json': JEST('root'),
    'root.test.js': '',
    'net/T/T.csproj': VSTEST_CSPROJ,
    'sols/All.sln': sln('..\\net\\T\\T.csproj'),
  });
  const fs = nodeFsReader();
  const state = await run([root], settings(), fs);
  expect(state.runnablePaths.has(at(root, 'sols/All.sln'))).toBe(true);
  expect(state.projects.map(p => p.name)).toEqual(['root', 'T']);

  // A Jest package moved in (the root project would own its test files).
  await mkdir(at(root, 'packages/c'), { recursive: true });
  await writeFile(at(root, 'packages/c/package.json'), JEST('c'));
  await writeFile(at(root, 'packages/c/c.test.js'), '');
  expect((await refreshFile(state, at(root, 'packages/c'), fs)).rediscover).toBe(true);
  // A new discovery drops the root as the orchestrator of c.
  expect((await run([root], settings(), fs)).projects.map(p => p.name)).toEqual(['T', 'c']);

  // A directory with a test .csproj moved in.
  await mkdir(at(root, 'more/U'), { recursive: true });
  await writeFile(at(root, 'more/U/U.csproj'), VSTEST_CSPROJ);
  expect((await refreshFile(state, at(root, 'more'), fs)).rediscover).toBe(true);

  // A deleted directory that held only a solution.
  await rm(at(root, 'sols'), { recursive: true });
  expect((await refreshFile(state, at(root, 'sols'), fs)).rediscover).toBe(true);
});

test('refreshFile keeps the spelling of a known path and normalizes a new one', async () => {
  const root = await tree({ 'web/package.json': JEST('web'), 'web/a.test.js': '' });
  const fs = nodeFsReader();
  const state = await run([root], settings(), fs);
  const key = state.projects[0].key;
  const odd = (name: string) => `${at(root, 'web')}${path.sep}.${path.sep}${name}`;
  expect(await refreshFile(state, odd('a.test.js'), fs)).toEqual({ state, rediscover: false });
  await writeFile(at(root, 'web/b.test.js'), '');
  const next = (await refreshFile(state, odd('b.test.js'), fs)).state;
  expect(next.testFiles.get(key)).toEqual([at(root, 'web/a.test.js'), at(root, 'web/b.test.js')]);
  expect(next.runnablePaths.has(at(root, 'web/b.test.js'))).toBe(true);
});

test('Python tests under a custom directory never make a Python project outside it', async () => {
  const files = { 'package.json': JEST('web'), 'a.test.js': '', 'tools/test_x.py': PY_TEST };
  const commands = { tools: 'make t' };
  const root = await tree(files);
  expect(summary(await run([root], settings({ commands })), root)).toEqual([
    ['jest', '.'],
    ['custom', 'tools'],
  ]);
  // With a test file of its own, the root Python project exists, without the file of the custom directory.
  const withOwn = await tree({ ...files, 'tests/test_y.py': PY_TEST });
  const state = await run([withOwn], settings({ commands }));
  expect(summary(state, withOwn)).toEqual([
    ['jest', '.'],
    ['python', '.'],
    ['custom', 'tools'],
  ]);
  expect(state.testFiles.get(state.projects[1].key)).toEqual([at(withOwn, 'tests/test_y.py')]);
  expect(state.runnablePaths.has(at(withOwn, 'tools/test_x.py'))).toBe(false);
});

test('a directory holding a custom directory runs only the enclosing project\'s own test files there', async () => {
  const root = await tree({
    'package.json': JEST('web'),
    'scripts/foo.test.js': '',
    'scripts/c/c.test.js': '',
    'pyproject.toml': '',
    'scripts/test_s.py': PY_TEST,
    'scripts/c/test_c.py': PY_TEST,
  });
  const state = await run([root], settings({ commands: { 'scripts/c': 'make c' } }));
  const [jest, py, custom] = state.projects;
  expect([jest.adapter, py.adapter, custom.adapter]).toEqual(['jest', 'python', 'custom']);
  expect(resolveTarget(at(root, 'scripts'), true, state)).toEqual([
    { project: custom, target: { kind: 'full' } },
    { project: jest, target: { kind: 'partial', paths: [at(root, 'scripts/foo.test.js')] } },
    { project: py, target: { kind: 'partial', paths: [at(root, 'scripts/test_s.py')] } },
  ]);
  // A directory inside a project with no project under it is passed as is: everything the adapter
  // finds under it belongs to that project.
  const flat = await tree({ 'package.json': JEST('web'), 'src/x/a.test.js': '', 'src/x/b.test.js': '' });
  const flatState = await run([flat]);
  expect(flatState.projects.filter(p => atOrInside(p.dir, at(flat, 'src/x')))).toEqual([]);
  expect(resolveTarget(at(flat, 'src/x'), true, flatState)).toEqual([
    { project: flatState.projects[0], target: { kind: 'partial', paths: [at(flat, 'src/x')] } },
  ]);
});

function atOrInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

test('nested custom directories: only the outermost runs', async () => {
  const root = await tree({ 'packages/a/package.json': JEST('a'), 'packages/a/a.test.js': '' });
  const state = await run([root], settings({ commands: { '.': 'make all', 'packages/a': 'make a' } }));
  expect(summary(state, root)).toEqual([['custom', '.']]);
  expect(state.projects[0].meta.command).toBe('make all');
});

test('a custom command in an outer workspace folder suppresses the projects of a folder nested in its directory', async () => {
  const outer = await tree({ 'inner/app/package.json': JEST('app'), 'web/package.json': JEST('web') });
  const inner = at(outer, 'inner');
  const byFolder = new Map([[outer, settings({ commands: { inner: 'make inner' } })], [inner, settings()]]);
  const state = await run([outer, inner], f => byFolder.get(f) ?? settings());
  expect(state.projects.map(p => [p.adapter, p.dir])).toEqual([
    ['custom', inner],
    ['jest', at(outer, 'web')],
  ]);
});

test('excludes are relative to the workspace folder, in discover and in refreshFile', async () => {
  const root = await tree({
    'web/package.json': JEST('web'),
    'web/a.test.js': '',
    'web/build/gen.test.js': '',
  });
  const s = settings({ exclude: [...DEFAULT_SETTINGS.exclude, 'web/build/**', 'web/more/build/**'] });
  const fs = nodeFsReader();
  const state = await run([root], s, fs);
  expect(state.testFiles.get(state.projects[0].key)).toEqual([at(root, 'web/a.test.js')]);
  await writeFile(at(root, 'web/build/gen2.test.js'), '');
  expect(await refreshFile(state, at(root, 'web/build/gen2.test.js'), fs)).toEqual({ state, rediscover: false });
  // A directory moved in: its own build/ is excluded relative to the folder, not to the directory.
  await mkdir(at(root, 'web/more/build'), { recursive: true });
  await writeFile(at(root, 'web/more/m.test.js'), '');
  await writeFile(at(root, 'web/more/build/x.test.js'), '');
  await mkdir(at(root, 'web/other/web/more/build'), { recursive: true });
  await writeFile(at(root, 'web/other/web/more/build/kept.test.js'), '');
  const next = (await refreshFile(state, at(root, 'web/more'), fs)).state;
  expect(next.testFiles.get(state.projects[0].key)).toEqual([at(root, 'web/a.test.js'), at(root, 'web/more/m.test.js')]);
  const other = (await refreshFile(next, at(root, 'web/other'), fs)).state;
  expect(other.testFiles.get(state.projects[0].key)).toContain(at(root, 'web/other/web/more/build/kept.test.js'));
});

test('walkthrough: a custom command on the root replaces the inner Jest packages', async () => {
  const root = await tree({
    'package.json': JSON.stringify({ name: 'mono', scripts: { test: 'yarn workspaces run test' } }),
    'packages/a/package.json': JEST('a'),
    'packages/b/package.json': JEST('b'),
  });
  const state = await run([root], settings({ commands: { '.': 'yarn cov' } }));
  expect(summary(state, root)).toEqual([['custom', '.']]);
  expect(resolveTarget(root, true, state).map(t => t.project.adapter)).toEqual(['custom']);
});

test('walkthrough: a custom command on a directory with two inner projects drops both', async () => {
  const root = await tree({
    'package.json': JSON.stringify({ name: 'root' }),
    'packages/a/package.json': JEST('a'),
    'packages/b/setup.py': '',
    'packages/b/test_b.py': PY_TEST,
    'other/package.json': VITEST('other'),
  });
  const state = await run([root], settings({ commands: { packages: 'make cov' } }));
  expect(summary(state, root)).toEqual([
    ['vitest', 'other'],
    ['custom', 'packages'],
  ]);
});

test('walkthrough (known limitation): a custom command on a directory that is not a project keeps the enclosing project, whose full run still covers that directory', async () => {
  const root = await tree({
    'package.json': JEST('web'),
    'src/a.test.js': '',
    'legacy/l.test.js': '',
  });
  const state = await run([root], settings({ commands: { legacy: 'make legacy' } }));
  expect(summary(state, root)).toEqual([
    ['jest', '.'],
    ['custom', 'legacy'],
  ]);
  // Not offered for partial runs of the enclosing project...
  expect(state.testFiles.get(state.projects[0].key)).toEqual([at(root, 'src/a.test.js')]);
  // ...but its full run (Jest over the whole project) still runs legacy/l.test.js.
  expect(resolveTarget(at(root, 'package.json'), false, state)).toEqual([{ project: state.projects[0], target: { kind: 'full' } }]);
});
