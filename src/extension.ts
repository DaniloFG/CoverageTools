import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import * as vscode from 'vscode';
import { FileBuilder } from './model';
import { CoverageStore } from './store';
import { Publisher } from './vscode/publisher';
import { StatusBar } from './vscode/statusBar';

export interface ExtensionApi {
  store: CoverageStore;
  /** Settles once the work started by activation is done. */
  ready: Promise<void>;
}

export function activate(context: vscode.ExtensionContext): ExtensionApi {
  const store = new CoverageStore();
  const publisher = new Publisher(store);
  const statusBar = new StatusBar(store);
  context.subscriptions.push(
    publisher,
    statusBar,
    vscode.commands.registerCommand('coverageTools.show', () => showCoverage(store, publisher)),
    vscode.commands.registerCommand('coverageTools.clear', async () => {
      store.clear();
      await publisher.close();
    }),
  );

  const seed = process.env.COVERAGE_TOOLS_TEST_SEED;
  const ready = seed ? loadTestSeed(seed, store) : Promise.resolve();
  return { store, ready };
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

/**
 * Provisional test hook, removed once report detection exists: loads `[{ path, lines: [[line, count]] }]`
 * from the JSON file named by COVERAGE_TOOLS_TEST_SEED into the store.
 */
async function loadTestSeed(seedFile: string, store: CoverageStore): Promise<void> {
  const entries = JSON.parse(await readFile(seedFile, 'utf8')) as Array<{ path: string; lines: Array<[number, number]> }>;
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
  store.replace('seed', entries.map(({ path, lines }) => {
    const b = new FileBuilder(isAbsolute(path) ? path : join(root, path));
    for (const [line, count] of lines) b.addLine(line, count);
    return b.build();
  }));
}
