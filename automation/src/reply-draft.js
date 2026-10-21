const fs = require('fs');
const path = require('path');
const { configPath } = require('./config-path');
const { resolveLlmConfig, addThinking } = require('./llm-config');

const ROOT = path.resolve(__dirname, '..', '..');
const PROMPT_VERSION = 'reply-draft-v1';

function loadEnv(filePath = path.join(ROOT, '.env')) {
  if (!fs.existsSync(filePath)) return;
  for (const raw of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const [key, ...parts] = line.split('=');
    if (!process.env[key]) process.env[key] = parts.join('=').trim().replace(/^(['"])(.*)\1$/, '$2');
  }
}

function extractJson(text) {
  const start = String(text || '').indexOf('{');
  const end = String(text || '').lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('模型响应不包含 JSON');
  return JSON.parse(String(text).slice(start, end + 1));
}

function redact(value) {
  return String(value || '')
    .replace(/(?<!\d)(?:\+?86[-\s]?)?1[3-9]\d[-\s]?\d{4}[-\s]?\d{4}(?!\d)/g, '[手机号已隐藏]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[邮箱已隐藏]')
    .replace(/(微信|vx|wechat)\s*[:：]?\s*[a-zA-Z][-_a-zA-Z0-9]{5,19}/gi, '$1：[账号已隐藏]');
}

async function generateReplyDraft(api, jobId, trigger) {
  loadEnv();
  const llm = resolveLlmConfig(JSON.parse(fs.readFileSync(configPath("evaluation-strategy-v2.json"), "utf8")), { maxTokens: 2200 });
  if (!llm.apiKey) throw new Error('缺少 LLM_API_KEY（或 DEEPSEEK_API_KEY）');
  const detail = await api.getJob(jobId);
  const chat = await api.request(`/api/jobs/${jobId}/chat`);
  const job = detail.job || detail;
  const evaluation = detail.evaluations?.[0] || {};
  const profile = JSON.parse(fs.readFileSync(configPath('candidate-profile-v2.json'), 'utf8'));
  const prompt = fs.readFileSync(configPath('reply-draft-prompt.md'), 'utf8').trim();
  const input = {
    candidate: {
      positioning: profile.positioning,
      education: profile.education,
      verified_evidence: profile.verified_evidence,
      evidence_boundaries: profile.evidence_boundaries,
    },
    job: {
      id: job.id, title: job.title, company: job.company, salary: job.salary,
      experience: job.experience, education: job.education,
      description: redact((job.jd || '').slice(0, 6000)),
      evaluation_summary: evaluation.summary || '',
      known_gaps: evaluation.gaps || [],
    },
    conversation: (chat.messages || []).slice(-20).map(message => ({
      direction: message.direction,
      time: message.sent_at,
      content: redact(message.content).slice(0, 600),
    })),
    latest_inbound: redact(trigger.content),
  };
  const { baseUrl, model } = llm;
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${llm.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(addThinking({
      model,
      messages: [
        { role: 'system', content: prompt },
        { role: 'user', content: JSON.stringify(input) },
      ],
      temperature: 0.2,
      max_tokens: llm.maxTokens || 2200,
      response_format: { type: 'json_object' },
    }, llm.thinking)),
    signal: AbortSignal.timeout(90000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`DeepSeek HTTP ${response.status}: ${text.slice(0, 240)}`);
  const body = JSON.parse(text);
  const message = body.choices?.[0]?.message || {};
  const result = extractJson(message.content || message.reasoning_content || '');
  const shouldReply = result.should_reply !== false && String(result.reply || '').trim();
  const payload = {
    job_id: jobId,
    trigger_message_hash: trigger.message_hash,
    trigger_content: trigger.content,
    generation_status: 'completed',
    suggested_reply: shouldReply ? String(result.reply).trim() : '',
    edited_reply: shouldReply ? String(result.reply).trim() : '',
    rationale: String(result.rationale || (shouldReply ? '' : '该消息无需回复')).trim(),
    risk_flags: Array.isArray(result.risk_flags) ? result.risk_flags.map(String).slice(0, 5) : [],
    model_name: model,
    prompt_version: PROMPT_VERSION,
  };
  if (!shouldReply) payload.risk_flags.unshift('模型判断该消息无需回复，请人工确认后忽略');
  return api.request('/api/reply-drafts', { method: 'POST', body: JSON.stringify(payload) });
}

async function recordDraftError(api, jobId, trigger, error) {
  return api.request('/api/reply-drafts', {
    method: 'POST',
    body: JSON.stringify({
      job_id: jobId,
      trigger_message_hash: trigger.message_hash,
      trigger_content: trigger.content,
      generation_status: 'failed',
      error: String(error?.message || error).slice(0, 500),
      prompt_version: PROMPT_VERSION,
    }),
  });
}

module.exports = { generateReplyDraft, recordDraftError, redact, PROMPT_VERSION };
