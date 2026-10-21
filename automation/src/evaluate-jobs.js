#!/usr/bin/env node
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { TrackerApi } = require('./api');
const { resolveLlmConfig, addThinking } = require('./llm-config');

const ROOT = path.resolve(__dirname, '..', '..');
const { configPath } = require('./config-path');
const LEVELS = new Set(['priority', 'normal', 'opportunity', '']);
const FILTER_RESULTS = new Set(['pass', 'flag', 'reject']);
const HARD_RESULTS = new Set(['matched', 'partial', 'gap', 'unknown']);

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
  const args = { mode: 'preview', limit: null, api: 'http://127.0.0.1:8888', token: '', force: false };
  for (const arg of argv) {
    if (arg === '--force') args.force = true;
    else if (arg.startsWith('--') && arg.includes('=')) {
      const [key, ...parts] = arg.slice(2).split('=');
      args[key.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = parts.join('=');
    } else throw new Error(`未知参数 ${arg}`);
  }
  if (!['preview', 'test', 'write'].includes(args.mode)) throw new Error('--mode 必须是 preview、test 或 write');
  args.token ||= process.env.TRACKER_API_TOKEN || '';
  return args;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : stableJson(value)).digest('hex');
}

function loadEvaluationConfig() {
  const strategy = JSON.parse(fs.readFileSync(configPath('evaluation-strategy-v2.json'), 'utf8'));
  const profile = JSON.parse(fs.readFileSync(configPath(strategy.profile_file), 'utf8'));
  const plan = JSON.parse(fs.readFileSync(configPath('search-plan-v2.json'), 'utf8'));
  const directions = (plan.directions || []).map(item => `${item.id}: ${item.label}${item.description ? `（${item.description}）` : ''}`).join('\n');
  const prompt = fs.readFileSync(configPath('evaluation-prompt-v2.md'), 'utf8').replaceAll('{{directions}}', directions || '（尚未配置方向；请先在检索计划中添加方向）').trim();
  return { strategy, profile, prompt, directions: new Set((plan.directions || []).map(item => item.id)) };
}

function buildJobInput(job, strategy) {
  const maxJd = strategy.input.max_jd_chars;
  return {
    job_id: job.id,
    source: job.source,
    title: job.title,
    company: job.company,
    location: job.location,
    salary: job.salary,
    listing_status: job.listing_status,
    experience: job.experience,
    education: job.education,
    headcount: job.headcount,
    job_tags: job.job_tags || [],
    publisher: {
      type: job.publisher_type,
      title: job.recruiter_title,
      company: job.recruiter_company,
      activity: job.recruiter_activity
    },
    company_context: {
      industry: job.company_industry,
      size: job.company_size,
      stage: job.company_stage
    },
    work_address: job.work_address,
    page_information_quality: job.metadata?.extraction_quality || null,
    description: (job.jd || '').slice(0, maxJd),
    description_truncated: (job.jd || '').length > maxJd
  };
}

function recommendedLevel(score, confidence, criticalGap, thresholds) {
  if (score >= thresholds.priority && confidence >= thresholds.minimum_confidence_for_priority && !criticalGap) return 'priority';
  if (score >= thresholds.normal) return 'normal';
  if (score >= thresholds.opportunity) return 'opportunity';
  return '';
}

function validateResult(raw, strategy, directionsOrIncomplete = null, maybeIncompleteJd = false) {
  const directions = directionsOrIncomplete instanceof Set
    ? directionsOrIncomplete
    : new Set(JSON.parse(fs.readFileSync(configPath('search-plan-v2.json'), 'utf8')).directions.map(item => item.id));
  const incompleteJd = typeof directionsOrIncomplete === 'boolean' ? directionsOrIncomplete : maybeIncompleteJd;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('模型结果不是JSON对象');
  if (!directions.has(raw.direction)) throw new Error(`未知方向 ${raw.direction}`);
  const scores = raw.dimension_scores;
  if (!scores || typeof scores !== 'object') throw new Error('缺少dimension_scores');
  let total = 0;
  for (const [key, config] of Object.entries(strategy.dimensions)) {
    const value = scores[key];
    if (!Number.isInteger(value) || value < 0 || value > config.weight) {
      throw new Error(`维度 ${key} 分数越界`);
    }
    total += value;
  }
  if (raw.score !== total) throw new Error(`总分${raw.score}不等于维度和${total}`);
  let confidence = Number(raw.confidence_score);
  if (!Number.isInteger(confidence) || confidence < 0 || confidence > 100) throw new Error('confidence_score越界');
  if (incompleteJd) confidence = Math.min(confidence, strategy.thresholds.incomplete_jd_confidence_cap);

  const hardRequirements = Array.isArray(raw.hard_requirements) ? raw.hard_requirements.map(item => ({
    item: String(item?.item || '').trim(),
    critical: Boolean(item?.critical),
    result: HARD_RESULTS.has(item?.result) ? item.result : 'unknown',
    evidence: String(item?.evidence || '').trim()
  })).filter(item => item.item) : [];
  const contradictoryOrRequirement = hardRequirements.find(item =>
    item.result === 'partial'
    && /(?:或|任一|至少一项|之一)/.test(item.item)
    && /(?:具备|已有|满足|有.+经验)/.test(item.evidence)
    && /(?:但|不过|然而).*(?:缺少|未有|没有)/.test(item.evidence)
  );
  if (contradictoryOrRequirement) {
    throw new Error(`“或”条件已满足分支却判为partial：${contradictoryOrRequirement.item}`);
  }
  const criticalGap = hardRequirements.some(item => item.critical && item.result === 'gap');
  if (criticalGap && total > strategy.thresholds.critical_gap_score_cap) {
    throw new Error(`存在关键硬门槛缺口但总分${total}超过封顶值`);
  }
  const recommendationLevel = recommendedLevel(total, confidence, criticalGap, strategy.thresholds);
  const filterResult = FILTER_RESULTS.has(raw.filter_result) ? raw.filter_result : criticalGap ? 'flag' : 'pass';
  return {
    direction: raw.direction,
    summary: String(raw.summary || '').trim(),
    dimension_scores: scores,
    score: total,
    confidence_score: confidence,
    recommendation_level: LEVELS.has(recommendationLevel) ? recommendationLevel : '',
    match_evidence: Array.isArray(raw.match_evidence) ? raw.match_evidence.map(String).filter(Boolean).slice(0, 5) : [],
    gaps: Array.isArray(raw.gaps) ? raw.gaps.map(String).filter(Boolean).slice(0, 4) : [],
    hard_requirements: hardRequirements.slice(0, 6),
    risk_notes: String(raw.risk_notes || '').trim(),
    filter_result: filterResult,
    filter_reasons: Array.isArray(raw.filter_reasons) ? raw.filter_reasons.map(String).filter(Boolean).slice(0, 4) : [],
    resume_direction: String(raw.resume_direction || '').trim(),
    needs_resume_tailoring: Boolean(raw.needs_resume_tailoring)
  };
}

function extractJson(content) {
  const text = String(content || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('响应不包含JSON对象');
  return JSON.parse(text.slice(start, end + 1));
}

async function callModel({ baseUrl, apiKey, model, prompt, profile, jobInput, strategy, thinking, maxTokens }) {
  const llm = { maxTokens: maxTokens || strategy.api.max_tokens };
  const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
  const messages = [
    { role: 'system', content: prompt },
    { role: 'user', content: `候选人画像：\n${JSON.stringify(profile)}\n\n评价策略：\n${JSON.stringify({ dimensions: strategy.dimensions, thresholds: strategy.thresholds })}\n\n岗位信息：\n${JSON.stringify(jobInput)}` }
  ];
  let lastError;
  for (let attempt = 0; attempt < strategy.api.max_retries; attempt += 1) {
    const started = Date.now();
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify(addThinking({
          model, messages, temperature: strategy.api.temperature,
          max_tokens: llm.maxTokens,
          response_format: { type: 'json_object' }
        }, thinking)),
        signal: AbortSignal.timeout(strategy.api.timeout_ms)
      });
      const bodyText = await response.text();
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${bodyText.slice(0, 300)}`);
      const body = JSON.parse(bodyText);
      const choice = body.choices?.[0] || {};
      const message = choice.message || {};
      const output = message.content || message.reasoning_content || '';
      if (!output || !String(output).includes('{')) {
        const usage = body.usage || {};
        throw new Error(`模型未完成JSON；finish_reason=${choice.finish_reason || ''} completion_tokens=${usage.completion_tokens ?? ''} reasoning_tokens=${usage.completion_tokens_details?.reasoning_tokens ?? ''}`);
      }
      const raw = extractJson(output);
      const incompleteJd = jobInput.description.length < strategy.input.min_jd_chars;
      const normalized = validateResult(raw, strategy, strategy._directions, incompleteJd);
      return { normalized, raw, usage: body.usage || {}, latencyMs: Date.now() - started };
    } catch (error) {
      lastError = error;
      if (attempt + 1 < strategy.api.max_retries) {
        await new Promise(resolve => setTimeout(resolve, strategy.api.retry_base_ms * (2 ** attempt)));
      }
    }
  }
  throw lastError;
}

function buildEvaluationPayload(result, audit) {
  return {
    strategy_version: audit.strategyVersion,
    evaluator: 'deepseek-api',
    relevance_score: result.normalized.score,
    recommendation_level: result.normalized.recommendation_level,
    direction: result.normalized.direction,
    summary: result.normalized.summary,
    match_evidence: result.normalized.match_evidence,
    gaps: result.normalized.gaps,
    risk_notes: result.normalized.risk_notes,
    hard_requirements: result.normalized.hard_requirements,
    filter_result: result.normalized.filter_result,
    filter_reasons: result.normalized.filter_reasons,
    filter_version: audit.strategyVersion,
    resume_direction: result.normalized.resume_direction,
    needs_resume_tailoring: result.normalized.needs_resume_tailoring,
    provider: 'deepseek',
    model_name: audit.model,
    prompt_version: audit.promptVersion,
    profile_version: audit.profileVersion,
    job_content_hash: audit.jobContentHash,
    input_hash: audit.inputHash,
    confidence_score: result.normalized.confidence_score,
    dimension_scores: result.normalized.dimension_scores,
    raw_response: result.raw,
    prompt_tokens: result.usage.prompt_tokens ?? null,
    completion_tokens: result.usage.completion_tokens ?? null,
    total_tokens: result.usage.total_tokens ?? null,
    latency_ms: result.latencyMs
  };
}

async function main() {
  loadEnv(); // 先加载 .env，确保 TRACKER_API_TOKEN / DEEPSEEK_* 在构造 TrackerApi 前就绪
  const args = parseArgs(process.argv.slice(2));
  const { strategy, profile, prompt, directions } = loadEvaluationConfig();
  if (args.mode !== 'preview' && /example/i.test(String(profile.version || ''))) {
    throw new Error('候选人画像仍是公开示例，已停用评价写入和模型测试；请先填写并保存个人画像。preview 预览仍可使用。');
  }
  strategy._directions = directions;
  const limit = Math.min(strategy.batch.max_limit, Math.max(1, Number(args.limit || strategy.batch.default_limit)));
  const api = new TrackerApi(args.api, args.token);
  const requestedIds = args.jobId ? [...new Set(String(args.jobId).split(',').map(Number))] : [];
  const detailByJobId = new Map();
  let candidates;
  if (requestedIds.length) {
    const details = await Promise.all(requestedIds.slice(0, limit).map(id => api.getJob(id)));
    for (const detail of details) detailByJobId.set(detail.job.id, detail);
    candidates = details.map(detail => detail.job);
  } else {
    const params = { limit, offset: 0 };
    if (args.source) params.source = args.source;
    candidates = await api.listJobs(params);
  }
  const llmConfig = resolveLlmConfig(strategy, { maxTokens: strategy.api.max_tokens });
  const { model } = llmConfig;
  const report = { mode: args.mode, strategyVersion: strategy.version, profileVersion: profile.version, model, candidates: [], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } };

  if (args.mode !== 'preview') {
    loadEnv();
    if (!llmConfig.apiKey) throw new Error('缺少 LLM_API_KEY（或 DEEPSEEK_API_KEY），请配置项目根目录 .env');
  }

  for (const job of candidates) {
    const jobInput = buildJobInput(job, strategy);
    const inputHash = sha256({ prompt, profile, strategy: { version: strategy.version, dimensions: strategy.dimensions, thresholds: strategy.thresholds }, job: jobInput });
    const audit = {
      strategyVersion: strategy.version, promptVersion: strategy.prompt_version, profileVersion: profile.version,
      model, jobContentHash: job.content_hash, inputHash
    };
    const item = { jobId: job.id, title: job.title, inputHash, inputChars: JSON.stringify(jobInput).length, status: 'queued' };
    if (!args.force) {
      const detail = detailByJobId.get(job.id) || await api.getJob(job.id);
      const duplicate = detail.evaluations.some(evaluation => evaluation.input_hash === inputHash && evaluation.model_name === model);
      if (duplicate) {
        item.status = 'skipped_unchanged';
        report.candidates.push(item);
        continue;
      }
    }
    if (!jobInput.description || jobInput.description.length <= 10 || jobInput.page_information_quality?.status === 'reject') {
      item.status = 'skipped_invalid_detail';
      report.candidates.push(item);
      continue;
    }
    if (args.mode === 'preview') {
      item.status = 'preview';
      report.candidates.push(item);
      continue;
    }
    try {
      const result = await callModel({
        baseUrl: llmConfig.baseUrl, apiKey: llmConfig.apiKey, model, prompt, profile, jobInput, strategy, thinking: llmConfig.thinking, maxTokens: llmConfig.maxTokens
      });
      const payload = buildEvaluationPayload(result, audit);
      item.status = args.mode === 'write' ? 'persisted' : 'tested_not_persisted';
      item.score = payload.relevance_score;
      item.confidence = payload.confidence_score;
      item.totalTokens = payload.total_tokens;
      if (args.mode === 'test') item.evaluation = result.normalized;
      if (args.mode === 'write') await api.createEvaluation(job.id, payload);
      for (const key of Object.keys(report.usage)) report.usage[key] += result.usage[key] || 0;
    } catch (error) {
      item.status = 'failed';
      item.error = error.message;
    }
    report.candidates.push(item);
    await new Promise(resolve => setTimeout(resolve, strategy.batch.delay_ms));
  }

  const outputDir = path.join(ROOT, 'data', 'evaluation-runs');
  fs.mkdirSync(outputDir, { recursive: true });
  const reportPath = path.join(outputDir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${args.mode}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ reportPath, mode: args.mode, model, count: report.candidates.length, statuses: report.candidates.reduce((acc, item) => ({ ...acc, [item.status]: (acc[item.status] || 0) + 1 }), {}), usage: report.usage }, null, 2));
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = { buildEvaluationPayload, buildJobInput, extractJson, loadEvaluationConfig, recommendedLevel, sha256, validateResult };
