const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseLiepinListHtml } = require('../src/adapters/liepin-list');

test('Liepin parser reads visible logged-out cards and skips hidden decoys', () => {
  const html = fs.readFileSync(path.join(__dirname, 'fixtures', 'liepin-list-logged-out.html'), 'utf8');
  const jobs = parseLiepinListHtml(html);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].title, '产品经理/高级产品经理 (Senior) Product Manager');
  assert.equal(jobs[0].location, '示例地点');
  assert.equal(jobs[0].salary, '18-35k');
  assert.equal(jobs[0].company, '示例科技公司');
  assert.match(jobs[0].url, /^https:\/\/www\.liepin\.com\/a\/80593177\.shtml\?/);
});
