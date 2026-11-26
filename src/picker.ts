import nodePath from 'node:path';
import type { AdapterId, Project } from './adapters/types';
import type { NamedFolder } from './format';
import type { RunSettings } from './settings';

/** A row of the project picker: a workspace folder heading, or a project to tick. */
export type PickerRow =
  | { kind: 'folder'; label: string }
  | { kind: 'project'; project: Project; label: string; description: string; picked: boolean };

const STACK: Readonly<Record<AdapterId, string>> = {
  'dotnet-vstest': '.NET',
  'dotnet-mtp': '.NET',
  jest: 'Jest',
  vitest: 'Vitest',
  'node-generic': 'Node',
  python: 'Python',
  custom: 'Custom command',
};

const folderOf = (project: Project): string =>
  (typeof project.meta.workspaceFolder === 'string' ? project.meta.workspaceFolder : project.dir);

/**
 * The picker's rows, in discovery order: each project with where it is inside its workspace folder
 * and its test stack, picked when its key is among `remembered` (the projects run last time). When
 * the projects come from several workspace folders, each folder heads its own.
 */
export function pickerRows(
  projects: readonly Project[], folders: readonly NamedFolder[], remembered: readonly string[], path: typeof nodePath = nodePath,
): PickerRow[] {
  const picked = new Set(remembered);
  const headed = new Set(projects.map(folderOf)).size > 1;
  const rows: PickerRow[] = [];
  let current: string | undefined;
  for (const project of projects) {
    const folder = folderOf(project);
    if (headed && folder !== current) {
      rows.push({ kind: 'folder', label: folders.find(f => f.fsPath === folder)?.name ?? path.basename(folder) });
    }
    current = folder;
    const where = path.relative(folder, project.definingFile ?? project.dir).split(path.sep).join('/');
    rows.push({
      kind: 'project',
      project,
      label: project.name,
      description: [where, STACK[project.adapter]].filter(t => t !== '').join(' · '),
      picked: picked.has(project.key),
    });
  }
  return rows;
}

/** What each run mode means for the machine, as the picker's title and its switch button say it. */
export const MODE_TEXT: Readonly<Record<RunSettings['mode'], string>> = {
  sequential: 'one project at a time (lighter on CPU and memory)',
  parallel: 'projects in parallel (faster, uses more CPU and memory)',
};

export function pickerTitle(mode: RunSettings['mode']): string {
  return `Run Coverage: ${MODE_TEXT[mode]}`;
}
