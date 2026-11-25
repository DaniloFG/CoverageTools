import path from 'node:path';
import type { Adapter, Project } from './types';

/** Replaced by the run's temp directory in a custom command line. */
const COVERAGE_DIR = '${coverageDir}';
const HINT =
  'The custom command wrote no coverage report the extension can read. Write an Istanbul JSON, Cobertura or LCOV report into "${coverageDir}".';

/**
 * The project of a `coverageTools.commands` entry: `dir` (absolute) runs `command`, a full command
 * line, as a whole. Discovery creates these from the settings; no file makes one.
 */
export function customProject(dir: string, command: string, workspaceFolder: string): Project {
  return {
    key: `project:${dir}`,
    adapter: 'custom',
    ecosystem: 'custom',
    dir,
    name: path.basename(dir) || dir,
    supportsPartial: false,
    meta: { command, workspaceFolder },
  };
}

/**
 * Runs the command line of a `coverageTools.commands` entry through the platform shell, in the
 * project directory, with every `${coverageDir}` replaced by the run's temp directory as is (the
 * command line quotes it when the path may contain spaces). The report is then searched for in that
 * temp directory; when the command does not mention `${coverageDir}`, in the project directory,
 * where only reports written during the run count.
 */
export const customAdapter: Adapter = {
  id: 'custom',
  ecosystem: 'custom',

  async detect() {
    return undefined;
  },

  async isTestFile() {
    return false; // Full runs only.
  },

  async plan(project, _target, ctx) {
    const line = typeof project.meta.command === 'string' ? project.meta.command : '';
    const usesDir = line.includes(COVERAGE_DIR);
    return {
      steps: [{ command: line.split(COVERAGE_DIR).join(ctx.tmpDir), args: [], cwd: project.dir, shell: true }],
      reportSearchDir: usesDir ? ctx.tmpDir : project.dir,
      hint: HINT,
    };
  },
};
