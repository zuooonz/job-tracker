const test = require('node:test');
const assert = require('node:assert/strict');
const { parseMonthlySalaryK, screenDetail } = require('../src/screening');
const { strategy } = require('../src/prefilter');

test('解析 BOSS 与猎聘月薪范围', () => {
  assert.deepEqual(parseMonthlySalaryK('11-18K'), { min: 11, max: 18, raw: '11-18K' });
  assert.deepEqual(parseMonthlySalaryK('20-30k·15薪'), { min: 20, max: 30, raw: '20-30k·15薪' });
  assert.equal(parseMonthlySalaryK('薪资面议'), null);
});

test('通用排除词和低薪岗位在调用模型前被筛除', () => {
  const before = strategy.minimumMonthlySalaryMaxK;
  strategy.minimumMonthlySalaryMaxK = 20;
  strategy.hardIrrelevantTitleTerms = ['团餐'];
  try {
    const result = screenDetail({ title: '团餐项目经理', company: '示例公司', salary: '11-18K', description: '负责客户服务和项目协调。' });
    assert.equal(result.status, 'reject');
    assert.ok(result.reasons.some(item => item.includes('无关领域')));
    assert.ok(result.reasons.some(item => item.includes('月薪上限')));
  } finally { strategy.minimumMonthlySalaryMaxK = before; strategy.hardIrrelevantTitleTerms = []; }
});

test('配置中的目标领域与任务锚点允许岗位通过', () => {
  const result = screenDetail({ title: '软件产品经理', salary: '20-30K', jobTags: ['产品设计'], description: '负责软件产品需求分析和跨团队项目交付。' });
  assert.equal(result.status, 'pass');
});

test('没有目标领域锚点的岗位被排除', () => {
  const result = screenDetail({ title: '项目经理', salary: '25-35K', description: '负责施工现场和供应商协调。' });
  assert.equal(result.status, 'reject');
  assert.ok(result.reasons.includes('岗位详情未命中目标领域锚点'));
});

test('通用配置规则、经验条件和岗位状态生效', () => {
  strategy.specialCaseRules = [{ matchTerms: ['高风险业务'], titleTerms: ['顾问'], reason: '配置的专项排除规则' }];
  strategy.hardExperienceTerms = ['在校/应届'];
  try {
    const special = screenDetail({ title: '业务顾问', salary: '25-35K', description: '负责高风险业务项目交付和产品分析。' });
    assert.ok(special.reasons.includes('配置的专项排除规则'));
    const graduate = screenDetail({ title: '软件产品经理', salary: '25-35K', experience: '在校/应届', description: '负责软件产品分析和项目交付。' });
    assert.ok(graduate.reasons.some(item => item.includes('经验条件不适用')));
    const offline = screenDetail({ title: '软件产品经理', salary: '25-35K', description: '负责软件产品分析和项目交付。', isOffline: true });
    assert.ok(offline.reasons.some(item => item.includes('关闭')));
  } finally { strategy.specialCaseRules = []; strategy.hardExperienceTerms = []; }
});
