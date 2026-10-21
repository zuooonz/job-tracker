const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '';
const TOKEN_KEY = 'tracker_token';
export const getToken = () => localStorage.getItem(TOKEN_KEY);
export const saveToken = (token) => { if (token) localStorage.setItem(TOKEN_KEY, token); else localStorage.removeItem(TOKEN_KEY); };
export class UnauthorizedError extends Error {}
const wait = milliseconds => new Promise(resolve => window.setTimeout(resolve, milliseconds));
export async function apiFetch(path, options = {}, timeoutMs = 30000) {
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
