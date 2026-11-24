import type { FileCoverageData } from '../model';

export type ReportFormat = 'istanbul' | 'cobertura' | 'lcov' | 'coveragepy';

/** When several formats are found for one run, the first of these wins. */
export const FORMAT_PRIORITY: readonly ReportFormat[] = ['istanbul', 'cobertura', 'lcov', 'coveragepy'];

export interface ParseContext {
  /** Directory that holds the report; relative paths are tried against it. */
  reportDir: string;
  /** Workspace folder roots; relative paths are tried against each. */
  roots: readonly string[];
  fileExists(p: string): boolean;
}

export interface ParsedReport {
  /** One entry per source file, sorted by path. */
  files: FileCoverageData[];
  /** Identifies what the report covers (e.g. Cobertura package names); '' when the format has none. */
  signature: string;
  /** Number of distinct files whose path could not be resolved to an existing file. */
  dropped: number;
}

/** The report is malformed or truncated (it may still be being written). */
export class ReportParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReportParseError';
  }
}

/** The file is well-formed but is not a coverage report of the expected format. */
export class NotCoverageReportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotCoverageReportError';
  }
}
