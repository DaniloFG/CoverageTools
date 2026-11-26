import { FORMAT_PRIORITY, formatOf } from '../parsers/load';

export type IngestResult = 'ok' | 'retry' | 'drop';

export interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface BatcherOptions {
  /** Quiet time after a group's last event before its reports are ingested. */
  debounceMs: number;
  /** Delay before the one new attempt at a report that could not be read. */
  retryMs: number;
  groupOf(path: string): string;
  /** Whether distinct reports (in different directories) of the group are all ingested; otherwise one per window. */
  ingestsMany?(group: string): boolean;
  isSuppressed(group: string): boolean;
  ingest(group: string, reportPath: string): Promise<IngestResult>;
  timers: Timers;
}

interface Group {
  /** Paths seen since the last flush, oldest first. */
  paths: string[];
  /** Bumped by every event, so that a retry of an older report is not started after a newer event. */
  generation: number;
  debounce?: unknown;
  retry?: unknown;
  running: boolean;
  /** A flush that happened while an ingestion was running; it starts when that one ends. */
  queued?: { paths: string[]; generation: number };
}

function rank(path: string): number {
  const format = formatOf(path);
  const i = format === undefined ? -1 : FORMAT_PRIORITY.indexOf(format);
  return i < 0 ? FORMAT_PRIORITY.length : i;
}

function dirOf(path: string): string {
  return path.slice(0, Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1);
}

/** The reports to ingest: the highest-priority format (the most recently pushed among equals), per directory when `many`, else once. */
function pick(paths: readonly string[], many: boolean): string[] {
  const best = new Map<string, string>();
  for (const p of paths) {
    const dir = many ? dirOf(p) : '';
    const current = best.get(dir);
    if (current === undefined || rank(p) <= rank(current)) {
      best.delete(dir); // keeps the map ordered by the last push
      best.set(dir, p);
    }
  }
  return [...best.values()];
}

/**
 * Groups report events (one group per project), waits for a quiet period, ingests one report per
 * group, and retries a report that could not be read once. Timers exist only while work is pending.
 */
export class ReportBatcher {
  private readonly groups = new Map<string, Group>();
  private disposed = false;

  constructor(private readonly o: BatcherOptions) {}

  push(path: string): void {
    if (this.disposed) return;
    const key = this.o.groupOf(path);
    if (this.o.isSuppressed(key)) return;
    let group = this.groups.get(key);
    if (!group) {
      group = { paths: [], generation: 0, running: false };
      this.groups.set(key, group);
    }
    const seen = group.paths.indexOf(path);
    if (seen >= 0) group.paths.splice(seen, 1);
    group.paths.push(path);
    group.generation++;
    this.clearTimer(group, 'retry');
    this.clearTimer(group, 'debounce');
    const g = group;
    g.debounce = this.o.timers.set(() => {
      g.debounce = undefined;
      this.flush(key, g);
    }, this.o.debounceMs);
  }

  dispose(): void {
    this.disposed = true;
    for (const group of this.groups.values()) {
      this.clearTimer(group, 'debounce');
      this.clearTimer(group, 'retry');
    }
    this.groups.clear();
  }

  private flush(key: string, group: Group): void {
    const paths = pick(group.paths, this.o.ingestsMany?.(key) ?? false);
    group.paths = [];
    if (this.o.isSuppressed(key)) {
      this.forgetIfIdle(key, group);
      return;
    }
    if (group.running) group.queued = { paths, generation: group.generation };
    else this.start(key, group, paths, group.generation, true);
  }

  private start(key: string, group: Group, paths: string[], generation: number, mayRetry: boolean): void {
    group.running = true;
    void this.ingestAll(key, paths).then(retries => {
      group.running = false;
      if (this.disposed) return;
      const queued = group.queued;
      if (queued) {
        group.queued = undefined;
        this.start(key, group, queued.paths, queued.generation, true);
        return;
      }
      if (retries.length > 0 && mayRetry && generation === group.generation && group.debounce === undefined) {
        group.retry = this.o.timers.set(() => {
          group.retry = undefined;
          if (this.o.isSuppressed(key)) this.forgetIfIdle(key, group);
          else this.start(key, group, retries, generation, false);
        }, this.o.retryMs);
        return;
      }
      this.forgetIfIdle(key, group);
    });
  }

  /** Ingests the reports one after the other; returns those worth another attempt. */
  private async ingestAll(key: string, paths: readonly string[]): Promise<string[]> {
    const retries: string[] = [];
    for (const path of paths) {
      if (this.disposed) break;
      if ((await this.ingest(key, path)) === 'retry') retries.push(path);
    }
    return retries;
  }

  private async ingest(key: string, path: string): Promise<IngestResult> {
    try {
      return await this.o.ingest(key, path);
    } catch {
      return 'drop';
    }
  }

  private forgetIfIdle(key: string, group: Group): void {
    const idle = !group.running && group.debounce === undefined && group.retry === undefined && group.paths.length === 0;
    if (idle && this.groups.get(key) === group) this.groups.delete(key);
  }

  private clearTimer(group: Group, which: 'debounce' | 'retry'): void {
    if (group[which] !== undefined) this.o.timers.clear(group[which]);
    group[which] = undefined;
  }
}
