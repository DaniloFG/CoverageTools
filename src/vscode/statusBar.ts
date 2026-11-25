import * as vscode from 'vscode';
import { coverageFraction, formatPercent, keyPath, projectLabel, type DisplayedPercent } from '../format';
import type { FileSummary } from '../model';
import type { CoverageStore } from '../store';

/** What the status bar needs from the run queue. */
export interface BusySource {
  readonly busy: boolean;
  onDidChangeBusy(listener: (busy: boolean) => void): { dispose(): void };
}

/** VS Code's own setting for which percentage its coverage UI shows. */
const DISPLAYED_PERCENT = 'testing.displayedCoveragePercent';

/** The percentage of a summary exactly as the native Test Coverage view writes it. */
function percent(s: FileSummary): string {
  const mode = vscode.workspace.getConfiguration('testing').get<DisplayedPercent>('displayedCoveragePercent') ?? 'totalCoverage';
  return formatPercent(coverageFraction(s, mode));
}

function isEmpty(s: FileSummary): boolean {
  return s.statements.total + s.branches.total + s.declarations.total === 0;
}

function labelOf(key: string): string {
  const folders = (vscode.workspace.workspaceFolders ?? []).map(f => ({ name: f.name, fsPath: f.uri.fsPath }));
  return projectLabel(keyPath(key), folders);
}

/** Tells when the published coverage settled after a burst of store changes (see `Publisher`). */
export interface SettleSource {
  onDidSettle(listener: () => void): { dispose(): void };
}

/**
 * Status bar item with the accumulated total; clicking it runs Show Coverage. The total is the
 * percentage the native Test Coverage view shows for the root of its tree (same formula, same
 * decimals, same `testing.displayedCoveragePercent` setting). It is recomputed once per settled
 * burst of store changes (the publisher's debounce), never per mutation.
 */
export class StatusBar {
  private readonly item: vscode.StatusBarItem;
  private readonly subscriptions: Array<{ dispose(): void }> = [];

  constructor(private readonly store: CoverageStore, settled: SettleSource, private readonly queue?: BusySource) {
    this.item = vscode.window.createStatusBarItem('coverageTools.status', vscode.StatusBarAlignment.Left);
    this.item.name = 'Coverage Tools';
    this.item.command = 'coverageTools.show';
    this.subscriptions.push(settled.onDidSettle(() => this.update()));
    if (queue) this.subscriptions.push(queue.onDidChangeBusy(() => this.update()));
    this.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration(DISPLAYED_PERCENT)) this.update();
    }));
    this.update();
  }

  dispose(): void {
    for (const s of this.subscriptions) s.dispose();
    this.item.dispose();
  }

  private update(): void {
    const totals = this.store.summary();
    const busy = this.queue?.busy ?? false;
    if (isEmpty(totals) && !busy) {
      this.item.hide();
      return;
    }
    const icon = busy ? '$(sync~spin)' : '$(beaker)';
    this.item.text = isEmpty(totals) ? icon : `${icon} ${percent(totals)}`;
    this.item.tooltip = this.tooltip(totals, busy);
    this.item.show();
  }

  private tooltip(totals: FileSummary, busy: boolean): string {
    const lines: string[] = [];
    if (!isEmpty(totals)) lines.push(`Coverage Tools: ${percent(totals)} covered`);
    for (const key of this.store.keys().sort()) {
      const t = this.store.summaryOf(key);
      if (t && !isEmpty(t)) lines.push(`${labelOf(key)}: ${percent(t)}`);
    }
    if (busy) lines.push('Running coverage…');
    lines.push('Click to show the accumulated coverage');
    return lines.join('\n');
  }
}
