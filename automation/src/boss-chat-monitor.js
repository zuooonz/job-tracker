#!/usr/bin/env node
/** BOSS 近实时沟通监测：09:00–21:00 发现变化、补录岗位、同步聊天；不生成或发送回复。 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { connectOrLaunch, releaseSession } = require('./browser');
const { TrackerApi } = require('./api');
const {
  fetchFriendList, clickRowByKey, waitHeader, extractMessages, normalizeTime, loadJobIndex, ingestNewJob,
} = require('./chat-shared');

const ROOT = path.resolve(__dirname, '..', '..');
const STATE_FILE = path.join(ROOT, 'data', 'boss-chat-monitor-state.json');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const SHANGHAI_TIMEZONE = 'Asia/Shanghai';

function parseArgs(argv) {
  const result = {
    intervalMs: 90000, once: false, baselineOnly: false,
    startHour: Number(process.env.BOSS_MONITOR_START_HOUR || 9),
    endHour: Number(process.env.BOSS_MONITOR_END_HOUR || 21),
    loginTimeoutMs: Number(process.env.BOSS_LOGIN_TIMEOUT_MINUTES || 30) * 60000,
  };
  for (const arg of argv) {
    if (arg === '--once') result.once = true;
    else if (arg === '--baseline-only') result.baselineOnly = true;
    else if (arg.startsWith('--interval=')) result.intervalMs = Math.max(30000, Number(arg.split('=')[1]) * 1000);
    else if (arg.startsWith('--start-hour=')) result.startHour = Number(arg.split('=')[1]);
    else if (arg.startsWith('--end-hour=')) result.endHour = Number(arg.split('=')[1]);
  }
  if (!(result.startHour >= 0 && result.startHour <= 23 && result.endHour >= 1 && result.endHour <= 24
      && result.startHour < result.endHour)) throw new Error('监测时段必须满足 0<=start<end<=24');
  return result;
}

function shanghaiMinutes(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: SHANGHAI_TIMEZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return Number(values.hour) * 60 + Number(values.minute);
}

function monitoringWindow(date = new Date(), startHour = 9, endHour = 21) {
  const minute = shanghaiMinutes(date);
  const start = startHour * 60;
  const end = endHour * 60;
  const active = minute >= start && minute < end;
  let deltaMinutes;
  if (active) deltaMinutes = end - minute;
  else if (minute < start) deltaMinutes = start - minute;
  else deltaMinutes = 24 * 60 - minute + start;
  return {
    active,
    nextBoundaryAt: new Date(date.getTime() + Math.max(1, deltaMinutes) * 60000).toISOString(),
    millisecondsToBoundary: Math.max(60000, deltaMinutes * 60000),
  };
}

function fingerprint(friend) {
  return `${friend.lastTime || ''}|${friend.lastMsg || ''}`;
}

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (_) { return { conversations: {} }; }
}

function writeState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify({ ...state, updated_at: new Date().toISOString() }, null, 2));
}

async function publishStatus(api, status, message, extra = {}) {
  try {
    return await api.request('/api/automation/boss/status', {
      method: 'POST',
      body: JSON.stringify({
        status, message,
        next_run_at: extra.nextRunAt || '', metadata: extra.metadata || {},
      }),
    });
  } catch (error) {
    console.error(`[status] ${error.message}`);
    return null;
  }
}

async function syncChangedFriend({ friend, page, browser, api, index, dependencies = {} }) {
  const ingest = dependencies.ingestNewJob || ingestNewJob;
  const clickRow = dependencies.clickRowByKey || clickRowByKey;
  const checkHeader = dependencies.waitHeader || waitHeader;
  const readMessages = dependencies.extractMessages || extractMessages;
  const match = friend.url.match(/job_detail\/([^/?]+)\.html/);
  let job = index.byUrl.get(friend.url) || (match ? index.byId.get(match[1]) : null);
  let newlyIngested = false;
  if (!job) {
    try {
      const created = await ingest(api, browser, friend.url);
      const detail = await api.getJob(created.id);
      job = detail.job || detail;
      newlyIngested = true;
      index.list.push(job);
      index.byUrl.set(friend.url, job);
      if (match) index.byId.set(match[1], job);
      console.log(`  auto-ingested job=${job.id} ${job.title} quality=${created.quality}`);
    } catch (error) {
      return { status: 'ingest-failed', friend: friend.name, title: friend.jobTitle, error: error.message.slice(0, 240) };
    }
  }
  const clicked = await clickRow(page, friend.name, friend.jobTitle);
  if (!clicked) return { status: 'row-not-found', jobId: job.id, ingested: newlyIngested };
  const header = await checkHeader(page, friend.name);
  if (!header.ok) return { status: 'header-mismatch', jobId: job.id, ingested: newlyIngested };
  const extraction = await readMessages(page);
  const messages = extraction.messages.filter(item => item.type === 'message').map(item => ({
    direction: item.sender === 'me' ? 'out' : 'in', content: item.text, content_type: 'text',
    sent_at: normalizeTime(item.time, ''), read_status: item.readStatus || 'unknown',
    raw: { raw_time: item.rawTime || '' },
  }));
  const imported = await api.importChat(job.id, {
    source: 'boss', active_monitoring: newlyIngested, messages,
  });
  return {
    status: 'synced', jobId: job.id, ingested: newlyIngested, messages: messages.length,
    newInbound: imported.new_inbound?.length || 0,
  };
}

function runLoginRelay(timeoutMs) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(__dirname, 'qr-relay.js'), '--exit-after-login'], {
      cwd: path.join(ROOT, 'automation'),
      env: { ...process.env, QR_EXIT_AFTER_LOGIN: '1' },
      stdio: 'inherit',
    });
    let settled = false;
    let timer;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish(false);
    }, timeoutMs);
    child.once('exit', code => finish(code === 0));
    child.once('error', () => finish(false));
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const api = new TrackerApi(process.env.TRACKER_API_URL || 'http://127.0.0.1:8888', process.env.TRACKER_API_TOKEN || '');
  const state = readState();
  state.failures = state.failures || {};
  let firstPass = !Object.keys(state.conversations || {}).length;
  let session = null;
  let shuttingDown = false;

  const closeSession = async () => {
    if (!session) return;
    const closing = session;
    session = null;
    await releaseSession(closing, { keepPage: false }).catch(() => {});
  };
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`BOSS monitor stopping (${signal})`);
    await publishStatus(api, 'offline', `执行器已停止（${signal}）`);
    await closeSession();
    process.exit(0);
  };
  process.once('SIGTERM', () => { shutdown('SIGTERM'); });
  process.once('SIGINT', () => { shutdown('SIGINT'); });

  const ensureSession = async () => {
    if (session) return session;
    session = await connectOrLaunch({
      source: 'boss', port: 18800,
      profileDir: process.env.JOB_TRACKER_BROWSER_PROFILE || path.join(ROOT, 'data', 'browser-profile'),
      chromePath: process.env.CHROME_PATH || '/usr/bin/google-chrome-stable',
    });
    await session.page.setViewport({ width: 1440, height: 900 });
    return session;
  };

  console.log(`BOSS monitor started interval=${Math.round(options.intervalMs / 1000)}s window=${options.startHour}:00-${options.endHour}:00 firstPass=${firstPass}`);
  do {
    const window = monitoringWindow(new Date(), options.startHour, options.endHour);
    if (!window.active) {
      await closeSession();
      await publishStatus(api, 'sleeping', `非监测时段（${options.startHour}:00–${options.endHour}:00）`, {
        nextRunAt: window.nextBoundaryAt, metadata: { monitor_window: `${options.startHour}:00-${options.endHour}:00` },
      });
      if (options.once) break;
      await sleep(Math.min(window.millisecondsToBoundary, 15 * 60000));
      continue;
    }

    try {
      const current = await ensureSession();
      const friends = await fetchFriendList(current.page);
      if (!friends.length) {
        await publishStatus(api, 'login_required', 'BOSS 登录已失效，正在准备扫码登录');
        await closeSession();
        const loggedIn = await runLoginRelay(options.loginTimeoutMs);
        if (!loggedIn) {
          await publishStatus(api, 'login_required', '等待重新扫码登录；稍后自动重试');
          if (options.once) break;
          await sleep(120000);
          continue;
        }
        await publishStatus(api, 'online', '扫码成功，正在恢复监测');
        if (options.once) break;
        await sleep(3000);
        continue;
      }

      const index = await loadJobIndex(api);
      const checkTime = Date.now();
      const changed = friends.filter(friend => {
        if (state.conversations[friend.key] === fingerprint(friend)) return false;
        const retryAt = Date.parse(state.failures[friend.key]?.next_retry_at || '');
        return Number.isNaN(retryAt) || retryAt <= checkTime;
      });
      console.log(`[${new Date().toISOString()}] conversations=${friends.length} changed=${changed.length}${firstPass ? ' baseline' : ''}`);
      const handled = new Set();
      if (!firstPass && !options.baselineOnly) {
        // 轻量接口轮询不会更新页面 DOM；仅在确有变化时刷新一次，让新会话行进入可点击列表。
        if (changed.length) {
          await current.page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
          await sleep(5000);
        }
        for (const friend of changed) {
          let result;
          try {
            result = await syncChangedFriend({ friend, page: current.page, browser: current.browser, api, index });
          } catch (error) {
            result = { status: 'error', error: error.message.slice(0, 240) };
          }
          console.log(`  ${friend.name} ${friend.jobTitle}: ${JSON.stringify(result)}`);
          if (result.status === 'synced') {
            handled.add(friend.key);
            delete state.failures[friend.key];
          } else {
            const attempts = (state.failures[friend.key]?.attempts || 0) + 1;
            const delayMinutes = Math.min(120, 15 * (2 ** Math.min(attempts - 1, 3)));
            state.failures[friend.key] = {
              attempts, status: result.status, error: result.error || '',
              next_retry_at: new Date(Date.now() + delayMinutes * 60000).toISOString(),
            };
          }
          await sleep(1200);
        }
      }
      for (const friend of friends) {
        const unchanged = state.conversations[friend.key] === fingerprint(friend);
        if (firstPass || options.baselineOnly || unchanged || handled.has(friend.key)) {
          state.conversations[friend.key] = fingerprint(friend);
        }
      }
      writeState(state);
      firstPass = false;
      await publishStatus(api, 'online', 'BOSS 沟通监测正常', {
        nextRunAt: new Date(Date.now() + options.intervalMs).toISOString(),
        metadata: { conversations: friends.length, changed: changed.length, monitor_window: `${options.startHour}:00-${options.endHour}:00` },
      });
    } catch (error) {
      console.error(error.stack || error.message);
      await publishStatus(api, 'error', error.message.slice(0, 240));
      await closeSession();
    }

    if (options.once) break;
    const jitter = Math.round(options.intervalMs * (0.85 + Math.random() * 0.3));
    await sleep(jitter);
  } while (!shuttingDown);
  await closeSession();
}

module.exports = { monitoringWindow, fingerprint, parseArgs, syncChangedFriend };

if (require.main === module) {
  main().catch(error => { console.error(error.stack || error.message); process.exit(1); });
}
