import { EOL, type FileBuilder } from '../model';
import { FileCollector } from './collect';
import type { ParseContext, ParsedReport } from './types';

/** A function of the current record; `line` is 0 until its location is known. */
interface FunctionEntry { name: string; line: number; endLine: number; hits: number }

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

/**
 * Parses an LCOV tracefile. `SF:` paths are resolved with no `<source>` roots; records of one file are merged.
 * Functions come either as `FN:line[,endLine],name` + `FNDA:hits,name` (matched by name; as in lcov, the
 * first FN of a name wins) or, from lcov 2.2, as `FNL:index,line[,endLine]` + `FNA:index,hits,name`
 * (matched by index; the first alias names the function and the hits of all aliases are summed).
 */
export function parseLcov(text: string, ctx: ParseContext): ParsedReport {
  const collector = new FileCollector(ctx);

  let builder: FileBuilder | undefined;
  let byName = new Map<string, FunctionEntry>();
  let byIndex = new Map<string, FunctionEntry>();
  /** Next arm number per line within the current record, so several blocks on one line stay distinct. */
  let nextArm = new Map<number, number>();

  const declare = (fn: FunctionEntry) => {
    if (builder === undefined || fn.line === 0 || fn.name === '') return;
    if (fn.endLine >= fn.line) builder.addDeclaration(fn.name, fn.line, 0, fn.endLine, EOL, fn.hits);
    else builder.addDeclaration(fn.name, fn.line, 0, 0, 0, fn.hits);
  };
  const entry = (map: Map<string, FunctionEntry>, key: string, name: string): FunctionEntry => {
    let fn = map.get(key);
    if (fn === undefined) map.set(key, (fn = { name, line: 0, endLine: 0, hits: 0 }));
    return fn;
  };
  const endRecord = () => {
    byName.forEach(declare);
    byIndex.forEach(declare);
    builder = undefined;
    byName = new Map();
    byIndex = new Map();
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
      builder = collector.builderFor(value);
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
        // BRDA:line,[e]block,branch,taken — the branch may be an expression containing commas
        // (lcov 2.x), so `taken` is whatever follows the last comma.
        const [lineNo, rest] = splitFirst(value);
        const ln = int(lineNo);
        const lastComma = rest.lastIndexOf(',');
        if (ln === 0 || lastComma <= rest.indexOf(',')) break;
        const taken = rest.slice(lastComma + 1);
        const arm = nextArm.get(ln) ?? 0;
        nextArm.set(ln, arm + 1);
        builder.addBranch(ln, 0, arm, taken === '-' ? 0 : int(taken));
        break;
      }
      case 'FN': {
        const [lineNo, rest] = splitFirst(value);
        const ln = int(lineNo);
        if (ln === 0 || rest === '') break;
        const [maybeEnd, afterEnd] = splitFirst(rest);
        const withEnd = isDigits(maybeEnd) && afterEnd !== '';
        const fn = entry(byName, withEnd ? afterEnd : rest, withEnd ? afterEnd : rest);
        if (fn.line === 0) {
          fn.line = ln;
          fn.endLine = withEnd ? int(maybeEnd) : 0;
        }
        break;
      }
      case 'FNDA': {
        const [count, name] = splitFirst(value);
        if (name !== '') entry(byName, name, name).hits += int(count);
        break;
      }
      case 'FNL': {
        const [index, rest] = splitFirst(value);
        const [lineNo, endLine] = splitFirst(rest);
        const ln = int(lineNo);
        if (index === '' || ln === 0) break;
        const fn = entry(byIndex, index, '');
        fn.line = ln;
        fn.endLine = int(endLine);
        break;
      }
      case 'FNA': {
        const [index, rest] = splitFirst(value);
        const [count, name] = splitFirst(rest);
        if (index === '' || name === '') break;
        const fn = entry(byIndex, index, name);
        if (fn.name === '') fn.name = name;
        fn.hits += int(count);
        break;
      }
    }
  }
  endRecord();

  return collector.finish('');
}
