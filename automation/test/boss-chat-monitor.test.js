const test = require('node:test');
const assert = require('node:assert/strict');
const { monitoringWindow, parseArgs, syncChangedFriend } = require('../src/boss-chat-monitor');

test('BOSS 监测只在北京时间 09:00（含）至 21:00（不含）运行', () => {
  assert.equal(monitoringWindow(new Date('2026-08-22T00:59:00Z')).active, false);
  assert.equal(monitoringWindow(new Date('2026-08-22T01:00:00Z')).active, true);
  assert.equal(monitoringWindow(new Date('2026-08-22T12:59:00Z')).active, true);
  assert.equal(monitoringWindow(new Date('2026-08-22T13:00:00Z')).active, false);
});

test('BOSS 监测时段可以显式配置且拒绝反向区间', () => {
  const options = parseArgs(['--start-hour=8', '--end-hour=20', '--interval=45']);
  assert.equal(options.startHour, 8);
  assert.equal(options.endHour, 20);
  assert.equal(options.intervalMs, 45000);
  assert.throws(() => parseArgs(['--start-hour=21', '--end-hour=9']), /监测时段/);
});

test('变化会话对应未知岗位时只补录并同步聊天，不自动生成回复', async () => {
  const calls = { ingest: 0, import: 0 };
  const friend = {
    url: 'https://www.zhipin.com/job_detail/new-active-job.html',
    name: '招聘者', jobTitle: '数据产品项目经理',
  };
  const index = { list: [], byUrl: new Map(), byId: new Map() };
  const api = {
    getJob: async id => ({ job: { id, title: friend.jobTitle } }),
    importChat: async (id, payload) => {
      calls.import += 1;
      assert.equal(id, 301);
      assert.equal(payload.active_monitoring, true);
      return { new_inbound: [{ message_hash: 'new-message', content: '方便沟通吗？' }] };
    },
  };
  const result = await syncChangedFriend({
    friend, page: {}, browser: {}, api, index,
    dependencies: {
      ingestNewJob: async () => { calls.ingest += 1; return { id: 301, quality: 'pass' }; },
      clickRowByKey: async () => ({ x: 1, y: 1 }),
      waitHeader: async () => ({ ok: true }),
      extractMessages: async () => ({ messages: [
        { type: 'message', sender: 'other', text: '方便沟通吗？', time: '10:00', readStatus: 'unknown' },
      ] }),
    },
  });
  assert.equal(result.status, 'synced');
  assert.equal(result.ingested, true);
  assert.equal(result.newInbound, 1);
  assert.deepEqual(calls, { ingest: 1, import: 1 });
  assert.equal(index.byUrl.get(friend.url).id, 301);
});
