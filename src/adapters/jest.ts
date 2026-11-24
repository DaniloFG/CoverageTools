import path from 'node:path';
import { localBin, NODE_TEST_FILE, packageManagerOf, readPackageJson, relativePosix, scriptCommand, scriptTailCalls } from './nodeShared';
import type { Adapter, FsReader, Project } from './types';

/** A script command that runs Jest (Create React App's `react-scripts test` wraps it). */
const JEST_TOOL = /^(?:jest|react-scripts test)(?:\s|$)/;
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
    const pm = await packageManagerOf(project.dir, ctx.fs);
    const args = [
      '--coverage',
      '--coverageReporters=json',
      `--coverageDirectory=${ctx.tmpDir}`,
      ...ctx.settings.nodeExtraArgs,
      ...(target.kind === 'partial' ? target.paths.map(p => relativePosix(project.dir, p)) : []),
    ];
    const script = scriptTailCalls(pkg, JEST_TOOL);
    const { command, args: fullArgs } = script !== undefined ? scriptCommand(pm, script, args) : localBin(pm, 'jest', args);
    return {
      steps: [{ command, args: fullArgs, cwd: project.dir, env: { CI: 'true' } }],
      reportSearchDir: ctx.tmpDir,
      hint: HINT,
    };
  },
};
