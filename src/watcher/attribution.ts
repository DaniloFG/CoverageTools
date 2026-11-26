import nodePath from 'node:path';
import type { Project } from '../adapters/types';
import type { ReportFormat } from '../parsers/types';

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

function matchesFormat(project: Project, format: ReportFormat): boolean {
  if (format === 'istanbul' || format === 'lcov') return project.ecosystem === 'node';
  if (format === 'coveragepy') return project.ecosystem === 'python';
  return false;
}

/**
 * The projects at the nearest directory above the report. Several only when projects share that
 * directory; then those whose ecosystem produces the report's format are preferred, if any.
 */
export function ownersOf(reportPath: string, projects: readonly Project[], path: PathApi = nodePath, format?: ReportFormat): Project[] {
  let best: Project[] = [];
  let bestLength = -1;
  for (const project of projects) {
    if (!isWithin(project.dir, reportPath, path)) continue;
    const length = comparable(project.dir, path).length;
    if (length > bestLength) {
      best = [project];
      bestLength = length;
    } else if (length === bestLength) {
      best.push(project);
    }
  }
  if (best.length > 1 && format !== undefined) {
    const matching = best.filter(project => matchesFormat(project, format));
    if (matching.length > 0) return matching;
  }
  return best;
}

/** The project whose directory is the nearest one above the report, if any (the first of a tie). */
export function ownerOf(reportPath: string, projects: readonly Project[], path: PathApi = nodePath, format?: ReportFormat): Project | undefined {
  return ownersOf(reportPath, projects, path, format)[0];
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
