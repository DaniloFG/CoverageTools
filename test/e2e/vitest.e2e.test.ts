import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import type { Project, RunTarget } from '../../src/adapters/types';
import { vitestAdapter } from '../../src/adapters/vitest';
import { runProject, type RunOutcome } from '../../src/runner/runProject';
import { createRealDeps, linesOf, nodeFsReader, sampleDir, type RealDeps } from './helpers';

const dir = sampleDir('node-vitest');
const calc = path.join(dir, 'src', 'calc.ts');
/** Statement lines of calc.ts: `add` has line 2, `divide` lines 6, 7 and 9. */
const ADD_LINES = [2];
const DIVIDE_LINES = [6, 7, 9];

let real: RealDeps;

async function detect(sample: string): Promise<Project> {
  const project = await vitestAdapter.detect(path.join(sampleDir(sample), 'package.json'), nodeFsReader());
  if (project === undefined) throw new Error(`samples/${sample} is not detected as a Vitest project`);
  return project;
}

beforeAll(() => {
  real = createRealDeps([dir, sampleDir('node-vitest-noprovider')], {}, [vitestAdapter]);
});

afterAll(async () => {
  await real.dispose();
});

async function run(target: RunTarget, sample = 'node-vitest'): Promise<RunOutcome> {
  return runProject(await detect(sample), target, real.deps, new AbortController().signal);
}

async function runOk(target: RunTarget): Promise<void> {
  const outcome = await run(target);
  if (outcome.status !== 'ok') throw new Error(`${outcome.status}: ${outcome.message ?? ''}\n${real.output.join('')}`);
}

function countsOf(lines: readonly number[]): number[] {
  const byLine = new Map(linesOf(real.store, calc));
  return lines.map(l => byLine.get(l) ?? -1);
}

/** What the tools printed, without the echoed command lines (`> …`), which name excluded files. */
function testOutput(): string {
  return real.output.join('').split('\n').filter(l => !l.startsWith('> ')).join('\n');
}

function sampleStatus(sample: string): string {
  return execFileSync('git', ['status', '--porcelain', '--untracked-files=all', '.'], { cwd: sampleDir(sample), encoding: 'utf8' });
}

test('full run reports the .ts source with add covered and divide covered', async () => {
  await runOk({ kind: 'full' });
  expect(real.store.merged().map(e => e.path)).toEqual([calc]);
  const all = linesOf(real.store, calc);
  expect(all.map(([line]) => line)).toEqual([...ADD_LINES, ...DIVIDE_LINES]);
  for (const [line, count] of all) expect(count, `line ${line}`).toBeGreaterThan(0);
  expect(real.suppressed).toContain((await detect('node-vitest')).key);
});

test('partial run of calc.test.ts then other.test.ts accumulates to full coverage', async () => {
  real.store.clear();
  real.output.length = 0;
  await runOk({ kind: 'partial', paths: [path.join(dir, 'src', 'calc.test.ts')] });
  expect(countsOf(ADD_LINES).every(c => c > 0)).toBe(true);
  // extra/src/calc.test.ts calls divide and its path contains src/calc.test.ts: it must not have run.
  expect(countsOf(DIVIDE_LINES)).toEqual([0, 0, 0]);
  expect(testOutput()).not.toContain('extra/src/calc.test.ts');

  await runOk({ kind: 'partial', paths: [path.join(dir, 'src', 'other.test.ts')] });
  expect(countsOf(ADD_LINES).every(c => c > 0)).toBe(true);
  expect(countsOf(DIVIDE_LINES).every(c => c > 0)).toBe(true);
});

test('a run writes nothing inside the sample directory', async () => {
  await runOk({ kind: 'full' });
  expect(sampleStatus('node-vitest')).toBe('');
});

test('without a coverage provider the run ends as no-report with the hint', async () => {
  const outcome = await run({ kind: 'full' }, 'node-vitest-noprovider');
  expect(outcome).toEqual({
    status: 'no-report',
    hint: 'Vitest did not write a coverage report. Install its coverage provider: "@vitest/coverage-v8".',
  });
  expect(real.output.join('')).toContain("Cannot find dependency '@vitest/coverage-v8'");
  expect(sampleStatus('node-vitest-noprovider')).toBe('');
});
