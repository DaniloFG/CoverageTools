import { FileBuilder, type FileCoverageData } from '../../src/model';

/** Builds a file with line-only statements from `[line, count]` pairs. */
export function file(path: string, lineCounts: ReadonlyArray<readonly [number, number]>): FileCoverageData {
  const b = new FileBuilder(path);
  for (const [line, count] of lineCounts) b.addLine(line, count);
  return b.build();
}

/** Returns `[line, count]` pairs for the line-only statements of a file (endLine === 0). */
export function lines(f: FileCoverageData): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const s = f.statements;
  for (let i = 0; i < s.length; i += 5) {
    if (s[i + 2] === 0) out.push([s[i], s[i + 4]]);
  }
  return out;
}

/** Returns `[name, startLine, count]` triples for the declarations of a file. */
export function decls(f: FileCoverageData): Array<[string, number, number]> {
  const out: Array<[string, number, number]> = [];
  const d = f.declarations;
  for (let i = 0; i < d.length; i += 6) out.push([f.names[d[i + 5]], d[i], d[i + 4]]);
  return out;
}

/** Returns `[name, startLine, startCol, endLine, endCol, count]` for the declarations of a file. */
export function declRanges(f: FileCoverageData): Array<[string, number, number, number, number, number]> {
  const out: Array<[string, number, number, number, number, number]> = [];
  const d = f.declarations;
  for (let i = 0; i < d.length; i += 6) out.push([f.names[d[i + 5]], d[i], d[i + 1], d[i + 2], d[i + 3], d[i + 4]]);
  return out;
}
