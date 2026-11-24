import { EOL, FileBuilder } from '../model';
import { resolveReportPath } from './paths';
import { NotCoverageReportError, ReportParseError, type ParseContext, type ParsedReport } from './types';

interface Position { line?: unknown; column?: unknown }
interface Range { start?: Position; end?: Position }

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** A line (1-based), or 0 when missing or invalid. */
function lineOf(p: Position | undefined): number {
  const v = p?.line;
  return typeof v === 'number' && v >= 1 ? Math.trunc(v) : 0;
}

function startColOf(p: Position | undefined): number {
  const v = p?.column;
  return typeof v === 'number' && v >= 0 ? Math.min(Math.trunc(v), EOL) : 0;
}

/** An end column; null, missing or out of range becomes EOL (c8 writes Infinity, which JSON stores as null). */
function endColOf(p: Position | undefined): number {
  const v = p?.column;
  return typeof v === 'number' && v >= 0 && v < EOL ? Math.trunc(v) : EOL;
}

function countOf(v: unknown): number {
  return typeof v === 'number' ? v : 0;
}

function asRange(v: unknown): Range | undefined {
  return isObject(v) ? (v as Range) : undefined;
}

function addFile(b: FileBuilder, data: Record<string, unknown>): void {
  const statementMap = isObject(data.statementMap) ? data.statementMap : {};
  const s = isObject(data.s) ? data.s : {};
  for (const id in statementMap) {
    const r = asRange(statementMap[id]);
    const line = lineOf(r?.start);
    if (line === 0) continue;
    const endLine = Math.max(lineOf(r?.end), line);
    b.addStatement(line, startColOf(r?.start), endLine, endColOf(r?.end), countOf(s[id]));
  }

  const fnMap = isObject(data.fnMap) ? data.fnMap : {};
  const f = isObject(data.f) ? data.f : {};
  for (const id in fnMap) {
    const fn = fnMap[id];
    if (!isObject(fn)) continue;
    const loc = asRange(fn.loc) ?? asRange(fn.decl);
    const line = lineOf(loc?.start);
    if (line === 0) continue;
    const name = typeof fn.name === 'string' && fn.name !== '' ? fn.name : `(anonymous_${id})`;
    b.addDeclaration(name, line, startColOf(loc?.start), Math.max(lineOf(loc?.end), line), endColOf(loc?.end), countOf(f[id]));
  }

  const branchMap = isObject(data.branchMap) ? data.branchMap : {};
  const counts = isObject(data.b) ? data.b : {};
  for (const id in branchMap) {
    const br = branchMap[id];
    if (!isObject(br)) continue;
    const arms = counts[id];
    if (!Array.isArray(arms)) continue;
    let start = asRange(br.loc)?.start;
    if (lineOf(start) === 0) {
      const first = Array.isArray(br.locations) ? asRange(br.locations[0]) : undefined;
      start = lineOf(first?.start) > 0 ? first?.start : { line: br.line, column: 0 };
    }
    const line = lineOf(start);
    if (line === 0) continue;
    const col = startColOf(start);
    for (let arm = 0; arm < arms.length; arm++) b.addBranch(line, col, arm, countOf(arms[arm]));
  }
}

/** Parses an Istanbul `coverage-final.json` report. Paths are resolved with no `<source>` roots. */
export function parseIstanbul(json: string, ctx: ParseContext): ParsedReport {
  let root: unknown;
  try {
    root = JSON.parse(json.charCodeAt(0) === 0xfeff ? json.slice(1) : json);
  } catch (e) {
    throw new ReportParseError(`Malformed or truncated JSON: ${(e as Error).message}`);
  }
  if (!isObject(root)) throw new NotCoverageReportError('Not an Istanbul report: the top level is not an object');
  for (const key in root) {
    if (!isObject(root[key])) throw new NotCoverageReportError(`Not an Istanbul report: entry "${key}" is not an object`);
  }

  const builders = new Map<string, FileBuilder>();
  const unresolved = new Set<string>();
  for (const key in root) {
    const data = root[key] as Record<string, unknown>;
    const raw = typeof data.path === 'string' && data.path !== '' ? data.path : key;
    const path = resolveReportPath(raw, [], ctx);
    if (path === undefined) {
      unresolved.add(raw);
      continue;
    }
    let b = builders.get(path);
    if (b === undefined) builders.set(path, (b = new FileBuilder(path)));
    addFile(b, data);
  }

  return {
    files: [...builders.keys()].sort().map(p => builders.get(p)!.build()),
    signature: '',
    dropped: unresolved.size,
  };
}
