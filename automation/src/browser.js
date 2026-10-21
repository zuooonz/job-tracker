const fs = require('fs');
const path = require('path');
const { prepareBrowserEnvironment, resolveBrowserMode, headlessArgs } = require('./browser-mode');

const { createCdpPage } = require('./cdp-page');
const { connectCdpBrowser } = require('./cdp-connection');

async function configurePage(page) {
  await page.bringToFront();
}

function browserArgs(profileDir, mode) {
  const args = [
    `--user-data-dir=${profileDir}`,
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-blink-features=AutomationControlled'
  ];
  if (mode === 'headless') args.push(...headlessArgs());
  return args;
}

// CDP 模式下自行以独立进程启动 Chrome（不经 Puppeteer，避免自动附着），再用原生连接接管。
async function launchDetachedChrome({ port, profileDir, chromePath, mode }) {
  const args = [...browserArgs(profileDir, mode), `--remote-debugging-port=${port}`,
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows', '--no-first-run', '--no-default-browser-check', 'about:blank'];
  require('child_process').spawn(chromePath, args, { detached: true, stdio: 'ignore' }).unref();
  for (let i = 0; i < 30; i += 1) {
    try { return await connectCdpBrowser({ port }); } catch (_) { await new Promise(resolve => setTimeout(resolve, 1000)); }
  }
  throw new Error(`Chrome 启动失败或 CDP 不可达（端口 ${port}）`);
}

async function connectOrLaunch({ source, port = 18800, profileDir, chromePath = '/usr/bin/google-chrome-stable', reuseWorkPage, workPageMarker }) {
  const reuse = reuseWorkPage ?? (Boolean(workPageMarker) || process.env.BROWSER_REUSE_WORK_PAGE === '1');
  const marker = reuse ? (workPageMarker || `job-tracker-work-${source}`) : '';
  let browser;
  let owned = false;
  try {
    browser = await connectCdpBrowser({ port });
  } catch (_) {
    const environment = prepareBrowserEnvironment();
    const mode = resolveBrowserMode();
    fs.mkdirSync(profileDir, { recursive: true });
    console.log(`[browser] mode=${mode}${environment.display ? ` display=${environment.display}` : ''}`);
    browser = await launchDetachedChrome({ port, profileDir, chromePath, mode });
    owned = false; // 独立进程常驻，脚本结束只断开连接
  }
  const page = await createCdpPage(browser, marker);
  await configurePage(page);
  return { browser, page, owned, workPageOwned: !reuse, reusable: reuse, port, source, driver: 'cdp' };
}

async function releaseSession(session, { keepPage = false } = {}) {
  if (!keepPage && session.workPageOwned) {
    try { if (!session.page.isClosed()) await session.page.close(); } catch (_) {}
  }
  if (session.owned && !keepPage && session.workPageOwned) await session.browser.close();
  else await session.browser.disconnect();
}

// 对已知可能挂起的浏览器操作（模拟鼠标运动、平滑滚动等）加超时护栏：卡住直接跳过，
// 绝不让单个装饰性操作拖死整个采集流程。
function bestEffort(promise, ms = 5000) {
  return Promise.race([
    promise.catch(() => {}),
    new Promise(resolve => setTimeout(resolve, ms))
  ]);
}

module.exports = { connectOrLaunch, releaseSession, bestEffort };
