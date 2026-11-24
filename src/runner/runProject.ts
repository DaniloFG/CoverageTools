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

const SKIPPED_DIRS = new Set(['node_modules', '.git', '.venv', 'venv', 'bin', 'obj']);
const MAX_DEPTH = 8;
/** Report names accepted when the adapter scans the project itself rather than its own temp directory. */
const KNOWN_REPORT_NAME = /^(coverage-final\.json|.*\.cobertura\.xml|cobertura-coverage\.xml|coverage\.xml|lcov\.info|.*\.lcov)$/i;

const CANCELLED: RunOutcome = { status: 'cancelled' };

/**
 * Runs one project's tests with coverage and loads the report into the store: replaced for a full
 * run, unioned for a partial one. Reports are written to a fresh temp directory outside the workspace,
 * which is always removed, and the watcher is told to ignore the project while it runs.
 */
export async function runProject(project: Project, target: RunTarget, deps: RunDeps, signal: AbortSignal): Promise<RunOutcome> {
  if (signal.aborted) return CANCELLED;
  const adapter = deps.adapters.get(project.adapter);
  if (adapter === undefined) return { status: 'spawn-error', message: `No adapter for ${project.adapter}` };

  const startedAt = Date.now();
  const tmpDir = await mkdtemp(path.join(await realpath(os.tmpdir()), 'coverage-tools-'));
  const suppression = deps.suppress(project.key);
  try {
    const ctx: PlanContext = {
      tmpDir, fs: deps.fs, settings: deps.settings, c8Bin: deps.c8Bin,
      probe: spec => probe(spec, signal),
    };
    let plan;
    try {
      plan = await adapter.plan(project, target, ctx);
    } catch (e) {
      if (signal.aborted) return CANCELLED;
      return { status: 'spawn-error', message: messageOf(e) };
    }
    if (signal.aborted) return CANCELLED;
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
      if (signal.aborted) return CANCELLED;
      // A failing step does not stop the next ones: a later step may still turn its output into a report.
      if (code !== 0 && failedCode === undefined) failedCode = code;
    }

    const insideTmp = isInside(plan.reportSearchDir, tmpDir);
    const report = await findReport(plan.reportSearchDir, insideTmp ? undefined : startedAt);
    if (signal.aborted) return CANCELLED;
    if (report === undefined) return { status: 'no-report', hint: plan.hint };

    let parsed;
    try {
      parsed = await deps.parser.parse(report, deps.roots);
    } catch (e) {
      if (signal.aborted) return CANCELLED;
      return { status: 'bad-report', message: `${report}: ${messageOf(e)}` };
    }
    if (signal.aborted) return CANCELLED;

    if (target.kind === 'full') deps.store.replace(project.key, parsed.files);
    else deps.store.union(project.key, parsed.files);

    if (failedCode !== undefined) {
      return { status: 'tests-failed', message: failedCode === null ? 'A step was terminated' : `A step exited with code ${failedCode}` };
    }
    return { status: 'ok' };
  } finally {
    suppression.release();
    await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
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

interface Candidate { path: string; format: ReportFormat; mtimeMs: number }

/**
 * The report a run produced, searched recursively (and boundedly) in `dir`: the first format of
 * FORMAT_PRIORITY found (coverage.py data excluded, it must be converted first), and among several
 * of that format the most recently modified. With `since`, the adapter scans the project itself, so
 * only files with a known report name modified during the run count; it is rounded down to the
 * second, for file systems with a coarse modification time.
 */
async function findReport(dir: string, since: number | undefined): Promise<string | undefined> {
  const minMtime = since === undefined ? -Infinity : Math.floor(since / 1000) * 1000;
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
      if (!entry.isFile()) continue;
      const format = formatOf(entry.name);
      if (format === undefined || format === 'coveragepy') continue;
      if (since !== undefined && !KNOWN_REPORT_NAME.test(entry.name)) continue;
      const info = await stat(full).catch(() => undefined);
      if (info === undefined || info.mtimeMs < minMtime) continue;
      candidates.push({ path: full, format, mtimeMs: info.mtimeMs });
    }
  };
  await walk(dir, 0);

  for (const format of FORMAT_PRIORITY) {
    const ofFormat = candidates.filter(c => c.format === format);
    if (ofFormat.length > 0) return ofFormat.reduce((a, b) => (b.mtimeMs > a.mtimeMs ? b : a)).path;
  }
  return undefined;
}
