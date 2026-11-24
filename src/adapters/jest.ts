import path from 'node:path';
import {
  localBin, NO_TEST_FILES_HINT, NODE_TEST_FILE, packageManagerOf, readPackageJson, relativePosix, scriptCommand, scriptTailCalls,
  selectedTestFiles, workspaceFolderOf,
} from './nodeShared';
import type { Adapter, FsReader, Project } from './types';

/** A script command that runs Jest (Create React App's `react-scripts test` wraps it). */
const JEST_TOOL = /^(?:jest|react-scripts test)(?:\s|$)/;
/** Watch flags `CI=true` does not override (Jest's `-w` is --maxWorkers, not watch). */
const JEST_WATCH = /\s--watch(?:All)?(?:=true)?(?:\s|$)/;
const CONFIG_FILES = ['js', 'ts', 'mjs', 'cjs', 'mts', 'cts', 'json'].map(ext => `jest.config.${ext}`);
const HINT = 'Jest did not write a coverage report. Check that the project\'s tests run with "--coverage".';

async function hasConfigFile(dir: string, fs: FsReader): Promise<boolean> {
  for (const name of CONFIG_FILES) {
    if (await fs.exists(path.join(dir, name))) return true;
  }
  return false;
}

export const jestAdapter: Adapter = {
  id: 'jest',
  ecosystem: 'node',

  async detect(candidate, fs) {
    const pkgFile = path.basename(candidate) === 'package.json' ? candidate : path.join(candidate, 'package.json');
    const pkg = await readPackageJson(pkgFile, fs);
    if (pkg === undefined) return undefined;
    const dir = path.dirname(pkgFile);
    const isJest = pkg.jest !== undefined || scriptTailCalls(pkg, JEST_TOOL) !== undefined || (await hasConfigFile(dir, fs));
    if (!isJest) return undefined;
    return {
      key: `project:${pkgFile}`,
      adapter: 'jest',
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
    let selection: string[] = [];
    if (target.kind === 'partial') {
      const files = await selectedTestFiles(project.dir, target.paths, ctx.fs, ctx.settings.exclude, rel => NODE_TEST_FILE.test(rel));
      if (files.length === 0) return { steps: [], reportSearchDir: ctx.tmpDir, hint: NO_TEST_FILES_HINT };
      // Positional arguments are regexes ORed with any pattern in the script; --runTestsByPath makes them exact paths.
      selection = ['--runTestsByPath', ...files.map(p => relativePosix(project.dir, p))];
    }
    const args = [
      '--coverage',
      '--coverageReporters=json',
      `--coverageDirectory=${ctx.tmpDir}`,
      ...ctx.settings.nodeExtraArgs,
      ...selection,
    ];
    const call = scriptTailCalls(pkg, JEST_TOOL, JEST_WATCH);
    const { command, args: fullArgs } = call !== undefined ? scriptCommand(pm, call.script, args) : localBin(pm, 'jest', args);
    return {
      steps: [{ command, args: fullArgs, cwd: project.dir, env: { ...call?.env, CI: 'true' } }],
      reportSearchDir: ctx.tmpDir,
      hint: HINT,
    };
  },
};
