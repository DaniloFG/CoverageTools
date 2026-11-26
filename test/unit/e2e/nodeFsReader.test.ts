import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, expect, test, vi } from 'vitest';
import { nodeFsReader } from '../../e2e/helpers';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readdir: vi.fn(actual.readdir) };
});

const root = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'ct-find-')));
afterAll(() => rmSync(root, { recursive: true, force: true }));

test('find prunes excluded directories instead of walking them', async () => {
  for (const rel of ['src/a.test.js', 'node_modules/lib/b.test.js', 'src/node_modules/c/d.test.js', 'src/keep/e.test.js']) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), '');
  }
  const found = await nodeFsReader().find(root, ['**/*.test.js'], ['**/node_modules/**']);
  expect(found).toEqual([path.join(root, 'src', 'a.test.js'), path.join(root, 'src', 'keep', 'e.test.js')]);
  const walked = vi.mocked(fsp.readdir).mock.calls.map(([dir]) => path.relative(root, String(dir)).split(path.sep).join('/'));
  expect(walked.sort()).toEqual(['', 'src', 'src/keep']);
});
