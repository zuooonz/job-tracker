import React, { useCallback, useEffect, useRef, useState } from 'react';
import LoginScreen from './Login.jsx';
import SettingsModal from './components/SettingsModal.jsx';
import FunnelSidebar from './components/Sidebar.jsx';
import JobItem from './components/JobItem.jsx';
import { Icons } from './components/icons.jsx';
import { apiFetch, fetchJson, getToken, saveToken, UnauthorizedError } from './api.js';

// 分页：首屏 20 条，滚动追加每次 50 条
const INITIAL_PAGE = 20;
const APPEND_PAGE = 50;

// 评分状态（合并 AI 评价 + 人工评分为一个下拉；标签内置在选项文字中）
const SCORE_STATE_ORDER = ['all', 'evaluated', 'unevaluated', 'rated', 'unrated'];
const SCORE_STATE_LABELS = {
  all: '评分：全部', evaluated: '评分：AI 已评', unevaluated: '评分：AI 未评',
  rated: '评分：人工已评', unrated: '评分：人工未评',
};
const FUNNEL_STAGES = ['all', 'todo', 'interested', 'contacted', 'interview', 'offer', 'closed', 'excluded'];
const FUNNEL_LABELS = { all: '全部', todo: '待看', interested: '想投', contacted: '已沟通', interview: '面试', offer: 'Offer', closed: '结束', excluded: '排除' };
const DIMENSION_LABELS = {
  domain_task_alignment: '领域任务', evidence_transferability: '证据迁移', hard_requirements: '硬门槛',
  seniority_scope: '职级范围', career_value: '职业价值', practical_constraints: '现实约束',
};

const SCORE_PRESETS = [
  { label: '全部', min: null, max: null },
  { label: '≥60', min: 60, max: null },
  { label: '≥70', min: 70, max: null },
  { label: '60–80', min: 60, max: 80 },
  { label: '≤50', min: null, max: 50 },
];

const clampScore = (value) => Math.min(100, Math.max(0, Number(value) || 0));

// 匹配分范围控件（最低–最高 + 快捷预设）；桌面/移动共用同一份状态
function ScoreRangeControl({ minScore, maxScore, onMinChange, onMaxChange, compact = false }) {
  const active = (preset) => (minScore ?? 0) === (preset.min ?? 0) && (maxScore ?? 100) === (preset.max ?? 100);
  return (
    <div className={`score-range-control ${compact ? 'compact' : ''}`}>
      <div className="score-range-inputs">
        <input
          type="number" min="0" max="100" placeholder="最低"
          value={minScore ?? ''}
          onChange={(event) => onMinChange(event.target.value === '' ? null : clampScore(event.target.value))}
        />
        <span className="score-range-sep">–</span>
        <input
          type="number" min="0" max="100" placeholder="最高"
          value={maxScore ?? ''}
          onChange={(event) => onMaxChange(event.target.value === '' ? null : clampScore(event.target.value))}
        />
      </div>
      {!compact && <div className="score-presets">
        {SCORE_PRESETS.map((preset) => (
          <button
            type="button"
            key={preset.label}
            className={`score-preset ${active(preset) ? 'active' : ''}`}
            onClick={() => { onMinChange(preset.min); onMaxChange(preset.max); }}
          >
            {preset.label}
          </button>
        ))}
      </div>}
    </div>
  );
}

// 排序选项：默认评分高→低（标签内置）
const SORT_OPTIONS = [
  { value: 'score_desc', label: '排序：AI 高分→低' },
  { value: 'score_asc', label: '排序：AI 低分→高' },
  { value: 'manual_score_desc', label: '排序：人工高分→低' },
  { value: 'manual_score_asc', label: '排序：人工低分→高' },
  { value: 'updated_desc', label: '排序：最新更新' },
  { value: 'updated_asc', label: '排序：最早更新' },
];
// 来源过滤器（BOSS直聘 / 猎聘）
const SOURCE_OPTIONS = [
  { value: 'all', label: '来源：全部' },
  { value: 'boss', label: '来源：BOSS' },
  { value: 'liepin', label: '来源：猎聘' },
];
// 展开内容（JD / AI 分析 / 沟通记录）统一控件（标签内置）
const EXPAND_OPTIONS = [
  { value: 'none', label: '展开：收起' },
  { value: 'jd', label: '展开：JD' },
  { value: 'ai', label: '展开：AI' },
  { value: 'chat', label: '展开：沟通' },
  { value: 'jd_ai', label: '展开：JD+AI' },
  { value: 'jd_chat', label: '展开：JD+沟通' },
  { value: 'ai_chat', label: '展开：AI+沟通' },
  { value: 'all', label: '展开：全部' },
];

export default function App() {
  const [jobs, setJobs] = useState([]);
  const [config, setConfig] = useState({ directions: {} });
  const [stats, setStats] = useState({ total: 0, funnel_statuses: {}, review_total: 0, application_total: 0, review_statuses: {}, application_statuses: {} });
  const [funnelStatus, setFunnelStatus] = useState('all');
  const [activeCardIdx, setActiveCardIdx] = useState(-1);
  const [showHelp, setShowHelp] = useState(false);
  const [evaluationFilter, setEvaluationFilter] = useState('all');
  const [sourceFilter, setSourceFilter] = useState('all');
  const [ratingFilter, setRatingFilter] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [minScore, setMinScore] = useState(null);
  const [maxScore, setMaxScore] = useState(null);
  const [jdMode, setJdMode] = useState(true); // 默认展开岗位描述（列表携带完整 JD）
  const [aiMode, setAiMode] = useState(false); // 是否展开 AI 分析（数据始终在响应中，仅控制渲染）
  const [chatMode, setChatMode] = useState(false); // 是否展开沟通记录（默认折叠，展开时按需拉取消息）
  const jdModeRef = useRef(true);
  const [sort, setSort] = useState('score_desc');
  const [loading, setLoading] = useState(true);
  const [totalRows, setTotalRows] = useState(0);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [evaluationSchedule, setEvaluationSchedule] = useState(null);
  const [token, setToken] = useState(() => getToken());
  const [authStatus, setAuthStatus] = useState('unknown'); // unknown | off | on
  const [resumeJobs, setResumeJobs] = useState(() => new Set()); // 已有定制简历的岗位 id
  const [loadError, setLoadError] = useState('');
  const [appending, setAppending] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const appendInFlightRef = useRef(false);
  const loadMoreRef = useRef(null);
  const jobsRef = useRef([]);
  const configRef = useRef(config);
  const hasLoadedRef = useRef(false);
  const requestSequenceRef = useRef(0);
  const retryTimerRef = useRef(null);

  useEffect(() => { jobsRef.current = jobs; }, [jobs]);
  useEffect(() => { configRef.current = config; }, [config]);
  useEffect(() => { jdModeRef.current = jdMode; }, [jdMode]);
  useEffect(() => () => retryTimerRef.current && clearTimeout(retryTimerRef.current), []);

  // 拉取已有定制简历的岗位集合（登录态变化后重试一次）
  useEffect(() => {
    let cancelled = false;
    apiFetch('/api/resumes', { cache: 'no-store' })
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (!cancelled && data) setResumeJobs(new Set(data.job_ids || []));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [token]);

  // 在新标签页打开岗位定制简历 PDF（带鉴权头，blob URL 避免 token 泄露到地址栏）
  const openResume = async (jobId) => {
    try {
      const response = await apiFetch(`/api/jobs/${jobId}/resume`, { cache: 'no-store' }, 20000);
      if (!response.ok) return;
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank', 'noopener');
    } catch { /* 静默失败 */ }
  };

  // 探测后端是否启用鉴权：200+auth_enabled=false → 本地模式；401 → 需要登录；200+auth_enabled=true → 已带令牌
  useEffect(() => {
    let cancelled = false;
    const probe = async () => {
      try {
        const response = await apiFetch('/api/auth/status', { cache: 'no-store' });
        if (cancelled) return;
        if (response.ok) {
          const data = await response.json();
          setAuthStatus(data.auth_enabled ? 'on' : 'off');
        } else if (response.status === 401) {
          setAuthStatus('on');
        } else {
          setAuthStatus('off');
        }
      } catch {
        if (!cancelled) setAuthStatus('off'); // 网络异常按本地模式尝试，loadData 会重试
      }
    };
    probe();
    return () => { cancelled = true; };
  }, []);

  const handleLogin = (newToken) => {
    saveToken(newToken);
    setToken(newToken);
    setAuthStatus('on');
    loadData();
  };

  const handleLogout = () => {
    setShowSettings(false);
    saveToken(null);
    setToken(null);
    setJobs([]);
    setStats({ total: 0, funnel_statuses: {}, review_total: 0, application_total: 0, review_statuses: {}, application_statuses: {} });
    setTotalRows(0);
    hasLoadedRef.current = false;
  };

  const loadData = useCallback(async ({ quiet = false, append = false } = {}) => {
    // 滚动追加保护：同一时间只允许一个追加请求在途
    if (append && appendInFlightRef.current) return;
    if (append) appendInFlightRef.current = true;
    if (append) setAppending(true);
    if (!quiet) setLoading(true);
    const requestSequence = ++requestSequenceRef.current;
    try {
      const params = new URLSearchParams({
        // 首屏 20 条；追加每次 50 条；刷新/轮询保持当前已加载的窗口
        limit: String(append ? APPEND_PAGE : Math.max(INITIAL_PAGE, jobsRef.current.length)),
        offset: String(append ? jobsRef.current.length : 0),
        funnel_status: funnelStatus,
        source: sourceFilter,
        evaluation_status: evaluationFilter,
        rating_status: ratingFilter,
        min_score: String(minScore ?? 0),
        max_score: String(maxScore ?? 100),
        sort,
      });
      if (searchQuery.trim()) params.set('q', searchQuery.trim());
      if (jdModeRef.current) params.set('include_jd', '1');
      // 侧栏交集计数：把当前筛选条件传给 /api/stats（后端按组扣除自身维度后计数）
      const statsParams = new URLSearchParams({
        source: sourceFilter,
        evaluation_status: evaluationFilter,
        rating_status: ratingFilter,
        min_score: String(minScore ?? 0),
        max_score: String(maxScore ?? 100),
      });
      if (searchQuery.trim()) statsParams.set('q', searchQuery.trim());
      const [jobsResult, configResult, statsResult, scheduleResult] = await Promise.allSettled([
        fetchJson(`/api/jobs?${params}`, 3),
        fetchJson('/api/config'),
        fetchJson(`/api/stats?${statsParams}`),
        fetchJson('/api/evaluation-schedule'),
      ]);
      if (requestSequence !== requestSequenceRef.current) return;
      if (jobsResult.status !== 'fulfilled') throw jobsResult.reason;
      const { data: jobRows, response: jobsResponse } = jobsResult.value;
      const cfg = configResult.status === 'fulfilled' ? configResult.value.data : configRef.current;
      const decorated = jobRows.map((job) => ({
        ...job,
        search_direction_labels: (job.search_directions || []).map((id) => cfg.directions[id] || id),
        evaluation_direction_label: job.evaluation_direction
          ? (cfg.directions[job.evaluation_direction] || job.evaluation_direction) : '',
      }));
      setJobs((current) => append ? [...current, ...decorated] : decorated);
      setTotalRows(Number(jobsResponse.headers.get('X-Total-Count') || decorated.length));
      if (configResult.status === 'fulfilled') setConfig(cfg);
      if (statsResult.status === 'fulfilled') setStats(statsResult.value.data);
      if (scheduleResult.status === 'fulfilled') setEvaluationSchedule(scheduleResult.value.data);
      hasLoadedRef.current = true;
      setLoadError('');
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    } catch (error) {
      console.error(error);
      if (error instanceof UnauthorizedError) {
        saveToken(null);
        setToken(null);
        setAuthStatus('on');
        return;
      }
      if (requestSequence === requestSequenceRef.current) {
        if (!hasLoadedRef.current) setLoading(false); // 首次失败立即退出"正在连接"，避免无限转圈
        setLoadError('连接服务失败，正在自动重试…');
        if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
        retryTimerRef.current = setTimeout(() => loadData({ quiet: true }), 1500);
      }
    } finally {
      if (append) {
        appendInFlightRef.current = false;
        setAppending(false);
      }
      if (requestSequence === requestSequenceRef.current && hasLoadedRef.current) setLoading(false);
    }
  }, [funnelStatus, sourceFilter, evaluationFilter, ratingFilter, minScore, maxScore, sort, searchQuery]);

  // 滚动到底部自动加载更多（IntersectionObserver 哨兵）
  useEffect(() => {
    const el = loadMoreRef.current;
    if (!el) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)
        && jobs.length < totalRows && !appendInFlightRef.current) {
        loadData({ quiet: true, append: true });
      }
    }, { rootMargin: '300px' });
    observer.observe(el);
    return () => observer.disconnect();
  }, [jobs.length, totalRows, loadData]);

  const authReady = authStatus !== 'unknown' && (authStatus === 'off' || Boolean(token));

  useEffect(() => {
    if (!authReady) return;
    const initial = setTimeout(() => loadData(), searchQuery ? 250 : 0);
    const interval = setInterval(() => loadData({ quiet: true }), 10000);
    const onFocus = () => { loadData({ quiet: true }); };
    window.addEventListener('focus', onFocus);
    return () => {
      clearTimeout(initial);
      clearInterval(interval);
      window.removeEventListener('focus', onFocus);
    };
  }, [loadData, searchQuery, authReady]);

  const updateLocal = (id, changes) => setJobs((current) => current.map((job) => job.id === id ? { ...job, ...changes } : job));

  // "展开内容"统一控件（收起/JD/AI/沟通 及其组合）
  const expandModeValue = ['jd', 'ai', 'chat'].every((k) => ({ jd: jdMode, ai: aiMode, chat: chatMode }[k]))
    ? 'all'
    : (jdMode && aiMode && chatMode) ? 'all'
    : (jdMode && aiMode) ? 'jd_ai'
    : (jdMode && chatMode) ? 'jd_chat'
    : (aiMode && chatMode) ? 'ai_chat'
    : jdMode ? 'jd' : aiMode ? 'ai' : chatMode ? 'chat' : 'none';
  const handleExpandChange = (value) => {
    const wantJd = value === 'jd' || value === 'jd_ai' || value === 'jd_chat' || value === 'all';
    const wantAi = value === 'ai' || value === 'jd_ai' || value === 'ai_chat' || value === 'all';
    const wantChat = value === 'chat' || value === 'jd_chat' || value === 'ai_chat' || value === 'all';
    setJdMode(wantJd);
    setAiMode(wantAi);
    setChatMode(wantChat);
    if (wantJd !== jdModeRef.current) loadData({ quiet: true }); // JD 需要重拉带 JD 的列表
  };

  // 合并后的评分状态下拉：把 AI 评价/人工评分两个筛选映射到同一控件
  const scoreStateValue = evaluationFilter !== 'all' ? evaluationFilter : ratingFilter !== 'all' ? ratingFilter : 'all';
  const handleScoreStateChange = (value) => {
    setEvaluationFilter(value === 'evaluated' || value === 'unevaluated' ? value : 'all');
    setRatingFilter(value === 'rated' || value === 'unrated' ? value : 'all');
  };

  // 重置全部筛选（保留已加载的岗位窗口，直接按默认重新拉取）
  const resetFilters = () => {
    setFunnelStatus('all');
    setSourceFilter('all');
    setEvaluationFilter('all');
    setRatingFilter('all');
    setMinScore(null);
    setMaxScore(null);
    setSearchQuery('');
    setSort('score_desc');
  };

  // 键盘快捷键（参考 Gmail / Google / 知乎的通用设计）：
  //   j/k  下一个/上一个岗位卡片    Enter  展开/收起岗位描述
  //   o    打开岗位原链接（新标签）   /      聚焦搜索框
  //   Esc  取消高亮（优先关闭帮助）   ?      快捷键帮助
  useEffect(() => {
    const onKey = (event) => {
      // 输入/组合键场景一律不拦截（搜索框、备注、IME 中文输入等）
      if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
      const tag = event.target?.tagName;
      const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || event.target?.isContentEditable;
      const key = event.key.toLowerCase();

      if (!typing && key === '?') { setShowHelp((v) => !v); return; }
      if (!typing && key === 'escape') {
        if (showHelp) { setShowHelp(false); return; }
        setActiveCardIdx(-1);
        return;
      }
      if (!typing && key === '/') {
        event.preventDefault();
        const input = [...document.querySelectorAll('.search-input')].find((el) => el.offsetParent !== null);
        if (input) { input.focus(); input.select(); }
        return;
      }
      if (typing) return;

      const activeCard = () => document.querySelector('.job-card.active');
      if (key === 'o') {
        const link = activeCard()?.querySelector('a.job-title');
        if (link) window.open(link.href, '_blank', 'noopener');
        return;
      }
      if (key === 'enter' && document.activeElement === document.body) {
        const jdTab = activeCard()?.querySelector('[data-jd-toggle]');
        if (jdTab) jdTab.click();
        return;
      }
      if (key !== 'j' && key !== 'k') return;

      const cards = Array.from(document.querySelectorAll('.job-card'));
      if (!cards.length) return;
      event.preventDefault();
      const delta = key === 'j' ? 1 : -1;
      const current = activeCardIdx >= 0 && activeCardIdx < cards.length ? activeCardIdx : -1;
      const next = current === -1
        ? (delta > 0 ? 0 : cards.length - 1)
        : Math.min(Math.max(current + delta, 0), cards.length - 1);
      setActiveCardIdx(next);
      // 滚动到目标卡片（居中）；滚到底时列表哨兵会自然触发加载更多
      cards[next].scrollIntoView({ behavior: 'smooth', block: 'center' });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [activeCardIdx, showHelp]);

  // 列表内容变化（筛选/刷新/追加）后清除高亮，避免指向错位卡片
  const firstJobId = jobs[0]?.id;
  useEffect(() => { setActiveCardIdx(-1); }, [jobs.length, firstJobId]);

  if (authStatus === 'unknown') {
    return <div className="login-screen"><p className="login-hint">正在连接服务…</p></div>;
  }
  if (authStatus === 'on' && !token) {
    return <LoginScreen onLogin={handleLogin} />;
  }

  return (
    <>
      {sidebarOpen && <div className="sidebar-backdrop" onClick={() => setSidebarOpen(false)} />}
      <aside className={`sidebar ${sidebarOpen ? 'open' : ''}`}>
        <div className="sidebar-header"><span>岗位筛选台</span><button className="mobile-close-btn" onClick={() => setSidebarOpen(false)}><Icons.Close /></button></div>
        <nav className="sidebar-nav">
          <FunnelSidebar stages={FUNNEL_STAGES} labels={FUNNEL_LABELS} active={funnelStatus} stats={stats} onSelect={(status) => { setFunnelStatus(status); setSidebarOpen(false); }} />
          <div className="sidebar-filters-mobile">
            <div className="nav-group-title">岗位过滤</div>
            <div className="mobile-filter-fields">
              <div className="search-container">
                <Icons.Search />
                <input value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="搜索职位、公司、JD 或岗位 ID…" className="search-input" />
                {searchQuery && <button type="button" className="mobile-filter-clear" aria-label="清空搜索" onClick={() => setSearchQuery('')}><Icons.Close /></button>}
              </div>
              <label className="mobile-filter-field">
                <select value={scoreStateValue} onChange={(event) => handleScoreStateChange(event.target.value)}>
                  {SCORE_STATE_ORDER.map((status) => <option value={status} key={status}>{SCORE_STATE_LABELS[status]}</option>)}
                </select>
                <ScoreRangeControl minScore={minScore} maxScore={maxScore} onMinChange={setMinScore} onMaxChange={setMaxScore} />
              </label>
              <label className="mobile-filter-field">
                <select value={sort} onChange={(event) => setSort(event.target.value)}>
                  {SORT_OPTIONS.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}
                </select>
              </label>
              <div className="mobile-filter-field">
                <select value={sourceFilter} onChange={(event) => setSourceFilter(event.target.value)}>
                  {SOURCE_OPTIONS.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}
                </select>
              </div>
              <div className="mobile-filter-field">
                <select value={expandModeValue} onChange={(event) => handleExpandChange(event.target.value)}>
                  {EXPAND_OPTIONS.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}
                </select>
              </div>
              <div className="mobile-filter-actions">
                <button type="button" className="filter-btn-mobile" onClick={resetFilters}>重置筛选</button>
                <button type="button" className="mobile-filter-done" onClick={() => setSidebarOpen(false)}>完成筛选</button>
              </div>
            </div>
          </div>
        </nav>
        <div className="sidebar-footer">
          <button type="button" className="sidebar-settings" onClick={() => { setShowSettings(true); setSidebarOpen(false); }}>
            设置
          </button>
        </div>
      </aside>

      <main className="main-content">
        <header className="header">
          <div className="mobile-header"><button className="menu-toggle" onClick={() => setSidebarOpen(true)}><Icons.Menu /></button><span>岗位筛选台</span></div>
          <div className="header-controls">
            <div className="filters-section">
              <div className="filters-row">
                <div className="search-container">
                  <Icons.Search />
                  <input value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="搜索" className="search-input" />
                  {searchQuery && <button type="button" className="mobile-filter-clear" aria-label="清空搜索" onClick={() => setSearchQuery('')}><Icons.Close /></button>}
                </div>
                <div className="score-group">
                  <select className="toolbar-select" value={scoreStateValue} onChange={(event) => handleScoreStateChange(event.target.value)}>{SCORE_STATE_ORDER.map((status) => <option value={status} key={status}>{SCORE_STATE_LABELS[status]}</option>)}</select>
                  <ScoreRangeControl compact minScore={minScore} maxScore={maxScore} onMinChange={setMinScore} onMaxChange={setMaxScore} />
                </div>
                <select className="toolbar-select sort-select" value={sort} onChange={(event) => setSort(event.target.value)}>{SORT_OPTIONS.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select>
                <select className="toolbar-select source-select" value={sourceFilter} onChange={(event) => setSourceFilter(event.target.value)}>{SOURCE_OPTIONS.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select>
                <select className="toolbar-select expand-select" value={expandModeValue} onChange={(event) => handleExpandChange(event.target.value)}>{EXPAND_OPTIONS.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select>
                <button className="refresh-btn" onClick={resetFilters}>重置筛选</button>
              </div>
            </div>
          </div>
        </header>

        {loading ? <p>正在连接本地岗位数据库…</p> : <>
          {loadError && <div className="load-error-banner">{loadError}</div>}
          <section className="job-list">
          {jobs.length === 0 ? <div className="empty-list">暂无岗位。浏览器检索保存后会自动出现在这里。</div> : jobs.map((job, index) => <JobItem key={job.id} job={job} active={index === activeCardIdx} jdMode={jdMode} aiMode={aiMode} chatMode={chatMode} onUpdate={updateLocal} evaluationSchedule={evaluationSchedule} hasResume={resumeJobs.has(job.id)} onOpenResume={openResume} />)}
          {jobs.length < totalRows && <div className="load-more-sentinel" ref={loadMoreRef}>{appending ? '加载中…' : ''}</div>}
        </section>
        </>}
      </main>

      {showSettings && <SettingsModal
        onClose={() => setShowSettings(false)}
        onLogout={handleLogout}
        canLogout={Boolean(token)}
      />}

      {showHelp && (
        <div className="shortcut-help" onClick={() => setShowHelp(false)}>
          <div className="shortcut-help-card" onClick={(event) => event.stopPropagation()}>
            <div className="shortcut-help-title">键盘快捷键</div>
            <div className="shortcut-help-rows">
              {[
                ['J / K', '下一个 / 上一个岗位卡片'],
                ['Enter', '展开 / 收起岗位描述'],
                ['O', '打开岗位原链接（新标签）'],
                ['/', '聚焦搜索框'],
                ['Esc', '取消高亮 / 关闭帮助'],
                ['?', '显示 / 隐藏本帮助'],
              ].map(([kbd, desc]) => (
                <div className="shortcut-help-row" key={kbd}><kbd>{kbd}</kbd><span>{desc}</span></div>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
