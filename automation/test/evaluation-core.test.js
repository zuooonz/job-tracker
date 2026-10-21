const test = require('node:test');
const assert = require('node:assert/strict');
const { buildJobInput, loadEvaluationConfig, recommendedLevel, sha256, validateResult } = require('../src/evaluate-jobs');

const { strategy } = loadEvaluationConfig();

test('评价策略保留充分完成额度且思考参数由环境变量显式控制', () => {
  assert.equal(strategy.api.thinking, undefined);
  assert.ok(strategy.api.max_tokens >= 4000);
});

function validResult() {
  return {
    direction: 'product_role', summary: '数据治理岗位，主线相关。',
    dimension_scores: {
      domain_task_alignment: 20, evidence_transferability: 20, hard_requirements: 15,
      seniority_scope: 10, career_value: 8, practical_constraints: 4
    },
    score: 77, confidence_score: 82, recommendation_level: 'normal',
    match_evidence: ['数据治理要求 ← 业务资料治理经验'], gaps: ['供应商规模待核实'],
    hard_requirements: [{ item: '专业背景', critical: true, result: 'matched', evidence: '相关领域博士' }],
    risk_notes: '', filter_result: 'pass', filter_reasons: [], resume_direction: '数据治理', needs_resume_tailoring: true
  };
}

test('六维分数严格求和并由本地阈值决定推荐级别', () => {
  const result = validateResult(validResult(), strategy);
  assert.equal(result.score, 77);
  assert.equal(result.recommendation_level, 'normal');
  assert.equal(recommendedLevel(82, 60, false, strategy.thresholds), 'normal');
  assert.equal(recommendedLevel(82, 80, false, strategy.thresholds), 'priority');
});

test('关键硬门槛缺口不能突破分数封顶', () => {
  const raw = validResult();
  raw.hard_requirements[0].result = 'gap';
  assert.throws(() => validateResult(raw, strategy), /超过封顶值/);
});

test('拒绝已满足一个分支却判为partial的“或”条件', () => {
  const raw = validResult();
  raw.hard_requirements[0] = {
    item: '有数据治理、文本分析或知识库经验',
    critical: true,
    result: 'partial',
    evidence: '候选人具备数据治理和知识库经验，但缺少文本分析经验'
  };
  assert.throws(() => validateResult(raw, strategy), /“或”条件已满足分支却判为partial/);
});

test('输入只包含评价所需字段且哈希稳定', () => {
  const job = {
    id: 1, source: 'boss', title: '数据产品经理', company: '示例公司', location: '示例地点', salary: '20-30K',
    jd: '负责数据治理和项目交付。', metadata: { business_registration_text: '不应发送', extraction_quality: { status: 'pass' } },
    job_tags: ['数据治理'], recruiter_title: 'HR', recruiter_company: '示例公司'
  };
  const input = buildJobInput(job, strategy);
  assert.equal(input.page_information_quality.status, 'pass');
  assert.equal(JSON.stringify(input).includes('不应发送'), false);
  assert.equal(sha256(input), sha256({ ...input }));
});
