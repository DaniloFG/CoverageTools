import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { pythonAdapter } from '../../src/adapters/python';
import type { PlanContext, Project, RunTarget } from '../../src/adapters/types';
import { loadReport } from '../../src/parsers/load';
import { exec } from '../../src/runner/exec';
import { runProject } from '../../src/runner/runProject';
import { DEFAULT_SETTINGS } from '../../src/settings';
import { CoverageStore } from '../../src/store';
import { conversionSpec } from '../../src/watcher/coveragepy';
import { createRealDeps, linesOf, nodeFsReader, sampleDir, type RealDeps } from './helpers';

const SAMPLES = ['python-pytest', 'python-pytest-configured', 'python-pytest-plain', 'python-unittest'];
/** calc.py: `def add` 1, its body 2; `def divide` 5, `if` 6, `raise` 7, `return` 8. */
/** `[line, 1 | 0]`: covered or not (a union of runs adds up their counts). */
function covered(store: CoverageStore, file: string): Array<[number, number]> {
  return linesOf(store, file).map(([line, count]) => [line, count > 0 ? 1 : 0]);
}

const ALL_BUT_RAISE: Array<[number, number]> = [[1, 1], [2, 1], [5, 1], [6, 1], [7, 0], [8, 1]];
const ONLY_ADD: Array<[number, number]> = [[1, 1], [2, 1], [5, 1], [6, 0], [7, 0], [8, 0]];
const ONLY_DIVIDE: Array<[number, number]> = [[1, 1], [2, 0], [5, 1], [6, 1], [7, 0], [8, 1]];

function venvPython(dir: string): string {
  return process.platform === 'win32' ? path.join(dir, '.venv', 'Scripts', 'python.exe') : path.join(dir, '.venv', 'bin', 'python');
}

beforeAll(() => {
  for (const name of SAMPLES) {
    if (!existsSync(venvPython(sampleDir(name)))) throw new Error(`samples/${name}/.venv is missing: run "node scripts/setup-samples.mjs ${name}"`);
  }
});

/** Paths of the files named `.coverage` or `coverage.xml` under `dir`, its .venv aside. */
function reportsInside(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter(e => e.isFile() && (e.name === '.coverage' || e.name === 'coverage.xml'))
    .map(e => path.join(e.parentPath, e.name))
    .filter(p => !path.relative(dir, p).split(path.sep).includes('.venv'));
}

/** Runs one sample through the Python adapter with real dependencies. */
function sampleRunner(name: string, extraArgs: string[] = []) {
  const dir = sampleDir(name);
  let real: RealDeps;
  let project: Project;

  beforeAll(async () => {
    real = createRealDeps([dir], { pythonExtraArgs: extraArgs }, [pythonAdapter]);
    const detected = await pythonAdapter.detect(dir, nodeFsReader());
    if (detected === undefined) throw new Error(`samples/${name} is not detected as a Python project`);
    project = detected;
  });

  afterAll(async () => {
    await real.dispose();
  });

  return {
    dir,
    get store() { return real.store; },
    /** The command lines run since the last call. */
    async run(target: RunTarget): Promise<string[]> {
      real.output.length = 0;
      const outcome = await runProject(project, target, real.deps, new AbortController().signal);
      if (outcome.status !== 'ok') throw new Error(`${outcome.status}: ${outcome.message ?? outcome.hint ?? ''}\n${real.output.join('')}`);
      expect(real.suppressed).toContain(project.key);
      return real.output.filter(c => c.startsWith('> ')).map(c => c.slice(2).trim());
    },
    paths(): string[] {
      return real.store.merged().map(e => path.relative(dir, e.path).split(path.sep).join('/'));
    },
  };
}

describe('python-pytest (pytest + pytest-cov)', () => {
  const s = sampleRunner('python-pytest');
  const calc = path.join(s.dir, 'calc.py');

  test('pytest + pytest-cov: full run, then partial runs accumulate', async () => {
    const commands = await s.run({ kind: 'full' });
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatch(/^\S+[\\/]\.venv[\\/]bin[\\/]python -m pytest --cov --cov-report=xml:\S+[\\/]coverage\.xml$/);
    expect(covered(s.store, calc)).toEqual(ALL_BUT_RAISE);
    // A bare --cov measures everything coverage.py sees, test files included, as in the terminal.
    expect(s.paths()).toEqual(['calc.py', 'tests/test_calc.py', 'tests/test_other.py']);

    s.store.clear();
    const partial = await s.run({ kind: 'partial', paths: [path.join(s.dir, 'tests', 'test_calc.py')] });
    expect(partial[0]).toMatch(/ -m pytest --cov --cov-report=xml:\S+ tests[\\/]test_calc\.py$/);
    expect(covered(s.store, calc)).toEqual(ONLY_ADD);

    await s.run({ kind: 'partial', paths: [path.join(s.dir, 'tests', 'test_other.py')] });
    expect(covered(s.store, calc)).toEqual(ALL_BUT_RAISE);
  });
});

describe('python-pytest-configured (--cov=pkg in addopts)', () => {
  const s = sampleRunner('python-pytest-configured');

  test('project with --cov=pkg in addopts keeps its source filter', async () => {
    const commands = await s.run({ kind: 'full' });
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatch(/ -m pytest --cov-report=xml:\S+[\\/]coverage\.xml$/);
    expect(commands[0]).not.toMatch(/ --cov(\s|$)/);
    // As in the terminal: only pkg is measured, the never-imported module included at 0%.
    expect(s.paths()).toEqual(['pkg/__init__.py', 'pkg/calc.py', 'pkg/unused.py']);
    expect(covered(s.store, path.join(s.dir, 'pkg', 'unused.py'))).toEqual([[1, 0], [2, 0]]);
    expect(covered(s.store, path.join(s.dir, 'pkg', 'calc.py'))).toEqual(ALL_BUT_RAISE);
  });
});

describe('python-pytest-plain (pytest + coverage, no pytest-cov)', () => {
  const s = sampleRunner('python-pytest-plain', ['-p', 'no:cacheprovider']);
  const calc = path.join(s.dir, 'calc.py');

  test('pytest with only coverage.py: coverage run -m pytest, then coverage xml; partial runs accumulate', async () => {
    const commands = await s.run({ kind: 'full' });
    expect(commands).toHaveLength(2);
    expect(commands[0]).toMatch(/ -m coverage run --data-file=\S+[\\/]\.coverage -m pytest -p no:cacheprovider$/);
    expect(commands[1]).toMatch(/ -m coverage xml --data-file=\S+[\\/]\.coverage -o \S+[\\/]coverage\.xml$/);
    expect(covered(s.store, calc)).toEqual(ALL_BUT_RAISE);

    s.store.clear();
    const partial = await s.run({ kind: 'partial', paths: [path.join(s.dir, 'tests', 'test_other.py')] });
    expect(partial[0]).toMatch(/ -m pytest -p no:cacheprovider tests[\\/]test_other\.py$/);
    expect(covered(s.store, calc)).toEqual(ONLY_DIVIDE);

    await s.run({ kind: 'partial', paths: [path.join(s.dir, 'tests', 'test_calc.py')] });
    expect(covered(s.store, calc)).toEqual(ALL_BUT_RAISE);
  });
});

describe('python-unittest (only coverage.py)', () => {
  const s = sampleRunner('python-unittest');
  const calc = path.join(s.dir, 'calc.py');

  test('unittest with only coverage.py installed', async () => {
    const commands = await s.run({ kind: 'full' });
    expect(commands).toHaveLength(2);
    expect(commands[0]).toMatch(/ -m coverage run --data-file=\S+[\\/]\.coverage -m unittest discover$/);
    expect(commands[1]).toMatch(/ -m coverage xml --data-file=\S+ -o \S+[\\/]coverage\.xml$/);
    expect(covered(s.store, calc)).toEqual(ALL_BUT_RAISE);

    s.store.clear();
    const file = await s.run({ kind: 'partial', paths: [path.join(s.dir, 'tests', 'test_calc.py')] });
    expect(file[0]).toMatch(/ -m unittest tests[\\/]test_calc\.py$/);
    expect(covered(s.store, calc)).toEqual(ONLY_ADD);

    s.store.clear();
    const dir = await s.run({ kind: 'partial', paths: [path.join(s.dir, 'tests')] });
    expect(dir[0]).toMatch(/ -m unittest discover -s tests$/);
    expect(covered(s.store, calc)).toEqual(ALL_BUT_RAISE);
  });
});

test('no .coverage or coverage.xml is written inside the sample directory', () => {
  // Runs after the runs above (tests in a file run in order): every sample is clean.
  for (const name of SAMPLES) {
    const dir = sampleDir(name);
    expect(reportsInside(dir), name).toEqual([]);
    const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all', '.'], { cwd: dir, encoding: 'utf8' });
    expect(status, name).toBe('');
  }
});

describe('coverage.py data conversion', () => {
  let work: string;

  beforeAll(() => {
    work = realpathSync(mkdtempSync(path.join(tmpdir(), 'ct-pydata-')));
  });

  afterAll(() => {
    rmSync(work, { recursive: true, force: true });
  });

  test('a .coverage written by a plain "pytest --cov" is converted by conversionSpec and loads with the real parser', async () => {
    const sample = sampleDir('python-pytest');
    const project = path.join(work, 'project');
    const skipped = new Set(['.venv', '__pycache__', '.pytest_cache', '.coverage', 'coverage.xml']);
    cpSync(sample, project, { recursive: true, filter: src => !skipped.has(path.basename(src)) });
    const python = venvPython(sample);
    const signal = new AbortController().signal;
    let output = '';
    const onOutput = (chunk: string) => { output += chunk; };

    // As typed in a terminal: pytest-cov writes its data file into the project directory.
    const env = process.env.COVERAGE_FILE === undefined ? undefined : { COVERAGE_FILE: path.join(project, '.coverage') };
    const ran = await exec({ command: python, args: ['-m', 'pytest', '--cov', '-p', 'no:cacheprovider'], cwd: project, env }, { onOutput, signal });
    expect(ran.code, output).toBe(0);
    const dataFile = path.join(project, '.coverage');
    expect(existsSync(dataFile)).toBe(true);
    expect(existsSync(path.join(project, 'coverage.xml'))).toBe(false);

    const out = path.join(work, 'out', 'coverage.xml');
    const spec = conversionSpec(dataFile, out, python);
    expect(spec.cwd).toBe(project);
    const converted = await exec(spec, { onOutput, signal });
    expect(converted.code, output).toBe(0);

    const report = loadReport(out, [project]);
    const calc = report.files.find(f => f.path === path.join(project, 'calc.py'));
    expect(calc, report.files.map(f => f.path).join(', ')).toBeDefined();
    const store = new CoverageStore();
    store.replace('project', report.files);
    expect(covered(store, path.join(project, 'calc.py'))).toEqual(ALL_BUT_RAISE);
  });
});

test('the probe is not fooled by project files named json.py, pytest.py or coverage/', async () => {
  const project = realpathSync(mkdtempSync(path.join(tmpdir(), 'ct-pydecoy-')));
  try {
    writeFileSync(path.join(project, 'json.py'), 'raise ImportError("decoy json")\n');
    writeFileSync(path.join(project, 'pytest.py'), 'raise ImportError("decoy pytest")\n');
    mkdirSync(path.join(project, 'pytest_cov'));
    writeFileSync(path.join(project, 'pytest_cov', '__init__.py'), '');
    writeFileSync(path.join(project, 'test_x.py'), 'def test_x():\n    pass\n');
    // The unittest sample's environment has coverage only: the decoys must not pass for pytest or pytest-cov.
    const python = venvPython(sampleDir('python-unittest'));
    const probes: string[] = [];
    const ctx: PlanContext = {
      tmpDir: path.join(project, 'tmp'), fs: nodeFsReader(), c8Bin: '',
      settings: { ...DEFAULT_SETTINGS, pythonInterpreter: python },
      probe: async spec => {
        let stdout = '';
        const { code } = await exec(spec, { onOutput: c => { stdout += c; }, signal: new AbortController().signal });
        probes.push(stdout);
        return { code, stdout };
      },
    };
    const detected = await pythonAdapter.detect(project, nodeFsReader());
    if (detected === undefined) throw new Error('decoy project not detected');
    const plan = await pythonAdapter.plan(detected, { kind: 'full' }, ctx);
    expect(probes).toEqual(['{"pytest": false, "pytest_cov": false, "coverage": true}\n']);
    expect(plan.steps[0].args).toEqual(['-m', 'coverage', 'run', `--data-file=${path.join(ctx.tmpDir, '.coverage')}`, '-m', 'unittest', 'discover']);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});
