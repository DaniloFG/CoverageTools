import { mkdtemp, readdir, realpath, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Adapter, AdapterId, CommandSpec, FsReader, PlanContext, Project, RunTarget } from '../adapters/types';
import { formatOf } from '../parsers/load';
import { FORMAT_PRIORITY, type ReportFormat } from '../parsers/types';
import type { Settings } from '../settings';
import type { CoverageStore } from '../store';
import type { ParserClient } from '../worker/client';
import { exec } from './exec';

export type RunStatus = 'ok' | 'tests-failed' | 'threshold-not-met' | 'no-report' | 'bad-report' | 'cancelled' | 'spawn-error';
export interface RunOutcome { status: RunStatus; message?: string; hint?: string }
export interface RunDeps {
  adapters: ReadonlyMap<AdapterId, Adapter>;
  store: CoverageStore;
  parser: ParserClient;
  fs: FsReader;
  settings: Settings;
  roots: readonly string[];
  c8Bin: string;
  output(chunk: string): void;
  /** The watcher ignores the project until release + 2,000 ms. */
  suppress(projectKey: string): { release(): void };
}

const SKIPPED_DIRS = new Set(['node_modules', '.git', '.venv', 'venv', 'bin', 'obj', 'tmp', '.nyc_output']);
const MAX_DEPTH = 8;
/**
 * The only file names taken as reports. `formatOf` maps any .json/.xml to a format, but runs leave other
 * JSON/XML around (c8's raw V8 `coverage-<pid>-….json`, test results, fixtures).
 */
const KNOWN_REPORT_NAME = /^(coverage-final\.json|lcov\.info|.*\.lcov|coverage\.xml|cobertura-coverage\.xml|.*\.cobertura\.xml)$/i;

/** What tools print when a coverage threshold made them exit non-zero (Jest, pytest-cov, coverage.py, Vitest, c8). */
const THRESHOLD_MESSAGE = /coverage threshold for|Required test coverage of .* not reached|Coverage failure: total of|does not meet (?:global |per-file )?threshold|fail-under/i;
/** Signs that tests failed too: `2 failed`, `FAILED (failures=1)`, `3 failing`. */
const TEST_FAILURES = /\b[1-9]\d* (?:failed|failing)\b|FAILED \((?:failures|errors)=|\bfailures=[1-9]/i;
/** How much of the end of the output is kept to tell the two apart. */
const OUTPUT_TAIL = 32_768;

const cancelled = (): RunOutcome => ({ status: 'cancelled' });

/**
 * Runs one project's tests with coverage and loads the report into the store: replaced for a full
 * run, unioned for a partial one. Reports are written to a fresh temp directory outside the workspace,
 * which is always removed, and the watcher is told to ignore the project while it runs. Never rejects:
 * every failure is an outcome.
 */
export async function runProject(project: Project, target: RunTarget, deps: RunDeps, signal: AbortSignal): Promise<RunOutcome> {
  if (signal.aborted) return cancelled();
  const adapter = deps.adapters.get(project.adapter);
  if (adapter === undefined) return { status: 'spawn-error', message: `No adapter for ${project.adapter}` };

  let tmpDir: string | undefined;
  let suppression: { release(): void } | undefined;
  try {
    try {
      tmpDir = await mkdtemp(path.join(await realpath(os.tmpdir()), 'coverage-tools-'));
      suppression = deps.suppress(project.key);
    } catch (e) {
      return { status: 'spawn-error', message: `Could not prepare the run: ${messageOf(e)}` };
    }

    const ctx: PlanContext = {
      tmpDir, fs: deps.fs, settings: deps.settings, c8Bin: deps.c8Bin,
      probe: spec => probe(spec, signal),
    };
    let plan;
    try {
      plan = await adapter.plan(project, target, ctx);
    } catch (e) {
      if (signal.aborted) return cancelled();
      return { status: 'spawn-error', message: messageOf(e) };
    }
    if (signal.aborted) return cancelled();
    if (plan.steps.length === 0) return { status: 'no-report', hint: plan.hint };

    // When the adapter scans the project itself, reports already there are left over from earlier runs:
    // only files that are new or changed since this snapshot count.
    const insideTmp = isInside(plan.reportSearchDir, tmpDir);
    const before = insideTmp ? undefined : await scanReports(plan.reportSearchDir);
    if (signal.aborted) return cancelled();

    let failedCode: number | null | undefined;
    let tail = '';
    const onOutput = (chunk: string): void => {
      deps.output(chunk);
      tail = (tail + chunk).slice(-OUTPUT_TAIL);
    };
    for (const step of plan.steps) {
      deps.output(`> ${describe(step)}\n`);
      let code: number | null;
      try {
        ({ code } = await exec(step, { onOutput, signal }));
      } catch (e) {
        return { status: 'spawn-error', message: `Could not start ${step.command}: ${messageOf(e)}`, hint: plan.hint };
      }
      if (signal.aborted) return cancelled();
      // A failing step does not stop the next ones: a later step may still turn its output into a report.
      if (code !== 0 && failedCode === undefined && !step.ignoreFailure) failedCode = code;
    }

    const candidates = await findReports(plan.reportSearchDir, before);
    if (signal.aborted) return cancelled();
    if (candidates.length === 0) return { status: 'no-report', hint: plan.hint };

    // The best candidate first; one that turns out not to be a readable report gives way to the next.
    // A plan that split its selection over several runs has one report for each: all are loaded.
    const errors: string[] = [];
    const roots = rootsFor(project, deps.roots);
    const all = plan.unionReports === true && target.kind === 'partial';
    const loaded: Array<Awaited<ReturnType<typeof deps.parser.parse>>> = [];
    for (const report of candidates) {
      try {
        loaded.push(await deps.parser.parse(report, roots));
        if (!all) break;
      } catch (e) {
        if (signal.aborted) return cancelled();
        errors.push(`${report}: ${messageOf(e)}`);
      }
    }
    if (signal.aborted) return cancelled();
    if (loaded.length === 0) return { status: 'bad-report', message: errors.join('\n') };

    // A partial run of a large project unions thousands of files: in slices, never in one main-thread block.
    for (const parsed of loaded) {
      if (target.kind === 'full') deps.store.replace(project.key, parsed.files);
      else await deps.store.unionInSlices(project.key, parsed.files);
    }
    if (all && (errors.length > 0 || loaded.length < plan.steps.length)) {
      deps.output(`Warning: ${loaded.length} of ${plan.steps.length} coverage reports were loaded; coverage of some selected tests is missing.\n`);
    }

    if (failedCode !== undefined && THRESHOLD_MESSAGE.test(tail) && !TEST_FAILURES.test(tail)) {
      return { status: 'threshold-not-met', message: 'The coverage threshold was not met' };
    }
    if (failedCode !== undefined) {
      return { status: 'tests-failed', message: failedCode === null ? 'A step was terminated' : `A step exited with code ${failedCode}` };
    }
    return { status: 'ok' };
  } finally {
    try {
      suppression?.release();
    } catch {
      // The temp directory is still removed.
    }
    if (tmpDir !== undefined) await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * The roots relative report paths are resolved against, the project's own location first: in a
 * multi-root workspace another root may hold a file with the same relative path.
 */
function rootsFor(project: Project, roots: readonly string[]): string[] {
  const folder = project.meta.workspaceFolder;
  return [...new Set([project.dir, ...(typeof folder === 'string' ? [folder] : []), ...roots])];
}

async function probe(spec: CommandSpec, signal: AbortSignal): Promise<{ code: number | null; stdout: string }> {
  let stdout = '';
  const { code } = await exec(spec, { onOutput: chunk => { stdout += chunk; }, signal });
  return { code, stdout };
}

function describe(step: CommandSpec): string {
  if (step.shell) return step.command;
  return [step.command, ...step.args].map(a => (a === '' || /[\s"']/.test(a) ? JSON.stringify(a) : a)).join(' ');
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

interface Found { format: ReportFormat; mtimeMs: number; size: number; ino: number }

/**
 * The known report files in `dir`, searched recursively and boundedly (dependency, build and temp
 * folders skipped; coverage.py data excluded, it must be converted first).
 */
async function scanReports(dir: string): Promise<Map<string, Found>> {
  const found = new Map<string, Found>();
  const walk = async (current: string, depth: number): Promise<void> => {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (depth < MAX_DEPTH && !SKIPPED_DIRS.has(entry.name)) await walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile() || !KNOWN_REPORT_NAME.test(entry.name)) continue;
      const format = formatOf(entry.name);
      if (format === undefined || format === 'coveragepy') continue;
      const info = await stat(full).catch(() => undefined);
      if (info !== undefined) found.set(full, { format, mtimeMs: info.mtimeMs, size: info.size, ino: info.ino });
    }
  };
  await walk(dir, 0);
  return found;
}

/**
 * The reports in `dir`, best first: by FORMAT_PRIORITY, then most recently modified. With `before`
 * (a snapshot taken before the steps ran), only files that are new or whose mtime, size or inode
 * changed count. Comparing a file with its own earlier state, rather than with a clock, holds on
 * file systems with coarse timestamps or a clock of their own (network shares).
 */
async function findReports(dir: string, before: ReadonlyMap<string, Found> | undefined): Promise<string[]> {
  const candidates: Array<Found & { path: string }> = [];
  for (const [p, f] of await scanReports(dir)) {
    const old = before?.get(p);
    if (old !== undefined && old.mtimeMs === f.mtimeMs && old.size === f.size && old.ino === f.ino) continue;
    candidates.push({ path: p, ...f });
  }
  const rank = (f: Found) => FORMAT_PRIORITY.indexOf(f.format);
  return candidates.sort((a, b) => rank(a) - rank(b) || b.mtimeMs - a.mtimeMs).map(c => c.path);
}
