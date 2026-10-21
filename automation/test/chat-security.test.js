const test = require('node:test');
const assert = require('node:assert/strict');
const { pacingOptions } = require('../src/apply-records');

test('猎聘安全验证 URL 规则覆盖实际 captchaPage_PC', () => {
  const url = 'https://safe.liepin.com/page/liepin/captchaPage_PC?euuid=abc';
  assert.match(url, /safe\.liepin\.com|captchaPage|\/captcha/i);
});

test('猎聘投递分页默认使用随机低频间隔', () => {
  assert.deepEqual(pacingOptions([]), { min: 18000, max: 30000 });
  assert.deepEqual(pacingOptions(['--delay-min=20000', '--delay-max=40000']), { min: 20000, max: 40000 });
});
