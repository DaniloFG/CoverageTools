import * as vscode from 'vscode';
import type { Project, RunTarget } from '../adapters/types';
import { resolveTarget, type DiscoveryState } from '../discovery';
import { batchNotices, failureDetails, InFlight, progressMessage, runBatch, type Notice, type RunItem } from '../runner/batch';
import type { RunQueue } from '../runner/queue';
import type { RunOutcome } from '../runner/runProject';

export interface CommandDeps {
  discovery: { readonly ready: Promise<void>; readonly current: DiscoveryState | undefined };
  queue: RunQueue;
  runProject(project: Project, target: RunTarget, signal: AbortSignal): Promise<RunOutcome>;
  log(msg: string): void;
  showOutput(): void;
  isTrusted(): boolean;
}

const UNTRUSTED = 'Coverage Tools runs no tests in an untrusted workspace.';

/** `Run All Coverage` and `Run Coverage Here`. */
export function registerCommands(deps: CommandDeps): vscode.Disposable {
  const inFlight = new InFlight();
  return vscode.Disposable.from(
    vscode.commands.registerCommand('coverageTools.runAll', () => runAll(deps, inFlight)),
    vscode.commands.registerCommand('coverageTools.runHere', (uri?: vscode.Uri, selected?: vscode.Uri[]) => runHere(deps, inFlight, uri, selected)),
  );
}

async function runAll(deps: CommandDeps, inFlight: InFlight): Promise<void> {
  // The commands are disabled in untrusted workspaces; a keybinding or another extension may still call them.
  if (!deps.isTrusted()) return void vscode.window.showWarningMessage(UNTRUSTED);
  await deps.discovery.ready;
  const projects = deps.discovery.current?.projects ?? [];
  if (projects.length === 0) return void vscode.window.showInformationMessage('No test projects found in this workspace.');
  await run(deps, inFlight, projects.map(project => ({ project, target: { kind: 'full' } })));
}

async function runHere(deps: CommandDeps, inFlight: InFlight, uri: vscode.Uri | undefined, selected: vscode.Uri[] | undefined): Promise<void> {
  if (!deps.isTrusted()) return void vscode.window.showWarningMessage(UNTRUSTED);
  const active = vscode.window.activeTextEditor?.document.uri;
  const uris = (selected !== undefined && selected.length > 0 ? selected : [uri ?? active]).filter(
    (u): u is vscode.Uri => u !== undefined && u.scheme === 'file',
  );
  await deps.discovery.ready;
  const state = deps.discovery.current;
  const items: RunItem[] = [];
  for (const u of uris) {
    if (state === undefined) break;
    let isDirectory = false;
    try {
      isDirectory = ((await vscode.workspace.fs.stat(u)).type & vscode.FileType.Directory) !== 0;
    } catch {
      continue;
    }
    items.push(...resolveTarget(u.fsPath, isDirectory, state));
  }
  if (items.length === 0) return void vscode.window.showInformationMessage('No tests to run here.');
  await run(deps, inFlight, items);
}

/**
 * Runs the items through the shared queue under one cancellable progress notification; requests made
 * meanwhile queue behind them, without the runs already queued or running. Cancelling stops the
 * running process and empties the whole queue.
 */
async function run(deps: CommandDeps, inFlight: InFlight, requested: RunItem[]): Promise<void> {
  const items = inFlight.claim(requested);
  if (items.length === 0) return; // All of it is queued or running already.
  const results = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Coverage Tools', cancellable: true },
    async (progress, token) => {
      const cancel = token.onCancellationRequested(() => deps.queue.cancelAll());
      if (deps.queue.busy) progress.report({ message: 'Waiting for the run in progress…' });
      try {
        return await runBatch(items, {
          queue: deps.queue,
          inFlight,
          run: (item, signal) => deps.runProject(item.project, item.target, signal),
          onStart: (item, n, total) => progress.report({ message: progressMessage(item.project.name, n, total) }),
        });
      } finally {
        cancel.dispose();
      }
    },
  );
  for (const r of results) {
    const line = failureDetails(r.item.project.name, r.outcome);
    if (line !== undefined) deps.log(line);
  }
  for (const notice of batchNotices(results)) show(notice, deps);
}

function show(notice: Notice, deps: CommandDeps): void {
  const SHOW_OUTPUT = 'Show Output';
  const actions = notice.showOutput ? [SHOW_OUTPUT] : [];
  const shown = notice.severity === 'error'
    ? vscode.window.showErrorMessage(notice.text, ...actions)
    : vscode.window.showWarningMessage(notice.text, ...actions);
  void shown.then(choice => {
    if (choice === SHOW_OUTPUT) deps.showOutput();
  });
}
