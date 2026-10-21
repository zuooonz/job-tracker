#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { connectOrLaunch, releaseSession } = require('./browser');
const { TrackerApi } = require('./api');
const { prefilter, strategy } = require('./prefilter');
const { detailToPayload } = require('./job-payload');
const { reviewDetail } = require('./field-quality');
const { screenDetail } = require('./screening');
const { resolveSearchDirection } = require('./search-direction');
const { acquireBrowserLock, isInterception } = require('./access-budget');

const ROOT = path.resolve(__dirname, '..', '..');

function parseArgs(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('用法: node src/cli.js --source=boss|liepin --keyword=关键词 [--direction=方向ID] [--max-pages=1] [--detail-limit=1] [--dry-run] [--keep-page]');
    return null;
  }
  const result = { maxPages: 1, detailLimit: 3, dryRun: false, closePage: true, api: 'http://127.0.0.1:8888', token: '', port: 18800 };
  const valueOptions = new Set(['source', 'keyword', 'direction', 'maxPages', 'detailLimit', 'api', 'token', 'port', 'city', 'chromePath', 'profileDir']);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') result.dryRun = true;
    else if (arg === '--close-page') result.closePage = true;
    else if (arg === '--keep-page') result.closePage = false;
    else if (arg.startsWith('--') && arg.includes('=')) {
      const [key, ...rest] = arg.slice(2).split('=');
      const normalized = key.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
      if (!valueOptions.has(normalized)) throw new Error(`未知参数 --${key}`);
      result[normalized] = rest.join('=');
    } else if (arg.startsWith('--')) {
      const key = arg.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
      if (!valueOptions.has(key)) throw new Error(`未知参数 ${arg}`);
      if (index + 1 >= argv.length) throw new Error(`${arg} 缺少参数值`);
      result[key] = argv[++index];
    } else {
      throw new Error(`未知位置参数 ${arg}`);
    }
  }
  result.maxPages = Math.max(1, Number(result.maxPages));
  result.detailLimit = Math.max(0, Number(result.detailLimit));
  result.port = Number(result.port);
  if (!['boss', 'liepin'].includes(result.source)) throw new Error('--source 必须是 boss 或 liepin');
  if (!result.keyword) throw new Error('缺少 --keyword');
  result.direction = resolveSearchDirection(result.source, result.keyword, result.direction);
  result.city ||= result.source === 'boss' ? '101010100' : '010';
  result.chromePath ||= process.env.CHROME_PATH || '/usr/bin/google-chrome-stable';
  result.profileDir ||= process.env.JOB_TRACKER_BROWSER_PROFILE || path.join(ROOT, 'data', 'browser-profile');
  result.token ||= process.env.TRACKER_API_TOKEN || '';
  return result;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const randomPacing = () => strategy.detailPacingMs.min + Math.floor(Math.random() * (strategy.detailPacingMs.max - strategy.detailPacingMs.min + 1));
const canonicalUrl = value => {
  const url = new URL(value);
  url.search = '';
  url.hash = '';
  url.pathname = url.pathname.replace(/\/$/, '') || '/';
  return url.toString();
};

function rejectionPayload(source, job, reasons, run, keyword, searchDirection, searchPageUrl) {
  return {
    source, url: job.url, title: job.title || '', company: job.company || '',
    location: job.location || '', salary: job.salary || '', reasons,
    rules_version: strategy.version, search_run_id: run?.id || null, keyword,
    search_direction: searchDirection,
    search_page_url: searchPageUrl, result_position: job.position
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options) return;
  const adapter = require(`./adapters/${options.source}`);
  const api = new TrackerApi(options.api, options.token);
  const outputDir = path.join(ROOT, 'data', 'automation-runs');
  fs.mkdirSync(outputDir, { recursive: true });
  let run = null;
  let session = null;
  let failed = false;
  let releaseLock = null;
  const startedAt = new Date();
  try {
    releaseLock = acquireBrowserLock('collect');
    await api.assertAutomationAvailable(options.source);
    if (!options.dryRun) {
      run = await api.createSearchRun(options.source, options.keyword, options.direction, {
        city: options.city, max_pages: options.maxPages, detail_limit: options.detailLimit,
        collector: 'puppeteer-legacy-tuned', strategy_version: strategy.version,
        close_page: options.closePage
      }, '统一自动化采集器');
    }
    session = await connectOrLaunch(options);
    const listResult = await adapter.search(session.page, options.keyword, options);
    const jobs = listResult.jobs.map((job, index) => ({ ...job, position: index, prefilter: prefilter(job) }));
    const uniqueJobs = Array.from(new Map(jobs.map(job => [job.url, job])).values());
    const knownRejected = options.dryRun ? [] : await api.listScreeningRejections(options.source);
    const rejectedByUrl = new Map(knownRejected.map(item => [item.canonical_url, item]));
    const rejectedUrls = new Set(rejectedByUrl.keys());
    const listRejected = uniqueJobs.filter(job =>
      job.prefilter.result === 'reject' || rejectedUrls.has(canonicalUrl(job.url))
    );
    if (!options.dryRun) {
      for (const job of listRejected) {
        const reasons = job.prefilter.result === 'reject'
          ? [job.prefilter.reason]
          : rejectedByUrl.get(canonicalUrl(job.url))?.reasons || ['此前已通过本地硬门槛排除'];
        await api.recordScreeningRejection(rejectionPayload(
          options.source, job, reasons, run, options.keyword, options.direction, listResult.searchPageUrl
        ));
      }
    }

    const candidates = uniqueJobs
      .filter(job => job.prefilter.result !== 'reject' && !rejectedUrls.has(canonicalUrl(job.url)))
      .sort((a, b) => b.prefilter.score - a.prefilter.score || a.position - b.position)
      .slice(0, options.detailLimit);
    const details = [];
    let persistedCount = 0;
    let detailRejectedCount = 0;
    for (let index = 0; index < candidates.length; index += 1) {
      await api.reserveAutomationBudget(options.source, 'detail_opens');
      const rawDetail = await adapter.detail(session.page, candidates[index]);
      const { detail, quality } = reviewDetail(options.source, rawDetail);
      const screening = quality.status === 'reject'
        ? { rules_version: strategy.version, status: 'reject', reasons: ['页面详情质量不合格'] }
        : screenDetail(detail);
      detail.metadata = { ...(detail.metadata || {}), screening };
      details.push({ ...detail, extractionQuality: quality, screening, jobId: null });
      if (screening.status === 'reject') {
        detailRejectedCount += 1;
        if (!options.dryRun) {
          await api.recordScreeningRejection(rejectionPayload(
            options.source, { ...detail, position: candidates[index].position }, screening.reasons,
            run, options.keyword, options.direction, listResult.searchPageUrl
          ));
        }
      } else if (!options.dryRun && quality.status !== 'reject') {
        const stored = await api.ingestJob(detailToPayload(options.source, detail, {
            search_run_id: run.id, keyword: options.keyword, search_direction: options.direction,
            search_page_url: listResult.searchPageUrl, result_position: candidates[index].position
        }));
        details[details.length - 1].jobId = stored.id;
        persistedCount += 1;
      }
      if (index + 1 < candidates.length) await sleep(randomPacing());
    }

    const report = {
      collectorVersion: '1.6.0', source: options.source, keyword: options.keyword,
      searchDirection: options.direction,
      searchRunId: run?.id || null, startedAt: startedAt.toISOString(), finishedAt: new Date().toISOString(),
      dryRun: options.dryRun, searchPageUrl: listResult.searchPageUrl,
      listCount: uniqueJobs.length, rejectedCount: listRejected.length,
      detailRejectedCount, detailCount: details.length, persistedCount,
      jobs: uniqueJobs, details,
      nextStep: '由 Codex 根据简历策略评估 details，并调用 /api/jobs/{id}/evaluations'
    };
    const reportPath = path.join(outputDir, `${startedAt.toISOString().replace(/[:.]/g, '-')}-${options.source}.json`);
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    if (run) await api.finishSearchRun(run.id, 'completed', `列表${report.listCount}条，详情${report.detailCount}条，正式入库${report.persistedCount}条，列表排除${report.rejectedCount}条，详情硬排除${report.detailRejectedCount}条；待Codex评估`);
    console.log(JSON.stringify({ reportPath, searchRunId: run?.id || null, listCount: report.listCount, detailCount: report.detailCount, persistedCount: report.persistedCount, rejectedCount: report.rejectedCount, detailRejectedCount: report.detailRejectedCount }, null, 2));
    await api.reportAutomationRun(options.source, 'collect', 'completed', { listed: report.listCount, details: report.detailCount, persisted: report.persistedCount }, '采集完成');
  } catch (error) {
    failed = true;
    if (isInterception(error)) await api.request('/api/automation/budget', { method: 'POST', body: JSON.stringify({ action: 'intercept', platform: options.source, message: error.message }) }).catch(() => {});
    await api.reportAutomationRun(options.source, 'collect', 'failed', {}, error.message).catch(() => {});
    if (run) await api.finishSearchRun(run.id, 'failed', error.message).catch(() => {});
    throw error;
  } finally {
    // 成功后默认关闭工作标签；显式 --keep-page 用于观察。失败永远保留现场。
    if (session) await releaseSession(session, { keepPage: failed || !options.closePage });
    if (releaseLock) releaseLock();
  }
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
