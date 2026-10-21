#!/usr/bin/env node
/**
 * BOSS 直聘短信登录（复用爬虫反检测设计）
 *
 * 用法: node src/boss-login.js [--phone=手机号]（或在 .env 设置 BOSS_LOGIN_PHONE）
 *
 * 设计对齐自动化采集器：
 *   - connectOrLaunch(boss) -> CDP 连接，独立工作标签
 *   - 与采集器一致的人类化节奏（goto 后长等待）
 *   - 发送验证码后检测倒计时；出现滑块/安全验证时只提示，交给本人手动完成
 */
const path = require('path');
const { connectOrLaunch } = require('./browser');

const PHONE = process.argv.find(a => a.startsWith('--phone='))?.split('=')[1] || process.env.BOSS_LOGIN_PHONE || '';
if (!PHONE) { console.error('缺少手机号：使用 --phone= 或在 .env 设置 BOSS_LOGIN_PHONE'); process.exit(1); }
const LOGIN_URL = 'https://www.zhipin.com/web/user/?ka=header-message';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const session = await connectOrLaunch({
    source: 'boss', port: 18800,
    profileDir: process.env.JOB_TRACKER_BROWSER_PROFILE || path.resolve(__dirname, '..', '..', 'data', 'browser-profile'),
    chromePath: process.env.CHROME_PATH || '/usr/bin/google-chrome-stable'
  });
  try {
    const { page } = session;
    await page.setViewport({ width: 1440, height: 900 });
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await sleep(8000); // 与采集器一致的等待节奏

    const isMobile = await page.evaluate(() => !!document.querySelector('.page-is-mobile, .is-mobile'));
    if (isMobile) { await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 }); await sleep(6000); }

    // 填手机号 + 勾选协议（用原生 setter 触发 React 事件）
    const filled = await page.evaluate((phone) => {
      const setVal = (el, v) => {
        const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
        desc.set.call(el, v);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      };
      const phoneInput = document.querySelector('input[type="tel"]');
      if (!phoneInput) return 'no phone input';
      setVal(phoneInput, phone);
      const agree = document.querySelector('.agree-policy');
      if (agree && !agree.checked) agree.click();
      return 'filled';
    }, PHONE);
    await sleep(1000);

    // 点发送验证码
    const send = await page.evaluate(() => {
      const btn = [...document.querySelectorAll('div,span,button,a')].find(e =>
        (e.innerText || '').trim() === '发送验证码' && e.getBoundingClientRect().width > 0);
      if (!btn) return 'no send button';
      btn.click();
      return 'clicked';
    });
    await sleep(3500);

    // 检测状态
    let state = await page.evaluate(() => {
      const text = (document.body?.innerText || '').replace(/\s+/g, ' ');
      const sliderEl = [...document.querySelectorAll('div,span,i,canvas')].find(el => {
        const t = (el.innerText || '').trim();
        return /按住滑块|向右滑|拖动.*滑块|请完成安全验证|验证码/.test(t) && el.getBoundingClientRect().width > 0;
      });
      return {
        countdown: /(\d{1,2})\s*(秒|s)\s*(后|倒计时)?(重发|重新发送)/.test(text),
        sliderText: sliderEl?.innerText.trim().slice(0, 30) || '',
        sliderCls: sliderEl?.className?.toString().slice(0, 60) || '',
        error: /验证码错误|频繁|失败|异常/.test(text) ? text.slice(0, 200) : '',
        isMobile: !!document.querySelector('.page-is-mobile')
      };
    });

    // 出现滑块或安全验证时不做任何自动处理，交给本人在浏览器里完成。
    if (state.sliderText || /slider|slide|captcha|verify/i.test(state.sliderCls)) {
      console.log('出现安全验证，请在浏览器中手动完成后再输入验证码。脚本不会自动处理验证。');
    }

    console.log(JSON.stringify({ phone: PHONE.replace(/^(\d{3})\d+(\d{2})$/, '$1******$2'), filled, send, state, url: page.url() }, null, 2));
  } finally {
    // 保留页面现场（不关闭工作标签），方便继续输入验证码
    await session.browser.disconnect();
  }
}

main().catch(e => { console.error(e.stack || e.message); process.exit(1); });
