#!/usr/bin/env node
/**
 * 沟通记录抓取器
 *
 * 用法:
 *   node src/chat.js --source=liepin --job-id=118
 *
 * 流程:
 *   1. 打开岗位页（按 job-id 从本地 API 查 URL，或直接 --url）
 *   2. 找到「继续沟通/继续聊」并点击；从不点击「立即沟通/聊一聊」等会发起新对话的按钮
 *   3. 等待聊天 UI（BOSS 跳转到聊天页 / 猎聘弹出聊天弹窗）
 *   4. 滚动加载历史消息，提取 {发送方, 时间, 内容}
 *   5. 保存 data/chat-runs/<source>-<jobId>-<ts>.json
 *
 * 首次运行会附带 DOM 诊断快照，便于校准选择器；--keep-page 保留页面现场。
 */
const fs = require('fs');
const path = require('path');
const { connectOrLaunch, releaseSession, bestEffort } = require('./browser');
const { TrackerApi } = require('./api');
const { acquireBrowserLock, isInterception } = require('./access-budget');

const ROOT = path.resolve(__dirname, '..', '..');
const RUN_DIR = path.join(ROOT, 'data', 'chat-runs');

function parseArgs(argv) {
  const result = { source: null, jobId: null, url: null, keepPage: false, allowStart: false,
    securityTimeout: Number(process.env.LIEPIN_SECURITY_TIMEOUT_MINUTES || 20) };
  const valueOpts = new Set(['source', 'jobId', 'url', 'api', 'port', 'securityTimeout']);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--keep-page') result.keepPage = true;
    else if (arg.startsWith('--') && arg.includes('=')) {
      const [key, ...rest] = arg.slice(2).split('=');
      const norm = key.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      if (!valueOpts.has(norm)) throw new Error(`未知参数 --${key}`);
      result[norm] = rest.join('=');
    } else if (arg.startsWith('--')) {
      const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      if (!valueOpts.has(key)) throw new Error(`未知参数 --${key}`);
      result[key] = argv[++i];
    } else {
      throw new Error(`未知位置参数 ${arg}`);
    }
  }
  if (result.source !== 'liepin') throw new Error('此岗位页聊天入口仅用于猎聘；BOSS 请使用 chat-pipeline 消息页历史同步');
  if (!result.url && !result.jobId) throw new Error('需要 --job-id 或 --url');
  return result;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const randomRange = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

async function humanizeLiepinVisit(page) {
  // 复用猎聘详情采集器已经验证过的无导航动作；不盲点页面元素，避免误触发投递/新沟通。
  await sleep(randomRange(2500, 5000));
  const actions = ['mouse', 'scroll', 'pause'].sort(() => 0.5 - Math.random()).slice(0, 2);
  for (const action of actions) {
    if (action === 'mouse') {
      await bestEffort(page.mouse.move(randomRange(120, 900), randomRange(100, 650), {
        steps: randomRange(8, 18),
      }));
      await sleep(randomRange(700, 1800));
    } else if (action === 'scroll') {
      await bestEffort(page.evaluate(y => window.scrollTo({ top: y, behavior: 'smooth' }), randomRange(260, 850)));
      await sleep(randomRange(1800, 3800));
    } else {
      await sleep(randomRange(1800, 3800));
    }
  }
}

async function liepinSecurityState(page) {
  return page.evaluate(() => {
    const text = (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 500);
    const url = location.href;
    const challenged = /safe\.liepin\.com|captchaPage|\/captcha/i.test(url)
      || /安全验证|请完成验证|拖动滑块|验证码/.test(text);
    return { challenged, url, text: text.slice(0, 120) };
  }).catch(() => ({ challenged: false, url: page.url(), text: '' }));
}

async function waitForLiepinSecurity(page, targetUrl, timeoutMinutes) {
  let state = await liepinSecurityState(page);
  if (!state.challenged) return false;
  const headed = String(process.env.BROWSER_MODE || '').toLowerCase() === 'headed';
  if (!headed) throw new Error(`LIEPIN_SECURITY_CHALLENGE url=${state.url.slice(0, 120)}`);
  console.log(`\n[猎聘安全验证] 已暂停当前岗位，请在置前的猎聘工作标签完成验证（最多等待 ${timeoutMinutes} 分钟）。`);
  await page.bringToFront().catch(() => {});
  const deadline = Date.now() + timeoutMinutes * 60000;
  while (Date.now() < deadline) {
    await sleep(3000);
    state = await liepinSecurityState(page);
    if (!state.challenged) {
      console.log('[猎聘安全验证] 验证页已解除，正在重试当前岗位。');
      if (!/liepin\.com\/(job|a)\//.test(state.url)) {
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
      }
      await sleep(5000);
      const retryState = await liepinSecurityState(page);
      if (retryState.challenged) continue;
      return true;
    }
  }
  throw new Error(`LIEPIN_SECURITY_CHALLENGE_TIMEOUT ${timeoutMinutes}min url=${state.url.slice(0, 120)}`);
}

// 平台聊天按钮候选文本（已沟通→继续，未沟通→开始）
const BUTTON_TEXTS = { liepin: ['继续聊', '聊一聊', '立即沟通'] };

// 聊天容器 / 消息元素的候选选择器（按登录后的真实 DOM 逐步校准）
const CHAT_CONTAINER_HINTS = [
  '[class*="chat"]', '[class*="message"]', '[class*="msg"]', '[class*="conversation"]'
];

async function findAndClickChatButton(page, source, { allowStart = false } = {}) {
  const texts = BUTTON_TEXTS[source];
  const found = await page.evaluate((texts) => {
    const els = [...document.querySelectorAll('a,button,div,span')];
    for (const t of texts) {
      const hit = els.find(el => (el.innerText || '').trim() === t && el.offsetParent !== null);
      if (hit) return { tag: hit.tagName, cls: hit.className?.toString().slice(0, 80), text: hit.innerText.trim(), found: t };
    }
    return null;
  }, texts);
  if (!found) return null;
  // 只恢复已有对话（继续聊/继续沟通）；开始新对话的按钮（聊一聊/立即沟通）会向招聘者发出消息，一律不点击。
  const START_TEXTS = new Set(['立即沟通', '聊一聊']);
  if (!allowStart && START_TEXTS.has(found.text)) {
    return { ...found, skipped: true, reason: '开始型按钮（可能发送消息），未点击' };
  }
  // 受信点击语义化元素（A/BUTTON）——合成点击/包裹层点击无法触发 BOSS 跳转，
  // 且可能点到外层导致显示错误会话。
  // 注意：puppeteer 的 elementHandle.click() 内部 scrollIntoView 在 BOSS 页面会挂起
  // （与聊天列表同因），改用「evaluate 取坐标 + page.mouse.click」坐标点击。
  const box = await Promise.race([
    page.evaluate((text) => {
      const all = [...document.querySelectorAll('a,button,div,span')];
      const exact = all.filter(el => (el.innerText || '').trim() === text && el.offsetParent !== null);
      const target = exact.find(el => el.tagName === 'A' || el.tagName === 'BUTTON') || exact[0];
      if (!target) return null;
      target.scrollIntoView({ block: 'center' });
      const r = target.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }, found.text).catch(() => null),
    sleep(5000).then(() => null),
  ]);
  if (box) {
    await new Promise(r => setTimeout(r, 400));
    await bestEffort(page.mouse.click(box.x, box.y).catch(() => {}), 5000);
  }
  return found;
}

async function waitForChatUi(page, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const state = await page.evaluate(() => {
      const url = location.href;
      const chatish = /chat|message|msg|geek|dialog|modal|layui-layer/i.test(url);
      const modal = [...document.querySelectorAll('[class*="chat"], [class*="dialog"], [class*="modal"], .layui-layer')]
        .find(el => el.offsetParent !== null && el.innerText.length > 50);
      const liepinChat = !!document.querySelector('.im-ui-chat-modal-container');
      const hasChatText = /继续沟通|继续聊|发送|已读|打招呼/.test(document.body?.innerText || '');
      return { url, chatish, hasChatText, modalFound: !!modal, liepinChat, modalText: modal?.innerText.slice(0, 80) };
    });
    if (state.liepinChat) return state;
    if (state.hasChatText && state.modalFound) return state;
    await sleep(1000);
  }
  return null;
}

function scrollChatContainer(page) {
  return page.evaluate(() => {
    const candidates = ['.im-ui-chat-modal-container', '.im-ui-message-list', '[class*="message-list"]'];
    for (const sel of candidates) {
      const el = document.querySelector(sel);
      if (el && el.scrollHeight > el.clientHeight) {
        el.scrollTop = el.scrollHeight;
        return true;
      }
    }
    return false;
  });
}

function extractLiepinMessages(page) {
  return page.evaluate(() => {
    const items = [...document.querySelectorAll('.im-ui-message-item-wrapper')];
    const SKIP = /发简历|交换手机号|交换微信号|立即体验|去修改|优先沟通|举报|安全防范/;
    const messages = [];
    for (const el of items) {
      const time = el.querySelector('.im-ui-system-tip.format-time')?.innerText?.trim() || '';
      const isSystem = !!el.querySelector('.im-ui-system-tip:not(.format-time)');
      const card = el.querySelector('.im-ui-common-message-card') || el.querySelector('.im-ui-message-item-body');
      // 克隆卡片并剔除阅读状态等 UI 文本
      const cleanCard = card ? card.cloneNode(true) : null;
      if (cleanCard) {
        cleanCard.querySelectorAll('.im-ui-message-read-status, .im-ui-message-item-extra-info, .im-ui-message-item-status')
          .forEach(n => n.remove());
      }
      let text = (cleanCard?.innerText || card?.innerText || '').replace(/\s+/g, ' ').trim();
      text = text.replace(/(未读|已读)$/, '').trim();
      // 阅读状态：我方发出消息 = 对方是否已读（核心信号）
      const readEl = el.querySelector('.im-ui-message-read-status, .im-ui-message-item-extra-info');
      const readText = readEl?.innerText?.trim() || '';
      const readStatus = /已读/.test(readText) ? 'read' : (/未读/.test(readText) ? 'unread' : 'unknown');
      if (isSystem) {
        if (text && !SKIP.test(text)) messages.push({ type: 'system', time, text: text.slice(0, 400) });
        continue;
      }
      if (!text || SKIP.test(text)) continue;
      const saveStatus = card?.getAttribute('enumsavestatus') || '';
      const sender = saveStatus === 'SENDER' || el.querySelector('.im-ui-message-item-send') ? 'me' : 'other';
      messages.push({ type: 'message', sender, time, readStatus, text: text.slice(0, 800) });
    }
    return { messageCount: messages.length, messages };
  });
}

async function extractMessages(page) {
  return extractLiepinMessages(page);
}

// 时间归一化：猎聘页面时间是「昨天 19:04」「16:57」等相对格式，转为 ISO 便于排序/判定已读未回
function normalizeTime(raw) {
  if (!raw) return '';
  const now = new Date();
  let m;
  if ((m = raw.match(/^(\d{1,2}):(\d{2})$/))) {
    const d = new Date(now); d.setHours(+m[1], +m[2], 0, 0); return d.toISOString();
  }
  if (raw.includes('昨天')) {
    const t = raw.match(/(\d{1,2}):(\d{2})/);
    const d = new Date(now); d.setDate(d.getDate() - 1);
    if (t) d.setHours(+t[1], +t[2], 0, 0);
    return d.toISOString();
  }
  if (raw.includes('今天')) {
    const t = raw.match(/(\d{1,2}):(\d{2})/);
    const d = new Date(now);
    if (t) d.setHours(+t[1], +t[2], 0, 0);
    return d.toISOString();
  }
  if ((m = raw.match(/(\d{4})-(\d{2})-(\d{2})/))) {
    return new Date(+m[1], +m[2] - 1, +m[3]).toISOString();
  }
  if ((m = raw.match(/^(\d{2})-(\d{2}) (\d{1,2}):(\d{2})$/))) {
    return new Date(now.getFullYear(), +m[1] - 1, +m[2], +m[3], +m[4]).toISOString();
  }
  // 中文日期：8月16日 07:31（年份取今年；日期在未来则视为去年）
  if ((m = raw.match(/(\d{1,2})月(\d{1,2})日\s*(\d{1,2}):(\d{2})/))) {
    let year = now.getFullYear();
    const d = new Date(year, +m[1] - 1, +m[2], +m[3], +m[4]);
    if (d.getTime() > now.getTime()) { year -= 1; d.setFullYear(year); }
    return d.toISOString();
  }
  return raw;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  fs.mkdirSync(RUN_DIR, { recursive: true });

  const api = new TrackerApi(process.env.TRACKER_API_URL || 'http://127.0.0.1:8888', process.env.TRACKER_API_TOKEN || '');
  await api.assertAutomationAvailable(options.source);
  let url = options.url;
  let job = null;
  if (options.jobId) {
    const resp = await api.getJob(options.jobId);
    const jobData = resp?.job || resp;
    job = jobData;
    url = jobData?.url || url;
    if (!url) throw new Error(`job #${options.jobId} 没有 URL`);
  }

  const releaseLock = process.env.TRACKER_BROWSER_LOCK_HELD === '1' ? () => {} : acquireBrowserLock('chat-sync');
  process.once('exit', releaseLock);
  const session = await connectOrLaunch({ source: options.source, port: 18800,
    profileDir: process.env.JOB_TRACKER_BROWSER_PROFILE || path.join(ROOT, 'data', 'browser-profile'),
    chromePath: process.env.CHROME_PATH || '/usr/bin/google-chrome-stable' });
  // 猎聘 lp-security 会检测自动化特征并将页面清空为 about:blank；
  // 保持爬虫原始设置：不干预视口/窗口，页面自然铺满浏览器窗口
  let failed = false;
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  try {
    await api.reserveAutomationBudget(options.source, 'detail_opens');
    await session.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await sleep(4000);
    if (options.source === 'liepin') {
      await waitForLiepinSecurity(session.page, url, Number(options.securityTimeout));
      await humanizeLiepinVisit(session.page);
    }

    const before = await session.page.evaluate(() => ({
      url: location.href,
      title: document.title.slice(0, 60),
      loggedIn: !/登录\/注册/.test(document.body?.innerText?.slice(0, 300) || '')
    }));
    if (!before.loggedIn) throw new Error(`LIEPIN_BLOCKED 登录页 url=${before.url}`);

    await api.reserveAutomationBudget(options.source, 'chat_opens');
    const btn = await findAndClickChatButton(session.page, options.source, { allowStart: options.allowStart });
    const afterClick = await session.page.evaluate(() => ({ url: location.href, title: document.title.slice(0, 60) }));
    await sleep(3000);
    if (options.source === 'liepin') {
      await waitForLiepinSecurity(session.page, url, Number(options.securityTimeout));
    }
    const chatState = btn && !btn.skipped ? await waitForChatUi(session.page) : null;

    // 滚动聊天容器加载历史
    if (chatState) {
      for (let i = 0; i < 8; i += 1) {
        const scrolled = await scrollChatContainer(session.page);
        if (!scrolled) break;
        await sleep(1000);
      }
    }

    const extraction = chatState ? await extractMessages(session.page) : null;

    // 组装入库消息并 POST 到后端（去重、刷新 applications 派生列与 chat_state）
    let importResult = null;
    const chatMessages = (extraction?.messages || [])
      .filter(m => m.type === 'message')
      .map(m => ({
        direction: m.sender === 'me' ? 'out' : 'in',
        content: m.text,
        content_type: 'text',
        sent_at: normalizeTime(m.time || ''),
        read_status: m.readStatus || 'unknown',
        raw: { raw_time: m.time || '' }
      }));
    if (options.jobId && chatMessages.length) {
      try {
        importResult = await api.importChat(options.jobId, { source: options.source, messages: chatMessages });
      } catch (error) {
        console.error(`[warn] 入库失败（保留本地报告）: ${error.message}`);
      }
    } else if (options.jobId && (chatState || (btn === null && before.loggedIn))) {
      // 已确认聊天 UI 存在但本次没有提取到消息，或已登录的有效岗位页没有沟通入口：
      // 只记录“已检查”，不以空数组覆盖历史消息。
      try {
        importResult = await api.touchChatSync(options.jobId, {
          source: options.source, outcome: chatState ? 'empty_chat_ui' : 'no_chat_entry',
        });
      } catch (error) {
        console.error(`[warn] 空会话检查时间写入失败（保留本地报告）: ${error.message}`);
      }
    }

    const report = {
      collectedAt: new Date().toISOString(),
      source: options.source,
      jobId: options.jobId || null,
      jobTitle: job?.title || null,
      jobUrl: url,
      before, afterClick, chatState,
      button: btn,
      messages: extraction?.messages || [],
      importResult,
      diagnostics: { containerCls: extraction?.containerCls, bodyTail: extraction?.bodyTail }
    };
    const outFile = path.join(RUN_DIR, `${options.source}-${options.jobId || 'url'}-${ts}.json`);
    fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({
      outFile, button: btn, chatUrl: afterClick.url, messageCount: report.messages.length,
      chatStateFound: !!chatState, imported: importResult?.imported || 0, chatState: importResult?.chat_state || null
    }, null, 2));
    await api.reportAutomationRun(options.source, 'chat', 'completed', { messages: report.messages.length, imported: importResult?.imported || 0 }, '沟通同步完成');
  } catch (error) {
    failed = true;
    if (isInterception(error)) await api.request('/api/automation/budget', { method: 'POST', body: JSON.stringify({ action: 'intercept', platform: options.source, message: error.message }) }).catch(() => {});
    await api.reportAutomationRun(options.source, 'chat', 'failed', {}, error.message).catch(() => {});
    throw error;
  } finally {
    await releaseSession(session, { keepPage: options.keepPage || failed });
    releaseLock();
    process.removeListener('exit', releaseLock);
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}

module.exports = { liepinSecurityState, waitForLiepinSecurity, humanizeLiepinVisit };
