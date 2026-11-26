import { expect, test } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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

// The CLI reads the repository's CHANGELOG.md: 0.1.0 has a section, 9.9.0 and 9.9.1 have none.
function cli(version: string, mode: string) {
  const dir = mkdtempSync(path.join(tmpdir(), 'release-notes-'));
  const out = path.join(dir, 'notes.md');
  const result = spawnSync('node', [path.resolve(__dirname, '../../../scripts/release-notes.mjs'), version, out, mode], { encoding: 'utf8' });
  const body = result.status === 0 ? readFileSync(out, 'utf8') : '';
  rmSync(dir, { recursive: true, force: true });
  return { status: result.status, body, stderr: result.stderr };
}

test('auto mode: a patch without a section gets a note, a minor/major without one fails', () => {
  expect(cli('9.9.1', 'auto')).toMatchObject({ status: 0 });
  expect(cli('9.9.1', 'auto').body).toMatch(/\S/);
  expect(cli('9.9.0', 'auto').status).toBe(1);
  expect(cli('9.0.0', 'auto').stderr).toMatch(/nothing to say/i);
  expect(cli('0.1.0', 'auto').status).toBe(0);
  expect(cli('9.9.1', 'bogus').status).toBe(1);
});
