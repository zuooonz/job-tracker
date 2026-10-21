const { strategy } = require('./prefilter');

const normalize = value => String(value || '').replace(/\s+/g, ' ').trim();
const hits = (text, terms = []) => terms.filter(term => text.toLowerCase().includes(term.toLowerCase()));

function parseMonthlySalaryK(value) {
  const text = normalize(value);
  if (!text || /面议/.test(text)) return null;
  const match = text.match(/(\d+(?:\.\d+)?)\s*[-~—至]\s*(\d+(?:\.\d+)?)\s*[kK]/);
  if (!match) return null;
  return { min: Number(match[1]), max: Number(match[2]), raw: text };
}

function screenDetail(detail) {
  const title = normalize(detail.title);
  const searchable = normalize([
    title, detail.company, detail.companyIndustry,
    ...(detail.jobTags || []), detail.description
  ].join(' '));
  const reasons = [];
  // 岗位已关闭/下架/失效：采集器在页面上明确识别到（isOffline 或 listingStatus 文案）
  const listing = normalize(detail.listingStatus || detail.listing_status || '');
  const closed = detail.isOffline === true || /关闭|下架|失效|下线|停止招聘|已结束|已被删除/.test(listing);
  if (closed) reasons.push('岗位已关闭/下架/失效，不入库');
  const irrelevantHits = hits(title, strategy.hardIrrelevantTitleTerms);
  const detailIrrelevantHits = hits(searchable, strategy.hardIrrelevantDetailTerms);
  const blacklistHits = hits(title, strategy.hardTitleBlacklist);
  const domainHits = hits(searchable, strategy.domainTerms);
  const taskHits = hits(searchable, strategy.taskTerms);
  const salary = parseMonthlySalaryK(detail.salary);
  const hardExperienceHits = hits(normalize(detail.experience), strategy.hardExperienceTerms);

  if (blacklistHits.length) reasons.push(`标题命中硬排除词：${blacklistHits.join('、')}`);
  if (irrelevantHits.length) reasons.push(`标题命中无关领域词：${irrelevantHits.join('、')}`);
  if (detailIrrelevantHits.length) reasons.push(`岗位详情命中无关领域词：${detailIrrelevantHits.join('、')}`);
  for (const rule of strategy.specialCaseRules || []) {
    const matched = (rule.matchTerms || []).some(term => searchable.toLowerCase().includes(term.toLowerCase()));
    const titleMatched = !(rule.titleTerms || []).length || (rule.titleTerms || []).some(term => title.toLowerCase().includes(term.toLowerCase()));
    if (matched && titleMatched && rule.reason) reasons.push(rule.reason);
  }
  if (hardExperienceHits.length) reasons.push(`经验条件不适用：${hardExperienceHits.join('、')}`);
  if (!domainHits.length) reasons.push('岗位详情未命中目标领域锚点');
  if (!taskHits.length) reasons.push('岗位详情未命中目标任务锚点');
  if (salary && salary.max < strategy.minimumMonthlySalaryMaxK) {
    reasons.push(`月薪上限 ${salary.max}K 低于 ${strategy.minimumMonthlySalaryMaxK}K`);
  }

  return {
    rules_version: strategy.version,
    status: reasons.length ? 'reject' : 'pass',
    reasons,
    domain_hits: domainHits,
    task_hits: taskHits,
    parsed_monthly_salary_k: salary
  };
}

module.exports = { parseMonthlySalaryK, screenDetail };
