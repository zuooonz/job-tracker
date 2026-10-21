const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const randomRange = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const { bestEffort } = require('../browser');
const { parseLiepinListHtml } = require('./liepin-list');

async function detectBlock(page) {
  return page.evaluate(() => {
    const url = location.href;
    const text = document.body?.innerText || '';
    return {
      // 注意：正文裸词「安全中心」不可作判定信号——公司名可能含该词（如“国家工信安全中心”）。
      // 真实安全验证页才会命中：跳到 wow 域名、标题含“安全中心”、正文出现具体风控语句、或存在验证码 DOM。
      blocked: url === 'about:blank' || url.includes('wow.liepin.com') || document.title.includes('安全中心')
        || /访问过于频繁|请完成安全验证|拖动滑块|安全验证|滑块验证/.test(text)
        || !!document.querySelector('#captcha, .captcha-modal'),
      loginRequired: url.includes('passport.liepin.com') || document.title.includes('登录'),
      url,
      title: document.title
    };
  });
}

async function search(page, keyword, options) {
  const city = options.city || '010';
  const seen = new Map();
  let firstSearchUrl = '';
  for (let pageNumber = 0; pageNumber < options.maxPages; pageNumber += 1) {
    const url = `https://www.liepin.com/zhaopin/?key=${encodeURIComponent(keyword)}&city=${city}&dq=${city}&currentPage=${pageNumber}`;
    if (!firstSearchUrl) firstSearchUrl = url;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(8000);
    const guard = await detectBlock(page);
    if (guard.blocked || guard.loginRequired) throw new Error(`LIEPIN_BLOCKED ${JSON.stringify(guard)}`);
    // 保留旧版列表采集的三段式轻滚动与等待节奏。
    await page.evaluate(() => window.scrollTo(0, 400));
    await sleep(1000);
    await page.evaluate(() => window.scrollTo(0, 800));
    await sleep(1000);
    await page.evaluate(() => window.scrollTo(0, 1200));
    await sleep(1000);
    const cardHtml = await page.evaluate(() => Array.from(document.querySelectorAll('div.jobCardPcContainer')).map(item => {
      const rect = item.getBoundingClientRect();
      if (!rect.width || !rect.height) return null;
      for (let node = item; node && node !== document.body; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return null;
      }
      return item.outerHTML;
    }).filter(Boolean));
    const jobs = cardHtml.flatMap(html => parseLiepinListHtml(html));
    for (const job of jobs) {
      seen.set(job.url.split('?')[0], { ...job, url: job.url.split('?')[0] });
    }
    if (!jobs.length) break;
    if (pageNumber + 1 < options.maxPages) await sleep(5000 + Math.random() * 3000);
  }
  return { searchPageUrl: firstSearchUrl, jobs: Array.from(seen.values()) };
}

/**
 * 猎聘“该职位已暂停招聘”页：标题包含岗位名称、公司名和招聘信息，
 * meta 描述含薪资、学历、经验。只补空缺字段，不覆盖页面上能读到的值。
 */
function liepinClosedFallback(data) {
  const out = {};
  const title = data.fallback?.pageTitle || '';
  const meta = data.fallback?.metaDescription || '';
  const match = title.match(/^【(\S+)\s+(.+?)招聘】-(.+?)(?:\1)?招聘信息/);
  if (match) {
    // 暂停招聘页上的公司/地点控件属于“推荐职位”列表，不可信：以页面标题为准。
    if (data.isOffline || !data.location) out.location = match[1];
    if (data.isOffline || !data.title) out.title = match[2];
    if (data.isOffline || !data.company) out.company = match[3];
  }
  if (!data.salary) out.salary = meta.match(/薪资([^,，]+)/)?.[1] || '';
  if (!data.education) out.education = meta.match(/要求([^,，]*?学历)/)?.[1] || '';
  if (!data.experience) out.experience = meta.match(/学历[,，]([^,，]*?经验)/)?.[1] || '';
  if (data.isOffline && !data.listingStatus) out.listingStatus = '已暂停招聘';
  return Object.fromEntries(Object.entries(out).filter(([, value]) => value));
}

async function extractJobDetail(page, url, { alreadyLoaded = false } = {}) {
  // 轻量详情提取：跳过随机鼠标/滚动动作（个别页面 mousemove 处理异常会挂死），用于补录兜底；字段提取与 detail() 完全一致。
  if (!alreadyLoaded) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(4000);
  }
  const guard = await detectBlock(page);
  if (guard.blocked || guard.loginRequired) throw new Error(`LIEPIN_BLOCKED ${JSON.stringify(guard)}`);
  const expectedPath = new URL(url).pathname.replace(/\/$/, '');
  const actualPath = new URL(page.url()).pathname.replace(/\/$/, '');
  if (actualPath !== expectedPath) throw new Error(`LIEPIN_NAVIGATION_DRIFT expected=${expectedPath} actual=${actualPath}`);
  const data = await page.evaluate(() => {
    const body = document.body?.innerText || '';
    const offline = !!document.querySelector('.apply-stop-title, .stop-apply-header, .stop-job-apply-operate')
      || /暂停招聘|职位下线|职位已关闭|该职位已停止招聘|职位已失效|已下架/.test(document.title)
      || /暂停招聘|职位下线|职位已关闭|该职位已停止招聘|职位已失效|已下架/.test(body);
    const header = document.querySelector('.job-apply-container, .job-apply-content');
    const intro = document.querySelector('.job-intro-container');
    const aside = document.querySelector('.company-info-container, .job-detail-company-box, aside');
    const descriptionEl = document.querySelector('dd[data-selector="job-intro-content"]') || intro?.querySelector('dd, .paragraph, .content');
    const propertyTexts = Array.from(header?.querySelectorAll('.job-properties span') || [])
      .map(element => element.innerText.trim()).filter(Boolean);
    const recruiter = document.querySelector('.recruiter-container');
    const recruiterText = recruiter?.innerText.split('\n').map(text => text.trim()).filter(Boolean) || [];
    const recruiterName = recruiter?.querySelector('.name, .recruiter-name')?.innerText.trim() || '';
    const recruiterActivity = recruiter?.querySelector('.online')?.innerText.trim() || '';
    const recruiterTitleLine = recruiterText.find(text => text.includes('·')) || '';
    const recruiterParts = recruiterTitleLine.split('·').map(text => text.trim()).filter(Boolean);
    const recruiterTitle = recruiterParts[0] || recruiter?.querySelector('.recruiter-title')?.innerText.trim() || '';
    const recruiterCompany = recruiterParts.slice(1).join(' · ');
    const recruiterTags = recruiterText.filter(text => /简历|回复|处理|速度/.test(text) && text !== recruiterTitleLine);
    const benefits = Array.from(document.querySelectorAll('.job-apply-container-desc span'))
      .map(element => element.innerText.trim()).filter(Boolean);
    const otherInfo = {};
    for (const element of Array.from(intro?.querySelectorAll('dd.ellipsis-1') || [])) {
      const [label, ...rest] = element.innerText.split(/[：:]/);
      if (label && rest.length) otherInfo[label.trim()] = rest.join(':').trim();
    }
    const companyInfo = document.querySelector('.company-info-container, .job-detail-company-box, [data-nick="job-detail-company-info"]');
    const companyMeta = {};
    for (const label of Array.from(companyInfo?.querySelectorAll('.label') || [])) {
      const key = label.innerText.replace(/[：:]/g, '').trim();
      const value = label.parentElement?.querySelector('.text')?.innerText.trim() || '';
      if (key && value) companyMeta[key] = value;
    }
    const pageUpdate = document.querySelector('.time-factor-wrap')?.innerText.match(/\d{4}-\d{2}-\d{2}/)?.[0] || '';
    return {
      title: header?.querySelector('.name')?.innerText.trim() || document.querySelector('.job-title-info .job-title')?.innerText.trim() || '',
      company: aside?.querySelector('.name, .company-name')?.innerText.trim() || document.querySelector('.job-title-info .company-name')?.innerText.trim() || '',
      location: header?.querySelector('.job-properties span:first-child')?.innerText.trim() || document.querySelector('.city-info, .job-title-info .city')?.innerText.trim() || '',
      salary: header?.querySelector('.salary')?.innerText.trim() || document.querySelector('.job-title-info .salary')?.innerText.trim() || '',
      updateTime: '',
      relativeUpdateTime: header?.querySelector('.update-time')?.innerText.trim() || '',
      experience: propertyTexts[1] || '',
      education: propertyTexts[2] || '',
      headcount: header?.querySelector('.recruit-cnt')?.innerText.trim() || propertyTexts[3] || '',
      benefits,
      recruiterName,
      recruiterTitle,
      recruiterCompany,
      recruiterActivity,
      recruiterTags,
      recruiterVerified: !!recruiter?.querySelector('.certification'),
      companyIndustry: companyMeta['企业行业'] || '',
      companySize: companyMeta['人数规模'] || '',
      workAddress: companyMeta['职位地址'] || '',
      metadata: {
        department: otherInfo['所属部门'] || '',
        language_requirement: otherInfo['语言要求'] || '',
        industry_requirement: otherInfo['行业要求'] || '',
        company_registered_at: companyMeta['注册时间'] || '',
        company_registered_capital: companyMeta['注册资本'] || '',
        company_business_scope: companyMeta['经营范围'] || '',
        company_description: document.querySelector('.company-intro-container .inner, .company-intro .inner')?.innerText.trim() || '',
        page_updated_at: pageUpdate,
        page_updated_at_semantics: 'page_not_job',
        field_sources: {
          job_update: '.job-apply-container .update-time',
          recruiter: '.recruiter-container',
          company: '.company-info-container'
        }
      },
      description: descriptionEl?.innerText.trim() || '',
      isOffline: offline,
      pageTextLength: body.length,
      // 暂停招聘页不再渲染岗位头部，只能从 <title> 与 meta description 兜底读取基本信息。
      fallback: {
        pageTitle: document.title,
        metaDescription: document.querySelector('meta[name="description"]')?.content || ''
      }
    };
  });
  Object.assign(data, liepinClosedFallback(data));
  delete data.fallback;
  const publisherType = /猎头|顾问/i.test(data.recruiterTitle) || /\/a\//.test(url)
    ? 'headhunter'
    : /HR|HRBP|招聘|人力|人事/i.test(data.recruiterTitle) ? 'company_hr' : 'unknown';
  return { url, ...data, publisherType };
}

async function detail(page, job) {
  await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(randomRange(2500, 5000));
  const guard = await detectBlock(page);
  if (guard.blocked || guard.loginRequired) throw new Error(`LIEPIN_BLOCKED ${JSON.stringify(guard)}`);
  // 每次随机执行 1~2 种无导航动作。禁止盲点页面坐标，否则可能点击推荐岗位，
  // 将另一岗位的详情错误绑定到当前 URL。
  const actions = page.isCdpPage ? ['pause'] : ['mouse', 'scroll', 'pause'].sort(() => 0.5 - Math.random()).slice(0, randomRange(1, 2));
  for (const action of actions) {
    if (action === 'mouse') {
      // 模拟鼠标只是反检测装饰：部分站点会让 Input.dispatchMouseEvent 挂起，加护栏卡住即跳过
      await bestEffort(page.mouse.move(randomRange(100, 800), randomRange(100, 600), { steps: randomRange(5, 15) }));
      await sleep(randomRange(500, 1500));
    } else if (action === 'scroll') {
      await bestEffort(page.evaluate(() => window.scrollTo(0, Math.floor(Math.random() * 600) + 300)));
      await sleep(randomRange(1500, 3500));
    } else {
      await sleep(randomRange(1000, 3000));
    }
  }
  const expectedPath = new URL(job.url).pathname.replace(/\/$/, '');
  const actualPath = new URL(page.url()).pathname.replace(/\/$/, '');
  if (actualPath !== expectedPath) {
    throw new Error(`LIEPIN_NAVIGATION_DRIFT expected=${expectedPath} actual=${actualPath}`);
  }
  const data = await extractJobDetail(page, job.url, { alreadyLoaded: true });
  const publisherType = /猎头|顾问/i.test(data.recruiterTitle) || /\/a\//.test(job.url)
    ? 'headhunter'
    : /HR|HRBP|招聘|人力|人事/i.test(data.recruiterTitle) ? 'company_hr' : 'unknown';
  return { ...job, ...Object.fromEntries(Object.entries(data).filter(([, value]) => value !== '')), publisherType };
}

module.exports = { search, detail, extractJobDetail, liepinClosedFallback };
