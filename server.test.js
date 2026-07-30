const test = require('node:test');
const assert = require('node:assert');
const { add } = require('./server');

test('add sums two numbers', () => {
  assert.strictEqual(add(2, 2), 4);
});

test('add coerces numeric strings', () => {
  // Deliberately fails against the current buggy implementation:
  // add(2, '3') currently returns '23' (string concatenation), not 5.
  assert.strictEqual(add(2, '3'), 5);
});
