import { copyFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterEach, beforeAll, expect, test } from 'vitest';
import { existsSync } from 'node:fs';
import {
  COVERAGE_ROW, COVERAGE_VIEW, closeAll, copySamples, coverageRowText, explorerMenu, launchVSCode, lcov, makeWorkspace, notificationTexts,
  outputChannelText, revealInExplorer, runFromExplorer, waitFor, waitForCoverageRow, waitForDiscovery, waitForLoaded,
  waitForOutput, waitUntilWatching, writeReport, type VSCodeSession,
} from './harness';

const repoRoot = resolve(import.meta.dirname, '..', '..');
const SAMPLES = ['node-jest', 'python-pytest', 'dotnet-vstest-coverlet'];
const JEST = 'node-jest-sample';
const RUN_ALL = 'Coverage Tools: Run All Coverage';
const RUN_HERE = 'Run Coverage Here';
/** The status bar entry of Coverage Tools (extension ID + item ID). */
const STATUS_ITEM = '[id="DaniloFG.coverage-tools.coverageTools.status"]';
/** .NET runs build the projects first: allow for a cold build in a fresh copy. */
const DOTNET_RUN_MS = 240_000;

let s: VSCodeSession;

beforeAll(() => {
  const missing = [['node-jest', 'node_modules'], ['python-pytest', '.venv']].filter(([d, f]) => !existsSync(join(repoRoot, 'samples', d, f)));
  if (missing.length > 0) {
    throw new Error(`samples not set up (${missing.map(([d]) => d).join(', ')}): run "node scripts/setup-samples.mjs ${SAMPLES.join(' ')}" first`);
  }
});

afterEach((ctx) => closeAll(ctx));

/**
 * Launches VS Code on `workspace` (a folder, or a `.code-workspace` file whose folders are given) and
 * waits until the extension watches them and discovery finished; returns the project count.
 */
async function start(workspace: string, options: { trusted?: boolean; folders?: string[] } = {}): Promise<number> {
  s = await launchVSCode({ extensionPath: repoRoot, workspace, trusted: options.trusted });
  await waitUntilWatching(s, options.folders ?? [workspace]);
  return waitForDiscovery(s);
}

/** A temp copy of the three samples with `samples.code-workspace` (folders node-jest, python-pytest, dotnet-vstest-coverlet). */
async function startSamples(): Promise<number> {
  const dir = await copySamples(SAMPLES);
  await copyFile(join(repoRoot, 'samples', 'samples.code-workspace'), join(dir, 'samples.code-workspace'));
  return start(join(dir, 'samples.code-workspace'), { folders: SAMPLES.map((n) => join(dir, n)) });
}

const finished = (text: string): Array<[string, string]> =>
  [...text.matchAll(/Finished coverage for (.+?): ([\w-]+)\./g)].map((m) => [m[1], m[2]]);

/** Waits until `count` runs have finished in total and returns every `[project, status]` so far. */
async function waitForRuns(count: number, timeoutMs = 120_000): Promise<Array<[string, string]>> {
  const text = await waitForOutput(s, (t) => finished(t).length >= count, timeoutMs, `${count} run(s) to finish`);
  return finished(text);
}

test('Run All Coverage runs every project and the view shows files from all three ecosystems; running one project again keeps the others', async () => {
  expect(await startSamples()).toBe(3);

  // The Testing view title offers Run All Coverage; it is the way in here.
  await s.runCommand('View: Show Testing');
  // The Test Explorer is the only view of its container, so its actions are in the side bar title.
  const button = s.page.locator('.part.sidebar .action-label[aria-label="Run All Coverage"]:visible').first();
  await button.waitFor({ state: 'visible', timeout: 10_000 });
  await button.click();
  await waitFor(async () => (await notificationTexts(s)).some((t) => /Running coverage: .+ \(\d\/3\)/.test(t)), 30_000, 'the progress notification');

  const runs = await waitForRuns(3, DOTNET_RUN_MS);
  expect(runs.map(([, status]) => status)).toEqual(['ok', 'ok', 'ok']);
  await waitForCoverageRow(s, 'calc.js', '100.00%');
  await waitForCoverageRow(s, 'calc.py', '83.33%');
  await s.coverageViewText('Calculator.cs');

  // The status bar total is the number the native view shows on the root row of its tree. Here the
  // tree has a single root (the directory holding the three workspace folders), whose percentage VS
  // Code computes itself from every published file.
  const roots = s.page.locator(`${COVERAGE_VIEW} ${COVERAGE_ROW}[aria-level="1"]`);
  expect(await roots.count()).toBe(1);
  const rootPercent = /(\d+\.\d\d)%/.exec(await roots.first().innerText())?.[1];
  expect(rootPercent).toBeDefined();
  const status = await waitFor(async () => {
    const t = (await s.page.locator(STATUS_ITEM).innerText({ timeout: 1_000 })).trim();
    return t === `${rootPercent}%` ? t : undefined;
  }, 10_000, `the status bar to show the root row's ${rootPercent}%`).catch(async (error: unknown) => {
    throw new Error(`${(error as Error).message}; it shows ${await s.page.locator(STATUS_ITEM).innerText()}`, { cause: error });
  });
  expect(status).toBe(`${rootPercent}%`);

  const python = await coverageRowText(s, 'calc.py');
  const dotnet = await coverageRowText(s, 'Calculator.cs');

  // Running the Jest project alone (its workspace folder in the Explorer) leaves the other rows as they were.
  await runFromExplorer(s, 'node-jest', RUN_HERE);
  expect((await waitForRuns(4)).at(-1)).toEqual([JEST, 'ok']);
  await waitForCoverageRow(s, 'calc.js', '100.00%');
  expect(await coverageRowText(s, 'calc.py')).toBe(python);
  expect(await coverageRowText(s, 'Calculator.cs')).toBe(dotnet);
}, DOTNET_RUN_MS + 120_000);

test('the Explorer menu shows Run Coverage Here on test files and test projects, not on plain sources or libraries', async () => {
  await startSamples();
  // calc.js has a unique name; node-jest/src/calc.test.js is then on screen next to it (extra/src stays collapsed).
  await revealInExplorer(s, 'calc.js');
  expect(await explorerMenu(s, 'calc.js')).not.toContain(RUN_HERE);
  expect(await explorerMenu(s, 'calc.test.js')).toContain(RUN_HERE);
  await revealInExplorer(s, 'Calc.Tests.csproj');
  expect(await explorerMenu(s, 'Calc.Tests.csproj')).toContain(RUN_HERE);
  await revealInExplorer(s, 'Calc.csproj');
  expect(await explorerMenu(s, 'Calc.csproj')).not.toContain(RUN_HERE);
  // A folder that holds a test project.
  expect(await explorerMenu(s, 'Calc.Tests')).toContain(RUN_HERE);
  await s.page.keyboard.press('Escape');
  // Hidden from the Command Palette.
  await expect(s.runCommand(`Coverage Tools: ${RUN_HERE}`, { timeoutMs: 5_000 })).rejects.toThrow(/is not in the Command Palette/);
});

test('Run Coverage Here on a test file runs a partial run that adds to the project', async () => {
  const dir = await copySamples(['node-jest']);
  await start(join(dir, 'node-jest'));
  await revealInExplorer(s, 'calc.js');
  await runFromExplorer(s, 'calc.test.js', RUN_HERE);
  expect(await waitForRuns(1)).toEqual([[JEST, 'ok']]);
  // Only add() ran: part of calc.js is covered.
  await s.coverageViewText('calc.js');
  const partial = Number(/(\d+(?:\.\d+)?)%/.exec(await coverageRowText(s, 'calc.js'))?.[1]);
  expect(partial).toBeGreaterThan(0);
  expect(partial).toBeLessThan(100);
  await runFromExplorer(s, 'other.test.js', RUN_HERE);
  expect((await waitForRuns(2)).at(-1)).toEqual([JEST, 'ok']);
  await waitForCoverageRow(s, 'calc.js', '100.00%');
});

test('Run Coverage Here on a folder that holds two projects runs both', async () => {
  const dir = await copySamples(['node-jest', 'python-pytest']);
  // One workspace folder, `apps`, with the two projects inside.
  const ws = await makeWorkspace({});
  const { rename, mkdir } = await import('node:fs/promises');
  await mkdir(join(ws, 'apps'));
  await rename(join(dir, 'node-jest'), join(ws, 'apps', 'node-jest'));
  await rename(join(dir, 'python-pytest'), join(ws, 'apps', 'python-pytest'));
  expect(await start(ws)).toBe(2);
  await runFromExplorer(s, 'apps', RUN_HERE);
  const runs = await waitForRuns(2);
  expect(runs.map(([name]) => name).sort()).toEqual([JEST, 'python-pytest']);
  await waitForCoverageRow(s, 'calc.js', '100.00%');
  await waitForCoverageRow(s, 'calc.py', '83.33%');
});

test('a run made by the extension is not ingested a second time by the watcher', async () => {
  const dir = await copySamples(['python-pytest']);
  const ws = join(dir, 'python-pytest');
  // The project's own test setup writes a report into the workspace at the end of every pytest run,
  // claiming nothing was covered: if the watcher took it, the project's coverage would drop to 0%.
  const report = join(ws, 'coverage', 'lcov.info');
  await writeReport(join(ws, 'conftest.py'), [
    'import os',
    '',
    'def pytest_sessionfinish(session):',
    `    os.makedirs(${JSON.stringify(join(ws, 'coverage'))}, exist_ok=True)`,
    `    with open(${JSON.stringify(report)}, "w") as f:`,
    `        f.write(${JSON.stringify(lcov({ [join(ws, 'calc.py')]: [[1, 0], [2, 0], [5, 0], [6, 0], [7, 0], [8, 0]] }))})`,
    '',
  ].join('\n'));
  await start(ws);
  await revealInExplorer(s, 'test_calc.py');
  await runFromExplorer(s, 'test_calc.py', RUN_HERE);
  expect(await waitForRuns(1)).toEqual([['python-pytest', 'ok']]);
  expect(existsSync(report)).toBe(true);
  // add() only: lines 1, 2 and 5 of 6.
  await waitForCoverageRow(s, 'calc.py', '50.00%');
  // Past the 750 ms debounce and the 2,000 ms suppression tail, nothing was loaded from the workspace.
  await new Promise((r) => setTimeout(r, 4_000));
  expect(await outputChannelText(s)).not.toContain(`Loaded ${report}`);
  await waitForCoverageRow(s, 'calc.py', '50.00%');
  // Control: the same report written outside a run, after the tail, is loaded (so the watcher did see that path).
  await writeReport(report, lcov({ [join(ws, 'calc.py')]: [[1, 0], [2, 0], [5, 0], [6, 0], [7, 0], [8, 0]] }));
  await waitForLoaded(s, report);
  await waitForCoverageRow(s, 'calc.py', '0.00%');
});

/** Two workspace folders, each a custom-command project. */
async function startCustom(commands: { a: string; b: string }): Promise<number> {
  const ws = await makeWorkspace({
    'a/.vscode/settings.json': JSON.stringify({ 'coverageTools.commands': { '.': commands.a } }),
    'b/.vscode/settings.json': JSON.stringify({ 'coverageTools.commands': { '.': commands.b } }),
    'custom.code-workspace': JSON.stringify({ folders: [{ path: 'a' }, { path: 'b' }] }),
  });
  return start(join(ws, 'custom.code-workspace'), { folders: [join(ws, 'a'), join(ws, 'b')] });
}

test('cancelling the progress notification stops the run and empties the queue', async () => {
  expect(await startCustom({ a: 'sleep 120', b: 'sleep 120' })).toBe(2);
  await s.runCommand(RUN_ALL);
  await waitForOutput(s, 'Running coverage for a ', 30_000);
  const toast = s.page.locator('.notifications-toasts .notification-list-item', { hasText: 'Running coverage: a (1/2)' });
  await toast.waitFor({ state: 'visible', timeout: 10_000 });
  await toast.hover();
  await toast.locator('.monaco-button', { hasText: /^Cancel$/ }).click();
  const runs = await waitForRuns(2, 30_000);
  expect(runs.sort()).toEqual([['a', 'cancelled'], ['b', 'cancelled']]);
  expect(await outputChannelText(s)).not.toContain('Running coverage for b ');
  await waitFor(async () => (await toast.count()) === 0, 10_000, 'the progress notification to close');
});

test('with no test project in the workspace, Run All shows "No test projects found in this workspace."', async () => {
  expect(await start(await makeWorkspace({ 'a.js': 'module.exports = 1;\n' }))).toBe(0);
  await s.runCommand(RUN_ALL);
  await waitFor(async () => (await notificationTexts(s)).includes('No test projects found in this workspace.'), 10_000, 'the message');
});

test('a failing run shows an error with a "Show Output" action and the adapter hint', async () => {
  await startCustom({ a: 'exit 3', b: 'echo no report here' });
  await runFromExplorer(s, 'a', RUN_HERE);
  expect(await waitForRuns(1)).toEqual([['a', 'no-report']]);
  const toast = s.page.locator('.notifications-toasts .notification-list-item', { hasText: 'Coverage failed for a:' });
  await toast.waitFor({ state: 'visible', timeout: 10_000 });
  expect(await toast.innerText()).toContain('The custom command wrote no coverage report the extension can read.');
  await toast.hover();
  await toast.locator('.monaco-button', { hasText: /^Show Output$/ }).click();
  // The output panel opens on the Coverage Tools channel, which holds the details.
  const panelText = async (): Promise<string> =>
    (await s.page.locator('.part.panel .monaco-editor .view-lines').innerText()).replace(/\u00a0/g, ' ').replace(/\n/g, '');
  await waitFor(async () => (await panelText()).includes('Coverage failed for a (no-report)'), 10_000, 'the Coverage Tools output to be shown');
});

test('in an untrusted workspace the run commands are unavailable and written reports are still picked up', async () => {
  const dir = await copySamples(['node-jest']);
  const ws = join(dir, 'node-jest');
  expect(await start(ws, { trusted: false })).toBe(1);
  await expect(s.runCommand(RUN_ALL, { timeoutMs: 5_000 })).rejects.toThrow(/is not in the Command Palette/);
  await revealInExplorer(s, 'calc.js');
  expect(await explorerMenu(s, 'calc.test.js')).not.toContain(RUN_HERE);
  await s.page.keyboard.press('Escape');
  const report = join(ws, 'coverage', 'lcov.info');
  await writeReport(report, lcov({ 'src/calc.js': [[2, 1], [6, 0], [7, 0], [9, 0], [12, 1]] }));
  await waitForLoaded(s, report);
  await waitForCoverageRow(s, 'calc.js', '40.00%');
  expect(await outputChannelText(s)).not.toContain('Running coverage for');
});
