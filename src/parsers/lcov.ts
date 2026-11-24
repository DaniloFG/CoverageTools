import { EOL, FileBuilder } from '../model';
import { resolveReportPath } from './paths';
import type { ParseContext, ParsedReport } from './types';

interface FunctionEntry { name: string; line: number; endLine: number }

function int(s: string): number {
  const n = parseInt(s, 10);
  return n >= 0 ? n : 0;
}

/** Splits at the first comma: [before, after], or [s, ''] without a comma. */
function splitFirst(s: string): [string, string] {
  const comma = s.indexOf(',');
  return comma < 0 ? [s, ''] : [s.slice(0, comma), s.slice(comma + 1)];
}

function isDigits(s: string): boolean {
  if (s === '') return false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 48 || c > 57) return false;
  }
  return true;
}

/** Parses an LCOV tracefile. `SF:` paths are resolved with no `<source>` roots; records of one file are merged. */
export function parseLcov(text: string, ctx: ParseContext): ParsedReport {
  const builders = new Map<string, FileBuilder>();
  const resolved = new Map<string, string | undefined>();
  const unresolved = new Set<string>();

  let builder: FileBuilder | undefined;
  let functions: FunctionEntry[] = [];
  let functionHits = new Map<string, number>();
  /** Next arm number per line within the current record, so several blocks on one line stay distinct. */
  let nextArm = new Map<number, number>();

  const endRecord = () => {
    if (builder !== undefined) {
      for (const fn of functions) {
        const count = functionHits.get(fn.name) ?? 0;
        if (fn.endLine >= fn.line) builder.addDeclaration(fn.name, fn.line, 0, fn.endLine, EOL, count);
        else builder.addDeclaration(fn.name, fn.line, 0, 0, 0, count);
      }
    }
    builder = undefined;
    functions = [];
    functionHits = new Map();
    nextArm = new Map();
  };

  const n = text.length;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  while (i < n) {
    let end = text.indexOf('\n', i);
    if (end < 0) end = n;
    const lineEnd = end > i && text.charCodeAt(end - 1) === 13 ? end - 1 : end;
    const line = text.slice(i, lineEnd);
    i = end + 1;

    if (line === 'end_of_record') {
      endRecord();
      continue;
    }
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const tag = line.slice(0, colon);
    const value = line.slice(colon + 1);

    if (tag === 'SF') {
      endRecord();
      let path = resolved.get(value);
      if (path === undefined && !resolved.has(value)) {
        path = resolveReportPath(value, [], ctx);
        resolved.set(value, path);
      }
      if (path === undefined) {
        unresolved.add(value);
        continue;
      }
      builder = builders.get(path);
      if (builder === undefined) builders.set(path, (builder = new FileBuilder(path)));
      continue;
    }
    if (builder === undefined) continue;

    switch (tag) {
      case 'DA': {
        const [lineNo, rest] = splitFirst(value);
        const ln = int(lineNo);
        if (ln > 0) builder.addLine(ln, int(splitFirst(rest)[0]));
        break;
      }
      case 'BRDA': {
        const parts = value.split(',');
        const ln = int(parts[0]);
        if (ln === 0 || parts.length < 4) break;
        const arm = nextArm.get(ln) ?? 0;
        nextArm.set(ln, arm + 1);
        builder.addBranch(ln, 0, arm, parts[3] === '-' ? 0 : int(parts[3]));
        break;
      }
      case 'FN': {
        const [lineNo, rest] = splitFirst(value);
        const ln = int(lineNo);
        if (ln === 0 || rest === '') break;
        const [maybeEnd, afterEnd] = splitFirst(rest);
        if (isDigits(maybeEnd) && afterEnd !== '') functions.push({ name: afterEnd, line: ln, endLine: int(maybeEnd) });
        else functions.push({ name: rest, line: ln, endLine: 0 });
        break;
      }
      case 'FNDA': {
        const [count, name] = splitFirst(value);
        if (name !== '') functionHits.set(name, (functionHits.get(name) ?? 0) + int(count));
        break;
      }
    }
  }
  endRecord();

  return {
    files: [...builders.keys()].sort().map(p => builders.get(p)!.build()),
    signature: '',
    dropped: unresolved.size,
  };
}
