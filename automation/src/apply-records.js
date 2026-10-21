#!/usr/bin/env node
/**
 * 猎聘「我的投递」反馈记录抓取器（含未匹配岗位补录）
 *
 * 用法: node src/apply-records.js [--dry-run] [--no-supplement]
 *
 * 数据源: https://c.liepin.com/job/record/apply（Ant Design 分页，每页 20 条）
 *
 * 流程：
 *   1. 提取投递反馈记录（岗位链接 + 反馈状态 + 时间），按链接匹配库内岗位
 *   2. 已匹配 → POST /api/apply-records/import 更新反馈 + 写 system 沟通消息
 *   3. 未匹配（网站推荐直接投递、未入库的岗位）→ 补录：
 *        a. 用项目采集适配器完整爬取岗位详情（field-quality 校验）
 *        b. 按入库标准写入 jobs（跳过 screening——用户已人工投递，人工决策优先）
 *        c. 回填投递反馈 + 状态置为已沟通（contacted）
 *        d. 备注写入进度结论（网站推荐直接投递/投递反馈）
 *        e. 抓取沟通记录（chat.js）
 */
const path = require('path');
const { spawn } = require('child_process');
const { connectOrLaunch, releaseSession } = require('./browser');
const { TrackerApi } = require('./api');
const { detailToPayload } = require('./job-payload');
const { reviewDetail } = require('./field-quality');
const { acquireBrowserLock, isInterception } = require('./access-budget');
const { waitForLiepinSecurity, humanizeLiepinVisit } = require('./chat');

const ROOT = path.resolve(__dirname, '..', '..');
const APPLY_URL = 'https://c.liepin.com/job/record/apply';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const randomBetween = (min, max) => min + Math.floor(Math.random() * (max - min + 1));

function pacingOptions(argv) {
  let min = 18000;
  let max = 30000;
  for (const arg of argv) {
    if (arg.startsWith('--delay-min=')) min = Number(arg.split('=')[1]);
    if (arg.startsWith('--delay-max=')) max = Number(arg.split('=')[1]);
  }
  if (max < min) throw new Error('--delay-max 不能小于 --delay-min');
  return { min, max };
}

function extractRecords(page) {
  return page.evaluate(() => {
    const TIME_RE = /(\d{4}-\d{2}-\d{2} \d{2}:\d{2})$/;
    const links = [...document.querySelectorAll('a[href*="liepin.com/job/"], a[href*="liepin.com/a/"]')];
    const seen = new Set();
    const records = [];
    for (const a of links) {
      const href = a.href.split('?')[0];
      if (seen.has(href)) continue;
      // 向上找记录容器（含反馈状态与时间的最近祖先）
      let el = a;
      let container = null;
      for (let i = 0; i < 6 && el.parentElement; i += 1) {
        el = el.parentElement;
        const t = el.innerText || '';
        if (/(已查看|暂不合适|不合适|面试邀约|已投递|已下线)/.test(t) && /20\d\d-\d\d-\d\d \d{2}:\d{2}/.test(t)) {
          container = el;
          break;
        }
      }
      if (!container) continue;
      seen.add(href);
      const text = (container.innerText || '').replace(/\s+/g, ' ').trim();
      const title = (a.innerText || '').trim().split('\n')[0].trim() || text.split('【')[0].trim();
      const timeM = text.match(TIME_RE);
      const feedbackM = timeM ? text.slice(0, timeM.index).trim().match(/(\S+)$/) : null;
      const feedback = feedbackM ? feedbackM[1] : '';
      const feedbackAt = timeM ? timeM[1] : '';
      if (feedback && feedbackAt) records.push({ url: href, title, feedback, feedback_at: feedbackAt });
    }
    return records;
  });
}

function runChatScraper(source, jobId) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'chat.js'), '--source', source, '--job-id', String(jobId)], {
      cwd: __dirname, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TRACKER_BROWSER_LOCK_HELD: '1' }
    });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    child.on('close', (code) => {
      let parsed = null;
      try {
        const start = out.indexOf('{');
        const end = out.lastIndexOf('}');
        if (start >= 0 && end > start) parsed = JSON.parse(out.slice(start, end + 1));
      } catch (_) {}
      resolve({ code, parsed });
    });
  });
}

async function supplementJob(api, session, rec) {
  /** 未匹配岗位补录：完整爬取 → 入库 → 反馈 → 已沟通 → 备注 → 沟通记录 */
  const adapter = require('./adapters/liepin');
    await api.reserveAutomationBudget('liepin', 'detail_opens');
  console.log(`\n补录: ${rec.title} ${rec.url.slice(0, 60)}`);
  // 回到投递页，避免残留页面状态
  await session.page.goto(APPLY_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await sleep(2000);
  try {
    // a) 完整爬取详情（沿用采集适配器：风控检测/人类化节奏/字段提取；加超时保护）
    //    个别页面 mousemove 处理异常会导致 detail() 挂死 → 超时后改用轻量提取兜底
    let rawDetail;
    try {
      rawDetail = await Promise.race([
        adapter.detail(session.page, { url: rec.url }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('详情爬取超时(90s)')), 90000)),
      ]);
    } catch (detailError) {
      if (!/超时/.test(detailError.message)) throw detailError;
      console.log('  详情爬取超时，改用轻量提取兜底');
      rawDetail = await adapter.extractJobDetail(session.page, rec.url);
    }
    // 岗位页读不到标题/公司时（如已暂停招聘），用投递记录里的信息兜底
    rawDetail.title ||= rec.title || '';
    rawDetail.company ||= rec.company || '';
    const { detail, quality } = reviewDetail('liepin', rawDetail, new Date(), { context: 'chat' });
    // b) 入库（人工已投递，跳过 screening；field-quality 结论写入 metadata）
    const stored = await api.ingestJob(detailToPayload('liepin', detail));
    console.log(`  已入库 #${stored.id}（质量 ${quality.status}）`);
    // c) 回填投递反馈（创建投递记录 + system 沟通消息）
    await api.request('/api/apply-records/import', {
      method: 'POST',
      body: JSON.stringify({ records: [{ url: rec.url, title: rec.title, feedback: rec.feedback, feedback_at: rec.feedback_at }] }),
    });
    // d) 状态置为已沟通 + 备注进度结论
    await api.request(`/api/jobs/${stored.id}/application`, {
      method: 'PATCH', body: JSON.stringify({ status: 'contacted' }),
    });
    const note = `网站推荐直接投递补录；${rec.feedback ? `投递反馈：${rec.feedback}（${rec.feedback_at}）` : '待反馈'}`;
    await api.request(`/api/jobs/${stored.id}`, {
      method: 'PATCH', body: JSON.stringify({ user_notes: note }),
    });
    // e) 抓取沟通记录
    const chatResult = await runChatScraper('liepin', stored.id);
    console.log(`  沟通记录: ${chatResult.parsed ? `消息 ${chatResult.parsed.messageCount} chat_state=${chatResult.parsed.chatState}` : `退出码 ${chatResult.code}`}`);
    return stored.id;
  } catch (error) {
    if (isInterception(error)) await api.request('/api/automation/budget', { method: 'POST', body: JSON.stringify({ action: 'intercept', platform: 'liepin', message: error.message }) }).catch(() => {});
    if (isInterception(error) || /409 .*budget|预算已用尽|冷却中/.test(error.message)) throw error;
    console.log(`  补录失败: ${error.message}`);
    return null;
  }
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const noSupplement = process.argv.includes('--no-supplement');
  const pacing = pacingOptions(process.argv.slice(2));
  const api = new TrackerApi(process.env.TRACKER_API_URL || 'http://127.0.0.1:8888', process.env.TRACKER_API_TOKEN || '');
  await api.assertAutomationAvailable('liepin');
  const releaseLock = acquireBrowserLock('chat-sync');
  process.once('exit', releaseLock);
  const session = await connectOrLaunch({
    source: 'liepin', port: 18800,
    profileDir: process.env.JOB_TRACKER_BROWSER_PROFILE || path.join(ROOT, 'data', 'browser-profile'),
    chromePath: process.env.CHROME_PATH || '/usr/bin/google-chrome-stable'
  });
  try {
    await session.page.setViewport({ width: 1440, height: 900 });
    // 猎聘 lp-security 风控：注入反检测（webdriver 清除等），否则页面被 JS 清空为 about:blank
    await session.page.goto(APPLY_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await sleep(6000);
    await waitForLiepinSecurity(session.page, APPLY_URL,
      Number(process.env.LIEPIN_SECURITY_TIMEOUT_MINUTES || 20));
    await humanizeLiepinVisit(session.page);
    for (let i = 0; i < 6; i += 1) {
      await session.page.evaluate(() => window.scrollBy(0, 1500));
      await sleep(1200);
    }
    let records = await extractRecords(session.page);
    const totalPages = await session.page.evaluate(() => {
      const items = [...document.querySelectorAll('.ant-pagination-item')];
      const nums = items.map(el => Number((el.innerText || '').trim())).filter(n => !Number.isNaN(n));
      return nums.length ? Math.max(...nums) : 1;
    }).catch(() => 1);
    console.log(`投递反馈第 1 页：${records.length} 条，共 ${totalPages} 页`);
    for (let pageNo = 2; pageNo <= totalPages; pageNo += 1) {
      const clicked = await session.page.evaluate(() => {
        const next = document.querySelector('.ant-pagination-next:not(.ant-pagination-disabled)');
        if (!next) return false;
        next.click();
        return true;
      }).catch(() => false);
      if (!clicked) break;
      await sleep(randomBetween(pacing.min, pacing.max));
      await waitForLiepinSecurity(session.page, APPLY_URL,
        Number(process.env.LIEPIN_SECURITY_TIMEOUT_MINUTES || 20));
      const more = await extractRecords(session.page);
      const before = records.length;
      for (const r of more) {
        if (!records.some(x => x.url === r.url)) records.push(r);
      }
      console.log(`投递反馈第 ${pageNo} 页：本页 ${more.length} 条，累计 ${records.length} 条`);
      if (records.length === before) break;
    }
    console.log(`提取投递反馈记录 ${records.length} 条`);
    if (dryRun) {
      for (const r of records) console.log(`  [${r.feedback}] ${r.feedback_at} ${r.title.slice(0, 30)} ${r.url.slice(0, 55)}`);
      return;
    }
    const result = await api.request('/api/apply-records/import', {
      method: 'POST', body: JSON.stringify({ records })
    });
    console.log(`匹配 ${result.matched_count} / 未匹配 ${result.unmatched_count}`);
    if (noSupplement || result.unmatched_count === 0) return;
    // 补录未匹配岗位
    const supplemented = [];
    for (const rec of result.unmatched) {
      const id = await supplementJob(api, session, rec);
      if (id) supplemented.push(id);
      await sleep(5000);
    }
    console.log(`\n补录完成：${supplemented.length}/${result.unmatched_count} 个岗位`);
  } catch (error) {
    if (isInterception(error)) await api.request('/api/automation/budget', { method: 'POST', body: JSON.stringify({ action: 'intercept', platform: 'liepin', message: error.message }) }).catch(() => {});
    throw error;
  } finally {
    await releaseSession(session).catch(() => {});
    releaseLock();
    process.removeListener('exit', releaseLock);
  }
}

if (require.main === module) {
  main().catch(e => { console.error(e.stack || e.message); process.exit(1); });
}

module.exports = { pacingOptions };
