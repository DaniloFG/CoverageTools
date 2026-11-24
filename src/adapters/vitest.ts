import path from 'node:path';
import {
  localBin, NO_TEST_FILES_HINT, NODE_TEST_FILE, packageManagerOf, readPackageJson, relativePosix, scriptCommand, scriptTailCalls,
  selectedTestFiles, workspaceFolderOf,
} from './nodeShared';
import type { Adapter, FsReader, Project } from './types';

/** A script command that runs Vitest. */
const VITEST_TOOL = /^vitest(?:\s|$)/;
/** Watch mode that `CI=true` does not override: the `watch`/`dev` subcommands and `--watch`/`-w`. */
const VITEST_WATCH = /^vitest\s+(?:watch|dev)(?:\s|$)|\s(?:--watch|-w)(?:=true)?(?:\s|$)/;
/** Characters with a meaning in the globs Vitest's `--exclude` takes. */
const GLOB_SPECIAL = /[\\*?[\]{}()!+@]/g;
const CONFIG_EXTENSIONS = ['ts', 'mts', 'cts', 'js', 'mjs', 'cjs'];
/** A `test` property in a Vite config, which is where Vitest reads its options from. */
const TEST_BLOCK = /(?:^|[\s{,])["']?test["']?\s*:/m;
const HINT = 'Vitest did not write a coverage report. Install its coverage provider: "@vitest/coverage-v8".';

async function hasConfig(dir: string, fs: FsReader): Promise<boolean> {
  for (const ext of CONFIG_EXTENSIONS) {
    if (await fs.exists(path.join(dir, `vitest.config.${ext}`))) return true;
  }
  for (const ext of CONFIG_EXTENSIONS) {
    const text = await fs.readText(path.join(dir, `vite.config.${ext}`));
    if (text !== undefined && TEST_BLOCK.test(text)) return true;
  }
  return false;
}

export const vitestAdapter: Adapter = {
  id: 'vitest',
  ecosystem: 'node',

  async detect(candidate, fs) {
    const pkgFile = path.basename(candidate) === 'package.json' ? candidate : path.join(candidate, 'package.json');
    const pkg = await readPackageJson(pkgFile, fs);
    if (pkg === undefined) return undefined;
    const dir = path.dirname(pkgFile);
    if (scriptTailCalls(pkg, VITEST_TOOL) === undefined && !(await hasConfig(dir, fs))) return undefined;
    return {
      key: `project:${pkgFile}`,
      adapter: 'vitest',
      ecosystem: 'node',
      dir,
      definingFile: pkgFile,
      name: typeof pkg.name === 'string' && pkg.name !== '' ? pkg.name : path.basename(dir),
      supportsPartial: true,
      meta: {},
    } satisfies Project;
  },

  async isTestFile(project, file) {
    const rel = relativePosix(project.dir, file);
    if (rel.startsWith('../') || path.isAbsolute(rel) || rel.split('/').includes('node_modules')) return false;
    return NODE_TEST_FILE.test(rel);
  },

  async plan(project, target, ctx) {
    const pkg = (await readPackageJson(path.join(project.dir, 'package.json'), ctx.fs)) ?? {};
    const pm = await packageManagerOf(project.dir, ctx.fs, workspaceFolderOf(project));
    const selection = target.kind === 'partial' ? await partialArgs(project, target.paths, ctx.fs, ctx.settings.exclude) : [];
    if (selection.length === 0 && target.kind === 'partial') {
      return { steps: [], reportSearchDir: ctx.tmpDir, hint: NO_TEST_FILES_HINT };
    }
    const args = [
      '--coverage',
      '--coverage.reporter=json',
      `--coverage.reportsDirectory=${ctx.tmpDir}`,
      ...ctx.settings.nodeExtraArgs,
      ...selection,
    ];
    const call = scriptTailCalls(pkg, VITEST_TOOL, VITEST_WATCH);
    // A bare `vitest` starts watch mode in a terminal: CI=true (and `run` for the binary) makes it run once.
    const { command, args: fullArgs } = call !== undefined ? scriptCommand(pm, call.script, args) : localBin(pm, 'vitest', ['run', ...args]);
    return {
      steps: [{ command, args: fullArgs, cwd: project.dir, env: { ...call?.env, CI: 'true' } }],
      reportSearchDir: ctx.tmpDir,
      hint: HINT,
    };
  },
};

const isTestRel = (rel: string): boolean => NODE_TEST_FILE.test(rel);

/**
 * The arguments that make Vitest run exactly the selected test files: the files as filters, preceded by
 * an `--exclude` for every other test file of the project that a filter would also match (Vitest's
 * filters are case-insensitive substrings of the path relative to the project). Empty when nothing
 * is selected.
 */
async function partialArgs(project: Project, paths: readonly string[], fs: FsReader, exclude: readonly string[]): Promise<string[]> {
  const selected = await selectedTestFiles(project.dir, paths, fs, exclude, isTestRel);
  if (selected.length === 0) return [];
  const filters = selected.map(p => relativePosix(project.dir, p));
  const lowered = filters.map(f => f.toLowerCase());
  const chosen = new Set(selected);
  const all = await selectedTestFiles(project.dir, [project.dir], fs, exclude, isTestRel);
  const excluded = all
    .filter(p => !chosen.has(p))
    .map(p => relativePosix(project.dir, p))
    .filter(rel => lowered.some(f => rel.toLowerCase().includes(f)));
  return [...excluded.map(rel => `--exclude=${rel.replace(GLOB_SPECIAL, '\\$&')}`), ...filters];
}
