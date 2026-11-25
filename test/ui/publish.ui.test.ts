import { join, resolve } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import {
  closeAll, copyWorkspace, COVERAGE_ROW, COVERAGE_VIEW, launchVSCode, lcov, waitFor, waitForLoaded, waitUntilWatching, writeReport,
  type VSCodeSession,
} from './harness';

const repoRoot = resolve(import.meta.dirname, '..', '..');
const fixture = join(import.meta.dirname, 'fixtures', 'publish-workspace');
/** The status bar entry of Coverage Tools (extension ID + item ID). */
const STATUS_ITEM = '[id="DaniloFG.coverage-tools.coverageTools.status"]';
const NOTIFICATION = '.notifications-toasts .notification-list-item-message';
/** a.js: lines 1, 2 and 4 covered (3/3); b.js: the same lines uncovered (0/3); 50% in total. */
const REPORT = lcov({ 'a.js': [[1, 1], [2, 3], [4, 1]], 'b.js': [[1, 0], [2, 0], [4, 0]] });

let s: VSCodeSession;

beforeEach(async () => {
  const workspace = await copyWorkspace(fixture);
  s = await launchVSCode({ extensionPath: repoRoot, workspace });
  // Seeds the store the way a user would: a report written by a run made outside the extension.
  await waitUntilWatching(s, [workspace]);
  const report = join(workspace, 'coverage', 'lcov.info');
  await writeReport(report, REPORT);
  await waitForLoaded(s, report);
});

afterEach((ctx) => closeAll(ctx));

/** The text of the coverage tree row for `name`. */
async function rowText(name: string): Promise<string> {
  const row = s.page.locator(`${COVERAGE_VIEW} ${COVERAGE_ROW}`, { hasText: name }).first();
  return (await row.innerText({ timeout: 10_000 })).trim();
}

/**
 * The line numbers (1-based) of the editor's inline coverage decorations with `className`,
 * read from the overlay row each decoration is drawn in.
 */
async function decoratedLines(className: string): Promise<number[]> {
  return s.page.evaluate((cls) => {
    // The test project has no DOM types; describe the little that is used.
    interface El { offsetTop: number; offsetHeight: number; parentElement: El | null; querySelector(q: string): El | null; querySelectorAll(q: string): Iterable<El> }
    const editor = (globalThis as unknown as { document: El }).document.querySelector('.editor-instance .monaco-editor');
    const lineHeight = editor?.querySelector('.view-lines .view-line')?.offsetHeight ?? 0;
    if (!editor || lineHeight === 0) return [];
    const lines = new Set<number>();
    for (const deco of editor.querySelectorAll(`.view-overlays .${cls}`)) {
      if (deco.parentElement) lines.add(Math.round(deco.parentElement.offsetTop / lineHeight) + 1);
    }
    return [...lines].sort((a, b) => a - b);
  }, className);
}

test('accumulated coverage shows in the native view with per-file percentages', async () => {
  const text = await s.coverageViewText('b.js');
  expect(text).toMatch(/50(\.00)?%/);
  expect(await rowText('a.js')).toMatch(/(^|[^\d.])100\.00%/);
  expect(await rowText('b.js')).toMatch(/(^|[^\d.])0\.00%/);
});

test('opening a file shows covered and uncovered line decorations on the right lines', async () => {
  await s.coverageViewText('b.js');
  await s.runCommand('Test: Toggle Inline Coverage');
  await s.openFile('a.js');
  // Line 3 (`}`) has no coverage data, so it has no decoration.
  expect(await waitFor(async () => {
    const hit = await decoratedLines('coverage-deco-inline.coverage-deco-hit');
    return hit.length === 3 ? hit : undefined;
  }, 30_000, 'a.js to show three covered lines')).toEqual([1, 2, 4]);
  expect(await decoratedLines('coverage-deco-inline.coverage-deco-miss')).toEqual([]);
  await s.openFile('b.js');
  expect(await waitFor(async () => {
    const miss = await decoratedLines('coverage-deco-inline.coverage-deco-miss');
    return miss.length === 3 ? miss : undefined;
  }, 30_000, 'b.js to show three uncovered lines')).toEqual([1, 2, 4]);
  expect(await decoratedLines('coverage-deco-inline.coverage-deco-hit')).toEqual([]);
});

test('Show Coverage brings the display back after the native view is closed', async () => {
  await s.coverageViewText('b.js');
  await s.runCommand('Test: Clear Coverage');
  await waitFor(async () => !(await s.page.locator(COVERAGE_VIEW).isVisible()), 10_000, 'the Test Coverage view to close');
  // A run that ends opens coverage without revealing the Testing view; Show Coverage must reveal it.
  await s.runCommand('View: Show Explorer');
  await s.runCommand('Coverage Tools: Show Coverage');
  await waitFor(() => s.page.locator(COVERAGE_VIEW).isVisible(), 10_000, 'Show Coverage to reveal the Test Coverage view');
  expect(await s.coverageViewText('b.js')).toMatch(/50(\.00)?%/);
});

test('Clear Coverage empties the view; Show Coverage with an empty store shows an information message', async () => {
  await s.coverageViewText('b.js');
  await s.runCommand('Coverage Tools: Clear Coverage');
  await waitFor(async () => !(await s.page.locator(COVERAGE_VIEW).isVisible()), 10_000, 'the Test Coverage view to close');
  await waitFor(async () => !(await s.page.locator(STATUS_ITEM).isVisible()), 10_000, 'the status bar item to hide');
  await s.runCommand('Coverage Tools: Show Coverage');
  const message = s.page.locator(NOTIFICATION, { hasText: 'no coverage to show' });
  await message.first().waitFor({ state: 'visible', timeout: 10_000 });
  expect(await s.page.locator(COVERAGE_VIEW).isVisible()).toBe(false);
});

test('the status bar shows the accumulated total', async () => {
  const item = s.page.locator(STATUS_ITEM);
  const text = await waitFor(async () => {
    const t = (await item.innerText({ timeout: 1_000 })).trim();
    return t.includes('50%') ? t : undefined;
  }, 30_000, 'the status bar item to show 50%');
  expect(text).toBe('50%');
  expect(await item.locator('.codicon-beaker').count()).toBe(1);
});
