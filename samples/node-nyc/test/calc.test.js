const assert = require('node:assert');
const { add } = require('../src/calc');

describe('calc', () => {
  it('adds', () => {
    assert.strictEqual(add(1, 2), 3);
  });
});
