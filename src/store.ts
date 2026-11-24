import { unionFileLists, unionFiles } from './merge';
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

  onDidChange(listener: () => void): { dispose(): void } {
    const wrapped = (): void => listener();
    this.listeners.add(wrapped);
    return { dispose: () => { this.listeners.delete(wrapped); } };
  }

  private changed(): void {
    this.mergedCache = undefined;
    this.totalsCache = undefined;
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        // A failing listener must not stop the others or the mutation that triggered it.
      }
    }
  }
}
