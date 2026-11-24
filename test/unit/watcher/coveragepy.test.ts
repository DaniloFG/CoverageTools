import path from 'node:path';
import { expect, test } from 'vitest';
import { conversionSpec } from '../../../src/watcher/coveragepy';

test('conversionSpec runs "<python> -m coverage xml --data-file=<file> -o <out>" in the file directory', () => {
  const file = path.resolve('/work/proj/.coverage');
  const out = path.resolve('/tmp/ct-2/coverage.xml');
  expect(conversionSpec(file, out, '/work/proj/.venv/bin/python')).toEqual({
    command: '/work/proj/.venv/bin/python',
    args: ['-m', 'coverage', 'xml', `--data-file=${file}`, '-o', out],
    cwd: path.resolve('/work/proj'),
  });
});
