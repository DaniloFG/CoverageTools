import path from 'node:path';
import { expect, test } from 'vitest';
import type { AdapterId, Project } from '../../src/adapters/types';
import { pickerRows, pickerTitle } from '../../src/picker';

const P = path.posix;
function project(folder: string, rel: string, adapter: AdapterId, name: string, file?: string): Project {
  const dir = rel === '' ? folder : `${folder}/${rel}`;
  const definingFile = file === undefined ? undefined : `${dir}/${file}`;
  return {
    key: `project:${definingFile ?? dir}`, adapter, ecosystem: adapter.startsWith('dotnet') ? 'dotnet' : 'node', dir, definingFile, name,
    supportsPartial: true, meta: { workspaceFolder: folder },
  };
}

const api = project('/w/api', 'Api.Tests', 'dotnet-vstest', 'Api.Tests', 'Api.Tests.csproj');
const core = project('/w/api', 'Core.Tests', 'dotnet-mtp', 'Core.Tests', 'Core.Tests.csproj');
const web = project('/w/web', '', 'jest', 'web-app', 'package.json');
const cart = project('/w/web', 'packages/cart', 'vitest', 'cart', 'package.json');
const folders = [{ name: 'api', fsPath: '/w/api' }, { name: 'Web (front)', fsPath: '/w/web' }];

test('one row per project, with where it is in its folder and its test stack; nothing is picked the first time', () => {
  expect(pickerRows([api, core], [folders[0]], [], P)).toEqual([
    { kind: 'project', project: api, label: 'Api.Tests', description: 'Api.Tests/Api.Tests.csproj · .NET', picked: false },
    { kind: 'project', project: core, label: 'Core.Tests', description: 'Core.Tests/Core.Tests.csproj · .NET', picked: false },
  ]);
});

test('with projects in several workspace folders, each folder heads its projects under its name', () => {
  const rows = pickerRows([api, web, cart], folders, [], P);
  expect(rows.map(r => (r.kind === 'folder' ? `# ${r.label}` : `${r.label} | ${r.description}`))).toEqual([
    '# api',
    'Api.Tests | Api.Tests/Api.Tests.csproj · .NET',
    '# Web (front)',
    'web-app | package.json · Jest',
    'cart | packages/cart/package.json · Vitest',
  ]);
});

test('the projects run last time come picked; a remembered project that no longer exists is ignored', () => {
  const rows = pickerRows([api, core, web], folders, [core.key, 'project:/w/gone', web.key], P);
  expect(rows.flatMap(r => (r.kind === 'project' && r.picked ? [r.label] : []))).toEqual(['Core.Tests', 'web-app']);
});

test('every test stack has a name; a project that is the folder itself, without a defining file, shows the stack alone', () => {
  const stack = (adapter: AdapterId) => pickerRows([project('/w/x', '', adapter, 'x')], [], [], P)[0];
  expect(['dotnet-vstest', 'dotnet-mtp', 'jest', 'vitest', 'node-generic', 'python', 'custom'].map(a => {
    const row = stack(a as AdapterId);
    return row.kind === 'project' ? row.description : '';
  })).toEqual(['.NET', '.NET', 'Jest', 'Vitest', 'Node', 'Python', 'Custom command']);
});

test('the title tells the run mode and what it costs', () => {
  expect(pickerTitle('sequential')).toBe('Run Coverage: one project at a time (lighter on CPU and memory)');
  expect(pickerTitle('parallel')).toBe('Run Coverage: projects in parallel (faster, uses more CPU and memory)');
});
