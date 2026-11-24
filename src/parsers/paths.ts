import nodePath from 'node:path';
import type { ParseContext } from './types';

type PathImpl = Pick<typeof nodePath, 'isAbsolute' | 'join' | 'normalize' | 'resolve' | 'sep'>;

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

/**
 * Resolves a path written in a coverage report to an existing file, or undefined.
 * Tries, in order: the path itself when absolute; each `<source>` + path; the report directory + path;
 * each workspace root + path; and, for deterministic-build paths (`/_/...`, also after a source),
 * each root + the remainder.
 */
export function resolveReportPath(
  raw: string,
  sources: readonly string[],
  ctx: ParseContext,
  pathImpl: PathImpl = nodePath,
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
    if ((found = exists(pathImpl.join(ctx.reportDir, raw)))) return found;
    for (const root of ctx.roots) {
      if ((found = exists(pathImpl.join(root, raw)))) return found;
    }
  }
  for (const rest of deterministic) {
    for (const root of ctx.roots) {
      if ((found = exists(pathImpl.join(root, rest)))) return found;
    }
  }
  return undefined;
}
