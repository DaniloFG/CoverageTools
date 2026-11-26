// A Mocha-style spec next to the source: c8 must not report it as source.
const assert = require('node:assert');
const { add } = require('./calc');

describe('calc (spec next to the source)', () => {
  it('adds', () => {
    assert.strictEqual(add(2, 2), 4);
  });
});
