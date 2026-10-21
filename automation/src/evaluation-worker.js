#!/usr/bin/env node
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');
const { TrackerApi } = require('./api');

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(__dirname, '..', '..');

function loadEnv(filePath = path.join(ROOT, '.env')) {
  if (!fs.existsSync(filePath)) return;
  for (const rawLine of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const [key, ...parts] = line.split('=');
    if (!process.env[key]) process.env[key] = parts.join('=').trim().replace(/^(['"])(.*)\1$/, '$2');
  }
}

loadEnv();

const POLL_MS = Math.max(2000, Number(process.env.EVALUATION_WORKER_POLL_MS || 15000));
const API_URL = process.env.TRACKER_API_URL || 'http://127.0.0.1:8888';
const WORKER_ID = `deepseek-worker-${process.pid}`;
let stopping = false;

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function evaluate(queueItem, api) {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [path.join(__dirname, 'evaluate-jobs.js'), '--mode=write', '--limit=1', `--job-id=${queueItem.job_id}`, `--api=${API_URL}`],
      { cwd: path.join(ROOT, 'automation'), timeout: 180000, maxBuffer: 1024 * 1024 }
    );
    const summary = JSON.parse(stdout.trim());
    const completed = (summary.statuses?.persisted || 0) + (summary.statuses?.skipped_unchanged || 0) === 1;
    if (!completed) throw new Error(`评价未完成：${JSON.stringify(summary.statuses || {})}${stderr ? `；${stderr.trim()}` : ''}`);
    const detail = await api.getJob(queueItem.job_id);
    const evaluationId = detail.evaluations?.[0]?.id || null;
    await api.finishEvaluationQueue(queueItem.id, { status: 'completed', evaluation_id: evaluationId });
    process.stdout.write(`${new Date().toISOString()} completed queue=${queueItem.id} job=${queueItem.job_id}\n`);
  } catch (error) {
    await api.finishEvaluationQueue(queueItem.id, { status: 'failed', error: String(error.message || error).slice(0, 1000) });
    process.stderr.write(`${new Date().toISOString()} failed queue=${queueItem.id} job=${queueItem.job_id}: ${error.message}\n`);
  }
}

async function tick(api) {
  const environment = await api.request('/api/settings/environment');
  if (environment.candidate_profile_is_example) {
    process.stdout.write(`${new Date().toISOString()} skipped: 候选人画像仍是公开示例，评价队列暂停\n`);
    return false;
  }
  const schedule = await api.getEvaluationSchedule();
  const item = await api.claimEvaluation(schedule.is_offpeak, WORKER_ID);
  if (!item) return false;
  await evaluate(item, api);
  return true;
}

async function main() {
  const once = process.argv.includes('--once');
  // --max-items=N：本次最多处理 N 条后退出（cron 批量用）；不传则常驻。
  const maxFlag = process.argv.find(arg => arg.startsWith('--max-items='));
  const maxItems = maxFlag ? Number(maxFlag.split('=')[1]) : Infinity;
  const api = new TrackerApi(API_URL);
  let processed = 0;
  do {
    try {
      const worked = await tick(api);
      if (worked) processed += 1;
      if (once) break;
      if (processed >= maxItems) break;
      await wait(POLL_MS);
    } catch (error) {
      process.stderr.write(`${new Date().toISOString()} worker error: ${error.message}\n`);
      if (once) process.exitCode = 1;
      else await wait(POLL_MS);
    }
  } while (!stopping);
}

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { stopping = true; });

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
