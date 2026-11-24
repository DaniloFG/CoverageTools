import assert from 'node:assert';
import { add } from '../src/calc';

describe('calc', () => {
  it('adds', () => {
    const sum: number = add(1, 2);
    assert.strictEqual(sum, 3);
  });
});
