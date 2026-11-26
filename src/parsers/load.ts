import { readFileSync, statSync } from 'node:fs';
import nodePath from 'node:path';
import { parseCobertura } from './cobertura';
import { parseIstanbul } from './istanbul';
import { parseLcov } from './lcov';
import { NotCoverageReportError, ReportParseError, type ParseContext, type ParsedReport, type ReportFormat } from './types';

export { FORMAT_PRIORITY } from './types';

/** The format of a report, from its file name alone; undefined when the name is not a known report name. */
export function formatOf(reportPath: string): ReportFormat | undefined {
  const slash = Math.max(reportPath.lastIndexOf('/'), reportPath.lastIndexOf('\\'));
  const name = reportPath.slice(slash + 1).toLowerCase();
  if (name === '.coverage') return 'coveragepy';
  if (name.endsWith('.json')) return 'istanbul';
  if (name.endsWith('.info') || name.endsWith('.lcov')) return 'lcov';
  if (name.endsWith('.xml')) return 'cobertura';
  return undefined;
}

function isSpace(c: number): boolean {
  return c === 32 || c === 9 || c === 10 || c === 13;
}

function skipSpace(text: string, i: number): number {
  while (i < text.length && isSpace(text.charCodeAt(i))) i++;
  return i;
}

/**
 * The name of the root element of an XML document: '' when the text does not start like XML,
 * undefined when it ends before the root element's name is complete.
 */
function rootElementName(text: string): string | undefined {
  let i = skipSpace(text, 0);
  for (;;) {
    if (i >= text.length) return undefined;
    if (text.charCodeAt(i) !== 60 /* < */) return '';
    if (text.startsWith('<?', i) || text.startsWith('<!--', i)) {
      const close = text.startsWith('<?', i) ? '?>' : '-->';
      const end = text.indexOf(close, i + 2);
      if (end < 0) return undefined;
      i = skipSpace(text, end + close.length);
      continue;
    }
    if (text.startsWith('<!', i)) {
      // A DOCTYPE, possibly with an internal subset in brackets.
      let depth = 0;
      let j = i + 2;
      for (; j < text.length; j++) {
        const c = text.charCodeAt(j);
        if (c === 91 /* [ */) depth++;
        else if (c === 93 /* ] */) depth--;
        else if (c === 62 /* > */ && depth <= 0) break;
      }
      if (j >= text.length) return undefined;
      i = skipSpace(text, j + 1);
      continue;
    }
    let j = i + 1;
    for (; j < text.length; j++) {
      const c = text.charCodeAt(j);
      if (isSpace(c) || c === 47 /* / */ || c === 62 /* > */) return text.slice(i + 1, j);
    }
    return undefined;
  }
}

function checkCobertura(text: string): void {
  const root = rootElementName(text);
  if (root === undefined) throw new ReportParseError('Truncated XML: the root element is incomplete');
  if (root !== 'coverage') {
    throw new NotCoverageReportError(root === '' ? 'Not a Cobertura report: not XML' : `Not a Cobertura report: the root element is <${root}>`);
  }
}

/**
 * A tracefile starts with a `TAG:` line. One with no `SF:` record (e.g. only `TN:`) is a valid empty report;
 * one whose last `SF:` record has no `end_of_record` after it is still being written.
 */
function checkLcov(text: string): void {
  const start = skipSpace(text, 0);
  let end = text.indexOf('\n', start);
  if (end < 0) end = text.length;
  const first = text.slice(start, end).trimEnd();
  if (first !== 'end_of_record' && !/^[A-Z]+:/.test(first)) throw new NotCoverageReportError('Not an LCOV tracefile');
  const lastRecord = text.startsWith('SF:', start) ? Math.max(start, text.lastIndexOf('\nSF:')) : text.lastIndexOf('\nSF:');
  if (lastRecord >= 0 && text.indexOf('end_of_record', lastRecord) < 0) {
    throw new ReportParseError('Truncated LCOV: the last record is incomplete');
  }
}

/** UTF-8, or UTF-16 when the file starts with a byte order mark (PowerShell redirection writes it). */
function decode(bytes: Buffer): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.toString('utf16le', 2);
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return Buffer.from(bytes.subarray(2)).swap16().toString('utf16le');
  return bytes.toString('utf8');
}

function readReport(reportPath: string): string {
  try {
    return decode(readFileSync(reportPath));
  } catch (e) {
    // The watcher saw the file, but it is gone: tools often replace a report by deleting and rewriting it,
    // so this is treated like a report that is still being written and is retried.
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new ReportParseError(`The report disappeared before it was read: ${reportPath}`);
    throw e;
  }
}

/**
 * Reads and parses a coverage report synchronously (it runs in the worker thread).
 * Throws ReportParseError for empty, truncated or vanished reports (worth retrying), NotCoverageReportError
 * for files that are not coverage reports of their format, and other errors for I/O failures.
 */
export function loadReport(reportPath: string, roots: readonly string[]): ParsedReport {
  const format = formatOf(reportPath);
  if (format === undefined) throw new NotCoverageReportError(`Not a known coverage report name: ${reportPath}`);
  if (format === 'coveragepy') {
    throw new ReportParseError('A coverage.py data file must be converted to XML before it is loaded');
  }

  let text = readReport(reportPath);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (skipSpace(text, 0) === text.length) throw new ReportParseError(`The report is empty: ${reportPath}`);

  const ctx: ParseContext = {
    reportDir: nodePath.dirname(reportPath),
    roots,
    fileExists: p => statSync(p, { throwIfNoEntry: false })?.isFile() ?? false,
  };
  switch (format) {
    case 'istanbul':
      return parseIstanbul(text, ctx);
    case 'cobertura':
      checkCobertura(text);
      return parseCobertura(text, ctx);
    case 'lcov':
      checkLcov(text);
      return parseLcov(text, ctx);
  }
}
