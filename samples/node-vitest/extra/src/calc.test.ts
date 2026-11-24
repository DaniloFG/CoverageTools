// Its path contains "src/calc.test.ts": a partial run of src/calc.test.ts must not run it.
import { expect, test } from 'vitest';
import { divide } from '../../src/calc';

test('divide from a sibling whose path contains src/calc.test.ts', () => {
  expect(divide(8, 2)).toBe(4);
});
