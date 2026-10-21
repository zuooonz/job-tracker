const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseArgs, loadPlan, preview, buildSeedSteps, freshState, recordResult,
  shouldExpandVariants, shouldStopVariants, completedEquivalent, collectorArgs
} = require('../src/collect-plan');

test('全量命令默认覆盖双平台和示例计划的 A/B/C 方向', () => {
  const options = parseArgs(['--scope=full', '--resume']);
  const plan = loadPlan();
  const summary = preview(plan, options);
  assert.deepEqual(summary.platforms, ['boss', 'liepin']);
  assert.equal(summary.directions.length, 3);
  assert.equal(summary.seedCount, 18);
  assert.equal(buildSeedSteps(plan, options).length, 18);
});

test('计划调度把检索方向显式传给单关键词采集器', () => {
  const options = parseArgs(['--scope=full']);
  const args = collectorArgs({
    directionId: 'technology_role', platform: 'boss', keyword: '应用项目经理'
  }, options);
  assert.ok(args.includes('--direction=technology_role'));
});

test('自适应模式达到方向目标后不展开扩展词', () => {
  const plan = loadPlan();
  const options = parseArgs(['--scope=full']);
  const direction = plan.directions.find(item => item.id === 'product_role');
  const state = freshState(plan, options);
  for (let index = 0; index < 2; index += 1) {
    recordResult(state, {
      directionId: direction.id, priority: 'A', platform: 'boss', stage: 'seed', keyword: `测试${index}`
    }, { resultCount: 6, newJobCount: 5, retainedRate: 5 / 6 });
  }
  assert.equal(shouldExpandVariants(plan, options, state, direction, 'boss').expand, false);
});

test('连续两个低新增扩展词后停止当前方向扩展', () => {
  const plan = loadPlan();
  const options = parseArgs(['--scope=full']);
  const direction = plan.directions.find(item => item.id === 'analysis_role');
  const state = freshState(plan, options);
  for (let index = 0; index < 2; index += 1) {
    recordResult(state, {
      directionId: direction.id, priority: 'B', platform: 'liepin', stage: 'variant', keyword: `低新增${index}`
    }, { resultCount: 10, newJobCount: 1, retainedRate: 0.1 });
  }
  assert.match(shouldStopVariants(plan, state, direction, 'liepin'), /连续 2 个/);
});

test('同平台同关键词跨方向只执行一次', () => {
  const plan = loadPlan();
  const options = parseArgs(['--scope=full']);
  const state = freshState(plan, options);
  recordResult(state, {
    directionId: 'product_role', priority: 'A', platform: 'boss', stage: 'variant', keyword: '产品经理'
  }, { resultCount: 5, newJobCount: 3, retainedRate: 0.6 });
  const duplicate = completedEquivalent(state, {
    directionId: 'analysis_role', platform: 'boss', stage: 'seed', keyword: '产品经理'
  });
  assert.equal(duplicate.directionId, 'product_role');
});
