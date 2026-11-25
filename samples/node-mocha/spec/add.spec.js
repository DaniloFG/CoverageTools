// A Mocha-style spec folder: c8 must not report it as source.
const assert = require('node:assert');
const { add } = require('../src/calc');

describe('calc (spec folder)', () => {
  it('adds', () => {
    assert.strictEqual(add(0, 1), 1);
  });
});
