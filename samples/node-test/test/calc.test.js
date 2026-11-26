const assert = require('node:assert');
const { test } = require('node:test');
const { add } = require('../src/calc');

test('adds', () => {
  assert.strictEqual(add(1, 2), 3);
});
