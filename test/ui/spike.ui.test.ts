import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { launchVSCode, type VSCodeSession } from './harness';

const fixtures = join(import.meta.dirname, 'fixtures');
const spikeExtension = join(fixtures, 'spike-extension');
const spikeWorkspace = join(fixtures, 'spike-workspace');

let s: VSCodeSession | undefined;

afterEach(async () => {
  await s?.close();
  s = undefined;
});

test('a coverage-only run with no test items shows in the native Test Coverage view', async () => {
  s = await launchVSCode({ extensionPath: spikeExtension, workspace: spikeWorkspace });
  await s.runCommand('Spike: Publish');
  const text = await s.coverageViewText();
  expect(text).toContain('a.txt');
  expect(text).toContain('50');
});
