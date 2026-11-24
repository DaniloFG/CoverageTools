import { join } from 'node:path';
import * as vscode from 'vscode';
import { CoverageStore } from './store';
import { readSettings } from './vscode/config';
import { Publisher } from './vscode/publisher';
import { ReportWatcher } from './vscode/reportWatcher';
import { StatusBar } from './vscode/statusBar';
import { ParserClient } from './worker/client';

export interface ExtensionApi {
  store: CoverageStore;
}

export function activate(context: vscode.ExtensionContext): ExtensionApi {
  const store = new CoverageStore();
  const publisher = new Publisher(store);
  const statusBar = new StatusBar(store, publisher);
  // The worker starts only when the first report arrives.
  const parser = new ParserClient(join(context.extensionPath, 'dist', 'worker.js'));
  // Created on the first message, so that a quiet session has no output channel.
  let channel: vscode.LogOutputChannel | undefined;
  const log = (msg: string): void => {
    channel ??= vscode.window.createOutputChannel('Coverage Tools', { log: true });
    channel.info(msg);
  };
  // Reading static reports runs no code, so it stays on in untrusted workspaces.
  const watcher = new ReportWatcher({
    store,
    parser,
    settingsOf: readSettings,
    projects: () => [],
    isSuppressed: () => false,
    log,
  });
  context.subscriptions.push(
    watcher,
    parser,
    publisher,
    statusBar,
    { dispose: () => channel?.dispose() },
    vscode.commands.registerCommand('coverageTools.show', () => showCoverage(store, publisher)),
    vscode.commands.registerCommand('coverageTools.clear', async () => {
      store.clear();
      await publisher.close();
    }),
  );
  return { store };
}

export function deactivate(): void {}

async function showCoverage(store: CoverageStore, publisher: Publisher): Promise<void> {
  if (store.merged().length === 0) {
    void vscode.window.showInformationMessage('Coverage Tools: there is no coverage to show yet.');
    return;
  }
  publisher.publishNow();
  // The workbench does not open coverage for a run that ends early in its startup; open it explicitly.
  try {
    await vscode.commands.executeCommand('testing.openCoverage');
  } catch {
    // Older VS Code builds lack the command; the workbench opens the run by itself there.
  }
}
