'use strict';

function resolveLlmConfig(strategy = {}, defaults = {}) {
  const env = (primary, legacy) => process.env[primary] || process.env[legacy] || '';
  const model = env('LLM_MODEL', 'DEEPSEEK_MODEL') || strategy.api?.model || defaults.model || 'deepseek-v4-flash';
  const baseUrl = env('LLM_BASE_URL', 'DEEPSEEK_BASE_URL') || defaults.baseUrl || 'https://api.deepseek.com';
  const apiKey = env('LLM_API_KEY', 'DEEPSEEK_API_KEY');
  const thinking = env('LLM_THINKING', 'DEEPSEEK_THINKING') || '';
  const maxTokens = env('LLM_MAX_TOKENS', 'DEEPSEEK_MAX_TOKENS');
  return { apiKey, baseUrl: baseUrl.replace(/\/$/, ''), model, thinking, maxTokens: maxTokens ? Number(maxTokens) : (defaults.maxTokens || strategy.api?.max_tokens) };
}

function addThinking(payload, thinking) {
  if (thinking) payload.thinking = { type: thinking };
  return payload;
}

module.exports = { resolveLlmConfig, addThinking };
