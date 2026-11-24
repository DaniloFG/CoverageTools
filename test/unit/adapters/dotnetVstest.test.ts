import path from 'node:path';
import { expect, test } from 'vitest';
import { dotnetVstestAdapter } from '../../../src/adapters/dotnetVstest';
import type { FsReader, PlanContext, Project } from '../../../src/adapters/types';
import { DEFAULT_SETTINGS, type Settings } from '../../../src/settings';
import { memoryFs } from './memoryFs';

const dir = path.resolve('/w/Calc.Tests');
const csproj = path.join(dir, 'Calc.Tests.csproj');
const tmp = path.resolve('/tmp/ct-1');
const HINT = 'No coverage report was produced. Check that the test project builds and that its tests run with "dotnet test".';

function csprojWith(packages: readonly string[], extra = ''): string {
  const refs = ['Microsoft.NET.Test.Sdk', ...packages].map(p => `<PackageReference Include="${p}" Version="1.0.0" />`).join('\n    ');
  return `<Project Sdk="Microsoft.NET.Sdk">\n  <ItemGroup>\n    ${refs}\n  </ItemGroup>\n${extra}</Project>\n`;
}

function ctx(fs: FsReader, settings: Partial<Settings> = {}): PlanContext {
  return {
    tmpDir: tmp, fs, settings: { ...DEFAULT_SETTINGS, ...settings }, c8Bin: '/c8.js',
    probe: async () => ({ code: 0, stdout: '' }),
  };
}

async function detected(fs: FsReader, candidate = csproj): Promise<Project> {
  const project = await dotnetVstestAdapter.detect(candidate, fs);
  if (project === undefined) throw new Error('not detected');
  return project;
}

const CALC_TESTS = 'using Xunit;\nnamespace Calc.Tests;\npublic class CalcTests { [Fact] public void Adds() {} }\n';
const OTHER_TESTS = 'using Xunit;\nnamespace Calc.Tests\n{\n    public class OtherTests { [Fact] public void Divides() {} }\n}\n';

test('detects a test csproj that is not MTP', async () => {
  const fs = memoryFs({ [csproj]: csprojWith(['xunit', 'coverlet.collector']) });
  const project = await detected(fs);
  expect(project).toMatchObject({
    key: `project:${csproj}`, adapter: 'dotnet-vstest', ecosystem: 'dotnet', dir, definingFile: csproj,
    name: 'Calc.Tests', supportsPartial: true,
  });
  expect(project.meta.facts).toMatchObject({ isTest: true, usesMtp: false, framework: 'xunit' });

  // Not a test project, an MTP project, or not a .csproj at all.
  expect(await dotnetVstestAdapter.detect(csproj, memoryFs({ [csproj]: '<Project Sdk="Microsoft.NET.Sdk" />' }))).toBeUndefined();
  expect(await dotnetVstestAdapter.detect(csproj, memoryFs({ [csproj]: csprojWith(['TUnit']) }))).toBeUndefined();
  expect(await dotnetVstestAdapter.detect(dir, fs)).toBeUndefined();
  expect(await dotnetVstestAdapter.detect(path.join(dir, 'package.json'), fs)).toBeUndefined();
});

test.each([
  [['coverlet.collector'], ['--collect:XPlat Code Coverage']],
  [['coverlet.msbuild'], ['/p:CollectCoverage=true', '/p:CoverletOutputFormat=cobertura', '/p:CoverletOutput=<tmp>/']],
  [[], ['--collect:Code Coverage;Format=cobertura']],
  [['coverlet.collector', 'coverlet.msbuild'], ['--collect:XPlat Code Coverage']],
])('packages %j choose collection args %j', async (packages, expected) => {
  const fs = memoryFs({ [csproj]: csprojWith(packages) });
  const plan = await dotnetVstestAdapter.plan(await detected(fs), { kind: 'full' }, ctx(fs));
  expect(plan.steps[0].args.slice(2, -2)).toEqual(expected.map(a => a.replace('<tmp>', tmp)));
});

test('the dotnet.collector setting overrides the automatic choice', async () => {
  const fs = memoryFs({ [csproj]: csprojWith(['coverlet.msbuild']) });
  const project = await detected(fs);
  for (const value of ['XPlat Code Coverage', '"XPlat Code Coverage"', '  XPlat Code Coverage ']) {
    const plan = await dotnetVstestAdapter.plan(project, { kind: 'full' }, ctx(fs, { dotnetCollector: value }));
    expect(plan.steps[0].args).toEqual(['test', csproj, '--collect:XPlat Code Coverage', '--results-directory', tmp]);
  }
});

test('full plan is dotnet test <csproj> <collection> --results-directory <tmp>', async () => {
  const fs = memoryFs({ [csproj]: csprojWith(['coverlet.collector']) });
  const project = await detected(fs);
  expect(await dotnetVstestAdapter.plan(project, { kind: 'full' }, ctx(fs))).toEqual({
    steps: [{ command: 'dotnet', args: ['test', csproj, '--collect:XPlat Code Coverage', '--results-directory', tmp], cwd: dir }],
    reportSearchDir: tmp,
    hint: HINT,
  });
  // Extra arguments go last.
  const withExtra = await dotnetVstestAdapter.plan(project, { kind: 'full' }, ctx(fs, { dotnetExtraArgs: ['-c', 'Release'] }));
  expect(withExtra.steps[0].args.slice(-2)).toEqual(['-c', 'Release']);
});

test('partial plan adds --filter with FullyQualifiedName~ for each test class, joined by |', async () => {
  const fs = memoryFs({
    [csproj]: csprojWith(['coverlet.collector']),
    [path.join(dir, 'CalcTests.cs')]: CALC_TESTS,
    [path.join(dir, 'More', 'OtherTests.cs')]: OTHER_TESTS,
    [path.join(dir, 'More', 'Helper.cs')]: 'namespace Calc.Tests; public class Helper {}',
    [path.join(dir, 'obj', 'Debug', 'Generated.cs')]: 'namespace Gen; public class G { [Fact] public void T() {} }',
  });
  const project = await detected(fs);
  const single = await dotnetVstestAdapter.plan(project, { kind: 'partial', paths: [path.join(dir, 'CalcTests.cs')] }, ctx(fs));
  expect(single.steps[0].args).toEqual([
    'test', csproj, '--collect:XPlat Code Coverage', '--results-directory', tmp, '--filter', 'FullyQualifiedName~Calc.Tests.CalcTests.',
  ]);

  // A folder collects the classes of every test file under it (bin/ and obj/ excluded); duplicates are dropped.
  const folder = await dotnetVstestAdapter.plan(
    project,
    { kind: 'partial', paths: [dir, path.join(dir, 'CalcTests.cs')] },
    ctx(fs, { dotnetExtraArgs: ['--no-restore'] }),
  );
  expect(folder.steps[0].args.slice(5)).toEqual([
    '--filter', 'FullyQualifiedName~Calc.Tests.CalcTests.|FullyQualifiedName~Calc.Tests.OtherTests.', '--no-restore',
  ]);
});

test('a partial target with no test classes yields a plan with no steps and an explanatory hint', async () => {
  const helper = path.join(dir, 'Helper.cs');
  const fs = memoryFs({ [csproj]: csprojWith([]), [helper]: 'namespace Calc.Tests; public class Helper {}' });
  const plan = await dotnetVstestAdapter.plan(await detected(fs), { kind: 'partial', paths: [helper] }, ctx(fs));
  expect(plan.steps).toEqual([]);
  expect(plan.reportSearchDir).toBe(tmp);
  expect(plan.hint).toBe('No test classes were found in the selected files, so there is nothing to run.');
});

test('isTestFile accepts .cs files with test attributes inside the project, outside bin/ and obj/', async () => {
  const fs = memoryFs({
    [csproj]: csprojWith([]),
    [path.join(dir, 'CalcTests.cs')]: CALC_TESTS,
    [path.join(dir, 'Helper.cs')]: 'public class Helper {}',
    [path.join(dir, 'obj', 'X.cs')]: CALC_TESTS,
    [path.join(dir, 'bin', 'X.cs')]: CALC_TESTS,
    [path.join(dir, 'Notes.txt')]: '[Fact]',
    [path.resolve('/w/Other/CalcTests.cs')]: CALC_TESTS,
  });
  const project = await detected(fs);
  const is = (p: string) => dotnetVstestAdapter.isTestFile(project, p, fs);
  expect(await is(path.join(dir, 'CalcTests.cs'))).toBe(true);
  expect(await is(path.join(dir, 'Helper.cs'))).toBe(false);
  expect(await is(path.join(dir, 'obj', 'X.cs'))).toBe(false);
  expect(await is(path.join(dir, 'bin', 'X.cs'))).toBe(false);
  expect(await is(path.join(dir, 'Notes.txt'))).toBe(false);
  expect(await is(path.join(dir, 'Missing.cs'))).toBe(false);
  expect(await is(path.resolve('/w/Other/CalcTests.cs'))).toBe(false);
});
