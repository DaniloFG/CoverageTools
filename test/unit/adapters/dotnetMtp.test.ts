import path from 'node:path';
import { expect, test } from 'vitest';
import { dotnetMtpAdapter, mtpFilterArgs } from '../../../src/adapters/dotnetMtp';
import type { FsReader, PlanContext, Project } from '../../../src/adapters/types';
import { DEFAULT_SETTINGS, type Settings } from '../../../src/settings';
import { memoryFs } from './memoryFs';

const dir = path.resolve('/w/Calc.Tests');
const csproj = path.join(dir, 'Calc.Tests.csproj');
const tmp = path.resolve('/tmp/ct-1');
const report = path.join(tmp, 'coverage.cobertura.xml');
const HINT =
  'The test project did not write a coverage report. Microsoft.Testing.Platform projects need the "Microsoft.Testing.Extensions.CodeCoverage" package.';
const PARTIAL_HINT =
  'The test project did not write a coverage report. Either no test matched the selection, or the project lacks the "Microsoft.Testing.Extensions.CodeCoverage" package.';
const COVERAGE_ARGS = ['--coverage', '--coverage-output-format', 'cobertura', '--coverage-output', report, '--results-directory', tmp];

const XUNIT3 = `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
    <OutputType>Exe</OutputType>
    <UseMicrosoftTestingPlatformRunner>true</UseMicrosoftTestingPlatformRunner>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="xunit.v3" Version="4.0.3" />
    <PackageReference Include="Microsoft.Testing.Extensions.CodeCoverage" Version="18.12.0" />
  </ItemGroup>
</Project>
`;

function ctx(fs: FsReader, settings: Partial<Settings> = {}): PlanContext {
  return {
    tmpDir: tmp, fs, settings: { ...DEFAULT_SETTINGS, ...settings }, c8Bin: '/c8.js',
    probe: async () => ({ code: 0, stdout: '' }),
  };
}

async function detected(fs: FsReader, candidate = csproj): Promise<Project> {
  const project = await dotnetMtpAdapter.detect(candidate, fs);
  if (project === undefined) throw new Error('not detected');
  return project;
}

test('detects a test csproj that uses MTP', async () => {
  const fs = memoryFs({ [csproj]: XUNIT3 });
  const project = await detected(fs);
  expect(project).toMatchObject({
    key: `project:${csproj}`, adapter: 'dotnet-mtp', ecosystem: 'dotnet', dir, definingFile: csproj,
    name: 'Calc.Tests', supportsPartial: true,
  });
  // xunit.v3 on MTP needs no Microsoft.NET.Test.Sdk reference to be a test project.
  expect(project.meta.facts).toMatchObject({ isTest: true, usesMtp: true, framework: 'xunit3' });

  for (const text of [
    '<Project Sdk="MSTest.Sdk/4.5.3"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>',
    '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><PackageReference Include="TUnit" /></ItemGroup></Project>',
    '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><EnableNUnitRunner>true</EnableNUnitRunner></PropertyGroup>' +
      '<ItemGroup><PackageReference Include="NUnit" /><PackageReference Include="NUnit3TestAdapter" /></ItemGroup></Project>',
  ]) {
    expect(await dotnetMtpAdapter.detect(csproj, memoryFs({ [csproj]: text })), text).toBeDefined();
  }

  // A VSTest project, a library, an MTP property without a test framework, or not a .csproj at all.
  const vstest = '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><PackageReference Include="Microsoft.NET.Test.Sdk" /><PackageReference Include="xunit" /></ItemGroup></Project>';
  expect(await dotnetMtpAdapter.detect(csproj, memoryFs({ [csproj]: vstest }))).toBeUndefined();
  expect(await dotnetMtpAdapter.detect(csproj, memoryFs({ [csproj]: '<Project Sdk="Microsoft.NET.Sdk" />' }))).toBeUndefined();
  const runnerOnly = '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><UseMicrosoftTestingPlatformRunner>true</UseMicrosoftTestingPlatformRunner></PropertyGroup></Project>';
  expect(await dotnetMtpAdapter.detect(csproj, memoryFs({ [csproj]: runnerOnly }))).toBeUndefined();
  expect(await dotnetMtpAdapter.detect(dir, fs)).toBeUndefined();
});

test('full plan is dotnet run --project <csproj> -- --coverage --coverage-output-format cobertura --coverage-output <tmp>/coverage.cobertura.xml --results-directory <tmp>', async () => {
  const fs = memoryFs({ [csproj]: XUNIT3 });
  const project = await detected(fs);
  expect(await dotnetMtpAdapter.plan(project, { kind: 'full' }, ctx(fs))).toEqual({
    steps: [{ command: 'dotnet', args: ['run', '--project', csproj, '--no-launch-profile', '--', ...COVERAGE_ARGS], cwd: dir }],
    reportSearchDir: tmp,
    hint: HINT,
  });
  // Extra arguments go last, to the test application.
  const withExtra = await dotnetMtpAdapter.plan(project, { kind: 'full' }, ctx(fs, { dotnetExtraArgs: ['--timeout', '5m'] }));
  expect(withExtra.steps[0].args.slice(-2)).toEqual(['--timeout', '5m']);
});

test('a multi-targeted project adds --framework with the first target', async () => {
  const fs = memoryFs({ [csproj]: XUNIT3.replace('<TargetFramework>net8.0</TargetFramework>', '<TargetFrameworks>net9.0;net8.0</TargetFrameworks>') });
  const plan = await dotnetMtpAdapter.plan(await detected(fs), { kind: 'full' }, ctx(fs));
  expect(plan.steps[0].args).toEqual(['run', '--project', csproj, '--no-launch-profile', '--framework', 'net9.0', '--', ...COVERAGE_ARGS]);
});

test.each([
  ['mstest', ['A.B.C'], ['--filter', 'FullyQualifiedName~A.B.C.']],
  ['nunit', ['A.B.C', 'A.D'], ['--filter', 'FullyQualifiedName~A.B.C.|FullyQualifiedName~A.D.']],
  ['xunit3', ['A.B.C', 'A.D'], ['--filter-class', 'A.B.C', '--filter-class', 'A.D']],
  ['xunit3', ['A.B.C+Inner'], ['--filter-class', 'A.B.C+Inner']],
  ['tunit', ['A.B.C'], ['--treenode-filter', '/*/A.B/C/*']],
  ['tunit', ['A.B.C', 'A.B.D+Inner'], ['--treenode-filter', '/*/A.B/(C|D+Inner)/*']],
  ['tunit', ['A.B.C', 'A.D'], ['--treenode-filter', '/*/(A.B|A)/(C|D)/*']],
  ['tunit', ['Global'], ['--treenode-filter', '/*/*/Global/*']],
  // A class in the global namespace can only be named with `*`, which already covers every namespace.
  ['tunit', ['Global', 'A.B.C'], ['--treenode-filter', '/*/*/(Global|C)/*']],
  ['tunit', [{ name: 'A.G', generic: true }], ['--treenode-filter', '/*/A/G/*']],
  ['xunit', ['A.B.C'], undefined],
  [undefined, ['A.B.C'], undefined],
] as const)('mtpFilterArgs(%s, %j) is %j', (framework, classes, expected) => {
  expect(mtpFilterArgs(framework, classes)).toEqual(expected);
});

test('a generic class keeps the FullyQualifiedName~ filter open after its name', () => {
  expect(mtpFilterArgs('nunit', [{ name: 'N.G', generic: true }, { name: 'N.P', generic: false }]))
    .toEqual(['--filter', 'FullyQualifiedName~N.G|FullyQualifiedName~N.P.']);
});

test('supportsPartial is true only when mtpFilterArgs is defined for the project framework', async () => {
  const xunit2 = '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><UseMicrosoftTestingPlatformRunner>true</UseMicrosoftTestingPlatformRunner></PropertyGroup>' +
    '<ItemGroup><PackageReference Include="Microsoft.NET.Test.Sdk" /><PackageReference Include="xunit" /><PackageReference Include="xunit.runner.visualstudio" /></ItemGroup></Project>';
  const project = await detected(memoryFs({ [csproj]: xunit2 }));
  expect(project.supportsPartial).toBe(false);
  expect((await detected(memoryFs({ [csproj]: XUNIT3 }))).supportsPartial).toBe(true);

  // Asked anyway, a project without partial support runs nothing and says why.
  const file = path.join(dir, 'CalcTests.cs');
  const fs = memoryFs({ [csproj]: xunit2, [file]: 'namespace N; public class CalcTests { [Fact] public void T() {} }' });
  const plan = await dotnetMtpAdapter.plan(project, { kind: 'partial', paths: [file] }, ctx(fs));
  expect(plan.steps).toEqual([]);
  expect(plan.hint).toBe('This test framework cannot run part of a project on Microsoft.Testing.Platform; run the whole project instead.');
});

test('partial plan adds the framework filter for the test classes of the files and folders', async () => {
  const fs = memoryFs({
    [csproj]: XUNIT3,
    [path.join(dir, 'CalcTests.cs')]: 'using Xunit;\nnamespace Calc.Tests;\npublic class CalcTests { [Fact] public void Adds() {} }\n',
    [path.join(dir, 'More', 'OtherTests.cs')]: 'namespace Calc.Tests { public class OtherTests { [Fact] public void Divides() {} } }',
    [path.join(dir, 'obj', 'Debug', 'Generated.cs')]: 'namespace Gen; public class G { [Fact] public void T() {} }',
  });
  const project = await detected(fs);
  const single = await dotnetMtpAdapter.plan(project, { kind: 'partial', paths: [path.join(dir, 'CalcTests.cs')] }, ctx(fs));
  expect(single.steps[0].args).toEqual(['run', '--project', csproj, '--no-launch-profile', '--', ...COVERAGE_ARGS, '--filter-class', 'Calc.Tests.CalcTests']);
  // A filter can match nothing, and then no report is written either.
  expect(single.hint).toBe(PARTIAL_HINT);

  const folder = await dotnetMtpAdapter.plan(project, { kind: 'partial', paths: [dir] }, ctx(fs, { dotnetExtraArgs: ['--x'] }));
  expect(folder.steps[0].args.slice(5 + COVERAGE_ARGS.length)).toEqual([
    '--filter-class', 'Calc.Tests.CalcTests', '--filter-class', 'Calc.Tests.OtherTests', '--x',
  ]);

  const helper = path.join(dir, 'Helper.cs');
  const none = await dotnetMtpAdapter.plan(project, { kind: 'partial', paths: [helper] }, ctx(memoryFs({ [csproj]: XUNIT3, [helper]: 'class Helper {}' })));
  expect(none).toEqual({ steps: [], reportSearchDir: tmp, hint: 'No test classes were found in the selected files, so there is nothing to run.' });
});

test('isTestFile accepts .cs files with test attributes inside the project, outside bin/ and obj/', async () => {
  const tests = 'namespace N; public class T { [Test] public async Task A() {} }';
  const fs = memoryFs({
    [csproj]: XUNIT3,
    [path.join(dir, 'CalcTests.cs')]: tests,
    [path.join(dir, 'Helper.cs')]: 'public class Helper {}',
    [path.join(dir, 'obj', 'X.cs')]: tests,
    [path.join(dir, 'bin', 'X.cs')]: tests,
    [path.resolve('/w/Other/CalcTests.cs')]: tests,
  });
  const project = await detected(fs);
  const is = (p: string) => dotnetMtpAdapter.isTestFile(project, p, fs);
  expect(await is(path.join(dir, 'CalcTests.cs'))).toBe(true);
  expect(await is(path.join(dir, 'Helper.cs'))).toBe(false);
  expect(await is(path.join(dir, 'obj', 'X.cs'))).toBe(false);
  expect(await is(path.join(dir, 'bin', 'X.cs'))).toBe(false);
  expect(await is(path.resolve('/w/Other/CalcTests.cs'))).toBe(false);
});
