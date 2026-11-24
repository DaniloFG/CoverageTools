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

test.skipIf(process.platform !== 'linux')('closeAll during a pending launch leaves no VS Code process behind', async () => {
  // Every session's user data lives under a coverage-tools-ui-* temp directory.
  const marker = 'coverage-tools-ui-';
  expect(await processesWith(marker)).toEqual([]);
  const launching = launchVSCode({ extensionPath: repoRoot, workspace });
  const outcome = launching.then(() => 'launched', () => 'rejected');
  await waitFor(async () => (await processesWith(marker)).length > 0, 60_000, 'VS Code to start');
  await closeAll({ task: { name: 'pending launch', result: { state: 'fail' } } });
  expect(await outcome).toBe('rejected');
  await waitFor(async () => (await processesWith(marker)).length === 0, 20_000, 'every VS Code process to exit');
});
