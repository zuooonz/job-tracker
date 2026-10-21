const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeLiepinUpdate, reviewDetail } = require('../src/field-quality');

const complete = {
  url: 'https://example.com/job/1', title: '数据产品经理', company: '示例公司',
  description: '负责数据治理、项目交付与质量管理。', publisherType: 'company_hr'
};

test('猎聘只用岗位头部月日归一化岗位更新时间', () => {
  assert.equal(normalizeLiepinUpdate('7月31日更新', new Date('2026-08-15T12:00:00+08:00')), '2026-07-31');
  const result = reviewDetail('liepin', {
    ...complete,
    updateTime: '2026-08-15',
    relativeUpdateTime: '7月31日更新',
    metadata: { page_updated_at: '2026-08-15', page_updated_at_semantics: 'page_not_job' }
  }, new Date('2026-08-15T12:00:00+08:00'));
  assert.equal(result.detail.updateTime, '2026-07-31');
  assert.equal(result.detail.metadata.page_updated_at, '2026-08-15');
  assert.equal(result.quality.status, 'pass');
});

test('BOSS 页面更新时间和招聘资质不能冒充岗位字段', () => {
  const result = reviewDetail('boss', {
    ...complete,
    updateTime: '2026-08-15',
    jobTags: ['B端产品', '人力资源服务许可证'],
    metadata: { page_updated_at: '2026-08-15' }
  });
  assert.equal(result.detail.updateTime, '');
  assert.deepEqual(result.detail.jobTags, ['B端产品']);
  assert.equal(result.quality.status, 'warn');
  assert.ok(result.quality.warnings.includes('boss_page_update_removed_from_job_update'));
  assert.ok(result.quality.warnings.includes('certification_removed_from_job_tags'));
});

test('可疑可选字段清空并留痕，核心详情缺失则拒绝入库', () => {
  const warning = reviewDetail('liepin', {
    ...complete, experience: '企业行业', education: '人数规模', headcount: '招聘中'
  });
  assert.equal(warning.detail.experience, '');
  assert.equal(warning.detail.education, '');
  assert.equal(warning.detail.headcount, '');
  assert.equal(warning.quality.status, 'warn');

  const rejected = reviewDetail('boss', { ...complete, description: '' });
  assert.equal(rejected.quality.status, 'reject');
  assert.ok(rejected.quality.errors.includes('missing_or_short_description'));
});
