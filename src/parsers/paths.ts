import nodePath from 'node:path';
import type { ParseContext } from './types';

type PathImpl = Pick<typeof nodePath, 'isAbsolute' | 'join' | 'normalize' | 'resolve' | 'sep'>;

/** Prefixes that deterministic .NET builds substitute for a source root (`/_/`, also with backslashes). */
function deterministicRest(p: string): string | undefined {
  if (p.length > 3 && p[1] === '_' && (p[0] === '/' || p[0] === '\\') && (p[2] === '/' || p[2] === '\\')) return p.slice(3);
  return undefined;
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
