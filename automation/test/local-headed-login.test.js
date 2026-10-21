const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyLoginSnapshot, parseTimeout } = require('../src/local-headed-login');

test('BOSS 登录页不会误判为已登录', () => {
  const state = classifyLoginSnapshot('boss', {
    url: 'https://www.zhipin.com/web/user/', text: '手机号登录 验证码登录', html: '<div class="user-nav"></div>'
  });
  assert.equal(state.loggedIn, false);
  assert.equal(state.loginPage, true);
});

test('BOSS 沟通页就绪判定为已登录', () => {
  const state = classifyLoginSnapshot('boss', {
    url: 'https://www.zhipin.com/web/geek/chat', text: '沟通', html: '<main class="friend-content-warp"></main>'
  });
  assert.equal(state.loggedIn, true);
});

test('猎聘投递页就绪判定为已登录', () => {
  const state = classifyLoginSnapshot('liepin', {
    url: 'https://c.liepin.com/job/record/apply', text: '我的投递 已投递 投递反馈', html: '<div></div>'
  });
  assert.equal(state.loggedIn, true);
});

test('登录等待时间支持覆盖与不限时', () => {
  assert.equal(parseTimeout([]), 60);
  assert.equal(parseTimeout(['--login-timeout=90']), 90);
  assert.equal(parseTimeout(['--login-timeout=0']), 0);
});
