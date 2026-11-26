import { expect, test } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isPatch, releaseNotes } from '../../../scripts/release-notes.mjs';

const HEADER = '# Changelog\n\nIntro text.\n\n';

const unreleased = (done: string) =>
  '## [Unreleased]\n\n### Planned\n\n- Planned thing.\n\n### In progress\n\n- Ongoing thing.\n\n' +
  `### Done\n\n${done}`;

const released =
  '## [0.1.0] - 2026-12-01\n\n### Added\n\n- First feature.\n- Second feature.\n\n### Fixed\n\n- A bug.\n\n';

const older = '## [0.0.9] - 2026-11-01\n\n### Added\n\n- Old feature.\n';

test('uses the section of the version when the changelog has one', () => {
  const changelog = HEADER + unreleased('- Done thing.\n\n') + released + older;
  expect(releaseNotes(changelog, '0.1.0', false)).toBe(
    '### Added\n\n- First feature.\n- Second feature.\n\n### Fixed\n\n- A bug.',
  );
});

test('the version section runs to the end of the file when it is the last one', () => {
  expect(releaseNotes(HEADER + older, '0.0.9', false)).toBe('### Added\n\n- Old feature.');
});

test('otherwise uses the Done list under Unreleased', () => {
  const changelog = HEADER + unreleased('- Done thing.\n- Another done thing.\n\n') + released;
  expect(releaseNotes(changelog, '0.1.1', false)).toBe('- Done thing.\n- Another done thing.');
});

test('the Done list ends at the next subsection under Unreleased', () => {
  const changelog = HEADER + '## [Unreleased]\n\n### Done\n\n- Done thing.\n\n### Planned\n\n- Later.\n';
  expect(releaseNotes(changelog, '0.1.1', false)).toBe('- Done thing.');
});

test('with nothing to say: neutral mode returns "Maintenance release."; strict mode throws', () => {
  const empty = HEADER + unreleased('- Nothing yet.\n\n') + released;
  expect(releaseNotes(empty, '0.1.1', true)).toBe('Maintenance release.');
  expect(() => releaseNotes(empty, '0.1.1', false)).toThrow(/nothing/i);

  const noDone = HEADER + '## [Unreleased]\n\n### Planned\n\n- Later.\n\n' + released;
  expect(releaseNotes(noDone, '0.1.1', true)).toBe('Maintenance release.');
  expect(() => releaseNotes(noDone, '0.1.1', false)).toThrow();

  expect(releaseNotes(HEADER, '0.1.1', true)).toBe('Maintenance release.');
  expect(() => releaseNotes(HEADER, '0.1.1', false)).toThrow();
});

test('an empty section of the version is an error even in neutral mode', () => {
  const changelog = HEADER + '## [0.2.0] - 2026-12-10\n\n' + released;
  expect(() => releaseNotes(changelog, '0.2.0', true)).toThrow(/0\.2\.0/);
});

test('an invalid version throws', () => {
  expect(() => releaseNotes(HEADER + released, 'abc', true)).toThrow(/x\.y\.z/);
});

test('isPatch: only a last number other than 0 is a patch', () => {
  expect(isPatch('0.1.1')).toBe(true);
  expect(isPatch('2.3.10')).toBe(true);
  expect(isPatch('0.2.0')).toBe(false);
  expect(isPatch('1.0.0')).toBe(false);
  expect(isPatch('abc')).toBe(false);
});

/**
 * Runs the CLI. With `changelog`, on a file holding that text; without, on the repository's own
 * CHANGELOG.md, whose Unreleased list changes with every pull request (only 0.1.0 is stable there).
 */
function cli(version: string, mode: string, changelog?: string) {
  const dir = mkdtempSync(path.join(tmpdir(), 'release-notes-'));
  const out = path.join(dir, 'notes.md');
  const args = [path.resolve(__dirname, '../../../scripts/release-notes.mjs'), version, out, mode];
  if (changelog !== undefined) {
    writeFileSync(path.join(dir, 'CHANGELOG.md'), changelog);
    args.push(path.join(dir, 'CHANGELOG.md'));
  }
  const result = spawnSync('node', args, { encoding: 'utf8' });
  const body = result.status === 0 ? readFileSync(out, 'utf8') : '';
  rmSync(dir, { recursive: true, force: true });
  return { status: result.status, body, stderr: result.stderr };
}

/** A changelog with nothing waiting for a release. */
const NOTHING_DONE = HEADER + unreleased('- Nothing yet.\n\n') + released;

test('auto mode: a patch without a section gets a note, a minor/major without one fails', () => {
  expect(cli('9.9.1', 'auto', NOTHING_DONE)).toMatchObject({ status: 0, body: 'Maintenance release.\n' });
  expect(cli('9.9.0', 'auto', NOTHING_DONE).status).toBe(1);
  expect(cli('9.0.0', 'auto', NOTHING_DONE).stderr).toMatch(/nothing to say/i);
  expect(cli('9.9.1', 'bogus', NOTHING_DONE).status).toBe(1);
});

test('auto mode: a version without a section ships the Done list when there is one, patch or not', () => {
  const changelog = HEADER + unreleased('- Done thing.\n\n') + released;
  expect(cli('9.9.1', 'auto', changelog)).toMatchObject({ status: 0, body: '- Done thing.\n' });
  expect(cli('9.9.0', 'auto', changelog)).toMatchObject({ status: 0, body: '- Done thing.\n' });
});

test('without a changelog file the CLI reads the repository\'s CHANGELOG.md', () => {
  const result = cli('0.1.0', 'auto');
  expect(result.status).toBe(0);
  expect(result.body).toMatch(/^### Added/);
});
