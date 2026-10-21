#!/usr/bin/env node
/** 从 BOSS 沟通页 Vue 内存列表追加每个岗位的最新消息，不展开虚拟列表行。 */
const path = require('path');
const fs = require('fs');
const { connectOrLaunch, releaseSession } = require('./browser');
const { TrackerApi } = require('./api');
const { fetchFriendList, loadJobIndex } = require('./chat-shared');

const ROOT = path.resolve(__dirname, '..', '..');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function ensureChatPage(page) {
  const ready = () => page.evaluate(() => !!document.querySelector('.user-list-content')?.__vue__?.dataSources)
    .catch(() => false);
  if (await ready()) return;
  await page.goto('https://www.zhipin.com/beijing/', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  await sleep(4000);
  await page.evaluate(() => {
    const link = [...document.querySelectorAll('a')]
      .find(a => (a.innerText || '').trim() === '消息' || (a.href || '').includes('/web/geek/chat'));
    if (link) link.click();
  }).catch(() => {});
  await sleep(8000);
  if (!await ready()) throw new Error(`BOSS_CHAT_LIST_NOT_READY url=${page.url()}`);
}

async function main() {
  const api = new TrackerApi(process.env.TRACKER_API_URL || 'http://127.0.0.1:8888', process.env.TRACKER_API_TOKEN || '');
  const session = await connectOrLaunch({ source: 'boss', port: 18800,
    profileDir: process.env.JOB_TRACKER_BROWSER_PROFILE || path.join(ROOT, 'data', 'browser-profile'),
    chromePath: process.env.CHROME_PATH || '/usr/bin/google-chrome-stable' });
  // 已有打开的“消息”页时直接附着它读取，不再新开标签跳转
  if (session.driver === 'cdp') {
    const { attachCdpPages } = require('./cdp-page');
    const [existing] = await attachCdpPages(session.browser, url => url.includes('/web/geek/chat'));
    if (existing) {
      await session.page.close().catch(() => {});
      session.page = existing;
      session.workPageOwned = false;
    }
  }
  try {
    await ensureChatPage(session.page);
    const [friends, index] = await Promise.all([fetchFriendList(session.page), loadJobIndex(api)]);
    let matched = 0; let imported = 0; let unchanged = 0; let unmatched = 0;
    const unmatchedRows = [];
    for (const friend of friends) {
      const sourceId = friend.encryptJobId;
      const job = index.byUrl.get(friend.url) || index.byId.get(sourceId);
      if (!job) {
        unmatched += 1;
        unmatchedRows.push({ name: friend.name, title: friend.jobTitle, brand: friend.brand,
          url: friend.url, lastTime: friend.lastTime, lastMsg: friend.lastMsg });
        continue;
      }
      matched += 1;
      if (!friend.lastMsg || !friend.lastTime) { unchanged += 1; continue; }
      const result = await api.appendChat(job.id, { source: 'boss', messages: [{
        direction: friend.lastIsSelf ? 'out' : 'in',
        content: friend.lastMsg,
        content_type: 'text',
        sent_at: friend.lastTime,
        read_status: 'unknown',
        raw: { source: 'boss_friend_list_snapshot', unread_count: friend.unreadCount },
      }] });
      if (result.imported) imported += result.imported;
      else unchanged += 1;
    }
    const report = { collectedAt: new Date().toISOString(), friends: friends.length,
      matched, imported, unchanged, unmatched, unmatchedRows };
    const dir = path.join(ROOT, 'data', 'chat-runs');
    fs.mkdirSync(dir, { recursive: true });
    const outFile = path.join(dir, `boss-chat-snapshot-${report.collectedAt.replace(/[:.]/g, '-')}.json`);
    fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ...report, unmatchedRows: undefined, outFile }, null, 2));
  } finally {
    await releaseSession(session, { keepPage: true }).catch(() => {});
  }
}

if (require.main === module) main().catch(error => { console.error(error.stack || error.message); process.exit(1); });
