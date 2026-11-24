import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { nodeGenericAdapter } from '../../src/adapters/nodeGeneric';
import { unionFiles } from '../../src/merge';
import { runProject } from '../../src/runner/runProject';
import { createRealDeps, linesOf, nodeFsReader, sampleDir, type RealDeps } from './helpers';

const SAMPLES = ['node-mocha', 'node-mocha-ts', 'node-test', 'node-nyc'];

/**
 * c8 reports one statement per source line. In calc.js `add` is lines 1-3 and `divide` lines 5-10.
 * In calc.ts the same, but line 5 (`export function divide…`) reads covered: V8's range for `divide`
 * starts after `export `, so the line is not wholly inside the uncovered range.
 */
const EXPECTED: Record<string, { file: string; covered: number[]; uncovered: number[] }> = {
  'node-mocha': { file: 'src/calc.js', covered: [1, 2, 3], uncovered: [5, 6, 7, 8, 9, 10] },
  'node-test': { file: 'src/calc.js', covered: [1, 2, 3], uncovered: [5, 6, 7, 8, 9, 10] },
  'node-mocha-ts': { file: 'src/calc.ts', covered: [1, 2, 3, 5], uncovered: [6, 7, 8, 9, 10] },
};

let real: RealDeps;

beforeAll(() => {
  real = createRealDeps(SAMPLES.map(sampleDir), {}, [nodeGenericAdapter]);
});

afterAll(async () => {
  await real.dispose();
});

async function runFull(sample: string): Promise<void> {
  const project = await nodeGenericAdapter.detect(path.join(sampleDir(sample), 'package.json'), nodeFsReader());
  if (project === undefined) throw new Error(`samples/${sample} is not detected as a generic Node project`);
  real.output.length = 0;
  const outcome = await runProject(project, { kind: 'full' }, real.deps, new AbortController().signal);
  if (outcome.status !== 'ok') throw new Error(`${outcome.status}: ${outcome.message ?? ''}\n${real.output.join('')}`);
}

function gitStatus(sample: string, ...flags: string[]): string {
  return execFileSync('git', ['status', '--porcelain', '--untracked-files=all', ...flags, '.'], { cwd: sampleDir(sample), encoding: 'utf8' });
}

function filesOf(sample: string): string[] {
  const dir = sampleDir(sample);
  return real.store.merged().map(e => e.path).filter(p => p.startsWith(dir + path.sep));
}

test.each(['node-mocha', 'node-mocha-ts', 'node-test'])('%s: full run covers add and not divide', async (sample) => {
  await runFull(sample);
  expect(real.output.join('')).toContain(`> node ${real.deps.c8Bin} --reporter=json`);
  const { file, covered, uncovered } = EXPECTED[sample];
  const abs = path.join(sampleDir(sample), file);
  expect(filesOf(sample)).toEqual([abs]);
  const byLine = new Map(linesOf(real.store, abs));
  for (const line of covered) expect(byLine.get(line), `line ${line}`).toBeGreaterThan(0);
  for (const line of uncovered) expect(byLine.get(line), `line ${line}`).toBe(0);
  expect(gitStatus(sample)).toBe('');
});

test('node-mocha-ts reports the .ts source file, not transpiled output', async () => {
  await runFull('node-mocha-ts');
  const ts = path.join(sampleDir('node-mocha-ts'), 'src', 'calc.ts');
  expect(filesOf('node-mocha-ts')).toEqual([ts]);
  expect(linesOf(real.store, ts).map(([line]) => line)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

  // The real functions are found at their .ts positions, but esbuild's CommonJS helpers (and the getters
  // `__export` defines) have no source mapping and land on line 1, column 0: a c8 limitation recorded in
  // the design's section 6. The getter named `add` merges with the real `add` (same name and line).
  const entry = real.store.merged().find(e => e.path === ts);
  const file = unionFiles(entry?.parts ?? []);
  const declarations: Array<[string, number, number, number]> = [];
  for (let i = 0; i < file.declarations.length; i += 6) {
    declarations.push([file.names[file.declarations[i + 5]], file.declarations[i], file.declarations[i + 1], file.declarations[i + 4]]);
  }
  expect(declarations).toEqual([
    ['__copyProps', 1, 0, 1], ['__export', 1, 0, 1], ['__name', 1, 0, 2], ['__toCommonJS', 1, 0, 1],
    ['add', 1, 0, 2], ['divide', 1, 0, 0], ['divide', 5, 7, 0], ['get', 1, 0, 1],
  ]);
});

test('node-nyc: the unwrapped script report is found in the project and ingested', async () => {
  const dir = sampleDir('node-nyc');
  // nyc's lcov names files relative to the project (`SF:src/calc.js`), which the parser resolves against
  // the report directory and then each root in order: with every sample as a root it would pick
  // samples/node-mocha/src/calc.js. The project is the only root here, as in a workspace opened on it.
  await real.dispose();
  real = createRealDeps([dir], {}, [nodeGenericAdapter]);
  const before = Date.now();
  await runFull('node-nyc');
  expect(real.output.join('')).toContain('> npm run test\n');
  expect(real.output.join('')).not.toContain(real.deps.c8Bin);
  // The script's own lcov report: nyc marks statement lines 2 (add) and 6, 7, 9 (divide), and 12 (exports).
  expect(statSync(path.join(dir, 'coverage', 'lcov.info')).mtimeMs).toBeGreaterThanOrEqual(before - 1000);
  const calc = path.join(dir, 'src', 'calc.js');
  expect(filesOf('node-nyc')).toEqual([calc]);
  expect(linesOf(real.store, calc)).toEqual([[2, 1], [6, 0], [7, 0], [9, 0], [12, 1]]);
  // Only git-ignored paths changed: the script writes coverage/ and .nyc_output/ itself.
  expect(gitStatus('node-nyc')).toBe('');
  const ignored = gitStatus('node-nyc', '--ignored=matching').split('\n').filter(l => l.startsWith('!! '));
  expect(ignored.map(l => l.slice(3).split('/').slice(0, 3).join('/')).filter((v, i, a) => a.indexOf(v) === i).sort())
    .toEqual(['samples/node-nyc/.nyc_output', 'samples/node-nyc/coverage', 'samples/node-nyc/node_modules']);
});
