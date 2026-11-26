import { expect, test } from 'vitest';
import manifest from '../../package.json';
import { DEFAULT_RUN_SETTINGS, DEFAULT_SETTINGS } from '../../src/settings';

test('manifest follows the global constraints', () => {
  expect(manifest.name).toBe('coverage-tools');
  expect(manifest.publisher).toBe('DaniloFG');
  expect(manifest.engines.vscode).toBe('^1.90.0');
  expect(manifest.activationEvents).toEqual(['onStartupFinished']);
  expect(manifest.main).toBe('./dist/extension.js');
  expect(manifest.capabilities.untrustedWorkspaces.supported).toBe('limited');
  expect(Object.keys(manifest.dependencies)).toEqual(['c8']);
  expect(manifest.scripts['vscode:prepublish']).toBe('npm run build');
});

test('the commands are contributed under the Coverage Tools category; the run commands need a trusted workspace', () => {
  expect(manifest.contributes.commands).toEqual([
    {
      command: 'coverageTools.runAll', title: 'Run All Coverage', category: 'Coverage Tools',
      icon: '$(run-all-coverage)', enablement: 'isWorkspaceTrusted',
    },
    {
      command: 'coverageTools.run', title: 'Run Coverage...', category: 'Coverage Tools',
      icon: '$(run-coverage)', enablement: 'isWorkspaceTrusted',
    },
    { command: 'coverageTools.runHere', title: 'Run Coverage Here', category: 'Coverage Tools', enablement: 'isWorkspaceTrusted' },
    { command: 'coverageTools.show', title: 'Show Coverage', category: 'Coverage Tools' },
    { command: 'coverageTools.clear', title: 'Clear Coverage', category: 'Coverage Tools' },
  ]);
});

test('Run Coverage Here is offered on runnable Explorer paths only and hidden from the Command Palette', () => {
  const menus = manifest.contributes.menus;
  expect(menus.commandPalette).toEqual([{ command: 'coverageTools.runHere', when: 'false' }]);
  expect(menus['explorer/context']).toEqual([{
    command: 'coverageTools.runHere', when: 'isWorkspaceTrusted && resourcePath in coverageTools.runnablePaths', group: '2_workspace@90',
  }]);
});

test('the Testing view button opens the project picker; Run All Coverage is one step away, in the view\'s overflow menu', () => {
  expect(manifest.contributes.menus['view/title']).toEqual([
    { command: 'coverageTools.run', when: 'view == workbench.view.testing', group: 'navigation@90' },
    { command: 'coverageTools.runAll', when: 'view == workbench.view.testing', group: 'coverageTools@1' },
  ]);
});

test('watch settings are contributed per resource, with the same defaults as DEFAULT_SETTINGS', () => {
  const props = manifest.contributes.configuration.properties;
  for (const key of ['coverageTools.watch.enabled', 'coverageTools.watch.globs', 'coverageTools.exclude'] as const) {
    expect(props[key].scope).toBe('resource');
  }
  expect(props['coverageTools.watch.enabled'].default).toBe(DEFAULT_SETTINGS.watchEnabled);
  expect(props['coverageTools.watch.globs'].default).toEqual(DEFAULT_SETTINGS.watchGlobs);
  expect(props['coverageTools.exclude'].default).toEqual(DEFAULT_SETTINGS.exclude);
});

test('every project setting is contributed per resource with a description and the same default as DEFAULT_SETTINGS', () => {
  const props = manifest.contributes.configuration.properties as Record<string, { scope: string; default: unknown; description?: string; markdownDescription?: string }>;
  const expected: Record<string, unknown> = {
    'coverageTools.watch.enabled': DEFAULT_SETTINGS.watchEnabled,
    'coverageTools.watch.globs': DEFAULT_SETTINGS.watchGlobs,
    'coverageTools.exclude': DEFAULT_SETTINGS.exclude,
    'coverageTools.nestedProjects': DEFAULT_SETTINGS.nestedProjects,
    'coverageTools.dotnet.collector': DEFAULT_SETTINGS.dotnetCollector,
    'coverageTools.dotnet.extraArgs': DEFAULT_SETTINGS.dotnetExtraArgs,
    'coverageTools.node.extraArgs': DEFAULT_SETTINGS.nodeExtraArgs,
    'coverageTools.python.interpreter': DEFAULT_SETTINGS.pythonInterpreter,
    'coverageTools.python.extraArgs': DEFAULT_SETTINGS.pythonExtraArgs,
    'coverageTools.commands': DEFAULT_SETTINGS.commands,
  };
  expect(Object.keys(props).filter(k => !k.startsWith('coverageTools.run.')).sort()).toEqual(Object.keys(expected).sort());
  for (const [key, value] of Object.entries(expected)) {
    expect(props[key].scope, key).toBe('resource');
    expect(props[key].default, key).toEqual(value);
    expect(props[key].description ?? props[key].markdownDescription, key).toMatch(/\w/);
  }
  expect(props['coverageTools.commands'].markdownDescription).toContain('${coverageDir}');
});

test('the run settings apply to the whole window; runs are sequential unless the user chooses parallel', () => {
  const props = manifest.contributes.configuration.properties;
  const mode = props['coverageTools.run.mode'];
  expect(mode.scope).toBe('window');
  expect(mode.enum).toEqual(['sequential', 'parallel']);
  expect(mode.default).toBe(DEFAULT_RUN_SETTINGS.mode);
  expect(mode.default).toBe('sequential');
  expect(mode.enumDescriptions).toHaveLength(2);
  // The setting says why sequence is the default.
  expect(mode.markdownDescription).toMatch(/processor and memory/);
  const max = props['coverageTools.run.maxParallel'];
  expect(max.scope).toBe('window');
  expect(max.type).toBe('integer');
  expect(max.minimum).toBe(0);
  expect(max.default).toBe(DEFAULT_RUN_SETTINGS.maxParallel);
});
