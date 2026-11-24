import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { parseCobertura } from '../../../src/parsers/cobertura';
import { NotCoverageReportError, ReportParseError, type ParseContext } from '../../../src/parsers/types';
import { decls, lines } from '../helpers';

const FIXTURES = path.join(__dirname, '../../fixtures/reports');
const read = (name: string) => readFileSync(path.join(FIXTURES, name), 'utf8');

function ctxOf(existing: readonly string[], roots: readonly string[] = ['/w']): ParseContext {
  const set = new Set(existing);
  return { reportDir: '/w/TestResults/x', roots, fileExists: p => set.has(p) };
}

const ctx = ctxOf([
  '/w/src/Calc.cs', '/w/py/pkg/mod.py', '/w/src/math.js', '/w/Lib/Greeter.cs', '/w/Lib.Tests/GreeterTests.cs',
  '/elsewhere/Shared.cs',
]);

/** Wraps class elements in a minimal Cobertura document. */
function doc(classes: string, sources: readonly string[] = ['/w']): string {
  return `<coverage><sources>${sources.map(s => `<source>${s}</source>`).join('')}</sources>`
    + `<packages><package name="P"><classes>${classes}</classes></package></packages></coverage>`;
}

test('coverlet dialect: lines, condition coverage and methods', () => {
  const r = parseCobertura(read('cobertura-coverlet.xml'), ctx);
  expect(r.files.map(f => f.path)).toEqual(['/w/src/Calc.cs']);
  expect(lines(r.files[0])).toEqual([[5, 2], [6, 2], [10, 0], [11, 0]]);
  expect(Array.from(r.files[0].branches)).toEqual([10, 0, 0, 0, 10, 0, 1, 0]);
  expect(r.files[0].names).toEqual(['Add', 'Divide']);
  expect(decls(r.files[0])).toEqual([['Add', 5, 2], ['Divide', 10, 0]]);
  expect(r.signature).toBe('Calc');
  expect(r.dropped).toBe(0);
});

test('condition-coverage "50% (1/2)" yields arm 0 covered and arm 1 uncovered', () => {
  const r = parseCobertura(doc('<class filename="src/Calc.cs"><lines>'
    + '<line number="3" hits="5" branch="true" condition-coverage="50% (1/2)"/></lines></class>'), ctx);
  expect(Array.from(r.files[0].branches)).toEqual([3, 0, 0, 1, 3, 0, 1, 0]);
  expect(lines(r.files[0])).toEqual([[3, 5]]);
});

test('the same file listed under two <class> elements is merged into one file', () => {
  const r = parseCobertura(doc(
    '<class name="A" filename="src/Calc.cs"><lines><line number="1" hits="1"/><line number="2" hits="0"/></lines></class>'
    + '<class name="A/Nested" filename="src/Calc.cs"><lines><line number="2" hits="3"/><line number="7" hits="0"/></lines></class>',
  ), ctx);
  expect(r.files).toHaveLength(1);
  expect(lines(r.files[0])).toEqual([[1, 1], [2, 3], [7, 0]]);
});

test('the same file under two <package> elements is merged, and the signature lists both packages', () => {
  const cls = (line: number) => `<classes><class filename="src/Calc.cs"><lines><line number="${line}" hits="1"/></lines></class></classes>`;
  const xml = `<coverage><sources><source>/w</source></sources><packages>`
    + `<package name="Zeta">${cls(1)}</package><package name="Alpha">${cls(2)}</package><package name="Zeta">${cls(3)}</package>`
    + `</packages></coverage>`;
  const r = parseCobertura(xml, ctx);
  expect(lines(r.files[0])).toEqual([[1, 1], [2, 1], [3, 1]]);
  expect(r.signature).toBe('Alpha|Zeta');
});

test('lines listed under a method are not counted again as statements', () => {
  const r = parseCobertura(read('cobertura-coverlet.xml'), ctx);
  // Every line appears under its <method> and under the class <lines>; hits stay as written (2, not 4).
  expect(Array.from(r.files[0].statements)).toEqual([5, 0, 0, 0, 2, 6, 0, 0, 0, 2, 10, 0, 0, 0, 0, 11, 0, 0, 0, 0]);
  expect(Array.from(r.files[0].branches)).toEqual([10, 0, 0, 0, 10, 0, 1, 0]);
  const inline = parseCobertura(doc('<class filename="src/Calc.cs"><methods><method name="M"><lines>'
    + '<line number="3" hits="5" branch="true" condition-coverage="50% (1/2)"/></lines></method></methods>'
    + '<lines><line number="3" hits="5" branch="true" condition-coverage="50% (1/2)"/></lines></class>'), ctx);
  expect(Array.from(inline.files[0].statements)).toEqual([3, 0, 0, 0, 5]);
  expect(Array.from(inline.files[0].branches)).toEqual([3, 0, 0, 1, 3, 0, 1, 0]);
  expect(decls(inline.files[0])).toEqual([['M', 3, 5]]);
});

test('coverage.py dialect: filename relative to <source>, no methods', () => {
  const r = parseCobertura(read('cobertura-coveragepy.xml'), ctx);
  expect(r.files.map(f => f.path)).toEqual(['/w/py/pkg/mod.py']);
  expect(lines(r.files[0])).toEqual([[1, 1], [2, 1], [3, 1], [4, 0]]);
  expect(Array.from(r.files[0].branches)).toEqual([3, 0, 0, 1, 3, 0, 1, 0]);
  expect(r.files[0].declarations.length).toBe(0);
  expect(r.signature).toBe('pkg');
});

test('istanbul dialect: DOCTYPE, method hits as declaration counts', () => {
  const r = parseCobertura(read('cobertura-istanbul.xml'), ctx);
  expect(r.files.map(f => f.path)).toEqual(['/w/src/math.js']);
  expect(lines(r.files[0])).toEqual([[2, 3], [3, 3], [5, 0]]);
  expect(Array.from(r.files[0].branches)).toEqual([3, 0, 0, 1, 3, 0, 1, 0]);
  expect(decls(r.files[0])).toEqual([['(anonymous_1)', 4, 0], ['add', 1, 3]]);
});

test('Microsoft.CodeCoverage dialect: absolute filenames, no sources, entities in names', () => {
  const r = parseCobertura(read('cobertura-mscoverage.xml'), ctx);
  expect(r.files.map(f => f.path)).toEqual(['/w/Lib.Tests/GreeterTests.cs', '/w/Lib/Greeter.cs']);
  const greeter = r.files[1];
  expect(lines(greeter)).toEqual([[7, 4], [8, 4]]);
  expect(Array.from(greeter.branches)).toEqual([7, 0, 0, 1, 7, 0, 1, 1]);
  expect(decls(greeter)).toEqual([['Map<T>', 7, 4]]);
  expect(r.signature).toBe('Lib|Lib.Tests');
});

test('several <source> roots are each tried', () => {
  const r = parseCobertura(doc('<class filename="Lib/Greeter.cs"><lines><line number="1" hits="1"/></lines></class>',
    ['/nowhere', '/w']), ctx);
  expect(r.files.map(f => f.path)).toEqual(['/w/Lib/Greeter.cs']);
});

test('files that do not exist are dropped and counted in dropped', () => {
  const r = parseCobertura(doc(
    '<class filename="src/Calc.cs"><lines><line number="1" hits="1"/></lines></class>'
    + '<class filename="src/Gone.cs"><lines><line number="1" hits="1"/></lines></class>'
    + '<class filename="src/Gone.cs"><lines><line number="2" hits="1"/></lines></class>',
  ), ctx);
  expect(r.files.map(f => f.path)).toEqual(['/w/src/Calc.cs']);
  expect(r.dropped).toBe(1);
});

test('a report whose files are all dropped is valid and has zero files', () => {
  const r = parseCobertura(doc('<class filename="src/Gone.cs"><lines><line number="1" hits="1"/></lines></class>'), ctx);
  expect(r).toEqual({ files: [], signature: 'P', dropped: 1 });
});

test('an existing file outside every workspace root is kept', () => {
  const r = parseCobertura(doc('<class filename="/elsewhere/Shared.cs"><lines><line number="4" hits="2"/></lines></class>'), ctx);
  expect(r.files.map(f => f.path)).toEqual(['/elsewhere/Shared.cs']);
  expect(lines(r.files[0])).toEqual([[4, 2]]);
});

test('a root element other than <coverage> throws NotCoverageReportError', () => {
  expect(() => parseCobertura('<?xml version="1.0"?><Project Sdk="x"><PropertyGroup/></Project>', ctx))
    .toThrow(NotCoverageReportError);
});

test('truncated XML throws ReportParseError', () => {
  expect(() => parseCobertura(read('cobertura-coverlet.xml').slice(0, 400), ctx)).toThrow(ReportParseError);
});

test('a report with no classes yields zero files', () => {
  expect(parseCobertura('<coverage><sources/><packages/></coverage>', ctx)).toEqual({ files: [], signature: '', dropped: 0 });
});
