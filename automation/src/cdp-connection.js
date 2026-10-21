/**
 * 极简 CDP 浏览器连接（不经过 Puppeteer）。
 *
 * Puppeteer 连接浏览器时会在浏览器级开启 Target.setAutoAttach（waitForDebuggerOnStart），
 * 页面新建的 Worker / iframe 会先被挂起等待调试器放行。BOSS 消息页打开会话时依赖这类
 * Worker，被挂起后会话要几十秒才加载出来，期间页面求值也全部排队。这里只建立一条
 * 浏览器级 WebSocket，按需附着到具体标签，不做任何自动附着。
 *
 * 对外接口刻意与 cdp-page.js 用到的 Puppeteer 子集保持一致：
 *   browser.target().createCDPSession()、browser._connection.session(id)、browser.disconnect()
 */
const { EventEmitter } = require('events');

class RawSession extends EventEmitter {
  constructor(connection, sessionId) {
    super();
    this.connection = connection;
    this.sessionId = sessionId;
  }

  id() { return this.sessionId; }

  send(method, params = {}) {
    return this.connection.send(method, params, this.sessionId);
  }

  async detach() {
    if (!this.sessionId) return;
    await this.connection.send('Target.detachFromTarget', { sessionId: this.sessionId }).catch(() => {});
    this.connection.sessions.delete(this.sessionId);
  }
}

class RawConnection {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 0;
    this.pending = new Map();
    this.sessions = new Map();
    this.root = new RawSession(this, '');
    ws.addEventListener('message', event => this.onMessage(event.data));
    ws.addEventListener('close', () => {
      for (const { reject } of this.pending.values()) reject(new Error('CDP connection closed'));
      this.pending.clear();
    });
  }

  onMessage(data) {
    const message = JSON.parse(typeof data === 'string' ? data : data.toString());
    if (message.id !== undefined) {
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      if (message.error) entry.reject(new Error(`Protocol error (${entry.method}): ${message.error.message}`));
      else entry.resolve(message.result || {});
      return;
    }
    const target = message.sessionId ? this.sessions.get(message.sessionId) : this.root;
    target?.emit(message.method, message.params || {});
    if (message.method === 'Target.detachedFromTarget') this.sessions.get(message.params?.sessionId)?.emit('detached');
  }

  send(method, params = {}, sessionId = '') {
    const id = ++this.nextId;
    const payload = { id, method, params, ...(sessionId ? { sessionId } : {}) };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      try {
        this.ws.send(JSON.stringify(payload));
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  session(sessionId) {
    if (!this.sessions.has(sessionId)) this.sessions.set(sessionId, new RawSession(this, sessionId));
    return this.sessions.get(sessionId);
  }
}

class RawBrowser {
  constructor(connection) {
    this._connection = connection;
  }

  target() {
    // 浏览器级会话：复用根连接即可，detach 为空操作
    return { createCDPSession: async () => this._connection.root };
  }

  // 兼容旧代码里的 browser.newPage()：新建一个低特征 CDP 标签
  async newPage() {
    const { createCdpPage } = require('./cdp-page');
    return createCdpPage(this);
  }

  async version() {
    const result = await this._connection.send('Browser.getVersion');
    return result.product;
  }

  async disconnect() {
    try { this._connection.ws.close(); } catch (_) {}
  }

  async close() {
    await this._connection.send('Browser.close').catch(() => {});
    await this.disconnect();
  }
}

async function connectCdpBrowser({ port = 18800, host = '127.0.0.1', timeoutMs = 5000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let version;
  try {
    version = await (await fetch(`http://${host}:${port}/json/version`, { signal: controller.signal })).json();
  } finally {
    clearTimeout(timer);
  }
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('CDP WebSocket 连接失败')), { once: true });
  });
  return new RawBrowser(new RawConnection(ws));
}

module.exports = { connectCdpBrowser, RawBrowser };
