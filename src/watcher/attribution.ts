import nodePath from 'node:path';
import type { Project } from '../adapters/types';

/** The parts of `node:path` used here; tests pass `path.win32` or `path.posix`. */
export type PathApi = Pick<typeof nodePath, 'normalize' | 'dirname' | 'sep'>;

/** A path in a form that compares equal for equal paths: normalized, and lower-cased on Windows. */
function comparable(p: string, path: PathApi): string {
  const n = path.normalize(p);
  return path.sep === '\\' ? n.toLowerCase() : n;
}

/** Whether `p` is `dir` itself or lies below it. Windows paths compare case-insensitively. */
export function isWithin(dir: string, p: string, path: PathApi = nodePath): boolean {
  const d = comparable(dir, path);
  const c = comparable(p, path);
  if (c === d) return true;
  const prefix = d.endsWith(path.sep) ? d : d + path.sep;
  return c.startsWith(prefix);
}

/** The project whose directory is the nearest one above the report, if any. */
export function ownerOf(reportPath: string, projects: readonly Project[], path: PathApi = nodePath): Project | undefined {
  let best: Project | undefined;
  let bestLength = -1;
  for (const project of projects) {
    const length = comparable(project.dir, path).length;
    if (length > bestLength && isWithin(project.dir, reportPath, path)) {
      best = project;
      bestLength = length;
    }
  }
  return best;
}

/**
 * Where a run's results live: the nearest `TestResults` directory above the report (so that the
 * per-run GUID folders under it count as one place), otherwise the report's own directory.
 */
export function resultsRootOf(reportPath: string, path: PathApi = nodePath): string {
  const caseInsensitive = path.sep === '\\';
  let dir = path.dirname(reportPath);
  for (;;) {
    const name = dir.slice(Math.max(dir.lastIndexOf('/'), dir.lastIndexOf('\\')) + 1);
    if (name === 'TestResults' || (caseInsensitive && name.toLowerCase() === 'testresults')) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.dirname(reportPath);
    dir = parent;
  }
}

/** Store key for a report no project owns. */
export function unownedKey(reportPath: string, signature: string): string {
  return `unowned:${resultsRootOf(reportPath)}#${signature}`;
}
