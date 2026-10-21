import React from 'react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import SettingsModal from '../SettingsModal.jsx';
import App from '../../App.jsx';

const profile = { positioning: '', education: [], verified_evidence: [], target_directions: [], preferred_locations: [], evidence_boundaries: [] };
const strategy = { minimumMonthlySalaryMaxK: 0, detailPacingMs: { min: 1, max: 2 }, downrankPenalty: 0 };
const evaluation = {
  thresholds: { priority: 80, normal: 65, opportunity: 45, minimum_confidence_for_priority: 60, incomplete_jd_confidence_cap: 60, critical_gap_score_cap: 60 },
  dimensions: { one: { label: '维度一', weight: 40 }, two: { label: '维度二', weight: 50 } }, api: { model: 'test', max_tokens: 1000 },
};
const environment = {
  llm_api_key_configured: false, llm_base_url_host: '', model: '', auth_enabled: false, browser_mode: 'headless', cdp_18800_reachable: false,
  database_basename: 'test.db', automation: { usage: {}, policy: { daily_caps: {} }, cooldowns: {}, runs: {} }, platform_login_state: {},
  env_overrides: {}, first_run: { env_exists: true, api_key_configured: false, candidate_profile_is_example: false, search_plan_is_example: false, browser_reachable: false, platform_logged_in: {} },
  config_sources: {}, secrets_hint: '', candidate_profile_is_example: false,
};
function response(data, { status = 200, headers = {} } = {}) {
  return { ok: status >= 200 && status < 300, status, headers: { get: key => headers[key] || null }, json: async () => data, blob: async () => new Blob() };
}
function settingsFetch(url) {
  if (url.endsWith('/api/search-plan')) return response({ plan: { directions: [], disabled_queries: [] }, path_kind: 'private' });
  if (url.endsWith('/api/settings/search-strategy')) return response({ value: strategy, path_kind: 'private' });
  if (url.endsWith('/api/settings/candidate-profile')) return response({ value: profile, path_kind: 'private' });
  if (url.endsWith('/api/settings/evaluation-strategy')) return response({ value: evaluation, path_kind: 'private' });
  if (url.endsWith('/api/settings/automation-policy')) return response({ value: { daily_caps: { boss: { detail_opens: 1, chat_opens: 1 }, liepin: { detail_opens: 1, chat_opens: 1 } }, cooldown_minutes: 60 } });
  if (url.endsWith('/api/stats/score-bands')) return response({ bands: [] });
  if (url.endsWith('/api/tasks')) return response({ tasks: [], last_runs: {} });
  if (url.endsWith('/api/settings/environment')) return response(environment);
  return response({});
}

describe('frontend components', () => {
  beforeEach(() => { vi.stubGlobal('fetch', vi.fn(url => Promise.resolve(settingsFetch(String(url))))); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('renders each settings section and warns when evaluation weights do not total 100', async () => {
    render(<SettingsModal onClose={() => {}} onLogout={() => {}} canLogout={false} />);
    for (const title of ['检索词', '筛选规则', '候选人画像', '评价设置', '评分区间统计', '自动化访问预算', '任务', '运行环境']) {
      expect(await screen.findByText(title)).toBeTruthy();
    }
    fireEvent.click(screen.getByText('评价设置'));
    expect(await screen.findByText(/维度权重合计：90%/)).toBeTruthy();
  });

  it('shows funnel counts and requests jobs with the selected funnel_status', async () => {
    globalThis.fetch.mockImplementation(url => {
      const value = String(url);
      if (value.endsWith('/api/auth/status')) return Promise.resolve(response({ auth_enabled: false }));
      if (value.endsWith('/api/resumes')) return Promise.resolve(response({ job_ids: [] }));
      if (value.includes('/api/jobs?')) return Promise.resolve(response([], { headers: { 'X-Total-Count': '0' } }));
      if (value.endsWith('/api/config')) return Promise.resolve(response({ directions: {} }));
      if (value.includes('/api/stats?')) return Promise.resolve(response({ total: 4, funnel_statuses: { interested: 2 } }));
      if (value.endsWith('/api/evaluation-schedule')) return Promise.resolve(response({}));
      return Promise.resolve(response({}));
    });
    render(<App />);
    const interested = await screen.findByRole('button', { name: /想投/ });
    await waitFor(() => expect(interested.textContent).toContain('2'));
    fireEvent.click(interested);
    await waitFor(() => {
      expect(globalThis.fetch.mock.calls.some(([url]) => String(url).includes('funnel_status=interested'))).toBe(true);
    });
  });
});
