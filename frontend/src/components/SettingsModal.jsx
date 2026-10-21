import { useEffect, useState } from 'react';
import { apiFetch } from '../api.js';

const configListFields = {
  strategy: ['hardTitleBlacklist', 'hardIrrelevantTitleTerms', 'hardIrrelevantDetailTerms', 'hardExperienceTerms', 'positiveTitleTerms', 'domainTerms', 'taskTerms', 'downrankTitleTerms', 'preferredLocations'],
  profile: ['education', 'verified_evidence', 'target_directions', 'preferred_locations', 'evidence_boundaries']
};

function ConfigSettingsSection({ type, title, endpoint, note = '' }) {
  const [value, setValue] = useState(null); const [loaded, setLoaded] = useState(null);
  const [pathKind, setPathKind] = useState('example'); const [error, setError] = useState('');
  const [message, setMessage] = useState(''); const [busy, setBusy] = useState(false);
  const [resumeText, setResumeText] = useState(''); const [draftBusy, setDraftBusy] = useState(false);
  const dirty = loaded && JSON.stringify(value) !== JSON.stringify(loaded);
  useEffect(() => { let active = true; apiFetch(`/api/settings/${endpoint}`).then(async r => { const d = await r.json(); if (!r.ok) throw new Error(d.detail || '读取设置失败'); if (active) { setValue(d.value); setLoaded(d.value); setPathKind(d.path_kind); } }).catch(e => active && setError(e.message)); return () => { active = false; }; }, [endpoint]);
  const update = (fn) => setValue(current => { const next = structuredClone(current); fn(next); return next; });
  const lines = (key, label, field = key) => <label key={key}>{label}<textarea rows="3" value={(value?.[field] || []).join('\n')} onChange={e => update(v => { v[field] = e.target.value.split('\n').map(x => x.trim()).filter(Boolean); })} /><small>每行一项</small></label>;
  const number = (label, field, min = 0, max = 100) => <label key={field}>{label}<input type="number" min={min} max={max} value={value?.[field] ?? ''} onChange={e => update(v => { v[field] = Number(e.target.value); })} /></label>;
  const nestedNumber = (label, group, field, min = 0, max = 100) => <label key={`${group}.${field}`}>{label}<input type="number" min={min} max={max} value={value?.[group]?.[field] ?? ''} onChange={e => update(v => { v[group][field] = Number(e.target.value); })} /></label>;
  const save = async () => { setBusy(true); setError(''); setMessage(''); try { const r = await apiFetch(`/api/settings/${endpoint}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) }); const d = await r.json(); if (!r.ok) throw new Error(d.detail || '保存失败'); setValue(d.value); setLoaded(d.value); setPathKind(d.path_kind); setMessage('已保存'); } catch (e) { setError(e.message); } finally { setBusy(false); } };
  const cancel = () => { setValue(loaded); setError(''); setMessage(''); };
  return <details className="settings-section config-settings-section"><summary><div><h3>{title}</h3><p className="settings-description">保存到本机私有配置 · {pathKind === 'private' ? '私有配置' : '公开示例'}</p></div></summary>
    {note && <p className="settings-description">{note}</p>}
    {!value && !error && <p className="settings-description">正在读取…</p>}
    {value && type === 'strategy' && <div className="config-settings-grid">{number('月薪上限低于此值（K）则排除', 'minimumMonthlySalaryMaxK', 0, 1000)}{configListFields.strategy.map(k => lines(k, ({hardTitleBlacklist:'标题黑名单',hardIrrelevantTitleTerms:'标题无关词',hardIrrelevantDetailTerms:'详情无关词',hardExperienceTerms:'经验排除词',positiveTitleTerms:'正向词',domainTerms:'领域词',taskTerms:'任务词',downrankTitleTerms:'降权标题词',preferredLocations:'偏好地点'})[k]))}<label>降权惩罚<input type="number" min="0" max="100" value={value.downrankPenalty || 0} onChange={e => update(v => { v.downrankPenalty = Number(e.target.value); })}/></label><label>详情最小间隔（毫秒）<input type="number" value={value.detailPacingMs.min} onChange={e => update(v => { v.detailPacingMs.min = Number(e.target.value); })}/></label><label>详情最大间隔（毫秒）<input type="number" value={value.detailPacingMs.max} onChange={e => update(v => { v.detailPacingMs.max = Number(e.target.value); })}/></label></div>}
    {value && type === 'profile' && <><div className="config-settings-grid"><label>职业定位<textarea rows="4" value={value.positioning || ''} onChange={e => update(v => { v.positioning = e.target.value; })}/></label>{configListFields.profile.map(k => lines(k, ({education:'教育经历',verified_evidence:'已核实证据',target_directions:'目标方向',preferred_locations:'偏好地点',evidence_boundaries:'证据边界'})[k]))}</div><div className="settings-section"><h4>从简历文本生成草稿</h4><p className="settings-description">文本脱敏后会发送到已配置的模型服务商生成候选人画像草稿。生成内容只填入下方可编辑字段，不会自动保存。</p><label>粘贴简历文本<textarea rows="7" maxLength="50000" value={resumeText} onChange={e => setResumeText(e.target.value)} placeholder="粘贴简历文本"/></label><button type="button" className="search-plan-secondary" disabled={!resumeText.trim() || draftBusy} onClick={async () => { setDraftBusy(true); setError(''); setMessage(''); try { const r = await apiFetch('/api/settings/candidate-profile/draft', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ resume_text: resumeText }) }); const d = await r.json(); if (!r.ok) throw new Error(d.detail || '生成草稿失败'); update(v => Object.assign(v, d.draft)); setMessage(d.notice || '草稿已填入，请检查并点击保存'); } catch (e) { setError(e.message); } finally { setDraftBusy(false); } }}>{draftBusy ? '生成中…' : '生成草稿并填入字段'}</button></div></>}
    {value && type === 'evaluation' && <><div className="config-settings-grid">{Object.keys(value.thresholds).map(k => { const labels = { priority: '重点推荐分数', normal: '常规推荐分数', opportunity: '机会岗位分数', minimum_confidence_for_priority: '重点推荐最低置信度', incomplete_jd_confidence_cap: 'JD 不完整时置信度上限', critical_gap_score_cap: '有关键差距时分数上限' }; const help = { priority: '达到此分数可列为重点推荐。', normal: '达到此分数可列为常规推荐。', opportunity: '低于常规线但达到此分数时作为机会观察。', minimum_confidence_for_priority: '置信度低于此值时不进入重点推荐。', incomplete_jd_confidence_cap: '岗位描述不完整时限制模型置信度。', critical_gap_score_cap: '存在关键能力差距时限制最终分数。' }; return <label key={k}>{labels[k] || k}<input type="number" min="0" max="100" value={value.thresholds[k]} onChange={e => update(v => { v.thresholds[k] = Number(e.target.value); })}/><small>{help[k]}</small></label>; })}{Object.entries(value.dimensions).map(([k, d]) => nestedNumber(`权重 · ${d.label}`, 'dimensions', k, 0, 100))}<label>模型名称<input value={value.api.model || ''} onChange={e => update(v => { v.api.model = e.target.value; })}/></label>{nestedNumber('最大 token 数', 'api', 'max_tokens', 1, 100000)}</div>{(() => { const total = Object.values(value.dimensions).reduce((sum, item) => sum + (Number(item.weight) || 0), 0); return <p className={total === 100 ? 'settings-description' : 'search-plan-error'}>维度权重合计：{total}%{total === 100 ? '（正常）' : '，必须等于 100%'}</p>; })()}</>}
    {error && <p className="search-plan-error" role="alert">{error}</p>}{message && <p className="search-plan-success" role="status">{message}</p>}
    <div className="search-plan-actions"><span>{dirty ? '有未保存的修改' : '已同步'}</span><button className="search-plan-secondary" onClick={cancel} disabled={!dirty || busy}>取消</button><button className="settings-logout-btn search-plan-save" onClick={save} disabled={!dirty || busy}>{busy ? '保存中…' : '保存'}</button></div>
  </details>;
}

function AutomationPolicySection() {
  const [value, setValue] = useState(null); const [loaded, setLoaded] = useState(null); const [error, setError] = useState(''); const [message, setMessage] = useState('');
  useEffect(() => { apiFetch('/api/settings/automation-policy').then(r => r.json()).then(d => { setValue(d.value); setLoaded(d.value); }).catch(e => setError(e.message)); }, []);
  const update = (platform, key, number) => setValue(v => ({ ...v, daily_caps: { ...v.daily_caps, [platform]: { ...v.daily_caps[platform], [key]: Number(number) } } }));
  const save = async () => { const r = await apiFetch('/api/settings/automation-policy', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) }); const d = await r.json(); if (!r.ok) { setError(d.detail || '保存失败'); return; } setValue(d.value); setLoaded(d.value); setMessage('已保存'); };
  return <details className="settings-section config-settings-section"><summary><div><h3>自动化访问预算</h3><p className="settings-description">按平台设置每日详情页与会话打开上限</p></div></summary>{error && <p className="search-plan-error">{error}</p>}{value && <><div className="config-settings-grid">{['boss', 'liepin'].flatMap(p => ['detail_opens', 'chat_opens'].map(k => <label key={p+k}>{p === 'boss' ? 'BOSS' : '猎聘'} · {k === 'detail_opens' ? '详情页每日上限' : '会话每日上限'}<input type="number" min="0" value={value.daily_caps[p][k]} onChange={e => update(p, k, e.target.value)}/></label>))}<label>拦截后冷却分钟<input type="number" min="1" max="1440" value={value.cooldown_minutes} onChange={e => setValue(v => ({ ...v, cooldown_minutes: Number(e.target.value) }))}/></label></div><div className="search-plan-actions"><span>{message || (JSON.stringify(value) === JSON.stringify(loaded) ? '已同步' : '有未保存的修改')}</span><button className="settings-logout-btn" disabled={JSON.stringify(value) === JSON.stringify(loaded)} onClick={save}>保存预算</button></div></>}</details>;
}

function ScoreBandStatsSection() {
  const [bands, setBands] = useState([]); const [error, setError] = useState('');
  useEffect(() => { apiFetch('/api/stats/score-bands').then(async r => { const d = await r.json(); if (!r.ok) throw new Error(d.detail || '读取统计失败'); setBands(d.bands || []); }).catch(e => setError(e.message)); }, []);
  const pct = n => `${Math.round((n || 0) * 100)}%`;
  return <details className="settings-section config-settings-section"><summary><div><h3>评分区间统计</h3><p className="settings-description">岗位沟通、回复与流程阶段分布</p></div></summary>{error && <p className="search-plan-error">{error}</p>}<div className="table-scroll"><table><thead><tr><th>分数</th><th>岗位</th><th>已沟通</th><th>已回复</th><th>面试</th><th>Offer</th></tr></thead><tbody>{bands.map(b => <tr key={b.band}><td>{b.band}</td><td>{b.jobs}</td><td>{b.contacted}（{pct(b.contacted_rate)}）</td><td>{b.replied}（{pct(b.replied_rate)}）</td><td>{b.interview}（{pct(b.interview_rate)}）</td><td>{b.offer}（{pct(b.offer_rate)}）</td></tr>)}</tbody></table></div></details>;
}

function TaskPanelSection() {
  const [data, setData] = useState({ tasks: [], last_runs: {} }); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const refresh = () => apiFetch('/api/tasks').then(async r => { const d = await r.json(); if (!r.ok) throw new Error(d.detail || '读取任务失败'); setData(d); }).catch(e => setError(e.message));
  useEffect(() => { refresh(); const timer = setInterval(refresh, 3000); return () => clearInterval(timer); }, []);
  const start = async name => { setBusy(true); setError(''); try { const r = await apiFetch(`/api/tasks/${name}`, { method: 'POST' }); const d = await r.json(); if (!r.ok) throw new Error(d.detail || '启动任务失败'); setData(d); } catch(e) { setError(e.message); } finally { setBusy(false); } };
  const stop = async id => { const r = await apiFetch(`/api/tasks/${id}/stop`, { method: 'POST' }); const d = await r.json(); if (!r.ok) { setError(d.detail || '停止失败'); return; } setData(d); };
  return <details className="settings-section config-settings-section"><summary><div><h3>任务</h3><p className="settings-description">查看自动化运行状态，启动固定任务</p></div></summary>{error && <p className="search-plan-error">{error}</p>}<div className="search-plan-actions"><button className="search-plan-secondary" disabled={busy || !!data.running} onClick={() => start('chat-pipeline')}>启动沟通同步</button><button className="search-plan-secondary" disabled={busy || !!data.running} onClick={() => start('collect-plan-dry-run')}>采集计划预览</button>{data.running?.panel_managed && <button className="settings-logout-btn" onClick={() => stop(data.running.id)}>停止 {data.running.name}</button>}{data.running && !data.running.panel_managed && <span className="settings-description">浏览器任务运行中：{data.running.name}</span>}</div><ul>{(data.tasks || []).slice(-8).reverse().map(t => <li key={t.id}>{t.name} · {t.status} · {t.started_at} · {t.log_file}</li>)}</ul><p className="settings-description">最近报告：{Object.entries(data.last_runs || {}).slice(-6).map(([k,v]) => `${k} ${v.status} ${v.at}`).join(' · ') || '暂无'}</p></details>;
}

function EnvironmentSection() {
  const [data, setData] = useState(null); const [error, setError] = useState('');
  useEffect(() => { apiFetch('/api/settings/environment').then(async r => { const d = await r.json(); if (!r.ok) throw new Error(d.detail || '读取环境状态失败'); setData(d); }).catch(e => setError(e.message)); }, []);
  const [dismissed, setDismissed] = useState(() => localStorage.getItem('first-run-checklist-dismissed') === '1');
  return <details className="settings-section config-settings-section"><summary><div><h3>运行环境</h3><p className="settings-description">登录、自动化预算和最近运行状态</p></div></summary>{error && <p className="search-plan-error">{error}</p>}{data && <><dl className="environment-grid">{[['模型 API 密钥已配置', data.llm_api_key_configured ? '是' : '否'], ['模型服务地址主机', data.llm_base_url_host], ['模型', data.model], ['前端鉴权', data.auth_enabled ? '启用' : '关闭'], ['浏览器模式', data.browser_mode], ['CDP 18800', data.cdp_18800_reachable ? '可访问' : '不可访问'], ['数据库文件', data.database_basename]].map(([k,v]) => <div key={k}><dt>{k}</dt><dd>{v || '—'}</dd></div>)}</dl><div className="environment-grid">{['boss','liepin'].map(platform => { const a = data.automation || {}; const used = a.usage?.[a.date]?.[platform] || {}; const caps = a.policy?.daily_caps?.[platform] || {}; const cooldown = a.cooldowns?.[platform]; const collect = a.runs?.[`${platform}:collect`]; const chat = a.runs?.[`${platform}:chat`]; const last = [collect, chat].filter(Boolean).sort((x,y) => y.at.localeCompare(x.at))[0]; return <div key={platform}><dt>{platform === 'boss' ? 'BOSS' : '猎聘'} 自动化</dt><dd>登录：{data.platform_login_state?.[platform] === 'blocked' ? `最近拦截 ${a.interceptions?.[platform]?.at || ''}，冷却至 ${cooldown || a.interceptions?.[platform]?.until || '已结束'}` : data.platform_login_state?.[platform] === 'logged_in' ? `最近成功 ${last?.at || ''}` : '尚无登录成功记录'}<br/>今日详情 {used.detail_opens || 0}/{caps.detail_opens ?? '—'} · 会话 {used.chat_opens || 0}/{caps.chat_opens ?? '—'}<br/>采集：{collect ? `${collect.at} · ${collect.status} · ${JSON.stringify(collect.counts || {})}` : '—'}；同步：{chat ? `${chat.at} · ${chat.status} · ${JSON.stringify(chat.counts || {})}` : '—'}</dd></div>; })}</div>{Object.values(data.env_overrides || {}).some(Boolean) && <p className="settings-description">环境变量覆盖评价设置：{Object.entries(data.env_overrides).filter(([,v]) => v).map(([k]) => ({model:'模型',thinking:'思考模式',max_tokens:'最大 token 数',base_url:'API 地址'}[k])).join('、')}。仅显示覆盖项，不显示环境变量值。</p>}
    {!dismissed && <div className="settings-section"><strong>首次使用检查</strong><ul>{[['.env 文件', data.first_run.env_exists], ['模型 API Key', data.first_run.api_key_configured], ['候选人画像已个性化', !data.first_run.candidate_profile_is_example], ['检索计划已个性化', !data.first_run.search_plan_is_example], ['浏览器可连接', data.first_run.browser_reachable], ['BOSS 已登录', data.first_run.platform_logged_in?.boss], ['猎聘已登录', data.first_run.platform_logged_in?.liepin]].map(([label, ok]) => <li key={label}>{ok ? '✓' : '○'} {label}</li>)}</ul>{data.candidate_profile_is_example && <p className="search-plan-error">候选人画像仍是公开示例。评价已停用；请在“候选人画像”中填写并保存后再运行。</p>}<button className="search-plan-secondary" onClick={() => { localStorage.setItem('first-run-checklist-dismissed', '1'); setDismissed(true); }}>收起检查清单</button></div>}
    <p className="settings-description">配置来源：{Object.entries(data.config_sources).map(([k,v]) => `${k}：${v === 'private' ? '私有' : '示例'}`).join(' · ')}</p><p className="settings-description">{data.secrets_hint}</p></>}</details>;
}

function SettingsModal({ onClose, onLogout, canLogout }) {
  const [loaded, setLoaded] = useState(null);
  const [pathKind, setPathKind] = useState('example');
  const [directions, setDirections] = useState([]);
  const [disabled, setDisabled] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const draft = { directions, disabled };
  const dirty = loaded && JSON.stringify(draft) !== JSON.stringify(loaded);
  useEffect(() => {
    let active = true;
    apiFetch('/api/search-plan', { cache: 'no-store' }).then(async (response) => {
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || '读取检索计划失败');
      if (!active) return;
      const value = { directions: data.plan.directions || [], disabled: data.plan.disabled_queries || [] };
      setPathKind(data.path_kind); setLoaded(value); setDirections(value.directions); setDisabled(value.disabled);
    }).catch((err) => { if (active) setError(err.message); });
    return () => { active = false; };
  }, []);
  const updateDirection = (index, update) => setDirections((items) => items.map((item, i) => i === index ? { ...item, ...update } : item));
  const save = async () => {
    setBusy(true); setError(''); setMessage('');
    try {
      const response = await apiFetch('/api/search-plan', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(draft) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || '保存检索计划失败');
      const value = { directions: data.plan.directions, disabled: data.plan.disabled_queries };
      setDirections(value.directions); setDisabled(value.disabled); setLoaded(value); setPathKind(data.path_kind); setMessage(['已保存，下一次采集时生效', ...(data.warnings || [])].join('；'));
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  const cancel = () => { if (loaded) { setDirections(loaded.directions); setDisabled(loaded.disabled); } setError(''); setMessage(''); };
  const keywords = (values) => values.join('\n');
  const parseKeywords = (value) => value.split('\n').map((word) => word.trim()).filter(Boolean);
  return (
    <div className="settings-modal-backdrop" onClick={onClose}>
      <section className="settings-modal" onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true" aria-label="设置">
        <div className="settings-modal-head">
          <div><strong>设置</strong><span>账号与本机配置</span></div>
          <button type="button" className="settings-close" onClick={onClose} aria-label="关闭设置">×</button>
        </div>
        {canLogout && <div className="settings-section settings-account-section">
          <div><h3>前端账号</h3><p className="settings-description">退出只清除当前设备保存的岗位筛选台令牌，不影响招聘平台登录。</p></div>
          <button type="button" className="settings-logout-btn" onClick={onLogout}>退出前端登录</button>
        </div>}
        <div className="settings-section search-plan-section">
          <div className="search-plan-heading"><div><h3>检索词</h3><p className="settings-description">修改后下次采集生效；保存到本机私有配置，不会进入 Git</p></div><span className={`search-plan-badge ${pathKind}`}>{pathKind === 'private' ? '私有配置' : '公开示例'}</span></div>
          {!loaded && !error && <p className="settings-description">正在读取…</p>}
          {directions.map((direction, index) => <details className="search-direction-card" key={`${direction.id}-${index}`} open={index === 0}>
            <summary><strong>{direction.label || '新检索方向'}</strong><span>{direction.id || '新方向'} · {direction.priority}</span></summary>
            <div className="search-plan-fields">
              <label>名称<input maxLength="40" value={direction.label} onChange={(event) => updateDirection(index, { label: event.target.value })} /></label>
              <label>方向 ID<input maxLength="42" readOnly={!direction.isNew} value={direction.id} placeholder="如 product_role" onChange={(event) => updateDirection(index, { id: event.target.value })} /></label>
              <label>优先级<select value={direction.priority} onChange={(event) => updateDirection(index, { priority: event.target.value })}>{['A', 'B', 'C'].map((p) => <option key={p}>{p}</option>)}</select></label>
              <label>方向说明<textarea maxLength="240" rows="2" value={direction.description || ''} onChange={(event) => updateDirection(index, { description: event.target.value })} /></label>
            </div>
            <div className="search-plan-platforms">{[['boss', 'BOSS'], ['liepin', '猎聘']].map(([platform, title]) => <div className="search-plan-platform" key={platform}><strong>{title}</strong>{['seed', 'variants'].map((kind) => <label key={kind}>{kind === 'seed' ? '种子词' : '扩展词'}<textarea rows="3" value={keywords(direction[platform]?.[kind] || [])} onChange={(event) => updateDirection(index, { [platform]: { ...direction[platform], [kind]: parseKeywords(event.target.value) } })} /><small>{(direction[platform]?.[kind] || []).length} 个词</small></label>)}</div>)}</div>
            <button type="button" className="search-plan-delete" onClick={() => { if (window.confirm(`确定删除方向“${direction.label}”吗？`)) setDirections((items) => items.filter((_, i) => i !== index)); }}>删除方向</button>
          </details>)}
          <button type="button" className="search-plan-secondary" onClick={() => setDirections((items) => [...items, { id: '', isNew: true, priority: 'B', label: '', boss: { seed: [], variants: [] }, liepin: { seed: [], variants: [] } }])}>＋ 添加方向</button>
          <details className="search-direction-card disabled-query-card"><summary><strong>停用词</strong><span>{disabled.length} 项</span></summary>
            {disabled.map((item, index) => <div className="disabled-query-row" key={index}><select aria-label="平台" value={item.platform} onChange={(event) => setDisabled((items) => items.map((row, i) => i === index ? { ...row, platform: event.target.value } : row))}><option value="boss">BOSS</option><option value="liepin">猎聘</option></select><input aria-label="停用关键词" placeholder="关键词" value={item.keyword} onChange={(event) => setDisabled((items) => items.map((row, i) => i === index ? { ...row, keyword: event.target.value } : row))} /><input aria-label="停用原因" placeholder="原因" value={item.reason} onChange={(event) => setDisabled((items) => items.map((row, i) => i === index ? { ...row, reason: event.target.value } : row))} /><button type="button" onClick={() => setDisabled((items) => items.filter((_, i) => i !== index))}>移除</button></div>)}
            <button type="button" className="search-plan-secondary" onClick={() => setDisabled((items) => [...items, { platform: 'boss', keyword: '', reason: '' }])}>＋ 添加停用词</button>
          </details>
          {error && <p className="search-plan-error" role="alert">{error}</p>}{message && <p className="search-plan-success" role="status">{message}</p>}
          <div className="search-plan-actions"><span>{dirty ? '有未保存的修改' : '已同步'}</span><button type="button" className="search-plan-secondary" onClick={cancel} disabled={!dirty || busy}>取消</button><button type="button" className="settings-logout-btn search-plan-save" onClick={save} disabled={!dirty || busy}>{busy ? '保存中…' : '保存检索词'}</button></div>
        </div>
        <ConfigSettingsSection type="strategy" title="筛选规则" endpoint="search-strategy" />
        <ConfigSettingsSection type="profile" title="候选人画像" endpoint="candidate-profile" note="不要填写姓名、电话、邮箱。" />
        <ConfigSettingsSection type="evaluation" title="评价设置" endpoint="evaluation-strategy" />
        <ScoreBandStatsSection />
        <AutomationPolicySection />
        <TaskPanelSection />
        <EnvironmentSection />
      </section>
    </div>
  );
}


export default SettingsModal;
