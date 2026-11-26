import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { jestAdapter } from '../../src/adapters/jest';
import type { Project, RunTarget } from '../../src/adapters/types';
import { runProject } from '../../src/runner/runProject';
import { createRealDeps, linesOf, nodeFsReader, sampleDir, type RealDeps } from './helpers';

const dir = sampleDir('node-jest');
const calc = path.join(dir, 'src', 'calc.js');
/** Statement lines of calc.js: `add` has line 2, `divide` lines 6, 7 and 9; line 12 exports. */
const ADD_LINES = [2];
const DIVIDE_LINES = [6, 7, 9];

let real: RealDeps;
let project: Project;

beforeAll(async () => {
  real = createRealDeps([dir], {}, [jestAdapter]);
  const detected = await jestAdapter.detect(path.join(dir, 'package.json'), nodeFsReader());
  if (detected === undefined) throw new Error('samples/node-jest is not detected as a Jest project');
  project = detected;
});

afterAll(async () => {
  await real.dispose();
});

async function run(target: RunTarget): Promise<string> {
  const outcome = await runProject(project, target, real.deps, new AbortController().signal);
  if (outcome.status !== 'ok') throw new Error(`${outcome.status}: ${outcome.message ?? ''}\n${real.output.join('')}`);
  return outcome.status;
}

function countsOf(lines: readonly number[]): number[] {
  const byLine = new Map(linesOf(real.store, calc));
  return lines.map(l => byLine.get(l) ?? -1);
}

test('full run reports add covered and divide covered', async () => {
  expect(await run({ kind: 'full' })).toBe('ok');
  const all = linesOf(real.store, calc);
  expect(all.map(([line]) => line)).toEqual([...ADD_LINES, ...DIVIDE_LINES, 12]);
  for (const [line, count] of all) expect(count, `line ${line}`).toBeGreaterThan(0);
  expect(real.suppressed).toContain(project.key);
});

test('partial run of calc.test.js then other.test.js accumulates to full coverage', async () => {
  real.store.clear();
  real.output.length = 0;
  await run({ kind: 'partial', paths: [path.join(dir, 'src', 'calc.test.js')] });
  expect(countsOf(ADD_LINES).every(c => c > 0)).toBe(true);
  // extra/src/calc.test.js calls divide and its path contains src/calc.test.js: it must not have run.
  expect(countsOf(DIVIDE_LINES)).toEqual([0, 0, 0]);
  expect(real.output.join('')).not.toContain('extra/src/calc.test.js');

  await run({ kind: 'partial', paths: [path.join(dir, 'src', 'other.test.js')] });
  expect(countsOf(ADD_LINES).every(c => c > 0)).toBe(true);
  expect(countsOf(DIVIDE_LINES).every(c => c > 0)).toBe(true);
});

test('a run writes nothing inside the sample directory', async () => {
  await run({ kind: 'full' });
  const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all', '.'], { cwd: dir, encoding: 'utf8' });
  expect(status).toBe('');
});
