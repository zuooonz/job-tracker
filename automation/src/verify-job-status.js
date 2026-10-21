#!/usr/bin/env node
/**
 * BOSS 岗位状态批量核验器（含已关闭岗位固化处理）
 *
 * 背景：chat-sync 只进聊天页同步聊天，不重访岗位详情页，导致 listing_status
 * （招聘中/最新/已关闭）停留在采集时点。本脚本逐个访问岗位详情页，检测
 * 「职位已关闭/已下线/已失效」等状态。
 *
 * 固化流程（检测到已关闭时自动执行）：
 *   1. listing_status → 已关闭
 *   2. review_status → rejected（前端显示"已排除"）
 *   3. user_notes 追加「岗位已关闭」（保留原备注）
 *
 * 用法:
 *   node src/verify-job-status.js --source=boss     # 批量核验 boss 岗位（默认）
 *   node src/verify-job-status.js --limit=10        # 只核验前 10 个
 *   node src/verify-job-status.js --dry-run         # 只报告不更新
 *   node src/verify-job-status.js --no-auto-exclude # 只更新 listing_status，不转已排除/加备注
 *   node src/verify-job-status.js --source=liepin   # 猎聘（需要 detail 适配）
 */
const path = require('path');
const { connectOrLaunch, releaseSession } = require('./browser');
const { TrackerApi } = require('./api');
const { acquireBrowserLock } = require('./access-budget');

const ROOT = path.resolve(__dirname, '..', '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const withTimeout = (p, ms, label) => Promise.race([
  p,
  new Promise((_, rej) => setTimeout(() => rej(new Error(label + ' timeout')), ms)),
]);

function parseArgs(argv) {
  const r = { source: 'boss', limit: null, dryRun: false, delayMs: 1200, autoExclude: true };
  for (const a of argv) {
    if (a === '--dry-run') r.dryRun = true;
    else if (a === '--no-auto-exclude') r.autoExclude = false;
    else if (a.startsWith('--source=')) r.source = a.split('=')[1];
    else if (a.startsWith('--limit=')) r.limit = Number(a.split('=')[1]);
    else if (a.startsWith('--delay=')) r.delayMs = Number(a.split('=')[1]);
  }
  return r;
}

/** 访问岗位页，检测真实 listing_status（轻量，不做完整详情提取） */
async function checkJobStatus(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  await sleep(3500);
  const guard = await page.evaluate(() => ({ url: location.href, text: (document.body?.innerText || '').slice(0, 400), title: document.title })).catch(() => ({ url: page.url(), text: '', title: '' }));
  if (guard.url === 'about:blank' || /safe\/verify|verify-slider|captchaPage|safe\.liepin\.com/i.test(guard.url) || /安全验证|请完成验证|拖动滑块|登录\/注册/.test(guard.text)) throw new Error(`BOSS_BLOCKED ${JSON.stringify(guard)}`);
  return withTimeout(page.evaluate(() => {
    const body = document.body?.innerText || '';
    const jobStatus = document.querySelector('.job-status')?.innerText?.trim() || '';
    const offline = document.title.includes('出错啦') || !!document.querySelector('.error-page')
      || /职位已下线|已被BOSS删除|职位已关闭|岗位已关闭|该职位已停止招聘|职位已失效|已下架/.test(body)
      || /关闭|下架|失效|下线|停止招聘/.test(jobStatus);
    const status = offline
      ? (jobStatus || '职位已关闭')
      : (jobStatus || '招聘中');
    return { offline, status, title: document.title.slice(0, 40) };
  }), 8000, 'status-check').catch(() => ({ offline: null, status: '', title: '' }));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const api = new TrackerApi(process.env.TRACKER_API_URL || 'http://127.0.0.1:8888', process.env.TRACKER_API_TOKEN || '');
  await api.assertAutomationAvailable(options.source);
  const releaseLock = acquireBrowserLock('collect');
  process.once('exit', releaseLock);
  const session = await connectOrLaunch({
    source: options.source, port: 18800,
    profileDir: process.env.JOB_TRACKER_BROWSER_PROFILE || path.join(ROOT, 'data', 'browser-profile'),
    chromePath: process.env.CHROME_PATH || '/usr/bin/google-chrome-stable'
  });
  const { page } = session;
  await page.setViewport({ width: 1440, height: 900 });
  // BOSS/猎聘都需反检测（猎聘 lp-security 会清空页面）

  try {
    const jobs = await api.listJobs({ source: options.source, limit: 1000 });
    // 只核验有详情的岗位（job_detail / .shtml）
    const candidates = jobs.filter(j => (j.url || '').includes('job_detail') || (j.url || '').includes('.shtml'));
    const scoped = options.limit ? candidates.slice(0, options.limit) : candidates;
    console.log(`待核验岗位：${scoped.length}（共 ${candidates.length} 个候选）`);

    let closed = 0, active = 0, failed = 0;
    const closedList = [];
    for (const job of scoped) {
      try {
        await api.reserveAutomationBudget(options.source, 'detail_opens');
        const result = await checkJobStatus(page, job.url);
        if (result.offline === null) { failed += 1; console.log(`  ? #${job.id} ${(job.title || '').slice(0, 20)} 检测失败`); continue; }
        // 检测到已关闭 → 固化处理：
        //   1. listing_status → 已关闭（如页面给出更具体文案则用其）
        //   2. review_status → rejected（前端显示"已排除"）
        //   3. user_notes 追加「岗位已关闭」（保留原备注）
        if (result.offline) {
          closed += 1;
          closedList.push({ id: job.id, title: job.title, status: result.status });
          if (!options.dryRun) {
            const closedLabel = result.status === '职位已关闭' ? '已关闭' : result.status;
            const patch = { listing_status: closedLabel };
            if (options.autoExclude) {
              patch.review_status = 'rejected';
              // 备注：追加「岗位已关闭」，不覆盖原备注（需要先读当前备注）
              try {
                const cur = await api.getJob(job.id);
                const curJob = cur?.job || cur;
                const oldNotes = (curJob.user_notes || '').trim();
                patch.user_notes = oldNotes
                  ? (oldNotes.includes('岗位已关闭') ? oldNotes : `${oldNotes}；岗位已关闭`)
                  : '岗位已关闭';
              } catch (_) { patch.user_notes = '岗位已关闭'; }
            }
            await api.request(`/api/jobs/${job.id}`, {
              method: 'PATCH', body: JSON.stringify(patch),
            }).catch(e => console.log(`    ! #${job.id} 更新失败: ${e.message.slice(0, 60)}`));
          }
          console.log(`  ✗ #${job.id} ${(job.title || '').slice(0, 24)} | ${result.status}`);
        } else {
          active += 1;
        }
      } catch (error) {
        if (/409 .*budget|预算已用尽|冷却中/.test(error.message)) { console.log(`停止：${error.message}`); break; }
        if (/BOSS_BLOCKED|LIEPIN_BLOCKED|about:blank|安全验证/.test(error.message)) { await api.request('/api/automation/budget', { method: 'POST', body: JSON.stringify({ action: 'intercept', platform: options.source, message: error.message }) }).catch(() => {}); console.log(`停止：平台拦截，已记录冷却：${error.message}`); break; }
        failed += 1;
        console.log(`  ! #${job.id} ${(job.title || '').slice(0, 20)}: ${error.message.slice(0, 60)}`);
      }
      await sleep(options.delayMs);
    }
    console.log(`\n===== 核验完成：${scoped.length} 个，已关闭 ${closed}，招聘中 ${active}，失败 ${failed} =====`);
    if (closedList.length) {
      console.log('本次识别为已关闭的岗位：');
      for (const c of closedList) console.log(`  #${c.id} ${c.title} (${c.status})`);
    }
  } finally {
    await releaseSession(session, { keepPage: true });
    releaseLock();
    process.removeListener('exit', releaseLock);
  }
}

main().catch(e => { console.error(e.stack || e.message); process.exit(1); });
