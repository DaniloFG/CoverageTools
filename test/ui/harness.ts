import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { downloadAndUnzipVSCode } from '@vscode/test-electron';
import { _electron, type ElectronApplication, type Page } from 'playwright-core';

export interface LaunchOptions {
  extensionPath: string;
  workspace: string;
  settings?: object;
  /** Extra environment variables for the VS Code process (merged over the test process's own). */
  env?: Record<string, string>;
}

export interface RunCommandOptions {
  /** The command opens a quick input (pick or input box): do not wait for the palette to close. */
  expectQuickInput?: boolean;
}

export interface VSCodeSession {
  page: Page;
  runCommand(title: string, options?: RunCommandOptions): Promise<void>;
  /**
   * Brings the latest run's coverage on screen (with `Test: Open Coverage` when the Test Coverage
   * view is not present), focuses the view, waits for a rendered row and returns the pane's text.
   * After a re-publish, pass what the new run must show as `expected`: otherwise the text may
   * still be the previous run's rows.
   */
  coverageViewText(expected?: string | RegExp): Promise<string>;
  /** Opens a workspace file with Quick Open and waits for its editor to be active. */
  openFile(name: string): Promise<void>;
  close(): Promise<void>;
}

/** Minimal view of a Vitest test context, as `afterEach` receives it. */
export interface TestContextLike {
  task: { name: string; result?: { state?: string } };
}

const repoRoot = resolve(import.meta.dirname, '..', '..');
const cachePath = join(repoRoot, '.vscode-test');
const screenshotDir = join(repoRoot, 'test-results', 'ui');

const FOCUS_COVERAGE_VIEW = 'Testing: Focus on Test Coverage View';
const OPEN_COVERAGE = 'Test: Open Coverage';
export const COVERAGE_VIEW = '.pane:has(> .pane-header[aria-label="Test Coverage Section"])';
/** A file or folder row of the coverage tree, once its percentage has been rendered. */
export const COVERAGE_ROW = '.monaco-list[aria-label="Test Coverage Explorer"] .monaco-list-row:has(.test-coverage-bars .tpc)';
const CLOSE_TIMEOUT_MS = 10_000;

const BASE_SETTINGS = {
  'workbench.startupEditor': 'none',
  'workbench.tips.enabled': false,
  'workbench.enableExperiments': false,
  'telemetry.telemetryLevel': 'off',
  'update.mode': 'none',
  'extensions.autoCheckUpdates': false,
  'extensions.autoUpdate': false,
  'chat.disableAIFeatures': true,
  'window.restoreWindows': 'none',
  'workbench.secondarySideBar.defaultVisibility': 'hidden',
  'git.openRepositoryInParentFolders': 'never',
};

/** Every session not closed yet, so `closeAll` can clean up after a failed or timed-out test. */
const sessions = new Set<VSCodeSession>();

/** Polls `fn` every 100 ms until it returns a truthy value, and returns that value. */
export async function waitFor<T>(fn: () => T | Promise<T>, timeoutMs = 30_000, description?: string): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  for (;;) {
    try {
      const value = await fn();
      if (value) return value as NonNullable<T>;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() >= deadline) {
      const what = description ? ` waiting for ${description}` : '';
      const reason = lastError instanceof Error ? `: ${lastError.message}` : '';
      throw new Error(`waitFor timed out after ${timeoutMs} ms${what}${reason}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * Closes every open session. Call it from `afterEach` with the test context: when the test
 * failed, a screenshot of each window is saved to `test-results/ui/<test name>.png` first.
 */
export async function closeAll(context?: TestContextLike): Promise<void> {
  const open = [...sessions];
  if (context?.task.result?.state === 'fail') {
    const base = context.task.name.replace(/[^\w.-]+/g, '_').slice(0, 120);
    await mkdir(screenshotDir, { recursive: true }).catch(() => {});
    await Promise.all(open.map((s, i) =>
      s.page.screenshot({ path: join(screenshotDir, `${base}${i === 0 ? '' : `-${i + 1}`}.png`), timeout: 5_000 }).catch(() => {})));
  }
  await Promise.all(open.map((s) => s.close()));
}

let download: Promise<string> | undefined;

/** Downloads VS Code stable once per process into `.vscode-test/`, reusing an existing install. */
function downloadVSCode(): Promise<string> {
  const silent = { report() {}, error() {} };
  download ??= downloadAndUnzipVSCode({ version: 'stable', cachePath, reporter: silent }).catch((error: unknown) => {
    download = undefined;
    throw error;
  });
  return download;
}

export async function launchVSCode(opts: LaunchOptions): Promise<VSCodeSession> {
  const executablePath = await downloadVSCode();
  const tempRoot = await mkdtemp(join(tmpdir(), 'coverage-tools-ui-'));

  let app: ElectronApplication | undefined;
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= (async () => {
      sessions.delete(session);
      try {
        if (app) await closeWithin(app, CLOSE_TIMEOUT_MS);
      } finally {
        app = undefined;
        await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      }
    })();
    return closing;
  };
  const session: VSCodeSession = {
    page: undefined as unknown as Page,
    runCommand: (title, options) => runPaletteCommand(session.page, title, options),
    coverageViewText: (expected) => readCoverageView(session, expected),
    openFile: (name) => quickOpen(session.page, name),
    close,
  };
  sessions.add(session);

  try {
    const userDataDir = join(tempRoot, 'user-data');
    const extensionsDir = join(tempRoot, 'extensions');
    await mkdir(join(userDataDir, 'User'), { recursive: true });
    await mkdir(extensionsDir, { recursive: true });
    await writeFile(
      join(userDataDir, 'User', 'settings.json'),
      JSON.stringify({ ...BASE_SETTINGS, ...opts.settings }, null, 2),
    );

    app = await _electron.launch({
      executablePath,
      env: opts.env ? { ...process.env, ...opts.env } as Record<string, string> : undefined,
      args: [
        // Chromium refuses to start as root without it; elsewhere keep the sandbox.
        ...(process.getuid?.() === 0 ? ['--no-sandbox'] : []),
        '--disable-gpu',
        '--disable-updates',
        '--disable-workspace-trust',
        '--skip-welcome',
        '--skip-release-notes',
        '--window-size=1280,800',
        `--extensionDevelopmentPath=${resolve(opts.extensionPath)}`,
        `--user-data-dir=${userDataDir}`,
        `--extensions-dir=${extensionsDir}`,
        resolve(opts.workspace),
      ],
    });
    session.page = await app.firstWindow();
    await session.page.waitForSelector('.monaco-workbench .part.statusbar', { timeout: 60_000 });
    await waitForEventuallyPhase(session.page);
    return session;
  } catch (error) {
    await close().catch(() => {});
    throw error;
  }
}

/** Closes VS Code, killing it if it has not exited within `timeoutMs`. */
async function closeWithin(app: ElectronApplication, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<'timeout'>((r) => { timer = setTimeout(() => r('timeout'), timeoutMs); });
  try {
    const result = await Promise.race([app.close().then(() => 'closed' as const, () => 'timeout' as const), timedOut]);
    if (result === 'timeout') app.process().kill('SIGKILL');
  } finally {
    clearTimeout(timer);
  }
}

async function readCoverageView(session: VSCodeSession, expected?: string | RegExp): Promise<string> {
  const { page } = session;
  const view = page.locator(COVERAGE_VIEW);
  // Do not rely on the workbench opening coverage by itself when a run ends: it misses runs that
  // end before its last lifecycle phase, which happens on slow machines.
  if (!(await view.isVisible())) await session.runCommand(OPEN_COVERAGE);
  await session.runCommand(FOCUS_COVERAGE_VIEW);
  await view.locator(COVERAGE_ROW).first().waitFor({ state: 'visible', timeout: 30_000 });
  const matches = (text: string): boolean =>
    expected === undefined || (typeof expected === 'string' ? text.includes(expected) : expected.test(text));
  let last = '';
  try {
    return await waitFor(async () => {
      last = (await view.innerText()).trim();
      return matches(last) ? last : undefined;
    }, 10_000, `the Test Coverage view to show ${String(expected)}`);
  } catch (error) {
    throw new Error(`${(error as Error).message}; the view shows:\n${last}`, { cause: error });
  }
}

/**
 * Waits for the last workbench lifecycle phase. Some services (such as the one that opens
 * coverage when a run completes) are created lazily and miss runs that end before this phase.
 */
async function waitForEventuallyPhase(page: Page): Promise<void> {
  await waitFor(
    () => page.evaluate(() => performance.getEntriesByName('code/LifecyclePhase/Eventually').length > 0),
    60_000,
    'the workbench lifecycle phase Eventually',
  );
}

async function runPaletteCommand(page: Page, title: string, options: RunCommandOptions = {}): Promise<void> {
  const input = page.locator('.quick-input-widget .quick-input-box input');
  await page.keyboard.press('Escape');
  await page.keyboard.press('F1');
  await input.waitFor({ state: 'visible', timeout: 10_000 });
  await input.fill(`>${title}`);
  const rows = page.locator('.quick-input-list .monaco-list-row');
  const entry = rows.filter({
    has: page.locator('.label-name', { hasText: new RegExp(`^${escapeRegExp(title)}$`) }),
  }).first();
  try {
    await entry.waitFor({ state: 'visible', timeout: 30_000 });
  } catch (error) {
    const listed = await rows.locator('.label-name').allInnerTexts().catch(() => []);
    await page.keyboard.press('Escape').catch(() => {});
    throw new Error(
      `Command "${title}" is not in the Command Palette; listed: ${listed.length ? listed.map((t) => `"${t}"`).join(', ') : '(nothing)'}`,
      { cause: error },
    );
  }
  await entry.click();
  if (!options.expectQuickInput) await input.waitFor({ state: 'hidden', timeout: 10_000 });
}

async function quickOpen(page: Page, name: string): Promise<void> {
  const input = page.locator('.quick-input-widget .quick-input-box input');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+P');
  await input.waitFor({ state: 'visible', timeout: 10_000 });
  await input.fill(name);
  const entry = page.locator('.quick-input-list .monaco-list-row', {
    has: page.locator('.label-name', { hasText: new RegExp(`^${escapeRegExp(name)}$`) }),
  }).first();
  await entry.waitFor({ state: 'visible', timeout: 30_000 });
  await entry.click();
  await input.waitFor({ state: 'hidden', timeout: 10_000 });
  await page.locator(`.tabs-container .tab.active[aria-label^="${name}"]`).waitFor({ state: 'visible', timeout: 10_000 });
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
