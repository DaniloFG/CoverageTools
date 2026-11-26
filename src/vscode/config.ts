import * as vscode from 'vscode';
import { DEFAULT_SETTINGS, runSettingsFrom, type RunSettings, type Settings } from '../settings';

function stringArray(value: unknown, fallback: string[]): string[] {
  return Array.isArray(value) && value.every(v => typeof v === 'string') ? [...value] : [...fallback];
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function stringRecord(value: unknown, fallback: Record<string, string>): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { ...fallback };
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) if (typeof v === 'string') out[k] = v;
  return out;
}

/** The `coverageTools.*` settings that apply to `scope` (a workspace folder or file), with defaults for anything unset or invalid. */
export function readSettings(scope?: vscode.Uri): Settings {
  const c = vscode.workspace.getConfiguration('coverageTools', scope);
  const d = DEFAULT_SETTINGS;
  const nested = c.get<unknown>('nestedProjects');
  const watchEnabled = c.get<unknown>('watch.enabled');
  return {
    watchEnabled: typeof watchEnabled === 'boolean' ? watchEnabled : d.watchEnabled,
    watchGlobs: stringArray(c.get('watch.globs'), d.watchGlobs),
    exclude: stringArray(c.get('exclude'), d.exclude),
    nestedProjects: nested === 'inner' || nested === 'outer' ? nested : d.nestedProjects,
    dotnetCollector: stringValue(c.get('dotnet.collector'), d.dotnetCollector),
    dotnetExtraArgs: stringArray(c.get('dotnet.extraArgs'), d.dotnetExtraArgs),
    nodeExtraArgs: stringArray(c.get('node.extraArgs'), d.nodeExtraArgs),
    pythonInterpreter: stringValue(c.get('python.interpreter'), d.pythonInterpreter),
    pythonExtraArgs: stringArray(c.get('python.extraArgs'), d.pythonExtraArgs),
    commands: stringRecord(c.get('commands'), d.commands),
  };
}

/** The `coverageTools.run.*` settings, which apply to the whole window. */
export function readRunSettings(): RunSettings {
  const c = vscode.workspace.getConfiguration('coverageTools');
  return runSettingsFrom(c.get('run.mode'), c.get('run.maxParallel'));
}

/**
 * Stores the run mode where the user already keeps it (the workspace's settings when it is set
 * there, otherwise the user's own), so the choice made in the picker is the one that takes effect.
 */
export async function writeRunMode(mode: RunSettings['mode']): Promise<void> {
  const c = vscode.workspace.getConfiguration('coverageTools');
  const inWorkspace = c.inspect('run.mode')?.workspaceValue !== undefined;
  await c.update('run.mode', mode, inWorkspace ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global);
}
