#!/usr/bin/env node
/**
 * 本机有头登录门禁。
 *
 * 在同一个持久化浏览器 profile 中打开 BOSS 沟通页和猎聘投递页，等待用户在
 * 可见 Chrome 中完成登录。两个平台都通过页面级校验后才返回，供沟通流水线继续执行。
 * 本模块不包含二维码中继、SSH、cookie 导入或远程 API 逻辑。
 */
const path = require('path');
const { connectOrLaunch, releaseSession } = require('./browser');

const ROOT = path.resolve(__dirname, '..', '..');
const BOSS_CHAT_URL = 'https://www.zhipin.com/web/geek/chat';
const LIEPIN_APPLY_URL = 'https://c.liepin.com/job/record/apply';
const LIEPIN_LOGIN_URL = 'https://www.liepin.com/login/';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function classifyLoginSnapshot(platform, snapshot) {
  const url = String(snapshot.url || '');
  const text = String(snapshot.text || '');
  const html = String(snapshot.html || '');
  const title = String(snapshot.title || '');
  if (platform === 'boss') {
    const loginPage = /\/web\/user|login\.zhipin\.com|passport/i.test(url)
      || /扫码登录|手机号登录|验证码登录|登录\s*\/\s*注册/.test(text);
    const chatReady = /\/web\/geek\/chat/.test(url)
      && /top-info-content|friend-content-warp|chat-list|friend-list/.test(html);
    const accountReady = /nav-figure|user-nav|nav-user-wrapper|geek-avatar/.test(html);
    return { loggedIn: !loginPage && (chatReady || accountReady), loginPage, url, title };
  }
  const loginPage = /\/login\/|passport\.liepin\.com/i.test(url)
    || /扫码登录|手机.*登录|验证码登录/.test(text);
  const applyReady = /c\.liepin\.com\/job\/record\/apply/.test(url)
    && /我的投递|投递记录|已投递|投递反馈|反馈/.test(text);
  const accountReady = /header-user|user-info|user-avatar|ant-avatar/.test(html);
  return { loggedIn: !loginPage && (applyReady || accountReady), loginPage, url, title };
}

async function snapshot(page, platform) {
  const raw = await page.evaluate(() => ({
    url: location.href,
    title: document.title,
    text: (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 1200),
    html: (document.body?.innerHTML || '').slice(0, 200000),
  })).catch(() => ({ url: page.url(), title: '', text: '', html: '' }));
  return classifyLoginSnapshot(platform, raw);
}

function statusText(state) {
  if (state.loggedIn) return '已登录';
  if (state.loginPage) return '等待登录';
  if (/about:blank/.test(state.url)) return '页面被拦截/尚未加载';
  return '正在校验';
}

async function openLoginPages() {
  const common = {
    port: 18800,
    profileDir: process.env.JOB_TRACKER_BROWSER_PROFILE || path.join(ROOT, 'data', 'browser-profile'),
    chromePath: process.env.CHROME_PATH || '/usr/bin/google-chrome-stable',
  };
  // 登录标签与后续固定工作标签分离，并在下次运行时复用，避免重复打开标签。
  const boss = await connectOrLaunch({ ...common, source: 'boss', reuseWorkPage: true,
    workPageMarker: 'job-tracker-login-boss' });
  const liepin = await connectOrLaunch({ ...common, source: 'liepin', reuseWorkPage: true,
    workPageMarker: 'job-tracker-login-liepin' });
  await Promise.all([
    boss.page.setViewport({ width: 1440, height: 900 }),
    liepin.page.setViewport({ width: 1440, height: 900 }),
  ]);
  await boss.page.goto(BOSS_CHAT_URL, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  await liepin.page.goto(LIEPIN_APPLY_URL, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  await sleep(5000);
  if ((liepin.page.url() || '') === 'about:blank') {
    await liepin.page.goto(LIEPIN_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  }
  await boss.page.bringToFront().catch(() => {});
  return { boss, liepin };
}

async function waitForLocalLogins({ timeoutMinutes = 60, pollMs = 3000 } = {}) {
  const sessions = await openLoginPages();
  const deadline = timeoutMinutes > 0 ? Date.now() + timeoutMinutes * 60000 : Infinity;
  let previous = '';
  let lastReport = 0;
  console.log('\n已打开本机可见 Chrome：BOSS 沟通页 + 猎聘投递页。');
  console.log('请在这两个标签页完成登录；脚本会自动检测，两边就绪后立即开始爬取。');
  try {
    while (Date.now() < deadline) {
      const [bossState, liepinState] = await Promise.all([
        snapshot(sessions.boss.page, 'boss'),
        snapshot(sessions.liepin.page, 'liepin'),
      ]);
      const current = `${statusText(bossState)}|${statusText(liepinState)}`;
      if (current !== previous || Date.now() - lastReport >= 60000) {
        console.log(`[登录检测] BOSS=${statusText(bossState)}；猎聘=${statusText(liepinState)}`);
        previous = current;
        lastReport = Date.now();
      }
      if (bossState.loggedIn && liepinState.loggedIn) {
        console.log('两个平台均已确认登录，开始沟通记录流水线。\n');
        return { boss: bossState, liepin: liepinState };
      }
      await sleep(pollMs);
    }
    throw new Error(`等待本机登录超时（${timeoutMinutes} 分钟），尚未开始爬取`);
  } finally {
    // 登录标签留在可见浏览器中；只断开控制连接，不关闭用户正在看的页面。
    await releaseSession(sessions.boss, { keepPage: true }).catch(() => {});
    await releaseSession(sessions.liepin, { keepPage: true }).catch(() => {});
  }
}

function parseTimeout(argv) {
  const arg = argv.find(item => item.startsWith('--login-timeout='));
  return arg ? Number(arg.split('=')[1]) : 60;
}

if (require.main === module) {
  waitForLocalLogins({ timeoutMinutes: parseTimeout(process.argv.slice(2)) })
    .catch(error => { console.error(error.stack || error.message); process.exit(1); });
}

module.exports = { classifyLoginSnapshot, waitForLocalLogins, parseTimeout };
