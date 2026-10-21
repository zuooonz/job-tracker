class TrackerApi {
  constructor(baseUrl, token = '') {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.token = token || process.env.TRACKER_API_TOKEN || '';
  }

  async request(path, options = {}) {
    const headers = { 'content-type': 'application/json', ...(options.headers || {}) };
    if (this.token) headers['Authorization'] = `Bearer ${this.token}`;
    const timeoutMs = Number(process.env.TRACKER_API_TIMEOUT_MS || 30000);
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers,
      signal: options.signal || AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    const body = text ? JSON.parse(text) : null;
    if (response.status === 401) {
      throw new Error(`401 ${path}: 服务器需要 TRACKER_API_TOKEN（或在 cli.js 传 --token）`);
    }
    if (!response.ok) throw new Error(`${response.status} ${path}: ${JSON.stringify(body)}`);
    return body;
  }

  createSearchRun(source, keyword, searchDirection, filters, notes = '') {
    return this.request('/api/search-runs', {
      method: 'POST', body: JSON.stringify({ source, keyword, search_direction: searchDirection, filters, notes })
    });
  }

  finishSearchRun(id, status, notes) {
    return this.request(`/api/search-runs/${id}`, {
      method: 'PATCH', body: JSON.stringify({ status, notes })
    });
  }

  ingestJob(payload) {
    return this.request('/api/jobs', { method: 'POST', body: JSON.stringify(payload) });
  }

  listScreeningRejections(source) {
    return this.request(`/api/screening-rejections?${new URLSearchParams({ source }).toString()}`);
  }

  recordScreeningRejection(payload) {
    return this.request('/api/screening-rejections', { method: 'POST', body: JSON.stringify(payload) });
  }

  listJobs(params = {}) {
    const query = new URLSearchParams(params).toString();
    return this.request(`/api/jobs${query ? `?${query}` : ''}`);
  }

  getJob(id) {
    return this.request(`/api/jobs/${id}`);
  }

  importChat(jobId, payload) {
    return this.request(`/api/jobs/${jobId}/chat`, {
      method: 'POST', body: JSON.stringify(payload)
    });
  }

  touchChatSync(jobId, payload = {}) {
    return this.request(`/api/jobs/${jobId}/chat-sync-touch`, {
      method: 'POST', body: JSON.stringify(payload)
    });
  }

  appendChat(jobId, payload) {
    return this.request(`/api/jobs/${jobId}/chat-append`, {
      method: 'POST', body: JSON.stringify(payload)
    });
  }

  createEvaluation(id, payload) {
    return this.request(`/api/jobs/${id}/evaluations`, {
      method: 'POST', body: JSON.stringify(payload)
    });
  }

  getEvaluationSchedule() {
    return this.request('/api/evaluation-schedule');
  }

  claimEvaluation(allowOffpeak, workerId = 'local-deepseek-worker') {
    return this.request('/api/evaluation-queue/claim', {
      method: 'POST', body: JSON.stringify({ allow_offpeak: allowOffpeak, worker_id: workerId })
    });
  }

  finishEvaluationQueue(id, payload) {
    return this.request(`/api/evaluation-queue/${id}`, {
      method: 'PATCH', body: JSON.stringify(payload)
    });
  }

  automationBudget() { return this.request('/api/automation/budget'); }
  assertAutomationAvailable(platform) {
    return this.request('/api/automation/budget', { method: 'POST', body: JSON.stringify({ action: 'check', platform }) });
  }
  reserveAutomationBudget(platform, kind) {
    return this.request('/api/automation/budget', { method: 'POST', body: JSON.stringify({ action: 'reserve', platform, kind }) });
  }
  reportAutomationRun(platform, kind, status, counts = {}, message = '') {
    return this.request('/api/automation/budget', { method: 'POST', body: JSON.stringify({ action: 'run', platform, kind, status, counts, message }) });
  }
}

module.exports = { TrackerApi };
