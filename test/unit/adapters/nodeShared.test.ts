import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { localBin, NODE_TEST_FILE, packageManagerOf, scriptCommand, scriptTailCalls, selectedTestFiles, workspaceFolderOf } from '../../../src/adapters/nodeShared';
import type { Project } from '../../../src/adapters/types';
import { DEFAULT_SETTINGS } from '../../../src/settings';
import { memoryFs } from './memoryFs';

const JEST = /^(?:jest|react-scripts test)(?:\s|$)/;
const JEST_WATCH = /\s--watch(?:All)?(?:=true)?(?:\s|$)/;

describe('scriptTailCalls', () => {
  test.each([
    [{ test: 'jest' }, 'test'],
    [{ test: 'cross-env CI=1 jest --ci' }, 'test'],
    [{ test: 'react-scripts test' }, 'test'],
    [{ test: 'jest && eslint .' }, undefined],
    [{ test: 'eslint . ; jest' }, undefined],
    [{ test: 'echo "Error: no test specified" && exit 1' }, undefined],
    [{}, undefined],
    // env-var prefixes stay in the script, which is run as is
    [{ test: 'FOO=1 jest' }, 'test'],
    [{ test: 'FOO=1 BAR="a b" jest' }, 'test'],
    [{ test: 'env FOO=1 jest' }, 'test'],
    [{ test: 'cross-env FOO=1 BAR=2 jest' }, 'test'],
    // wrappers
    [{ test: 'npx jest' }, 'test'],
    [{ test: 'npx --no-install jest --ci' }, 'test'],
    [{ test: 'yarn jest' }, 'test'],
    [{ test: 'yarn exec jest' }, 'test'],
    [{ test: 'pnpm exec jest' }, 'test'],
    [{ test: 'npm exec -- jest' }, 'test'],
    // path-qualified binaries
    [{ test: 'node_modules/.bin/jest' }, 'test'],
    [{ test: './node_modules/.bin/jest --watchAll=false' }, 'test'],
    [{ test: 'node --experimental-vm-modules node_modules/jest/bin/jest.js' }, 'test'],
    [{ test: 'node -r ts-node/register --experimental-vm-modules ./node_modules/jest/bin/jest.js --ci' }, 'test'],
    // trailing arguments
    [{ test: 'jest --ci --runInBand src' }, 'test'],
    // yarn and pnpm forward appended arguments, so the outer script is run with its env and arguments
    [{ test: 'yarn test:unit', 'test:unit': 'jest' }, 'test'],
    [{ test: 'TZ=UTC NODE_ENV=test yarn test:unit', 'test:unit': 'jest' }, 'test'],
    [{ test: 'yarn run test:unit --ci', 'test:unit': 'FOO=1 jest' }, 'test'],
    [{ test: 'pnpm test:unit', 'test:unit': 'jest' }, 'test'],
    [{ test: 'pnpm run test:unit', 'test:unit': 'jest' }, 'test'],
    // `npm run x -- <args>` forwards them too
    [{ test: 'npm run test:unit -- --ci', 'test:unit': 'jest' }, 'test'],
    // a bare `npm run x` would take appended options for itself: the target script is run
    [{ test: 'npm run test:unit', 'test:unit': 'jest' }, 'test:unit'],
    [{ test: 'npm run-script unit', unit: 'npx jest' }, 'unit'],
    [{ test: 'npm run --silent unit', unit: 'jest' }, 'unit'],
    // words after a bare `npm run x` would be lost: unusable
    [{ test: 'npm run unit src', unit: 'jest' }, undefined],
    // only one level, and the target must be a single command too
    [{ test: 'npm run a', a: 'npm run b', b: 'jest' }, undefined],
    [{ test: 'npm run a', a: 'jest && eslint .' }, undefined],
    [{ test: 'npm run missing' }, undefined],
    [{ test: 'yarn test' }, undefined],
    // chaining operators inside quotes do not count
    [{ test: 'jest --testNamePattern "a && b"' }, 'test'],
    [{ test: 'jest --testNamePattern "a & b > c"' }, 'test'],
    [{ test: 'jest | tee out.txt' }, undefined],
    [{ test: 'jest || true' }, undefined],
    // background jobs and redirections are not a plain tool call
    [{ test: 'jest & eslint .' }, undefined],
    [{ test: 'jest > out.txt' }, undefined],
    [{ test: 'jest 2>&1' }, undefined],
    [{ test: 'jest < input.txt' }, undefined],
    // watch flags make the script unusable, also when forwarded by the outer line
    [{ test: 'jest --watchAll' }, undefined],
    [{ test: 'jest --watch' }, undefined],
    [{ test: 'jest --watch=true' }, undefined],
    [{ test: 'yarn unit --watch', unit: 'jest' }, undefined],
    [{ test: 'npm run unit', unit: 'jest --watchAll' }, undefined],
    // other tools
    [{ test: 'vitest' }, undefined],
    [{ test: 'jest-runner-foo' }, undefined],
    [{ test: 'react-scripts start' }, undefined],
    [{ test: 'node' }, undefined],
  ])('scriptTailCalls(%j) runs %s', (scripts, expected) => {
    expect(scriptTailCalls({ scripts }, JEST, JEST_WATCH)?.script).toBe(expected);
  });

  test.each([
    [{ test: 'jest' }, {}],
    [{ test: 'FOO=1 jest' }, {}],
    [{ test: 'TZ=UTC yarn unit', unit: 'jest' }, {}],
    [{ test: 'TZ=UTC NODE_ENV=test npm run unit', unit: 'jest' }, { TZ: 'UTC', NODE_ENV: 'test' }],
    [{ test: 'cross-env TZ=UTC BAR="a b" npm run unit', unit: 'jest' }, { TZ: 'UTC', BAR: 'a b' }],
    [{ test: 'env A=x=y npm run unit', unit: 'jest' }, { A: 'x=y' }],
  ])('scriptTailCalls(%j) carries env %j', (scripts, env) => {
    expect(scriptTailCalls({ scripts }, JEST, JEST_WATCH)?.env).toEqual(env);
  });
});

test('package manager comes from the nearest lockfile at or above the project, default npm', async () => {
  const root = path.resolve('/w');
  const fs = memoryFs({
    [path.join(root, 'yarn.lock')]: '',
    [path.join(root, 'apps', 'p', 'package.json')]: '{}',
    [path.join(root, 'apps', 'q', 'pnpm-lock.yaml')]: '',
    [path.join(root, 'apps', 'r', 'package-lock.json')]: '',
  });
  expect(await packageManagerOf(path.join(root, 'apps', 'p'), fs)).toBe('yarn');
  expect(await packageManagerOf(path.join(root, 'apps', 'q'), fs)).toBe('pnpm');
  expect(await packageManagerOf(path.join(root, 'apps', 'r'), fs)).toBe('npm');
  expect(await packageManagerOf(root, fs)).toBe('yarn');
  expect(await packageManagerOf(path.resolve('/elsewhere/x'), fs)).toBe('npm');
});

test('the lockfile search stops at the given workspace folder', async () => {
  const root = path.resolve('/w');
  const fs = memoryFs({ [path.join(root, 'yarn.lock')]: '', [path.join(root, 'inner', 'p', 'package.json')]: '{}' });
  expect(await packageManagerOf(path.join(root, 'inner', 'p'), fs, path.join(root, 'inner'))).toBe('npm');
  expect(await packageManagerOf(path.join(root, 'inner', 'p'), fs, root)).toBe('yarn');
});

test('npm puts script arguments after "--"; yarn and pnpm do not', () => {
  expect(scriptCommand('npm', 'test', ['--coverage'])).toEqual({ command: 'npm', args: ['run', 'test', '--', '--coverage'] });
  expect(scriptCommand('yarn', 'test', ['--coverage'])).toEqual({ command: 'yarn', args: ['run', 'test', '--coverage'] });
  expect(scriptCommand('pnpm', 'test', ['--coverage'])).toEqual({ command: 'pnpm', args: ['run', 'test', '--coverage'] });
  expect(scriptCommand('npm', 'test', [])).toEqual({ command: 'npm', args: ['run', 'test'] });
});

test('localBin uses "yarn jest", "pnpm exec jest" and "npx --no-install jest"', () => {
  expect(localBin('yarn', 'jest', ['--ci'])).toEqual({ command: 'yarn', args: ['jest', '--ci'] });
  expect(localBin('pnpm', 'jest', ['--ci'])).toEqual({ command: 'pnpm', args: ['exec', 'jest', '--ci'] });
  expect(localBin('npm', 'jest', ['--ci'])).toEqual({ command: 'npx', args: ['--no-install', 'jest', '--ci'] });
});

test.each([
  ['src/a.test.js', true], ['src/a.spec.ts', true], ['test.js', true], ['src/a.test.tsx', true],
  ['src/a.test.mjs', true], ['src/a.test.cjs', true], ['src/a.test.mts', true], ['src/a.test.cts', true],
  ['src/__tests__/a.js', true], ['__tests__/deep/b.ts', true], ['C:\\p\\src\\a.test.js', true],
  ['src/a.js', false], ['src/latest.js', false], ['src/a.test.json', false], ['src/__tests__', false],
])('NODE_TEST_FILE matches %s: %s', (p, expected) => {
  expect(NODE_TEST_FILE.test(p)).toBe(expected);
});

function nodeProject(dir: string, meta: Record<string, unknown> = {}): Project {
  return { key: `project:${dir}`, adapter: 'jest', ecosystem: 'node', dir, name: 'p', supportsPartial: true, meta };
}

test('workspaceFolderOf reads project.meta.workspaceFolder when it is a string', () => {
  expect(workspaceFolderOf(nodeProject('/w/p', { workspaceFolder: '/w' }))).toBe('/w');
  expect(workspaceFolderOf(nodeProject('/w/p'))).toBeUndefined();
  expect(workspaceFolderOf(nodeProject('/w/p', { workspaceFolder: 3 }))).toBeUndefined();
});

test('selectedTestFiles keeps test files, expands directories to their test files and skips excluded ones', async () => {
  const dir = path.resolve('/w/p');
  const f = (rel: string): string => path.join(dir, ...rel.split('/'));
  const fs = memoryFs({
    [f('src/a.test.js')]: '', [f('src/a.js')]: '', [f('src/deep/b.test.ts')]: '', [f('src/deep/c.spec.js')]: '',
    [f('src/deep/node_modules/x/d.test.js')]: '', [f('app/[slug]/page.test.tsx')]: '', [f('empty/readme.md')]: '',
  });
  const isTest = (p: string): boolean => NODE_TEST_FILE.test(p);
  const select = (paths: string[]): Promise<string[]> => selectedTestFiles(dir, paths, fs, DEFAULT_SETTINGS.exclude, isTest);
  expect(await select([f('src/a.test.js')])).toEqual([f('src/a.test.js')]);
  expect(await select([f('app/[slug]/page.test.tsx')])).toEqual([f('app/[slug]/page.test.tsx')]);
  expect(await select([f('src/deep')])).toEqual([f('src/deep/b.test.ts'), f('src/deep/c.spec.js')]);
  expect(await select([f('src/deep'), f('src/deep/b.test.ts'), f('src/a.test.js')])).toEqual([
    f('src/a.test.js'), f('src/deep/b.test.ts'), f('src/deep/c.spec.js'),
  ]);
  expect(await select([f('empty')])).toEqual([]);
  expect(await select([f('src/a.js')])).toEqual([]);
});
