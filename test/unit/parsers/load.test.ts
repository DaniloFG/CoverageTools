import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { formatOf, loadReport } from '../../../src/parsers/load';
import { FORMAT_PRIORITY, NotCoverageReportError, ReportParseError } from '../../../src/parsers/types';
import { lines } from '../helpers';

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'ct-load-'));
  mkdirSync(path.join(root, 'src'));
  mkdirSync(path.join(root, 'coverage'));
  writeFileSync(path.join(root, 'src/a.js'), 'a();\nb();\n');
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function write(rel: string, content: string): string {
  const p = path.join(root, rel);
  writeFileSync(p, content);
  return p;
}

const LCOV = 'TN:\nSF:src/a.js\nDA:1,3\nDA:2,0\nend_of_record\n';

test.each([
  ['coverage/coverage-final.json', 'istanbul'], ['out/custom.json', 'istanbul'],
  ['coverage/lcov.info', 'lcov'], ['coverage.lcov', 'lcov'],
  ['TestResults/g/coverage.cobertura.xml', 'cobertura'], ['coverage.xml', 'cobertura'],
  ['.coverage', 'coveragepy'], ['notes.txt', undefined],
])('formatOf(%s) is %s', (p, f) => expect(formatOf(p)).toBe(f));

test('formatOf looks only at the file name, in either separator style and any case', () => {
  expect(formatOf('C:\\w\\Coverage\\LCOV.INFO')).toBe('lcov');
  expect(formatOf('/w/.coverage/notes.txt')).toBeUndefined();
  expect(formatOf('/w/py/.coverage')).toBe('coveragepy');
});

test('FORMAT_PRIORITY is istanbul, cobertura, lcov, coveragepy', () => {
  expect(FORMAT_PRIORITY).toEqual(['istanbul', 'cobertura', 'lcov', 'coveragepy']);
});

test('loadReport reads a real file from disk and resolves against roots', () => {
  const report = loadReport(write('coverage/lcov.info', LCOV), [root]);
  expect(report.files.map(f => f.path)).toEqual([path.join(root, 'src/a.js')]);
  expect(lines(report.files[0])).toEqual([[1, 3], [2, 0]]);
  expect(report.dropped).toBe(0);
});

test('loadReport strips a UTF-8 BOM', () => {
  const report = loadReport(write('coverage.xml', '\ufeff<?xml version="1.0"?>\n<coverage><sources><source>' + root +
    '</source></sources><packages><package name="p"><classes><class filename="src/a.js"><lines>' +
    '<line number="1" hits="2"/></lines></class></classes></package></packages></coverage>'), [root]);
  expect(report.files.map(f => f.path)).toEqual([path.join(root, 'src/a.js')]);
  expect(report.signature).not.toBe('');
});

test('loadReport on a .coverage file throws ReportParseError: conversion happens before loading', () => {
  expect(() => loadReport(write('.coverage', 'SQLite format 3\0'), [root])).toThrow(ReportParseError);
});

test('a coverage.xml whose root element is not <coverage> throws NotCoverageReportError', () => {
  expect(() => loadReport(write('coverage.xml', '<?xml version="1.0"?>\n<!-- c -->\n<project/>'), [root]))
    .toThrow(NotCoverageReportError);
  expect(() => loadReport(write('coverage.xml', 'not xml at all'), [root])).toThrow(NotCoverageReportError);
});

test('a .json that is not an Istanbul coverage map throws NotCoverageReportError', () => {
  expect(() => loadReport(write('coverage/coverage-summary.json', '{"total":{"lines":{"pct":50}}}'), [root]))
    .toThrow(NotCoverageReportError);
  expect(() => loadReport(write('coverage/x.json', '{"src/a.js":{"path":"src/a.js"}}'), [root]))
    .toThrow(NotCoverageReportError);
});

test('a .info or .lcov file that is not a tracefile throws NotCoverageReportError', () => {
  expect(() => loadReport(write('coverage.lcov', 'hello world\n'), [root])).toThrow(NotCoverageReportError);
});

test.each([
  ['coverage/coverage-final.json', ''],
  ['coverage/coverage-final.json', '{"src/a.js":{"statementMap":'],
  ['coverage.xml', '  \n'],
  ['coverage.xml', '<?xml version="1.0"?><cover'],
  ['coverage.xml', '<coverage><packages>'],
  ['coverage/lcov.info', ''],
  ['coverage/lcov.info', 'TN:\nSF:src/a.js\nDA:1,3\n'],
])('empty or truncated %s (%j) throws ReportParseError', (rel, content) => {
  expect(() => loadReport(write(rel, content), [root])).toThrow(ReportParseError);
});

test('a file that disappeared before it was read throws ReportParseError', () => {
  expect(() => loadReport(path.join(root, 'coverage/lcov.info'), [root])).toThrow(ReportParseError);
});

test('other read failures are plain errors', () => {
  mkdirSync(path.join(root, 'dir.json'));
  let error: unknown;
  try {
    loadReport(path.join(root, 'dir.json'), [root]);
  } catch (e) {
    error = e;
  }
  expect(error).toBeInstanceOf(Error);
  expect(error).not.toBeInstanceOf(ReportParseError);
  expect(error).not.toBeInstanceOf(NotCoverageReportError);
});

test('a file with an unknown format throws NotCoverageReportError', () => {
  expect(() => loadReport(write('notes.txt', 'x'), [root])).toThrow(NotCoverageReportError);
});
