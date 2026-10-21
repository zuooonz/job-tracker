const fs = require('fs');
const path = require('path');
const Tesseract = require('tesseract.js');
const { bestEffort } = require('../browser');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const randomRange = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

async function detectBlock(page) {
  return page.evaluate(() => {
    const url = location.href;
    const text = document.body?.innerText || '';
    return {
      // 反爬命中时页面会被重定向到 about:blank，按拦截处理并立即停止。
      blocked: url === 'about:blank' || url.includes('/safe/verify') || url.includes('verify-slider') || /安全验证|拖动滑块/.test(text),
      loginRequired: url.includes('login.zhipin.com') || /扫码登录|手机号登录/.test(text),
      url,
      title: document.title
    };
  });
}

async function search(page, keyword, options) {
  const city = options.city || '101010100';
  const searchPageUrl = `https://www.zhipin.com/web/geek/job?query=${encodeURIComponent(keyword)}&city=${city}`;
  await page.goto(searchPageUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(2000);
  const guard = await detectBlock(page);
  if (guard.blocked || guard.loginRequired) throw new Error(`BOSS_BLOCKED ${JSON.stringify(guard)}`);
  try {
    await page.waitForSelector('.job-card-box', { timeout: 15000 });
  } catch (error) {
    const diagnostics = await page.evaluate(() => ({
      url: location.href,
      title: document.title,
      bodyText: (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 500),
      jobCards: document.querySelectorAll('.job-card-box').length,
      jobLinks: document.querySelectorAll('a[href*="/job_detail/"]').length,
      verifyElements: document.querySelectorAll('[class*="verify"], [class*="captcha"], [id*="verify"], [id*="captcha"]').length
    })).catch(() => ({ url: page.url() }));
    throw new Error(`BOSS_LIST_NOT_READY ${JSON.stringify(diagnostics)}`);
  }

  const seen = new Map();
  for (let batch = 0; batch < options.maxPages; batch += 1) {
    const jobs = await page.evaluate(() => Array.from(document.querySelectorAll('.job-card-box')).map(item => {
      const titleEl = item.querySelector('.job-name');
      const companyEl = item.querySelector('.boss-name') || item.querySelector('.company-name');
      const linkEl = item.querySelector('a.job-name') || item.querySelector('.job-title a');
      const locationEl = item.querySelector('.company-location') || item.querySelector('.job-area');
      const salaryEl = item.querySelector('.job-salary') || item.querySelector('.salary');
      const rawSalary = salaryEl?.innerText.trim() || '';
      const salaryEncrypted = /[\uE000-\uF8FF]/.test(rawSalary);
      return {
        title: titleEl?.innerText.trim() || '', company: companyEl?.innerText.trim() || '',
        url: linkEl?.href || '', location: locationEl?.innerText.trim() || '',
        salary: salaryEncrypted ? '' : rawSalary,
        salaryEncrypted
      };
    }).filter(job => job.title && job.url));
    for (const job of jobs) seen.set(job.url.split('?')[0], { ...job, url: job.url.split('?')[0] });
    if (batch + 1 >= options.maxPages) break;
    const previous = jobs.length;
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    try {
      await page.waitForFunction(count => document.querySelectorAll('.job-card-box').length > count, { timeout: 8000 }, previous);
      await sleep(1000 + Math.random() * 2000);
    } catch (_) { break; }
  }
  return { searchPageUrl, jobs: Array.from(seen.values()) };
}

let ocrWorker = null;
let ocrIdleTimer = null;

async function ocrSalary(page, element) {
  if (!element) return '';
  const tempDir = fs.mkdtempSync('/tmp/job-tracker-ocr-');
  const imagePath = path.join(tempDir, 'salary.png');
  try {
    await element.screenshot({ path: imagePath });
    // 复用同一个 OCR worker：每次新建要重新加载模型，单个岗位会多花数秒。
    clearTimeout(ocrIdleTimer);
    ocrWorker ||= Tesseract.createWorker('eng');
    const worker = await ocrWorker;
    const result = await Promise.race([
      worker.recognize(imagePath),
      new Promise((_, reject) => setTimeout(() => reject(new Error('OCR_TIMEOUT')), 20000)),
    ]).catch(async error => {
      // 识别卡住时丢弃该 worker，薪资留空，不拖住整个详情采集。
      if (ocrWorker) await closeOcr();
      return { data: { text: '' }, error };
    });
    // 空闲 20 秒自动释放，避免 worker 让一次性脚本无法退出。
    ocrIdleTimer = setTimeout(() => { closeOcr(); }, 20000);
    return result.data.text.trim();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function detail(page, job, { alreadyLoaded = false } = {}) {
  // alreadyLoaded：页面已由用户式点击（如消息页“查看职位”）打开，不再自行跳转。
  if (!alreadyLoaded) await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(3000);
  const guard = await detectBlock(page);
  if (guard.blocked || guard.loginRequired) throw new Error(`BOSS_BLOCKED ${JSON.stringify(guard)}`);
  await sleep(randomRange(1500, 3000));
  // 模拟鼠标运动/滚动只是反检测装饰：BOSS 页面反爬监听会让 Input.dispatchMouseEvent
  // 与 smooth 滚动挂起（实测必挂），全部加超时护栏，卡住直接跳过。
  await bestEffort(page.mouse.move(randomRange(100, 800), randomRange(100, 600), { steps: randomRange(5, 15) }));
  await bestEffort(page.evaluate(() => window.scrollTo(0, Math.floor(Math.random() * 600) + 300)));
  await sleep(randomRange(1000, 2000));
  await page.waitForSelector('.job-detail-box, .info-primary, .error-page', { timeout: 15000 });
  const data = await page.evaluate(() => {
    const body = document.body?.innerText || '';
    const listingStatus = document.querySelector('.job-status')?.innerText.trim() || '';
    const offline = document.title.includes('出错啦') || !!document.querySelector('.error-page')
      || /职位已下线|已被BOSS删除|职位已关闭|岗位已关闭|该职位已停止招聘|职位已失效|已下架/.test(body)
      || /关闭|下架|失效|下线|停止招聘/.test(listingStatus);
    const companyLinks = Array.from(document.querySelectorAll('.sider-company .company-info a'));
    const companyEl = companyLinks.find(el => el.innerText.trim()) || document.querySelector('.company-info a[target="_blank"]');
    // 新版布局没有 .sider-company，公司名在 <span class="brand-name">（如“代招公司：某人工智能公司”）
    const brandCompany = (document.querySelector('.brand-name')?.innerText.trim() || '')
      .replace(/^(代招|猎头|招聘)?公司[：:]\s*/, '').trim();
    const company = companyEl?.innerText.trim() || brandCompany;
    const recruiter = document.querySelector('.job-boss-info');
    const recruiterAttr = recruiter?.querySelector('.boss-info-attr')?.innerText.split(/[·\n]/).map(text => text.trim()).filter(Boolean) || [];
    const sideCompany = document.querySelector('.sider-company');
    const sideFacts = Array.from(sideCompany?.querySelectorAll('p, a') || []).map(element => element.innerText.trim()).filter(Boolean);
    const pageUpdate = Array.from(document.querySelectorAll('p.gray')).map(element => element.innerText)
      .join(' ').match(/\d{4}-\d{2}-\d{2}/)?.[0] || '';
    const jobTags = Array.from(document.querySelectorAll('.job-keyword-list li'))
      .map(element => element.innerText.replace(/\s+/g, '').trim()).filter(text => text && text.length <= 30);
    const recruiterCertifications = Array.from(document.querySelectorAll('.company-certification .certification-tags li'))
      .map(element => element.innerText.trim()).filter(Boolean);
    const businessText = document.querySelector('.business-info-box')?.innerText.trim() || '';
    return {
      title: document.querySelector('.info-primary .name h1, .name h1')?.innerText.trim() || '',
      company,
      location: document.querySelector('.info-primary .text-city, .location-address')?.innerText.trim() || '',
      updateTime: '',
      listingStatus,
      experience: document.querySelector('.text-experiece')?.innerText.trim() || '',
      education: document.querySelector('.text-degree')?.innerText.trim() || '',
      jobTags,
      benefits: [...new Set(Array.from(document.querySelectorAll('.job-tags span')).map(element => element.innerText.trim()).filter(Boolean))],
      recruiterName: Array.from(recruiter?.querySelector('h2.name')?.childNodes || [])
        .filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent.trim()).find(Boolean) || '',
      recruiterTitle: recruiterAttr.length >= 2 ? recruiterAttr.at(-1) : '',
      recruiterCompany: recruiterAttr.length >= 2 ? recruiterAttr[0] : '',
      recruiterActivity: recruiter?.querySelector('.boss-active-time')?.innerText.trim() || '',
      recruiterVerified: !!recruiter?.querySelector('.icon-vip, .boss-verified, [class*="verified"], img[alt*="认证"]'),
      companyStage: sideFacts.find(text => /轮|上市|融资|未融资|不需要融资/.test(text)) || '',
      companySize: sideFacts.find(text => /\d+.*人/.test(text)) || '',
      companyIndustry: sideCompany?.querySelector('a[ka="job-detail-brandindustry"]')?.innerText.trim() || '',
      workAddress: document.querySelector('.job-location')?.innerText.split('\n')[0]?.trim() || '',
      metadata: {
        page_updated_at: pageUpdate,
        page_updated_at_semantics: 'page_not_job',
        recruiter_certifications: recruiterCertifications,
        field_sources: {
          job_tags: '.job-keyword-list li',
          recruiter_certifications: '.company-certification .certification-tags li',
          recruiter: '.job-boss-info',
          page_updated_at: 'p.gray'
        }
      },
      // 已关闭岗位的描述通常仍在页面上（折叠状态），照样保留，由入库方决定如何处理。
      description: document.querySelector('.job-sec-text')?.innerText.trim() || '',
      isOffline: offline
    };
  });
  if (data.isOffline && !data.listingStatus) data.listingStatus = '已关闭';
  const salaryEl = await page.$('.name .salary');
  const rawSalary = salaryEl ? await page.evaluate(el => el.innerText.trim(), salaryEl) : '';
  data.salary = /[\uE000-\uF8FF]/.test(rawSalary) ? await ocrSalary(page, salaryEl) : rawSalary;
  const publisherType = /猎头|顾问/.test(data.recruiterTitle)
    ? 'headhunter'
    : /HR|招聘|人力/.test(data.recruiterTitle) ? 'company_hr' : 'direct_manager';
  return { ...job, ...Object.fromEntries(Object.entries(data).filter(([, value]) => value !== '')), publisherType };
}

async function closeOcr() {
  clearTimeout(ocrIdleTimer);
  if (!ocrWorker) return;
  // 先同步清空引用，再终止，避免下一次识别拿到正在被终止的 worker 而挂死。
  const pending = ocrWorker;
  ocrWorker = null;
  const worker = await pending.catch(() => null);
  await worker?.terminate().catch(() => {});
}

module.exports = { search, detail, closeOcr };
