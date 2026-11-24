/**
 * Compact, platform-neutral coverage model. Lines are 1-based and columns 0-based.
 *
 * Records live in flat typed arrays sorted by their key, with duplicates summed:
 * - statements, stride 5: startLine, startCol, endLine, endCol, count
 *   (endLine === 0 means "whole line" coverage); key = (startLine, startCol, endLine, endCol)
 * - branches, stride 4: line, col, arm, count; key = (line, col, arm)
 * - declarations, stride 6: startLine, startCol, endLine, endCol, count, nameIndex;
 *   key = (name, startLine). `names` holds each name once, in ascending code-unit order.
 *
 * Objects are immutable by convention: no function changes a FileCoverageData it receives.
 */

/** "Up to the end of the line" in endCol. */
export const EOL = 0xffffffff;

/** Largest count a record can hold; sums saturate here instead of wrapping. */
export const MAX_COUNT = 0xffffffff;

export interface FileCoverageData {
  readonly path: string;
  readonly statements: Uint32Array;
  readonly branches: Uint32Array;
  readonly declarations: Uint32Array;
  readonly names: readonly string[];
}

export interface Count { covered: number; total: number }
export interface FileSummary { statements: Count; branches: Count; declarations: Count }

export const STATEMENT_STRIDE = 5;
export const BRANCH_STRIDE = 4;
export const DECLARATION_STRIDE = 6;

/** Adds two counts, saturating at MAX_COUNT. */
export function addCounts(a: number, b: number): number {
  const sum = a + b;
  return sum > MAX_COUNT ? MAX_COUNT : sum;
}

function toCount(value: number): number {
  if (!(value > 0)) return 0;
  return value >= MAX_COUNT ? MAX_COUNT : Math.trunc(value);
}

/** Normalizes a line, column or arm: non-finite or negative → 0, else truncated and capped at 0xffffffff. */
function toCoord(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return value >= 0xffffffff ? 0xffffffff : Math.trunc(value);
}

function countRecords(records: Uint32Array, stride: number, countOffset: number): Count {
  let covered = 0;
  for (let i = countOffset; i < records.length; i += stride) if (records[i] > 0) covered++;
  return { covered, total: records.length / stride };
}

export function summarize(file: FileCoverageData): FileSummary {
  return {
    statements: countRecords(file.statements, STATEMENT_STRIDE, 4),
    branches: countRecords(file.branches, BRANCH_STRIDE, 3),
    declarations: countRecords(file.declarations, DECLARATION_STRIDE, 4),
  };
}

/** Sorts record indices by the first `keyLen` fields (ties keep insertion order). */
function sortedOrder(raw: readonly number[], stride: number, keyLen: number): Uint32Array {
  const n = raw.length / stride;
  const order = new Uint32Array(n);
  let sorted = true;
  for (let r = 0; r < n; r++) {
    order[r] = r;
    if (sorted && r > 0 && compareRaw(raw, (r - 1) * stride, r * stride, keyLen) > 0) sorted = false;
  }
  if (!sorted) order.sort((x, y) => compareRaw(raw, x * stride, y * stride, keyLen) || x - y);
  return order;
}

function compareRaw(raw: readonly number[], i: number, j: number, keyLen: number): number {
  for (let k = 0; k < keyLen; k++) {
    const d = raw[i + k] - raw[j + k];
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Emits records in `order`, summing the count (at `countOffset`) of records whose first
 * `keyLen` fields match the previous emitted record. The first record of a key keeps its other fields.
 */
function emit(raw: readonly number[], order: Uint32Array, stride: number, keyLen: number, countOffset: number): Uint32Array {
  const out = new Uint32Array(raw.length);
  let len = 0;
  for (let r = 0; r < order.length; r++) {
    const src = order[r] * stride;
    if (len > 0) {
      const prev = len - stride;
      let same = true;
      for (let k = 0; k < keyLen; k++) {
        if (out[prev + k] !== raw[src + k]) { same = false; break; }
      }
      if (same) {
        out[prev + countOffset] = addCounts(out[prev + countOffset], raw[src + countOffset]);
        continue;
      }
    }
    for (let k = 0; k < stride; k++) out[len + k] = raw[src + k];
    len += stride;
  }
  return len === out.length ? out : out.slice(0, len);
}

export class FileBuilder {
  private readonly statements: number[] = [];
  private readonly branches: number[] = [];
  /** Declarations with a builder-local name id in the last field. */
  private readonly declarations: number[] = [];
  private readonly nameIds = new Map<string, number>();

  constructor(private readonly path: string) {}

  addLine(line: number, count: number): void {
    this.statements.push(toCoord(line), 0, 0, 0, toCount(count));
  }

  addStatement(startLine: number, startCol: number, endLine: number, endCol: number, count: number): void {
    this.statements.push(toCoord(startLine), toCoord(startCol), toCoord(endLine), toCoord(endCol), toCount(count));
  }

  addBranch(line: number, col: number, arm: number, count: number): void {
    this.branches.push(toCoord(line), toCoord(col), toCoord(arm), toCount(count));
  }

  addDeclaration(name: string, startLine: number, startCol: number, endLine: number, endCol: number, count: number): void {
    let id = this.nameIds.get(name);
    if (id === undefined) {
      id = this.nameIds.size;
      this.nameIds.set(name, id);
    }
    this.declarations.push(toCoord(startLine), toCoord(startCol), toCoord(endLine), toCoord(endCol), toCount(count), id);
  }

  /** Sorts every kind of record by its key and sums duplicates. */
  build(): FileCoverageData {
    const statements = emit(this.statements, sortedOrder(this.statements, STATEMENT_STRIDE, 4), STATEMENT_STRIDE, 4, 4);
    const branches = emit(this.branches, sortedOrder(this.branches, BRANCH_STRIDE, 3), BRANCH_STRIDE, 3, 3);

    // Rank names in code-unit order so that sorting by (nameIndex, startLine) sorts by (name, startLine).
    const names = [...this.nameIds.keys()].sort();
    const rankOfId = new Uint32Array(names.length);
    names.forEach((name, rank) => { rankOfId[this.nameIds.get(name)!] = rank; });
    // Reorder to (nameIndex, startLine, startCol, endLine, endCol, count) so the key is the first two fields.
    const keyed: number[] = new Array(this.declarations.length);
    for (let i = 0; i < this.declarations.length; i += DECLARATION_STRIDE) {
      keyed[i] = rankOfId[this.declarations[i + 5]];
      for (let k = 0; k < 5; k++) keyed[i + 1 + k] = this.declarations[i + k];
    }
    const keyedOut = emit(keyed, sortedOrder(keyed, DECLARATION_STRIDE, 2), DECLARATION_STRIDE, 2, 5);
    const declarations = new Uint32Array(keyedOut.length);
    for (let i = 0; i < keyedOut.length; i += DECLARATION_STRIDE) {
      for (let k = 0; k < 5; k++) declarations[i + k] = keyedOut[i + 1 + k];
      declarations[i + 5] = keyedOut[i];
    }

    return { path: this.path, statements, branches, declarations, names };
  }
}
