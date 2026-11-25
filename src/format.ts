import nodePath from 'node:path';
import type { Count, FileSummary } from './model';

/** The values of VS Code's `testing.displayedCoveragePercent` setting. */
export type DisplayedPercent = 'totalCoverage' | 'statement' | 'minimum';

/** A count as a fraction; nothing to count is full coverage (VS Code's rule). */
function fraction(c: Count): number {
  return c.total === 0 ? 1 : Math.min(Math.max(c.covered / c.total, 0), 1);
}

/**
 * The covered fraction VS Code shows for a summary, so the status bar agrees with the native
 * Test Coverage view. Same formulas as VS Code's workbench (1.147/1.148): `totalCoverage` (the
 * default) adds statements, branches and declarations together; `statement` is statements only;
 * `minimum` is the lowest of the three. A kind with no records is not published, so it is left out.
 */
export function coverageFraction(s: FileSummary, mode: DisplayedPercent = 'totalCoverage'): number {
  switch (mode) {
    case 'statement':
      return fraction(s.statements);
    case 'minimum': {
      let min = fraction(s.statements);
      if (s.branches.total > 0) min = Math.min(min, fraction(s.branches));
      if (s.declarations.total > 0) min = Math.min(min, fraction(s.declarations));
      return min;
    }
    default: {
      const covered = s.statements.covered + s.branches.covered + s.declarations.covered;
      const total = s.statements.total + s.branches.total + s.declarations.total;
      return total === 0 ? 1 : covered / total;
    }
  }
}

/**
 * A fraction as VS Code writes it in the Test Coverage view: two decimals, and `99.99%` when a
 * value below full coverage would round to `100.00%`.
 */
export function formatPercent(value: number): string {
  const text = (value * 100).toFixed(2);
  return value < 1 - 1e-7 && text === '100.00' ? '99.99%' : `${text}%`;
}

/**
 * The location a store key stands for: `project:<file or dir>` → the file or directory;
 * `unowned:<results root>#<signature>` → the results root, without the signature.
 */
export function keyPath(key: string): string {
  const separator = key.indexOf(':');
  if (separator < 0) return key;
  const rest = key.slice(separator + 1);
  if (key.slice(0, separator) !== 'unowned') return rest;
  // The signature never holds a `#`, while the results root may (`…/C#/Api/TestResults`).
  const hash = rest.lastIndexOf('#');
  return hash < 0 ? rest : rest.slice(0, hash);
}

export interface NamedFolder { readonly name: string; readonly fsPath: string }

/**
 * How a project location reads to the user: the name of the innermost workspace folder holding it,
 * followed by its path inside that folder (`api/Api.Tests/Api.Tests.csproj`), or the folder name
 * alone when it is the folder itself. A location outside every folder reads as itself.
 */
export function projectLabel(location: string, folders: readonly NamedFolder[], path: typeof nodePath = nodePath): string {
  let best: { name: string; rel: string } | undefined;
  for (const folder of folders) {
    const rel = path.relative(folder.fsPath, location);
    const inside = rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
    if (inside && (best === undefined || rel.length < best.rel.length)) best = { name: folder.name, rel };
  }
  if (best === undefined) return location;
  return best.rel === '' ? best.name : `${best.name}/${best.rel.split(path.sep).join('/')}`;
}
