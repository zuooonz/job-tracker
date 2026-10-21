const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '';
export const STATIC_DEMO = import.meta.env.VITE_STATIC_DEMO === '1';
const TOKEN_KEY = 'tracker_token';
export const getToken = () => localStorage.getItem(TOKEN_KEY);
export const saveToken = (token) => { if (token) localStorage.setItem(TOKEN_KEY, token); else localStorage.removeItem(TOKEN_KEY); };
export class UnauthorizedError extends Error {}
const wait = milliseconds => new Promise(resolve => window.setTimeout(resolve, milliseconds));
export async function apiFetch(path, options = {}, timeoutMs = 30000) {
  if (STATIC_DEMO) {
    const method = (options.method || 'GET').toUpperCase();
    if (method !== 'GET') return new Response(JSON.stringify({ detail: '这是只读演示站，修改不会保存' }), { status: 405, headers: { 'Content-Type': 'application/json' } });
    const parsed = new URL(path, window.location.origin);
    const route = parsed.pathname.replace(/^\/+|\/+$/g, '').replaceAll('/', '__');
    const response = await fetch(`${import.meta.env.BASE_URL}demo-data/${route}.json`, { cache: 'no-store' });
    if (!response.ok) return new Response(JSON.stringify({ detail: '演示数据暂不可用' }), { status: response.status, headers: { 'Content-Type': 'application/json' } });
    if (parsed.pathname === '/api/jobs') {
      const rows = await response.json();
      const query = parsed.searchParams;
      let filtered = rows.filter((job) => {
        const score = Number(job.relevance_score ?? -1);
        const status = job.funnel_status || job.application_status || 'todo';
        const evaluation = job.relevance_score == null ? 'unevaluated' : 'evaluated';
        const rating = job.user_score == null ? 'unrated' : 'rated';
        const haystack = [job.title, job.company, job.jd, job.location, job.id].join(' ').toLowerCase();
        const needle = (query.get('q') || '').toLowerCase();
        return (!query.get('source') || query.get('source') === 'all' || job.source === query.get('source'))
          && (!query.get('funnel_status') || query.get('funnel_status') === 'all' || status === query.get('funnel_status'))
          && (!query.get('evaluation_status') || query.get('evaluation_status') === 'all' || evaluation === query.get('evaluation_status'))
          && (!query.get('rating_status') || query.get('rating_status') === 'all' || rating === query.get('rating_status'))
          && (score < 0 || (score >= Number(query.get('min_score') || 0) && score <= Number(query.get('max_score') || 100)))
          && (!needle || haystack.includes(needle));
      });
      const sort = query.get('sort') || 'score_desc';
      const scoreField = sort.startsWith('manual_score') ? 'user_score' : 'relevance_score';
      if (sort.includes('score')) filtered.sort((a, b) => ((Number(a[scoreField]) || 0) - (Number(b[scoreField]) || 0)) * (sort.endsWith('_asc') ? 1 : -1));
      if (sort === 'updated_desc' || sort === 'updated_asc') filtered.sort((a, b) => (a.updated_at || '').localeCompare(b.updated_at || '') * (sort === 'updated_asc' ? 1 : -1));
      const total = filtered.length;
      const offset = Number(query.get('offset') || 0), limit = Number(query.get('limit') || total);
      return new Response(JSON.stringify(filtered.slice(offset, offset + limit)), { headers: { 'Content-Type': 'application/json', 'X-Total-Count': String(total) } });
    }
    return response;
  }
  const headers = { ...(options.headers || {}) };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetch(`${API_BASE_URL}${path}`, { ...options, headers, signal: controller.signal }); }
  finally { window.clearTimeout(timer); }
}
export async function fetchJson(path, attempts = 2) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await apiFetch(path, { cache: 'no-store' });
      if (response.status === 401) throw new UnauthorizedError(`${path} returned 401`);
      if (!response.ok) throw new Error(`${path} returned ${response.status}`);
      return { data: await response.json(), response };
    } catch (error) {
      if (error instanceof UnauthorizedError) throw error;
      lastError = error;
      if (attempt + 1 < attempts) await wait(350 * (attempt + 1));
    }
  }
  throw lastError;
}
export { API_BASE_URL };
