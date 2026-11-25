import { expect, test } from 'vitest';
import { expandBraces, globToRegExp, matchesAny, oneGlob } from '../../src/glob';

const m = (glob: string, path: string): boolean => globToRegExp(glob).test(path);

test('** matches any number of directories, including none', () => {
  expect(m('**/coverage/lcov.info', 'coverage/lcov.info')).toBe(true);
  expect(m('**/coverage/lcov.info', 'a/b/coverage/lcov.info')).toBe(true);
  expect(m('**/coverage/lcov.info', '/w/a/coverage/lcov.info')).toBe(true);
  expect(m('**/coverage/lcov.info', 'a/mycoverage/lcov.info')).toBe(false);
  expect(m('**/TestResults/**/*.cobertura.xml', 'api/TestResults/3f2a/coverage.cobertura.xml')).toBe(true);
  expect(m('**/TestResults/**/*.cobertura.xml', 'TestResults/coverage.cobertura.xml')).toBe(true);
});

test('a trailing /** matches everything below the directory', () => {
  expect(m('**/node_modules/**', 'node_modules/pkg/coverage/lcov.info')).toBe(true);
  expect(m('**/node_modules/**', 'web/node_modules/x')).toBe(true);
  expect(m('**/node_modules/**', 'web/node_modules')).toBe(true);
  expect(m('**/node_modules/**', 'web/node_modules2/x')).toBe(false);
  expect(m('**', 'any/thing')).toBe(true);
});

test('* and ? stay within one path segment', () => {
  expect(m('src/*.ts', 'src/a.ts')).toBe(true);
  expect(m('src/*.ts', 'src/sub/a.ts')).toBe(false);
  expect(m('a?.js', 'ab.js')).toBe(true);
  expect(m('a?.js', 'a/.js')).toBe(false);
  expect(m('a?.js', 'abc.js')).toBe(false);
});

test('{a,b} matches either alternative, which may contain wildcards', () => {
  expect(m('**/coverage.{xml,lcov}', 'x/coverage.xml')).toBe(true);
  expect(m('**/coverage.{xml,lcov}', 'x/coverage.lcov')).toBe(true);
  expect(m('**/coverage.{xml,lcov}', 'x/coverage.json')).toBe(false);
  expect(m('{bin,obj/*}/x', 'obj/Debug/x')).toBe(true);
  expect(m('{bin,obj/*}/x', 'bin/x')).toBe(true);
});

test('regular expression characters are literal', () => {
  expect(m('a.b+(c)', 'a.b+(c)')).toBe(true);
  expect(m('a.b', 'axb')).toBe(false);
  expect(m('{a', '{a')).toBe(true);
});

test('matchesAny compares with forward slashes', () => {
  const excludes = ['**/bin/**', '**/obj/**'];
  expect(matchesAny('api\\bin\\Debug\\coverage.cobertura.xml', excludes)).toBe(true);
  expect(matchesAny('api/obj/x', excludes)).toBe(true);
  expect(matchesAny('api/TestResults/g/coverage.cobertura.xml', excludes)).toBe(false);
  expect(matchesAny('api/bin/x', [])).toBe(false);
});

test('expandBraces flattens nested brace groups into plain alternatives', () => {
  expect(expandBraces('**/*.csproj')).toEqual(['**/*.csproj']);
  expect(expandBraces('**/*.{js,ts}')).toEqual(['**/*.js', '**/*.ts']);
  expect(expandBraces('{a,b/*.{x,y}}/c')).toEqual(['a/c', 'b/*.x/c', 'b/*.y/c']);
  expect(expandBraces('{a,b}{1,2}')).toEqual(['a1', 'a2', 'b1', 'b2']);
  expect(expandBraces('unclosed{a,b')).toEqual(['unclosed{a,b']);
});

test('oneGlob joins globs into one brace group without nesting, for VS Code', () => {
  expect(oneGlob(['**/*.csproj'])).toBe('**/*.csproj');
  expect(oneGlob(['**/*.csproj', '**/*.{js,ts}', '**/*.csproj'])).toBe('{**/*.csproj,**/*.js,**/*.ts}');
  expect(oneGlob([])).toBeUndefined();
});
