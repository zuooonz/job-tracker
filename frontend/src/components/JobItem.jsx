import React, { useState, useEffect, useRef, useCallback } from 'react';
import { API_BASE_URL, apiFetch } from '../api.js';
import { HeartIcon, Icons } from './icons.jsx';

const FUNNEL_LABELS = { all: '全部', todo: '待看', interested: '想投', contacted: '已沟通', interview: '面试', offer: 'Offer', closed: '结束', excluded: '排除' };
const DIMENSION_LABELS = { domain_task_alignment: '领域任务', evidence_transferability: '证据迁移', hard_requirements: '硬门槛', seniority_scope: '职级范围', career_value: '职业价值', practical_constraints: '现实约束' };
const jobDetailCache = new Map();
const chatDetailCache = new Map();
const mergeChatNotes = (summary, userNotes) => !summary ? (userNotes || '') : (userNotes ? `${summary}；${userNotes}` : summary);
const formatTime = value => {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

function HeartRating({ value, onChange }) {  const [hover, setHover] = useState(0);
  return (
    <div className="heart-rating" onMouseLeave={() => setHover(0)}>
      {[1, 2, 3, 4, 5].map((score) => (
        <button
          type="button"
          aria-label={`人工评分 ${score} 星`}
          key={score}
          className={`heart ${score <= (hover || value || 0) ? 'filled' : ''}`}
          onMouseEnter={() => setHover(score)}
          onClick={() => onChange(value === score ? null : score)}
        >
          <HeartIcon />
        </button>
      ))}
    </div>
  );
}

export default function JobItem({ job, jdMode, aiMode, chatMode, onUpdate, evaluationSchedule, active, hasResume, onOpenResume }) {
  const [showJD, setShowJD] = useState(jdMode);
  const [showAI, setShowAI] = useState(aiMode);
  const [showChat, setShowChat] = useState(chatMode);
  const [notes, setNotes] = useState(() => mergeChatNotes(job.chat_summary || '', job.user_notes || ''));
  const summaryRef = useRef(job.chat_summary || '');
  const notesRef = useRef(job.user_notes || '');
  const [saving, setSaving] = useState(false);
  const [queueBusy, setQueueBusy] = useState(false);
  const [detail, setDetail] = useState(() => jobDetailCache.get(job.id) || null);
  const [jdLoading, setJdLoading] = useState(false);
  const [jdError, setJdError] = useState('');
  const [chatDetail, setChatDetail] = useState(() => chatDetailCache.get(job.id) || null);
  const [chatLoading, setChatLoading] = useState(false);
  const [chatError, setChatError] = useState('');
  const [replyBusy, setReplyBusy] = useState(false);
  const [replyError, setReplyError] = useState('');
  const timer = useRef(null);

  useEffect(() => setShowJD(jdMode), [jdMode]);
  useEffect(() => setShowAI(aiMode), [aiMode]);
  useEffect(() => setShowChat(chatMode), [chatMode]);
  useEffect(() => {
    summaryRef.current = job.chat_summary || '';
    notesRef.current = job.user_notes || '';
    setNotes(mergeChatNotes(summaryRef.current, notesRef.current));
  }, [job.chat_summary, job.user_notes]);
  useEffect(() => () => timer.current && clearTimeout(timer.current), []);

  const loadJD = useCallback(async () => {
    if (jobDetailCache.has(job.id)) {
      setDetail(jobDetailCache.get(job.id));
      return;
    }
    setJdLoading(true);
    setJdError('');
    try {
      const response = await apiFetch(`${API_BASE_URL}/api/jobs/${job.id}`, { cache: 'no-store' });
      if (!response.ok) throw new Error(`加载失败：${response.status}`);
      const data = await response.json();
      jobDetailCache.set(job.id, data);
      setDetail(data);
    } catch {
      setJdError('加载失败，点击重试');
    } finally {
      setJdLoading(false);
    }
  }, [job.id]);

  // 沟通记录懒加载（展开沟通记录时按需拉取）
  const loadChat = useCallback(async () => {
    if (chatDetailCache.has(job.id)) {
      setChatDetail(chatDetailCache.get(job.id));
      return;
    }
    setChatLoading(true);
    setChatError('');
    try {
      const response = await apiFetch(`${API_BASE_URL}/api/jobs/${job.id}/chat`, { cache: 'no-store' });
      if (!response.ok) throw new Error(`加载失败：${response.status}`);
      const data = await response.json();
      chatDetailCache.set(job.id, data);
      setChatDetail(data);
    } catch {
      setChatError('加载失败，点击重试');
    } finally {
      setChatLoading(false);
    }
  }, [job.id]);

  // 展开且列表数据没有 JD 时，按需拉取详情（懒加载）
  useEffect(() => {
    if (showJD && !job.jd && !detail && !jdLoading) loadJD();
  }, [showJD, job.jd, detail, jdLoading, loadJD]);

  // 展开沟通记录且未拉取时按需加载
  useEffect(() => {
    if (showChat && !chatDetail && !chatLoading) loadChat();
  }, [showChat, chatDetail, chatLoading, loadChat]);

  // 任何用户编辑（评分/备注/投递等）都视为"查看过该岗位"：自动标记已查看
  const markViewed = () => {
    if (job.review_status !== 'unreviewed') return;
    apiFetch(`${API_BASE_URL}/api/jobs/${job.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ review_status: 'viewed' }),
    }).then(response => response.ok ? response.json() : null)
      .then(data => data && onUpdate(job.id, data))
      .catch(() => {});
  };

  const requestPatch = async (endpoint, changes, { jobPatch = true } = {}) => {
    setSaving(true);
    const payload = { ...changes };
    if (jobPatch && job.review_status === 'unreviewed' && !('review_status' in payload)) {
      payload.review_status = 'viewed';
    }
    onUpdate(job.id, payload);
    try {
      const response = await apiFetch(`${API_BASE_URL}${endpoint}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!response.ok) throw new Error(`保存失败：${response.status}`);
      onUpdate(job.id, await response.json());
      if (!jobPatch) markViewed(); // 投递等非岗位字段编辑也视为已查看
    } catch (error) {
      console.error(error);
    } finally {
      setSaving(false);
    }
  };

  const patchJob = (changes) => requestPatch(`/api/jobs/${job.id}`, changes);
  const patchApplication = (changes) => requestPatch(`/api/jobs/${job.id}/application`, changes, { jobPatch: false });

  const generateReply = async () => {
    setReplyBusy(true);
    setReplyError('');
    try {
      const response = await apiFetch(`/api/jobs/${job.id}/reply-draft/generate`, { method: 'POST' }, 100000);
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.detail || `生成失败：${response.status}`);
      const next = { ...(chatDetail || {}), reply_draft: payload };
      chatDetailCache.set(job.id, next);
      setChatDetail(next);
    } catch (error) {
      setReplyError(error.message || '生成失败，请稍后重试');
    } finally {
      setReplyBusy(false);
    }
  };

  const updateReplyText = (value) => {
    const draft = chatDetail?.reply_draft;
    if (!draft) return;
    const next = { ...chatDetail, reply_draft: { ...draft, edited_reply: value } };
    chatDetailCache.set(job.id, next);
    setChatDetail(next);
  };

  const saveReplyText = async () => {
    const draft = chatDetail?.reply_draft;
    if (!draft?.id) return;
    await apiFetch(`/api/reply-drafts/${draft.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ edited_reply: draft.edited_reply || draft.suggested_reply || '' }),
    }).catch(() => {});
  };

  const copyReply = async () => {
    const draft = chatDetail?.reply_draft;
    const text = (draft?.edited_reply || draft?.suggested_reply || '').trim();
    if (text) await navigator.clipboard.writeText(text);
  };
  // 备注 = 沟通总结 + 人工备注 分号合并编辑（单行："总结；备注"）：
  //   前缀（总结）未变 → 编辑备注区；后缀（备注）未变 → 编辑总结区（同步更新总结存储）；
  //   无备注时整段视为总结编辑。总结随定期抓取更新覆盖，人工备注不受影响。
  const handleNotesChange = (value) => {
    setNotes(value);
    const prevSummary = summaryRef.current;
    const prevNotes = notesRef.current;
    let newSummary = prevSummary;
    let newNotes = prevNotes;
    if (prevSummary) {
      if (value.startsWith(prevSummary)) {
        newNotes = value.slice(prevSummary.length).replace(/^；/, '');
      } else if (prevNotes && value.endsWith(prevNotes)) {
        newSummary = value.slice(0, value.length - prevNotes.length).replace(/；$/, '');
      } else if (!prevNotes) {
        newSummary = value;
        newNotes = '';
      } else {
        newNotes = value.startsWith(`${prevSummary}；`) ? value.slice(prevSummary.length + 1) : value;
      }
    } else {
      newSummary = '';
      newNotes = value;
    }
    summaryRef.current = newSummary;
    notesRef.current = newNotes;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const patch = {};
      if (newSummary !== prevSummary) patch.chat_summary = newSummary;
      if (newNotes !== prevNotes) patch.user_notes = newNotes;
      if (Object.keys(patch).length) patchJob(patch);
    }, 700);
  };

  const requestEvaluation = async (mode) => {
    if (mode === 'immediate' && evaluationSchedule?.is_peak
      && !window.confirm('当前是 DeepSeek 高峰计价时段，确定立即评价这个岗位吗？')) return;
    setQueueBusy(true);
    try {
      const response = await apiFetch(`${API_BASE_URL}/api/jobs/${job.id}/evaluation-queue`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode }),
      });
      if (!response.ok) throw new Error(`加入评价队列失败：${response.status}`);
      const queued = await response.json();
      onUpdate(job.id, {
        evaluation_queue_id: queued.id, evaluation_queue_mode: queued.mode,
        evaluation_queue_status: queued.status, evaluation_queue_requested_at: queued.requested_at,
        evaluation_queue_error: '',
      });
    } catch (error) {
      console.error(error);
    } finally {
      setQueueBusy(false);
    }
  };

  const manualStars = job.user_score ? job.user_score / 20 : null;
  const isAppliedContacted = job.application_status === 'applied' || job.application_status === 'contacted';
  const isInterview = job.application_status === 'interview';
  const isRejected = job.review_status === 'rejected';
  // 排除时记录原因（写入备注，用于优化检索方向/简历）；未写备注时弹窗询问（可选）
  const handleExclude = () => {
    if (isRejected) { patchJob({ review_status: 'viewed' }); return; }
    let reason = notes.trim();
    if (!reason) {
      const input = window.prompt('排除原因（可选，将写入备注，用于优化检索方向）');
      if (input === null) return; // 取消则本次不排除
      reason = input.trim();
    }
    if (reason && reason !== notes.trim()) setNotes(reason);
    patchJob({ review_status: 'rejected', user_notes: reason || job.user_notes || '' });
  };
  const evidence = job.match_evidence || [];
  const gaps = job.gaps || [];
  const keywords = job.search_keywords || [];
  const searchDirectionLabels = job.search_direction_labels || [];
  const qualificationFacts = [job.experience, job.education, job.headcount].filter(Boolean);
  const companyFacts = [job.company_industry, job.company_size, job.company_stage].filter(Boolean);
  const publisherLabels = { company_hr: '企业 HR', headhunter: '猎头', direct_manager: '业务负责人', unknown: '身份待确认' };

  return (
    <article className={`job-card${active ? ' active' : ''}`}>
      <div className="card-scroll-area">
        <div className="card-topline">
          <div>
            <div className="job-badges">
              <span className={`source-badge ${job.source}`}>{job.source === 'boss' ? 'BOSS' : '猎聘'}</span>
              {job.review_status === 'unreviewed' && <span className="unviewed-badge">未查看</span>}
              {job.funnel_status !== 'todo' && <span className="state-badge">{FUNNEL_LABELS[job.funnel_status] || '待看'}</span>}
              {/关闭|暂停|下线|下架|失效|不可访问/.test(job.listing_status || '') && <span className="state-badge closed-badge" title="岗位已不在招聘，保留用于沟通记录">{job.listing_status}</span>}
              {searchDirectionLabels.map((label) => <span className="direction-badge" key={label}>检索：{label}</span>)}
              {job.evaluation_direction_label && <span className="direction-badge evaluation-direction">AI：{job.evaluation_direction_label}</span>}
            </div>
            <a href={job.url} target="_blank" rel="noopener noreferrer" className="job-title">
              {job.title} - {job.company || '公司未显示'}
            </a>
            <div className="job-meta">
              <span className="meta-item"><Icons.Location /> {job.location || '地点待确认'}</span>
              <span className="meta-item"><Icons.Salary /> {job.salary || '薪资面议'}</span>
              <span className="meta-item"><Icons.Time /> {job.update_time || job.relative_update_time
                ? `岗位更新：${[job.update_time, job.relative_update_time].filter(Boolean).join(' · ')}`
                : `首次发现：${job.first_seen_at?.slice(0, 10) || '待确认'}`}</span>
            </div>
          </div>
          <div className="topline-actions">
            <div className="score-pill">
              <strong>{job.relevance_score ?? '—'}</strong><span>匹配分</span>
            </div>
            {hasResume && (
              <button type="button" className="resume-btn" title="查看定制简历 PDF" onClick={() => onOpenResume(job.id)}>
                <Icons.Pdf />
                <span>简历</span>
              </button>
            )}
          </div>
        </div>

        <div className="rich-job-info">
          {qualificationFacts.length > 0 && <div className="fact-row"><strong>要求</strong>{qualificationFacts.map((fact) => <span className="fact-chip" key={fact}>{fact}</span>)}</div>}
          {(job.recruiter_name || job.recruiter_title) && <div className="fact-row publisher-row">
            <strong>发布者</strong>
            <span>{[job.recruiter_name, job.recruiter_title].filter(Boolean).join(' · ')}</span>
            {job.recruiter_company && <span className="muted-fact">所属：{job.recruiter_company}</span>}
            <span className="muted-fact">{publisherLabels[job.publisher_type] || publisherLabels.unknown}</span>
            {job.recruiter_verified && <span className="verified-fact">已认证</span>}
            {job.recruiter_activity && <span className="muted-fact">{job.recruiter_activity}</span>}
            {job.recruiter_tags?.map((tag) => <span className="fact-chip subtle" key={tag}>{tag}</span>)}
          </div>}
          {companyFacts.length > 0 && <div className="fact-row"><strong>公司</strong>{companyFacts.map((fact) => <span className="fact-chip" key={fact}>{fact}</span>)}</div>}
          {job.work_address && <div className="fact-row"><strong>地址</strong><span>{job.work_address}</span></div>}
          {job.job_tags?.length > 0 && <div className="fact-row"><strong>标签</strong>{job.job_tags.map((tag) => <span className="fact-chip" key={tag}>{tag}</span>)}</div>}
          {job.benefits?.length > 0 && <div className="fact-row benefits-row"><strong>福利</strong>{job.benefits.map((benefit) => <span className="fact-chip subtle" key={benefit}>{benefit}</span>)}</div>}
          {(job.metadata?.department || job.metadata?.language_requirement || job.metadata?.industry_requirement) && <div className="fact-row"><strong>其他</strong><span>{[
            job.metadata?.department && `部门：${job.metadata.department}`,
            job.metadata?.language_requirement && `语言：${job.metadata.language_requirement}`,
            job.metadata?.industry_requirement && `行业：${job.metadata.industry_requirement}`,
          ].filter(Boolean).join('；')}</span></div>}
        </div>

        <div className="card-collapsibles">
          <button type="button" className={`collapsible-tab ${showAI ? 'active' : ''}`} onClick={() => { setShowAI(!showAI); markViewed(); }}>
            {showAI ? <Icons.ChevronDown /> : <Icons.ChevronRight />} AI 分析
          </button>
          <button type="button" data-jd-toggle className={`collapsible-tab ${showJD ? 'active' : ''}`} onClick={() => { setShowJD(!showJD); markViewed(); }}>
            {showJD ? <Icons.ChevronDown /> : <Icons.ChevronRight />} 岗位描述
          </button>
          <button type="button" className={`collapsible-tab ${showChat ? 'active' : ''}`} onClick={() => { setShowChat(!showChat); markViewed(); }}>
            {showChat ? <Icons.ChevronDown /> : <Icons.ChevronRight />} 沟通记录
            {job.chat_message_count > 0 && <span className="chat-count-badge">{job.chat_message_count}</span>}
          </button>
        </div>
        {showAI && <div className="callout">
          <div className="callout-body">
            <div><strong>岗位实质</strong>：{job.summary || '尚未完成评估'}</div>
            {evidence.length > 0 && <div className="analysis-block"><strong>匹配证据</strong>：{evidence.join('；')}</div>}
            {gaps.length > 0 && <div className="analysis-block risk"><strong>关键缺口</strong>：{gaps.join('；')}</div>}
            {job.risk_notes && <div className="analysis-block risk"><strong>风险备注</strong>：{job.risk_notes}</div>}
            {job.filter_reasons?.length > 0 && <div className="analysis-block risk"><strong>规则提示</strong>：{job.filter_reasons.join('；')}</div>}
              {job.dimension_scores && Object.keys(job.dimension_scores).length > 0 && <div className="fact-row">
                <strong>分维度</strong>{Object.entries(job.dimension_scores).map(([key, value]) => <span className="fact-chip" key={key}>{DIMENSION_LABELS[key] || key} {value}</span>)}
              </div>}
              <div className="eval-audit">
                {keywords.length > 0 && <span>关键词：{keywords.join('、')}</span>}
                {job.confidence_score != null && <span>置信度 {job.confidence_score}</span>}
                <span>评估 {job.evaluation_count || 0} 版 · 快照 {job.snapshot_count || 0} 版 · 发现 {job.discovery_count || 0} 次</span>
                {job.strategy_version && <span>策略 {job.strategy_version}</span>}
                {job.model_name && <span>模型 {job.model_name}</span>}
                {job.evaluation_queue_status === 'failed'
                  ? <button type="button" className="audit-retry" disabled={queueBusy} onClick={() => requestEvaluation('offpeak')}>评价失败 · 重试</button>
                  : job.evaluation_queue_status === 'queued' || job.evaluation_queue_status === 'running'
                    ? <span className="muted-fact">评分排队中…</span>
                    : job.evaluation_count === 0
                      ? <button type="button" className="audit-retry" disabled={queueBusy} onClick={() => requestEvaluation('immediate')}>立即评分</button>
                      : null}
              </div>
            </div>
          </div>}
        {showJD && <div className="jd-content">
          {job.jd || detail?.job?.jd || (jdLoading ? 'JD 加载中…' : jdError
            ? <button type="button" className="jd-retry" onClick={loadJD}>{jdError}</button>
            : '页面暂未获取到完整 JD。')}
        </div>}
        {showChat && <div className="chat-content">
          {chatLoading ? '沟通记录加载中…' : chatError
            ? <button type="button" className="jd-retry" onClick={loadChat}>{chatError}</button>
            : !chatDetail || chatDetail.messages?.length === 0
              ? <div className="chat-empty">暂无沟通记录（尚未抓取或未建立对话）。</div>
              : <div className="chat-list">
                  <div className="chat-meta">
                    <span className="chat-summary">{chatDetail.chat_summary || job.chat_summary || '—'}</span>
                    {chatDetail.chat_synced_at && <span className="muted-fact">抓取更新 {formatTime(chatDetail.chat_synced_at)}</span>}
                  </div>
                  {[...chatDetail.messages]
                    .sort((a, b) => String(a.sent_at || '').localeCompare(String(b.sent_at || '')))
                    .map((msg) => (
                    <div key={msg.id} className={`chat-msg ${msg.direction === 'out' ? 'out' : msg.direction === 'system' ? 'system' : 'in'}`}>
                      <div className="chat-msg-head">
                        <span className="chat-direction">{msg.direction === 'out' ? '我' : '对方'}</span>
                        <span className="muted-fact">{formatTime(msg.sent_at)}</span>
                        {msg.direction === 'out' && msg.read_status !== 'unknown' && (
                          <span className={`chat-read ${msg.read_status}`}>{msg.read_status === 'read' ? '已读' : '未读'}</span>
                        )}
                      </div>
                      <div className="chat-msg-body">{msg.content}</div>
                    </div>
                  ))}
                  <div className="reply-assistant">
                    <div className="reply-assistant-head">
                      <div><strong>辅助回复</strong><span>仅在点击后调用模型，不会自动发送</span></div>
                      <button
                        type="button"
                        className="reply-generate-btn"
                        disabled={replyBusy || !chatDetail.messages.some((message) => message.direction === 'in')}
                        onClick={generateReply}
                      >
                        {replyBusy ? '正在生成…' : chatDetail.reply_draft ? '重新生成' : '生成回复'}
                      </button>
                    </div>
                    {!chatDetail.messages.some((message) => message.direction === 'in') && (
                      <div className="reply-assistant-hint">尚无招聘方消息，不需要生成回复。</div>
                    )}
                    {replyError && <div className="reply-assistant-error">{replyError}</div>}
                    {chatDetail.reply_draft && <div className="reply-draft-panel">
                      <textarea
                        value={chatDetail.reply_draft.edited_reply || chatDetail.reply_draft.suggested_reply || ''}
                        onChange={(event) => updateReplyText(event.target.value)}
                        onBlur={saveReplyText}
                        aria-label={`岗位 ${job.id} 的辅助回复`}
                      />
                      {chatDetail.reply_draft.rationale && <div className="reply-rationale">建议依据：{chatDetail.reply_draft.rationale}</div>}
                      {chatDetail.reply_draft.risk_flags?.length > 0 && <div className="reply-risk">发送前确认：{chatDetail.reply_draft.risk_flags.join('；')}</div>}
                      <div className="reply-draft-actions">
                        <button type="button" onClick={copyReply}>复制回复</button>
                        <span>请在招聘平台中人工确认并发送</span>
                      </div>
                    </div>}
                  </div>
                </div>}
        </div>}

      <div className="feedback-actions">
        <HeartRating value={manualStars} onChange={(value) => patchJob({ user_score: value ? value * 20 : null })} />
        <div className="note-exclude-row">
          <div className="note-wrap">
            <input
              className="user-note-input"
              value={notes}
              onChange={(event) => handleNotesChange(event.target.value)}
              placeholder="沟通总结；备注（分号后为你的备注，总结随定期抓取更新）"
            />
          </div>
          <button
            type="button"
            className={`state-btn ${isAppliedContacted ? 'active' : ''}`}
            disabled={saving || isRejected}
            aria-label="已沟通"
            onClick={() => patchApplication({ status: isAppliedContacted ? 'not_started' : 'applied' })}
          >
            <Icons.Chat /><span className="btn-label">已沟通</span>
          </button>
          <button
            type="button"
            className={`state-btn ${isInterview ? 'active' : ''}`}
            disabled={saving || isRejected}
            aria-label="面试中"
            onClick={() => patchApplication({ status: isInterview ? 'not_started' : 'interview' })}
          >
            <Icons.Interview /><span className="btn-label">面试中</span>
          </button>
          <button
            type="button"
            className={`exclude-btn ${isRejected ? 'excluded' : ''}`}
            disabled={saving}
            aria-label={isRejected ? '恢复' : '排除'}
            onClick={handleExclude}
          >
            <Icons.Exclude /><span className="btn-label">{isRejected ? '恢复' : '排除'}</span>
          </button>
        </div>
      </div>
      </div>
    </article>
  );
}

