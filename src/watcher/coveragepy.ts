import path from 'node:path';
import type { CommandSpec } from '../adapters/types';

/**
 * Converts a coverage.py data file into a Cobertura report: `<python> -m coverage xml`, run in the
 * data file's directory so that the project's own coverage configuration applies.
 */
export function conversionSpec(coverageFile: string, outXml: string, python: string): CommandSpec {
  return {
    command: python,
    args: ['-m', 'coverage', 'xml', `--data-file=${coverageFile}`, '-o', outXml],
    cwd: path.dirname(coverageFile),
  };
}
