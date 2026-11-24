const { divide } = require('./calc');

test('divide', () => {
  expect(divide(6, 3)).toBe(2);
});

test('divide by zero', () => {
  expect(() => divide(1, 0)).toThrow('Division by zero');
});
