// Captures the README's usage screenshots (docs/images/*.png) from a real VS Code running the
// extension on a temporary copy of the sample workspace: `xvfb-run -a npm run screenshots`.
// The samples must be set up first:
//   node scripts/setup-samples.mjs node-jest python-pytest dotnet-vstest-coverlet
// On Linux the capture runs on a private Xvfb screen, large enough for a 1280x800 window at 2x.
// Any failed step exits non-zero, and the images of a failed run are deleted, never left half-made.
import { spawn, spawnSync } from 'node:child_process';
import { copyFile, cp, mkdir, rename, rm, stat } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(import.meta.dirname, '..');
const imagesDir = join(repoRoot, 'docs', 'images');
const SAMPLES = ['node-jest', 'python-pytest', 'dotnet-vstest-coverlet'];
const IMAGES = ['01-run-all', '02-coverage-view', '03-line-detail', '04-explorer-menu', '05-terminal-detection', '06-status-bar'];
const WIDTH = 1280;
const HEIGHT = 800;
const SCALE = 2;
/** .NET runs build the projects first: allow for a cold build in a fresh copy. */
const RUN_ALL_MS = 300_000;
/** Larger images are re-encoded losslessly (when Pillow is available). */
const MAX_BYTES = 400 * 1024;
/** Set in the environment of the capturing child process. */
const CAPTURE_ENV = 'COVERAGE_TOOLS_SCREENSHOTS_CAPTURE';

function step(message) {
  console.log(`screenshots: ${message}`);
}

// ---------------------------------------------------------------------------------------------
// Parent: checks, build, display, and the child process that drives VS Code.

function checkSamples() {
  const missing = [['node-jest', 'node_modules'], ['python-pytest', '.venv']]
    .filter(([dir, file]) => !existsSync(join(repoRoot, 'samples', dir, file)));
  if (missing.length > 0) {
    throw new Error(`samples not set up (${missing.map(([d]) => d).join(', ')}): run "node scripts/setup-samples.mjs ${SAMPLES.join(' ')}" first`);
  }
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: repoRoot, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed`);
}

/**
 * Starts Xvfb on a free display with a screen of `width`x`height` pixels and returns
 * `{ display, stop }`, or undefined when Xvfb is not installed (then the current display is used).
 */
async function startXvfb(width, height) {
  if (process.platform !== 'linux' || spawnSync('Xvfb', ['-help']).error) return undefined;
  const xvfb = spawn('Xvfb', ['-displayfd', '3', '-screen', '0', `${width}x${height}x24`, '-nolisten', 'tcp'], {
    stdio: ['ignore', 'ignore', 'ignore', 'pipe'],
  });
  const display = await new Promise((resolveDisplay, reject) => {
    let out = '';
    xvfb.stdio[3].on('data', (chunk) => {
      out += chunk;
      if (out.includes('\n')) resolveDisplay(`:${out.trim()}`);
    });
    xvfb.on('error', reject);
    xvfb.on('exit', (code) => reject(new Error(`Xvfb exited (${code}) before it was ready`)));
  });
  return { display, stop: () => xvfb.kill() };
}

/** Re-encodes PNGs above `MAX_BYTES` losslessly with Pillow, if it is installed; keeps the smaller file. */
function shrink(paths) {
  const big = paths.filter((p) => existsSync(p) && statSync(p).size > MAX_BYTES);
  if (big.length === 0) return;
  const script = [
    'import os, sys',
    'from PIL import Image',
    'for p in sys.argv[1:]:',
    '    im = Image.open(p); im.load(); t = p + ".tmp.png"; im.save(t, optimize=True)',
    '    os.replace(t, p) if os.path.getsize(t) < os.path.getsize(p) else os.remove(t)',
  ].join('\n');
  const result = spawnSync('python3', ['-I', '-c', script, ...big], { stdio: 'inherit' });
  if (result.status !== 0) step('Pillow is not available; the images were not re-encoded');
}

async function parent() {
  checkSamples();
  run(process.execPath, ['esbuild.mjs']);
  await mkdir(imagesDir, { recursive: true });
  const paths = IMAGES.map((name) => join(imagesDir, `${name}.png`));
  for (const path of paths) await rm(path, { force: true });

  const xvfb = await startXvfb(WIDTH * SCALE, HEIGHT * SCALE);
  let status;
  try {
    // The harness is TypeScript, which Node runs by stripping the types; the warning about the
    // package's module type is expected.
    const child = spawn(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', fileURLToPath(import.meta.url)], {
      cwd: repoRoot,
      stdio: 'inherit',
      env: { ...process.env, [CAPTURE_ENV]: '1', ...(xvfb ? { DISPLAY: xvfb.display } : {}) },
    });
    status = await new Promise((r) => child.on('exit', (code, signal) => r(code ?? signal)));
  } finally {
    xvfb?.stop();
  }
  const missing = paths.filter((p) => !existsSync(p));
  if (status !== 0 || missing.length > 0) {
    // Images of a failed run never stay in docs/images; they are kept aside for diagnosis.
    const partial = join(repoRoot, 'test-results', 'screenshots-partial');
    await rm(partial, { recursive: true, force: true });
    await mkdir(partial, { recursive: true });
    for (const path of paths.filter((p) => existsSync(p))) await rename(path, join(partial, basename(path)));
    throw new Error(status !== 0 ? `the capture failed (${status})` : `images missing: ${missing.join(', ')}`);
  }
  shrink(paths);
  for (const path of paths) step(`docs/images/${path.split('/').pop()}: ${Math.round((await stat(path)).size / 1024)} KB`);
}

// ---------------------------------------------------------------------------------------------
// Child: drives VS Code through the UI test harness and writes the images.

const SETTINGS = {
  // Run as root, VS Code's own title bar reads "[Superuser]": use the native one, which Xvfb (no
  // window manager) does not draw, and keep the menu bar hidden.
  'window.titleBarStyle': 'native',
  'window.menuBarVisibility': 'toggle',
  'window.customTitleBarVisibility': 'never',
  // Context menus drawn by VS Code, so that the page captures them.
  'window.menuStyle': 'custom',
  'workbench.colorTheme': 'Default Dark Modern',
  'extensions.ignoreRecommendations': true,
  'chat.commandCenter.enabled': false,
  'workbench.editor.empty.hint': 'hidden',
  'testing.openTesting': 'neverOpen',
  'git.enabled': false,
  // A neutral prompt: no user, host or directory in the terminal.
  'terminal.integrated.profiles.linux': { bash: { path: 'bash', args: ['--norc', '--noprofile'], env: { PS1: '$ ' } } },
  'terminal.integrated.defaultProfile.linux': 'bash',
  'terminal.integrated.shellIntegration.enabled': false,
  'terminal.integrated.enablePersistentSessions': false,
};

const STATUS_ITEM = '[id="DaniloFG.coverage-tools.coverageTools.status"]';
const MENU_ITEM = '.monaco-menu .action-item .action-label';
const EXPLORER_ROW = '.explorer-folders-view .monaco-list-row';
/** Side bar width, wide enough for the Test Coverage view's names and bars. */
const SIDEBAR_WIDTH = 400;
/** Where the mouse rests during a capture: over nothing that shows a hover. */
const REST = { x: WIDTH / 2, y: HEIGHT / 2 + 150 };

const finished = (text) => [...text.matchAll(/Finished coverage for (.+?): ([\w-]+)\./g)].map((m) => [m[1], m[2]]);

async function capture() {
  const h = await import('../test/ui/harness.ts');
  const COVERAGE_VIEW = h.COVERAGE_VIEW;
  /** @type {import('../test/ui/harness.ts').VSCodeSession} */
  let s;

  /** Closes toasts, hovers and menus, and parks the mouse. */
  const tidy = async () => {
    await s.page.keyboard.press('Escape');
    await s.runCommand('Notifications: Clear All Notifications');
    await s.page.mouse.move(REST.x, REST.y);
  };

  const shoot = async (name, clip) => {
    const toasts = await h.notificationTexts(s);
    if (toasts.length > 0) throw new Error(`a notification is on screen: ${toasts.join(' | ')}`);
    if (await s.page.locator('.monaco-dialog-box').isVisible()) throw new Error('a dialog is on screen');
    // Let list reveals and progress bars settle.
    await s.page.waitForTimeout(700);
    await s.page.screenshot({ path: join(imagesDir, `${name}.png`), clip, scale: 'device', animations: 'disabled', caret: 'hide' });
    step(`captured ${name}.png`);
  };

  /** Shows the Testing view with the Test Coverage view, expanded, and waits until it lists `expected`. */
  const showCoverage = async (expected) => {
    const view = s.page.locator(COVERAGE_VIEW);
    await s.runCommand('View: Show Testing');
    if (!(await view.isVisible())) await s.runCommand('Test: Open Coverage');
    await s.runCommand('Testing: Focus on Test Coverage View');
    await view.locator(h.COVERAGE_ROW).first().waitFor({ state: 'visible', timeout: 30_000 });
    // The Test Explorer only says that no tests were found: collapse it, leaving the space to coverage.
    const explorerHeader = s.page.locator('.part.sidebar .pane-header[aria-label^="Test Explorer"]');
    if ((await explorerHeader.getAttribute('aria-expanded')) === 'true') await explorerHeader.click();
    const collapsed = view.locator('.monaco-list-row[aria-expanded="false"]');
    for (let i = 0; i < 50 && (await collapsed.count()) > 0; i++) {
      await collapsed.first().locator('.monaco-tl-twistie').click();
      await s.page.waitForTimeout(150);
    }
    await h.waitFor(async () => {
      const text = await view.innerText();
      return expected.every((t) => text.includes(t));
    }, 30_000, `the Test Coverage view to list ${expected.join(', ')}`);
  };

  /** Quick Open can take a click on a list that is still updating: try again. */
  const open = async (name) => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await s.openFile(name);
      } catch (error) {
        if (attempt >= 3) throw error;
      }
    }
  };

  /** Expands the collapsed Explorer row `label` (the first visible one). */
  const expandInExplorer = async (label) => {
    const row = s.page.locator(`${EXPLORER_ROW}[aria-label="${label}"]`).first();
    await row.waitFor({ state: 'visible', timeout: 10_000 });
    if ((await row.getAttribute('aria-expanded')) === 'false') await row.click();
    await h.waitFor(async () => (await row.getAttribute('aria-expanded')) === 'true', 10_000, `${label} to expand`);
  };

  /** Widens the side bar by dragging its edge. */
  const widenSideBar = async () => {
    const box = await s.page.locator('.part.sidebar').boundingBox();
    const edge = box.x + box.width;
    await s.page.mouse.move(edge, box.y + box.height / 2);
    await s.page.mouse.down();
    await s.page.mouse.move(box.x + SIDEBAR_WIDTH, box.y + box.height / 2, { steps: 10 });
    await s.page.mouse.up();
  };

  const chooseFromMenu = async (item) => {
    await s.page.locator(MENU_ITEM, { hasText: new RegExp(`^${item}$`) }).first().hover();
  };

  try {
    // The coverage tree's root is the folder holding the samples: name it `samples`.
    const copies = await h.copySamples(SAMPLES);
    const dir = join(copies, 'samples');
    await mkdir(dir);
    for (const name of SAMPLES) await rename(join(copies, name), join(dir, name));
    const workspace = join(dir, 'samples.code-workspace');
    await copyFile(join(repoRoot, 'samples', 'samples.code-workspace'), workspace);
    step('launching VS Code');
    s = await h.launchVSCode({
      extensionPath: repoRoot,
      workspace,
      settings: SETTINGS,
      installed: true,
      args: [`--force-device-scale-factor=${SCALE}`],
    });
    const [width, height, scale] = await s.page.evaluate(() => [window.innerWidth, window.innerHeight, window.devicePixelRatio]);
    if (width !== WIDTH || height !== HEIGHT || scale !== SCALE) {
      throw new Error(`the window is ${width}x${height} at ${scale}x, not ${WIDTH}x${HEIGHT} at ${SCALE}x (is the screen large enough?)`);
    }
    await h.waitUntilWatching(s, SAMPLES.map((n) => join(dir, n)));
    const projects = await h.waitForDiscovery(s);
    if (projects !== 3) throw new Error(`discovery found ${projects} project(s), not 3`);

    // 1. The Command Palette with Run All Coverage highlighted.
    await s.runCommand('View: Show Explorer');
    await widenSideBar();
    await open('calc.js');
    // The cursor on the last, empty line: no word or occurrence highlight in the editor.
    await s.page.keyboard.press('Control+End');
    await tidy();
    await s.page.keyboard.press('F1');
    const input = s.page.locator('.quick-input-widget .quick-input-box input');
    await input.waitFor({ state: 'visible', timeout: 10_000 });
    // F1 opens the palette with `>` already typed.
    await input.pressSequentially('Run All Coverage', { delay: 20 });
    const focused = s.page.locator('.quick-input-list .monaco-list-row.focused .label-name');
    await h.waitFor(async () => (await focused.innerText()).trim() === 'Coverage Tools: Run All Coverage', 10_000, 'Run All Coverage to be highlighted');
    await shoot('01-run-all');

    // 2. Run All, then the Test Coverage view with the three projects.
    step('running Run All Coverage (the .NET build takes a while)');
    await s.page.keyboard.press('Enter');
    const output = await h.waitForOutput(s, (t) => finished(t).length >= 3, RUN_ALL_MS, 'the three runs to finish');
    const runs = finished(output);
    if (runs.some(([, status]) => status !== 'ok')) throw new Error(`a run did not succeed: ${JSON.stringify(runs)}`);
    await h.waitFor(async () => !(await s.page.locator(`${STATUS_ITEM} .codicon-sync`).isVisible()), 30_000, 'the status bar spinner to stop');
    await showCoverage(['calc.js', 'calc.py', 'Calculator.cs']);
    await tidy();
    await shoot('02-coverage-view');

    // 3. A source file with inline coverage: covered and uncovered lines.
    await open('Calculator.cs');
    await s.page.keyboard.press('Control+End');
    await s.runCommand('Test: Toggle Inline Coverage');
    const decoration = (kind) => s.page.locator(`.editor-instance .view-overlays .coverage-deco-inline.coverage-deco-${kind}`).first();
    await decoration('hit').waitFor({ state: 'attached', timeout: 10_000 });
    await decoration('miss').waitFor({ state: 'attached', timeout: 10_000 });
    await tidy();
    await shoot('03-line-detail');

    // 4. The Explorer context menu of a test file, on Run Coverage Here. node-jest/src/calc.test.js
    // is the last row of that name (extra/src/calc.test.js comes first when extra is expanded).
    await tidy();
    await s.runCommand('View: Show Explorer');
    await expandInExplorer('node-jest');
    await expandInExplorer('src');
    const testFile = s.page.locator(`${EXPLORER_ROW}[aria-label="calc.test.js"]`).last();
    await testFile.click();
    await h.waitFor(async () => /^node-jest\s*›?\s*src\b/.test((await s.page.locator('.editor-group-container.active .breadcrumbs-control').innerText()).replace(/\n/g, ' ').trim()),
      10_000, 'node-jest/src/calc.test.js to be open');
    await testFile.click({ button: 'right' });
    await s.page.locator(MENU_ITEM).first().waitFor({ state: 'visible', timeout: 10_000 });
    const items = (await s.page.locator(MENU_ITEM).allInnerTexts()).map((t) => t.trim());
    if (!items.includes('Run Coverage Here')) throw new Error(`Run Coverage Here is not in the menu: ${items.join(', ')}`);
    await chooseFromMenu('Run Coverage Here');
    await shoot('04-explorer-menu');
    await s.page.keyboard.press('Escape');

    // 6. The bottom of the window: the status bar with the Coverage Tools total. (Its tooltip is
    // left out: it names the projects by their location, which here is a temporary directory.)
    await showCoverage(['calc.js', 'calc.py', 'Calculator.cs']);
    await tidy();
    const bar = await s.page.locator(STATUS_ITEM).boundingBox();
    if (!/\d%/.test(await s.page.locator(STATUS_ITEM).innerText())) throw new Error('the status bar shows no total');
    const top = Math.floor(bar.y) - 48;
    await shoot('06-status-bar', { x: 0, y: top, width: WIDTH, height: HEIGHT - top });

    // 5. A coverage run typed in the terminal, detected and shown in the view.
    await s.page.mouse.move(REST.x, REST.y);
    await s.runCommand('Coverage Tools: Clear Coverage');
    await h.waitFor(async () => !(await s.page.locator(COVERAGE_VIEW).isVisible()), 10_000, 'the Test Coverage view to close');
    await s.runCommand('View: Show Explorer');
    await s.page.keyboard.press('Escape');
    // A terminal in the node-jest folder.
    await h.explorerMenu(s, 'node-jest');
    await chooseFromMenu('Open in Integrated Terminal');
    await s.page.keyboard.press('Enter');
    const terminal = s.page.locator('.terminal-wrapper.active .xterm');
    await terminal.waitFor({ state: 'visible', timeout: 15_000 });
    await h.waitFor(async () => (await terminal.innerText()).includes('$'), 15_000, 'the terminal prompt');
    const before = (await h.outputChannelText(s)).length;
    await s.page.keyboard.type('yarn test --coverage');
    await s.page.keyboard.press('Enter');
    await h.waitForOutput(s, (t) => /Loaded \S+\/node-jest\/coverage\//.test(t.slice(before)), 60_000, 'the Jest report to be loaded');
    await h.waitFor(async () => /Done in/.test(await terminal.innerText()), 30_000, 'yarn to finish');
    await open('calc.js');
    await s.runCommand('View: Close Other Editors in Group');
    await s.page.keyboard.press('Control+End');
    await showCoverage(['calc.js']);
    await tidy();
    await shoot('05-terminal-detection');
  } catch (error) {
    // What the window showed, for diagnosis (test-results/ is git-ignored).
    if (s?.page) {
      const debug = join(repoRoot, 'test-results', 'screenshots-failure.png');
      await mkdir(dirname(debug), { recursive: true });
      await s.page.screenshot({ path: debug, timeout: 5_000 }).then(() => console.error(`screenshots: the window at the failure: ${debug}`), () => {});
      await cp(join(s.userDataDir, 'logs'), join(dirname(debug), 'screenshots-logs'), { recursive: true }).catch(() => {});
    }
    throw error;
  } finally {
    await h.closeAll();
  }
}

try {
  await (process.env[CAPTURE_ENV] === '1' ? capture() : parent());
} catch (error) {
  console.error(`screenshots: FAILED: ${error instanceof Error ? error.stack : String(error)}`);
  process.exit(1);
}
