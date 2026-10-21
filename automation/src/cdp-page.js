const { EventEmitter } = require('events');
const fs = require('fs');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

class CdpElement {
  constructor(page, objectId) { this.page = page; this.objectId = objectId; }
  async boundingBox() {
    await this.page.session.send('DOM.enable').catch(() => {});
    const { result } = await this.page.session.send('DOM.getBoxModel', { objectId: this.objectId }).catch(() => ({}));
    const q = result?.model?.border;
    if (!q?.length) return null;
    const xs = q.filter((_, i) => i % 2 === 0), ys = q.filter((_, i) => i % 2 === 1);
    const x = Math.min(...xs), y = Math.min(...ys);
    return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
  }
  async screenshot(options = {}) {
    const box = await this.boundingBox();
    if (!box) throw new Error('Element is not visible');
    return this.page.screenshot({ ...options, clip: box });
  }
}

class CdpPage extends EventEmitter {
  constructor(browserSession, session, targetId) {
    super();
    this.browserSession = browserSession;
    this.session = session;
    this.targetId = targetId;
    this.isCdpPage = true;
    this.currentUrl = 'about:blank';
    this.closed = false;
    this.responseById = new Map();
    // 记录当前鼠标位置：按下/抬起必须落在最后一次移动到的坐标上，否则会点到页面左上角。
    this.mousePosition = { x: 0, y: 0 };
    // buttons 必须与真实鼠标一致：按下时为 1、抬起后为 0，否则事件的 buttons 字段恒为 0，容易被识别。
    this.mouseButtons = 0;
    const press = (type, options = {}) => {
      this.mouseButtons = type === 'mousePressed' ? 1 : 0;
      return this.session.send('Input.dispatchMouseEvent', {
        type, ...this.mousePosition, button: options.button || 'left',
        buttons: this.mouseButtons, clickCount: options.clickCount || 1, pointerType: 'mouse'
      });
    };
    this.mouse = {
      move: async (x, y, options = {}) => {
        const steps = Math.max(1, Math.min(20, options.steps || 1));
        const from = { ...this.mousePosition };
        for (let i = 1; i <= steps; i++) {
          const point = { x: from.x + ((x - from.x) * i) / steps, y: from.y + ((y - from.y) * i) / steps };
          await this.session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point, buttons: this.mouseButtons, pointerType: 'mouse' });
          if (steps > 1) await sleep(8 + Math.random() * 12);
        }
        this.mousePosition = { x, y };
      },
      down: options => press('mousePressed', options),
      up: options => press('mouseReleased', options),
      click: async (x, y, options = {}) => {
        await this.mouse.move(x, y);
        await press('mousePressed', options);
        if (options.delay) await sleep(options.delay);
        await press('mouseReleased', options);
      }
    };
    this.session.on('Network.responseReceived', event => {
      let resolveBody;
      const bodyReady = new Promise(resolve => { resolveBody = resolve; });
      const response = {
        url: () => event.response.url,
        status: () => event.response.status,
        headers: () => event.response.headers,
        request: () => ({ url: () => event.response.url }),
        text: async () => {
          await bodyReady;
          return (await this.session.send('Network.getResponseBody', { requestId: event.requestId })).body;
        },
        json: async () => JSON.parse(await response.text())
      };
      this.responseById.set(event.requestId, response);
      response.resolveBody = resolveBody;
      this.emit('response', response);
    });
    const finishResponse = event => {
      const response = this.responseById.get(event.requestId);
      response?.resolveBody?.();
      this.responseById.delete(event.requestId);
    };
    this.session.on('Network.loadingFinished', finishResponse);
    this.session.on('Network.loadingFailed', finishResponse);
  }
  async initialize() {
    await this.session.send('Runtime.evaluate', { expression: 'location.href', returnByValue: true }).then(r => { this.currentUrl = r.result.value || 'about:blank'; }).catch(() => {});
    return this;
  }
  on(event, listener) {
    const result = super.on(event, listener);
    if (event === 'response') this.session.send('Network.enable').catch(() => {});
    return result;
  }
  async goto(url, options = {}) {
    this.currentUrl = url;
    const referrer = options.referer || options.referrer;
    await this.session.send('Page.navigate', { url, ...(referrer ? { referrer } : {}) });
    const deadline = Date.now() + (options.timeout || 30000);
    // 导航初期页面可能在跑安全校验脚本，求值会被长时间阻塞：先等一下，
    // 每次轮询单独限时，卡住就跳过这一轮，不让单次求值拖住整个流程。
    await sleep(1000);
    while (Date.now() < deadline) {
      const state = await Promise.race([
        this.evaluate(() => [document.readyState, location.href]).catch(() => null),
        sleep(3000).then(() => null),
      ]);
      if (state) {
        this.currentUrl = state[1];
        if (state[0] === 'interactive' || state[0] === 'complete') return null;
      }
      await sleep(250);
    }
    throw new Error(`Navigation timeout: ${url}`);
  }
  async evaluate(fn, ...args) {
    const source = typeof fn === 'function' ? `(${fn.toString()})(...__args)` : String(fn);
    if (args.some(arg => arg instanceof CdpElement)) {
      const object = args.find(arg => arg instanceof CdpElement);
      const rest = args.map(arg => arg instanceof CdpElement ? null : arg);
      const { result } = await this.session.send('Runtime.callFunctionOn', {
        objectId: object.objectId,
        functionDeclaration: `function(...__args){ return (${fn.toString()})(...__args); }`,
        arguments: [{ objectId: object.objectId }, ...rest.filter(v => v !== null).map(value => ({ value }))],
        returnByValue: true, awaitPromise: true
      });
      if (result?.exceptionDetails) throw new Error(result.exceptionDetails.text || 'Evaluation failed');
      return result?.value;
    }
    const expression = typeof fn === 'function' ? `(${fn.toString()})(...${JSON.stringify(args)})` : source;
    const { result, exceptionDetails } = await this.session.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text || 'Evaluation failed');
    this.currentUrl = await this._readUrl().catch(() => this.currentUrl);
    return result?.value;
  }
  async _readUrl() { return (await this.session.send('Runtime.evaluate', { expression: 'location.href', returnByValue: true })).result.value; }
  url() { return this.currentUrl; }
  async content() { return this.evaluate(() => document.documentElement.outerHTML); }
  async waitForSelector(selector, options = {}) {
    const deadline = Date.now() + (options.timeout || 30000);
    while (Date.now() < deadline) {
      const el = await this.$(selector);
      if (el) return el;
      await sleep(250);
    }
    throw new Error(`Waiting for selector failed: ${selector}`);
  }
  async waitForFunction(fn, options = {}, ...args) {
    const deadline = Date.now() + (options.timeout || 30000);
    while (Date.now() < deadline) {
      if (await this.evaluate(fn, ...args).catch(() => false)) return true;
      await sleep(250);
    }
    throw new Error('Waiting for function failed');
  }
  async $(selector) {
    const { result } = await this.session.send('Runtime.evaluate', { expression: `document.querySelector(${JSON.stringify(selector)})`, returnByValue: false });
    return result?.objectId ? new CdpElement(this, result.objectId) : null;
  }
  async screenshot(options = {}) {
    const params = { format: 'png', captureBeyondViewport: Boolean(options.fullPage) };
    if (options.clip) params.clip = { ...options.clip, scale: 1 };
    const { data } = await this.session.send('Page.captureScreenshot', params);
    const buffer = Buffer.from(data, 'base64');
    if (options.path) fs.writeFileSync(options.path, buffer);
    return buffer;
  }
  async bringToFront() { await this.session.send('Page.bringToFront').catch(() => {}); }
  async reload(options = {}) { return this.goto(this.currentUrl, options); }
  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.browserSession.send('Target.closeTarget', { targetId: this.targetId }).catch(() => {});
    await this.session.detach().catch(() => {});
  }
  isClosed() { return this.closed; }
  async setViewport() {}
  async setUserAgent() {}
  async setCookie(...cookies) { await this.session.send('Network.setCookies', { cookies }); }
  async cookies(...urls) {
    const result = await this.session.send('Network.getCookies', urls.length ? { urls } : {});
    return result.cookies || [];
  }
  async evaluateOnNewDocument(fn, ...args) {
    const source = typeof fn === 'function' ? `(${fn.toString()})(...${JSON.stringify(args)})` : String(fn);
    return this.session.send('Page.addScriptToEvaluateOnNewDocument', { source });
  }
}

async function createCdpPage(browser, marker = '') {
  const browserSession = await browser.target().createCDPSession();
  if (marker) {
    const { targetInfos } = await browserSession.send('Target.getTargets');
    for (const info of targetInfos.filter(item => item.type === 'page')) {
      const { sessionId } = await browserSession.send('Target.attachToTarget', { targetId: info.targetId, flatten: true }).catch(() => ({}));
      if (!sessionId) continue;
      const session = browser._connection.session(sessionId);
      const name = await session.send('Runtime.evaluate', { expression: 'window.name', returnByValue: true })
        .then(result => result.result.value || '').catch(() => '');
      if (name === marker) return new CdpPage(browserSession, session, info.targetId).initialize();
      await session.detach().catch(() => {});
    }
  }
  const { targetId } = await browserSession.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await browserSession.send('Target.attachToTarget', { targetId, flatten: true });
  const session = browser._connection.session(sessionId);
  const page = await new CdpPage(browserSession, session, targetId).initialize();
  if (marker) await page.evaluate(value => { window.name = value; }, marker);
  return page;
}

/** 附着到 URL 满足条件的已有标签（如用户打开的 BOSS 消息页），不新建、不刷新。 */
async function attachCdpPages(browser, urlPredicate) {
  const browserSession = await browser.target().createCDPSession();
  const { targetInfos } = await browserSession.send('Target.getTargets');
  const pages = [];
  for (const info of targetInfos.filter(item => item.type === 'page' && urlPredicate(item.url))) {
    const { sessionId } = await browserSession.send('Target.attachToTarget', { targetId: info.targetId, flatten: true }).catch(() => ({}));
    if (!sessionId) continue;
    pages.push(await new CdpPage(browserSession, browser._connection.session(sessionId), info.targetId).initialize());
  }
  return pages;
}

/** 等待一个新出现、URL 满足条件的标签（例如点击链接后新开的详情页），附着后返回。 */
async function waitForNewCdpPage(browser, urlPredicate, { timeout = 15000, exclude = new Set() } = {}) {
  const browserSession = await browser.target().createCDPSession();
  const deadline = Date.now() + timeout;
  try {
    while (Date.now() < deadline) {
      const { targetInfos } = await browserSession.send('Target.getTargets');
      const info = targetInfos.find(item => item.type === 'page' && !exclude.has(item.targetId) && urlPredicate(item.url));
      if (info) {
        const [page] = await attachCdpPages(browser, url => url === info.url);
        if (page) return page;
      }
      await sleep(300);
    }
  } finally {
    await browserSession.detach().catch(() => {});
  }
  return null;
}

async function listPageTargetIds(browser) {
  const browserSession = await browser.target().createCDPSession();
  try {
    const { targetInfos } = await browserSession.send('Target.getTargets');
    return new Set(targetInfos.filter(item => item.type === 'page').map(item => item.targetId));
  } finally {
    await browserSession.detach().catch(() => {});
  }
}

module.exports = { CdpPage, createCdpPage, attachCdpPages, waitForNewCdpPage, listPageTargetIds };
