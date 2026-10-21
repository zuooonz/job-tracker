const test = require('node:test');
const assert = require('node:assert/strict');
const { prefilter, strategy } = require('../src/prefilter');

test('读取配置的领域与正向词为岗位排序', () => {
  const targeted = prefilter({ title: '软件产品经理', location: '示例地点' });
  const generic = prefilter({ title: '项目经理', location: '示例地点' });
  assert.ok(targeted.score > generic.score);
  assert.ok(targeted.domainHits.length > 0);
});

test('自定义黑名单和降权词在列表阶段生效', () => {
  strategy.hardTitleBlacklist = ['外包'];
  strategy.downrankTitleTerms = ['高级'];
  try {
    const senior = prefilter({ title: '高级软件产品经理', location: '示例地点' });
    assert.ok(senior.downrankHits.includes('高级'));
    const excluded = prefilter({ title: '外包项目经理', location: '示例地点' });
    assert.equal(excluded.result, 'reject');
  } finally { strategy.hardTitleBlacklist = []; strategy.downrankTitleTerms = []; }
});
