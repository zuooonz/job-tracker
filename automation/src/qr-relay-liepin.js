#!/usr/bin/env node
/**
 * 猎聘本机扫码登录中继（猎聘APP 扫码版，自包含）
 *
 * 背景：猎聘登录页（www.liepin.com/login/）的扫码分两种——微信扫码（关注服务号）
 * 与 APP 扫码（猎聘APP-求职端扫码登录）。用户需要的是 APP 登录码：
 * 默认密码登录 → 点切换按钮进扫码区 → 点「APP扫码」tab → 抓取 data: 二维码。
 *
 * 一个脚本完成整条链路：
 *   驱动浏览器 → 打开猎聘登录页 → 切到 APP扫码 tab → 抓取二维码
 *   → 在本机页面显示 → 监控登录状态 → 扫码成功识别
 *
 * 用法（本机）:
 *   node src/qr-relay-liepin.js
 *
 * 打开 http://127.0.0.1:3082/，用猎聘 APP 扫码即可。
 *
 * 关键设计:
 *   - 猎聘有 lp-security 前端风控，headless 下首页会被 JS 清空（location.replace
 *     about:blank）；登录页 www.liepin.com/login/ 配合语言伪装可稳定加载。
 *   - APP 二维码是 data:image base64（138x138），页面内直接读 src 解码。
 *   - 登录态存 Chrome profile cookie；登录成功判定：页面从登录页跳走。
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
const HTTP_PORT = Number(process.env.QR_RELAY_PORT || 3082);
const LOGIN_URL = 'https://www.liepin.com/login/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p, ms, label) => Promise.race([
  p,
  new Promise((_, rej) => setTimeout(() => rej(new Error(label + ' timeout')), ms)),
]);

let latestQr = null;
let loggedIn = false;
let status = '启动中…';
let lastQrMd5 = '';
let lastQrAt = 0;

process.on('unhandledRejection', (reason) => {
  console.error(`[未捕获异常，已忽略] ${String(reason?.message || reason).slice(0, 200)}`);
});
process.on('uncaughtException', (error) => {
  console.error(`[未捕获异常，已忽略] ${String(error?.message || error).slice(0, 200)}`);
});

// ---------------- 浏览器 ----------------
async function ensureBrowser() {
  for (let i = 0; i < 3; i++) {
    try {
      return await connectCdpBrowser({ port: CDP_PORT });
    } catch (_) { await sleep(1000); }
  }
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

// ---------------- 页面内抓取猎聘 APP 登录二维码 ----------------
// 猎聘扫码分两种：微信扫码（mp.weixin.qq.com，关注服务号）与 APP 扫码
// （猎聘APP-求职端扫码登录，data:image base64）。用户需要 APP 扫码码：
// 先点切换按钮进入扫码区，再点「APP扫码」tab，抓取 data: 二维码解码。
async function switchToAppQr(page) {
  // 点切换按钮进入扫码区（若尚未在）
  await withTimeout(page.evaluate(() => {
    const b = document.querySelector('.teno-switch-login-type-btn-box');
    if (b) b.click();
  }), 5000, 'switch-btn').catch(() => {});
  await sleep(2500);
  // 点「APP扫码」tab
  const clicked = await withTimeout(page.evaluate(() => {
    const t = Array.from(document.querySelectorAll('.login-type-tab-item'))
      .find(e => (e.innerText || '').trim() === 'APP扫码');
    if (!t) return false;
    t.click();
    return true;
  }), 5000, 'app-tab');
  await sleep(3500);
  return clicked;
}
async function fetchQrBytes(page) {
  const data = await withTimeout(page.evaluate(() => {
    // APP 扫码码：data:image base64，约 130-160px 方形
    const img = Array.from(document.querySelectorAll('img'))
      .find(i => i.src.startsWith('data:image') && i.width >= 120 && i.height >= 120 && Math.abs(i.width - i.height) < 30);
    return img ? img.src : '';
  }), 5000, 'qr-src');
  if (!data || !data.startsWith('data:image')) return null;
  const m = data.match(/^data:image\/[a-z+]+;base64,(.+)$/);
  if (!m) return null;
  const buf = Buffer.from(m[1], 'base64');
  return buf && buf.length > 300 ? buf : null;
}

(async () => {
  const browser = await ensureBrowser();
  const page = await createCdpPage(browser);
  await page.setViewport({ width: 1440, height: 900 });
  // 猎聘 lp-security 风控：伪装语言（zh-CN），否则页面会被 JS 清空
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'language', { get: () => 'zh-CN' });
    Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh'] });
  });
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await sleep(8000);
  // 切到「APP扫码」tab（默认是密码登录：先点切换进扫码区，再点 APP扫码）
  try {
    await switchToAppQr(page);
  } catch (_) {}

  // 本地 3082 调试服务
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
      res.end(`<!doctype html><meta charset="utf-8"><title>猎聘扫码登录</title>
<style>
body{background:#000;color:#eee;font-family:system-ui,sans-serif;display:flex;flex-direction:column;align-items:center;padding:24px;min-height:90vh;justify-content:center}
h2{font-size:17px;margin:0 0 16px} img{background:#fff;border-radius:12px;padding:12px;width:280px;height:280px}
.st{color:#999;margin-top:12px;font-size:13px;max-width:320px;text-align:center}
</style>
<h2>猎聘 · APP 扫码登录</h2>
<img id="qr" src="/qr.png" alt="二维码">
<div class="st" id="st">等待二维码…</div>
<script>let version='';async function refresh(){try{const s=await(await fetch('/status.json?t='+Date.now(),{cache:'no-store'})).json();const el=document.getElementById('st');el.textContent=s.loggedIn?'✅ 已登录':s.status;el.className='st'+(s.loggedIn?' ok':'');if(s.qrVersion&&s.qrVersion!==version){version=s.qrVersion;document.getElementById('qr').src='/qr.png?v='+version;}}catch(e){}}refresh();setInterval(refresh,1000);</script>`);
    }
  });
  await new Promise((resolve) => server.listen(HTTP_PORT, '127.0.0.1', resolve));
  console.log(`猎聘 QR 中继已启动: http://127.0.0.1:${HTTP_PORT}（CDP: ${CDP_PORT}）`);

  // 初始二维码
  const initial = await fetchQrBytes(page);
  if (initial) {
    latestQr = initial;
    lastQrMd5 = crypto.createHash('md5').update(initial).digest('hex');
    lastQrAt = Date.now();
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
        const url = location.href;
        const text = document.body?.innerText || '';
        return {
          url,
          onLoginPage: url.includes('/login/') || url.includes('passport'),
          loggedInHint: !url.includes('/login/') && !url.includes('passport') && url.length > 20,
          body: text.slice(0, 100),
        };
      }), 5000, 'state');
      // 猎聘微信扫码成功后：页面跳回主页/跳走登录页 + 有用户态
      if (state.loggedInHint) {
        loggedIn = true;
        status = '已登录';
        console.log('LOGIN_OK url=' + state.url);
        break;
      }
      const stateKey = `${state.onLoginPage}|${state.url.slice(0, 45)}`;
      if (stateKey !== lastStateKey) {
        lastStateKey = stateKey;
        console.log(`[状态] ${new Date().toISOString()} onLoginPage=${state.onLoginPage} url=${state.url.slice(0, 55)}`);
      }
      // 猎聘 APP 登录二维码有效期较短：每 60 秒重新抓取上传，若码失效
      // （data: 未出现或 md5 不变超时）则重新切到 APP扫码 tab 强制换新码
      const now = Date.now();
      const qr = await fetchQrBytes(page);
      if (qr) {
        const md5 = crypto.createHash('md5').update(qr).digest('hex');
        if (now - lastQrAt > 60000) {
          if (md5 !== lastQrMd5) {
            latestQr = qr;
            lastQrMd5 = md5;
            lastQrAt = now;
            status = `二维码已就绪 (${Math.round(qr.length / 1024)}KB, ${Date.now() - t0}ms)`;
          } else {
            // 码未变但已超时：重新切 APP扫码 tab 强制换新码
            await switchToAppQr(page).catch(() => {});
            lastQrAt = now;
            console.log(`[状态] ${new Date().toISOString()} 码超时，已重新切 APP扫码 换新码`);
          }
        } else {
          status = `二维码已就绪 (${Math.round(qr.length / 1024)}KB)`;
        }
      } else {
        // 二维码消失（过期/被扫码）：重新切 APP扫码 tab 换新码
        await switchToAppQr(page).catch(() => {});
        const qr2 = await fetchQrBytes(page);
        if (qr2) {
          latestQr = qr2;
          lastQrMd5 = crypto.createHash('md5').update(qr2).digest('hex');
          lastQrAt = Date.now();
          status = `二维码已换新 (${Math.round(qr2.length / 1024)}KB)`;
        } else {
          status = '二维码暂未出现，等待页面渲染…';
        }
      }
    } catch (error) {
      status = '等待页面…' + error.message.slice(0, 40);
    }
  }

  console.log('已登录，Chrome 保持运行（profile 已写入 cookie），可执行采集/入库。');
  await sleep(8000);
  console.log('保持本机 QR 页面运行，需要结束请 kill 本进程。');
  await new Promise(() => {});
})().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
