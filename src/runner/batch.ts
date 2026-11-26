import path from 'node:path';
import type { Project, RunTarget } from '../adapters/types';
import type { RunOutcome } from './runProject';

export interface RunItem { project: Project; target: RunTarget }
export interface RunResult { item: RunItem; outcome: RunOutcome }

export interface BatchDeps {
  queue: { enqueue<T>(job: (signal: AbortSignal) => Promise<T>, exclusive?: string): Promise<T> };
  run(item: RunItem, signal: AbortSignal): Promise<RunOutcome>;
  /** The `n`-th item (1-based) of `total` starts; not called for items cancelled before they start. */
  onStart?(item: RunItem, n: number, total: number): void;
  /** An item `onStart` was called for has settled. */
  onEnd?(item: RunItem): void;
  /** Items claimed there (see `InFlight.claim`) are released as each one settles. */
  inFlight?: InFlight;
}

/** The same project with the same target is the same run. */
function runId(item: RunItem): string {
  return item.target.kind === 'full' ? `${item.project.key}\0full` : `${item.project.key}\0partial\0${item.target.paths.join('\0')}`;
}

/**
 * The runs queued or running, so that a request repeated meanwhile (a double click on Run All, Run
 * Coverage Here on a project Run All already queued) does not run the same thing twice.
 */
export class InFlight {
  private readonly ids = new Set<string>();

  /** The items not queued or running yet (each once), now counted as queued. */
  claim(items: readonly RunItem[]): RunItem[] {
    const fresh: RunItem[] = [];
    for (const item of items) {
      const id = runId(item);
      if (this.ids.has(id)) continue;
      this.ids.add(id);
      fresh.push(item);
    }
    return fresh;
  }

  release(item: RunItem): void {
    this.ids.delete(runId(item));
  }
}

const isUnder = (child: string, parent: string): boolean => {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

/**
 * One item per project, in order of first appearance: a full run of a project covers its partial
 * runs; partial runs of the same project become one with the union of their paths, leaving out any
 * path that lies inside another selected path (a selected folder runs its files already).
 */
export function mergeRunItems(items: readonly RunItem[]): RunItem[] {
  const byProject = new Map<string, { project: Project; full: boolean; paths: string[] }>();
  for (const { project, target } of items) {
    let entry = byProject.get(project.key);
    if (entry === undefined) byProject.set(project.key, entry = { project, full: false, paths: [] });
    if (target.kind === 'full') entry.full = true;
    else entry.paths.push(...target.paths);
  }
  return [...byProject.values()].map(({ project, full, paths }): RunItem => {
    if (full) return { project, target: { kind: 'full' } };
    const unique = [...new Set(paths)];
    return { project, target: { kind: 'partial', paths: unique.filter(p => !unique.some(o => o !== p && isUnder(p, o))) } };
  });
}

/**
 * What two runs must share to be kept from running at the same time, also when the queue runs
 * several at once. .NET projects: all of them, since each run builds the projects it references
 * and two builds of one referenced project collide on its `obj` files. Others: the directory,
 * where the tool keeps its data files.
 */
export function exclusiveKey(project: Project): string {
  return project.ecosystem === 'dotnet' ? 'dotnet' : project.dir;
}

/**
 * Puts every item on the run queue at once (so later requests queue behind all of them) and
 * resolves with each item's outcome, in the order given, once all have settled. The queue decides
 * how many run at a time (see `exclusiveKey` for the ones that never do); cancelling it settles
 * the rest as `cancelled` without starting them.
 */
export function runBatch(items: readonly RunItem[], deps: BatchDeps): Promise<RunResult[]> {
  let started = 0;
  return Promise.all(items.map(item => deps.queue.enqueue(async (signal): Promise<RunResult> => {
    const starts = !signal.aborted;
    try {
      if (starts) deps.onStart?.(item, ++started, items.length);
      return { item, outcome: await deps.run(item, signal) };
    } catch (e) {
      return { item, outcome: { status: 'spawn-error', message: messageOf(e) } };
    } finally {
      deps.inFlight?.release(item);
      if (starts) deps.onEnd?.(item);
    }
  }, exclusiveKey(item.project))));
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Logs process output line by line (a log channel stamps every entry); `flush` logs an unfinished last line. */
export function lineLogger(log: (msg: string) => void): { write(chunk: string): void; flush(): void } {
  let rest = '';
  return {
    write(chunk) {
      const lines = (rest + chunk).split(/\r?\n/);
      rest = lines.pop() ?? '';
      for (const line of lines) log(line);
    },
    flush() {
      if (rest !== '') log(rest);
      rest = '';
    },
  };
}

/**
 * Runs one item with its output logged line by line, between `Running coverage for <name> (…).`
 * (left out when it was cancelled before it started) and `Finished coverage for <name>: <status>.`,
 * which is always written, also when `start` throws (that counts as a spawn error). With `tagged`,
 * each output line starts with `[<name>]`: the output of runs made at the same time is interleaved.
 */
export async function loggedRun(
  item: RunItem, signal: AbortSignal, log: (msg: string) => void, start: (output: (chunk: string) => void) => Promise<RunOutcome>,
  tagged = false,
): Promise<RunOutcome> {
  const { project, target } = item;
  const lines = lineLogger(tagged ? line => log(`[${project.name}] ${line}`) : log);
  if (!signal.aborted) log(`Running coverage for ${project.name} (${target.kind === 'full' ? 'all tests' : target.paths.join(', ')}).`);
  let outcome: RunOutcome;
  try {
    outcome = await start(lines.write);
  } catch (e) {
    outcome = { status: 'spawn-error', message: `Unexpected error: ${messageOf(e)}` };
  } finally {
    lines.flush();
  }
  // Tells when a run has ended, and how (tests wait on this line too).
  log(`Finished coverage for ${project.name}: ${outcome.status}.`);
  return outcome;
}

export function progressMessage(name: string, n: number, total: number): string {
  return `Running coverage: ${name} (${n}/${total})`;
}

/** How many runs under way the progress message names before it counts the rest. */
const NAMED_RUNS = 3;

/** The progress message of a batch whose runs may overlap: the runs under way, and how many of the total have started. */
export class RunProgress {
  private readonly running: string[] = [];
  private started = 0;

  constructor(private readonly total: number) {}

  start(name: string): string {
    this.running.push(name);
    this.started++;
    return this.message();
  }

  /** Nothing when no run is under way: the next start, or the end of the batch, follows. */
  end(name: string): string | undefined {
    const i = this.running.indexOf(name);
    if (i >= 0) this.running.splice(i, 1);
    return this.running.length === 0 ? undefined : this.message();
  }

  private message(): string {
    const rest = this.running.length - NAMED_RUNS;
    const names = this.running.slice(0, NAMED_RUNS).join(', ') + (rest > 0 ? ` and ${rest} more` : '');
    return progressMessage(names, this.started, this.total);
  }
}

export interface Notice {
  severity: 'warning' | 'error';
  text: string;
  /** Offer a `Show Output` action. */
  showOutput: boolean;
}

const failed = (o: RunOutcome): boolean => o.status === 'no-report' || o.status === 'bad-report' || o.status === 'spawn-error';

function detail(o: RunOutcome): string {
  return [o.message, o.hint].filter(t => t !== undefined && t !== '').join(' ');
}

/** What to tell the user about one run; nothing for a success or a cancellation. */
export function outcomeNotice(name: string, outcome: RunOutcome): Notice | undefined {
  if (outcome.status === 'tests-failed') {
    return { severity: 'warning', text: `Tests failed in ${name}; coverage was still loaded.`, showOutput: false };
  }
  if (outcome.status === 'threshold-not-met') {
    return { severity: 'warning', text: `Coverage threshold not met in ${name}; coverage was still loaded.`, showOutput: false };
  }
  if (!failed(outcome)) return undefined;
  return { severity: 'error', text: `Coverage failed for ${name}: ${detail(outcome) || 'no coverage report was found.'}`, showOutput: true };
}

/** The output channel line for a run that failed or whose tests failed. */
export function failureDetails(name: string, outcome: RunOutcome): string | undefined {
  const text = detail(outcome);
  if (outcome.status === 'tests-failed') return `Tests failed in ${name} (tests-failed)${text ? `: ${text}` : ''}`;
  if (outcome.status === 'threshold-not-met') return `Coverage threshold not met in ${name} (threshold-not-met)${text ? `: ${text}` : ''}`;
  if (!failed(outcome)) return undefined;
  return `Coverage failed for ${name} (${outcome.status})${text ? `: ${text}` : ''}`;
}

/**
 * The notifications for one command: a single run gets its own message; several runs get at most
 * one warning (tests failed) and one summary error, the details being in the output channel.
 */
export function batchNotices(results: readonly RunResult[]): Notice[] {
  if (results.length === 1) {
    const notice = outcomeNotice(results[0].item.project.name, results[0].outcome);
    return notice ? [notice] : [];
  }
  const names = (keep: (o: RunOutcome) => boolean) => results.filter(r => keep(r.outcome)).map(r => r.item.project.name);
  const testsFailed = names(o => o.status === 'tests-failed');
  const thresholds = names(o => o.status === 'threshold-not-met');
  const errors = names(failed);
  const notices: Notice[] = [];
  if (testsFailed.length > 0) {
    notices.push({ severity: 'warning', text: `Tests failed in ${testsFailed.join(', ')}; coverage was still loaded.`, showOutput: false });
  }
  if (thresholds.length > 0) {
    notices.push({ severity: 'warning', text: `Coverage threshold not met in ${thresholds.join(', ')}; coverage was still loaded.`, showOutput: false });
  }
  if (errors.length > 0) {
    notices.push({
      severity: 'error',
      text: `Coverage failed for ${errors.length} project(s): ${errors.join(', ')}. See the output for details.`,
      showOutput: true,
    });
  }
  return notices;
}
