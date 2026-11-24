import * as vscode from 'vscode';
import { formatPercent, keyPath } from '../format';
import type { Count } from '../model';
import type { CoverageStore } from '../store';

/** What the status bar needs from the run queue. */
export interface BusySource {
  readonly busy: boolean;
  onDidChangeBusy(listener: (busy: boolean) => void): { dispose(): void };
}

function percent(c: Count): string {
  return formatPercent(c.covered, c.total);
}

function projectLabel(key: string): string {
  return vscode.workspace.asRelativePath(keyPath(key), true);
}

/** Tells when the published coverage settled after a burst of store changes (see `Publisher`). */
export interface SettleSource {
  onDidSettle(listener: () => void): { dispose(): void };
}

/**
 * Status bar item with the accumulated line total; clicking it runs Show Coverage. It is recomputed
 * once per settled burst of store changes (the publisher's debounce), never per mutation.
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
    this.update();
  }

  dispose(): void {
    for (const s of this.subscriptions) s.dispose();
    this.item.dispose();
  }

  private update(): void {
    const totals = this.store.totals();
    const busy = this.queue?.busy ?? false;
    if (totals.total === 0 && !busy) {
      this.item.hide();
      return;
    }
    const icon = busy ? '$(sync~spin)' : '$(beaker)';
    this.item.text = totals.total === 0 ? icon : `${icon} ${percent(totals)}`;
    this.item.tooltip = this.tooltip(totals, busy);
    this.item.show();
  }

  private tooltip(totals: Count, busy: boolean): string {
    const lines: string[] = [];
    if (totals.total > 0) lines.push(`Coverage Tools: ${percent(totals)} of lines covered`);
    for (const key of this.store.keys().sort()) {
      const t = this.store.totalsOf(key);
      if (t && t.total > 0) lines.push(`${projectLabel(key)}: ${percent(t)}`);
    }
    if (busy) lines.push('Running coverage…');
    lines.push('Click to show the accumulated coverage');
    return lines.join('\n');
  }
}
