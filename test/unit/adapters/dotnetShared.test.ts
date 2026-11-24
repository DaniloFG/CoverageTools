import path from 'node:path';
import { expect, test } from 'vitest';
import { hasTestAttributes, projectsInSolution, readProjectFacts, testClassesIn } from '../../../src/adapters/dotnetShared';
import { memoryFs } from './memoryFs';

const root = path.resolve('/repo');
const dir = path.join(root, 'tests', 'Calc.Tests');
const csproj = path.join(dir, 'Calc.Tests.csproj');

function project(body: string, sdk = 'Microsoft.NET.Sdk'): string {
  return `<Project Sdk="${sdk}">\n${body}\n</Project>\n`;
}

async function facts(files: Record<string, string>) {
  return readProjectFacts(csproj, memoryFs(files));
}

test('facts merge the csproj with Directory.Build.props and Directory.Packages.props above it', async () => {
  const f = await facts({
    [csproj]: project('<ItemGroup><PackageReference Include="xunit" /></ItemGroup>'),
    [path.join(root, 'tests', 'Directory.Build.props')]: project(
      '<PropertyGroup><TargetFrameworks>net8.0;net9.0</TargetFrameworks></PropertyGroup>' +
      '<ItemGroup><PackageReference Include="coverlet.collector" /></ItemGroup>',
    ),
    [path.join(root, 'Directory.Packages.props')]: project(
      '<ItemGroup><PackageVersion Include="xunit" Version="2.9.2" /><PackageVersion Include="NUnit" Version="4.2.2" />' +
      '<GlobalPackageReference Include="Microsoft.NET.Test.Sdk" Version="17.11.1" /></ItemGroup>',
    ),
    [path.join(root, 'Directory.Build.targets')]: project('<ItemGroup><PackageReference Include="Extra.Package" /></ItemGroup>'),
  });
  expect(f).toEqual({
    isTest: true,
    usesMtp: false,
    packages: new Set(['xunit', 'coverlet.collector', 'microsoft.net.test.sdk', 'extra.package']),
    sdk: 'Microsoft.NET.Sdk',
    targetFrameworks: ['net8.0', 'net9.0'],
    framework: 'xunit',
  });
});

test('the csproj overrides properties of Directory.Build.props, and commented-out XML is ignored', async () => {
  const f = await facts({
    [csproj]: project(
      '<PropertyGroup><TargetFramework>net8.0</TargetFramework><IsTestProject>true</IsTestProject></PropertyGroup>' +
      '<!-- <PackageReference Include="coverlet.msbuild" /> -->',
    ),
    [path.join(dir, 'Directory.Build.props')]: project('<PropertyGroup><TargetFramework>net6.0</TargetFramework></PropertyGroup>'),
  });
  expect(f.targetFrameworks).toEqual(['net8.0']);
  expect(f.isTest).toBe(true);
  expect(f.packages.size).toBe(0);
  expect(f.framework).toBeUndefined();
});

test('conditional references in imported files are ignored, so a library is not taken for a test project', async () => {
  const props = project(
    '<ItemGroup Condition="\'$(IsTestProject)\' == \'true\'"><PackageReference Include="Microsoft.NET.Test.Sdk" /></ItemGroup>' +
    '<ItemGroup><PackageReference Include="coverlet.collector" Condition="\'$(IsTestProject)\' == \'true\'" /></ItemGroup>',
  );
  const f = await facts({ [csproj]: project(''), [path.join(root, 'Directory.Build.props')]: props });
  expect(f.isTest).toBe(false);
  expect(f.packages.size).toBe(0);
});

test('a missing csproj yields facts of a non-test project', async () => {
  expect(await facts({})).toEqual({
    isTest: false, usesMtp: false, packages: new Set(), sdk: '', targetFrameworks: [], framework: undefined,
  });
});

test('package names are matched case-insensitively', async () => {
  const f = await facts({
    [csproj]: project('<ItemGroup><PackageReference Include="microsoft.net.test.SDK" Version="17.11.1" /><packagereference include="Coverlet.MSBuild" /></ItemGroup>'),
  });
  expect(f.isTest).toBe(true);
  expect(f.packages.has('coverlet.msbuild')).toBe(true);
});

test.each([
  ['Sdk="MSTest.Sdk"', true],
  ['<EnableMSTestRunner>true</EnableMSTestRunner>', true],
  ['<EnableNUnitRunner>true</EnableNUnitRunner>', true],
  ['<UseMicrosoftTestingPlatformRunner>true</UseMicrosoftTestingPlatformRunner>', true],
  ['<TestingPlatformDotnetTestSupport>true</TestingPlatformDotnetTestSupport>', true],
  ['<PackageReference Include="TUnit" />', true],
  ['<PackageReference Include="Microsoft.NET.Test.Sdk" />', false],
])('usesMtp for %s is %s', async (snippet, expected) => {
  const text = snippet.startsWith('Sdk=')
    ? project('', 'MSTest.Sdk/3.6.4')
    : snippet.startsWith('<PackageReference')
      ? project(`<ItemGroup>${snippet}</ItemGroup>`)
      : project(`<PropertyGroup>${snippet}</PropertyGroup>`);
  expect((await facts({ [csproj]: text })).usesMtp).toBe(expected);
});

test('a runner property set to false does not select Microsoft.Testing.Platform', async () => {
  const f = await facts({ [csproj]: project('<PropertyGroup><EnableMSTestRunner>false</EnableMSTestRunner></PropertyGroup>') });
  expect(f.usesMtp).toBe(false);
});

test('global.json with test.runner "Microsoft.Testing.Platform" above the project sets usesMtp', async () => {
  const globalJson = '{\n  // comments are allowed\n  "sdk": { "version": "10.0.100" },\n  "test": { "runner": "Microsoft.Testing.Platform" }\n}';
  const f = await facts({
    [csproj]: project('<ItemGroup><PackageReference Include="Microsoft.NET.Test.Sdk" /></ItemGroup>'),
    [path.join(root, 'global.json')]: globalJson,
  });
  expect(f.usesMtp).toBe(true);
  // Only the nearest global.json counts.
  const nearer = await facts({
    [csproj]: project('<ItemGroup><PackageReference Include="Microsoft.NET.Test.Sdk" /></ItemGroup>'),
    [path.join(root, 'global.json')]: globalJson,
    [path.join(root, 'tests', 'global.json')]: '{ "test": { "runner": "VSTest" } }',
  });
  expect(nearer.usesMtp).toBe(false);
});

test('MSTest.Sdk with <UseVSTest>true</UseVSTest> is not MTP', async () => {
  const f = await facts({ [csproj]: project('<PropertyGroup><UseVSTest>true</UseVSTest></PropertyGroup>', 'MSTest.Sdk') });
  expect(f).toMatchObject({ isTest: true, usesMtp: false, sdk: 'MSTest.Sdk', framework: 'mstest' });
});

test.each([
  [['MSTest.TestFramework', 'MSTest.TestAdapter'], 'mstest'],
  [['MSTest'], 'mstest'],
  [['NUnit', 'NUnit3TestAdapter'], 'nunit'],
  [['xunit.v3'], 'xunit3'],
  [['xunit.v3.mtp-v2'], 'xunit3'],
  [['xunit'], 'xunit'],
  [['xunit.core'], 'xunit'],
  [['TUnit'], 'tunit'],
  [['Microsoft.NET.Test.Sdk'], undefined],
])('packages %j are framework %s', async (packages, expected) => {
  const refs = packages.map(p => `<PackageReference Include="${p}" />`).join('');
  expect((await facts({ [csproj]: project(`<ItemGroup>${refs}</ItemGroup>`) })).framework).toBe(expected);
});

test('TUnit and IsTestProject make a test project', async () => {
  expect((await facts({ [csproj]: project('<ItemGroup><PackageReference Include="TUnit" /></ItemGroup>') })).isTest).toBe(true);
  expect((await facts({ [csproj]: project('<PropertyGroup><IsTestProject>true</IsTestProject></PropertyGroup>') })).isTest).toBe(true);
  expect((await facts({ [csproj]: project('<ItemGroup><PackageReference Include="xunit" /></ItemGroup>') })).isTest).toBe(false);
});

test('testClassesIn handles file-scoped and block namespaces and nested namespaces', () => {
  expect(testClassesIn('namespace A.B;\npublic class CalcTests { [Fact] public void T() {} }')).toEqual(['A.B.CalcTests']);
  expect(testClassesIn(`
namespace A
{
    namespace B.C
    {
        public sealed class First { [Test] public void T() { if (true) { } } }
    }
    internal partial class Second
    {
        [TestMethod]
        public void T() { var s = "}"; var c = '{'; }
    }
}
public static class Helpers { public static void H() {} }
[TestClass]
public abstract class Global { [TestMethod] public void T() {} }
`)).toEqual(['A.B.C.First', 'A.Second', 'Global']);
});

test('testClassesIn returns only classes with test attributes, nested classes with +, each once', () => {
  const source = `
using Xunit;
namespace Calc.Tests;

// public class Commented { [Fact] public void T() {} }
public partial class Outer
{
    public class Fixture { public int Value => 1; }

    public class Inner
    {
        [Theory, InlineData(1)]
        public void T(int x) { var s = $"{x} {{ \\" }}"; var v = @"a "" }"; }
    }

    [Fact] public void Top() {}
}

public partial class Outer { [Fact] public void More() {} }

public record Data(int X);
public class Generic<T> where T : class { [Fact] public void T1() {} }
`;
  expect(testClassesIn(source)).toEqual(['Calc.Tests.Outer', 'Calc.Tests.Outer+Inner', 'Calc.Tests.Generic']);
});

test('testClassesIn falls back to every class when attributes cannot be placed in one', () => {
  // The attribute is outside any class body (e.g. after a parse it does not understand).
  expect(testClassesIn('[Fact]\nnamespace N;\npublic class A {}\npublic class B {}')).toEqual(['N.A', 'N.B']);
  expect(testClassesIn('public class A {}')).toEqual([]);
});

test('hasTestAttributes recognises Fact, Theory, Test, TestCase, TestMethod and DataTestMethod', () => {
  for (const attr of ['[Fact]', '[Theory]', '[Test]', '[TestCase(1, 2)]', '[TestMethod]', '[DataTestMethod]',
    '[Xunit.Fact]', '[FactAttribute]', '[Category("x"), Test]', '[ Test ]', '[TestCaseSource(nameof(Cases))]']) {
    expect(hasTestAttributes(`public class C { ${attr} public void T() {} }`), attr).toBe(true);
  }
  for (const text of ['public class C { [Obsolete] public void T() {} }', '// [Fact]\npublic class C {}',
    '/* [Test] */ class C {}', 'class C { string s = "[Fact]"; }', 'class C { [TestFixture] void T() {} }', '[Testing] class C {}']) {
    expect(hasTestAttributes(text), text).toBe(false);
  }
});

test('projectsInSolution reads .sln and .slnx and resolves backslash paths', () => {
  const sln = path.join(root, 'Calc.sln');
  const slnText = [
    'Microsoft Visual Studio Solution File, Format Version 12.00',
    'Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "Calc", "src\\Calc\\Calc.csproj", "{195BA372-0D4F-47FF-B623-DC02915BBF73}"',
    'EndProject',
    'Project("{2150E333-8FDC-42A3-9474-1A3956D46DE8}") = "tests", "tests", "{11111111-1111-1111-1111-111111111111}"',
    'EndProject',
    'Project("{9A19103F-16F7-4668-BE54-9A1E7A4F7556}") = "Calc.Tests", "tests\\Calc.Tests\\Calc.Tests.csproj", "{590483DE-DC0C-431E-B238-1F53888B84AF}"',
    'EndProject',
  ].join('\r\n');
  expect(projectsInSolution(slnText, sln)).toEqual([path.join(root, 'src', 'Calc', 'Calc.csproj'), csproj]);

  const slnx = path.join(root, 'Calc.slnx');
  const slnxText = `<Solution>
  <Folder Name="/tests/">
    <Project Path="tests/Calc.Tests/Calc.Tests.csproj" />
  </Folder>
  <Project Path="src\\Calc\\Calc.csproj" Type="Classic C#" />
  <!-- <Project Path="old/Old.csproj" /> -->
</Solution>`;
  expect(projectsInSolution(slnxText, slnx)).toEqual([csproj, path.join(root, 'src', 'Calc', 'Calc.csproj')]);
});
