import { expect, test } from 'vitest';
import { releaseNotes } from '../../../scripts/release-notes.mjs';

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
