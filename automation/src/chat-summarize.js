#!/usr/bin/env node
/**
 * 沟通记录 AI 总结器（标准化分类 + DeepSeek API）
 *
 * 为有聊天记录的岗位调用 DeepSeek 生成标准化沟通总结，写回 applications.chat_summary。
 * 分类：rejected|offer|interview|advancing|replied|read_no_reply|unread|none
 *
 * 用法:
 *   node src/chat-summarize.js                 # 全量（有聊天记录且未总结/已过期的岗位）
 *   node src/chat-summarize.js --job-id=3      # 指定岗位
 *   node src/chat-summarize.js --limit=10      # 最多 10 个
 *   node src/chat-summarize.js --dry-run       # 只列目标
 *   node src/chat-summarize.js --force         # 忽略高峰期提示，直接运行
 *   node src/chat-summarize.js --stale-after=24  # 仅重新总结 24h 前已总结的
 */
const fs = require('fs');
const path = require('path');
const { TrackerApi } = require('./api');
const { resolveLlmConfig, addThinking } = require('./llm-config');

const ROOT = path.resolve(__dirname, '..', '..');
const { configPath } = require('./config-path');
const sleep = ms => new Promise(r => setTimeout(r, ms));

function loadEnv(filePath = path.join(ROOT, '.env')) {
  if (!fs.existsSync(filePath)) return;
  for (const rawLine of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const [key, ...parts] = line.split('=');
    if (!process.env[key]) process.env[key] = parts.join('=').trim().replace(/^(['"])(.*)\1$/, '$2');
  }
}

function parseArgs(argv) {
  const r = { jobIds: [], limit: null, dryRun: false, force: false, staleAfterHours: 72, delayMs: 1200 };
  for (const a of argv) {
    if (a === '--dry-run') r.dryRun = true;
    else if (a === '--force') r.force = true;
    else if (a.startsWith('--job-id=')) {
      for (const part of a.split('=')[1].split(',')) {
        const n = Number(part.trim());
        if (!Number.isNaN(n)) r.jobIds.push(n);
      }
    }
    else if (a.startsWith('--limit=')) r.limit = Number(a.split('=')[1]);
    else if (a.startsWith('--stale-after=')) r.staleAfterHours = Number(a.split('=')[1]);
    else if (a.startsWith('--delay=')) r.delayMs = Number(a.split('=')[1]);
  }
  return r;
}

function extractJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('响应不包含JSON对象');
  return JSON.parse(text.slice(start, end + 1));
}

/** 调用 DeepSeek（与 evaluate-jobs 同模式：超时/重试/usage） */
async function callModel({ baseUrl, apiKey, model, prompt, jobInput, messages, api, thinking, maxTokens }) {
  const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
  const payload = {
    model,
    messages: [
      { role: 'system', content: prompt },
      { role: 'user', content: `岗位信息：\n${JSON.stringify(jobInput)}\n\n沟通记录：\n${JSON.stringify(messages)}` }
    ],
    temperature: 0.1,
    max_tokens: 800,
    response_format: { type: 'json_object' }
  };
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const started = Date.now();
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify(addThinking({ ...payload, max_tokens: maxTokens || payload.max_tokens }, thinking)),
        signal: AbortSignal.timeout(90000)
      });
      const bodyText = await response.text();
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${bodyText.slice(0, 300)}`);
      const body = JSON.parse(bodyText);
      const output = body.choices?.[0]?.message?.content || '';
      if (!output || !output.includes('{')) throw new Error('模型未完成JSON');
      const normalized = extractJson(output);
      // 校验分类合法
      const VALID = new Set(['rejected', 'offer', 'interview', 'advancing', 'replied', 'read_no_reply', 'unread', 'none']);
      if (!VALID.has(normalized.category)) {
        throw new Error(`分类非法: ${normalized.category || '(空)'}`);
      }
      return { normalized, usage: body.usage || {}, latencyMs: Date.now() - started };
    } catch (error) {
      lastError = error;
      if (attempt + 1 < 2) await sleep(1500 * (2 ** attempt));
    }
  }
  throw lastError;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  loadEnv();
  const llm = resolveLlmConfig(JSON.parse(fs.readFileSync(configPath("evaluation-strategy-v2.json"), "utf8")), { maxTokens: 800 });
  if (!llm.apiKey) throw new Error('缺少 LLM_API_KEY（或 DEEPSEEK_API_KEY），请配置项目根目录 .env');
  const api = new TrackerApi(process.env.TRACKER_API_URL || 'http://127.0.0.1:8888', process.env.TRACKER_API_TOKEN || '');
  const { model, baseUrl } = llm;
  const prompt = fs.readFileSync(configPath('chat-summary-prompt.md'), 'utf8').trim();

  // 高峰期提示（复用后端 /api/evaluation-schedule 的窗口判断；--force 跳过）
  let schedule = null;
  try { schedule = await api.getEvaluationSchedule(); } catch (_) {}
  if (schedule && schedule.is_peak && !options.force) {
    console.log(`⚠️  当前为 API 价格高峰期（窗口 ${(schedule.peak_windows || []).join('、')}），费用较高。`);
    console.log(`   建议非高峰时段运行以降低成本；确认要继续请加 --force（当前已跳过，未执行）。`);
    return;
  }
  if (schedule && schedule.is_peak && options.force) {
    console.log(`⚠️  当前为高峰期，--force 已指定，继续运行（价格倍率 ${schedule.price_multiplier}）。`);
  } else if (schedule) {
    console.log(`价格倍率：${schedule.price_multiplier}（${schedule.is_peak ? '高峰' : '非高峰'}）`);
  }

  // 目标岗位：有聊天记录
  let targets = [];
  if (options.jobIds.length) {
    for (const jid of options.jobIds) {
      try {
        const resp = await api.getJob(jid);
        const job = resp?.job || resp;
        targets.push({ job_id: job.id, title: job.title, source: job.source });
      } catch (_) {}
    }
  } else {
    const jobs = await api.listJobs({ limit: 1000 });
    targets = jobs.filter(j => (j.chat_message_count || 0) > 0)
      .map(j => ({ job_id: j.id, title: j.title, source: j.source, chat_summary: j.stored_chat_summary, chat_last_at: j.chat_last_at }));
    // 新鲜度：最近总结过且聊天无新增 → 跳过
    if (!options.staleAfterHours || options.staleAfterHours <= 0) {
      // 不过滤
    } else {
      targets = targets;
    }
  }
  const scoped = options.limit ? targets.slice(0, options.limit) : targets;
  console.log(`沟通总结目标：${targets.length} 个（${options.limit ? `本次 ${scoped.length}` : '全部'}）`);
  if (options.dryRun) {
    for (const t of scoped) console.log(`  #${t.job_id} [${t.source}] ${(t.title || '').slice(0, 30)}`);
    return;
  }

  const results = [];
  for (const target of scoped) {
    try {
      const chatResp = await api.request(`/api/jobs/${target.job_id}/chat`);
      const msgs = (chatResp.messages || [])
        .map(m => ({ direction: m.direction, time: m.sent_at?.slice(0, 16) || '', status: m.read_status, content: (m.content || '').slice(0, 200) }))
        .slice(-30); // 最近 30 条足够判定
      if (!msgs.length) { results.push({ job_id: target.job_id, status: 'no-messages' }); continue; }
      const { normalized, usage } = await callModel({
        baseUrl, apiKey: llm.apiKey, model, prompt, thinking: llm.thinking || undefined, maxTokens: llm.maxTokens,
        jobInput: { id: target.job_id, title: target.title, source: target.source },
        messages: msgs, api
      });
      // 写回 chat_summary（标准化：分类前缀 + 摘要 + 下一步）
      const summaryText = `[${normalized.category}] ${normalized.summary}${normalized.next_action ? `；下一步：${normalized.next_action}` : ''}`;
      await api.request(`/api/jobs/${target.job_id}`, {
        method: 'PATCH', body: JSON.stringify({ chat_summary: summaryText }),
      });
      if (normalized.category === 'interview' && !['offer', 'closed'].includes(target.application_status)) {
        await api.request(`/api/jobs/${target.job_id}/application`, { method: 'PATCH', body: JSON.stringify({ status: 'interview' }) });
      }
      results.push({ job_id: target.job_id, status: 'ok', category: normalized.category, tokens: usage.total_tokens || 0 });
      console.log(`  #${target.job_id} ${target.title ? (target.title + ' ').slice(0, 20) : ''}→ ${normalized.category} | ${normalized.summary}${normalized.next_action ? '；' + normalized.next_action : ''}`);
    } catch (error) {
      results.push({ job_id: target.job_id, status: 'error', error: error.message.slice(0, 150) });
      console.log(`  ! #${target.job_id}: ${error.message.slice(0, 120)}`);
    }
    await sleep(options.delayMs);
  }
  const ok = results.filter(r => r.status === 'ok').length;
  const used = results.reduce((s, r) => s + (r.tokens || 0), 0);
  console.log(`\n===== 完成：${results.length} 个，成功 ${ok}，共 ${used} tokens =====`);
}

main().catch(e => { console.error(e.stack || e.message); process.exit(1); });
