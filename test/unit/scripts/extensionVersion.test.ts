import { expect, test } from 'vitest';
import { nextExtensionVersion } from '../../../scripts/extension-version.mjs';

test.each([
  ['0.1.0', [], '0.1.0'], // no tag: the file version wins
  ['0.2.0', ['v0.1.3'], '0.2.0'], // file above the last tag: manual bump
  ['0.1.0', ['v0.1.0'], '0.1.1'], // equal: next patch
  ['0.1.0', ['v0.1.9', 'v0.1.10'], '0.1.11'], // numeric comparison, not text
  ['0.1.0', ['v0.1.2', 'nightly', 'v1'], '0.1.3'], // tags outside the format are ignored
])('nextExtensionVersion(%s, %j) is %s', (file, tags, expected) => {
  expect(nextExtensionVersion(file, tags)).toBe(expected);
});

test('the tags argument is optional', () => {
  expect(nextExtensionVersion('1.2.3')).toBe('1.2.3');
});

test('an invalid file version throws', () => {
  expect(() => nextExtensionVersion('1.0')).toThrow();
});
