import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { createPythonAdapter, PROBE_SCRIPT, pytestConfigHasCov, pythonAdapter, resolveInterpreter } from '../../../src/adapters/python';
import type { CommandSpec, FsReader, PlanContext, Project, RunTarget } from '../../../src/adapters/types';
import { matchesAny } from '../../../src/glob';
import { DEFAULT_SETTINGS, type Settings } from '../../../src/settings';

const DIR = path.resolve('/work/proj');
const TMP = path.resolve('/tmp/ct-1');
const COVERAGE_FILE = path.join(TMP, '.coverage');
const XML = path.join(TMP, 'coverage.xml');

/** An in-memory FsReader over absolute paths. */
function memFs(files: Record<string, string>): FsReader {
  const map = new Map(Object.entries(files).map(([p, text]) => [path.resolve(p), text]));
  return {
    readText: async p => map.get(path.resolve(p)),
    exists: async p => {
      const abs = path.resolve(p);
      return map.has(abs) || [...map.keys()].some(k => k.startsWith(abs + path.sep));
    },
    find: async (dir, include, exclude) => [...map.keys()]
      .filter(k => k.startsWith(path.resolve(dir) + path.sep))
      .filter(k => {
        const rel = path.relative(dir, k);
        return matchesAny(rel, include) && !matchesAny(rel, exclude);
      })
      .sort(),
  };
}

interface Installed { pytest: boolean; pytest_cov: boolean; coverage: boolean }

function context(installed: Installed | ((spec: CommandSpec) => Promise<{ code: number | null; stdout: string }>), opts: {
  files?: Record<string, string>; settings?: Partial<Settings>;
} = {}): { ctx: PlanContext; probes: CommandSpec[] } {
  const probes: CommandSpec[] = [];
  const ctx: PlanContext = {
    tmpDir: TMP,
    fs: memFs(opts.files ?? {}),
    settings: { ...DEFAULT_SETTINGS, ...opts.settings },
    c8Bin: '/c8.js',
    probe: async spec => {
      probes.push(spec);
      if (typeof installed === 'function') return installed(spec);
      return { code: 0, stdout: `${JSON.stringify(installed)}\n` };
    },
  };
  return { ctx, probes };
}

const project: Project = {
  key: `project:${DIR}`, adapter: 'python', ecosystem: 'python', dir: DIR,
  definingFile: path.join(DIR, 'pyproject.toml'), name: 'proj', supportsPartial: true, meta: {},
};

const FULL: RunTarget = { kind: 'full' };
const ALL: Installed = { pytest: true, pytest_cov: true, coverage: true };
const PYTEST_COVERAGE: Installed = { pytest: true, pytest_cov: false, coverage: true };
const COVERAGE_ONLY: Installed = { pytest: false, pytest_cov: false, coverage: true };

function withTmp(args: readonly string[]): string[] {
  return args.map(a => a.replace('<tmp>/.coverage', COVERAGE_FILE).replace('<tmp>/coverage.xml', XML));
}

const posixVenv = (dir: string) => path.join(dir, '.venv', 'bin', 'python');

describe('resolveInterpreter', () => {
  test('interpreter order: setting, project .venv, project venv, Python extension selection, python3', async () => {
    const venvPython = path.join(DIR, '.venv', 'bin', 'python');
    const plainVenvPython = path.join(DIR, 'venv', 'bin', 'python');
    const both = memFs({ [venvPython]: '', [plainVenvPython]: '' });
    const settings = (pythonInterpreter: string): Settings => ({ ...DEFAULT_SETTINGS, pythonInterpreter });

    expect(await resolveInterpreter(DIR, settings('/opt/py/bin/python'), both, '/selected/python', 'linux')).toBe('/opt/py/bin/python');
    expect(await resolveInterpreter(DIR, settings(''), both, '/selected/python', 'linux')).toBe(venvPython);
    expect(await resolveInterpreter(DIR, settings(''), memFs({ [plainVenvPython]: '' }), '/selected/python', 'linux')).toBe(plainVenvPython);
    expect(await resolveInterpreter(DIR, settings(''), memFs({}), '/selected/python', 'linux')).toBe('/selected/python');
    expect(await resolveInterpreter(DIR, settings(''), memFs({}), undefined, 'linux')).toBe('python3');
  });

  test('.venv uses bin/python on POSIX and Scripts\\python.exe on Windows', async () => {
    const posix = path.join(DIR, '.venv', 'bin', 'python');
    const windows = path.join(DIR, '.venv', 'Scripts', 'python.exe');
    const fs = memFs({ [posix]: '', [windows]: '' });
    expect(await resolveInterpreter(DIR, DEFAULT_SETTINGS, fs, undefined, 'linux')).toBe(posix);
    expect(await resolveInterpreter(DIR, DEFAULT_SETTINGS, fs, undefined, 'darwin')).toBe(posix);
    expect(await resolveInterpreter(DIR, DEFAULT_SETTINGS, fs, undefined, 'win32')).toBe(windows);
    // On Windows `python3` is often the Microsoft Store alias: the py launcher comes first.
    expect(await resolveInterpreter(DIR, DEFAULT_SETTINGS, memFs({ [posix]: '' }), undefined, 'win32')).toBe('py');
  });
});

describe('plan', () => {
  const venv = { [posixVenv(DIR)]: '' };
  const adapter = createPythonAdapter({ platform: 'linux' });

  test.each([
    [ALL, ['-m', 'pytest', '--cov', '--cov-report=xml:<tmp>/coverage.xml']],
    [PYTEST_COVERAGE, ['-m', 'coverage', 'run', '--data-file=<tmp>/.coverage', '-m', 'pytest']],
    [COVERAGE_ONLY, ['-m', 'coverage', 'run', '--data-file=<tmp>/.coverage', '-m', 'unittest', 'discover']],
  ])('probe %j plans %j', async (installed, firstStepArgs) => {
    const { ctx, probes } = context(installed, { files: venv });
    const plan = await adapter.plan(project, FULL, ctx);
    expect(probes).toHaveLength(1);
    expect(probes[0].command).toBe(posixVenv(DIR));
    expect(probes[0].args[0]).toBe('-c');
    expect(plan.steps[0]).toMatchObject({ command: posixVenv(DIR), cwd: DIR });
    expect(plan.steps[0].args).toEqual(withTmp(firstStepArgs));
    expect(plan.reportSearchDir).toBe(TMP);
  });

  test('the coverage.py variants add a second step: coverage xml --data-file=<tmp>/.coverage -o <tmp>/coverage.xml', async () => {
    for (const installed of [PYTEST_COVERAGE, COVERAGE_ONLY]) {
      const { ctx } = context(installed, { files: venv });
      const plan = await adapter.plan(project, FULL, ctx);
      expect(plan.steps).toHaveLength(3);
      expect(plan.steps[2]).toMatchObject({
        command: posixVenv(DIR), cwd: DIR,
        args: ['-m', 'coverage', 'xml', `--data-file=${COVERAGE_FILE}`, '-o', XML],
      });
    }
    const { ctx } = context(ALL, { files: venv });
    expect((await adapter.plan(project, FULL, ctx)).steps).toHaveLength(1);
  });

  test('no coverage.py installed: the plan has no steps and the hint names coverage and pytest-cov', async () => {
    const { ctx } = context({ pytest: true, pytest_cov: false, coverage: false }, { files: venv });
    const plan = await adapter.plan(project, FULL, ctx);
    expect(plan.steps).toEqual([]);
    expect(plan.hint).toBe('No coverage tool found in this project\'s Python environment. Install "coverage" or "pytest-cov".');
  });

  test('an interpreter that cannot be run: no steps, and the hint names the interpreter and the setting', async () => {
    const failing = async (): Promise<never> => { throw new Error('spawn ENOENT'); };
    const { ctx } = context(failing, { settings: { pythonInterpreter: '/missing/python' } });
    const plan = await adapter.plan(project, FULL, ctx);
    expect(plan.steps).toEqual([]);
    expect(plan.hint).toBe('Could not run the Python interpreter "/missing/python". Set "coverageTools.python.interpreter" to the interpreter of this project\'s environment.');

    const garbage = context(async () => ({ code: 1, stdout: 'Traceback: something\n' }), { files: venv });
    const plan2 = await adapter.plan(project, FULL, garbage.ctx);
    expect(plan2.steps).toEqual([]);
    expect(plan2.hint).toContain(`"${posixVenv(DIR)}"`);
  });

  test('python3 that cannot be spawned falls back to python', async () => {
    const { ctx, probes } = context(async spec => {
      if (spec.command === 'python3') throw new Error('spawn python3 ENOENT');
      return { code: 0, stdout: JSON.stringify(ALL) };
    });
    const plan = await adapter.plan(project, FULL, ctx);
    expect(probes.map(p => p.command)).toEqual(['python3', 'python']);
    expect(plan.steps[0].command).toBe('python');

    const none = context(async () => { throw new Error('ENOENT'); });
    const failed = await adapter.plan(project, FULL, none.ctx);
    expect(failed.steps).toEqual([]);
    expect(failed.hint).toContain('"python3"');
  });

  test('Windows tries py, then python, then python3', async () => {
    const win = createPythonAdapter({ platform: 'win32' });
    const { ctx, probes } = context(async spec => {
      if (spec.command !== 'python3') throw new Error(`spawn ${spec.command} ENOENT`);
      return { code: 0, stdout: JSON.stringify(ALL) };
    });
    const plan = await win.plan(project, FULL, ctx);
    expect(probes.map(p => p.command)).toEqual(['py', 'python', 'python3']);
    expect(plan.steps[0].command).toBe('python3');
  });

  test('without pytest-cov, parallel coverage data is combined (a failure of that step is ignored) before the XML is written', async () => {
    for (const installed of [PYTEST_COVERAGE, COVERAGE_ONLY]) {
      const { ctx } = context(installed, { files: venv });
      const steps = (await adapter.plan(project, FULL, ctx)).steps;
      expect(steps.slice(-2)).toMatchObject([
        { args: ['-m', 'coverage', 'combine', `--data-file=${COVERAGE_FILE}`], ignoreFailure: true },
        { args: ['-m', 'coverage', 'xml', `--data-file=${COVERAGE_FILE}`, '-o', XML] },
      ]);
    }
  });

  test('the Python extension selection is used when the project has no environment of its own', async () => {
    const withSelection = createPythonAdapter({ platform: 'linux', selectedInterpreter: async dir => (dir === DIR ? '/sel/python' : undefined) });
    const { ctx, probes } = context(ALL);
    const plan = await withSelection.plan(project, FULL, ctx);
    expect(probes[0].command).toBe('/sel/python');
    expect(plan.steps[0].command).toBe('/sel/python');
  });

  test.each(['pytest.ini', 'pyproject.toml', 'setup.cfg', 'tox.ini'])('--cov already in %s: no extra --cov is added, only --cov-report', async file => {
    const configs: Record<string, string> = {
      'pytest.ini': '[pytest]\naddopts = --cov=pkg -q\n',
      'pyproject.toml': '[project]\nname = "x"\n\n[tool.pytest.ini_options]\naddopts = "--cov=pkg"\n',
      'setup.cfg': '[metadata]\nname = x\n\n[tool:pytest]\naddopts =\n    --cov=pkg\n    --cov-report=term\n',
      'tox.ini': '[tox]\nenvlist = py313\n\n[pytest]\naddopts = --cov pkg\n',
    };
    const { ctx } = context(ALL, { files: { ...venv, [path.join(DIR, file)]: configs[file] } });
    const plan = await adapter.plan(project, FULL, ctx);
    expect(plan.steps[0].args).toEqual(['-m', 'pytest', `--cov-report=xml:${XML}`]);
  });

  test('every step sets COVERAGE_FILE to <tmp>/.coverage', async () => {
    for (const installed of [ALL, PYTEST_COVERAGE, COVERAGE_ONLY]) {
      const { ctx } = context(installed, { files: venv });
      const plan = await adapter.plan(project, { kind: 'partial', paths: [path.join(DIR, 'tests')] }, ctx);
      expect(plan.steps.length).toBeGreaterThan(0);
      for (const step of plan.steps) expect(step.env).toEqual({ COVERAGE_FILE });
    }
  });

  test('partial paths come last, after python.extraArgs', async () => {
    const target: RunTarget = { kind: 'partial', paths: [path.join(DIR, 'tests', 'test_a.py'), path.join(DIR, 'tests', 'test_b.py')] };
    const rel = [path.join('tests', 'test_a.py'), path.join('tests', 'test_b.py')];
    const settings = { pythonExtraArgs: ['-x', '-p', 'no:cacheprovider'] };

    const a = context(ALL, { files: venv, settings });
    expect((await adapter.plan(project, target, a.ctx)).steps[0].args)
      .toEqual(['-m', 'pytest', '--cov', `--cov-report=xml:${XML}`, '-x', '-p', 'no:cacheprovider', ...rel]);

    const b = context(PYTEST_COVERAGE, { files: venv, settings });
    expect((await adapter.plan(project, target, b.ctx)).steps[0].args)
      .toEqual(['-m', 'coverage', 'run', `--data-file=${COVERAGE_FILE}`, '-m', 'pytest', '-x', '-p', 'no:cacheprovider', ...rel]);
  });

  test('unittest: files are passed as relative paths, a directory uses discover -s', async () => {
    const files: RunTarget = { kind: 'partial', paths: [path.join(DIR, 'tests', 'test_a.py')] };
    const a = context(COVERAGE_ONLY, { files: venv, settings: { pythonExtraArgs: ['-v'] } });
    expect((await adapter.plan(project, files, a.ctx)).steps[0].args)
      .toEqual(['-m', 'coverage', 'run', `--data-file=${COVERAGE_FILE}`, '-m', 'unittest', '-v', path.join('tests', 'test_a.py')]);

    const dir: RunTarget = { kind: 'partial', paths: [path.join(DIR, 'tests')] };
    const b = context(COVERAGE_ONLY, { files: venv, settings: { pythonExtraArgs: ['-v'] } });
    expect((await adapter.plan(project, dir, b.ctx)).steps[0].args)
      .toEqual(['-m', 'coverage', 'run', `--data-file=${COVERAGE_FILE}`, '-m', 'unittest', 'discover', '-v', '-s', 'tests']);
  });

  test('unittest: several directories run one after the other, appending to the same data file', async () => {
    const target: RunTarget = { kind: 'partial', paths: [path.join(DIR, 'a'), path.join(DIR, 'b', 'test_x.py'), path.join(DIR, 'c')] };
    const { ctx } = context(COVERAGE_ONLY, { files: venv });
    const plan = await adapter.plan(project, target, ctx);
    const run = ['-m', 'coverage', 'run', '--append', `--data-file=${COVERAGE_FILE}`, '-m', 'unittest'];
    expect(plan.steps.map(s => s.args)).toEqual([
      [...run, path.join('b', 'test_x.py')],
      [...run, 'discover', '-s', 'a'],
      [...run, 'discover', '-s', 'c'],
      ['-m', 'coverage', 'combine', `--data-file=${COVERAGE_FILE}`],
      ['-m', 'coverage', 'xml', `--data-file=${COVERAGE_FILE}`, '-o', XML],
    ]);
  });

  test('unittest: a file or directory inside another listed directory is not run twice', async () => {
    const target: RunTarget = { kind: 'partial', paths: [
      path.join(DIR, 'tests', 'test_a.py'), path.join(DIR, 'tests'), path.join(DIR, 'tests', 'unit'),
      path.join(DIR, 'other', 'test_b.py'), path.join(DIR, 'other', 'test_b.py'), path.join(DIR, 'tests'),
    ] };
    const { ctx } = context(COVERAGE_ONLY, { files: venv });
    const plan = await adapter.plan(project, target, ctx);
    const run = ['-m', 'coverage', 'run', '--append', `--data-file=${COVERAGE_FILE}`, '-m', 'unittest'];
    expect(plan.steps.map(s => s.args)).toEqual([
      [...run, path.join('other', 'test_b.py')],
      [...run, 'discover', '-s', 'tests'],
      ['-m', 'coverage', 'combine', `--data-file=${COVERAGE_FILE}`],
      ['-m', 'coverage', 'xml', `--data-file=${COVERAGE_FILE}`, '-o', XML],
    ]);
  });

  test('the workspace folder in project.meta bounds the search for a parent pytest configuration', async () => {
    const files = { ...venv, [path.join(path.dirname(DIR), 'pytest.ini')]: '[pytest]\naddopts = --cov=pkg\n' };
    const inside = context(ALL, { files });
    expect((await adapter.plan(project, FULL, inside.ctx)).steps[0].args).toEqual(['-m', 'pytest', `--cov-report=xml:${XML}`]);
    const bounded = context(ALL, { files });
    const own = { ...project, meta: { workspaceFolder: DIR } };
    expect((await adapter.plan(own, FULL, bounded.ctx)).steps[0].args).toEqual(['-m', 'pytest', '--cov', `--cov-report=xml:${XML}`]);
  });

  test('the probe drops the working directory from sys.path before importing anything else', () => {
    expect(PROBE_SCRIPT.startsWith("import sys; sys.path[:] = [p for p in sys.path if p != '']; ")).toBe(true);
    expect(PROBE_SCRIPT.indexOf('import importlib')).toBeGreaterThan(PROBE_SCRIPT.indexOf('sys.path[:]'));
    expect(PROBE_SCRIPT).not.toContain('"');
    const { ctx, probes } = context(ALL, { files: venv });
    return adapter.plan(project, FULL, ctx).then(() => expect(probes[0].args).toEqual(['-c', PROBE_SCRIPT]));
  });

  test('a partial run of the project directory itself passes "."', async () => {
    const { ctx } = context(ALL, { files: venv });
    const plan = await adapter.plan(project, { kind: 'partial', paths: [DIR] }, ctx);
    expect(plan.steps[0].args.at(-1)).toBe('.');
  });
});

describe('pytestConfigHasCov', () => {
  test.each([
    ['pytest.ini', '[pytest]\naddopts = --cov=pkg\n', true],
    ['pytest.ini', '[pytest]\naddopts = -q --cov\n', true],
    ['pytest.ini', '[pytest]\n# addopts = --cov=pkg\naddopts = -q\n', false],
    ['pytest.ini', '[pytest]\naddopts = --cov-report=term --no-cov-on-fail\n', false],
    ['pyproject.toml', '[tool.pytest.ini_options]\naddopts = ["-q", "--cov=pkg"]\n', true],
    ['pyproject.toml', '[tool.pytest]\naddopts = ["--cov"]\n', true],
    ['pyproject.toml', '[tool.pytest.ini_options]\naddopts = "-q"  # --cov=pkg\n', false],
    ['pyproject.toml', '[tool.coverage.run]\n# run with --cov\nsource = ["pkg"]\n[tool.other]\nargs = "--cov"\n', false],
    ['setup.cfg', '[tool:pytest]\naddopts =\n  -q\n  --cov=pkg\n', true],
    ['setup.cfg', '[flake8]\nignore = --cov\n[tool:pytest]\naddopts = -q\n', false],
    ['tox.ini', '[testenv]\ncommands = pytest --cov\n[pytest]\naddopts = -q\n', false],
    ['tox.ini', '[testenv]\ncommands = pytest\n[pytest]\naddopts = --cov=pkg\n', true],
  ])('%s %j → %s', async (file, text, expected) => {
    expect(await pytestConfigHasCov(DIR, memFs({ [path.join(DIR, file)]: text }))).toBe(expected);
  });

  test('no configuration file: false', async () => {
    expect(await pytestConfigHasCov(DIR, memFs({}))).toBe(false);
  });

  const at = (file: string) => path.join(DIR, file);
  test.each([
    ['pytest.ini without --cov wins over a stale --cov in pyproject.toml', { 'pytest.ini': '[pytest]\naddopts = -q\n', 'pyproject.toml': '[tool.pytest.ini_options]\naddopts = "--cov=pkg"\n' }, false],
    ['pytest.ini wins even without a [pytest] section', { 'pytest.ini': '# empty\n', 'tox.ini': '[pytest]\naddopts = --cov=pkg\n' }, false],
    ['.pytest.ini is read', { '.pytest.ini': '[pytest]\naddopts = --cov=pkg\n' }, true],
    ['.pytest.ini wins over pyproject.toml', { '.pytest.ini': '[pytest]\n', 'pyproject.toml': '[tool.pytest]\naddopts = ["--cov"]\n' }, false],
    ['pyproject.toml without a pytest table is skipped', { 'pyproject.toml': '[project]\nname = "x"\n', 'tox.ini': '[pytest]\naddopts = --cov=pkg\n' }, true],
    ['pyproject.toml with a pytest table wins over tox.ini', { 'pyproject.toml': '[tool.pytest.ini_options]\naddopts = "-q"\n', 'tox.ini': '[pytest]\naddopts = --cov=pkg\n' }, false],
    ['tox.ini with [pytest] wins over setup.cfg', { 'tox.ini': '[pytest]\naddopts = -q\n', 'setup.cfg': '[tool:pytest]\naddopts = --cov=pkg\n' }, false],
    ['tox.ini without [pytest] is skipped', { 'tox.ini': '[tox]\nenvlist = py313\n', 'setup.cfg': '[tool:pytest]\naddopts = --cov=pkg\n' }, true],
  ])('precedence: %s', async (_name, files, expected) => {
    const fs = memFs(Object.fromEntries(Object.entries(files).map(([f, text]) => [at(f), text])));
    expect(await pytestConfigHasCov(DIR, fs)).toBe(expected);
  });

  test('a configuration only in a parent directory is honored; a nearer selected file stops the search', async () => {
    const root = path.resolve('/work');
    const parentIni = { [path.join(root, 'pytest.ini')]: '[pytest]\naddopts = --cov=pkg\n' };
    expect(await pytestConfigHasCov(DIR, memFs(parentIni))).toBe(true);
    expect(await pytestConfigHasCov(DIR, memFs({ ...parentIni, [at('pyproject.toml')]: '[project]\nname = "x"\n' }))).toBe(true);
    expect(await pytestConfigHasCov(DIR, memFs({ ...parentIni, [at('setup.cfg')]: '[tool:pytest]\naddopts = -q\n' }))).toBe(false);
  });

  test('the parent search stops at the workspace folder, or five levels up without one', async () => {
    const parentIni = { [path.resolve('/work/pytest.ini')]: '[pytest]\naddopts = --cov=pkg\n' };
    expect(await pytestConfigHasCov(DIR, memFs(parentIni), DIR)).toBe(false);
    expect(await pytestConfigHasCov(DIR, memFs(parentIni), path.resolve('/work'))).toBe(true);

    const deep = path.resolve('/a/b/c/d/e/f/proj');
    const ini = (dir: string) => memFs({ [path.join(dir, 'pytest.ini')]: '[pytest]\naddopts = --cov\n' });
    expect(await pytestConfigHasCov(deep, ini(path.resolve('/a/b')))).toBe(true); // 5 levels up
    expect(await pytestConfigHasCov(deep, ini(path.resolve('/a')))).toBe(false); // 6 levels up
  });
});

describe('detect and isTestFile', () => {
  test('a directory with test files is a project; the first existing marker is its defining file', async () => {
    const fs = memFs({
      [path.join(DIR, 'setup.cfg')]: '',
      [path.join(DIR, 'tox.ini')]: '',
      [path.join(DIR, 'calc.py')]: '',
      [path.join(DIR, 'tests', 'test_calc.py')]: '',
    });
    expect(await pythonAdapter.detect(DIR, fs)).toEqual({
      key: `project:${DIR}`, adapter: 'python', ecosystem: 'python', dir: DIR,
      definingFile: path.join(DIR, 'setup.cfg'), name: 'proj', supportsPartial: true, meta: {},
    });
  });

  test('without a marker the project has no defining file', async () => {
    const fs = memFs({ [path.join(DIR, 'calc_test.py')]: '' });
    const p = await pythonAdapter.detect(DIR, fs);
    expect(p?.definingFile).toBeUndefined();
    expect(p?.key).toBe(`project:${DIR}`);
  });

  test('no test files, or test files only in excluded directories: not a project', async () => {
    expect(await pythonAdapter.detect(DIR, memFs({ [path.join(DIR, 'pyproject.toml')]: '', [path.join(DIR, 'calc.py')]: '' }))).toBeUndefined();
    expect(await pythonAdapter.detect(DIR, memFs({
      [path.join(DIR, 'pyproject.toml')]: '',
      [path.join(DIR, '.venv', 'lib', 'site-packages', 'x', 'test_x.py')]: '',
    }))).toBeUndefined();
  });

  test('isTestFile matches test_*.py and *_test.py', async () => {
    const fs = memFs({});
    const is = (p: string) => pythonAdapter.isTestFile(project, p, fs);
    expect(await is(path.join(DIR, 'tests', 'test_calc.py'))).toBe(true);
    expect(await is(path.join(DIR, 'calc_test.py'))).toBe(true);
    expect(await is(path.join(DIR, 'calc.py'))).toBe(false);
    expect(await is(path.join(DIR, 'tests', 'conftest.py'))).toBe(false);
    expect(await is(path.join(DIR, 'test_calc.txt'))).toBe(false);
    expect(await is(path.join(DIR, 'testcalc.py'))).toBe(false);
    expect(await is(path.resolve('/elsewhere/test_calc.py'))).toBe(false);
    expect(await is(path.join(DIR, '.venv', 'lib', 'test_x.py'))).toBe(false);
  });
});

test('test files inside tox, nox, conda and site-packages directories are not the project\'s', async () => {
  for (const dirName of ['.tox', '.nox', '.conda', 'site-packages']) {
    expect(await pythonAdapter.isTestFile(project, path.join(DIR, dirName, 'lib', 'test_x.py'), memFs({}))).toBe(false);
  }
  expect(await pythonAdapter.isTestFile(project, path.join(DIR, 'tests', 'test_x.py'), memFs({}))).toBe(true);
});
