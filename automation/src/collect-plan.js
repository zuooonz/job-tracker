#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { acquireBrowserLock } = require('./access-budget');

const AUTOMATION_ROOT = path.resolve(__dirname, '..');
const PROJECT_ROOT = path.resolve(AUTOMATION_ROOT, '..');
const { configPath } = require('./config-path');

const PLAN_PATH = configPath('search-plan-v2.json');
const RUN_DIR = path.join(PROJECT_ROOT, 'data', 'automation-runs');

function parseArgs(argv) {
  const options = {
    scope: 'full', platform: 'all', priorities: ['A', 'B', 'C'], stage: 'adaptive',
    resume: false, newRun: false, dryRun: false, maxPages: 1, detailLimit: 5,
    minDelayMs: 45000, maxDelayMs: 90000, longBreakEvery: 6,
    longBreakMinMs: 300000, longBreakMaxMs: 600000,
    api: 'http://127.0.0.1:8888',
    token: ''
  };
  const booleans = new Set(['resume', 'new-run', 'dry-run']);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) throw new Error(`未知位置参数 ${arg}`);
    const [rawKey, inline] = arg.slice(2).split(/=(.*)/s);
    if (booleans.has(rawKey)) {
      options[rawKey.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = true;
      continue;
    }
    const value = inline === undefined ? argv[++index] : inline;
    if (value === undefined) throw new Error(`--${rawKey} 缺少参数值`);
    const key = rawKey.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (!(key in options)) throw new Error(`未知参数 --${rawKey}`);
    options[key] = value;
  }
  if (options.scope !== 'full') throw new Error('--scope 当前只支持 full');
  if (!['all', 'boss', 'liepin'].includes(options.platform)) throw new Error('--platform 必须是 all、boss 或 liepin');
  if (!['adaptive', 'seed', 'all'].includes(options.stage)) throw new Error('--stage 必须是 adaptive、seed 或 all');
  options.priorities = Array.isArray(options.priorities)
    ? options.priorities
    : String(options.priorities).split(',').map(item => item.trim().toUpperCase()).filter(Boolean);
  if (options.priorities.some(item => !['A', 'B', 'C'].includes(item))) throw new Error('--priorities 只能包含 A、B、C');
  for (const key of ['maxPages', 'detailLimit', 'minDelayMs', 'maxDelayMs', 'longBreakEvery', 'longBreakMinMs', 'longBreakMaxMs']) {
    options[key] = Number(options[key]);
    if (!Number.isFinite(options[key]) || options[key] < 0) throw new Error(`--${key} 必须是非负数字`);
  }
  if (options.maxDelayMs < options.minDelayMs) throw new Error('max-delay-ms 不能小于 min-delay-ms');
  if (options.longBreakMaxMs < options.longBreakMinMs) throw new Error('long-break-max-ms 不能小于 long-break-min-ms');
  options.token ||= process.env.TRACKER_API_TOKEN || '';
  return options;
}

function loadPlan() {
  return JSON.parse(fs.readFileSync(PLAN_PATH, 'utf8'));
}

function selectedPlatforms(options) {
  return options.platform === 'all' ? ['boss', 'liepin'] : [options.platform];
}

function selectedDirections(plan, options) {
  return plan.directions.filter(item => options.priorities.includes(item.priority));
}

function queryKey(direction, platform, stage, keyword) {
  const directionId = typeof direction === 'string' ? direction : direction.directionId || direction.id;
  return `${directionId}|${platform}|${stage}|${keyword}`;
}

function completedEquivalent(state, step) {
  return Object.values(state.completedQueries).find(item =>
    item.platform === step.platform && item.keyword === step.keyword
  ) || null;
}

function buildSeedSteps(plan, options) {
  const steps = [];
  for (const direction of selectedDirections(plan, options)) {
    for (const platform of selectedPlatforms(options)) {
      for (const keyword of direction[platform].seed) {
        steps.push({ directionId: direction.id, priority: direction.priority, platform, stage: 'seed', keyword });
      }
    }
  }
  return steps;
}

function statePath(plan, options) {
  const priorities = options.priorities.join('').toLowerCase();
  return path.join(RUN_DIR, `${plan.version}-${options.platform}-${priorities}-${options.stage}.state.json`);
}

function freshState(plan, options) {
  return {
    version: 1, planVersion: plan.version, status: 'running',
    scope: options.scope, platform: options.platform, priorities: options.priorities,
    stage: options.stage, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    finishedAt: null, completedQueries: {}, failedQueries: {}, skippedQueries: {},
    directionMetrics: {}, executedQueryCount: 0
  };
}

function atomicWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2));
  fs.renameSync(temporary, file);
}

function loadOrCreateState(plan, options, file) {
  if (options.resume && !options.newRun && fs.existsSync(file)) {
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (state.planVersion !== plan.version) throw new Error(`断点属于 ${state.planVersion}，当前计划为 ${plan.version}`);
    if (state.status === 'completed') return state;
    state.status = 'running';
    state.updatedAt = new Date().toISOString();
    return state;
  }
  if (fs.existsSync(file) && !options.newRun && !options.resume) {
    throw new Error(`已存在计划状态 ${file}；继续请加 --resume，重新扫描请加 --new-run`);
  }
  return freshState(plan, options);
}

function randomBetween(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

async function visibleWait(ms, label) {
  if (ms <= 0) return;
  const end = Date.now() + ms;
  process.stdout.write(`${label}：${Math.ceil(ms / 1000)} 秒\n`);
  while (Date.now() < end) {
    const remaining = end - Date.now();
    await new Promise(resolve => setTimeout(resolve, Math.min(30000, remaining)));
    if (Date.now() < end) process.stdout.write(`${label}：剩余 ${Math.ceil((end - Date.now()) / 1000)} 秒\n`);
  }
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${url}: ${await response.text()}`);
  return response.json();
}

async function latestSearchRun(api, step, startedAt) {
  const runs = await fetchJson(`${api.replace(/\/$/, '')}/api/search-runs?limit=1000`);
  return runs.find(item => item.source === step.platform && item.keyword === step.keyword
    && new Date(item.started_at).getTime() >= startedAt - 2000) || null;
}

function collectorArgs(step, options) {
  return [
    path.join(__dirname, 'cli.js'), `--source=${step.platform}`, `--keyword=${step.keyword}`,
    `--direction=${step.directionId}`,
    `--max-pages=${options.maxPages}`, `--detail-limit=${options.detailLimit}`, `--api=${options.api}`,
    ...(options.token ? [`--token=${options.token}`] : [])
  ];
}

async function spawnCollector(step, options) {
  const startedAt = Date.now();
  const args = collectorArgs(step, options);
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: AUTOMATION_ROOT, stdio: 'inherit', env: { ...process.env, TRACKER_BROWSER_LOCK_HELD: '1' } });
    child.once('error', reject);
    child.once('exit', code => resolve(code ?? 1));
  });
  if (exitCode !== 0) throw new Error(`采集器退出码 ${exitCode}`);
  const run = await latestSearchRun(options.api, step, startedAt);
  if (!run) throw new Error('采集完成但未找到对应 search_run');
  return {
    searchRunId: run.id, resultCount: run.result_count || 0, newJobCount: run.new_job_count || 0,
    retainedRate: run.result_count ? (run.new_job_count || 0) / run.result_count : 0,
    finishedAt: run.finished_at, notes: run.notes
  };
}

function metricKey(directionId, platform) {
  return `${directionId}|${platform}`;
}

function recordResult(state, step, result) {
  const key = queryKey(step, step.platform, step.stage, step.keyword);
  state.completedQueries[key] = { ...step, ...result, completedAt: new Date().toISOString() };
  state.executedQueryCount += 1;
  const groupKey = metricKey(step.directionId, step.platform);
  const metrics = state.directionMetrics[groupKey] || { resultCount: 0, newJobCount: 0, variantsRun: 0, consecutiveLowYield: 0 };
  metrics.resultCount += result.resultCount;
  metrics.newJobCount += result.newJobCount;
  if (step.stage === 'variant') {
    metrics.variantsRun += 1;
    const threshold = loadPlan().execution_policy.low_yield_new_rate_lt;
    metrics.consecutiveLowYield = result.retainedRate < threshold ? metrics.consecutiveLowYield + 1 : 0;
  }
  state.directionMetrics[groupKey] = metrics;
  state.updatedAt = new Date().toISOString();
}

function shouldExpandVariants(plan, options, state, direction, platform) {
  if (options.stage === 'seed') return { expand: false, reason: 'stage=seed' };
  if (options.stage === 'all') return { expand: true, reason: 'stage=all' };
  const metrics = state.directionMetrics[metricKey(direction.id, platform)] || { newJobCount: 0 };
  const target = plan.execution_policy.target_new_jobs_per_direction_platform[direction.priority];
  return metrics.newJobCount >= target
    ? { expand: false, reason: `种子查询已新增 ${metrics.newJobCount} 条，达到目标 ${target}` }
    : { expand: true, reason: `种子查询新增 ${metrics.newJobCount} 条，低于目标 ${target}` };
}

function shouldStopVariants(plan, state, direction, platform) {
  const metrics = state.directionMetrics[metricKey(direction.id, platform)] || {};
  const target = plan.execution_policy.target_new_jobs_per_direction_platform[direction.priority];
  if ((metrics.newJobCount || 0) >= target) return `累计新增达到 ${target}`;
  if ((metrics.consecutiveLowYield || 0) >= plan.execution_policy.stop_variants_after_consecutive_low_yield) {
    return `连续 ${metrics.consecutiveLowYield} 个扩展词新增率过低`;
  }
  return '';
}

function acquireLock(file) {
  const lock = `${file}.lock`;
  if (fs.existsSync(lock)) {
    const pid = Number(fs.readFileSync(lock, 'utf8').trim());
    try {
      process.kill(pid, 0);
      throw new Error(`已有全量任务运行，PID=${pid}`);
    } catch (error) {
      if (error.message.startsWith('已有全量任务')) throw error;
      fs.unlinkSync(lock);
    }
  }
  fs.writeFileSync(lock, String(process.pid), { flag: 'wx' });
  return () => { if (fs.existsSync(lock)) fs.unlinkSync(lock); };
}

async function executeStep(plan, options, state, file, step) {
  const key = queryKey(step, step.platform, step.stage, step.keyword);
  if (state.completedQueries[key]) {
    process.stdout.write(`跳过已完成：${step.platform}/${step.directionId}/${step.keyword}\n`);
    return;
  }
  const equivalent = completedEquivalent(state, step);
  if (equivalent) {
    state.skippedQueries[key] = {
      ...step, reason: `同平台关键词已由方向 ${equivalent.directionId} 完成`, at: new Date().toISOString()
    };
    atomicWrite(file, state);
    process.stdout.write(`跳过跨方向重复词：${step.platform}/${step.keyword}\n`);
    return;
  }
  process.stdout.write(`\n开始：${step.priority}/${step.directionId}/${step.platform}/${step.stage}/${step.keyword}\n`);
  try {
    const result = await spawnCollector(step, options);
    recordResult(state, step, result);
    delete state.failedQueries[key];
    atomicWrite(file, state);
    process.stdout.write(`完成：发现 ${result.resultCount}，净新增 ${result.newJobCount}\n`);
  } catch (error) {
    state.status = 'paused';
    state.failedQueries[key] = { ...step, error: error.message, failedAt: new Date().toISOString() };
    state.updatedAt = new Date().toISOString();
    atomicWrite(file, state);
    throw error;
  }
  if (state.executedQueryCount % options.longBreakEvery === 0) {
    await visibleWait(randomBetween(options.longBreakMinMs, options.longBreakMaxMs), '批次长冷却');
  } else {
    await visibleWait(randomBetween(options.minDelayMs, options.maxDelayMs), '关键词间冷却');
  }
}

function preview(plan, options) {
  const directions = selectedDirections(plan, options);
  const platforms = selectedPlatforms(options);
  const seedCount = directions.reduce((sum, direction) =>
    sum + platforms.reduce((inner, platform) => inner + direction[platform].seed.length, 0), 0);
  const variantCount = directions.reduce((sum, direction) =>
    sum + platforms.reduce((inner, platform) => inner + direction[platform].variants.length, 0), 0);
  return { planVersion: plan.version, directions: directions.map(item => ({ id: item.id, priority: item.priority })), platforms, seedCount, variantCapacity: variantCount, stage: options.stage };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const plan = loadPlan();
  const summary = preview(plan, options);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (options.dryRun) return;
  const releaseBrowser = acquireBrowserLock('collect');
  process.once('exit', releaseBrowser);
  const file = statePath(plan, options);
  const releaseLock = acquireLock(file);
  const state = loadOrCreateState(plan, options, file);
  if (state.status === 'completed') {
    process.stdout.write(`计划已经完成：${file}\n`);
    releaseLock();
    releaseBrowser(); process.removeListener('exit', releaseBrowser);
    return;
  }
  atomicWrite(file, state);
  try {
    for (const direction of selectedDirections(plan, options)) {
      for (const platform of selectedPlatforms(options)) {
        for (const keyword of direction[platform].seed) {
          await executeStep(plan, options, state, file, {
            directionId: direction.id, priority: direction.priority, platform, stage: 'seed', keyword
          });
        }
        const decision = shouldExpandVariants(plan, options, state, direction, platform);
        if (!decision.expand) {
          state.skippedQueries[`${direction.id}|${platform}|variants`] = { reason: decision.reason, at: new Date().toISOString() };
          atomicWrite(file, state);
          continue;
        }
        for (const keyword of direction[platform].variants) {
          const stopReason = options.stage === 'all' ? '' : shouldStopVariants(plan, state, direction, platform);
          if (stopReason) {
            state.skippedQueries[`${direction.id}|${platform}|remaining-variants`] = { reason: stopReason, at: new Date().toISOString() };
            atomicWrite(file, state);
            break;
          }
          await executeStep(plan, options, state, file, {
            directionId: direction.id, priority: direction.priority, platform, stage: 'variant', keyword
          });
        }
      }
    }
    state.status = 'completed';
    state.finishedAt = new Date().toISOString();
    state.updatedAt = state.finishedAt;
    atomicWrite(file, state);
    const report = file.replace(/\.state\.json$/, `.report-${state.finishedAt.replace(/[:.]/g, '-')}.json`);
    atomicWrite(report, { ...summary, stateFile: file, ...state });
    process.stdout.write(`\n全量检索完成。状态：${file}\n报告：${report}\n`);
  } finally {
    releaseLock();
    releaseBrowser(); process.removeListener('exit', releaseBrowser);
  }
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exit(1);
  });
}

module.exports = {
  parseArgs, loadPlan, selectedDirections, selectedPlatforms, buildSeedSteps,
  queryKey, preview, shouldExpandVariants, shouldStopVariants, freshState, recordResult,
  completedEquivalent, collectorArgs
};
