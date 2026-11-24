import { expect, test } from 'vitest';
import manifest from '../../package.json';
import { DEFAULT_SETTINGS } from '../../src/settings';

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

test('Show and Clear are contributed under the Coverage Tools category', () => {
  expect(manifest.contributes.commands).toEqual([
    { command: 'coverageTools.show', title: 'Show Coverage', category: 'Coverage Tools' },
    { command: 'coverageTools.clear', title: 'Clear Coverage', category: 'Coverage Tools' },
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
