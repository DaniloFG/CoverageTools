import { mkdtemp, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Adapter, AdapterId, CommandSpec, FsReader, PlanContext, Project, RunTarget } from '../adapters/types';
import { formatOf } from '../parsers/load';
import { FORMAT_PRIORITY } from '../parsers/types';
import type { Settings } from '../settings';
import type { CoverageStore } from '../store';
import type { ParserClient } from '../worker/client';
import { exec } from './exec';

export type RunStatus = 'ok' | 'tests-failed' | 'no-report' | 'bad-report' | 'cancelled' | 'spawn-error';
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
    let startMtime: number;
    try {
      tmpDir = await mkdtemp(path.join(await realpath(os.tmpdir()), 'coverage-tools-'));
      startMtime = await startMarker(tmpDir);
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

    let failedCode: number | null | undefined;
    for (const step of plan.steps) {
      deps.output(`> ${describe(step)}\n`);
      let code: number | null;
      try {
        ({ code } = await exec(step, { onOutput: deps.output, signal }));
      } catch (e) {
        return { status: 'spawn-error', message: `Could not start ${step.command}: ${messageOf(e)}`, hint: plan.hint };
      }
      if (signal.aborted) return cancelled();
      // A failing step does not stop the next ones: a later step may still turn its output into a report.
      if (code !== 0 && failedCode === undefined) failedCode = code;
    }

    const insideTmp = isInside(plan.reportSearchDir, tmpDir);
    const candidates = await findReports(plan.reportSearchDir, insideTmp ? undefined : startMtime);
    if (signal.aborted) return cancelled();
    if (candidates.length === 0) return { status: 'no-report', hint: plan.hint };

    // The best candidate first; one that turns out not to be a readable report gives way to the next.
    const errors: string[] = [];
    let parsed;
    for (const report of candidates) {
      try {
        parsed = await deps.parser.parse(report, deps.roots);
        break;
      } catch (e) {
        if (signal.aborted) return cancelled();
        errors.push(`${report}: ${messageOf(e)}`);
      }
    }
    if (signal.aborted) return cancelled();
    if (parsed === undefined) return { status: 'bad-report', message: errors.join('\n') };

    if (target.kind === 'full') deps.store.replace(project.key, parsed.files);
    else deps.store.union(project.key, parsed.files);

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
 * Writes a marker file and returns its modification time, as the file system clock sees it. Reports
 * modified strictly after it were written by this run; comparing with `Date.now()` instead would be
 * off by the kernel's coarse clock or a file system's whole-second resolution.
 */
async function startMarker(tmpDir: string): Promise<number> {
  const marker = path.join(tmpDir, '.run-started');
  await writeFile(marker, '');
  return (await stat(marker)).mtimeMs;
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

interface Candidate { path: string; rank: number; mtimeMs: number }

/**
 * The reports found in `dir` (recursively, boundedly), best first: by FORMAT_PRIORITY (coverage.py data
 * excluded, it must be converted first), then most recently modified. Only known report names count.
 * With `after`, the adapter scans the project itself, so only files modified after that time count.
 */
async function findReports(dir: string, after: number | undefined): Promise<string[]> {
  const candidates: Candidate[] = [];

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
      if (info === undefined || (after !== undefined && !(info.mtimeMs > after))) continue;
      candidates.push({ path: full, rank: FORMAT_PRIORITY.indexOf(format), mtimeMs: info.mtimeMs });
    }
  };
  await walk(dir, 0);

  return candidates.sort((a, b) => a.rank - b.rank || b.mtimeMs - a.mtimeMs).map(c => c.path);
}
