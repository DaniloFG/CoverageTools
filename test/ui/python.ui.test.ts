import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterEach, beforeAll, expect, test } from 'vitest';
import {
  closeAll, copyWorkspace, COVERAGE_VIEW, launchVSCode, outputChannelText, waitFor, waitForCoverageRow, type VSCodeSession,
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
}

/** Runs the sample's tests from the test process, as the user would in a terminal: `.coverage` lands in the workspace. */
function pytest(...args: string[]): void {
  const env = { ...process.env };
  delete env.COVERAGE_FILE;
  const python = join(ws, '.venv', 'bin', 'python');
  const r = spawnSync(python, ['-m', 'pytest', '--cov', '-p', 'no:cacheprovider', ...args], { cwd: ws, env, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`pytest failed (${r.status ?? r.signal}):\n${r.stdout}\n${r.stderr}`);
}

/**
 * Runs pytest until `seen` holds: right after startup the extension may not be watching yet,
 * and a missed event is not repeated.
 */
async function pytestUntil(seen: () => Promise<boolean>, args: string[] = []): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    pytest(...args);
    try {
      await waitFor(seen, 5_000, 'the coverage of the pytest run to be picked up');
      return;
    } catch (error) {
      if (attempt >= 8) throw error;
    }
  }
}

const statusVisible = (): Promise<boolean> => s.page.locator(STATUS_ITEM).isVisible();

test('a .coverage written by "pytest --cov" in a terminal is converted and ingested by the watcher', async () => {
  await start();
  await pytestUntil(statusVisible);
  // calc.py: 6 statements, line 7 (the raise) never runs.
  await waitForCoverageRow(s, 'calc.py', '83.33%');
  await waitForCoverageRow(s, 'test_calc.py', '100.00%');
});

test('in an untrusted workspace a .coverage is skipped, while a static coverage.xml is still read', async () => {
  await start(false);
  const skipped = `Skipped ${join(ws, '.coverage')}: the workspace is not trusted`;
  await pytestUntil(async () => (await outputChannelText(s)).includes(skipped));
  expect(await statusVisible()).toBe(false);
  expect(await s.page.locator(COVERAGE_VIEW).isVisible()).toBe(false);

  // The same run with a Cobertura report: only coverage.xml (preferred over .coverage) is read.
  await pytestUntil(statusVisible, ['--cov-report=xml']);
  await waitForCoverageRow(s, 'calc.py', '83.33%');
});
