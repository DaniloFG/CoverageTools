import * as vscode from 'vscode';
import type { Project } from '../adapters/types';
import type { NamedFolder } from '../format';
import { MODE_TEXT, pickerRows, pickerTitle } from '../picker';
import type { RunSettings } from '../settings';

type Mode = RunSettings['mode'];

export interface PickerDeps {
  folders: readonly NamedFolder[];
  /** The keys of the projects run from the picker last time: they come ticked. */
  remembered: readonly string[];
  mode(): Mode;
  setMode(mode: Mode): Promise<void>;
}

interface ProjectItem extends vscode.QuickPickItem { project?: Project }

const other = (mode: Mode): Mode => (mode === 'sequential' ? 'parallel' : 'sequential');

/**
 * Asks which test projects to run, in a list with a tick per project. Resolves with the ticked
 * projects (in list order), with every project when the Run All button is pressed, or with
 * undefined when the list is dismissed. Its other button switches between sequential and parallel
 * runs; the title always tells the mode in effect and what it costs the machine.
 */
export function pickProjects(projects: readonly Project[], deps: PickerDeps): Promise<Project[] | undefined> {
  const pick = vscode.window.createQuickPick<ProjectItem>();
  const ticked: ProjectItem[] = [];
  const items = pickerRows(projects, deps.folders, deps.remembered).map((row): ProjectItem => {
    if (row.kind === 'folder') return { label: row.label, kind: vscode.QuickPickItemKind.Separator };
    const item: ProjectItem = { label: row.label, description: row.description, project: row.project };
    if (row.picked) ticked.push(item);
    return item;
  });
  pick.canSelectMany = true;
  pick.matchOnDescription = true;
  pick.placeholder = 'Tick the test projects to run coverage for';
  pick.items = items;
  pick.selectedItems = ticked;

  const runAll: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('run-all'), tooltip: `Run all ${projects.length} projects` };
  let switchMode: vscode.QuickInputButton;
  const showMode = (): void => {
    const mode = deps.mode();
    switchMode = {
      iconPath: new vscode.ThemeIcon(mode === 'sequential' ? 'list-ordered' : 'layers'),
      tooltip: `Switch to ${MODE_TEXT[other(mode)]}`,
    };
    pick.title = pickerTitle(mode);
    pick.buttons = [runAll, switchMode];
  };
  showMode();

  return new Promise(resolve => {
    let settled = false;
    const settle = (chosen: Project[] | undefined): void => {
      if (settled) return;
      settled = true;
      resolve(chosen);
      pick.dispose();
    };
    pick.onDidAccept(() => {
      const chosen = new Set(pick.selectedItems.map(i => i.project));
      settle(projects.filter(p => chosen.has(p)));
    });
    pick.onDidTriggerButton(button => {
      if (button === runAll) return settle([...projects]);
      if (button !== switchMode) return;
      // A setting that cannot be written leaves the mode, and what the picker says, as they were.
      void deps.setMode(other(deps.mode())).then(showMode, () => undefined);
    });
    pick.onDidHide(() => settle(undefined));
    pick.show();
  });
}
