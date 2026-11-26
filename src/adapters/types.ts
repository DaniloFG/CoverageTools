import type { Settings } from '../settings';

export type AdapterId = 'dotnet-vstest' | 'dotnet-mtp' | 'jest' | 'vitest' | 'node-generic' | 'python' | 'custom';
export type Ecosystem = 'dotnet' | 'node' | 'python' | 'custom';

export interface Project {
  /** `project:${definingFile ?? dir}` */
  key: string;
  adapter: AdapterId;
  ecosystem: Ecosystem;
  dir: string;
  definingFile?: string;
  name: string;
  supportsPartial: boolean;
  meta: Readonly<Record<string, unknown>>;
}

export type RunTarget = { kind: 'full' } | { kind: 'partial'; paths: readonly string[] };

export interface CommandSpec {
  command: string;
  args: readonly string[];
  cwd: string;
  env?: Readonly<Record<string, string>>;
  /** Runs `command` as a full command line through the platform shell; `args` are ignored. */
  shell?: boolean;
  /** A non-zero exit of this step is not a failure of the run (a step that has nothing to do may exit 1). */
  ignoreFailure?: boolean;
}

export interface RunPlan {
  steps: readonly CommandSpec[];
  /**
   * Where the report is searched for after the steps ran. It is searched recursively for known report
   * file names only (`coverage-final.json`, `lcov.info`, `*.lcov`, `coverage.xml`, `cobertura-coverage.xml`,
   * `*.cobertura.xml`); other JSON/XML files and `tmp`/`.nyc_output` folders are ignored. Outside the run's
   * temp directory only reports written during the run count.
   */
  reportSearchDir: string;
  /**
   * The steps write one report each (a long selection split in several runs): a partial run loads
   * and unions every report found instead of the best one.
   */
  unionReports?: boolean;
  /** Shown to the user when no report is found. */
  hint: string;
}

export interface FsReader {
  readText(path: string): Promise<string | undefined>;
  exists(path: string): Promise<boolean>;
  find(dir: string, include: readonly string[], exclude: readonly string[]): Promise<string[]>;
}

export interface PlanContext {
  tmpDir: string;
  fs: FsReader;
  settings: Settings;
  c8Bin: string;
  /** For tests: the longest command line a run may use (see `commandLineLimit` in nodeShared). */
  commandLineLimit?: number;
  probe(spec: CommandSpec): Promise<{ code: number | null; stdout: string }>;
}

export interface Adapter {
  readonly id: AdapterId;
  readonly ecosystem: Ecosystem;
  /** candidate: a .csproj, a package.json or a directory. */
  detect(candidate: string, fs: FsReader): Promise<Project | undefined>;
  isTestFile(project: Project, path: string, fs: FsReader): Promise<boolean>;
  plan(project: Project, target: RunTarget, ctx: PlanContext): Promise<RunPlan>;
}
