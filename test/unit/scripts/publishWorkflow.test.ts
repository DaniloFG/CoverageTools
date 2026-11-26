import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { parse } from 'yaml';

const ROOT = path.resolve(__dirname, '../../..');
const WORKFLOW = path.join(ROOT, '.github/workflows/publish-extension.yml');

interface Step {
  name?: string;
  id?: string;
  uses?: string;
  run?: string;
  if?: string;
  'continue-on-error'?: boolean;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
}

interface Job {
  'runs-on': string;
  permissions?: Record<string, string>;
  steps: Step[];
}

interface Workflow {
  name: string;
  on: {
    push: { branches: string[]; paths: string[]; tags: string[] };
    workflow_dispatch: { inputs: Record<string, { description: string; required: boolean }> };
  };
  permissions: Record<string, string>;
  concurrency: { group: string; 'cancel-in-progress': boolean };
  jobs: Record<string, Job>;
}

const text = readFileSync(WORKFLOW, 'utf8');
// YAML 1.2 (the `yaml` package's default) keeps the bare key `on` a string, as GitHub reads it.
const workflow = parse(text) as Workflow;
const steps = workflow.jobs.publish.steps;

function stepNamed(fragment: string): Step {
  const step = steps.find((s) => s.name?.toLowerCase().includes(fragment.toLowerCase()));
  if (!step) throw new Error(`no step named like "${fragment}"`);
  return step;
}

test('triggers on push to main, on v* tags and manually with a version input', () => {
  expect(workflow.on.push.branches).toEqual(['main']);
  expect(workflow.on.push.tags).toEqual(['v*']);
  expect(workflow.on.push.paths).toEqual([
    'src/**',
    'scripts/**',
    'package.json',
    'package-lock.json',
    'esbuild.mjs',
    'tsconfig.json',
    '.vscodeignore',
    'README.md',
    'CHANGELOG.md',
    'docs/images/**',
    'media/**',
  ]);
  expect(Object.keys(workflow.on.workflow_dispatch.inputs)).toEqual(['version']);
  expect(workflow.on.workflow_dispatch.inputs.version.required).toBe(false);
  expect(Object.keys(workflow.on).sort()).toEqual(['push', 'workflow_dispatch']);
});

test('top-level permissions are read-only and only the publish job can write contents', () => {
  expect(workflow.permissions).toEqual({ contents: 'read' });
  expect(Object.keys(workflow.jobs)).toEqual(['publish']);
  expect(workflow.jobs.publish.permissions).toEqual({ contents: 'write' });
});

test('one publication at a time, never cancelled', () => {
  expect(workflow.concurrency).toEqual({ group: 'publish-extension', 'cancel-in-progress': false });
});

test('the steps follow the GitTools order', () => {
  const summary = steps.map((s) => s.uses ?? s.run?.trim().split('\n')[0] ?? s.name);
  expect(summary.slice(0, 7)).toEqual([
    'actions/checkout@v4',
    'actions/setup-node@v4',
    'npm ci',
    'npm run lint',
    'npm run build',
    'npm run check:size',
    'npm test',
  ]);
  expect(steps[0].with).toEqual({ 'fetch-depth': 0 });
  expect(steps[1].with).toEqual({ 'node-version': 22, cache: 'npm' });

  const order = [
    stepNamed('version'),
    stepNamed('release notes'),
    steps.find((s) => s.run?.trim() === 'npm run package'),
    stepNamed('Marketplace'),
    stepNamed('Open VSX'),
    steps.find((s) => s.uses === 'softprops/action-gh-release@v2'),
    steps.find((s) => s.uses === 'actions/upload-artifact@v4'),
  ];
  const indexes = order.map((s) => (s ? steps.indexOf(s) : -1));
  expect(indexes).toEqual([7, 8, 9, 10, 11, 12, 13]);
  expect(steps).toHaveLength(14);
  expect(steps[9].env).toEqual({ NODE_ENV: 'production' });
});

test('no ${{ … }} expression appears inside a run: block', () => {
  const runs = steps.filter((s) => s.run !== undefined);
  expect(runs.length).toBeGreaterThan(5);
  for (const step of runs) expect(step.run).not.toContain('${{');
});

test('event inputs and secrets reach the shell only through env:', () => {
  const lines = text.split('\n').filter((line) => /\$\{\{[^}]*(github\.event|github\.ref|secrets\.)/.test(line));
  expect(lines.length).toBeGreaterThan(0);
  for (const line of lines) {
    // Either an env entry (NAME: ${{ … }}) or an action input under `with:` / an `if:` condition.
    expect(line).toMatch(/^\s+([A-Z_]+|tag_name|if): /);
  }
  expect(stepNamed('version').env).toMatchObject({
    INPUT_VERSION: '${{ github.event.inputs.version }}',
    REF_TYPE: '${{ github.ref_type }}',
    REF_NAME: '${{ github.ref_name }}',
  });
  expect(stepNamed('Marketplace').env).toMatchObject({ VSCE_PAT: '${{ secrets.VSCE_PAT }}' });
  expect(stepNamed('Open VSX').env).toMatchObject({ OVSX_PAT: '${{ secrets.OVSX_PAT }}' });
});

test('release notes come from the changelog; a patch may be neutral, a minor or major may not (auto mode)', () => {
  const notes = stepNamed('release notes');
  expect(notes.env).toEqual({ VERSION: '${{ steps.version.outputs.version }}' });
  expect(notes.run).toContain('node scripts/release-notes.mjs "$VERSION" "$RUNNER_TEMP/release-notes.md" auto');
});

test('an Open VSX failure only warns and never stops the release', () => {
  const ovsx = stepNamed('Open VSX');
  expect(ovsx['continue-on-error']).toBe(true);
  expect(ovsx.run).toContain('::warning::');
  expect(ovsx.run).not.toMatch(/exit "\$CODE"/);
  const release = steps.find((s) => s.uses === 'softprops/action-gh-release@v2');
  expect(release?.if).not.toMatch(/ovsx|open/i);
});

test('the Marketplace and Open VSX steps publish release/coverage-tools-<version>.vsix', () => {
  const marketplace = stepNamed('Marketplace');
  expect(marketplace.id).toBe('marketplace');
  expect(marketplace.run).toContain(
    'npx --no-install vsce publish --no-yarn --packagePath release/coverage-tools-"$VERSION".vsix',
  );
  for (const output of ['published=true', 'published=false', 'configured=true', 'configured=false']) {
    expect(marketplace.run).toContain(`echo "${output}" >> "$GITHUB_OUTPUT"`);
  }
  expect(marketplace.run).toMatch(/already exists/);
  expect(stepNamed('Open VSX').run).toContain('npx --no-install ovsx publish release/coverage-tools-"$VERSION".vsix -p "$OVSX_PAT"');
});

test('vsce and ovsx are pinned devDependencies, run without fetching anything', () => {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { devDependencies: Record<string, string> };
  expect(Object.keys(pkg.devDependencies)).toEqual(expect.arrayContaining(['@vscode/vsce', 'ovsx']));
  const npx = text.split('\n').filter((line) => /\bnpx\b/.test(line));
  expect(npx.length).toBe(2);
  for (const line of npx) expect(line).toMatch(/npx --no-install (vsce|ovsx) /);
});

test('the release step runs on a tag push, after a Marketplace publish, or when VSCE_PAT is absent', () => {
  const release = steps.find((s) => s.uses === 'softprops/action-gh-release@v2');
  const condition = release?.if?.replace(/\s+/g, ' ').trim();
  expect(condition).toBe(
    "(github.event_name == 'push' && github.ref_type == 'tag') || steps.marketplace.outputs.published == 'true' || steps.marketplace.outputs.configured == 'false'",
  );
  // Only a tag push uses the pushed tag; a manual run (even started from a tag) releases v<its version>.
  expect(release?.with).toEqual({
    tag_name: "${{ github.event_name == 'push' && github.ref_type == 'tag' && github.ref_name || format('v{0}', steps.version.outputs.version) }}",
    target_commitish: '${{ github.sha }}',
    files: 'release/*.vsix',
    generate_release_notes: false,
    body_path: '${{ runner.temp }}/release-notes.md',
  });
});

test('the .vsix is kept as the coverage-tools-vsix artifact', () => {
  const upload = steps.find((s) => s.uses === 'actions/upload-artifact@v4');
  expect(upload?.with).toEqual({ name: 'coverage-tools-vsix', path: 'release/*.vsix' });
});

// The publish job runs on ubuntu-latest, so its bash script is only run where a POSIX shell and tools are.
describe.skipIf(process.platform === 'win32')('the version step, run in a scratch git repository', () => {
  let repo: string;

  beforeAll(() => {
    repo = mkdtempSync(path.join(tmpdir(), 'publish-version-'));
    mkdirSync(path.join(repo, 'scripts'));
    copyFileSync(path.join(ROOT, 'scripts/extension-version.mjs'), path.join(repo, 'scripts/extension-version.mjs'));
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: repo });
    git('init', '-q');
    writeFileSync(path.join(repo, 'package.json'), '{ "name": "x", "version": "0.1.0" }\n');
    git('add', '.');
    git('commit', '-q', '-m', 'init');
    git('tag', 'v0.1.0');
  });

  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  function runVersionStep(env: { INPUT_VERSION: string; REF_TYPE: string; REF_NAME: string }) {
    writeFileSync(path.join(repo, 'package.json'), '{ "name": "x", "version": "0.1.0" }\n');
    const output = path.join(repo, 'github-output');
    writeFileSync(output, '');
    // GitHub runs `run:` blocks with `bash --noprofile --norc -eo pipefail`.
    const result = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', stepNamed('version').run ?? ''], {
      cwd: repo,
      encoding: 'utf8',
      env: { PATH: process.env.PATH, HOME: process.env.HOME, GITHUB_OUTPUT: output, ...env },
    });
    const pkg = JSON.parse(readFileSync(path.join(repo, 'package.json'), 'utf8')) as { version: string };
    return { status: result.status, stdout: result.stdout, output: readFileSync(output, 'utf8'), version: pkg.version };
  }

  test('empty input on a branch push: the automatic version (next patch of the last tag)', () => {
    const r = runVersionStep({ INPUT_VERSION: '', REF_TYPE: 'branch', REF_NAME: 'main' });
    expect(r).toMatchObject({ status: 0, output: 'version=0.1.1\n', version: '0.1.1' });
  });

  test('a manual input wins', () => {
    const r = runVersionStep({ INPUT_VERSION: '0.3.0', REF_TYPE: 'branch', REF_NAME: 'main' });
    expect(r).toMatchObject({ status: 0, output: 'version=0.3.0\n', version: '0.3.0' });
  });

  test('a tag push uses the tag without the v', () => {
    const r = runVersionStep({ INPUT_VERSION: '', REF_TYPE: 'tag', REF_NAME: 'v0.5.1' });
    expect(r).toMatchObject({ status: 0, output: 'version=0.5.1\n', version: '0.5.1' });
  });

  test.each(['abc', '0.3.0\n0.4.0', '0.3.0; touch pwned', '1.0'])('rejects %j', (input) => {
    const r = runVersionStep({ INPUT_VERSION: input, REF_TYPE: 'branch', REF_NAME: 'main' });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('::error::');
    expect(r).toMatchObject({ output: '', version: '0.1.0' });
  });
});
