import * as vscode from 'vscode';
import { toDetails, type DeclarationDetail, type Pos, type StatementDetail } from '../details';
import { DEFAULT_SLICES, unionFiles, type SliceOptions } from '../merge';
import type { FileSummary } from '../model';
import type { CoverageStore, MergedEntry } from '../store';

/** Quiet time after the last store change before the accumulated set is republished. */
const PUBLISH_DEBOUNCE_MS = 150;

/**
 * A published file: its uri, its three counts and its path, and no coverage data. VS Code keeps the
 * files of every run in its history, so a file that held its records would keep superseded data
 * alive; the line detail is read from the store when VS Code asks for it (see `loadDetailedCoverage`).
 */
class AccumulatedFileCoverage extends vscode.FileCoverage {
  constructor(uri: vscode.Uri, summary: FileSummary, readonly path: string) {
    super(
      uri,
      count(summary.statements),
      summary.branches.total > 0 ? count(summary.branches) : undefined,
      summary.declarations.total > 0 ? count(summary.declarations) : undefined,
    );
  }

  /** Whether this file shows `summary`'s counts. */
  shows(summary: FileSummary): boolean {
    return same(this.statementCoverage, summary.statements)
      && same(this.branchCoverage, summary.branches)
      && same(this.declarationCoverage, summary.declarations);
  }
}

function same(published: vscode.TestCoverageCount | undefined, c: { covered: number; total: number }): boolean {
  return published === undefined ? c.total === 0 : published.covered === c.covered && published.total === c.total;
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
 * (no test items) per change, with line detail loaded on demand from the current store (so an old
 * run in VS Code's history shows the current line detail). A large set is added to its run in slices
 * that give the event loop control back.
 */
export class Publisher {
  private readonly controller: vscode.TestController;
  private readonly profile: vscode.TestRunProfile;
  private readonly subscription: { dispose(): void };
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** Whether a run of ours may be on screen (published since the last close). */
  private shown = false;
  private readonly settleListeners = new Set<() => void>();
  /**
   * The files of the last publication by path. A file with the same counts again is published as the
   * same `FileCoverage`: VS Code keeps the files of every run in its history, so a republication
   * after one project changed costs that project's changed files only.
   */
  private published = new Map<string, AccumulatedFileCoverage>();
  /** Bumped by every publication and close: a sliced publication that is no longer the latest stops. */
  private generation = 0;
  /** `store.merged()` by path, for `loadDetailedCoverage`; rebuilt when the merged list changes. */
  private index: Map<string, MergedEntry> | undefined;
  private disposed = false;

  constructor(private readonly store: CoverageStore, private readonly slices: SliceOptions = DEFAULT_SLICES) {
    this.controller = vscode.tests.createTestController('coverageTools', 'Coverage Tools');
    // The profile exists only so that our runs can carry coverage and answer `loadDetailedCoverage`.
    // Its handler does nothing: we never start a run on the user's behalf from VS Code's own "Run with
    // Coverage" entry points, so we never compete with another extension's coverage run. Show
    // Coverage is the way to republish.
    this.profile = this.controller.createRunProfile('Coverage', vscode.TestRunProfileKind.Coverage, () => {}, false);
    this.profile.loadDetailedCoverage = async (_run, file) => {
      if (!(file instanceof AccumulatedFileCoverage)) return [];
      const entry = this.entryOf(file.path);
      if (entry === undefined) return []; // No longer in the store.
      const data = entry.parts.length === 1 ? entry.parts[0] : unionFiles(entry.parts);
      return toDetails(data).map(toVSCode);
    };
    this.subscription = store.onDidChange(() => {
      this.index = undefined; // Holds the superseded entries otherwise.
      this.generation++; // A publication still slicing carries stale data: it stops.
      this.schedule();
    });
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

  /**
   * Publishes the accumulated set now, cancelling a pending publication; resolves once it is
   * published (or superseded by a newer one). Publishes nothing when it is empty.
   */
  publishNow(): Promise<void> {
    this.cancelPending();
    const generation = ++this.generation;
    if (this.disposed) return Promise.resolve();
    const entries = this.store.merged();
    if (entries.length === 0) {
      this.published = new Map();
      // A superseded publication may have fed a run already: nothing may stay displayed.
      return this.shown ? this.close() : (this.settled(), Promise.resolve());
    }
    return this.publish(entries, generation).catch(() => {
      // The controller may be gone (dispose) or VS Code refused the run: a later change publishes again.
    });
  }

  private async publish(entries: readonly MergedEntry[], generation: number): Promise<void> {
    let sliceStart = performance.now();
    const published = new Map<string, AccumulatedFileCoverage>();
    const request = new vscode.TestRunRequest(undefined, undefined, this.profile);
    const run = this.controller.createTestRun(request, 'Coverage Tools', false);
    try {
      for (let i = 0; i < entries.length; i++) {
        if ((i & 63) === 63 && performance.now() - sliceStart >= this.slices.sliceMs) {
          await this.slices.yieldToLoop();
          if (generation !== this.generation) return; // A newer publication, a store change or a close took over.
          sliceStart = performance.now();
        }
        const e = entries[i];
        const before = this.published.get(e.path);
        const file = before?.shows(e.summary) ? before : new AccumulatedFileCoverage(before?.uri ?? vscode.Uri.file(e.path), e.summary, e.path);
        published.set(e.path, file);
        run.addCoverage(file);
        this.shown = true; // From the first file on, something of ours is on screen.
      }
    } finally {
      try {
        run.end();
      } catch {
        // The controller was disposed meanwhile.
      }
    }
    if (generation !== this.generation) return;
    this.published = published;
    this.settled();
  }

  /** Closes the native coverage display. */
  async close(): Promise<void> {
    this.cancelPending();
    this.generation++;
    const wasShown = this.shown;
    this.shown = false;
    this.published = new Map();
    this.settled();
    // Another extension's coverage may be on screen: close only what we published.
    if (!wasShown) return;
    try {
      await vscode.commands.executeCommand('testing.coverage.close');
    } catch {
      // Older VS Code builds may lack the command; nothing is displayed then.
    }
  }

  dispose(): void {
    this.cancelPending();
    this.generation++;
    this.disposed = true;
    if (this.shown) {
      this.shown = false;
      Promise.resolve(vscode.commands.executeCommand('testing.coverage.close')).catch(() => undefined);
    }
    this.published = new Map();
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
      else void this.publishNow();
    }, PUBLISH_DEBOUNCE_MS);
  }

  private entryOf(path: string): MergedEntry | undefined {
    // Built once per store version (the change handler drops it), not per file VS Code asks about.
    this.index ??= new Map(this.store.merged().map(e => [e.path, e]));
    return this.index.get(path);
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
