import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeAll, expect, test } from 'vitest';
import { closeAll, copySamples, launchVSCode, waitForDiscovery, waitForOutput, waitUntilWatching, type VSCodeSession } from './harness';

const repoRoot = resolve(import.meta.dirname, '..', '..');
const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { publisher: string; name: string; version: string };
/** Where `npm run package` writes the `.vsix` (the publishing workflow publishes this path). */
const VSIX = join(repoRoot, 'release', `${manifest.name}-${manifest.version}.vsix`);

beforeAll(() => {
  if (!existsSync(join(repoRoot, 'samples', 'node-mocha', 'node_modules'))) {
    throw new Error('samples not set up (node-mocha): run "node scripts/setup-samples.mjs node-mocha" first');
  }
  // The real packaging script, as a release runs it.
  execFileSync('npm', ['run', 'package'], { cwd: repoRoot, stdio: 'pipe', shell: process.platform === 'win32' });
}, 180_000);

afterEach((ctx) => closeAll(ctx));

/** The names of the entries of a zip file, read from its central directory. */
function zipEntries(zipPath: string): string[] {
  const zip = readFileSync(zipPath);
  // End of central directory record: signature 0x06054b50, within the last 64 KiB + 22 bytes.
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65_557); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error(`${zipPath} is not a zip file`);
  const count = zip.readUInt16LE(eocd + 10);
  let offset = zip.readUInt32LE(eocd + 16);
  const names: string[] = [];
  for (let n = 0; n < count; n++) {
    if (zip.readUInt32LE(offset) !== 0x02014b50) throw new Error(`bad central directory entry in ${zipPath}`);
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    names.push(zip.toString('utf8', offset + 46, offset + 46 + nameLength));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return names;
}

test('the .vsix contains dist, the bundled c8 and the icon, and no source, test, sample or docs files', () => {
  const entries = zipEntries(VSIX);
  for (const required of [
    'extension/package.json',
    'extension/dist/extension.js',
    'extension/dist/worker.js',
    'extension/node_modules/c8/bin/c8.js',
    'extension/media/icon.png',
  ]) {
    expect(entries, required).toContain(required);
  }
  for (const prefix of ['extension/src/', 'extension/test/', 'extension/samples/', 'extension/docs/', 'extension/scripts/', 'extension/.github/']) {
    expect(entries.filter((e) => e.startsWith(prefix)), prefix).toEqual([]);
  }
  // Production dependencies only (c8 and its tree), and no source maps of a development build.
  expect(entries.filter((e) => /^extension\/node_modules\/(vitest|typescript|esbuild|@vscode)\//.test(e))).toEqual([]);
  expect(entries.filter((e) => e.startsWith('extension/dist/') && e.endsWith('.map'))).toEqual([]);
});

test('the packaged .vsix installs into a clean VS Code and Run All Coverage works with the bundled c8', async () => {
  const dir = await copySamples(['node-mocha']);
  const workspace = join(dir, 'node-mocha');
  // No --extensionDevelopmentPath: the extension is installed from the .vsix with `--install-extension`.
  const s: VSCodeSession = await launchVSCode({ extensionPath: repoRoot, vsix: VSIX, workspace });
  const extensionsDir = join(dirname(s.userDataDir), 'extensions');
  const installed = `${manifest.publisher.toLowerCase()}.${manifest.name}-${manifest.version}`;
  expect(readdirSync(extensionsDir)).toContain(installed);

  await waitUntilWatching(s, [workspace]);
  expect(await waitForDiscovery(s)).toBe(1);
  await s.runCommand('Coverage Tools: Run All Coverage');
  const output = await waitForOutput(s, /Finished coverage for node-mocha-sample: [\w-]+\./, 120_000);
  expect(output).toContain('Finished coverage for node-mocha-sample: ok.');
  // The command line runs the c8 shipped inside the installed extension.
  expect(output).toContain(join(extensionsDir, installed, 'node_modules', 'c8'));
  expect(await s.coverageViewText('calc.js')).toContain('calc.js');
}, 240_000);
