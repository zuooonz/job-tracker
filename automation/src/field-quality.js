const QUALITY_RULES_VERSION = 'field-quality-v1';

const clean = value => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : value;
const uniqueStrings = values => [...new Set((Array.isArray(values) ? values : []).map(clean).filter(Boolean))];

function normalizeLiepinUpdate(relative, now = new Date()) {
  const match = clean(relative || '').match(/^(\d{1,2})月(\d{1,2})日更新$/);
  if (!match) return '';
  let year = now.getFullYear();
  const candidate = new Date(year, Number(match[1]) - 1, Number(match[2]));
  const futureToleranceMs = 2 * 24 * 60 * 60 * 1000;
  if (candidate.getTime() - now.getTime() > futureToleranceMs) year -= 1;
  const month = String(match[1]).padStart(2, '0');
  const day = String(match[2]).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// context='chat'：沟通涉及的岗位即使已关闭、详情不全也要入库（聊天需要挂在岗位上），
// 此时“已关闭/描述过短”只记警告，不拒绝入库。
function reviewDetail(source, input, now = new Date(), { context = 'search' } = {}) {
  const detail = { ...input, metadata: { ...(input.metadata || {}) } };
  const warnings = [];
  const errors = [];

  for (const key of ['title', 'company', 'location', 'salary', 'updateTime', 'relativeUpdateTime',
    'listingStatus', 'experience', 'education', 'headcount', 'recruiterName', 'recruiterTitle',
    'recruiterCompany', 'recruiterActivity', 'companyIndustry', 'companySize', 'companyStage',
    'workAddress', 'description']) {
    if (key in detail) detail[key] = clean(detail[key]);
  }
  detail.jobTags = uniqueStrings(detail.jobTags);
  detail.benefits = uniqueStrings(detail.benefits);
  detail.recruiterTags = uniqueStrings(detail.recruiterTags);

  if (source === 'boss') {
    if (detail.updateTime) warnings.push('boss_page_update_removed_from_job_update');
    detail.updateTime = '';
    const rejectedTags = detail.jobTags.filter(tag => /许可证|认证资质/.test(tag));
    if (rejectedTags.length) warnings.push('certification_removed_from_job_tags');
    detail.jobTags = detail.jobTags.filter(tag => !/许可证|认证资质/.test(tag));
  } else if (source === 'liepin') {
    const normalized = normalizeLiepinUpdate(detail.relativeUpdateTime, now);
    if (normalized) detail.updateTime = normalized;
    else if (detail.updateTime) warnings.push('liepin_page_update_removed_from_job_update');
    if (!normalized) detail.updateTime = '';
  }

  if (detail.experience && !/不限|应届|在校|实习|\d+\s*[-至年以上]*\s*\d*年/.test(detail.experience)) {
    warnings.push(`invalid_experience:${detail.experience}`);
    detail.experience = '';
  }
  if (detail.education && !/不限|中专|中技|高中|大专|本科|硕士|博士/.test(detail.education)) {
    warnings.push(`invalid_education:${detail.education}`);
    detail.education = '';
  }
  if (detail.headcount && !/^招\s*\d+\s*人$/.test(detail.headcount)) {
    warnings.push(`invalid_headcount:${detail.headcount}`);
    detail.headcount = '';
  }
  if (detail.updateTime && !/^\d{4}-\d{2}-\d{2}$/.test(detail.updateTime)) {
    warnings.push(`invalid_job_update:${detail.updateTime}`);
    detail.updateTime = '';
  }
  if (detail.recruiterName && /在线|活跃|认证/.test(detail.recruiterName)) {
    warnings.push(`recruiter_name_contaminated:${detail.recruiterName}`);
    detail.recruiterName = '';
  }
  if (!['company_hr', 'headhunter', 'direct_manager', 'unknown'].includes(detail.publisherType)) {
    warnings.push(`invalid_publisher_type:${detail.publisherType}`);
    detail.publisherType = 'unknown';
  }

  if (!detail.url) errors.push('missing_url');
  if (!detail.title) errors.push('missing_title');
  if (!detail.company) errors.push('missing_company');
  const lenient = context === 'chat';
  if (!detail.description || detail.description.length <= 10) {
    (lenient ? warnings : errors).push('missing_or_short_description');
  }
  if (detail.isOffline) (lenient ? warnings : errors).push('job_offline');

  const status = errors.length ? 'reject' : warnings.length ? 'warn' : 'pass';
  detail.metadata.extraction_quality = {
    rules_version: QUALITY_RULES_VERSION,
    status,
    warnings,
    errors
  };
  return { detail, quality: detail.metadata.extraction_quality };
}

module.exports = { QUALITY_RULES_VERSION, normalizeLiepinUpdate, reviewDetail };
