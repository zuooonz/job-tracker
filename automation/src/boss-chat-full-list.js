#!/usr/bin/env node
/**
 * 从 BOSS 沟通中心逐会话提取完整历史。
 *
 * 关键约束：
 * - 不刷新、不关闭、不重启浏览器；页面失去响应时保存检查点并停止。
 * - 每次 page.evaluate 只做一个同步动作。会话切换可能更新路由，绝不在
 *   触发切换的同一次 evaluate 中等待或读取 DOM。
 * - 用 encryptJobId 校验虚拟列表、selectedFriend 和 conversation 三层状态。
 * - 只做非破坏性合并，不以当前 DOM 覆盖已有聊天历史。
 */
const fs = require('fs');
const path = require('path');
const { attachCdpPages } = require('./cdp-page');
const { connectCdpBrowser } = require('./cdp-connection');
const { TrackerApi } = require('./api');
const { acquireBrowserLock, isInterception } = require('./access-budget');
const { loadJobIndex, normalizeTime } = require('./chat-shared');

const ROOT = path.resolve(__dirname, '..', '..');
const RUN_DIR = path.join(ROOT, 'data', 'chat-runs');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function parseArgs(argv) {
  const out = {
    limit: 0,
    offset: 0,
    switchDelayMs: 4000,
    itemDelayMs: 700,
    readyTimeoutMs: 15000,
    maxAttempts: 2,
    historyRounds: 12,
    historySettleMs: 800,
    resumeFile: '',
    dryRun: false,
    supplement: false,
    supplementLimit: 0,
    detailDelayMinMs: 9000,
    detailDelayMaxMs: 15000,
    detailBatchSize: 10,
    detailBatchBreakMs: 60000,
    freezeCooldownMs: 180000,
    // 实测（2026-10）：BOSS 详情访问间隔低于约 5 秒、连续 20 余次会被降级变卡；
    // 默认从 9 秒起自适应：连续成功缓慢提速，变卡则翻倍放慢。
    adaptive: true,
  };
  for (const arg of argv) {
    if (arg.startsWith('--limit=')) out.limit = Number(arg.split('=')[1]);
    else if (arg.startsWith('--offset=')) out.offset = Number(arg.split('=')[1]);
    else if (arg.startsWith('--switch-delay=')) out.switchDelayMs = Number(arg.split('=')[1]);
    else if (arg.startsWith('--item-delay=')) out.itemDelayMs = Number(arg.split('=')[1]);
    else if (arg.startsWith('--ready-timeout=')) out.readyTimeoutMs = Number(arg.split('=')[1]);
    else if (arg.startsWith('--attempts=')) out.maxAttempts = Number(arg.split('=')[1]);
    else if (arg.startsWith('--history-rounds=')) out.historyRounds = Number(arg.split('=')[1]);
    else if (arg.startsWith('--history-settle=')) out.historySettleMs = Number(arg.split('=')[1]);
    else if (arg.startsWith('--resume-file=')) out.resumeFile = arg.slice('--resume-file='.length);
    else if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--supplement') out.supplement = true;
    else if (arg.startsWith('--supplement-limit=')) out.supplementLimit = Number(arg.split('=')[1]);
    else if (arg.startsWith('--detail-delay-min=')) out.detailDelayMinMs = Number(arg.split('=')[1]);
    else if (arg.startsWith('--detail-delay-max=')) out.detailDelayMaxMs = Number(arg.split('=')[1]);
    else if (arg.startsWith('--detail-batch-size=')) out.detailBatchSize = Number(arg.split('=')[1]);
    else if (arg.startsWith('--detail-batch-break=')) out.detailBatchBreakMs = Number(arg.split('=')[1]);
    else if (arg.startsWith('--freeze-cooldown=')) out.freezeCooldownMs = Number(arg.split('=')[1]);
    else if (arg === '--adaptive') out.adaptive = true;
    else if (arg === '--fixed-delay') out.adaptive = false;
    // 兼容曾经暴露的参数，但新版始终逐条处理，不再创建批次级故障域。
    else if (arg.startsWith('--batch-size=')) out.ignoredBatchSize = Number(arg.split('=')[1]);
  }
  for (const key of ['limit', 'offset', 'switchDelayMs', 'itemDelayMs', 'readyTimeoutMs',
    'maxAttempts', 'historyRounds', 'historySettleMs']) {
    if (!Number.isFinite(out[key]) || out[key] < 0) throw new Error(`INVALID_OPTION:${key}`);
  }
  out.maxAttempts = Math.max(1, Math.floor(out.maxAttempts));
  return out;
}

function timeoutError(label, ms) {
  const error = new Error(`${label}_TIMEOUT:${ms}`);
  error.code = `${label}_TIMEOUT`;
  return error;
}

async function withTimeout(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(timeoutError(label, ms)), ms); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function errorText(error) {
  return String(error?.message || error || '').slice(0, 500);
}

function isTransientContextError(error) {
  return /Execution context was destroyed|Cannot find context|detached Frame|navigation/i.test(errorText(error));
}

function isPageFatalError(error) {
  return /Target closed|Session closed|Page closed|PAGE_EVALUATE_TIMEOUT|BOSS_CHAT_LIST_READY_TIMEOUT|browser has disconnected/i.test(errorText(error));
}

async function evaluate(page, fn, arg, timeoutMs = 4000) {
  if (!page || page.isClosed()) throw new Error('BOSS_CHAT_PAGE_CLOSED');
  return withTimeout(page.evaluate(fn, arg), timeoutMs, 'PAGE_EVALUATE');
}

async function pageReady(page) {
  return evaluate(page, () => ({
    url: location.href,
    ready: !!document.querySelector('.user-list-content')?.__vue__?.dataSources,
  }), null, 2000).catch(() => ({ url: page.url(), ready: false }));
}

async function waitForChatReady(page, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (page.isClosed()) throw new Error('BOSS_CHAT_PAGE_CLOSED');
    const state = await pageReady(page);
    if (state.url.includes('/web/geek/chat') && state.ready) return page;
    await sleep(250);
  }
  throw timeoutError('BOSS_CHAT_LIST_READY', timeoutMs);
}

async function findReadyChatPage(browser, timeoutMs = 15000) {
  // 只附着已打开的“消息”标签；用低特征 CDP 会话，不触发站点对 Runtime.enable 的检测。
  const pages = await attachCdpPages(browser, url => url.includes('/web/geek/chat'));
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const page of pages) {
      const state = await pageReady(page);
      if (state.ready) return page;
    }
    await sleep(500);
  }
  throw new Error('BOSS_CHAT_LIST_NOT_READY：请保持 BOSS“消息”页打开；脚本不会替你刷新或重启浏览器');
}

async function readListState(page) {
  return evaluate(page, () => {
    const virtual = document.querySelector('.user-list-content')?.__vue__;
    const list = virtual?.$parent;
    return {
      ready: !!virtual?.dataSources,
      length: virtual?.dataSources?.length || 0,
      hasMore: !!list?.hasMore$,
      loading: Number(list?.loading$ || 0),
    };
  });
}

async function listTargets(page) {
  let unchangedRounds = 0;
  let previousLength = -1;
  for (let pageNo = 0; pageNo < 20; pageNo += 1) {
    await waitForChatReady(page);
    const before = await readListState(page);
    if (!before.ready) throw new Error('BOSS_CHAT_LIST_NOT_READY');
    if (!before.hasMore) break;
    if (before.loading === 0) {
      // 只触发加载，立即退出页面上下文。
      await evaluate(page, () => {
        const list = document.querySelector('.user-list-content')?.__vue__?.$parent;
        if (list?.hasMore$ && Number(list.loading$ || 0) === 0) list.loadMore();
        return true;
      });
    }
    const deadline = Date.now() + 8000;
    let after = before;
    while (Date.now() < deadline) {
      await sleep(300);
      after = await readListState(page).catch(error => {
        if (isTransientContextError(error)) return before;
        throw error;
      });
      if (after.length > before.length || !after.hasMore) break;
    }
    if (after.length === previousLength || after.length === before.length) unchangedRounds += 1;
    else unchangedRounds = 0;
    previousLength = after.length;
    if (after.hasMore && unchangedRounds >= 2) {
      throw new Error(`BOSS_CHAT_LIST_LOAD_STALLED:${after.length}`);
    }
  }
  const finalState = await readListState(page);
  if (finalState.hasMore) throw new Error(`BOSS_CHAT_LIST_INCOMPLETE:${finalState.length}`);
  return evaluate(page, () => {
    const rows = document.querySelector('.user-list-content')?.__vue__?.dataSources || [];
    return rows.filter(row => row?.encryptJobId && !row.isFiltered).map(row => ({
      name: row.name || '',
      title: row.title || '',
      brand: row.brandName || '',
      encryptJobId: row.encryptJobId,
    }));
  });
}

async function scrollToTarget(page, encryptJobId) {
  return evaluate(page, jobId => {
    const container = document.querySelector('.user-list-content');
    const virtual = container?.__vue__;
    const rows = virtual?.dataSources || [];
    const index = rows.findIndex(row => row?.encryptJobId === jobId);
    if (index < 0) return { ok: false, status: 'target-not-in-list' };
    if (typeof virtual.scrollToIndex === 'function') {
      virtual.scrollToIndex(index);
      virtual.$el?.dispatchEvent(new Event('scroll', { bubbles: true }));
      if (typeof virtual.onScroll === 'function') virtual.onScroll({ target: virtual.$el });
    } else {
      container.scrollTop = Math.max(0, index * 78 - 120);
      container.dispatchEvent(new Event('scroll', { bubbles: true }));
    }
    return { ok: true, index };
  }, encryptJobId);
}

async function waitForRenderedRow(page, encryptJobId, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await evaluate(page, jobId => [...document.querySelectorAll('.friend-content-warp')]
      .some(el => el.__vue__?.source?.encryptJobId === jobId), encryptJobId, 2000)
      .catch(error => {
        if (isTransientContextError(error)) return false;
        throw error;
      });
    if (found) return true;
    await sleep(150);
  }
  return false;
}

async function triggerConversation(page, encryptJobId) {
  // 像人一样点击会话行。直接调用组件的 handleOpenChat，或发出 buttons=0 的点击事件，
  // 站点脚本会在打开会话后让页面卡住十几秒；带移动过程、按键状态正确的点击则即时响应。
  const box = await evaluate(page, jobId => {
    const row = [...document.querySelectorAll('.friend-content-warp')]
      .find(el => el.__vue__?.source?.encryptJobId === jobId);
    if (!row) return null;
    row.scrollIntoView({ block: 'center' });
    const r = row.getBoundingClientRect();
    return { x: r.x + r.width * (0.3 + Math.random() * 0.3), y: r.y + r.height * (0.35 + Math.random() * 0.3) };
  }, encryptJobId, 3000);
  if (!box) return { ok: false, status: 'row-not-rendered' };
  await sleep(150 + Math.random() * 250);
  if (page.isCdpPage) {
    const from = page.mousePosition || { x: 0, y: 0 };
    if (Math.hypot(from.x - box.x, from.y - box.y) < 5) await page.mouse.move(box.x - 80, box.y + 50);
    await page.mouse.move(box.x, box.y, { steps: 8 + Math.floor(Math.random() * 8) });
    await sleep(100 + Math.random() * 200);
  }
  await page.mouse.click(box.x, box.y, { delay: 50 + Math.random() * 60 });
  return { ok: true };
}

async function waitForConversation(page, encryptJobId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let stableSignature = '';
  let stableRounds = 0;
  while (Date.now() < deadline) {
    let state;
    try {
      state = await evaluate(page, jobId => {
        const list = document.querySelector('.user-list-content')?.__vue__?.$parent;
        const selected = list?.selectedFriend$;
        const conversation = list?.conversation$;
        const items = [...document.querySelectorAll('.message-item')];
        const last = items.at(-1)?.innerText?.trim() || '';
        return {
          selectedId: selected?.encryptJobId || '',
          conversationId: conversation?.encryptJobId || '',
          count: items.length,
          signature: `${items.length}|${last.slice(-80)}`,
          matches: selected?.encryptJobId === jobId && conversation?.encryptJobId === jobId,
        };
      }, encryptJobId, 2000);
    } catch (error) {
      if (isTransientContextError(error)) {
        await sleep(200);
        continue;
      }
      throw error;
    }
    if (state.matches) {
      if (state.signature === stableSignature) stableRounds += 1;
      else {
        stableSignature = state.signature;
        stableRounds = 1;
      }
      if (stableRounds >= 2) return state;
    }
    await sleep(250);
  }
  return null;
}

async function extractSelectedConversation(page, encryptJobId) {
  return evaluate(page, jobId => {
    const list = document.querySelector('.user-list-content')?.__vue__?.$parent;
    const selected = list?.selectedFriend$;
    const conversation = list?.conversation$;
    if (selected?.encryptJobId !== jobId || conversation?.encryptJobId !== jobId) {
      return {
        status: 'conversation-mismatch',
        selectedJobId: selected?.encryptJobId || '',
        conversationJobId: conversation?.encryptJobId || '',
        messages: [],
      };
    }
    const header = {
      contact: document.querySelector('.top-info-content .name-text')?.innerText?.trim() || '',
      position: document.querySelector('.top-info-content .position-name')?.innerText?.trim() || '',
    };
    const messages = [...document.querySelectorAll('.message-item')].map(el => {
      const cls = el.className || '';
      const content = el.querySelector('.text-content')?.innerText?.trim() || '';
      const statusCls = el.querySelector('.message-status')?.className || '';
      return {
        direction: cls.includes('item-myself') ? 'out' : 'in',
        content,
        sent_at: el.querySelector('.item-time .time')?.innerText?.trim() || '',
        read_status: statusCls.includes('status-read') ? 'read'
          : (statusCls.includes('status-delivery') ? 'unread' : 'unknown'),
        system: cls.includes('item-system'),
      };
    }).filter(msg => msg.content && !msg.system
      && !/发简历|换电话|换微信|按Enter键发送|PK情况|竞争者|查看详细分析|超过竞争者|送达|已读/.test(msg.content));
    return { status: 'ok', header, messages };
  }, encryptJobId);
}

async function historyState(page, encryptJobId, scrollToTop = false) {
  return evaluate(page, ({ jobId, shouldScroll }) => {
    const list = document.querySelector('.user-list-content')?.__vue__?.$parent;
    if (list?.conversation$?.encryptJobId !== jobId) return { matches: false };
    const items = [...document.querySelectorAll('.message-item')];
    let scroller = items[0]?.parentElement || null;
    while (scroller && scroller !== document.body) {
      const style = getComputedStyle(scroller);
      const scrollable = /(auto|scroll)/.test(style.overflowY)
        && scroller.scrollHeight > scroller.clientHeight + 2;
      if (scrollable) break;
      scroller = scroller.parentElement;
    }
    if (scroller === document.body) scroller = null;
    const clean = el => (el?.innerText || '').replace(/\s+/g, ' ').trim();
    const signature = `${items.length}|${clean(items[0]).slice(0, 120)}|${clean(items.at(-1)).slice(-120)}`;
    const beforeTop = scroller?.scrollTop || 0;
    if (shouldScroll && scroller) {
      scroller.scrollTop = 0;
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
    }
    return {
      matches: true,
      count: items.length,
      signature,
      hasScroller: !!scroller,
      beforeTop,
      scrollHeight: scroller?.scrollHeight || 0,
      clientHeight: scroller?.clientHeight || 0,
    };
  }, { jobId: encryptJobId, shouldScroll: scrollToTop });
}

async function loadEarlierMessages(page, encryptJobId, options) {
  let previous = '';
  let stableRounds = 0;
  for (let round = 1; round <= options.historyRounds; round += 1) {
    const before = await historyState(page, encryptJobId, true);
    if (!before.matches) return { complete: false, status: 'conversation-mismatch', rounds: round };
    await sleep(options.historySettleMs);
    const after = await historyState(page, encryptJobId, false);
    if (!after.matches) return { complete: false, status: 'conversation-mismatch', rounds: round };
    if (!after.hasScroller) return { complete: true, rounds: round, messageCount: after.count };
    if (after.signature === previous && after.beforeTop <= 1) stableRounds += 1;
    else stableRounds = 0;
    previous = after.signature;
    if (stableRounds >= 2) return { complete: true, rounds: round, messageCount: after.count };
  }
  const finalState = await historyState(page, encryptJobId, false);
  return {
    complete: false,
    status: 'history-load-incomplete',
    rounds: options.historyRounds,
    messageCount: finalState.count || 0,
  };
}

async function extractOne(page, target, options) {
  const positioned = await scrollToTarget(page, target.encryptJobId);
  if (!positioned.ok) return { ...target, status: positioned.status, messages: [] };
  if (!await waitForRenderedRow(page, target.encryptJobId)) {
    return { ...target, status: 'row-not-rendered', messages: [] };
  }
  const triggered = await triggerConversation(page, target.encryptJobId);
  if (!triggered.ok) return { ...target, status: triggered.status, messages: [] };
  const stable = await waitForConversation(page, target.encryptJobId, options.switchDelayMs);
  if (!stable) return { ...target, status: 'conversation-timeout', messages: [] };
  const history = await loadEarlierMessages(page, target.encryptJobId, options);
  if (!history.complete) return { ...target, status: history.status, history, messages: [] };
  const extracted = await extractSelectedConversation(page, target.encryptJobId);
  return { ...target, ...extracted, history };
}

function normalizeCapturedMessages(messages) {
  let fallback = '';
  return messages.map((msg, index) => {
    const sentAt = normalizeTime(msg.sent_at, fallback);
    if (sentAt) fallback = sentAt;
    return {
      direction: msg.direction,
      content: msg.content,
      content_type: 'text',
      sent_at: sentAt,
      read_status: msg.read_status,
      raw: { source: 'boss_chat_full_list', source_message_index: index },
    };
  });
}

function upsertReportResult(report, result) {
  const index = report.results.findIndex(row => row.encryptJobId === result.encryptJobId);
  if (index >= 0) report.results[index] = result;
  else report.results.push(result);
  return report;
}

function summarizeReport(report) {
  return report.results.reduce((summary, row) => {
    summary[row.status] = (summary[row.status] || 0) + 1;
    return summary;
  }, {});
}

function writeCheckpoint(file, report) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  report.updatedAt = new Date().toISOString();
  report.summary = summarizeReport(report);
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(report, null, 2));
  fs.renameSync(temporary, file);
}

function createReport(options) {
  if (options.resumeFile) {
    const file = path.resolve(options.resumeFile);
    const report = JSON.parse(fs.readFileSync(file, 'utf8'));
    report.resumedAt = new Date().toISOString();
    report.results = Array.isArray(report.results) ? report.results : [];
    return { file, report };
  }
  const collectedAt = new Date().toISOString();
  const file = path.join(RUN_DIR, `boss-chat-full-list-${collectedAt.replace(/[:.]/g, '-')}.json`);
  return {
    file,
    report: { collectedAt, mode: 'single-conversation-checkpointed', dryRun: options.dryRun, results: [] },
  };
}

async function persistConversation(api, target, extracted, options) {
  if (options.dryRun) return { imported: 0, dryRun: true };
  const messages = normalizeCapturedMessages(extracted.messages);
  return api.appendChat(target.job.id, {
    source: 'boss',
    sync_kind: 'full_history',
    messages,
  });
}

async function processTarget(page, api, target, options) {
  let last;
  for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
    try {
      await waitForChatReady(page, options.readyTimeoutMs);
      const extracted = await extractOne(page, target, options);
      last = extracted;
      if (extracted.status === 'ok') {
        const saved = await persistConversation(api, target, extracted, options);
        return {
          jobId: target.job.id,
          encryptJobId: target.encryptJobId,
          name: target.name,
          title: target.title,
          status: 'ok',
          attempts: attempt,
          messageCount: extracted.messages.length,
          historyRounds: extracted.history?.rounds || 0,
          imported: saved.imported || 0,
          dryRun: !!saved.dryRun,
        };
      }
    } catch (error) {
      last = { status: isPageFatalError(error) ? 'page-unresponsive' : 'extract-error', error: errorText(error) };
      if (isPageFatalError(error)) break;
    }
    if (attempt < options.maxAttempts) await sleep(600 * attempt);
  }
  return {
    jobId: target.job.id,
    encryptJobId: target.encryptJobId,
    name: target.name,
    title: target.title,
    status: last?.status || 'extract-error',
    attempts: options.maxAttempts,
    messageCount: last?.messages?.length || 0,
    error: last?.error || '',
    selectedJobId: last?.selectedJobId || '',
    conversationJobId: last?.conversationJobId || '',
    historyRounds: last?.history?.rounds || 0,
  };
}

/**
 * 补录沟通中涉及、但库里还没有的岗位：像人一样在消息页选中会话，点击会话顶部的
 * “查看职位”，在新开的详情标签里读取并入库，随后关闭该标签。不直接跳转详情页。
 */
async function selectConversation(chatPage, row, options) {
  const positioned = await scrollToTarget(chatPage, row.encryptJobId);
  if (!positioned.ok) throw new Error(positioned.status);
  if (!await waitForRenderedRow(chatPage, row.encryptJobId)) throw new Error('row-not-rendered');
  const triggered = await triggerConversation(chatPage, row.encryptJobId);
  if (!triggered.ok) throw new Error(triggered.status);
  if (!await waitForConversation(chatPage, row.encryptJobId, options.switchDelayMs)) throw new Error('conversation-timeout');
}

/** 会话已选中时，顺手读取完整聊天和会话顶部的岗位摘要（岗位名、薪资、城市）。 */
async function captureConversation(chatPage, row, options) {
  const history = await loadEarlierMessages(chatPage, row.encryptJobId, options);
  const extracted = history.complete
    ? await extractSelectedConversation(chatPage, row.encryptJobId)
    : { status: history.status, messages: [] };
  const raw = await evaluate(chatPage, () => (document.querySelector('.top-info-content')?.innerText || '')
    .replace(/\s+/g, ' ').trim()).catch(() => '');
  const salary = raw.match(/\d+(?:\.\d+)?-\d+(?:\.\d+)?[Kk万](?:·\d+薪)?|\d+-\d+元\/天/)?.[0] || '';
  const city = salary ? (raw.split(salary)[1] || '').trim().split(/\s+/)[0] || '' : '';
  return {
    ...extracted,
    history,
    summary: {
      position: extracted.header?.position || '',
      contact: extracted.header?.contact || row.name || '',
      salary,
      city: /查看职位/.test(city) ? '' : city,
      raw: raw.slice(0, 200),
    },
  };
}

async function openJobDetailTab(browser, chatPage, row) {
  const { waitForNewCdpPage, listPageTargetIds } = require('./cdp-page');
  await sleep(800 + Math.random() * 1200);
  const point = await evaluate(chatPage, () => {
    const els = [...document.querySelectorAll('a,span,div,button')]
      .filter(el => /^查看职位$/.test((el.innerText || '').trim()) && el.getBoundingClientRect().width > 0);
    const el = els[els.length - 1];
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2 + (Math.random() * 6 - 3), y: r.y + r.height / 2 + (Math.random() * 4 - 2) };
  });
  if (!point) throw new Error('view-job-link-missing');
  const before = await listPageTargetIds(browser);
  await chatPage.bringToFront();
  // 与点击会话行一致：先带轨迹移到“查看职位”，再按下抬起，不做瞬移点击
  await chatPage.mouse.move(point.x, point.y, { steps: 8 + Math.floor(Math.random() * 8) });
  await sleep(120 + Math.random() * 200);
  await chatPage.mouse.click(point.x, point.y, { delay: 50 + Math.random() * 60 });
  const detailPage = await waitForNewCdpPage(browser, url => url.includes(row.encryptJobId), { exclude: before, timeout: 15000 });
  if (!detailPage) throw new Error('detail-tab-not-opened');
  return detailPage;
}

/** 详情页打不开/被关闭时，用会话里的岗位摘要建一条记录，保证聊天有地方挂。 */
function detailFromConversation(row, conversation, url, reason) {
  return {
    url,
    title: conversation.summary.position || row.title || '',
    company: row.brand || '',
    salary: conversation.summary.salary,
    location: conversation.summary.city,
    recruiterName: conversation.summary.contact,
    recruiterTitle: row.title || '',
    listingStatus: '详情不可访问',
    isOffline: false,
    description: '',
    metadata: { detail_source: 'boss_conversation_summary', detail_error: reason },
  };
}

async function supplementJobs(browser, chatPage, api, rows, options, report) {
  const adapter = require('./adapters/boss');
  const { detailToPayload } = require('./job-payload');
  const { reviewDetail } = require('./field-quality');
  const todo = options.supplementLimit ? rows.slice(0, options.supplementLimit) : rows;
  const added = [];
  let consecutiveErrors = 0;
  let cooldowns = 0;
  let successStreak = 0;
  let adaptiveDelay = options.detailDelayMinMs;
  report.pacing = report.pacing || [];
  try {
    for (let i = 0; i < todo.length; i += 1) {
      const row = todo[i];
      const url = `https://www.zhipin.com/job_detail/${row.encryptJobId}.html`;
      const item = { encryptJobId: row.encryptJobId, name: row.name, brand: row.brand, url };
      let detailPage = null;
      try {
        // 1) 选中会话并读取聊天（一次进入，聊天和岗位都在这一轮完成）
        await api.reserveAutomationBudget('boss', 'chat_opens');
        await selectConversation(chatPage, row, options);
        const conversation = await captureConversation(chatPage, row, options);
        item.messageCount = conversation.messages?.length || 0;
        // 2) 点“查看职位”读取详情；失败时用会话摘要兜底入库
        let detail;
        let quality;
        try {
          await api.reserveAutomationBudget('boss', 'detail_opens');
          detailPage = await openJobDetailTab(browser, chatPage, row);
          const raw = await withTimeout(adapter.detail(detailPage, { url }, { alreadyLoaded: true }), 60000, 'BOSS_DETAIL');
          if (detailPage.url() === 'about:blank' || /\/web\/user|passport|safe\/verify|verify-slider/.test(detailPage.url())) {
            throw new Error(`BOSS_BLOCKED url=${detailPage.url()}`);
          }
          raw.title ||= conversation.summary.position;
          raw.company ||= row.brand || '';
          ({ detail, quality } = reviewDetail('boss', { ...raw, url }, new Date(), { context: 'chat' }));
        } catch (detailError) {
          if (/BOSS_BLOCKED|409 .*budget|预算已用尽|冷却中/.test(errorText(detailError))) throw detailError;
          item.detailError = errorText(detailError);
          ({ detail, quality } = reviewDetail('boss', detailFromConversation(row, conversation, url, item.detailError),
            new Date(), { context: 'chat' }));
          item.fallback = true;
        }
        item.title = detail.title;
        item.quality = quality.status;
        if (!detail.title) throw new Error('missing_title');
        if (!options.dryRun) {
          const stored = await api.ingestJob(detailToPayload('boss', detail));
          item.jobId = stored.id;
          await api.request(`/api/jobs/${stored.id}/application`, {
            method: 'PATCH', body: JSON.stringify({ status: 'contacted' }),
          }).catch(() => {});
          // 3) 聊天直接写入刚入库的岗位
          if (conversation.status === 'ok' && conversation.messages.length) {
            const saved = await persistConversation(api, { ...row, job: { id: stored.id } }, conversation, options);
            item.imported = saved.imported || 0;
          }
          added.push(row.encryptJobId);
        }
        item.status = options.dryRun ? 'dry-run' : (item.fallback ? 'ingested-summary' : 'ingested');
        // 详情兜底不算失败，不触发降级判断；但详情页打不开本身也可能是降级信号
        if (item.fallback && /timeout|TIMEOUT|not-opened/.test(item.detailError)) item.degradedSignal = true;
      } catch (error) {
        item.status = 'error';
        item.error = errorText(error);
      } finally {
        if (detailPage) await detailPage.close().catch(() => {});
      }
      report.supplement.push(item);
      writeCheckpoint(options.reportFile, report);
      console.log(`[BOSS补录] ${i + 1}/${todo.length} ${item.status} ${item.title || item.brand || ''} 消息${item.messageCount ?? '-'} ${item.error || item.detailError || ''}`);
      if (/BOSS_BLOCKED|about:blank|LOGIN|验证/.test(item.error || '')) {
        report.aborted = '补录时遇到登录墙或安全验证，已停止';
        break;
      }
      // 连续两个详情页失败通常是站点开始降级（页面卡死），立即停下冷却。
      consecutiveErrors = (item.status === 'error' || item.degradedSignal) ? consecutiveErrors + 1 : 0;
      if (consecutiveErrors >= 2) {
        // 页面被降级变卡：冷却后等消息页恢复响应再继续，连续 3 次冷却仍失败才停止。
        cooldowns += 1;
        if (cooldowns > 3) {
          report.aborted = '多次冷却后详情页仍然失败，疑似触发反爬降级，已停止';
          break;
        }
        // 自适应节奏：触发降级说明间隔太短，翻倍（上限 120 秒）。
        const before = adaptiveDelay;
        adaptiveDelay = Math.min(adaptiveDelay * 2, 120000);
        successStreak = 0;
        report.pacing.push({ at: new Date().toISOString(), event: 'freeze', fromMs: Math.round(before), toMs: Math.round(adaptiveDelay), index: i });
        console.log(`[BOSS补录] 页面变卡，冷却 ${Math.round(options.freezeCooldownMs / 1000)} 秒（第 ${cooldowns} 次）；间隔 ${Math.round(before / 1000)}s → ${Math.round(adaptiveDelay / 1000)}s`);
        await sleep(options.freezeCooldownMs);
        await waitForChatReady(chatPage, 60000).catch(() => {});
        consecutiveErrors = 0;
        i -= 2; // 重试刚才失败的两个岗位
        continue;
      }
      if (item.status !== 'error' && !item.degradedSignal) {
        cooldowns = 0;
        successStreak += 1;
        // 连续 8 个成功就把间隔缩短 20%（下限 5 秒），逐步逼近不触发降级的最短间隔。
        if (options.adaptive && successStreak >= 8 && adaptiveDelay > 5000) {
          const before = adaptiveDelay;
          adaptiveDelay = Math.max(5000, adaptiveDelay * 0.8);
          successStreak = 0;
          report.pacing.push({ at: new Date().toISOString(), event: 'speedup', fromMs: Math.round(before), toMs: Math.round(adaptiveDelay), index: i });
          console.log(`[BOSS补录] 连续成功，间隔 ${Math.round(before / 1000)}s → ${Math.round(adaptiveDelay / 1000)}s`);
        }
      }
      if (i + 1 < todo.length) {
        const base = options.adaptive ? adaptiveDelay
          : options.detailDelayMinMs + Math.random() * (options.detailDelayMaxMs - options.detailDelayMinMs);
        const pause = !options.adaptive && (i + 1) % options.detailBatchSize === 0
          ? options.detailBatchBreakMs
          : base * (0.8 + Math.random() * 0.4);
        await sleep(pause);
      }
    }
  } finally {
    await adapter.closeOcr?.().catch(() => {});
  }
  return added;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const api = new TrackerApi(process.env.TRACKER_API_URL || 'http://127.0.0.1:8888', process.env.TRACKER_API_TOKEN || '');
  await api.assertAutomationAvailable('boss');
  const releaseLock = acquireBrowserLock('chat-sync');
  process.once('exit', releaseLock);
  // 原生 CDP 连接：Puppeteer 的自动附着会挂起页面新建的 Worker，导致会话加载停滞
  const browser = await connectCdpBrowser({ port: Number(process.env.BOSS_CDP_PORT || 18800) });
  const { file: reportFile, report } = createReport(options);
  writeCheckpoint(reportFile, report);
  try {
    const page = await findReadyChatPage(browser, options.readyTimeoutMs);
    const siteTargets = await listTargets(page);
    let index = await loadJobIndex(api);
    const missing = siteTargets.filter(item => !index.byId.get(item.encryptJobId));
    report.missingCount = missing.length;
    report.supplement = report.supplement || [];
    if (options.supplement && missing.length) {
      options.reportFile = reportFile;
      const done = new Set(report.supplement.filter(row => String(row.status).startsWith('ingested')).map(row => row.encryptJobId));
      await supplementJobs(browser, page, api, missing.filter(row => !done.has(row.encryptJobId)), options, report);
      if (report.aborted) throw new Error(report.aborted);
      index = await loadJobIndex(api);
    }
    const matched = siteTargets.map(item => ({ ...item, job: index.byId.get(item.encryptJobId) }))
      .filter(item => item.job);
    const targets = options.limit
      ? matched.slice(options.offset, options.offset + options.limit)
      : matched.slice(options.offset);
    Object.assign(report, {
      siteCount: siteTargets.length,
      matchedCount: matched.length,
      targetCount: targets.length,
      offset: options.offset,
    });
    writeCheckpoint(reportFile, report);

    const completed = new Set(report.results.filter(row => row.status === 'ok').map(row => row.encryptJobId));
    // 补录时已顺手导入聊天的会话，不再重复进入
    for (const row of report.supplement || []) if (row.imported !== undefined) completed.add(row.encryptJobId);
    let processed = 0;
    let unresponsiveStreak = 0;
    for (const target of targets) {
      if (completed.has(target.encryptJobId)) continue;
      await api.reserveAutomationBudget('boss', 'chat_opens');
      const result = await processTarget(page, api, target, options);
      if (isInterception(new Error(result.error || ''))) {
        await api.request('/api/automation/budget', { method: 'POST', body: JSON.stringify({ action: 'intercept', platform: 'boss', message: result.error }) }).catch(() => {});
        report.aborted = `平台拦截，已记录冷却：${result.error}`;
        upsertReportResult(report, result); writeCheckpoint(reportFile, report); break;
      }
      if (/409 .*budget|预算已用尽|冷却中/.test(result.error || '')) { report.aborted = result.error; break; }
      upsertReportResult(report, result);
      processed += 1;
      report.processedThisRun = processed;
      writeCheckpoint(reportFile, report);
      console.log(`[BOSS完整历史] ${processed}/${targets.length} job=${target.job.id} status=${result.status} messages=${result.messageCount}`);
      if (result.status === 'page-unresponsive') {
        // 个别会话渲染很重会让单次求值超时：等页面恢复后跳过它继续；连续两个才停止。
        unresponsiveStreak += 1;
        if (unresponsiveStreak >= 2) {
          report.aborted = '页面失去响应；已保留标签页和检查点，请检查后使用 --resume-file 继续';
          writeCheckpoint(reportFile, report);
          break;
        }
        await waitForChatReady(page, 60000).catch(() => {});
      } else {
        unresponsiveStreak = 0;
      }
      await sleep(options.itemDelayMs);
    }
    if (!report.aborted) report.completedAt = new Date().toISOString();
    writeCheckpoint(reportFile, report);
    console.log(JSON.stringify({ ...summarizeReport(report), reportFile, aborted: report.aborted || '' }, null, 2));
    await api.reportAutomationRun('boss', 'chat', report.aborted ? 'failed' : 'completed', summarizeReport(report), report.aborted || '沟通同步完成');
  } catch (error) {
    if (isInterception(error)) await api.request('/api/automation/budget', { method: 'POST', body: JSON.stringify({ action: 'intercept', platform: 'boss', message: error.message }) }).catch(() => {});
    await api.reportAutomationRun('boss', 'chat', 'failed', {}, error.message).catch(() => {});
    report.aborted = '初始化或列表加载失败；未刷新或关闭浏览器';
    report.error = errorText(error);
    writeCheckpoint(reportFile, report);
    throw error;
  } finally {
    // 只断开 CDP；绝不关闭标签页或浏览器。
    browser.disconnect();
    releaseLock();
    process.removeListener('exit', releaseLock);
  }
}

if (require.main === module) main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});

module.exports = {
  parseArgs,
  isTransientContextError,
  isPageFatalError,
  normalizeCapturedMessages,
  upsertReportResult,
  summarizeReport,
};
