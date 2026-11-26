import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';
import { closeAll, launchVSCode, waitFor, type LaunchStage } from './harness';

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
 * Calls closeAll at a fixed stage of a launch (see `LaunchOptions.onStage`) and waits for it there,
 * so each of the two code paths is exercised every time: closed before the process handle came back
 * ('launched': the harness must close the process it then receives, which it reports as the stage
 * 'closed-while-launching') and closed once the window exists ('window').
 */
async function closeAllDuringLaunch(stage: 'launched' | 'window'): Promise<LaunchStage[]> {
  // Every session's user data lives under a coverage-tools-ui-* temp directory. Processes already
  // there belong to other VS Code runs on this machine and are left out.
  const marker = 'coverage-tools-ui-';
  const before = new Set(await processesWith(marker));
  const ours = async (): Promise<number[]> => (await processesWith(marker)).filter((pid) => !before.has(pid));
  const stages: LaunchStage[] = [];
  const outcome = await launchVSCode({
    extensionPath: repoRoot,
    workspace,
    onStage: async (at) => {
      stages.push(at);
      // Awaited by the launch: closing does not wait for the launch, so this cannot deadlock.
      if (at === stage) await closeAll({ task: { name: `pending launch ${stage}`, result: { state: 'fail' } } });
    },
  }).then(() => 'launched', () => 'rejected');
  expect(outcome).toBe('rejected');
  await waitFor(async () => (await ours()).length === 0, 20_000, 'every VS Code process of this launch to exit');
  return stages;
}

pendingLaunchTest('closeAll while the VS Code process is starting leaves no process behind', async () => {
  expect(await closeAllDuringLaunch('launched')).toEqual(['launched', 'closed-while-launching']);
});

pendingLaunchTest('closeAll while the first window is loading leaves no process behind', async () => {
  expect(await closeAllDuringLaunch('window')).toEqual(['launched', 'window']);
});
