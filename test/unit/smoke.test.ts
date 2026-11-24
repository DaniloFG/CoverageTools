import { expect, test } from 'vitest';
import manifest from '../../package.json';

test('manifest follows the global constraints', () => {
  expect(manifest.name).toBe('coverage-tools');
  expect(manifest.publisher).toBe('danilofg');
  expect(manifest.engines.vscode).toBe('^1.90.0');
  expect(manifest.activationEvents).toEqual(['onStartupFinished']);
  expect(manifest.main).toBe('./dist/extension.js');
  expect(manifest.capabilities.untrustedWorkspaces.supported).toBe('limited');
  expect(Object.keys(manifest.dependencies)).toEqual(['c8']);
});
