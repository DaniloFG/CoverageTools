import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterEach, beforeAll, expect, test } from 'vitest';
import {
  closeAll, copyWorkspace, COVERAGE_VIEW, launchVSCode, waitForCoverageRow, waitForLoaded, waitForOutput, waitUntilWatching,
  type VSCodeSession,
} from './harness';

const repoRoot = resolve(import.meta.dirname, '..', '..');
const sample = join(repoRoot, 'samples', 'python-pytest');
const STATUS_ITEM = '[id="DaniloFG.coverage-tools.coverageTools.status"]';

let s: VSCodeSession;
let ws: string;

beforeAll(() => {
  if (!existsSync(join(sample, '.venv'))) {
    throw new Error('samples/python-pytest has no .venv: run "node scripts/setup-samples.mjs python-pytest" first');
  }
});

afterEach((ctx) => closeAll(ctx));

/** Opens a copy of the sample (its .venv included: the interpreter is a symlink plus pyvenv.cfg). */
async function start(trusted = true): Promise<void> {
  ws = await copyWorkspace(sample);
  await rm(join(ws, '.coverage'), { force: true });
  s = await launchVSCode({ extensionPath: repoRoot, workspace: ws, trusted });
  await waitUntilWatching(s, [ws]);
}

/** Runs the sample's tests from the test process, as the user would in a terminal: `.coverage` lands in the workspace. */
function pytest(...args: string[]): void {
  const env = { ...process.env };
  delete env.COVERAGE_FILE;
  const python = join(ws, '.venv', 'bin', 'python');
  const r = spawnSync(python, ['-m', 'pytest', '--cov', '-p', 'no:cacheprovider', ...args], { cwd: ws, env, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`pytest failed (${r.status ?? r.signal}):\n${r.stdout}\n${r.stderr}`);
}

const statusVisible = (): Promise<boolean> => s.page.locator(STATUS_ITEM).isVisible();

test('a .coverage written by "pytest --cov" in a terminal is converted and ingested by the watcher', async () => {
  await start();
  pytest();
  await waitForLoaded(s, join(ws, '.coverage'));
  // calc.py: 6 statements, line 7 (the raise) never runs.
  await waitForCoverageRow(s, 'calc.py', '83.33%');
  await waitForCoverageRow(s, 'test_calc.py', '100.00%');
});

test('in an untrusted workspace a .coverage is skipped, while a static coverage.xml is still read', async () => {
  await start(false);
  const skipped = `Skipped ${join(ws, '.coverage')}: the workspace is not trusted`;
  pytest();
  await waitForOutput(s, skipped);
  expect(await statusVisible()).toBe(false);
  expect(await s.page.locator(COVERAGE_VIEW).isVisible()).toBe(false);

  // The same run with a Cobertura report: only coverage.xml (preferred over .coverage) is read.
  pytest('--cov-report=xml');
  await waitForLoaded(s, join(ws, 'coverage.xml'));
  await waitForCoverageRow(s, 'calc.py', '83.33%');
});
