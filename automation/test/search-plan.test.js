const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const plan = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'search-plan-v2.json'), 'utf8'));
const { resolveSearchDirection } = require('../src/search-direction');

// 测试只针对公开示例计划（JOB_TRACKER_CONFIG=example），不依赖本人的私有检索计划。
test('示例检索矩阵覆盖 A/B/C 三个层级', () => {
  const expected = ['product_role', 'analysis_role', 'technology_role'];
  assert.deepEqual(plan.directions.map(item => item.id), expected);
  assert.deepEqual([...new Set(plan.directions.map(item => item.priority))].sort(), ['A', 'B', 'C']);
  for (const direction of plan.directions) {
    for (const platform of ['boss', 'liepin']) {
      assert.ok(direction[platform].seed.length >= 3, `${direction.id}/${platform} 缺少 seed 查询`);
      assert.ok(direction[platform].variants.length >= 4, `${direction.id}/${platform} 缺少扩展查询`);
    }
  }
});

test('采集时从平台和关键词确定检索方向', () => {
  for (const item of plan.tested_queries) {
    assert.equal(resolveSearchDirection(item.platform, item.keyword), item.direction);
  }
  assert.equal(resolveSearchDirection('boss', '全新探索词', 'technology_role'), 'technology_role');
  assert.throws(() => resolveSearchDirection('boss', '全新探索词'), /不在检索策略/);
});

test('示例允许没有停用查询，真实停用词由使用者配置', () => {
  assert.ok(Array.isArray(plan.disabled_queries));
});
