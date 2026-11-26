import { expect, test } from 'vitest';
import { divide } from './calc';

test('divide', () => {
  expect(divide(6, 3)).toBe(2);
  expect(() => divide(1, 0)).toThrow('Division by zero');
});
