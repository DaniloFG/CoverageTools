import path from 'node:path';
import { expect, test } from 'vitest';
import { EOL } from '../../../src/model';
import { parseLcov } from '../../../src/parsers/lcov';
import type { ParseContext } from '../../../src/parsers/types';
import { decls, lines } from '../helpers';

function ctxOf(existing: readonly string[]): ParseContext {
  const set = new Set(existing);
  return { reportDir: '/w/coverage', roots: ['/w'], fileExists: p => set.has(p), path: path.posix };
}

const ctx = ctxOf(['/w/src/a.js', '/w/src/b.js']);

const SAMPLE = `TN:
SF:src/a.js
FN:1,add
FN:5,9,divide
FNDA:2,add
FNDA:0,divide
DA:2,2
DA:6,0
BRDA:6,0,0,-
BRDA:6,0,1,3
end_of_record
`;

test('reads DA, BRDA, FN and FNDA', () => {
  const r = parseLcov(SAMPLE, ctx);
  expect(r.files.map(f => f.path)).toEqual(['/w/src/a.js']);
  const f = r.files[0];
  expect(lines(f)).toEqual([[2, 2], [6, 0]]);
  expect(Array.from(f.branches)).toEqual([6, 0, 0, 0, 6, 0, 1, 3]);
  expect(f.names).toEqual(['add', 'divide']);
  expect(decls(f)).toEqual([['add', 1, 2], ['divide', 5, 0]]);
  expect(r.signature).toBe('');
  expect(r.dropped).toBe(0);
});

test('FN accepts both "line,name" and "line,endLine,name"', () => {
  const f = parseLcov(SAMPLE, ctx).files[0];
  // add: no end line → no range; divide: lines 5 to 9, to the end of line 9.
  expect(Array.from(f.declarations)).toEqual([1, 0, 0, 0, 2, 0, 5, 0, 9, EOL, 0, 1]);
});

test('a function name containing commas is kept whole', () => {
  const f = parseLcov('SF:src/a.js\nFN:1,a(b,c)\nFN:3,4,d(e,f)\nFNDA:5,a(b,c)\nFNDA:1,d(e,f)\nend_of_record\n', ctx).files[0];
  expect(decls(f)).toEqual([['a(b,c)', 1, 5], ['d(e,f)', 3, 1]]);
});

test('two records for the same SF are merged', () => {
  const text = 'SF:src/a.js\nDA:1,1\nDA:2,0\nBRDA:2,0,0,0\nBRDA:2,0,1,1\nend_of_record\n'
    + 'SF:/w/src/a.js\nDA:2,4\nDA:3,0\nBRDA:2,0,0,2\nBRDA:2,0,1,0\nend_of_record\n';
  const r = parseLcov(text, ctx);
  expect(r.files).toHaveLength(1);
  expect(lines(r.files[0])).toEqual([[1, 1], [2, 4], [3, 0]]);
  expect(Array.from(r.files[0].branches)).toEqual([2, 0, 0, 2, 2, 0, 1, 1]);
});

test('several blocks on one line get distinct arms', () => {
  const f = parseLcov('SF:src/a.js\nBRDA:4,0,0,1\nBRDA:4,0,1,0\nBRDA:4,1,0,2\nBRDA:4,1,1,0\nend_of_record\n', ctx).files[0];
  expect(Array.from(f.branches)).toEqual([4, 0, 0, 1, 4, 0, 1, 0, 4, 0, 2, 2, 4, 0, 3, 0]);
});

test('lcov 2.2 FNL and FNA records are read by index, with commas in names and summed aliases', () => {
  const text = 'SF:src/a.js\nFNL:0,3,8\nFNA:0,4,add\nFNL:1,10\nFNA:1,0,map(a,b)\nFNA:0,1,add_alias\nend_of_record\n';
  const f = parseLcov(text, ctx).files[0];
  expect(f.names).toEqual(['add', 'map(a,b)']);
  expect(Array.from(f.declarations)).toEqual([3, 0, 8, EOL, 5, 0, 10, 0, 0, 0, 0, 1]);
});

test('BRDA reads taken from the last field, so branch expressions may contain commas', () => {
  const f = parseLcov('SF:src/a.js\nBRDA:7,e0,(a,b) == 1,4\nBRDA:7,e0,(a,b) != 1,-\nend_of_record\n', ctx).files[0];
  expect(Array.from(f.branches)).toEqual([7, 0, 0, 4, 7, 0, 1, 0]);
});

test('a repeated FN name gets its FNDA hits once, on the first declaration', () => {
  const f = parseLcov('SF:src/a.js\nFN:1,f\nFN:5,f\nFNDA:3,f\nend_of_record\n', ctx).files[0];
  expect(decls(f)).toEqual([['f', 1, 3]]);
});

test('CRLF line endings are accepted', () => {
  const f = parseLcov(SAMPLE.replace(/\n/g, '\r\n'), ctx).files[0];
  expect(f.path).toBe('/w/src/a.js');
  expect(lines(f)).toEqual([[2, 2], [6, 0]]);
  expect(f.names).toEqual(['add', 'divide']);
  expect(Array.from(f.branches)).toEqual([6, 0, 0, 0, 6, 0, 1, 3]);
});

test('a file with no end_of_record at the end still yields its record', () => {
  const r = parseLcov(SAMPLE + 'SF:src/b.js\nFN:1,f\nFNDA:1,f\nDA:1,7', ctx);
  expect(r.files.map(f => f.path)).toEqual(['/w/src/a.js', '/w/src/b.js']);
  expect(lines(r.files[1])).toEqual([[1, 7]]);
  expect(decls(r.files[1])).toEqual([['f', 1, 1]]);
});

test('records for files that do not exist are dropped and counted', () => {
  const r = parseLcov('SF:src/gone.js\nDA:1,1\nend_of_record\nSF:src/gone.js\nDA:2,1\nend_of_record\n' + SAMPLE, ctx);
  expect(r.files.map(f => f.path)).toEqual(['/w/src/a.js']);
  expect(r.dropped).toBe(1);
});

test('with two roots, a relative SF resolves into the root that holds the report', () => {
  const c: ParseContext = {
    reportDir: '/w/samples/node-nyc/coverage',
    roots: ['/w/samples/node-mocha', '/w/samples/node-nyc'],
    fileExists: p => p === '/w/samples/node-mocha/src/calc.js' || p === '/w/samples/node-nyc/src/calc.js',
    path: path.posix,
  };
  const r = parseLcov('SF:src/calc.js\nDA:1,1\nend_of_record\n', c);
  expect(r.files.map(f => f.path)).toEqual(['/w/samples/node-nyc/src/calc.js']);
});

test('empty input is a valid report with zero files', () => {
  expect(parseLcov('', ctx)).toEqual({ files: [], signature: '', dropped: 0 });
});
