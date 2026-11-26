import nodePath from 'node:path';
import type { ParseContext } from './types';

type PathImpl = Pick<typeof nodePath, 'dirname' | 'isAbsolute' | 'join' | 'normalize' | 'relative' | 'resolve' | 'sep'>;

/** How many ancestors of the report directory are tried when no workspace root contains it. */
const MAX_ANCESTORS_OUTSIDE_ROOTS = 8;

/**
 * The part after a deterministic-build prefix, or undefined. Deterministic .NET builds replace each
 * SourceRoot with `/_/`, `/_1/`, `/_2/`... (also written with backslashes); a bare prefix yields ''.
 */
function deterministicRest(p: string): string | undefined {
  const sep = (i: number) => p[i] === '/' || p[i] === '\\';
  if (!sep(0) || p[1] !== '_') return undefined;
  let i = 2;
  while (i < p.length && p.charCodeAt(i) >= 48 && p.charCodeAt(i) <= 57) i++;
  if (i === p.length) return '';
  return sep(i) ? p.slice(i + 1) : undefined;
}

/** Normalizes separators and, on Windows, upper-cases the drive letter. */
function normalize(p: string, pathImpl: PathImpl): string {
  const n = pathImpl.normalize(p);
  if (pathImpl.sep === '\\' && n.length >= 2 && n[1] === ':') {
    const c = n.charCodeAt(0);
    if (c >= 97 && c <= 122) return n[0].toUpperCase() + n.slice(1);
  }
  return n;
}

/** True when `dir` is `root` or lies below it. */
function isWithin(dir: string, root: string, pathImpl: PathImpl): boolean {
  const rel = pathImpl.relative(root, dir);
  return rel === '' || (!rel.startsWith('..') && !pathImpl.isAbsolute(rel));
}

const searchDirCache = new WeakMap<ParseContext, { pathImpl: PathImpl; dirs: readonly string[] }>();

/**
 * The directories a relative report path is tried against, nearest first: the report directory and
 * its ancestors up to and including the innermost root that contains it, then the roots in the given
 * order; when no root contains the report, the report directory, the roots, then up to
 * MAX_ANCESTORS_OUTSIDE_ROOTS ancestors (or up to the filesystem root).
 */
function searchDirs(ctx: ParseContext, pathImpl: PathImpl): readonly string[] {
  const cached = searchDirCache.get(ctx);
  if (cached !== undefined && cached.pathImpl === pathImpl) return cached.dirs;

  const dirs: string[] = [];
  const outsideAncestors: string[] = [];
  const inside = ctx.roots.some(root => isWithin(ctx.reportDir, root, pathImpl));
  let dir = pathImpl.normalize(ctx.reportDir);
  for (let up = 0; ; up++) {
    (inside || up === 0 ? dirs : outsideAncestors).push(dir);
    if (ctx.roots.some(root => pathImpl.relative(root, dir) === '')) break;
    if (!inside && up >= MAX_ANCESTORS_OUTSIDE_ROOTS) break;
    const parent = pathImpl.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  for (const root of ctx.roots) {
    if (!dirs.some(d => pathImpl.relative(root, d) === '')) dirs.push(root);
  }
  // A report outside every root (a run's temp directory): its ancestors are no more than a last resort.
  dirs.push(...outsideAncestors.filter(d => !dirs.some(x => pathImpl.relative(x, d) === '')));
  searchDirCache.set(ctx, { pathImpl, dirs });
  return dirs;
}

/**
 * Resolves a path written in a coverage report to an existing file, or undefined. Tries, in order:
 * 1. an absolute path as it is;
 * 2. for a relative path, each `<source>` + path (a relative source is taken from the report directory);
 * 3. for a relative path, the report directory and each of its ancestors + path, walking upward and
 *    stopping at (and including) the innermost workspace root that contains the report directory;
 * 4. for a relative path, each workspace root + path, in the order given (callers put the owning
 *    project's root first, so it is never re-sorted);
 *    (a report outside every root, e.g. in a temporary directory, tries the report directory, then
 *    the roots, and only then up to 8 of its ancestors);
 * 5. for deterministic-build paths (`/_/`, `/_1/`... in the path or in a `<source>`), the remainder
 *    against the same directories as in steps 3 and 4.
 */
export function resolveReportPath(
  raw: string,
  sources: readonly string[],
  ctx: ParseContext,
  pathImpl: PathImpl = ctx.path ?? nodePath,
): string | undefined {
  const exists = (p: string): string | undefined => {
    const n = normalize(p, pathImpl);
    return ctx.fileExists(n) ? n : undefined;
  };
  let found: string | undefined;
  const deterministic: string[] = [];
  const rawRest = deterministicRest(raw);
  if (rawRest !== undefined) deterministic.push(rawRest);

  if (pathImpl.isAbsolute(raw)) {
    if ((found = exists(raw))) return found;
  } else {
    for (const source of sources) {
      if ((found = exists(pathImpl.resolve(ctx.reportDir, source, raw)))) return found;
      const sourceRest = deterministicRest(source);
      if (sourceRest !== undefined) deterministic.push(pathImpl.join(sourceRest, raw));
    }
    for (const dir of searchDirs(ctx, pathImpl)) {
      if ((found = exists(pathImpl.join(dir, raw)))) return found;
    }
  }
  for (const rest of deterministic) {
    for (const dir of searchDirs(ctx, pathImpl)) {
      if ((found = exists(pathImpl.join(dir, rest)))) return found;
    }
  }
  return undefined;
}
