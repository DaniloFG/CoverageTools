import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { EOL } from '../../../src/model';
import { parseIstanbul } from '../../../src/parsers/istanbul';
import { NotCoverageReportError, ReportParseError, type ParseContext } from '../../../src/parsers/types';
import { decls } from '../helpers';

const read = (name: string) => readFileSync(path.join(__dirname, '../../fixtures/reports', name), 'utf8');

function ctxOf(existing: readonly string[]): ParseContext {
  const set = new Set(existing);
  return { reportDir: '/w/coverage', roots: ['/w'], fileExists: p => set.has(p) };
}

const ctx = ctxOf(['/w/src/a.ts', '/w/src/b.ts']);

test('keeps exact statement ranges and counts', () => {
  const r = parseIstanbul(read('coverage-final.json'), ctx);
  expect(r.files.map(f => f.path)).toEqual(['/w/src/a.ts', '/w/src/b.ts']);
  const f = r.files[0];
  expect(Array.from(f.statements.slice(0, 5))).toEqual([1, 0, 1, 24, 3]);
  expect(Array.from(f.statements)).toEqual([1, 0, 1, 24, 3, 3, 2, 3, 14, 2, 4, 2, 6, 3, 2]);
});

test('branches use the branch location and one arm per count', () => {
  const f = parseIstanbul(read('coverage-final.json'), ctx).files[0];
  expect(Array.from(f.branches)).toEqual([4, 2, 0, 2, 4, 2, 1, 0]);
});

test('branch entries that start at the same position keep distinct arms', () => {
  // `a && b ? c : d`: a cond-expr and a binary-expr both start at `a`.
  const at = { start: { line: 3, column: 4 }, end: { line: 3, column: 18 } };
  const json = JSON.stringify({
    '/w/src/a.ts': {
      path: '/w/src/a.ts', statementMap: {}, fnMap: {}, s: {}, f: {},
      branchMap: { 0: { loc: at, type: 'cond-expr', locations: [at, at] }, 1: { loc: at, type: 'binary-expr', locations: [at, at] } },
      b: { 0: [1, 0], 1: [0, 1] },
    },
  });
  const f = parseIstanbul(json, ctx).files[0];
  expect(Array.from(f.branches)).toEqual([3, 4, 0, 1, 3, 4, 1, 0, 3, 4, 2, 0, 3, 4, 3, 1]);
});

test('functions become declarations using fnMap loc and name', () => {
  const f = parseIstanbul(read('coverage-final.json'), ctx).files[0];
  expect(f.names).toEqual(['(anonymous_1)', 'add']);
  expect(decls(f)).toEqual([['(anonymous_1)', 9, 0], ['add', 2, 2]]);
  expect(Array.from(f.declarations.slice(6, 12))).toEqual([2, 0, 7, 1, 2, 1]);
});

test('a null end column becomes EOL', () => {
  const r = parseIstanbul(read('coverage-final.json'), ctx);
  const b = r.files[1];
  expect(Array.from(b.statements)).toEqual([1, 0, 1, EOL, 0]);
  expect(r.files[0].declarations[3]).toBe(EOL);
});

test('the path is resolved like any report path; missing files are dropped', () => {
  const r = parseIstanbul(read('coverage-final.json'), ctxOf(['/w/src/b.ts']));
  expect(r.files.map(f => f.path)).toEqual(['/w/src/b.ts']);
  expect(r.dropped).toBe(1);
});

test('the object key is used when the path field is missing', () => {
  const json = JSON.stringify({ 'src/a.ts': { statementMap: { 0: { start: { line: 2, column: 0 }, end: { line: 2, column: 5 } } }, s: { 0: 1 } } });
  const r = parseIstanbul(json, ctx);
  expect(r.files.map(f => f.path)).toEqual(['/w/src/a.ts']);
  expect(Array.from(r.files[0].statements)).toEqual([2, 0, 2, 5, 1]);
});

test('truncated JSON throws ReportParseError', () => {
  expect(() => parseIstanbul('{"/w/a.ts":{"path":', ctx)).toThrow(ReportParseError);
});

test('JSON that is not an object of file entries throws NotCoverageReportError', () => {
  expect(() => parseIstanbul('[1, 2]', ctx)).toThrow(NotCoverageReportError);
  expect(() => parseIstanbul('{"name": "pkg", "version": "1.0.0"}', ctx)).toThrow(NotCoverageReportError);
  expect(() => parseIstanbul('{"total": {"lines": {"pct": 50}}}', ctx)).toThrow(NotCoverageReportError);
});

test('an empty object is a valid report with zero files', () => {
  expect(parseIstanbul('{}', ctx)).toEqual({ files: [], signature: '', dropped: 0 });
});

test('signature is the empty string', () => {
  expect(parseIstanbul(read('coverage-final.json'), ctx).signature).toBe('');
});

test("esbuild's helper functions are dropped by name only, wherever they are", () => {
  const fn = (name: string, line: number, col: number) => ({ name, decl: { start: { line, column: col }, end: { line, column: col + 1 } }, loc: { start: { line, column: col }, end: { line: line + 1, column: 1 } }, line });
  const helpers = ['__export', '__toCommonJS', '__copyProps', '__name', '__defProp', '__getOwnPropDesc', '__getOwnPropNames', '__hasOwnProp'];
  const names = [...helpers, 'get', 'divide', 'add', '__exportStar_like', 'real'];
  const fnMap = Object.fromEntries(names.map((n, i) => [String(i), fn(n, n === 'real' ? 7 : 1, 0)]));
  const f = Object.fromEntries(names.map((_, i) => [String(i), 1]));
  const json = JSON.stringify({ '/w/src/a.ts': { path: '/w/src/a.ts', statementMap: {}, s: {}, fnMap, f, branchMap: {}, b: {} } });
  const file = parseIstanbul(json, ctx).files[0];
  // A real function at 1:0 is kept, whatever its position; only the fixed helper names go.
  expect(decls(file).map(([name]) => name).sort()).toEqual(['__exportStar_like', 'add', 'divide', 'get', 'real']);
});
