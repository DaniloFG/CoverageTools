import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import {
  closeAll, copyWorkspace, COVERAGE_ROW, COVERAGE_VIEW, istanbul, launchVSCode, lcov, waitFor, writeReport, writeReportUntil,
  type VSCodeSession,
} from './harness';

const repoRoot = resolve(import.meta.dirname, '..', '..');
const fixture = join(import.meta.dirname, 'fixtures', 'watch-workspace');
const STATUS_ITEM = '[id="DaniloFG.coverage-tools.coverageTools.status"]';

/** a.js lives in folder `one`, b.js in folder `two`; lines 1, 2 and 4 hold code. */
const A_FULL = lcov({ 'a.js': [[1, 1], [2, 1], [4, 1]] });
const A_THIRD = lcov({ 'a.js': [[1, 1], [2, 0], [4, 0]] });
const B_NONE = lcov({ 'b.js': [[1, 0], [2, 0], [4, 0]] });

let s: VSCodeSession;
let ws: string;

afterEach((ctx) => closeAll(ctx));

async function start(prepare?: (ws: string) => Promise<void>): Promise<void> {
  ws = await copyWorkspace(fixture);
  await prepare?.(ws);
  s = await launchVSCode({ extensionPath: repoRoot, workspace: join(ws, 'watch.code-workspace') });
}

const statusVisible = (): Promise<boolean> => s.page.locator(STATUS_ITEM).isVisible();

async function rowText(name: string): Promise<string> {
  const row = s.page.locator(`${COVERAGE_VIEW} ${COVERAGE_ROW}`, { hasText: name }).first();
  return (await row.innerText({ timeout: 10_000 })).trim();
}

/** Waits until the coverage row for `name` shows `percent` (e.g. '33.33%'). */
async function rowShows(name: string, percent: string): Promise<void> {
  await s.coverageViewText(name);
  const pattern = new RegExp(`(^|[^\\d.])${percent.replace('.', '\\.')}`);
  await waitFor(async () => pattern.test(await rowText(name)), 10_000, `the ${name} row to show ${percent}`);
}

/**
 * The text of the Coverage Tools output channel (it exists once something was logged), with the
 * editor's soft line breaks removed: long entries wrap.
 */
async function outputText(): Promise<string> {
  await s.runCommand('Output: Show Output Channels...', { expectQuickInput: true });
  const entry = s.page.locator('.quick-input-list .monaco-list-row', {
    has: s.page.locator('.label-name', { hasText: /^Coverage Tools$/ }),
  }).first();
  try {
    await entry.waitFor({ state: 'visible', timeout: 2_000 });
  } catch {
    await s.page.keyboard.press('Escape');
    return '';
  }
  await entry.click();
  const text = await s.page.locator('.part.panel .monaco-editor .view-lines').innerText({ timeout: 5_000 });
  return text.replace(/\u00a0/g, ' ').replace(/\n/g, '');
}

test('a report written to the workspace is picked up without any command', async () => {
  await start();
  await writeReportUntil(join(ws, 'one', 'coverage', 'lcov.info'), A_FULL, statusVisible);
  await rowShows('a.js', '100.00%');
});

test('reports from two folders accumulate; rewriting one keeps the other', async () => {
  await start();
  await writeReportUntil(join(ws, 'one', 'coverage', 'lcov.info'), A_FULL, statusVisible);
  await rowShows('a.js', '100.00%');
  await writeReport(join(ws, 'two', 'coverage', 'lcov.info'), B_NONE);
  await rowShows('b.js', '0.00%');
  expect(await rowText('a.js')).toMatch(/(^|[^\d.])100\.00%/);
  await writeReport(join(ws, 'one', 'coverage', 'lcov.info'), A_THIRD);
  await rowShows('a.js', '33.33%');
  expect(await rowText('b.js')).toMatch(/(^|[^\d.])0\.00%/);
});

test('a truncated report keeps the previous coverage and is retried once after 1 s', async () => {
  await start();
  const report = join(ws, 'one', 'coverage', 'coverage-final.json');
  const a = join(ws, 'one', 'a.js');
  await writeReportUntil(report, istanbul({ [a]: [[1, 1], [2, 1], [4, 1]] }), statusVisible);
  await rowShows('a.js', '100.00%');

  const next = istanbul({ [a]: [[1, 1], [2, 0], [4, 0]] });
  await writeReport(report, next.slice(0, Math.floor(next.length / 2)));
  // Both attempts (the first read and the retry) are logged with a timestamp.
  const attempt = /(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3}) \[info\] Could not read the coverage report/g;
  const times = await waitFor(async () => {
    const found = [...(await outputText()).matchAll(attempt)].map((m) => Date.parse(m[1].replace(' ', 'T')));
    return found.length >= 2 ? found : undefined;
  }, 30_000, 'two logged attempts at the truncated report');
  expect(times).toHaveLength(2);
  expect(times[1] - times[0]).toBeGreaterThanOrEqual(1_000);
  expect(times[1] - times[0]).toBeLessThan(2_000);
  await rowShows('a.js', '100.00%');

  await writeReport(report, next);
  await rowShows('a.js', '33.33%');
});

test('a report that becomes empty closes the coverage display', async () => {
  await start();
  const report = join(ws, 'one', 'coverage', 'coverage-final.json');
  await writeReportUntil(report, istanbul({ [join(ws, 'one', 'a.js')]: [[1, 1], [2, 1], [4, 1]] }), statusVisible);
  await rowShows('a.js', '100.00%');
  await writeReport(report, '{}');
  await waitFor(async () => !(await s.page.locator(COVERAGE_VIEW).isVisible()), 10_000, 'the Test Coverage view to close');
  await waitFor(async () => !(await statusVisible()), 10_000, 'the status bar item to hide');
});

test('a report already on disk at startup is not loaded', async () => {
  await start((dir) => writeReport(join(dir, 'one', 'coverage', 'lcov.info'), A_FULL));
  await writeReportUntil(join(ws, 'two', 'coverage', 'lcov.info'), B_NONE, statusVisible);
  const text = await s.coverageViewText('b.js');
  expect(text).not.toContain('a.js');
});

test('reports under excluded folders are ignored', async () => {
  await start();
  await writeReport(join(ws, 'one', 'node_modules', 'pkg', 'coverage', 'lcov.info'), A_FULL);
  await writeReportUntil(join(ws, 'two', 'coverage', 'lcov.info'), B_NONE, statusVisible);
  const text = await s.coverageViewText('b.js');
  expect(text).not.toContain('a.js');
});

test('with coverageTools.watch.enabled false nothing is picked up', async () => {
  const settings = (ws: string): string => join(ws, 'one', '.vscode', 'settings.json');
  await start((dir) => writeReport(settings(dir), JSON.stringify({ 'coverageTools.watch.enabled': false })));
  await writeReport(join(ws, 'one', 'coverage', 'lcov.info'), A_FULL);
  // Folder `two` still watches: once its report shows, folder one's earlier report would have too.
  await writeReportUntil(join(ws, 'two', 'coverage', 'lcov.info'), B_NONE, statusVisible);
  expect(await s.coverageViewText('b.js')).not.toContain('a.js');
  // Turning it back on starts watching folder one.
  await writeFile(settings(ws), JSON.stringify({ 'coverageTools.watch.enabled': true }));
  await writeReportUntil(join(ws, 'one', 'coverage', 'lcov.info'), A_THIRD, async () => (await s.coverageViewText()).includes('a.js'));
  await rowShows('a.js', '33.33%');
});
