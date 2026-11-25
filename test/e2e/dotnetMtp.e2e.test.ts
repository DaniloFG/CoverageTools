import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { afterAll, expect, test } from 'vitest';
import { dotnetMtpAdapter } from '../../src/adapters/dotnetMtp';
import type { Project, RunTarget } from '../../src/adapters/types';
import { runProject, type RunOutcome } from '../../src/runner/runProject';
import { prepareDotnetEnv } from './dotnetEnv';
import { createRealDeps, linesOf, nodeFsReader, sampleDir, type RealDeps } from './helpers';

prepareDotnetEnv();

const FRAMEWORKS = ['mstest', 'nunit', 'xunit3', 'tunit'];
const ALL_SAMPLES = [...FRAMEWORKS, 'nocoverage'].map(f => `dotnet-mtp-${f}`);

/**
 * Line numbers of Calc/Calculator.cs in the Microsoft.Testing.Platform coverage report: `Add` is
 * lines 6-8; `Divide` is lines 11-17, where 13-14 are the `throw` inside its `if`, which no test reaches.
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
  const real = createRealDeps([dir], {}, [dotnetMtpAdapter]);
  opened.push(real);
  const csproj = path.join(dir, 'Calc.Tests', 'Calc.Tests.csproj');
  const project = await dotnetMtpAdapter.detect(csproj, nodeFsReader());
  if (project === undefined) throw new Error(`samples/${sample} is not detected as a Microsoft.Testing.Platform project`);
  return { real, project, dir, calculator: path.join(dir, 'Calc', 'Calculator.cs') };
}

async function run(real: RealDeps, project: Project, target: RunTarget): Promise<RunOutcome> {
  return runProject(project, target, real.deps, new AbortController().signal);
}

async function runOk(real: RealDeps, project: Project, target: RunTarget): Promise<void> {
  const outcome = await run(real, project, target);
  if (outcome.status !== 'ok') throw new Error(`${outcome.status}: ${outcome.message ?? ''}\n${real.output.join('')}`);
}

function countsOf(real: RealDeps, file: string, lines: readonly number[]): number[] {
  const byLine = new Map(linesOf(real.store, file));
  return lines.map(l => byLine.get(l) ?? -1);
}

const ANSI_ESCAPE = /\u001b\[[0-9;?]*[A-Za-z]/g;

/**
 * The `total:` count of the last test platform run summary, or undefined when there is none. The
 * platform colours its output when it thinks it runs in CI (GitHub Actions), so escape codes are
 * removed and line endings normalised first.
 */
function testsRun(real: RealDeps): number | undefined {
  const text = real.output.join('').replace(ANSI_ESCAPE, '').replace(/\r\n?/g, '\n');
  const summary = text.lastIndexOf('Test run summary');
  if (summary < 0) return undefined;
  const total = /total:\s*(\d+)/.exec(text.slice(summary));
  return total === null ? undefined : Number(total[1]);
}

test.each(FRAMEWORKS)('dotnet-mtp-%s: full run reports Add covered and Divide uncovered', async framework => {
  const { real, project, calculator } = await setUp(`dotnet-mtp-${framework}`);
  expect(project.meta.facts).toMatchObject({ framework });
  expect(project.supportsPartial).toBe(true);
  await runOk(real, project, { kind: 'full' });
  expect(testsRun(real) ?? 2).toBe(2);
  expect(linesOf(real.store, calculator).map(([line]) => line)).toEqual([...ADD_LINES, 11, 12, 13, 14, 16, 17]);
  for (const c of countsOf(real, calculator, [...ADD_LINES, ...DIVIDE_LINES])) expect(c).toBeGreaterThan(0);
  // OtherTests.cs runs Divide(6, 3), so only the throw for a zero divisor stays uncovered.
  expect(countsOf(real, calculator, THROW_LINES)).toEqual([0, 0]);
});

test.each(FRAMEWORKS)('dotnet-mtp-%s: a partial run of one test file runs only that class', async framework => {
  const { real, project, dir, calculator } = await setUp(`dotnet-mtp-${framework}`);
  await runOk(real, project, { kind: 'partial', paths: [path.join(dir, 'Calc.Tests', 'CalcTests.cs')] });
  // The proof is the coverage: CalcTests.cs covers Add, and only OtherTests.cs reaches Divide.
  expect(countsOf(real, calculator, ADD_LINES).every(c => c > 0)).toBe(true);
  expect(countsOf(real, calculator, [...DIVIDE_LINES, ...THROW_LINES])).toEqual([0, 0, 0, 0, 0, 0]);
  // Secondary: the run summary, when the platform prints one, counts the single test of CalcTests.
  expect(testsRun(real) ?? 1).toBe(1);
});

test('dotnet-mtp-nocoverage: the run ends as no-report with the package hint', async () => {
  const { real, project } = await setUp('dotnet-mtp-nocoverage');
  const outcome = await run(real, project, { kind: 'full' });
  expect(outcome).toEqual({
    status: 'no-report',
    hint: 'The test project did not write a coverage report. Microsoft.Testing.Platform projects need the "Microsoft.Testing.Extensions.CodeCoverage" package.',
  });
  expect(real.output.join('')).toContain("Option '--coverage' is provided by the 'Microsoft.Testing.Extensions.CodeCoverage' extension");
});

function testResultsDirs(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter(e => e.isDirectory() && e.name === 'TestResults')
    .map(e => path.join(e.parentPath, e.name));
}

test('nothing is written inside the samples, not even TestResults under bin/', () => {
  for (const sample of ALL_SAMPLES) {
    const dir = sampleDir(sample);
    expect(testResultsDirs(dir), sample).toEqual([]);
    const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all', '.'], { cwd: dir, encoding: 'utf8' });
    expect(status, sample).toBe('');
  }
});
