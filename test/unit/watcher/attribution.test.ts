import nodePath from 'node:path';
import { expect, test } from 'vitest';
import type { Project } from '../../../src/adapters/types';
import { isWithin, ownerOf, resultsRootOf, unownedKey } from '../../../src/watcher/attribution';

function p(dir: string): Project {
  return { key: `project:${dir}`, adapter: 'custom', ecosystem: 'custom', dir, name: nodePath.basename(dir), supportsPartial: false, meta: {} };
}

test('a report belongs to the nearest project above it', () => {
  expect(ownerOf('/w/api/Tests/TestResults/g1/coverage.cobertura.xml', [p('/w/api/Tests'), p('/w/api')])!.dir).toBe('/w/api/Tests');
  expect(ownerOf('/w/api/coverage/lcov.info', [p('/w/api/Tests'), p('/w/api')])!.dir).toBe('/w/api');
});

test('a report with no project above has no owner', () => {
  expect(ownerOf('/w/web/coverage/lcov.info', [p('/w/api')])).toBeUndefined();
  expect(ownerOf('/w/api2/coverage/lcov.info', [p('/w/api')])).toBeUndefined();
  expect(ownerOf('/w/coverage/lcov.info', [])).toBeUndefined();
});

test('Windows paths are attributed case-insensitively', () => {
  const win = nodePath.win32;
  const projects = [p('C:\\Work\\Api'), p('C:\\Work\\Api\\Tests')];
  expect(ownerOf('c:\\work\\api\\tests\\TestResults\\g\\coverage.cobertura.xml', projects, win)!.dir).toBe('C:\\Work\\Api\\Tests');
  expect(ownerOf('C:/Work/API/coverage/lcov.info', projects, win)!.dir).toBe('C:\\Work\\Api');
  expect(ownerOf('C:\\Work\\Api2\\coverage\\lcov.info', projects, win)).toBeUndefined();
  // POSIX paths stay case-sensitive.
  expect(ownerOf('/w/API/coverage/lcov.info', [p('/w/api')])).toBeUndefined();
});

test('isWithin accepts the directory itself and its descendants only', () => {
  expect(isWithin('/w', '/w')).toBe(true);
  expect(isWithin('/w/', '/w/a/b')).toBe(true);
  expect(isWithin('/w', '/wx/a')).toBe(false);
  expect(isWithin('/', '/w/a')).toBe(true);
  expect(isWithin('C:\\', 'c:\\w', nodePath.win32)).toBe(true);
  expect(isWithin('C:\\W', 'D:\\W\\a', nodePath.win32)).toBe(false);
});

test('resultsRootOf strips the GUID folder under TestResults, otherwise uses the report directory', () => {
  expect(resultsRootOf('/w/TestResults/3f2a9c1e-0b7d-4c55-9a1e-2f3b4c5d6e7f/coverage.cobertura.xml')).toBe('/w/TestResults');
  expect(resultsRootOf('/w/TestResults/coverage.cobertura.xml')).toBe('/w/TestResults');
  expect(resultsRootOf('/w/coverage/lcov.info')).toBe('/w/coverage');
  expect(resultsRootOf('C:\\w\\testresults\\g\\coverage.cobertura.xml', nodePath.win32)).toBe('C:\\w\\testresults');
});

test('unownedKey combines results root and signature', () => {
  expect(unownedKey('/w/TestResults/g/coverage.cobertura.xml', 'A|B')).toBe('unowned:/w/TestResults#A|B');
  expect(unownedKey('/w/coverage/lcov.info', '')).toBe('unowned:/w/coverage#');
});
