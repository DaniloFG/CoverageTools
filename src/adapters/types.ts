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
}

export interface RunPlan {
  steps: readonly CommandSpec[];
  /** Where the report is searched for after the steps ran. */
  reportSearchDir: string;
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
