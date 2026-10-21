#!/usr/bin/env node
/**
 * 沟通记录统一爬取流水线（四个入口一次运行）
 *
 * 入口顺序（各入口独立失败隔离）：
 *   1. BOSS 消息页完整历史（含补录）
 *   2. 猎聘岗位页聊天
 *   3. 猎聘投递记录
 *
 * 跳过判断（统筹）：
 *   - 终态跳过：投递反馈为不合适/已拒绝/已关闭等，或对方消息含明确拒绝 → 后端
 *   - 新鲜度跳过：chat_synced_at 在 --stale-after 小时内 → 跳过重爬（默认 24h）。
 *   - --skip-terminal 时额外跳过已知终态岗位。
 *
 * 用法:
 *   node src/chat-pipeline.js                  # BOSS 历史 + 猎聘聊天和投递记录
 *   node src/chat-pipeline.js --only=boss      # 仅 BOSS 消息页历史
 *   node src/chat-pipeline.js --only=liepin    # 仅猎聘两个入口
 *   node src/chat-pipeline.js --entry=liepin-chat --entry=liepin-apply  # 指定入口
 *   node src/chat-pipeline.js --dry-run        # 只列目标不抓取
 *   node src/chat-pipeline.js --limit=5        # 每入口最多 5 个岗位
 *   node src/chat-pipeline.js --summarize      # 爬取完成后跑 AI 沟通总结
 *   node src/chat-pipeline.js --yes            # 总结时忽略高峰期提示直接运行
 *   node src/chat-pipeline.js --local-headed-login # 本机有头登录，两站就绪后再运行
 */
const path = require('path');
const { spawn } = require('child_process');
const { TrackerApi } = require('./api');
const { acquireBrowserLock } = require('./access-budget');

const ROOT = path.resolve(__dirname, '..', '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));

function parseArgs(argv) {
  const r = { only: null, entries: [], dryRun: false, limit: null, staleAfterHours: 24,
              delayMinMs: 1500, delayMaxMs: 1500, batchSize: 0, batchBreakMinMs: 0, batchBreakMaxMs: 0,
              summarize: false, yes: false, skipTerminal: false, noSupplement: false,
              localHeadedLogin: false, loginTimeoutMinutes: 60,
              bossResumeFile: '', skipJobIds: new Set(), maxConsecutiveErrors: 2 };
  for (const a of argv) {
    if (a === '--dry-run') r.dryRun = true;
    else if (a === '--summarize') r.summarize = true;
    else if (a === '--yes') r.yes = true;
    else if (a === '--skip-terminal') r.skipTerminal = true;
    else if (a === '--no-supplement') r.noSupplement = true;
    else if (a === '--local-headed-login') r.localHeadedLogin = true;
    else if (a.startsWith('--only=')) r.only = a.split('=')[1];
    else if (a.startsWith('--entry=')) r.entries.push(a.split('=')[1]);
    else if (a.startsWith('--limit=')) r.limit = Number(a.split('=')[1]);
    else if (a.startsWith('--stale-after=')) r.staleAfterHours = Number(a.split('=')[1]);
    else if (a.startsWith('--delay=')) r.delayMinMs = r.delayMaxMs = Number(a.split('=')[1]);
    else if (a.startsWith('--delay-min=')) r.delayMinMs = Number(a.split('=')[1]);
    else if (a.startsWith('--delay-max=')) r.delayMaxMs = Number(a.split('=')[1]);
    else if (a.startsWith('--batch-size=')) r.batchSize = Number(a.split('=')[1]);
    else if (a.startsWith('--batch-break-min=')) r.batchBreakMinMs = Number(a.split('=')[1]);
    else if (a.startsWith('--batch-break-max=')) r.batchBreakMaxMs = Number(a.split('=')[1]);
    else if (a.startsWith('--login-timeout=')) r.loginTimeoutMinutes = Number(a.split('=')[1]);
    else if (a.startsWith('--boss-resume-file=')) r.bossResumeFile = a.slice('--boss-resume-file='.length);
    else if (a.startsWith('--skip-job-ids=')) {
      for (const id of a.split('=')[1].split(',')) if (id) r.skipJobIds.add(Number(id));
    }
    else if (a.startsWith('--max-consecutive-errors=')) r.maxConsecutiveErrors = Number(a.split('=')[1]);
  }
  if (r.delayMaxMs < r.delayMinMs) throw new Error('--delay-max 不能小于 --delay-min');
  if (r.batchBreakMaxMs < r.batchBreakMinMs) throw new Error('--batch-break-max 不能小于 --batch-break-min');
  return r;
}

function randomBetween(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

function runScript(script, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(__dirname, script), ...args], {
      cwd: __dirname, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TRACKER_BROWSER_LOCK_HELD: '1' }
    });
    let out = '';
    child.stdout.on('data', d => { out += d; process.stdout.write(d); });
    child.stderr.on('data', d => { out += d; process.stderr.write(d); });
    child.on('close', (code) => {
      let parsed = null;
      // 提取最后一个完整 JSON 对象：从最后一个 '}' 反向配平找最外层 '{'（嵌套对象不截断）
      try {
        const lastClose = out.lastIndexOf('}');
        if (lastClose >= 0) {
          let depth = 0;
          let start = -1;
          let inStr = false;
          let esc = false;
          for (let i = lastClose; i >= 0; i -= 1) {
            const ch = out[i];
            if (inStr) {
              if (esc) esc = false;
              else if (ch === '\\') esc = true;
              else if (ch === '"') inStr = false;
              continue;
            }
            if (ch === '"') inStr = true;
            else if (ch === '}') depth += 1;
            else if (ch === '{') {
              depth -= 1;
              if (depth === 0) { start = i; break; }
            }
          }
          if (start >= 0) {
            const candidate = JSON.parse(out.slice(start, lastClose + 1));
            if (candidate && typeof candidate === 'object') parsed = candidate;
          }
        }
      } catch (_) { parsed = null; }
      resolve({ script, code, parsed, out: out.slice(-600) });
    });
  });
}

/** 从后端取沟通同步目标（已排除终态），按新鲜度过滤 */
async function loadTargets(api, source) {
  const targets = await api.request(`/api/chat-sync/targets?source=${encodeURIComponent(source)}`);
  return targets;
}

/** 汇总各入口结果 */
function summarize(results) {
  const summary = { entries: [] };
  for (const r of results) {
    const entry = { script: r.script, code: r.code, parsed: r.parsed || null };
    summary.entries.push(entry);
  }
  return summary;
}

/** 猎聘登录预检：投递页若被重定向到登录页则跳过该入口 */
async function liepinLoggedIn() {
  const { connectOrLaunch, releaseSession } = require('./browser');
    const session = await connectOrLaunch({ source: 'liepin', port: 18800,
    profileDir: process.env.JOB_TRACKER_BROWSER_PROFILE || path.join(ROOT, 'data', 'browser-profile'),
    chromePath: process.env.CHROME_PATH || '/usr/bin/google-chrome-stable' });
  try {
    // 猎聘 lp-security：需注入反检测，否则页面被清空为 about:blank
    await session.page.goto('https://c.liepin.com/job/record/apply', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await sleep(4000);
    const url = session.page.url() || '';
    const body = await session.page.evaluate(() => (document.body?.innerText || '').slice(0, 200)).catch(() => '');
    const loggedIn = url.includes('record/apply') || /投递|已投递|反馈/.test(body);
    return { loggedIn, url: url.slice(0, 60), hint: body.replace(/\s+/g, ' ').slice(0, 60) };
  } finally {
    await releaseSession(session, { keepPage: false }).catch(() => {});
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const api = new TrackerApi(process.env.TRACKER_API_URL || 'http://127.0.0.1:8888', process.env.TRACKER_API_TOKEN || '');

  if (options.localHeadedLogin) {
    const { waitForLocalLogins } = require('./local-headed-login');
    await waitForLocalLogins({ timeoutMinutes: options.loginTimeoutMinutes });
  }

  // 入口编排：BOSS 消息页完整历史、猎聘岗位页聊天与投递记录。
  // 平台间链接/会话完全独立，先跑完 boss 再跑 liepin：
  //   BOSS 消息页完整历史 → 猎聘岗位页聊天 → 猎聘投递记录
  const ALL_ENTRIES = ['boss-chat', 'liepin-chat', 'liepin-apply'];
  let entries = [...ALL_ENTRIES];
  if (options.only === 'boss') entries = ['boss-chat'];
  else if (options.only === 'liepin') entries = ['liepin-chat', 'liepin-apply'];
  else if (options.entries.length) entries = options.entries.filter(e => ALL_ENTRIES.includes(e));
  if (!entries.length) throw new Error('没有可运行的入口（--only=boss|liepin 或 --entry=boss-chat|liepin-chat|liepin-apply）');
  let releaseLock = null;
  if (!options.dryRun) {
    const api = new TrackerApi(process.env.TRACKER_API_URL || 'http://127.0.0.1:8888', process.env.TRACKER_API_TOKEN || '');
    const platforms = new Set(entries.map(entry => entry.startsWith('boss-') ? 'boss' : 'liepin'));
    for (const platform of platforms) await api.assertAutomationAvailable(platform);
    releaseLock = acquireBrowserLock('chat-sync');
    process.once('exit', releaseLock);
  }

  const common = [];
  if (options.dryRun) common.push('--dry-run');
  if (options.limit) common.push(`--limit=${options.limit}`);
  if (options.delayMinMs !== 1500 || options.delayMaxMs !== 1500) {
    common.push(`--delay=${options.delayMinMs}`);
  }

  console.log(`===== 沟通记录流水线启动：${entries.join(' → ')} =====`);
  if (options.dryRun) console.log('（--dry-run：只列目标，不抓取）');

  const results = [];
  for (const entry of entries) {
    console.log(`\n########## 入口：${entry} ##########`);
    try {
      if (entry === 'boss-chat' || entry === 'liepin-chat') {
        const source = entry === 'boss-chat' ? 'boss' : 'liepin';
        // BOSS 完整历史必须从沟通中心按稳定岗位 ID 逐会话读取。旧的
        // “岗位详情→继续沟通”链路对历史/下架岗位不完整，也容易打开关闭大量标签。
        if (source === 'boss') {
          const args = [];
          // 默认在消息页一次完成：补录缺失岗位 + 导入完整聊天
          if (!options.dryRun) args.push('--supplement');
          if (options.dryRun) args.push('--dry-run');
          if (options.limit) args.push(`--limit=${options.limit}`);
          if (options.bossResumeFile) args.push(`--resume-file=${options.bossResumeFile}`);
          if (options.delayMinMs !== 1500) args.push(`--item-delay=${options.delayMinMs}`);
          const r = await runScript('boss-chat-full-list.js', args);
          results.push({ script: 'boss-chat-full-list', code: r.code, parsed: r.parsed });
          continue;
        }
        // 岗位页入口：按 targets 逐岗位跑 chat.js（复用 chat-sync 的驱动方式）
        const targets = await loadTargets(api, source);
        // 猎聘岗位页也需登录态：未登录时 chat.js 会空跑（about:blank），预检后跳过
        if (source === 'liepin') {
          const pre = await liepinLoggedIn();
          if (!pre.loggedIn) {
            console.log(`[liepin-岗位页] 登录态失效（url=${pre.url}），跳过该入口。`);
            console.log('   提示：猎聘需要重新注入登录 cookie 后重试。');
            results.push({ script: 'liepin-chat', code: 0, parsed: { skipped: true, reason: 'liepin login required', count: targets.length } });
            await sleep(2000);
            continue;
          }
        }
        const staleMs = options.staleAfterHours * 3600 * 1000;
        const nowMs = Date.now();
        const toSync = targets.filter(t => {
          if (options.skipJobIds.has(Number(t.job_id))) return false;
          const syncedAt = t.chat_synced_at;
          if (!syncedAt) return true;
          const syncedMs = Date.parse(syncedAt);
          if (Number.isNaN(syncedMs)) return true;
          return (nowMs - syncedMs) > staleMs;
        });
        const skippedFresh = targets.length - toSync.length;
        const scoped = options.limit ? toSync.slice(0, options.limit) : toSync;
        console.log(`[${source}-岗位页] 目标 ${targets.length} 个，需同步 ${toSync.length}（跳过 ${skippedFresh} 个 ${options.staleAfterHours}h 内已同步）`);
        if (options.dryRun) {
          for (const t of scoped) console.log(`  #${t.job_id} ${(t.application_status || '')} 上次同步 ${t.chat_synced_at || '—'}`);
          results.push({ script: `${source}-chat`, code: 0, parsed: { dryRun: true, count: scoped.length } });
          continue;
        }
        let ok = 0;
        let skipped = 0;
        let empty = 0;
        let securityBlocked = false;
        let consecutiveErrors = 0;
        let processed = 0;
        for (const t of scoped) {
          // chat.js 只接受 source/job-id（其他参数由 pipeline 层处理）
          console.log(`[${source}-岗位页] 开始 #${t.job_id}`);
          const r = await runScript('chat.js', ['--source', source, '--job-id', String(t.job_id)]);
          const out = r.out || '';
          if (out.includes('LIEPIN_SECURITY_CHALLENGE')) {
            securityBlocked = true;
            console.log('[liepin-岗位页] 安全验证未完成，停止猎聘队列，避免继续触发风控。');
            break;
          }
          const msgCount = r.parsed?.messageCount;
          if (r.code !== 0) {
            skipped += 1;
            consecutiveErrors += 1;
            if (consecutiveErrors >= options.maxConsecutiveErrors) {
              console.log(`[${source}-岗位页] 连续 ${consecutiveErrors} 个任务失败，停止当前入口，保留现场供检查。`);
              break;
            }
          } else {
            consecutiveErrors = 0;
            if (typeof msgCount === 'number' && msgCount > 0) ok += 1;
            else empty += 1;
          }
          processed += 1;
          if (source === 'liepin' && options.batchSize > 0 && processed < scoped.length
              && processed % options.batchSize === 0) {
            const breakMs = randomBetween(options.batchBreakMinMs, options.batchBreakMaxMs);
            console.log(`[liepin-岗位页] 已处理 ${processed} 个，批次冷却 ${Math.round(breakMs / 1000)} 秒`);
            await sleep(breakMs);
          } else {
            await sleep(randomBetween(options.delayMinMs, options.delayMaxMs));
          }
        }
        results.push({ script: `${source}-chat`, code: securityBlocked ? 1 : 0,
          parsed: { count: scoped.length, ok, skipped, empty, securityBlocked } });
        if (securityBlocked) continue;
      } else if (entry === 'liepin-apply') {
        // 猎聘登录预检：未登录时投递页被 WAF 重定向到登录页，跳过并提示
        const pre = await liepinLoggedIn();
        if (!pre.loggedIn) {
          console.log(`[猎聘投递页] 登录态失效或页面未就绪（url=${pre.url} body=${pre.hint}），跳过该入口。`);
          console.log('   提示：猎聘需要重新注入登录 cookie或重新登录后重试。');
          results.push({ script: 'apply-records', code: 0, parsed: { skipped: true, reason: 'liepin login required' } });
          await sleep(2000);
          continue;
        }
        const args = [];
        if (options.dryRun) args.push('--dry-run');
        if (options.noSupplement) args.push('--no-supplement');
        args.push(`--delay-min=${options.delayMinMs}`, `--delay-max=${options.delayMaxMs}`);
        const r = await runScript('apply-records.js', args);
        results.push({ script: 'apply-records', code: r.code, parsed: r.parsed });
      }
    } catch (error) {
      results.push({ script: entry, code: 1, error: error.message.slice(0, 200) });
      console.log(`  入口失败（继续下一个）: ${error.message.slice(0, 150)}`);
    }
    await sleep(2000); // 入口间冷却
  }

  // 汇总
  console.log('\n===== 流水线汇总 =====');
  for (const r of results) {
    console.log(`  ${r.script}: 退出码 ${r.code}${r.parsed ? ' ' + JSON.stringify(r.parsed).slice(0, 200) : ''}${r.error ? ' 错误 ' + r.error : ''}`);
  }

  // 可选：AI 沟通总结
  if (options.summarize) {
    console.log('\n===== AI 沟通总结阶段 =====');
    const args = [];
    if (options.limit) args.push(`--limit=${options.limit}`);
    if (options.yes) args.push('--force');
    if (options.dryRun) args.push('--dry-run');
    const r = await runScript('chat-summarize.js', args);
    results.push({ script: 'chat-summarize', code: r.code, parsed: r.parsed });
  }
  console.log('\n流水线完成。');
  if (releaseLock) { releaseLock(); process.removeListener('exit', releaseLock); }
}

main().catch(e => { console.error(e.stack || e.message); process.exit(1); });
