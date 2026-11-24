import {
  BRANCH_STRIDE, DECLARATION_STRIDE, EOL, STATEMENT_STRIDE, addCounts, type FileCoverageData,
} from './model';

/** Zero-based position, as in VS Code. */
export interface Pos { line: number; character: number }
export interface BranchDetail { executed: number; label: string }
export interface StatementDetail { kind: 'statement'; executed: number; start: Pos; end?: Pos; branches: BranchDetail[] }
export interface DeclarationDetail { kind: 'declaration'; name: string; executed: number; start: Pos; end?: Pos }

/** Character used for "up to the end of the line"; VS Code clamps it to the line length. */
const END_OF_LINE = 0x7fffffff;

function pos(line: number, col: number): Pos {
  return { line: line > 0 ? line - 1 : 0, character: col === EOL ? END_OF_LINE : col };
}

/**
 * Converts the compact model of one file into line-by-line detail, without VS Code types.
 *
 * Statements come first, in line order, then declarations in name order. Branches attach to the
 * first statement that starts on their line, labelled `branch 1`, `branch 2`, … in order; a line
 * with branches but no statement gets a whole-line statement whose count is the sum of its branches.
 */
export function toDetails(file: FileCoverageData): Array<StatementDetail | DeclarationDetail> {
  const statements: StatementDetail[] = [];
  const firstOnLine = new Map<number, StatementDetail>();
  const s = file.statements;
  for (let i = 0; i < s.length; i += STATEMENT_STRIDE) {
    const lineOnly = s[i + 2] === 0;
    const detail: StatementDetail = lineOnly
      ? { kind: 'statement', executed: s[i + 4], start: pos(s[i], 0), branches: [] }
      : { kind: 'statement', executed: s[i + 4], start: pos(s[i], s[i + 1]), end: pos(s[i + 2], s[i + 3]), branches: [] };
    statements.push(detail);
    if (!firstOnLine.has(s[i])) firstOnLine.set(s[i], detail);
  }

  // Branches are sorted by line, so each line's branches are contiguous.
  const orphans: StatementDetail[] = [];
  const b = file.branches;
  for (let i = 0; i < b.length;) {
    const line = b[i];
    const branches: BranchDetail[] = [];
    let sum = 0;
    for (; i < b.length && b[i] === line; i += BRANCH_STRIDE) {
      branches.push({ executed: b[i + 3], label: `branch ${branches.length + 1}` });
      sum = addCounts(sum, b[i + 3]);
    }
    const owner = firstOnLine.get(line);
    if (owner) owner.branches.push(...branches);
    else orphans.push({ kind: 'statement', executed: sum, start: pos(line, 0), branches });
  }

  const out: Array<StatementDetail | DeclarationDetail> = orphans.length === 0 ? statements : mergeByLine(statements, orphans);

  const d = file.declarations;
  for (let i = 0; i < d.length; i += DECLARATION_STRIDE) {
    const name = file.names[d[i + 5]];
    out.push(d[i + 2] === 0
      ? { kind: 'declaration', name, executed: d[i + 4], start: pos(d[i], d[i + 1]) }
      : { kind: 'declaration', name, executed: d[i + 4], start: pos(d[i], d[i + 1]), end: pos(d[i + 2], d[i + 3]) });
  }
  return out;
}

/** Merges two lists sorted by start line; on equal lines `a` comes first. */
function mergeByLine(a: StatementDetail[], b: StatementDetail[]): StatementDetail[] {
  const out: StatementDetail[] = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) out.push(a[i].start.line <= b[j].start.line ? a[i++] : b[j++]);
  while (i < a.length) out.push(a[i++]);
  while (j < b.length) out.push(b[j++]);
  return out;
}
