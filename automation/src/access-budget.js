const fs = require('node:fs');
const path = require('node:path');
const { TrackerApi } = require('./api');

const ROOT = path.resolve(__dirname, '..', '..');
const API_URL = process.env.TRACKER_API_URL || 'http://127.0.0.1:8888';

function createAccessBudget(api = new TrackerApi(API_URL)) {
  return {
    reserve(platform, kind) { return api.request('/api/automation/budget', { method: 'POST', body: JSON.stringify({ action: 'reserve', platform, kind }) }); },
    intercept(platform, message) { return api.request('/api/automation/budget', { method: 'POST', body: JSON.stringify({ action: 'intercept', platform, message }) }); },
    report(platform, kind, status, counts = {}, message = '') { return api.request('/api/automation/budget', { method: 'POST', body: JSON.stringify({ action: 'run', platform, kind, status, counts, message }) }); },
  };
}

function acquireBrowserLock(kind) {
  if (process.env.TRACKER_BROWSER_LOCK_HELD === '1') return () => {};
  const dir = path.join(ROOT, '.run');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'browser-automation.lock');
  const current = { pid: process.pid, kind, started_at: new Date().toISOString() };
  try {
    const fd = fs.openSync(file, 'wx');
    fs.writeFileSync(fd, JSON.stringify(current)); fs.closeSync(fd);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let stale = false;
    try {
      const owner = JSON.parse(fs.readFileSync(file, 'utf8'));
      try { process.kill(owner.pid, 0); } catch (e) { stale = e.code === 'ESRCH'; }
      if (stale) fs.unlinkSync(file);
    } catch { stale = true; try { fs.unlinkSync(file); } catch {} }
    if (!stale) throw new Error(`浏览器自动化正在运行（${JSON.parse(fs.readFileSync(file, 'utf8')).kind}）；请等待其结束后重试`);
    return acquireBrowserLock(kind);
  }
  let released = false;
  return () => { if (released) return; released = true; try { const owner = JSON.parse(fs.readFileSync(file, 'utf8')); if (owner.pid === process.pid) fs.unlinkSync(file); } catch {} };
}

function isInterception(error) { return /BOSS_BLOCKED|LIEPIN_BLOCKED|LIEPIN_SECURITY_CHALLENGE|about:blank|安全验证|登录/.test(String(error?.message || error)); }

module.exports = { createAccessBudget, acquireBrowserLock, isInterception };
