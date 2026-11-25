import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';
import { closeAll, launchVSCode, waitFor } from './harness';

const repoRoot = resolve(import.meta.dirname, '..', '..');
const workspace = join(import.meta.dirname, 'fixtures', 'publish-workspace');

/** PIDs of running processes whose command line contains `marker` (Linux only). */
async function processesWith(marker: string): Promise<number[]> {
  const pids: number[] = [];
  for (const entry of await readdir('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    const cmdline = await readFile(join('/proc', entry, 'cmdline'), 'utf8').catch(() => '');
    if (cmdline.includes(marker)) pids.push(Number(entry));
  }
  return pids;
}

const pendingLaunchTest = test.skipIf(process.platform !== 'linux');

/**
 * Calls closeAll at a fixed stage of a launch (see `LaunchOptions.onStage`), so each of the two
 * code paths is exercised every time: closed before the process handle came back ('launched': the
 * harness must close the process it then receives) and closed once the window exists ('window').
 */
async function closeAllDuringLaunch(stage: 'launched' | 'window'): Promise<void> {
  // Every session's user data lives under a coverage-tools-ui-* temp directory.
  const marker = 'coverage-tools-ui-';
  expect(await processesWith(marker)).toEqual([]);
  let closed: Promise<void> | undefined;
  const outcome = await launchVSCode({
    extensionPath: repoRoot,
    workspace,
    onStage: (at) => {
      if (at === stage) closed = closeAll({ task: { name: `pending launch ${stage}`, result: { state: 'fail' } } });
    },
  }).then(() => 'launched', () => 'rejected');
  expect(closed).toBeDefined();
  await closed;
  expect(outcome).toBe('rejected');
  await waitFor(async () => (await processesWith(marker)).length === 0, 20_000, 'every VS Code process to exit');
}

pendingLaunchTest('closeAll while the VS Code process is starting leaves no process behind', () => closeAllDuringLaunch('launched'));

pendingLaunchTest('closeAll while the first window is loading leaves no process behind', () => closeAllDuringLaunch('window'));
