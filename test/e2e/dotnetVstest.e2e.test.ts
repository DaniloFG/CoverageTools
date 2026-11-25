import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterAll, expect, test } from 'vitest';
import { dotnetVstestAdapter } from '../../src/adapters/dotnetVstest';
import type { Project, RunTarget } from '../../src/adapters/types';
import { runProject } from '../../src/runner/runProject';
import { prepareDotnetEnv } from './dotnetEnv';
import { createRealDeps, linesOf, nodeFsReader, sampleDir, type RealDeps } from './helpers';

prepareDotnetEnv();

const SAMPLES = ['dotnet-vstest-coverlet', 'dotnet-vstest-plain', 'dotnet-vstest-msbuild'];

/**
 * Line numbers of Calc/Calculator.cs reported by every collector: `Add` is lines 6-8; `Divide` is
 * lines 11-17, where 13-14 are the `throw` inside its `if`, which no test reaches.
 */
const ADD_LINES = [6, 7, 8];
const DIVIDE_LINES = [11, 12, 16, 17];
const THROW_LINES = [13, 14];

const opened: RealDeps[] = [];

afterAll(async () => {
  await Promise.all(opened.map(r => r.dispose()));
});

async function setUp(sample: string): Promise<{ real: RealDeps; project: Project; dir: string; calculator: string }> {
  const dir = sampleDir(sample);
  const real = createRealDeps([dir], {}, [dotnetVstestAdapter]);
  opened.push(real);
  const csproj = path.join(dir, 'Calc.Tests', 'Calc.Tests.csproj');
  const project = await dotnetVstestAdapter.detect(csproj, nodeFsReader());
  if (project === undefined) throw new Error(`samples/${sample} is not detected as a VSTest project`);
  return { real, project, dir, calculator: path.join(dir, 'Calc', 'Calculator.cs') };
}

async function run(real: RealDeps, project: Project, target: RunTarget): Promise<void> {
  const outcome = await runProject(project, target, real.deps, new AbortController().signal);
  if (outcome.status !== 'ok') throw new Error(`${outcome.status}: ${outcome.message ?? ''}\n${real.output.join('')}`);
}

function countsOf(real: RealDeps, file: string, lines: readonly number[]): number[] {
  const byLine = new Map(linesOf(real.store, file));
  return lines.map(l => byLine.get(l) ?? -1);
}

test.each(SAMPLES)('%s: full run reports Add covered and the throw in Divide uncovered', async sample => {
  const { real, project, calculator } = await setUp(sample);
  await run(real, project, { kind: 'full' });
  expect(linesOf(real.store, calculator).map(([line]) => line)).toEqual([...ADD_LINES, 11, 12, 13, 14, 16, 17]);
  for (const c of countsOf(real, calculator, [...ADD_LINES, ...DIVIDE_LINES])) expect(c).toBeGreaterThan(0);
  expect(countsOf(real, calculator, THROW_LINES)).toEqual([0, 0]);
});

test.each(SAMPLES)('%s: partial runs of two test files accumulate', async sample => {
  const { real, project, dir, calculator } = await setUp(sample);
  await run(real, project, { kind: 'partial', paths: [path.join(dir, 'Calc.Tests', 'CalcTests.cs')] });
  expect(countsOf(real, calculator, ADD_LINES).every(c => c > 0)).toBe(true);
  expect(countsOf(real, calculator, DIVIDE_LINES)).toEqual([0, 0, 0, 0]);

  await run(real, project, { kind: 'partial', paths: [path.join(dir, 'Calc.Tests', 'OtherTests.cs')] });
  expect(countsOf(real, calculator, ADD_LINES).every(c => c > 0)).toBe(true);
  expect(countsOf(real, calculator, DIVIDE_LINES).every(c => c > 0)).toBe(true);
  expect(countsOf(real, calculator, THROW_LINES)).toEqual([0, 0]);
});

test('coverlet sample: a partial run of a file with non-ASCII names runs exactly that class', async () => {
  const { real, project, dir, calculator } = await setUp('dotnet-vstest-coverlet');
  await run(real, project, { kind: 'partial', paths: [path.join(dir, 'Calc.Tests', 'CálculoTests.cs')] });
  const output = real.output.join('');
  expect(output).toContain('--filter FullyQualifiedName~Calc.Tests.Más.CálculoTests.');
  expect(output).toMatch(/Passed:\s+1, Skipped:\s+0, Total:\s+1,/);
  expect(countsOf(real, calculator, ADD_LINES).every(c => c > 0)).toBe(true);
  expect(countsOf(real, calculator, DIVIDE_LINES)).toEqual([0, 0, 0, 0]);
});

test('no TestResults folder is created inside the sample', () => {
  for (const sample of SAMPLES) {
    const dir = sampleDir(sample);
    expect(existsSync(path.join(dir, 'TestResults')), sample).toBe(false);
    expect(existsSync(path.join(dir, 'Calc.Tests', 'TestResults')), sample).toBe(false);
    const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all', '.'], { cwd: dir, encoding: 'utf8' });
    expect(status, sample).toBe('');
  }
});
