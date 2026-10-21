#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { connectOrLaunch, releaseSession } = require('./browser');
const { reviewDetail } = require('./field-quality');

const ROOT = path.resolve(__dirname, '..', '..');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function parseArgs(argv) {
  const result = { count: 3, maxPages: 1, port: 18800, closePage: true };
  for (const arg of argv) {
    if (arg === '--keep-page') result.closePage = false;
    else if (arg.startsWith('--') && arg.includes('=')) {
      const [key, ...value] = arg.slice(2).split('=');
      result[key.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value.join('=');
    } else throw new Error(`未知参数 ${arg}`);
  }
  if (!['boss', 'liepin'].includes(result.source)) throw new Error('--source 必须是 boss 或 liepin');
  if (!result.keyword) throw new Error('缺少 --keyword');
  result.count = Math.min(5, Math.max(1, Number(result.count)));
  result.maxPages = Math.max(1, Number(result.maxPages));
  result.port = Number(result.port);
  result.city ||= result.source === 'boss' ? '101010100' : '010';
  result.chromePath ||= process.env.CHROME_PATH || '/usr/bin/google-chrome-stable';
  result.profileDir ||= process.env.JOB_TRACKER_BROWSER_PROFILE || path.join(ROOT, 'data', 'browser-profile');
  return result;
}

function selectDiverse(jobs, count, source) {
  if (jobs.length <= count) return jobs;
  const selected = [];
  const add = job => {
    if (job && !selected.some(item => item.url === job.url)) selected.push(job);
  };
  if (source === 'liepin') {
    add(jobs.find(job => /\/job\//.test(job.url)));
    add(jobs.find(job => /\/a\//.test(job.url)));
  } else {
    add(jobs[0]);
    add(jobs.at(-1));
  }
  const indexes = [0, Math.floor((jobs.length - 1) / 2), jobs.length - 1];
  for (const index of indexes) add(jobs[index]);
  for (const job of jobs) add(job);
  return selected.slice(0, count);
}

async function collectEvidence(page, source) {
  return page.evaluate(site => {
    const visible = element => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0
        && rect.width > 0 && rect.height > 0;
    };
    const selectors = site === 'boss' ? {
      title: ['.info-primary .name h1', '.name h1'],
      salary: ['.name .salary'],
      location: ['.info-primary .text-city', '.location-address', '.job-location'],
      listing_status: ['.job-status'],
      experience: ['.text-experiece'],
      education: ['.text-degree'],
      tags: ['.job-detail-section:first-of-type ul li'],
      benefits: ['.job-tags span'],
      recruiter_block: ['.job-boss-info'],
      recruiter_name: ['.job-boss-info h2.name'],
      recruiter_activity: ['.job-boss-info .boss-active-time'],
      company_block: ['.sider-company'],
      company_industry: ['a[ka="job-detail-brandindustry"]'],
      work_address: ['.job-location'],
      description: ['.job-sec-text'],
      update_candidates: ['p.gray'],
      business_info: ['.business-info-box']
    } : {
      header: ['.job-apply-container', '.job-apply-content'],
      title: ['.job-apply-container .name', '.job-title-info .job-title'],
      salary: ['.job-apply-container .salary', '.job-title-info .salary'],
      properties: ['.job-properties span'],
      headcount: ['.recruit-cnt'],
      benefits: ['.job-apply-container-desc span'],
      recruiter_block: ['.recruiter-container'],
      recruiter_name: ['.recruiter-container .name', '.recruiter-container .recruiter-name'],
      recruiter_activity: ['.recruiter-container .online'],
      recruiter_verified: ['.recruiter-container .certification'],
      description: ['dd[data-selector="job-intro-content"]'],
      other_info: ['.job-intro-container dd.ellipsis-1'],
      company_info: ['.company-info-container'],
      company_labels: ['.company-info-container .label'],
      update_candidates: ['.update-time', '.time-factor-wrap']
    };
    const evidence = {};
    for (const [field, fieldSelectors] of Object.entries(selectors)) {
      evidence[field] = [];
      for (const selector of fieldSelectors) {
        for (const element of document.querySelectorAll(selector)) {
          const rect = element.getBoundingClientRect();
          evidence[field].push({
            selector,
            visible: visible(element),
            text: (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 1500),
            tag: element.tagName.toLowerCase(),
            className: typeof element.className === 'string' ? element.className : '',
            rect: { x: Math.round(rect.x), y: Math.round(rect.y + scrollY), width: Math.round(rect.width), height: Math.round(rect.height) }
          });
        }
      }
    }
    const bodyLines = (document.body?.innerText || '').split('\n').map(line => line.trim()).filter(Boolean);
    const relevantPattern = /更新|发布|招聘|招\d+人|经验|学历|本科|硕士|博士|大专|在线|活跃|认证|人数|规模|融资|行业|地址|部门|语言|五险|年假|奖金/;
    return {
      url: location.href,
      title: document.title,
      evidence,
      relevantLines: bodyLines.filter(line => relevantPattern.test(line)).slice(0, 300),
      bodyTextLength: document.body?.innerText.length || 0
    };
  }, source);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const adapter = require(`./adapters/${options.source}`);
  const outputDir = path.join(ROOT, 'data', 'field-audits', new Date().toISOString().replace(/[:.]/g, '-'));
  fs.mkdirSync(outputDir, { recursive: true });
  let session;
  let failed = false;
  try {
    session = await connectOrLaunch(options);
    const list = await adapter.search(session.page, options.keyword, options);
    const samples = selectDiverse(list.jobs, options.count, options.source);
    const results = [];
    for (let index = 0; index < samples.length; index += 1) {
      const rawDetail = await adapter.detail(session.page, samples[index]);
      const { detail, quality } = reviewDetail(options.source, rawDetail);
      await session.page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await sleep(1000);
      const dom = await collectEvidence(session.page, options.source);
      const stem = `${String(index + 1).padStart(2, '0')}-${options.source}`;
      const screenshotPath = path.join(outputDir, `${stem}.png`);
      await session.page.screenshot({ path: screenshotPath, fullPage: true });
      results.push({ sampleIndex: index + 1, listItem: samples[index], extractedRaw: rawDetail, extracted: detail, quality, dom, screenshotPath });
      fs.writeFileSync(path.join(outputDir, `${stem}.json`), JSON.stringify(results.at(-1), null, 2));
      if (index + 1 < samples.length) await sleep(7000 + Math.floor(Math.random() * 4000));
    }
    const summaryPath = path.join(outputDir, 'summary.json');
    fs.writeFileSync(summaryPath, JSON.stringify({
      source: options.source, keyword: options.keyword, searchPageUrl: list.searchPageUrl,
      listCount: list.jobs.length, sampleCount: results.length, results
    }, null, 2));
    console.log(JSON.stringify({ outputDir, summaryPath, listCount: list.jobs.length, sampleCount: results.length }, null, 2));
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    if (session) await releaseSession(session, { keepPage: failed || !options.closePage });
  }
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
