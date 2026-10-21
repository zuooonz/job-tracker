
const { readConfigJson } = require('./config-path');

const strategy = readConfigJson('search-strategy.json');

function prefilter(job) {
  const title = job.title || '';
  const location = job.location || '';
  const blacklistHits = [...strategy.hardTitleBlacklist, ...(strategy.hardIrrelevantTitleTerms || [])].filter(term =>
    title.toLowerCase().includes(term.toLowerCase())
  );
  const positiveHits = strategy.positiveTitleTerms.filter(term =>
    title.toLowerCase().includes(term.toLowerCase())
  );
  const domainHits = strategy.domainTerms.filter(term =>
    title.toLowerCase().includes(term.toLowerCase())
  );
  const downrankHits = (strategy.downrankTitleTerms || []).filter(term =>
    title.toLowerCase().includes(term.toLowerCase())
  );
  const preferredLocation = strategy.preferredLocations.some(term => location.includes(term));
  return {
    result: blacklistHits.length ? 'reject' : 'candidate',
    score: domainHits.length * 20 + positiveHits.length * 5
      - downrankHits.length * (strategy.downrankPenalty || 0) + (preferredLocation ? 3 : 0),
    blacklistHits,
    positiveHits,
    domainHits,
    downrankHits,
    reason: blacklistHits.length ? `标题命中硬排除词：${blacklistHits.join('、')}` : ''
  };
}

module.exports = { prefilter, strategy };
