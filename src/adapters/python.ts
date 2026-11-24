import path from 'node:path';
import { DEFAULT_SETTINGS, type Settings } from '../settings';
import type { Adapter, CommandSpec, FsReader, PlanContext, Project, RunPlan, RunTarget } from './types';

const MARKERS = ['pyproject.toml', 'setup.py', 'setup.cfg', 'pytest.ini', 'tox.ini'] as const;
const TEST_FILE_GLOBS = ['**/test_*.py', '**/*_test.py'];
const TEST_FILE_NAME = /^(test_.*|.*_test)\.py$/;
/** Directories whose files never count as the project's test files (the default excludes). */
const SKIPPED_DIRS = new Set(['node_modules', 'bin', 'obj', '.venv', 'venv', '__pycache__']);

/**
 * The configuration files pytest picks from, in its order of precedence: in a directory it reads
 * the first of these that exists (`always`) or that has a pytest section, and only that one.
 */
const PYTEST_CONFIGS: ReadonlyArray<{ file: string; header: RegExp; toml: boolean; always: boolean }> = [
  { file: 'pytest.ini', header: /^\[\s*pytest\s*\]$/, toml: false, always: true },
  { file: '.pytest.ini', header: /^\[\s*pytest\s*\]$/, toml: false, always: true },
  { file: 'pyproject.toml', header: /^\[\s*tool\.pytest(\.ini_options)?\s*\]$/, toml: true, always: false },
  { file: 'tox.ini', header: /^\[\s*pytest\s*\]$/, toml: false, always: false },
  { file: 'setup.cfg', header: /^\[\s*tool:pytest\s*\]$/, toml: false, always: false },
];
/** Without a workspace folder to stop at, how many parent directories are searched for a configuration. */
const MAX_CONFIG_LEVELS_UP = 5;
/** `--cov` or `--cov=<source>` as an option of its own (not `--cov-report`, `--no-cov`…). */
const COV_OPTION = /(?:^|[\s"',[])--cov(?=$|[=\s"',\]])/;

/**
 * Prints which of the tools the adapter can use are importable by the interpreter. With `-c` the
 * working directory (the project) comes first on sys.path as '', so it is dropped before anything
 * else is imported: a project's own json.py, pytest.py or coverage/ must neither break the probe
 * nor pass for an installed tool. (Not `-I`, which would also drop PYTHONPATH and user site.)
 */
export const PROBE_SCRIPT =
  "import sys; sys.path[:] = [p for p in sys.path if p != '']; " +
  "import importlib.util as u, json; print(json.dumps({m: u.find_spec(m) is not None for m in ('pytest', 'pytest_cov', 'coverage')}))";

const NO_COVERAGE_HINT = 'No coverage tool found in this project\'s Python environment. Install "coverage" or "pytest-cov".';
const NO_REPORT_HINT = 'The Python tests did not produce a coverage report. Check the test output in the "Coverage Tools" output channel.';

function cannotRunHint(python: string): string {
  return `Could not run the Python interpreter "${python}". Set "coverageTools.python.interpreter" to the interpreter of this project's environment.`;
}

interface Installed { pytest: boolean; pytest_cov: boolean; coverage: boolean }

export interface PythonAdapterOptions {
  /** The interpreter the Python extension selected for a directory, if that extension is installed. */
  selectedInterpreter?(dir: string): Promise<string | undefined>;
  /** For tests; defaults to process.platform. */
  platform?: NodeJS.Platform;
}

/**
 * The interpreter for a project: the `coverageTools.python.interpreter` setting; the project's own
 * `.venv`, then `venv`; the interpreter selected in the Python extension; `python3`. (When `python3`
 * cannot be started, the adapter falls back to `python` itself.)
 */
export async function resolveInterpreter(
  projectDir: string,
  settings: Settings,
  fs: FsReader,
  selectedByPythonExtension: string | undefined,
  platform: NodeJS.Platform = process.platform,
): Promise<string> {
  if (settings.pythonInterpreter.trim() !== '') return settings.pythonInterpreter.trim();
  const inVenv = platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python'];
  for (const venv of ['.venv', 'venv']) {
    const candidate = path.join(projectDir, venv, ...inVenv);
    if (await fs.exists(candidate)) return candidate;
  }
  if (selectedByPythonExtension) return selectedByPythonExtension;
  return 'python3';
}

/**
 * Runs `attempt` with the resolved interpreter; when that is the `python3` fallback and the attempt
 * fails (returns undefined: it could not be started), tries `python` once. Returns the interpreter
 * that worked, or the original one when neither did.
 */
export async function withPythonFallback<T>(
  python: string,
  attempt: (python: string) => Promise<T | undefined>,
): Promise<{ python: string; result: T | undefined }> {
  const result = await attempt(python);
  if (result !== undefined || python !== 'python3') return { python, result };
  const second = await attempt('python');
  return second === undefined ? { python, result } : { python: 'python', result: second };
}

/** Removes a comment from one line: a whole-line `#`/`;` comment, or a `#` (INI: also `;`) after whitespace. */
function stripComment(line: string, toml: boolean): string {
  const trimmed = line.trim();
  if (trimmed.startsWith('#') || (!toml && trimmed.startsWith(';'))) return '';
  const inline = toml ? /(^|\s)#.*$/ : /(^|\s)[#;].*$/;
  return line.replace(inline, '');
}

/** The lines of the section whose header matches `header`, comments removed; undefined without that section. */
function sectionLines(text: string, header: RegExp, toml: boolean): string[] | undefined {
  const out: string[] = [];
  let inside = false;
  let found = false;
  for (const raw of text.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (trimmed.startsWith('[') && /^\[[^\]]*\]\s*(#.*)?$/.test(trimmed)) {
      inside = header.test(trimmed.replace(/\s*#.*$/, ''));
      found ||= inside;
      continue;
    }
    if (inside) out.push(stripComment(raw, toml));
  }
  return found ? out : undefined;
}

/** The pytest section of the configuration file pytest would read in `dir`; undefined when it reads none there. */
async function selectedConfig(dir: string, fs: FsReader): Promise<string[] | undefined> {
  for (const { file, header, toml, always } of PYTEST_CONFIGS) {
    const text = await fs.readText(path.join(dir, file));
    if (text === undefined) continue;
    const lines = sectionLines(text, header, toml);
    if (lines !== undefined) return lines;
    if (always) return [];
  }
  return undefined;
}

/**
 * Whether the pytest configuration that applies to the project already passes `--cov`: a plain
 * text search inside the pytest section of the one file pytest would select, looked for in the
 * project directory and then in its parents, up to `stopAt` (inclusive) when given, else up to
 * five levels up.
 */
export async function pytestConfigHasCov(projectDir: string, fs: FsReader, stopAt?: string): Promise<boolean> {
  const stop = stopAt === undefined ? undefined : path.resolve(stopAt);
  let dir = path.resolve(projectDir);
  for (let level = 0; ; level++) {
    const lines = await selectedConfig(dir, fs);
    if (lines !== undefined) return lines.some(line => COV_OPTION.test(line));
    const parent = path.dirname(dir);
    const atLimit = stop === undefined ? level >= MAX_CONFIG_LEVELS_UP : dir === stop || !isInside(parent, stop);
    if (atLimit || parent === dir) return false;
    dir = parent;
  }
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function parseProbe(stdout: string): Installed | undefined {
  for (const line of stdout.split(/\r?\n/).reverse()) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const value: unknown = JSON.parse(trimmed);
      if (typeof value !== 'object' || value === null) continue;
      const v = value as Record<string, unknown>;
      if (typeof v.pytest === 'boolean' && typeof v.pytest_cov === 'boolean' && typeof v.coverage === 'boolean') {
        return { pytest: v.pytest, pytest_cov: v.pytest_cov, coverage: v.coverage };
      }
    } catch {
      // Not the probe's line.
    }
  }
  return undefined;
}

async function probeInterpreter(python: string, cwd: string, ctx: PlanContext): Promise<Installed | undefined> {
  try {
    const { stdout } = await ctx.probe({ command: python, args: ['-c', PROBE_SCRIPT], cwd });
    return parseProbe(stdout);
  } catch {
    return undefined;
  }
}

function relativeTo(dir: string, p: string): string {
  return path.relative(dir, p) || '.';
}

/**
 * The `unittest` argument lists of a run: one for all files, then one per directory. A file or
 * directory inside another listed directory is left out, as that directory's run already has it.
 */
function unittestRuns(project: Project, target: RunTarget, extraArgs: readonly string[]): string[][] {
  if (target.kind === 'full') return [['discover', ...extraArgs]];
  const isFile = (p: string) => p.toLowerCase().endsWith('.py');
  const allDirs = target.paths.filter(p => !isFile(p)).map(p => path.resolve(p));
  const coveredByOther = (p: string) => allDirs.some(d => d !== p && isInside(p, d));
  const files = [...new Set(target.paths.filter(isFile).map(p => path.resolve(p)))].filter(p => !coveredByOther(p));
  const dirs = [...new Set(allDirs)].filter(d => !coveredByOther(d));
  const runs: string[][] = [];
  if (files.length > 0) runs.push([...extraArgs, ...files.map(p => relativeTo(project.dir, p))]);
  for (const dir of dirs) runs.push(['discover', ...extraArgs, '-s', relativeTo(project.dir, dir)]);
  return runs;
}

export function createPythonAdapter(options: PythonAdapterOptions = {}): Adapter {
  const platform = options.platform ?? process.platform;

  return {
    id: 'python',
    ecosystem: 'python',

    async detect(candidate, fs) {
      const tests = await fs.find(candidate, TEST_FILE_GLOBS, DEFAULT_SETTINGS.exclude);
      if (tests.length === 0) return undefined;
      let definingFile: string | undefined;
      for (const marker of MARKERS) {
        const p = path.join(candidate, marker);
        if (await fs.exists(p)) {
          definingFile = p;
          break;
        }
      }
      return {
        key: `project:${candidate}`, adapter: 'python', ecosystem: 'python', dir: candidate,
        definingFile, name: path.basename(candidate), supportsPartial: true, meta: {},
      };
    },

    async isTestFile(project, p) {
      const rel = path.relative(project.dir, p);
      if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return false;
      const parts = rel.split(/[\\/]/);
      if (parts.slice(0, -1).some(part => SKIPPED_DIRS.has(part))) return false;
      return TEST_FILE_NAME.test(parts[parts.length - 1]);
    },

    async plan(project, target, ctx): Promise<RunPlan> {
      const selected = await options.selectedInterpreter?.(project.dir);
      const resolved = await resolveInterpreter(project.dir, ctx.settings, ctx.fs, selected, platform);
      const { python, result: installed } = await withPythonFallback(resolved, p => probeInterpreter(p, project.dir, ctx));
      const reportSearchDir = ctx.tmpDir;
      if (installed === undefined) return { steps: [], reportSearchDir, hint: cannotRunHint(python) };

      const dataFile = path.join(ctx.tmpDir, '.coverage');
      const xml = path.join(ctx.tmpDir, 'coverage.xml');
      const step = (args: string[]): CommandSpec => ({ command: python, args, cwd: project.dir, env: { COVERAGE_FILE: dataFile } });
      const extraArgs = ctx.settings.pythonExtraArgs;
      const paths = target.kind === 'partial' ? target.paths.map(p => relativeTo(project.dir, p)) : [];
      const convert = step(['-m', 'coverage', 'xml', `--data-file=${dataFile}`, '-o', xml]);

      if (installed.pytest && installed.pytest_cov) {
        const stopAt = typeof project.meta.workspaceFolder === 'string' ? project.meta.workspaceFolder : undefined;
        const cov = (await pytestConfigHasCov(project.dir, ctx.fs, stopAt)) ? [] : ['--cov'];
        return {
          steps: [step(['-m', 'pytest', ...cov, `--cov-report=xml:${xml}`, ...extraArgs, ...paths])],
          reportSearchDir, hint: NO_REPORT_HINT,
        };
      }
      if (installed.pytest && installed.coverage) {
        return {
          steps: [step(['-m', 'coverage', 'run', `--data-file=${dataFile}`, '-m', 'pytest', ...extraArgs, ...paths]), convert],
          reportSearchDir, hint: NO_REPORT_HINT,
        };
      }
      if (installed.coverage) {
        const runs = unittestRuns(project, target, extraArgs);
        const append = runs.length > 1 ? ['--append'] : [];
        return {
          steps: [...runs.map(args => step(['-m', 'coverage', 'run', ...append, `--data-file=${dataFile}`, '-m', 'unittest', ...args])), convert],
          reportSearchDir, hint: NO_REPORT_HINT,
        };
      }
      return { steps: [], reportSearchDir, hint: NO_COVERAGE_HINT };
    },
  };
}

export const pythonAdapter: Adapter = createPythonAdapter();
