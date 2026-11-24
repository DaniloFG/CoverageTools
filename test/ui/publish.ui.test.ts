import { join, resolve } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { closeAll, COVERAGE_VIEW, launchVSCode, waitFor, type VSCodeSession } from './harness';

const repoRoot = resolve(import.meta.dirname, '..', '..');
const workspace = join(import.meta.dirname, 'fixtures', 'publish-workspace');
/** The status bar entry of Coverage Tools (extension ID + item ID). */
const STATUS_ITEM = '[id="DaniloFG.coverage-tools.coverageTools.status"]';
const NOTIFICATION = '.notifications-toasts .notification-list-item-message';

let s: VSCodeSession;

beforeEach(async () => {
  s = await launchVSCode({
    extensionPath: repoRoot,
    workspace,
    env: { COVERAGE_TOOLS_TEST_SEED: join(workspace, 'seed.json') },
  });
});

afterEach((ctx) => closeAll(ctx));

test('accumulated coverage shows in the native view with per-file percentages', async () => {
  const text = await s.coverageViewText('b.js');
  expect(text).toContain('a.js');
  expect(text).toContain('b.js');
  expect(text).toMatch(/50(\.00)?%/);
  expect(text).toContain('100.00%');
  expect(text).toContain('0.00%');
});

test('opening a file shows covered and uncovered line decorations', async () => {
  await s.coverageViewText('b.js');
  await s.runCommand('Test: Toggle Inline Coverage');
  await s.openFile('a.js');
  await s.page.locator('.editor-instance .view-overlays .coverage-deco-inline.coverage-deco-hit').first()
    .waitFor({ state: 'attached', timeout: 30_000 });
  await s.openFile('b.js');
  await s.page.locator('.editor-instance .view-overlays .coverage-deco-inline.coverage-deco-miss').first()
    .waitFor({ state: 'attached', timeout: 30_000 });
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
