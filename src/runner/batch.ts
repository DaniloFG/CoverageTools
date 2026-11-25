import type { Project, RunTarget } from '../adapters/types';
import type { RunOutcome } from './runProject';

export interface RunItem { project: Project; target: RunTarget }
export interface RunResult { item: RunItem; outcome: RunOutcome }

export interface BatchDeps {
  queue: { enqueue<T>(job: (signal: AbortSignal) => Promise<T>): Promise<T> };
  run(item: RunItem, signal: AbortSignal): Promise<RunOutcome>;
  /** The `n`-th item (1-based) of `total` starts; not called for items cancelled before they start. */
  onStart?(item: RunItem, n: number, total: number): void;
}

/**
 * Puts every item on the run queue at once (so later requests queue behind all of them) and
 * resolves with each item's outcome, in order, once all have settled. The queue runs one item at a
 * time; cancelling it settles the rest as `cancelled` without starting them.
 */
export function runBatch(items: readonly RunItem[], deps: BatchDeps): Promise<RunResult[]> {
  return Promise.all(items.map((item, i) => deps.queue.enqueue(async (signal): Promise<RunResult> => {
    if (!signal.aborted) deps.onStart?.(item, i + 1, items.length);
    try {
      return { item, outcome: await deps.run(item, signal) };
    } catch (e) {
      return { item, outcome: { status: 'spawn-error', message: e instanceof Error ? e.message : String(e) } };
    }
  })));
}

export function progressMessage(name: string, n: number, total: number): string {
  return `Running coverage: ${name} (${n}/${total})`;
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
  if (!failed(outcome)) return undefined;
  return { severity: 'error', text: `Coverage failed for ${name}: ${detail(outcome) || 'no coverage report was found.'}`, showOutput: true };
}

/** The output channel line for a run that failed or whose tests failed. */
export function failureDetails(name: string, outcome: RunOutcome): string | undefined {
  const text = detail(outcome);
  if (outcome.status === 'tests-failed') return `Tests failed in ${name} (tests-failed)${text ? `: ${text}` : ''}`;
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
  const errors = names(failed);
  const notices: Notice[] = [];
  if (testsFailed.length > 0) {
    notices.push({ severity: 'warning', text: `Tests failed in ${testsFailed.join(', ')}; coverage was still loaded.`, showOutput: false });
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
