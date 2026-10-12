const { test } = require('node:test');
const assert = require('node:assert/strict');
const { existsSync } = require('node:fs');
const { resolve } = require('node:path');

test('project README is present', () => {
  assert.ok(existsSync(resolve(__dirname, '../README.md')));
});
