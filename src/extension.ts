import { join } from 'node:path';
import * as vscode from 'vscode';
import { customAdapter } from './adapters/custom';
import { ADAPTERS } from './adapters/index';
import { createPythonAdapter } from './adapters/python';
import type { Adapter, AdapterId, Project, RunTarget } from './adapters/types';
import { loggedRun } from './runner/batch';
import { RunQueue } from './runner/queue';
import { runProject, type RunOutcome } from './runner/runProject';
import { RunSuppressions } from './runner/suppression';
import { CoverageStore } from './store';
import { registerCommands } from './vscode/commands';
import { readSettings } from './vscode/config';
import { WorkspaceFileEvents } from './vscode/fileEvents';
import { vscodeFsReader } from './vscode/fsReader';
import { ProjectDiscovery } from './vscode/projects';
import { Publisher } from './vscode/publisher';
import { selectedPythonInterpreter } from './vscode/pythonExtension';
import { RunnablePathsContext } from './vscode/runnablePaths';
import { ReportWatcher } from './vscode/reportWatcher';
import { StatusBar } from './vscode/statusBar';
import { ParserClient } from './worker/client';

export interface ExtensionApi {
  store: CoverageStore;
  /** Settles when the first project discovery has finished (logged as `Discovery finished: N project(s).`). */
  ready: Promise<void>;
  /** Settles once the report watchers are registered (logged as `Watching for coverage reports.`). */
  watching: Promise<void>;
}

const timers = { set: (fn: () => void, ms: number) => setTimeout(fn, ms), clear: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>) };

export function activate(context: vscode.ExtensionContext): ExtensionApi {
  // Listener errors are logged; `log` is defined below and only called later, so the output channel is not created here.
  const store = new CoverageStore(m => log(m));
  const publisher = new Publisher(store);
  const queue = new RunQueue();
  const statusBar = new StatusBar(store, publisher, queue);
  // The worker starts only when the first report arrives.
  const parser = new ParserClient(join(context.extensionPath, 'dist', 'worker.js'));
  const c8Bin = join(context.extensionPath, 'node_modules', 'c8', 'bin', 'c8.js');
  // Created on the first message, so that nothing is created during activation.
  let channel: vscode.LogOutputChannel | undefined;
  const output = (): vscode.LogOutputChannel => (channel ??= vscode.window.createOutputChannel('Coverage Tools', { log: true }));
  const log = (msg: string): void => output().info(msg);
  const isTrusted = (): boolean => vscode.workspace.isTrusted;

  // The Python extension's selection is read when a run is planned, never at activation.
  const python = createPythonAdapter({ selectedInterpreter: async dir => selectedPythonInterpreter(vscode.Uri.file(dir)) });
  const adapters: readonly Adapter[] = ADAPTERS.map(a => (a.id === 'python' ? python : a));
  const runAdapters = new Map<AdapterId, Adapter>([...adapters, customAdapter].map(a => [a.id, a]));

  const suppressions = new RunSuppressions(timers);
  const runnable = new RunnablePathsContext(
    p => vscode.Uri.file(p).fsPath,
    value => void vscode.commands.executeCommand('setContext', 'coverageTools.runnablePaths', value),
  );
  // One watcher per workspace folder, shared by discovery and the report watcher; created after activation.
  const fileEvents = new WorkspaceFileEvents({ settingsOf: readSettings });
  const discovery = new ProjectDiscovery({
    makeFs: vscodeFsReader,
    adapters,
    settingsOf: readSettings,
    log,
    // The message is only built at the Trace log level (`--log DaniloFG.coverage-tools:trace`).
    trace: msg => {
      if (channel?.logLevel === vscode.LogLevel.Trace) channel.trace(msg());
    },
    events: fileEvents,
    onState: state => runnable.update(state.runnablePaths),
  });

  // Reading static reports runs no code, so it stays on in untrusted workspaces; converting
  // coverage.py data runs an interpreter, so the watcher skips it there.
  const watcher = new ReportWatcher({
    store,
    parser,
    settingsOf: readSettings,
    projects: () => discovery.projects(),
    isSuppressed: key => suppressions.isSuppressed(key),
    isTrusted,
    pythonSelection: selectedPythonInterpreter,
    // Only asks whether a venv interpreter exists; no adapter caches anything on this reader.
    fs: vscodeFsReader(),
    log,
    events: fileEvents,
  });

  const run = (project: Project, target: RunTarget, signal: AbortSignal): Promise<RunOutcome> => {
    if (!isTrusted()) return Promise.resolve({ status: 'cancelled' });
    return loggedRun({ project, target }, signal, log, output => runProject(project, target, {
      adapters: runAdapters,
      store,
      parser,
      // A fresh reader per run: adapters cache imported files per reader object.
      fs: vscodeFsReader(),
      settings: readSettings(vscode.Uri.file(project.dir)),
      roots: (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath),
      c8Bin,
      output,
      suppress: key => suppressions.suppress(key),
    }, signal));
  };

  context.subscriptions.push(
    fileEvents,
    watcher,
    discovery,
    parser,
    publisher,
    statusBar,
    suppressions,
    { dispose: () => queue.cancelAll() },
    { dispose: () => channel?.dispose() },
    vscode.commands.registerCommand('coverageTools.show', () => showCoverage(store, publisher)),
    vscode.commands.registerCommand('coverageTools.clear', async () => {
      store.clear();
      await publisher.close();
    }),
    registerCommands({ discovery, queue, runProject: run, log, showOutput: () => output().show(true), isTrusted }),
  );

  // Nothing is read during activation: discovery starts once activate has returned.
  let watching!: () => void;
  const watchingPromise = new Promise<void>(resolve => { watching = resolve; });
  const pending = setImmediate(() => {
    fileEvents.start();
    log('Watching for coverage reports.');
    watching();
    discovery.start();
  });
  context.subscriptions.push({ dispose: () => clearImmediate(pending) });
  return { store, ready: discovery.ready, watching: watchingPromise };
}

export function deactivate(): void {}

async function showCoverage(store: CoverageStore, publisher: Publisher): Promise<void> {
  if (store.merged().length === 0) {
    void vscode.window.showInformationMessage('Coverage Tools: there is no coverage to show yet.');
    return;
  }
  await publisher.publishNow();
  // The workbench does not open coverage for a run that ends early in its startup; open it explicitly.
  try {
    await vscode.commands.executeCommand('testing.openCoverage');
  } catch {
    // Older VS Code builds lack the command; the workbench opens the run by itself there.
  }
}
