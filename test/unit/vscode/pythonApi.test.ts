import { expect, test } from 'vitest';
import { PYTHON_EXTENSION_ID, pythonExtensionSelection, type ExtensionsLike } from '../../../src/vscode/pythonApi';

const RESOURCE = { fsPath: '/work/proj/.coverage' };

function extensions(ext: { isActive: boolean; exports: unknown } | undefined, onGet?: (id: string) => void): ExtensionsLike {
  return {
    getExtension(id) {
      onGet?.(id);
      return id === PYTHON_EXTENSION_ID ? ext : undefined;
    },
  };
}

const api = (getActiveEnvironmentPath: unknown) => ({ environments: { getActiveEnvironmentPath } });

test('the active environment path of an installed, active Python extension is the selection', () => {
  const asked: unknown[] = [];
  const exports = api((resource: unknown) => {
    asked.push(resource);
    return { id: 'x', path: '/envs/a/bin/python' };
  });
  expect(pythonExtensionSelection(extensions({ isActive: true, exports }), RESOURCE)).toBe('/envs/a/bin/python');
  expect(asked).toEqual([RESOURCE]);
});

test('no extension or an inactive one gives no selection, and the API is not touched', () => {
  let called = false;
  const exports = api(() => {
    called = true;
    return { path: '/envs/a/bin/python' };
  });
  expect(pythonExtensionSelection(extensions(undefined), RESOURCE)).toBeUndefined();
  expect(pythonExtensionSelection(extensions({ isActive: false, exports }), RESOURCE)).toBeUndefined();
  expect(called).toBe(false);
});

test.each([
  ['undefined exports', undefined],
  ['null exports', null],
  ['a string export', 'api'],
  ['no environments', {}],
  ['environments is not an object', { environments: 3 }],
  ['no getActiveEnvironmentPath', { environments: {} }],
  ['getActiveEnvironmentPath is not a function', api('nope')],
  ['it returns undefined', api(() => undefined)],
  ['it returns a string', api(() => '/envs/a/bin/python')],
  ['it returns no path', api(() => ({ id: 'x' }))],
  ['it returns a non-string path', api(() => ({ path: 42 }))],
  ['it returns an empty path', api(() => ({ path: '' }))],
  ['it returns a promise', api(() => Promise.resolve({ path: '/envs/a/bin/python' }))],
  ['it throws', api(() => { throw new Error('boom'); })],
  ['environments is a throwing getter', Object.defineProperty({}, 'environments', { get() { throw new Error('boom'); } })],
])('%s: no selection', (_name, exports) => {
  expect(pythonExtensionSelection(extensions({ isActive: true, exports }), RESOURCE)).toBeUndefined();
});

test('a throwing getExtension gives no selection', () => {
  expect(pythonExtensionSelection({ getExtension() { throw new Error('boom'); } }, RESOURCE)).toBeUndefined();
});
