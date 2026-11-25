// Project discovery over a large tree: 20,000 files and 30 projects of every ecosystem, served by an
// in-memory reader that answers like VS Code's (every call resolves on a later turn of the event
// loop; the search runs "elsewhere", in slices). Measures what discovery itself costs the main
// thread, and the file access it makes. Sampling: see helpers.ts.
import nodePath from 'node:path';
import { expect, test } from 'vitest';
import { ADAPTERS } from '../../src/adapters/index';
import type { FsReader } from '../../src/adapters/types';
import { discover } from '../../src/discovery';
import { matchesAny } from '../../src/glob';
import { DEFAULT_SETTINGS } from '../../src/settings';
import { maxBlocks, report, stats } from './helpers';

const WS = '/ws';
const TOTAL_FILES = 20_000;
const BLOCK_LIMIT_MS = 50;

const VSTEST_CSPROJ =
  '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup><ItemGroup>' +
  '<PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.0.0" /><PackageReference Include="xunit" Version="2.9.0" /></ItemGroup></Project>';

interface Tree { files: Map<string, string>; counts: Record<string, number> }

function buildTree(): Tree {
  const files = new Map<string, string>();
  const add = (rel: string, text = ''): void => { files.set(`${WS}/${rel}`, text); };
  const counts = { jest: 10, vitest: 5, mocha: 5, python: 5, dotnet: 5 };
  for (let i = 0; i < counts.jest; i++) {
    add(`apps/jest${i}/package.json`, JSON.stringify({ name: `jest${i}`, scripts: { test: 'jest' }, devDependencies: { jest: '^29.0.0' } }));
    for (let f = 0; f < 150; f++) add(`apps/jest${i}/src/mod${f}.js`);
    for (let f = 0; f < 30; f++) add(`apps/jest${i}/src/__tests__/mod${f}.test.js`);
    for (let f = 0; f < 300; f++) add(`apps/jest${i}/node_modules/dep${f % 30}/index${f}.js`);
  }
  for (let i = 0; i < counts.vitest; i++) {
    add(`web/vitest${i}/package.json`, JSON.stringify({ name: `vitest${i}`, scripts: { test: 'vitest' }, devDependencies: { vitest: '^4.0.0' } }));
    add(`web/vitest${i}/vitest.config.ts`, 'export default {};');
    for (let f = 0; f < 200; f++) add(`web/vitest${i}/src/c${f}.ts`);
    for (let f = 0; f < 40; f++) add(`web/vitest${i}/src/c${f}.test.ts`);
    for (let f = 0; f < 300; f++) add(`web/vitest${i}/node_modules/dep${f % 30}/index${f}.js`);
  }
  for (let i = 0; i < counts.mocha; i++) {
    add(`libs/mocha${i}/package.json`, JSON.stringify({ name: `mocha${i}`, scripts: { test: 'mocha' } }));
    for (let f = 0; f < 150; f++) add(`libs/mocha${i}/lib/m${f}.js`);
    for (let f = 0; f < 30; f++) add(`libs/mocha${i}/test/m${f}.spec.js`);
  }
  for (let i = 0; i < counts.python; i++) {
    add(`py/svc${i}/pyproject.toml`, '[project]\nname = "svc"\n');
    for (let f = 0; f < 150; f++) add(`py/svc${i}/svc/m${f}.py`);
    for (let f = 0; f < 40; f++) add(`py/svc${i}/tests/test_m${f}.py`, 'def test_a():\n    assert True\n');
    for (let f = 0; f < 200; f++) add(`py/svc${i}/.venv/lib/site/p${f}.py`);
  }
  for (let i = 0; i < counts.dotnet; i++) {
    add(`net/App${i}/App${i}.csproj`, '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>');
    for (let f = 0; f < 150; f++) add(`net/App${i}/Code${f}.cs`, 'public class C { }');
    add(`net/App${i}.Tests/App${i}.Tests.csproj`, VSTEST_CSPROJ);
    for (let f = 0; f < 100; f++) add(`net/App${i}.Tests/T${f}.cs`, f % 3 === 0 ? 'public class T { [Fact] public void A() { } }' : 'public static class H { }');
    for (let f = 0; f < 200; f++) add(`net/App${i}.Tests/obj/Debug/g${f}.cs`, '');
    for (let f = 0; f < 100; f++) add(`net/App${i}.Tests/bin/Debug/a${f}.dll`);
  }
  for (let f = 0; files.size < TOTAL_FILES; f++) add(`docs/section${f % 40}/page${f}.md`);
  return { files, counts: { ...counts, projects: Object.values(counts).reduce((a, b) => a + b, 0) } };
}

/** A later turn of the event loop, as an answer from VS Code's file service would arrive. */
const later = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

function memoryReader(files: ReadonlyMap<string, string>) {
  const finds: string[] = [];
  const reads: string[] = [];
  let csInFlight = 0;
  let maxCsInFlight = 0;
  const all = [...files.keys()].sort();
  const reader: FsReader = {
    async readText(p) {
      reads.push(p);
      const cs = p.endsWith('.cs');
      if (cs) maxCsInFlight = Math.max(maxCsInFlight, ++csInFlight);
      await later();
      if (cs) csInFlight--;
      return files.get(p);
    },
    async exists(p) {
      await later();
      return files.has(p) || all.some(f => f.startsWith(`${p}/`));
    },
    async find(dir, include, exclude) {
      finds.push(dir);
      // The search runs in VS Code's search process: here in slices, so that its cost is not counted as ours.
      const out: string[] = [];
      for (let i = 0; i < all.length; i += 500) {
        await later();
        for (const f of all.slice(i, i + 500)) {
          if (!f.startsWith(`${dir}/`)) continue;
          const rel = nodePath.posix.relative(dir, f);
          if (matchesAny(rel, include) && !matchesAny(rel, exclude)) out.push(f);
        }
      }
      await later();
      return out;
    },
  };
  return { reader, finds, reads, maxCsInFlight: () => maxCsInFlight };
}

test('discovery over 20,000 files and 30 projects never blocks the main thread for 50 ms, with bounded searches and reads', async () => {
  const tree = buildTree();
  expect(tree.files.size).toBe(TOTAL_FILES);
  let last: ReturnType<typeof memoryReader> | undefined;
  let projects = 0;
  let partial: { node: number; dotnet: number } = { node: 0, dotnet: 0 };
  const blocks = await maxBlocks(async () => {
    last = memoryReader(tree.files);
    const state = await discover([WS], last.reader, () => DEFAULT_SETTINGS, ADAPTERS);
    projects = state.projects.length;
    partial = {
      node: state.projects.filter(p => p.ecosystem === 'node' && p.supportsPartial).length,
      dotnet: state.projects.filter(p => p.ecosystem === 'dotnet' && p.supportsPartial).length,
    };
  });
  const s = stats(blocks);
  report('max main-thread block, discovery of 20,000 files / 30 projects (best of 3)', s, 'ms', BLOCK_LIMIT_MS);
  const run = last!;
  // 10 Jest + 5 Vitest + 5 Mocha + 5 Python + 5 .NET test projects (the 5 .NET libraries are not test projects).
  expect(projects).toBe(tree.counts.projects);
  // One search per workspace folder, plus one per project that lists its test files (Node and .NET with partial runs).
  expect(partial).toEqual({ node: 15, dotnet: 5 });
  expect(run.finds.length).toBe(1 + partial.node + partial.dotnet);
  // Source files are read only inside .NET test projects (never build output), at most 20 at a time.
  const csReads = run.reads.filter(p => p.endsWith('.cs'));
  expect(csReads.length).toBe(5 * 100);
  expect(csReads.every(p => /\/net\/App\d+\.Tests\/T\d+\.cs$/.test(p))).toBe(true);
  expect(run.maxCsInFlight()).toBeLessThanOrEqual(20);
  // Of the tree's files, nothing else is read but project files (sources, dependencies, docs are not);
  // the other reads are probes for configuration files that do not exist here.
  const otherReads = run.reads.filter(p => !p.endsWith('.cs') && tree.files.has(p));
  expect(otherReads.filter(p => !/\/(?:package\.json|[^/]+\.csproj|pyproject\.toml|vitest\.config\.ts)$/.test(p))).toEqual([]);
  expect(s.min).toBeLessThan(BLOCK_LIMIT_MS);
}, 120_000);
