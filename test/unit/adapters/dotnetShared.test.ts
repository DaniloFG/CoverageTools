import path from 'node:path';
import { expect, test } from 'vitest';
import { hasTestAttributes, projectsInSolution, readProjectFacts, testClassesIn, testTypesIn } from '../../../src/adapters/dotnetShared';
import { dotnetMtpAdapter } from '../../../src/adapters/dotnetMtp';
import { dotnetVstestAdapter } from '../../../src/adapters/dotnetVstest';
import type { FsReader } from '../../../src/adapters/types';
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

test('only the nearest file of each name applies, as MSBuild imports it', async () => {
  const outer = project(
    '<PropertyGroup><TestingPlatformDotnetTestSupport>true</TestingPlatformDotnetTestSupport></PropertyGroup>' +
    '<ItemGroup><PackageReference Include="coverlet.collector" /></ItemGroup>',
  );
  const f = await facts({
    [csproj]: project('<ItemGroup><PackageReference Include="Microsoft.NET.Test.Sdk" /></ItemGroup>'),
    [path.join(root, 'Directory.Build.props')]: outer,
    [path.join(root, 'tests', 'Directory.Build.props')]: project('<PropertyGroup><Nullable>enable</Nullable></PropertyGroup>'),
    [path.join(root, 'Directory.Build.targets')]: project('<ItemGroup><PackageReference Include="From.Outer.Targets" /></ItemGroup>'),
    [path.join(dir, 'Directory.Build.targets')]: project(''),
  });
  expect(f.usesMtp).toBe(false);
  expect([...f.packages]).toEqual(['microsoft.net.test.sdk']);
});

test.each([
  ['GetPathOfFileAbove', '<Import Project="$([MSBuild]::GetPathOfFileAbove(\'Directory.Build.props\', \'$(MSBuildThisFileDirectory)../\'))" />'],
  [
    'GetDirectoryNameOfFileAbove',
    '<Import Project="$([MSBuild]::GetDirectoryNameOfFileAbove($(MSBuildThisFileDirectory).., Directory.Build.props))/Directory.Build.props"' +
    ' Condition="Exists(\'$([MSBuild]::GetDirectoryNameOfFileAbove($(MSBuildThisFileDirectory).., Directory.Build.props))/Directory.Build.props\')" />',
  ],
])('a nearer file that imports the one above with %s lets it apply', async (_, importElement) => {
  const f = await facts({
    [csproj]: project('<ItemGroup><PackageReference Include="Microsoft.NET.Test.Sdk" /></ItemGroup>'),
    [path.join(root, 'Directory.Build.props')]: project('<PropertyGroup><TestingPlatformDotnetTestSupport>true</TestingPlatformDotnetTestSupport></PropertyGroup>'),
    [path.join(root, 'tests', 'Directory.Build.props')]: project(`${importElement}<ItemGroup><PackageReference Include="Inner" /></ItemGroup>`),
  });
  expect(f.usesMtp).toBe(true);
  expect(f.packages.has('inner')).toBe(true);
  // An import of a different file name does not chain this one.
  const other = await facts({
    [csproj]: project(''),
    [path.join(root, 'Directory.Build.props')]: project('<PropertyGroup><TestingPlatformDotnetTestSupport>true</TestingPlatformDotnetTestSupport></PropertyGroup>'),
    [path.join(root, 'tests', 'Directory.Build.props')]: project(importElement.replace(/Directory\.Build\.props/g, 'Other.props')),
  });
  expect(other.usesMtp).toBe(false);
});

function countingFs(files: Record<string, string>): { fs: FsReader; reads: string[] } {
  const inner = memoryFs(files);
  const reads: string[] = [];
  return { reads, fs: { ...inner, readText: async p => { reads.push(p); return inner.readText(p); } } };
}

test('probing stops at the nearest file of each name, and a shared cache avoids reading a file twice', async () => {
  const { fs, reads } = countingFs({
    [csproj]: project(''),
    [path.join(dir, 'Directory.Build.props')]: project(''),
    [path.join(dir, 'global.json')]: '{}',
  });
  await readProjectFacts(csproj, fs);
  const count = (name: string) => reads.filter(r => path.basename(r) === name).length;
  expect(count('Directory.Build.props')).toBe(1);
  expect(count('global.json')).toBe(1);
  // Directory.Packages.props and Directory.Build.targets are missing: probed up to the root.
  expect(count('Directory.Build.targets')).toBe(4);

  // Reads are cached per reader: a second project read with the same reader object reads only its own directory.
  const sibling = path.join(root, 'tests', 'Other.Tests', 'Other.Tests.csproj');
  const first = [...reads];
  reads.length = 0;
  await readProjectFacts(sibling, fs);
  expect(reads.filter(r => first.includes(r))).toEqual([]);
  expect(first).toContain(path.join(root, 'tests', 'Directory.Build.targets'));
  expect(reads).not.toContain(path.join(root, 'tests', 'Directory.Build.targets'));
});

test('two detects with the same reader read a shared Directory.Build.props once; another reader reads it again', async () => {
  const props = path.join(root, 'Directory.Build.props');
  const files = {
    [csproj]: project('<ItemGroup><PackageReference Include="Microsoft.NET.Test.Sdk" /><PackageReference Include="xunit" /></ItemGroup>'),
    [path.join(root, 'tests', 'Other.Tests', 'Other.Tests.csproj')]: project('<ItemGroup><PackageReference Include="TUnit" /></ItemGroup>'),
    [props]: project('<PropertyGroup><Nullable>enable</Nullable></PropertyGroup>'),
  };
  const { fs, reads } = countingFs(files);
  expect(await dotnetVstestAdapter.detect(csproj, fs)).toBeDefined();
  expect(await dotnetMtpAdapter.detect(path.join(root, 'tests', 'Other.Tests', 'Other.Tests.csproj'), fs)).toBeDefined();
  expect(reads.filter(r => r === props)).toHaveLength(1);

  const other = countingFs(files);
  await dotnetVstestAdapter.detect(csproj, other.fs);
  expect(other.reads.filter(r => r === props)).toHaveLength(1);
});

test('<IsTestProject>false</IsTestProject> wins over a Microsoft.NET.Test.Sdk reference', async () => {
  const f = await facts({
    [csproj]: project('<PropertyGroup><IsTestProject>false</IsTestProject></PropertyGroup><ItemGroup><PackageReference Include="Microsoft.NET.Test.Sdk" /></ItemGroup>'),
  });
  expect(f.isTest).toBe(false);
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

test('an MTP project with a recognised test framework is a test project without Microsoft.NET.Test.Sdk', async () => {
  const mtp = (refs: string) => project(`<PropertyGroup><UseMicrosoftTestingPlatformRunner>true</UseMicrosoftTestingPlatformRunner></PropertyGroup><ItemGroup>${refs}</ItemGroup>`);
  expect((await facts({ [csproj]: mtp('<PackageReference Include="xunit.v3" />') })).isTest).toBe(true);
  expect((await facts({ [csproj]: mtp('') })).isTest).toBe(false);
  const off = project('<PropertyGroup><IsTestProject>false</IsTestProject><EnableNUnitRunner>true</EnableNUnitRunner></PropertyGroup><ItemGroup><PackageReference Include="NUnit" /></ItemGroup>');
  expect((await facts({ [csproj]: off })).isTest).toBe(false);
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

test('testClassesIn accepts Unicode identifiers in namespaces and classes', () => {
  expect(testClassesIn('namespace Cálculo.Testes;\npublic class CálculoTests { [Fact] public void Soma() {} }')).toEqual(['Cálculo.Testes.CálculoTests']);
  expect(testClassesIn(`
namespace Ünï.Çödé
{
    public class Äußere
    {
        public class 内部Tests { [Test] public void T() {} }
    }
    public class @Δοκιμή_1 { [Test] public void T() {} }
}
`)).toEqual(['Ünï.Çödé.Äußere+内部Tests', 'Ünï.Çödé.Δοκιμή_1']);
  // A keyword glued to a non-ASCII letter is part of an identifier, not a declaration.
  expect(testClassesIn('namespace N; public class A { int éclass = 0; [Fact] public void T() {} }')).toEqual(['N.A']);
});

test('testTypesIn marks generic test classes and the classes nested in them', () => {
  expect(testTypesIn(`
namespace N;
public class G<T> { [Test] public void T1() {} public class Inner { [Test] public void T2() {} } }
public class Plain { [Test] public void T3() {} }
`)).toEqual([
    { name: 'N.G', generic: true },
    { name: 'N.G+Inner', generic: true },
    { name: 'N.Plain', generic: false },
  ]);
});

test('a test attribute after a comma counts only inside an attribute section', () => {
  for (const text of ['class C { [Category("x"), Test] void T() {} }', 'class C {\n  [Category("x"),\n   Test]\n  void T() {} }',
    'class C { [Test, Category("x")] void T() {} }', 'class C {\n#if DEBUG\n  [Test]\n#endif\n  void T() {} }',
    'class C { [Obsolete][Test] void T() {} }']) {
    expect(hasTestAttributes(text), text).toBe(true);
  }
  for (const text of ['class C { void T() { var a = new[] { x, Test, y }; } }', 'class C { void T() { M(a, Test); } }',
    'class C { void T() { var v = grid[x, Test]; } }', 'class C { void T() { var t = (x, Test); } }']) {
    expect(hasTestAttributes(text), text).toBe(false);
  }
  expect(testClassesIn('namespace N; public class Helper { void T() { M(a, Test); } }')).toEqual([]);
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
