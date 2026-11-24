import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { downloadAndUnzipVSCode } from '@vscode/test-electron';
import { _electron, type ElectronApplication, type Page } from 'playwright-core';

export interface LaunchOptions {
  extensionPath: string;
  workspace: string;
  settings?: object;
}

export interface VSCodeSession {
  page: Page;
  runCommand(title: string): Promise<void>;
  coverageViewText(): Promise<string>;
  close(): Promise<void>;
}

const repoRoot = resolve(import.meta.dirname, '..', '..');
const cachePath = join(repoRoot, '.vscode-test');

const FOCUS_COVERAGE_VIEW = 'Testing: Focus on Test Coverage View';
const COVERAGE_VIEW = '.pane:has(> .pane-header[aria-label="Test Coverage Section"])';
/** A file or folder row of the coverage tree, once its percentage has been rendered. */
const COVERAGE_ROW = '.monaco-list[aria-label="Test Coverage Explorer"] .monaco-list-row:has(.test-coverage-bars .tpc)';

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

/** Polls `fn` until it returns a truthy value, and returns that value. */
export async function waitFor<T>(fn: () => T | Promise<T>, timeoutMs = 30_000, intervalMs = 100): Promise<NonNullable<T>> {
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
      const reason = lastError instanceof Error ? `: ${lastError.message}` : '';
      throw new Error(`waitFor timed out after ${timeoutMs} ms${reason}`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

let download: Promise<string> | undefined;

/** Downloads VS Code stable once per process into `.vscode-test/`, reusing an existing install. */
function downloadVSCode(): Promise<string> {
  const silent = { report() {}, error() {} };
  download ??= downloadAndUnzipVSCode({ version: 'stable', cachePath, reporter: silent });
  return download;
}

export async function launchVSCode(opts: LaunchOptions): Promise<VSCodeSession> {
  const executablePath = await downloadVSCode();
  const tempRoot = await mkdtemp(join(tmpdir(), 'coverage-tools-ui-'));
  const userDataDir = join(tempRoot, 'user-data');
  const extensionsDir = join(tempRoot, 'extensions');
  await mkdir(join(userDataDir, 'User'), { recursive: true });
  await mkdir(extensionsDir, { recursive: true });
  await writeFile(
    join(userDataDir, 'User', 'settings.json'),
    JSON.stringify({ ...BASE_SETTINGS, ...opts.settings }, null, 2),
  );

  let app: ElectronApplication | undefined;
  const close = async (): Promise<void> => {
    try {
      await app?.close();
    } finally {
      app = undefined;
      await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  };

  try {
    app = await _electron.launch({
      executablePath,
      args: [
        '--no-sandbox',
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
    const page = await app.firstWindow();
    await page.waitForSelector('.monaco-workbench .part.statusbar', { timeout: 60_000 });
    await waitForEventuallyPhase(page);

    const runCommand = (title: string) => runPaletteCommand(page, title);
    return {
      page,
      runCommand,
      coverageViewText: async () => {
        await runCommand(FOCUS_COVERAGE_VIEW);
        const view = page.locator(COVERAGE_VIEW);
        await view.locator(COVERAGE_ROW).first().waitFor({ state: 'visible', timeout: 30_000 });
        return waitFor(async () => (await view.innerText()).trim(), 10_000);
      },
      close,
    };
  } catch (error) {
    await close().catch(() => {});
    throw error;
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
  );
}

async function runPaletteCommand(page: Page, title: string): Promise<void> {
  const input = page.locator('.quick-input-widget .quick-input-box input');
  await page.keyboard.press('Escape');
  await page.keyboard.press('F1');
  await input.waitFor({ state: 'visible', timeout: 10_000 });
  await input.fill(`>${title}`);
  const entry = page.locator('.quick-input-list .monaco-list-row', {
    has: page.locator('.label-name', { hasText: new RegExp(`^${escapeRegExp(title)}$`) }),
  });
  await entry.first().waitFor({ state: 'visible', timeout: 30_000 });
  const focused = page.locator('.quick-input-list .monaco-list-row.focused .label-name').first();
  if ((await focused.innerText({ timeout: 1_000 }).catch(() => '')).trim() !== title) {
    await entry.first().click();
  } else {
    await page.keyboard.press('Enter');
  }
  await input.waitFor({ state: 'hidden', timeout: 10_000 });
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
