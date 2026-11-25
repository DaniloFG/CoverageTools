import * as vscode from 'vscode';
import { toDetails, type DeclarationDetail, type Pos, type StatementDetail } from '../details';
import { unionFiles } from '../merge';
import type { FileCoverageData, FileSummary } from '../model';
import type { CoverageStore } from '../store';

/** Quiet time after the last store change before the accumulated set is republished. */
const PUBLISH_DEBOUNCE_MS = 150;

/**
 * A published file that keeps the records it was published with, so that a run kept in VS Code's
 * history still shows what was true when it was published.
 */
class AccumulatedFileCoverage extends vscode.FileCoverage {
  constructor(uri: vscode.Uri, summary: FileSummary, readonly parts: readonly FileCoverageData[]) {
    super(
      uri,
      count(summary.statements),
      summary.branches.total > 0 ? count(summary.branches) : undefined,
      summary.declarations.total > 0 ? count(summary.declarations) : undefined,
    );
  }
}

function count(c: { covered: number; total: number }): vscode.TestCoverageCount {
  return new vscode.TestCoverageCount(c.covered, c.total);
}

function position(p: Pos): vscode.Position {
  return new vscode.Position(p.line, p.character);
}

function location(start: Pos, end: Pos | undefined): vscode.Position | vscode.Range {
  return end ? new vscode.Range(position(start), position(end)) : position(start);
}

function toVSCode(detail: StatementDetail | DeclarationDetail): vscode.FileCoverageDetail {
  const where = location(detail.start, detail.end);
  if (detail.kind === 'declaration') return new vscode.DeclarationCoverage(detail.name, detail.executed, where);
  return new vscode.StatementCoverage(
    detail.executed,
    where,
    detail.branches.map(b => new vscode.BranchCoverage(b.executed, b.position && position(b.position), b.label)),
  );
}

/**
 * Publishes the accumulated coverage through the native Testing API: one coverage-only test run
 * (no test items) per change, with line detail loaded on demand.
 */
export class Publisher {
  private readonly controller: vscode.TestController;
  private readonly profile: vscode.TestRunProfile;
  private readonly subscription: { dispose(): void };
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** Whether a run of ours may be on screen (published since the last close). */
  private shown = false;
  private readonly settleListeners = new Set<() => void>();

  constructor(private readonly store: CoverageStore) {
    this.controller = vscode.tests.createTestController('coverageTools', 'Coverage Tools');
    // The profile exists only so that our runs can carry coverage and answer `loadDetailedCoverage`.
    // Its handler does nothing: we never start a run on the user's behalf from VS Code's own "Run with
    // Coverage" entry points, so we never compete with another extension's coverage run. Show
    // Coverage is the way to republish.
    this.profile = this.controller.createRunProfile('Coverage', vscode.TestRunProfileKind.Coverage, () => {}, false);
    this.profile.loadDetailedCoverage = async (_run, file) => {
      if (!(file instanceof AccumulatedFileCoverage)) return [];
      const data = file.parts.length === 1 ? file.parts[0] : unionFiles(file.parts);
      return toDetails(data).map(toVSCode);
    };
    this.subscription = store.onDidChange(() => this.schedule());
  }

  /**
   * Fires once the display caught up with the store: after each debounced publication (or close),
   * and after `publishNow` and `close`. Listeners do their per-burst work here, not per store change.
   */
  onDidSettle(listener: () => void): { dispose(): void } {
    const wrapped = (): void => listener();
    this.settleListeners.add(wrapped);
    return { dispose: () => { this.settleListeners.delete(wrapped); } };
  }

  /** Publishes the accumulated set now, cancelling a pending publication. Publishes nothing when it is empty. */
  publishNow(): void {
    this.cancelPending();
    const entries = this.store.merged();
    if (entries.length > 0) {
      const request = new vscode.TestRunRequest(undefined, undefined, this.profile);
      const run = this.controller.createTestRun(request, 'Coverage Tools', false);
      for (const e of entries) run.addCoverage(new AccumulatedFileCoverage(vscode.Uri.file(e.path), e.summary, e.parts));
      run.end();
      this.shown = true;
    }
    this.settled();
  }

  /** Closes the native coverage display. */
  async close(): Promise<void> {
    this.cancelPending();
    this.shown = false;
    this.settled();
    try {
      await vscode.commands.executeCommand('testing.coverage.close');
    } catch {
      // Older VS Code builds may lack the command; nothing is displayed then.
    }
  }

  dispose(): void {
    this.cancelPending();
    this.subscription.dispose();
    this.settleListeners.clear();
    this.controller.dispose();
  }

  private schedule(): void {
    this.cancelPending();
    this.timer = setTimeout(() => {
      this.timer = undefined;
      // Coverage that became empty must not leave the last run on screen.
      if (this.shown && this.store.merged().length === 0) void this.close();
      else this.publishNow();
    }, PUBLISH_DEBOUNCE_MS);
  }

  private settled(): void {
    for (const listener of [...this.settleListeners]) {
      try {
        listener();
      } catch {
        // One failing listener must not stop the others.
      }
    }
  }

  private cancelPending(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
