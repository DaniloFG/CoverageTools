import path from 'node:path';
import { jestAdapter } from './jest';
import {
  localBin, packageManagerOf, readPackageJson, scriptCommand, scriptCommandWords, scriptInvokes, toolName, workspaceFolderOf,
  type PackageJson,
} from './nodeShared';
import type { Adapter, FsReader, Project } from './types';
import { vitestAdapter } from './vitest';

/** The `test` script `npm init` writes, which runs no tests. */
const NPM_INIT_PLACEHOLDER = 'echo "Error: no test specified" && exit 1';
const MOCHARC_FILES = ['js', 'cjs', 'mjs', 'json', 'jsonc', 'yaml', 'yml'].map(ext => `.mocharc.${ext}`);
const OWN_COVERAGE_TOOLS = ['nyc', 'c8'];
const HINT = 'No coverage report was produced. Coverage for this project is collected with c8, which needs Node.js 18 or later.';
const WATCH_HINT = 'The test script runs in watch mode, so it never finishes. Remove the watch flag or set a command for this project in "coverageTools.commands".';
const OWN_TOOL_HINT = 'The test script runs its own coverage tool but wrote no report the extension can read. Add an "lcov" or "json" reporter.';

/** The extensions in @istanbuljs/schema's default-extension, as its default-exclude spells them. */
const EXTENSIONS = 'js,cjs,mjs,ts,tsx,jsx';

/**
 * What c8 leaves out. c8's `--exclude` replaces its defaults, so they are passed again: first
 * @istanbuljs/schema 0.1.6's default-exclude (a unit test compares this copy with the installed package),
 * then Mocha's spec conventions and Yarn Berry's in-project files (`.yarn/releases/*.cjs`, `.pnp.cjs`,
 * `.pnp.loader.mjs`), which run inside the wrapped `yarn run test`. node_modules is excluded by c8's
 * own `--exclude-node-modules`, on by default.
 */
export const C8_EXCLUDES: readonly string[] = [
  'coverage/**',
  'packages/*/test{,s}/**',
  '**/*.d.ts',
  'test{,s}/**',
  `test{,-*}.{${EXTENSIONS}}`,
  `**/*{.,-}test.{${EXTENSIONS}}`,
  '**/__tests__/**',
  '**/{ava,babel,nyc}.config.{js,cjs,mjs}',
  '**/jest.config.{js,cjs,mjs,ts}',
  '**/{karma,rollup,webpack}.config.js',
  '**/.{eslint,mocha}rc.{js,cjs}',
  `**/*{.,-}spec.{${EXTENSIONS}}`,
  'spec{,s}/**',
  '.yarn/**',
  '.pnp.*',
];

/** A watch flag in any command of the test script: `--watch` (Mocha, `node --test`), `--watch-path`, Mocha's `-w`. */
function watches(pkg: PackageJson): boolean {
  return scriptCommandWords(pkg).some(words =>
    words.some(w => w === '--watch' || w === '--watch=true' || w.startsWith('--watch-path'))
    || (words.includes('-w') && words.some(w => ['mocha', '_mocha'].includes(toolName(w)))));
}

/** The c8 entry point shipped inside the extension. */
export function c8BinPath(extensionRoot: string): string {
  return path.join(extensionRoot, 'node_modules', 'c8', 'bin', 'c8.js');
}

function hasTestScript(pkg: PackageJson): boolean {
  const test = pkg.scripts?.test;
  return typeof test === 'string' && test.trim() !== '' && test.trim() !== NPM_INIT_PLACEHOLDER;
}

async function hasMocharc(dir: string, fs: FsReader): Promise<boolean> {
  for (const name of MOCHARC_FILES) {
    if (await fs.exists(path.join(dir, name))) return true;
  }
  return false;
}

/**
 * Any other Node project with tests: a real `test` script or a Mocha config. Its whole test command
 * runs under the c8 bundled with the extension, which collects coverage from V8 whatever the runner.
 */
export const nodeGenericAdapter: Adapter = {
  id: 'node-generic',
  ecosystem: 'node',

  async detect(candidate, fs) {
    const pkgFile = path.basename(candidate) === 'package.json' ? candidate : path.join(candidate, 'package.json');
    const pkg = await readPackageJson(pkgFile, fs);
    if (pkg === undefined) return undefined;
    const dir = path.dirname(pkgFile);
    if (!hasTestScript(pkg) && !(await hasMocharc(dir, fs))) return undefined;
    if ((await jestAdapter.detect(pkgFile, fs)) !== undefined || (await vitestAdapter.detect(pkgFile, fs)) !== undefined) return undefined;
    return {
      key: `project:${pkgFile}`,
      adapter: 'node-generic',
      ecosystem: 'node',
      dir,
      definingFile: pkgFile,
      name: typeof pkg.name === 'string' && pkg.name !== '' ? pkg.name : path.basename(dir),
      supportsPartial: false,
      meta: {},
    } satisfies Project;
  },

  async isTestFile() {
    return false; // Full runs only: no file is runnable on its own.
  },

  async plan(project, _target, ctx) {
    const pkg = (await readPackageJson(path.join(project.dir, 'package.json'), ctx.fs)) ?? {};
    const pm = await packageManagerOf(project.dir, ctx.fs, workspaceFolderOf(project));
    const extra = ctx.settings.nodeExtraArgs;
    if (hasTestScript(pkg) && watches(pkg)) return { steps: [], reportSearchDir: ctx.tmpDir, hint: WATCH_HINT };
    if (hasTestScript(pkg) && scriptInvokes(pkg, OWN_COVERAGE_TOOLS)) {
      // Wrapping nyc or c8 in c8 again would measure the wrong process; the script's own report is used.
      const { command, args } = scriptCommand(pm, 'test', extra);
      return { steps: [{ command, args, cwd: project.dir }], reportSearchDir: project.dir, hint: OWN_TOOL_HINT };
    }
    const test = hasTestScript(pkg) ? scriptCommand(pm, 'test', extra) : localBin(pm, 'mocha', extra);
    const c8Args = [
      ctx.c8Bin,
      '--reporter=json',
      `--reports-dir=${ctx.tmpDir}`,
      // c8's raw V8 output; kept apart from the report, which the run searches for in tmpDir.
      `--temp-directory=${path.join(ctx.tmpDir, 'v8')}`,
      ...C8_EXCLUDES.map(glob => `--exclude=${glob}`),
    ];
    return {
      steps: [{ command: 'node', args: [...c8Args, test.command, ...test.args], cwd: project.dir }],
      reportSearchDir: ctx.tmpDir,
      hint: HINT,
    };
  },
};
