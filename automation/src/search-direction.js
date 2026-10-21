const { readConfigJson } = require('./config-path');

const plan = readConfigJson('search-plan-v2.json');

const normalize = value => String(value || '').toLowerCase().replace(/\s+/g, '');
const knownDirections = new Set(plan.directions.map(item => item.id));

function candidatesFor(source, keyword) {
  const normalized = normalize(keyword);
  const candidates = new Set();
  for (const item of plan.tested_queries || []) {
    if (item.platform === source && normalize(item.keyword) === normalized && item.direction) {
      candidates.add(item.direction);
    }
  }
  for (const direction of plan.directions) {
    const queries = [...direction[source].seed, ...direction[source].variants];
    if (queries.some(query => normalize(query) === normalized)) candidates.add(direction.id);
  }
  return [...candidates];
}

function resolveSearchDirection(source, keyword, explicit = '') {
  if (explicit) {
    if (!knownDirections.has(explicit)) throw new Error(`未知检索方向 ${explicit}`);
    return explicit;
  }
  const candidates = candidatesFor(source, keyword);
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) {
    throw new Error(`关键词“${keyword}”对应多个检索方向（${candidates.join('、')}），请使用 --direction 明确指定`);
  }
  throw new Error(`关键词“${keyword}”不在检索策略中，请先纳入 search-plan-v2.json 或使用 --direction 明确指定`);
}

module.exports = { candidatesFor, resolveSearchDirection };
