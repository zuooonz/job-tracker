'use strict';
const { detailToPayload } = require('./job-payload');
const { reviewDetail } = require('./field-quality');
const CHAT_URL = 'https://www.zhipin.com/web/geek/chat';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const withTimeout = (p, ms, label) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timeout`)), ms))]);

function normalizeFriendList(friends) {
  if (!Array.isArray(friends)) return [];
  return friends
    .filter(f => f && f.encryptJobId)
    .map(f => ({
      key: (f.name || '') + '|' + (f.title || '') + '|' + (f.brandName || ''),
      name: f.name || '',
      jobTitle: f.title || '',
      brand: f.brandName || '',
      encryptJobId: f.encryptJobId,
      jobId: f.jobId,
      securityId: f.securityId,
      lastMsg: f.lastMsg || '',
      lastTime: f.lastTime || '',
      lastIsSelf: Boolean(f.lastIsSelf),
      lastMsgStatus: f.lastMsgStatus ?? null,
      unreadCount: Number(f.unreadCount || 0),
      url: `https://www.zhipin.com/job_detail/${f.encryptJobId}.html`,
    }));
}

function normalizeTime(raw, fallback) {
  if (!raw) return fallback || '';
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
  if ((m = raw.match(/(\d{1,2})月(\d{1,2})日\s*(\d{1,2}):(\d{2})/))) {
    let year = now.getFullYear();
    const d = new Date(year, +m[1] - 1, +m[2], +m[3], +m[4]);
    if (d.getTime() > now.getTime()) { year -= 1; d.setFullYear(year); }
    return d.toISOString();
  }
  return raw;
}

async function fetchFriendList(page) {
  // 首选页面已加载的 Vue 虚拟列表内存数据。它包含完整会话对象，且不需要 reload；
  // BOSS 对 /web/geek/chat 的直接 reload 偶尔会清空正文。
  const inMemory = await page.evaluate(() => {
    const virtual = document.querySelector('.user-list-content')?.__vue__;
    const rows = virtual?.dataSources;
    if (!Array.isArray(rows)) return [];
    return rows.filter(row => row && row.encryptJobId && !row.isFiltered).map(row => ({
      name: row.name || '', title: row.title || '', brandName: row.brandName || '',
      encryptJobId: row.encryptJobId, jobId: row.jobId, friendId: row.friendId,
      securityId: row.securityId, lastMsg: row.lastText || '',
      lastTime: row.lastTS ? new Date(row.lastTS).toISOString() : '',
      lastIsSelf: row.lastIsSelf, lastMsgStatus: row.lastMsgStatus,
      unreadCount: row.unreadCount || 0,
    }));
  }).catch(() => []);
  if (inMemory.length) return normalizeFriendList(inMemory);

  // 页面会把 friendIds 分批 POST（目前每批最多 100 个）。必须合并同一轮的
  // 所有 getGeekFriendList 响应；若只保留最后一个响应，101 个会话会被误读成 1 个。
  const friendsByKey = new Map();
  const handler = async (r) => {
    try {
      if (r.url().includes("getGeekFriendList") && r.status() === 200) {
        const t = await r.text();
        const d = JSON.parse(t);
        if (Array.isArray(d.zpData?.result)) {
          for (const friend of d.zpData.result) {
            const key = friend.friendId || friend.encryptJobId
              || `${friend.name || ""}|${friend.title || ""}|${friend.brandName || ""}`;
            friendsByKey.set(String(key), friend);
          }
        }
      }
    } catch (_) {}
  };
  page.on("response", handler);
  if (!page.url().includes("/web/geek/chat")) {
    await page.goto(CHAT_URL, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
  } else {
    await page.reload({ waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
  }
  await sleep(7000);
  page.off("response", handler);
  return normalizeFriendList([...friendsByKey.values()]);
}

async function clickRowByKey(page, contactName, jobTitleHint) {
  const findRow = () => withTimeout(page.evaluate((name, jobHint) => {
    const rows = Array.from(document.querySelectorAll('.friend-content-warp'));
    let el = null;
    if (jobHint) {
      el = rows.find(r => {
        const n = r.querySelector('.name-text')?.innerText?.trim();
        const t = (r.innerText || '').replace(/\s+/g, ' ');
        return n === name && jobHint && t.includes(jobHint);
      });
    }
    if (!el) el = rows.find(r => r.querySelector('.name-text')?.innerText?.trim() === name);
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, name: el.querySelector('.name-text')?.innerText?.trim() || '' };
  }, contactName, jobTitleHint), 8000, 'row-box');

  // 根据 Vue dataSources 的真实索引直接定位虚拟列表，避免从顶部逐屏盲搜。
  const positioned = await withTimeout(page.evaluate((name, jobHint) => {
    const el = document.querySelector('.user-list-content');
    const sourceRows = el?.__vue__?.dataSources;
    if (!el || !Array.isArray(sourceRows)) return false;
    const rows = sourceRows.filter(row => row && row.encryptJobId && !row.isFiltered);
    let index = rows.findIndex(row => row?.name === name && (!jobHint || String(row.title || '').includes(jobHint)));
    if (index < 0) index = rows.findIndex(row => row?.name === name);
    if (index < 0) return false;
    el.scrollTop = Math.max(0, index * 78 - 120);
    return true;
  }, contactName, jobTitleHint), 5000, 'list-position').catch(() => false);
  if (!positioned) {
    await withTimeout(page.evaluate(() => {
      const el = document.querySelector('.user-list-content');
      if (el) el.scrollTop = 0;
    }), 5000, 'list-reset').catch(() => {});
  }
  await sleep(500);
  let box = await findRow();
  // 当前可视区无此行 → 滚动列表逐屏搜索（覆盖当前约 7530px 的完整列表）
  for (let i = 0; !box && i < 16; i += 1) {
    const scrolled = await withTimeout(page.evaluate(() => {
      const el = document.querySelector('.user-list-content');
      if (!el) return false;
      const before = el.scrollTop;
      el.scrollTop += 500;
      return el.scrollTop !== before;
    }), 6000, 'list-scroll').catch(() => false);
    if (!scrolled) break;
    await sleep(700);
    box = await findRow();
  }
  if (!box) return null;
  await sleep(300);
  await withTimeout(page.evaluate((name, jobHint) => {
    const rows = Array.from(document.querySelectorAll('.friend-content-warp'));
    let target = rows.find(row => {
      const n = row.querySelector('.name-text')?.innerText?.trim();
      const text = (row.innerText || '').replace(/\s+/g, ' ');
      return n === name && (!jobHint || text.includes(jobHint));
    });
    if (!target) target = rows.find(row => row.querySelector('.name-text')?.innerText?.trim() === name);
    if (!target) return false;
    (target.querySelector('.friend-content') || target).click();
    return true;
  }, contactName, jobTitleHint), 5000, 'row-click');
  await sleep(1500);
  return box;
}

async function waitHeader(page, expectName, timeoutMs = 6000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const header = await withTimeout(page.evaluate(() => ({
      position: document.querySelector('.top-info-content .position-name')?.innerText?.trim() || '',
      contact: document.querySelector('.top-info-content .name-text')?.innerText?.trim() || '',
      raw: (document.querySelector('.top-info-content')?.innerText || '').replace(/\s+/g, ' ').slice(0, 200),
    })), 5000, 'header-read');
    const contactOk = header.contact && (!expectName
      || header.contact === expectName || header.contact.includes(expectName) || expectName.includes(header.contact));
    if (header.position && contactOk) return { ...header, ok: true };
    if (header.contact && !expectName) return { ...header, ok: true };
    await sleep(600);
  }
  // 超时：返回最后一次读取（带 ok=false 便于上层判断具体缺哪个）
  const last = await withTimeout(page.evaluate(() => ({
    position: document.querySelector('.top-info-content .position-name')?.innerText?.trim() || '',
    contact: document.querySelector('.top-info-content .name-text')?.innerText?.trim() || '',
    raw: (document.querySelector('.top-info-content')?.innerText || '').replace(/\s+/g, ' ').slice(0, 200),
  })), 5000, 'header-last').catch(() => ({ position: '', contact: '', raw: '' }));
  return { ...last, ok: false };
}

async function extractMessages(page) {
  return withTimeout(page.evaluate(() => {
    const items = Array.from(document.querySelectorAll('.message-item'));
    const messages = [];
    let lastTime = '';
    let skippedCards = 0;
    for (const el of items) {
      const cls = el.className || '';
      const isSelf = cls.includes('item-myself');
      const isSystem = cls.includes('item-system');
      const time = el.querySelector('.item-time .time')?.innerText?.trim() || '';
      if (time) lastTime = time;
      const statusEl = el.querySelector('.message-status');
      const statusCls = statusEl?.className || '';
      const readStatus = statusCls.includes('status-read') ? 'read'
        : (statusCls.includes('status-delivery') ? 'unread' : 'unknown');
      const contentEl = el.querySelector('.text-content');
      if (!contentEl) { skippedCards += 1; continue; }
      const content = contentEl.innerText?.trim() || '';
      if (!content) { skippedCards += 1; continue; }
      if (/发简历|换电话|换微信|按Enter键发送|PK情况|竞争者|查看详细分析|超过竞争者|送达|已读/.test(content)) continue;
      messages.push({
        type: isSystem ? 'system' : 'message',
        sender: isSelf ? 'me' : 'other',
        time: time || lastTime,
        rawTime: time,
        readStatus,
        text: content.slice(0, 800),
      });
    }
    return { messageCount: messages.length, messages, skippedCards };
  }), 10000, 'messages');
}

async function loadJobIndex(api) {
  const jobs = await api.listJobs({ source: 'boss', limit: 1000 });
  const byUrl = new Map();
  const byId = new Map();
  for (const j of jobs) {
    const cu = (j.canonical_url || j.url || '').split('?')[0];
    if (cu) byUrl.set(cu, j);
    const m = (j.url || '').match(/job_detail\/([^/?]+)\.html/);
    if (m) byId.set(m[1], j);
  }
  return { list: jobs, byUrl, byId };
}

async function ingestNewJob(api, browser, url) {
  await api.reserveAutomationBudget('boss', 'detail_opens');
  const np = await browser.newPage();
  await np.setViewport({ width: 1440, height: 900 }).catch(() => {});
  try {
    const adapter = require('./adapters/boss');
    let rawDetail;
    try {
      rawDetail = await Promise.race([
        adapter.detail(np, { url }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('详情爬取超时(90s)')), 90000)),
      ]);
    } catch (detailError) {
      if (!/超时/.test(detailError.message)) throw detailError;
      // 轻量兜底：直接读当前页字段
      rawDetail = await np.evaluate(() => {
        const body = document.body?.innerText || '';
        const offline = document.title.includes('出错啦') || /职位已下线|已被BOSS删除|已关闭|已失效|已下架/.test(body);
        return {
          url: location.href.split('?')[0],
          title: document.querySelector('.info-primary .name h1, .name h1')?.innerText?.trim() || '',
          company: document.querySelector('.brand-name')?.innerText?.replace(/^(代招|猎头|招聘)?公司[：:]\s*/, '').trim() || '',
          location: document.querySelector('.info-primary .text-city')?.innerText?.trim() || '',
          description: document.querySelector('.job-sec-text')?.innerText?.trim() || '',
          isOffline: offline,
        };
      });
    }
    const { detail, quality } = reviewDetail('boss', rawDetail);
    const stored = await api.ingestJob(detailToPayload('boss', detail));
    return { id: stored.id, quality: quality.status, title: detail.title };
  } finally {
    try { await np.close().catch(() => {}); } catch (_) {}
  }
}

module.exports = { normalizeFriendList, normalizeTime, fetchFriendList, clickRowByKey, waitHeader, extractMessages, loadJobIndex, ingestNewJob };
