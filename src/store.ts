import { unionFileLists, unionFileListsInSlices, unionFiles, type SliceOptions } from './merge';
import { summarize, type Count, type FileCoverageData, type FileSummary } from './model';

export interface MergedEntry { path: string; parts: readonly FileCoverageData[]; summary: FileSummary }

/**
 * Coverage accumulated per project key. Each project holds at most one entry per path; a path
 * covered by several projects shows up in `merged()` once, with one part per project.
 */
export class CoverageStore {
  private readonly projects = new Map<string, readonly FileCoverageData[]>();
  private readonly listeners = new Set<() => void>();
  private mergedCache: readonly MergedEntry[] | undefined;
  private totalsCache: Count | undefined;
  private readonly projectTotalsCache = new Map<string, Count>();
  private summaryCache: FileSummary | undefined;
  private readonly projectSummaryCache = new Map<string, FileSummary>();

  /** Replaces everything a project holds. An empty list keeps the project, with no files. */
  replace(key: string, files: readonly FileCoverageData[]): void {
    const current = this.projects.get(key);
    if (current !== undefined && current.length === 0 && files.length === 0) return;
    this.projects.set(key, unionFileLists(files, []));
    this.changed();
  }

  /** Adds coverage to a project, summing it with what the project already holds. */
  union(key: string, files: readonly FileCoverageData[]): void {
    const current = this.projects.get(key);
    if (current !== undefined && files.length === 0) return;
    this.projects.set(key, unionFileLists(current ?? [], files));
    this.changed();
  }

  /**
   * `union` for large runs: the files are unioned in slices that give the event loop control back
   * in between, then the project changes once. If the project changed meanwhile, the union starts
   * again from what it holds then.
   */
  async unionInSlices(key: string, files: readonly FileCoverageData[], options?: SliceOptions): Promise<void> {
    for (;;) {
      const current = this.projects.get(key);
      if (current !== undefined && files.length === 0) return;
      const next = await unionFileListsInSlices(current ?? [], files, options);
      if (this.projects.get(key) !== current) continue;
      this.projects.set(key, next);
      this.changed();
      return;
    }
  }

  /** Removes one project, or all of them when `key` is omitted. */
  clear(key?: string): void {
    if (key === undefined) {
      if (this.projects.size === 0) return;
      this.projects.clear();
    } else if (!this.projects.delete(key)) {
      return;
    }
    this.changed();
  }

  keys(): string[] {
    return [...this.projects.keys()];
  }

  /** One entry per path across all projects, sorted by path; cached until the next change. */
  merged(): readonly MergedEntry[] {
    if (this.mergedCache) return this.mergedCache;
    const partsByPath = new Map<string, FileCoverageData[]>();
    for (const files of this.projects.values()) {
      for (const f of files) {
        const parts = partsByPath.get(f.path);
        if (parts) parts.push(f); else partsByPath.set(f.path, [f]);
      }
    }
    const paths = [...partsByPath.keys()].sort();
    this.mergedCache = paths.map(path => {
      const parts = partsByPath.get(path)!;
      return { path, parts, summary: summarize(parts.length === 1 ? parts[0] : unionFiles(parts)) };
    });
    return this.mergedCache;
  }

  /** Statement totals over `merged()`. */
  totals(): Count {
    if (this.totalsCache) return { ...this.totalsCache };
    let covered = 0, total = 0;
    for (const e of this.merged()) {
      covered += e.summary.statements.covered;
      total += e.summary.statements.total;
    }
    this.totalsCache = { covered, total };
    return { covered, total };
  }

  /** Statement totals of one project's own files (before the union with other projects); cached until the next change. */
  totalsOf(key: string): Count | undefined {
    const files = this.projects.get(key);
    if (!files) return undefined;
    let totals = this.projectTotalsCache.get(key);
    if (!totals) {
      totals = { covered: 0, total: 0 };
      for (const f of files) {
        const { statements } = summarize(f);
        totals.covered += statements.covered;
        totals.total += statements.total;
      }
      this.projectTotalsCache.set(key, totals);
    }
    return { ...totals };
  }

  /**
   * Statement, branch and declaration totals over `merged()`: what VS Code adds up for the root of
   * its coverage tree. Cached until the next change.
   */
  summary(): FileSummary {
    this.summaryCache ??= addSummaries(this.merged().map(e => e.summary));
    return copySummary(this.summaryCache);
  }

  /** `summary()` over one project's own files (before the union with other projects); undefined for an unknown key. */
  summaryOf(key: string): FileSummary | undefined {
    const files = this.projects.get(key);
    if (!files) return undefined;
    let summary = this.projectSummaryCache.get(key);
    if (!summary) {
      summary = addSummaries(files.map(summarize));
      this.projectSummaryCache.set(key, summary);
    }
    return copySummary(summary);
  }

  onDidChange(listener: () => void): { dispose(): void } {
    const wrapped = (): void => listener();
    this.listeners.add(wrapped);
    return { dispose: () => { this.listeners.delete(wrapped); } };
  }

  private changed(): void {
    this.mergedCache = undefined;
    this.totalsCache = undefined;
    this.projectTotalsCache.clear();
    this.summaryCache = undefined;
    this.projectSummaryCache.clear();
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        // A failing listener must not stop the others or the mutation that triggered it.
      }
    }
  }
}

function addSummaries(summaries: readonly FileSummary[]): FileSummary {
  const sum: FileSummary = { statements: { covered: 0, total: 0 }, branches: { covered: 0, total: 0 }, declarations: { covered: 0, total: 0 } };
  for (const s of summaries) {
    for (const kind of ['statements', 'branches', 'declarations'] as const) {
      sum[kind].covered += s[kind].covered;
      sum[kind].total += s[kind].total;
    }
  }
  return sum;
}

function copySummary(s: FileSummary): FileSummary {
  return { statements: { ...s.statements }, branches: { ...s.branches }, declarations: { ...s.declarations } };
}
