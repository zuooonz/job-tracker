const test = require('node:test');
const assert = require('node:assert/strict');
const { isInterception } = require('../src/access-budget');

test('recognizes platform blocks for shared cooldown reporting', () => {
  assert.equal(isInterception(new Error('BOSS_BLOCKED {"loginRequired":true}')), true);
  assert.equal(isInterception(new Error('LIEPIN_SECURITY_CHALLENGE url=safe.liepin.com')), true);
  assert.equal(isInterception(new Error('LIEPIN_BLOCKED about:blank')), true);
  assert.equal(isInterception(new Error('network timeout')), false);
});
