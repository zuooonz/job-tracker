#!/usr/bin/env node
const path = require('path');
const { connectOrLaunch, releaseSession } = require('./browser');
const { TrackerApi } = require('./api');
const { acquireBrowserLock, isInterception } = require('./access-budget');
const { detailToPayload } = require('./job-payload');
const { reviewDetail } = require('./field-quality');

const [, , source, url] = process.argv;
if (!['boss', 'liepin'].includes(source) || !url) {
  console.error('用法: node src/enrich-url.js boss|liepin URL');
  process.exit(1);
}

async function main() {
  const options = {
    source, port: 18800, city: source === 'boss' ? '101010100' : '010', maxPages: 1,
    profileDir: process.env.JOB_TRACKER_BROWSER_PROFILE || path.resolve(__dirname, '..', '..', 'data', 'browser-profile'),
    chromePath: process.env.CHROME_PATH || '/usr/bin/google-chrome-stable'
  };
  const adapter = require(`./adapters/${source}`);
  const api = new TrackerApi(
    process.env.TRACKER_API_URL || 'http://127.0.0.1:8888',
    process.env.TRACKER_API_TOKEN || ''
  );
  await api.assertAutomationAvailable(source);
  const releaseLock = acquireBrowserLock('collect');
  process.once('exit', releaseLock);
  const session = await connectOrLaunch(options);
  let failed = false;
  try {
    await api.reserveAutomationBudget(source, 'detail_opens');
    if (source === 'boss') await adapter.search(session.page, '数据产品项目经理', options);
    const rawDetail = await adapter.detail(session.page, { url });
    const { detail, quality } = reviewDetail(source, rawDetail);
    if (quality.status === 'reject') throw new Error(`字段质量审核未通过：${quality.errors.join(', ')}`);
    const stored = await api.ingestJob(detailToPayload(source, detail));
    console.log(JSON.stringify({ id: stored.id, source, title: stored.title, recruiter: stored.recruiter_name, publisherType: stored.publisher_type, quality }, null, 2));
  } catch (error) {
    failed = true;
    if (isInterception(error)) await api.request('/api/automation/budget', { method: 'POST', body: JSON.stringify({ action: 'intercept', platform: source, message: error.message }) }).catch(() => {});
    throw error;
  } finally {
    await releaseSession(session, { keepPage: failed });
    releaseLock();
    process.removeListener('exit', releaseLock);
  }
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
