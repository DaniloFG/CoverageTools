import path from 'node:path';
import { withPythonFallback } from '../adapters/python';
import type { CommandSpec } from '../adapters/types';
import type { FileCoverageData } from '../model';
import type { ParsedReport } from '../parsers/types';
import type { IngestResult } from './batcher';

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

export interface CoverageDataDeps {
  /** Workspace Trust: converting runs an interpreter that may come from the repository. */
  isTrusted(): boolean;
  /** The interpreter for the data file (setting, venvs, Python extension selection, `python3`). */
  interpreterFor(coverageFile: string): Promise<string>;
  /** Resolves with the exit code; rejects when the process could not be started. */
  exec(spec: CommandSpec, opts: { onOutput(chunk: string): void; signal: AbortSignal }): Promise<{ code: number | null }>;
  parse(reportPath: string, roots: readonly string[]): Promise<ParsedReport>;
  /** A fresh, empty directory outside the workspace. */
  makeTempDir(): Promise<string>;
  removeDir(dir: string): Promise<void>;
  store: { replace(key: string, files: readonly FileCoverageData[]): void };
  /** The store key of the data file's coverage: the owning project's key, else an `unowned:` key. */
  keyOf(coverageFile: string, signature: string): string;
  roots(): readonly string[];
  log(msg: string): void;
  /** Aborted when the watcher is disposed. */
  signal: AbortSignal;
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Ingests a coverage.py data file written outside the extension: converts it with the resolved
 * interpreter into a temp directory, parses the Cobertura result and replaces the owner's coverage.
 * Every failure is logged only, keeps the previous coverage and is not retried (the next change of
 * the file is a new attempt). The temp directory is always removed.
 */
export async function ingestCoverageData(coverageFile: string, deps: CoverageDataDeps): Promise<IngestResult> {
  if (!deps.isTrusted()) {
    deps.log(`Skipped ${coverageFile}: the workspace is not trusted, and converting a coverage.py data file runs a Python interpreter.`);
    return 'drop';
  }
  let tmpDir: string | undefined;
  try {
    const resolved = await deps.interpreterFor(coverageFile);
    tmpDir = await deps.makeTempDir();
    const xml = path.join(tmpDir, 'coverage.xml');
    let output = '';
    let spawnError = '';
    const { python, result } = await withPythonFallback(resolved, async p => {
      try {
        return await deps.exec(conversionSpec(coverageFile, xml, p), { onOutput: chunk => { output += chunk; }, signal: deps.signal });
      } catch (e) {
        spawnError = messageOf(e);
        return undefined;
      }
    });
    if (deps.signal.aborted) return 'drop';
    const failed = `Could not convert the coverage.py data file ${coverageFile}`;
    if (result === undefined) {
      deps.log(`${failed}: the Python interpreter "${python}" could not be started (${spawnError}). Set "coverageTools.python.interpreter" to the interpreter of this project's environment.`);
      return 'drop';
    }
    if (result.code !== 0) {
      const how = result.code === null ? 'was terminated' : `exited with code ${result.code}`;
      deps.log(`${failed}: "${python} -m coverage xml" ${how}.${output.trim() ? `\n${output.trim()}` : ''}`);
      return 'drop';
    }
    let report: ParsedReport;
    try {
      report = await deps.parse(xml, deps.roots());
    } catch (e) {
      if (!deps.signal.aborted) deps.log(`${failed}: the converted report could not be read: ${messageOf(e)}`);
      return 'drop';
    }
    if (deps.signal.aborted) return 'drop';
    deps.store.replace(deps.keyOf(coverageFile, report.signature), report.files);
    return 'ok';
  } catch (e) {
    if (!deps.signal.aborted) deps.log(`Could not convert the coverage.py data file ${coverageFile}: ${messageOf(e)}`);
    return 'drop';
  } finally {
    if (tmpDir !== undefined) await deps.removeDir(tmpDir).catch(() => undefined);
  }
}
