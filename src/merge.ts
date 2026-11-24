import {
  addCounts, BRANCH_STRIDE, DECLARATION_STRIDE, STATEMENT_STRIDE, type FileCoverageData,
} from './model';

/**
 * Reusable merge buffer: each merge writes here and copies out exactly `len` values, so a merged
 * array costs one allocation (small typed-array allocations dominate the merge time otherwise).
 */
let scratch = new Uint32Array(4096);

function scratchFor(size: number): Uint32Array {
  if (scratch.length < size) scratch = new Uint32Array(Math.max(size, scratch.length * 2));
  return scratch;
}

/** Compares statement keys (startLine, startCol, endLine, endCol) at offsets i and j. */
function compareStatements(a: Uint32Array, i: number, b: Uint32Array, j: number): number {
  return (a[i] - b[j]) || (a[i + 1] - b[j + 1]) || (a[i + 2] - b[j + 2]) || (a[i + 3] - b[j + 3]);
}

/** Compares branch keys (line, col, arm) at offsets i and j. */
function compareBranches(a: Uint32Array, i: number, b: Uint32Array, j: number): number {
  return (a[i] - b[j]) || (a[i + 1] - b[j + 1]) || (a[i + 2] - b[j + 2]);
}

/**
 * Linear merge of two record arrays sorted by their first `keyLen` fields, with the count right
 * after the key. Matching records are summed. `compare(a, i, b, j)` compares the keys at i and j.
 */
function mergeKeyed(
  a: Uint32Array, b: Uint32Array, keyLen: number,
  compare: (a: Uint32Array, i: number, b: Uint32Array, j: number) => number,
): Uint32Array {
  if (b.length === 0) return a;
  if (a.length === 0) return b;
  const stride = keyLen + 1;
  const out = scratchFor(a.length + b.length);
  let i = 0, j = 0, len = 0;
  while (i < a.length && j < b.length) {
    const cmp = compare(a, i, b, j);
    if (cmp < 0) {
      for (let k = 0; k < stride; k++) out[len + k] = a[i + k];
      i += stride;
    } else if (cmp > 0) {
      for (let k = 0; k < stride; k++) out[len + k] = b[j + k];
      j += stride;
    } else {
      for (let k = 0; k < keyLen; k++) out[len + k] = a[i + k];
      out[len + keyLen] = addCounts(a[i + keyLen], b[j + keyLen]);
      i += stride; j += stride;
    }
    len += stride;
  }
  if (i < a.length) { out.set(a.subarray(i), len); len += a.length - i; }
  if (j < b.length) { out.set(b.subarray(j), len); len += b.length - j; }
  return out.slice(0, len);
}

/** Linear merge of declarations sorted by (name, startLine); builds the merged, sorted name table. */
function mergeDeclarations(a: FileCoverageData, b: FileCoverageData): { declarations: Uint32Array; names: string[] } {
  const da = a.declarations, db = b.declarations;
  const S = DECLARATION_STRIDE;
  const out = scratchFor(da.length + db.length);
  const names: string[] = [];
  let i = 0, j = 0, len = 0;
  const copy = (src: Uint32Array, at: number, name: string): void => {
    for (let k = 0; k < 5; k++) out[len + k] = src[at + k];
    if (names.length === 0 || names[names.length - 1] !== name) names.push(name);
    out[len + 5] = names.length - 1;
    len += S;
  };
  while (i < da.length && j < db.length) {
    const na = a.names[da[i + 5]], nb = b.names[db[j + 5]];
    const cmp = na < nb ? -1 : na > nb ? 1 : da[i] - db[j];
    if (cmp < 0) { copy(da, i, na); i += S; }
    else if (cmp > 0) { copy(db, j, nb); j += S; }
    else {
      copy(da, i, na);
      out[len - S + 4] = addCounts(da[i + 4], db[j + 4]);
      i += S; j += S;
    }
  }
  for (; i < da.length; i += S) copy(da, i, a.names[da[i + 5]]);
  for (; j < db.length; j += S) copy(db, j, b.names[db[j + 5]]);
  return { declarations: out.slice(0, len), names };
}

function unionTwo(a: FileCoverageData, b: FileCoverageData): FileCoverageData {
  let declarations = a.declarations, names = a.names;
  if (a.declarations.length === 0) {
    declarations = b.declarations; names = b.names;
  } else if (b.declarations.length > 0) {
    ({ declarations, names } = mergeDeclarations(a, b));
  }
  return {
    path: a.path,
    statements: mergeKeyed(a.statements, b.statements, STATEMENT_STRIDE - 1, compareStatements),
    branches: mergeKeyed(a.branches, b.branches, BRANCH_STRIDE - 1, compareBranches),
    declarations,
    names,
  };
}

/** Unions the coverage of several parts of the same file. Inputs are never modified. */
export function unionFiles(parts: readonly FileCoverageData[]): FileCoverageData {
  if (parts.length === 0) throw new Error('unionFiles needs at least one part');
  let result = parts[0];
  for (let p = 1; p < parts.length; p++) {
    if (parts[p].path !== result.path) {
      throw new Error(`unionFiles got different paths: ${result.path} and ${parts[p].path}`);
    }
    result = unionTwo(result, parts[p]);
  }
  return result;
}

/**
 * Unions two file lists by path. Files present on one side only are kept as they are.
 * Order: first appearance across `a` then `b`.
 */
export function unionFileLists(a: readonly FileCoverageData[], b: readonly FileCoverageData[]): FileCoverageData[] {
  const byPath = new Map<string, FileCoverageData>();
  for (const list of [a, b]) {
    for (const f of list) {
      const existing = byPath.get(f.path);
      byPath.set(f.path, existing ? unionTwo(existing, f) : f);
    }
  }
  return [...byPath.values()];
}
