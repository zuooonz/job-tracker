import { useState } from 'react';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '';

/**
 * 登录页：提交密码换取令牌。
 * 仅在服务器启用鉴权（TRACKER_LOGIN_PASSWORD）后显示；
 * 未启用时后端 /api/auth/status 返回 200 且 auth_enabled=false，前端不进入登录态。
 */
export default function LoginScreen({ onLogin }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (event) => {
    event.preventDefault();
    if (busy || !password) return;
    setBusy(true);
    setError('');
    try {
      const response = await fetch(`${API_BASE_URL}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      if (response.status === 429) throw new Error('尝试次数过多，请稍后再试');
      if (!response.ok) throw new Error('密码不正确');
      const data = await response.json();
      onLogin(data.token);
    } catch (err) {
      setError(err.message || '登录失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-screen">
      <form className="login-card" onSubmit={submit}>
        <div className="login-logo">🍀</div>
        <h1>岗位筛选台</h1>
        <p className="login-hint">请输入访问密码</p>
        <input
          className="login-input"
          type="password"
          value={password}
          autoFocus
          placeholder="密码"
          onChange={(event) => setPassword(event.target.value)}
        />
        {error && <div className="login-error">{error}</div>}
        <button className="login-submit" type="submit" disabled={busy || !password}>
          {busy ? '登录中…' : '登录'}
        </button>
      </form>
    </div>
  );
}
