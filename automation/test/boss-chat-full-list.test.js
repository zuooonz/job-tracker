const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseArgs,
  isTransientContextError,
  isPageFatalError,
  normalizeCapturedMessages,
  upsertReportResult,
  summarizeReport,
} = require('../src/boss-chat-full-list');

test('BOSS 完整历史默认逐条执行并保留兼容参数', () => {
  const defaults = parseArgs([]);
  assert.equal(defaults.maxAttempts, 2);
  assert.equal(defaults.historyRounds, 12);
  assert.equal(defaults.resumeFile, '');
  assert.equal(defaults.dryRun, false);

  const parsed = parseArgs([
    '--offset=20', '--limit=5', '--attempts=3', '--batch-size=10',
    '--resume-file=/tmp/checkpoint.json', '--history-rounds=8', '--dry-run',
  ]);
  assert.equal(parsed.offset, 20);
  assert.equal(parsed.limit, 5);
  assert.equal(parsed.maxAttempts, 3);
  assert.equal(parsed.ignoredBatchSize, 10);
  assert.equal(parsed.historyRounds, 8);
  assert.equal(parsed.resumeFile, '/tmp/checkpoint.json');
  assert.equal(parsed.dryRun, true);
});

test('页面路由切换可重试，页面/CDP 关闭必须停止', () => {
  assert.equal(isTransientContextError(new Error('Execution context was destroyed because of a navigation')), true);
  assert.equal(isPageFatalError(new Error('Protocol error: Target closed')), true);
  assert.equal(isPageFatalError(new Error('PAGE_EVALUATE_TIMEOUT:4000')), true);
  assert.equal(isPageFatalError(new Error('conversation-timeout')), false);
});

test('消息时间按页面分组继承并保留来源序号', () => {
  const normalized = normalizeCapturedMessages([
    { direction: 'out', content: '第一条', sent_at: '2026-08-21', read_status: 'read' },
    { direction: 'in', content: '第二条', sent_at: '', read_status: 'unknown' },
  ]);
  assert.equal(normalized[0].sent_at, normalized[1].sent_at);
  assert.equal(normalized[1].raw.source, 'boss_chat_full_list');
  assert.equal(normalized[1].raw.source_message_index, 1);
});

test('断点按岗位稳定键覆盖失败结果而不是重复追加', () => {
  const report = { results: [] };
  upsertReportResult(report, { encryptJobId: 'job-a', status: 'conversation-timeout' });
  upsertReportResult(report, { encryptJobId: 'job-a', status: 'ok' });
  upsertReportResult(report, { encryptJobId: 'job-b', status: 'row-not-rendered' });
  assert.equal(report.results.length, 2);
  assert.equal(report.results[0].status, 'ok');
  assert.deepEqual(summarizeReport(report), { ok: 1, 'row-not-rendered': 1 });
});
