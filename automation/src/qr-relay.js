#!/usr/bin/env node
/**
 * BOSS直聘本机扫码登录中继（自包含版）
 *
 * 一个脚本完成整条链路：
 *   驱动浏览器 → 打开 BOSS 登录页 → 抓取二维码 → 在本机页面显示
 *   → 实时监控登录状态 → 扫码成功自动识别
 *
 * 用法（本机）:
 *   node src/qr-relay.js
 *
 * 打开 http://127.0.0.1:3081/，用 BOSS 直聘 App 扫码即可。
 *
 * 关键设计:
 *   - 二维码 PNG 字节从页面 blob 原样 fetch（登录页截图 CDP captureScreenshot 会挂起，
 *     不能用 screenshot）；字节原样传递，base64 仅是跨 evaluate 的传输编码。
 *   - 令牌服务端有效期短（几十秒）但图片 blob 稳定：页面出现"请重新刷新二维码"时
 *     自动点击页面自带"点击刷新"换码，再抓取（无需刷新整页）。
 *   - 登录态存 Chrome profile cookie（独立进程启动，relay 退出不影响 Chrome 存活）。
 *   - 本地 HTTP 服务只绑定 127.0.0.1；页面轮询状态并在二维码变化时刷新图片。
 */
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { createCdpPage } = require('./cdp-page');
const { connectCdpBrowser } = require('./cdp-connection');
const { prepareBrowserEnvironment, resolveBrowserMode, headlessArgs } = require('./browser-mode');

const PROFILE_DIR = process.env.JOB_TRACKER_BROWSER_PROFILE
  || path.resolve(__dirname, '..', '..', 'data', 'browser-profile');
const CDP_PORT = Number(process.env.BOSS_CDP_PORT || 18800);
const HTTP_PORT = Number(process.env.QR_RELAY_PORT || 3081);
const LOGIN_URL = 'https://www.zhipin.com/web/user/?from=passport-zp';
const EXIT_AFTER_LOGIN = process.env.QR_EXIT_AFTER_LOGIN === '1' || process.argv.includes('--exit-after-login');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p, ms, label) => Promise.race([
  p,
  new Promise((_, rej) => setTimeout(() => rej(new Error(label + ' timeout')), ms)),
]);

let latestQr = null;
let loggedIn = false;
let status = '启动中…';

// 长驻守护：Chrome 里瞬态标签页关闭会让 stealth 插件抛 Target closed 的
// 未捕获 rejection，不能让它把整个中继带崩（登录态在 Chrome profile，不受影响）。
process.on('unhandledRejection', (reason) => {
  console.error(`[未捕获异常，已忽略] ${String(reason?.message || reason).slice(0, 200)}`);
});
process.on('uncaughtException', (error) => {
  console.error(`[未捕获异常，已忽略] ${String(error?.message || error).slice(0, 200)}`);
});

// ---------------- 浏览器 ----------------
async function ensureBrowser() {
  // 优先连接已在运行的 Chrome（独立进程，relay 退出不影响它，登录态得以持久落盘）
  for (let i = 0; i < 3; i++) {
    try {
      return await connectCdpBrowser({ port: CDP_PORT });
    } catch (_) { await sleep(1000); }
  }
  // 否则以独立进程方式启动 Chrome（detached + unref），本进程退出后 Chrome 继续存活
  const environment = prepareBrowserEnvironment();
  const mode = resolveBrowserMode();
  const args = [
    `--user-data-dir=${PROFILE_DIR}`,
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-blink-features=AutomationControlled',
    `--remote-debugging-port=${CDP_PORT}`,
    'about:blank',
  ];
  if (mode === 'headless') args.push(...headlessArgs());
  console.log(`[browser] mode=${mode}${environment.display ? ` display=${environment.display}` : ''}`);
  require('child_process').spawn(
    process.env.CHROME_PATH || '/usr/bin/google-chrome-stable',
    args, { detached: true, stdio: 'ignore' }).unref();
  let browser = null;
  for (let i = 0; i < 25 && !browser; i++) {
    try {
      browser = await connectCdpBrowser({ port: CDP_PORT });
    } catch (_) { await sleep(1000); }
  }
  if (!browser) throw new Error('Chrome 启动失败或 CDP 不可达');
  return browser;
}

// ---------------- 页面内抓取二维码字节 ----------------
async function fetchQrBytes(page) {
  const imgSrc = await withTimeout(page.evaluate(() =>
    document.querySelector('img[src^="blob:"]')?.src || ''
  ), 5000, 'qr-src');
  if (!imgSrc) return null;
  const b64 = await withTimeout(page.evaluate(async (src) => {
    const resp = await fetch(src);
    const buf = await resp.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }, imgSrc), 5000, 'qr-bytes');
  return Buffer.from(b64, 'base64');
}

(async () => {
  const browser = await ensureBrowser();
  const page = await createCdpPage(browser);
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await sleep(8000);
  // 登录页默认显示「验证码登录」，需点击「APP扫码登录」切换出二维码
  // （图形会话/已登录时可能直接是扫码页；headless/新会话时必须点击切换）
  try {
    await page.evaluate(() => {
      const btn = document.querySelector('.btn-sign-switch.ewm-switch');
      if (btn) btn.click();
    });
    await sleep(1500);
  } catch (_) {}

  const server = http.createServer((req, res) => {
    const url = (req.url || '').split('?')[0];
    if (url === '/qr.png') {
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Cache-Control', 'no-store');
      res.end(latestQr || Buffer.alloc(0));
    } else if (url === '/status.json') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify({ loggedIn, status, qrVersion: latestQr ? crypto.createHash('md5').update(latestQr).digest('hex') : '' }));
    } else if (url !== '/') {
      res.statusCode = 404;
      res.end('Not found');
    } else {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`<!doctype html><meta charset="utf-8"><title>BOSS直聘扫码登录</title>
<style>
body{background:#000;color:#eee;font-family:system-ui,sans-serif;display:flex;flex-direction:column;align-items:center;padding:24px;min-height:90vh;justify-content:center}
h2{font-size:17px;margin:0 0 16px} img{background:#fff;border-radius:12px;padding:12px;width:260px;height:260px}
.st{color:#999;margin-top:12px;font-size:13px;max-width:320px;text-align:center}
</style>
<h2>BOSS直聘 · App 扫码登录</h2>
<img id="qr" src="/qr.png" alt="二维码">
<div class="st" id="st">等待二维码…</div>
<script>let version='';async function refresh(){try{const s=await(await fetch('/status.json?t='+Date.now(),{cache:'no-store'})).json();const el=document.getElementById('st');el.textContent=s.loggedIn?'✅ 已登录':s.status;el.className='st'+(s.loggedIn?' ok':'');if(s.qrVersion&&s.qrVersion!==version){version=s.qrVersion;document.getElementById('qr').src='/qr.png?v='+version;}}catch(e){}}refresh();setInterval(refresh,1000);</script>`);
    }
  });
  await new Promise((resolve) => server.listen(HTTP_PORT, '127.0.0.1', resolve));
  console.log(`本机 QR 页面: http://127.0.0.1:${HTTP_PORT}/（CDP: ${CDP_PORT}）`);

  // 初始二维码：立即抓取并在本机页面显示
  const initial = await fetchQrBytes(page);
  if (initial) {
    latestQr = initial;
    status = `二维码已就绪 (${Math.round(initial.length / 1024)}KB)`;
  } else {
    status = '未找到二维码元素（可能已登录或页面未加载完）';
  }

  // ---- 主循环：3s 监控 + 失效自动换码上传 ----
  let lastStateKey = '';
  while (!loggedIn) {
    await sleep(3000);
    const t0 = Date.now();
    try {
      const state = await withTimeout(page.evaluate(() => {
        const text = document.body?.innerText || '';
        return {
          url: location.href,
          onLoginPage: location.href.includes('web/user') || location.href.includes('passport'),
          userNav: !!document.querySelector('.user-nav, [class*="header-userinfo"], [class*="userInfo"], [class*="avatar-wrap"]'),
          scanned: text.includes('扫描成功') || text.includes('请在App端确认'),
          needRefresh: text.includes('请重新刷新二维码'),
        };
      }), 5000, 'state');
      loggedIn = !state.onLoginPage || state.userNav;
      if (loggedIn) {
        status = '已登录';
        console.log('LOGIN_OK url=' + state.url);
        break;
      }
      const stateKey = `${state.onLoginPage}|${state.scanned}|${state.needRefresh}|${state.url.slice(0, 45)}`;
      if (stateKey !== lastStateKey) {
        lastStateKey = stateKey;
        console.log(`[状态] ${new Date().toISOString()} scanned=${state.scanned} needRefresh=${state.needRefresh} url=${state.url.slice(0, 55)}`);
      }
      if (state.scanned) {
        status = '已扫码，请在手机 App 端确认登录';
        continue; // 待确认期间绝不动页面，等 BOSS 自行跳转
      }

      // 令牌失效：点页面自带"点击刷新"换码，再抓取上传（无需刷新整页）
      if (state.needRefresh) {
        await withTimeout(page.evaluate(() => {
          const el = Array.from(document.querySelectorAll('a,span,div,button'))
            .find(e => e.textContent.trim() === '点击刷新');
          if (el) el.click();
        }), 5000, 'click-refresh');
        console.log(`[状态] ${new Date().toISOString()} 二维码失效，已点击刷新（页面自带换码，无需刷新整页）`);
        await sleep(2000); // 等新码渲染
        const qr = await fetchQrBytes(page);
        if (qr) {
          latestQr = qr;
          status = `二维码已就绪（失效自动换新）(${Math.round(qr.length / 1024)}KB, ${Date.now() - t0}ms)`;
        } else {
          status = '未找到二维码元素（页面可能还在加载）';
        }
      } else if (!latestQr) {
        // 初始抓取失败时兜底重试
        const qr = await fetchQrBytes(page);
        if (qr) { latestQr = qr; status = `二维码已就绪 (${Math.round(qr.length / 1024)}KB)`; }
      } else {
        status = `二维码已就绪 (${Math.round(latestQr.length / 1024)}KB)`;
      }
    } catch (error) {
      status = '等待页面…' + error.message.slice(0, 40);
    }
  }

  // 登录成功：等 cookie 落盘，推送最终状态，保持服务
  console.log('已登录，Chrome 保持运行（profile 已写入 cookie），可执行采集/入库。');
  await sleep(8000);
  if (EXIT_AFTER_LOGIN) {
    console.log('登录中继完成，退出并交还监测器。');
    if (server) await new Promise(resolve => server.close(resolve));
    await page.close().catch(() => {});
    await browser.disconnect();
    return;
  }
  console.log('保持本机 QR 页面运行，需要结束请 kill 本进程。');
  await new Promise(() => {}); // 不退出：本机页面持续显示 loggedIn:true
})().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
