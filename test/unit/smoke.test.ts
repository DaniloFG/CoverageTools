import { expect, test } from 'vitest';
import manifest from '../../package.json';

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
