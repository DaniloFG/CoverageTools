import type { FileCoverageData } from '../model';
import type { ParsedReport } from '../parsers/types';

/**
 * Stores a parsed report under `key`, replacing what the key held. A report none of whose paths
 * could be resolved (a CI or Docker report with paths outside the workspace) keeps the earlier
 * coverage instead and says so. Returns whether the report was applied.
 */
export function applyReport(
  store: { replace(key: string, files: readonly FileCoverageData[]): void },
  key: string,
  report: Pick<ParsedReport, 'files' | 'dropped'>,
  reportPath: string,
  log: (msg: string) => void,
): boolean {
  if (report.files.length === 0 && report.dropped > 0) {
    log(`Kept the earlier coverage: none of the ${report.dropped} file(s) in ${reportPath} could be found in the workspace (paths outside the workspace, or files that no longer exist).`);
    return false;
  }
  store.replace(key, report.files);
  return true;
}
