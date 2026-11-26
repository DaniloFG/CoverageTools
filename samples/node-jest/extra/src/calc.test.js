// Its path contains "src/calc.test.js": a partial run of src/calc.test.js must not run it.
const { divide } = require('../../src/calc');

test('divide from a sibling whose path contains src/calc.test.js', () => {
  expect(divide(8, 2)).toBe(4);
});
