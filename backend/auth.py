"""Job Tracker 登录鉴权（标准库实现，无第三方依赖）。

- 单密码登录（TRACKER_LOGIN_PASSWORD），签发 HMAC 签名、带过期时间的令牌。
- 可选固定 API 令牌（TRACKER_API_TOKEN），供本机采集器 / 评价 worker 使用，
  相当于“应用密码”，无需走登录流程。
- 未配置 TRACKER_LOGIN_PASSWORD 时鉴权整体关闭（本地开发默认行为）。

环境变量：
    TRACKER_LOGIN_PASSWORD  登录密码；不设置则关闭鉴权
    TRACKER_AUTH_SECRET     令牌签名密钥；不设置则从密码派生（单用户场景够用）
    TRACKER_API_TOKEN       采集器/worker 固定令牌（可选）
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import threading
import time

TOKEN_TTL_SECONDS = 7 * 24 * 3600  # 令牌有效期 7 天

LOGIN_PASSWORD = os.environ.get("TRACKER_LOGIN_PASSWORD") or ""
AUTH_SECRET = os.environ.get("TRACKER_AUTH_SECRET") or ""
API_TOKEN = os.environ.get("TRACKER_API_TOKEN") or ""

# 未显式配置密钥时，从密码派生稳定密钥，保证功能可用（单用户场景）。
_SECRET_SALT = b"job-tracker-auth-v1"


def _secret() -> bytes:
    if AUTH_SECRET:
        return AUTH_SECRET.encode()
    return hashlib.sha256(LOGIN_PASSWORD.encode() + _SECRET_SALT).digest()


def auth_enabled() -> bool:
    return bool(LOGIN_PASSWORD)


def check_credentials(password: str) -> bool:
    if not LOGIN_PASSWORD:
        return False
    return hmac.compare_digest(password.encode("utf-8"), LOGIN_PASSWORD.encode("utf-8"))


def check_api_token(token: str) -> bool:
    if not API_TOKEN:
        return False
    return hmac.compare_digest(token.encode("utf-8"), API_TOKEN.encode("utf-8"))


def _sign(payload_b64: bytes) -> bytes:
    return hmac.new(_secret(), payload_b64, hashlib.sha256).digest()


def create_token() -> str:
    """签发登录令牌：base64url(payload).base64url(hmac)。"""
    payload = {"sub": "user", "exp": int(time.time()) + TOKEN_TTL_SECONDS}
    body = base64.urlsafe_b64encode(json.dumps(payload).encode("utf-8")).rstrip(b"=")
    sig = base64.urlsafe_b64encode(_sign(body)).rstrip(b"=")
    return (body + b"." + sig).decode("ascii")


def verify_token(token: str) -> bool:
    """校验令牌签名与有效期。"""
    try:
        body_b64, sig_b64 = token.split(".", 1)
        body = base64.urlsafe_b64decode((body_b64 + "=" * (-len(body_b64) % 4)).encode("ascii"))
        sig = base64.urlsafe_b64decode((sig_b64 + "=" * (-len(sig_b64) % 4)).encode("ascii"))
        if not hmac.compare_digest(sig, _sign(body_b64.encode("ascii"))):
            return False
        payload = json.loads(body)
        return isinstance(payload.get("exp"), int) and payload["exp"] >= int(time.time())
    except Exception:
        return False


def authorize(header: str | None) -> bool:
    """校验 Authorization 头；未开启鉴权时总是放行。"""
    if not auth_enabled():
        return True
    if not header:
        return False
    header = header.strip()
    if header.lower().startswith("bearer "):
        token = header[7:].strip()
        return verify_token(token) or check_api_token(token)
    return check_api_token(header)


# ---------------------------------------------------------------------------
# 登录限流（简单内存计数，防暴力猜测）
# ---------------------------------------------------------------------------
LOGIN_MAX_FAILURES = 5
LOGIN_WINDOW_SECONDS = 60

_login_failures: dict[str, list[float]] = {}
_login_lock = threading.Lock()


def login_throttled(client_ip: str) -> bool:
    with _login_lock:
        now = time.time()
        hits = [t for t in _login_failures.get(client_ip, []) if now - t < LOGIN_WINDOW_SECONDS]
        _login_failures[client_ip] = hits
        return len(hits) >= LOGIN_MAX_FAILURES


def record_login_failure(client_ip: str) -> None:
    with _login_lock:
        _login_failures.setdefault(client_ip, []).append(time.time())


# ---------------------------------------------------------------------------
# ASGI 鉴权中间件
# ---------------------------------------------------------------------------
from fastapi.responses import JSONResponse  # noqa: E402
from starlette.types import ASGIApp, Receive, Scope, Send  # noqa: E402


class AuthMiddleware:
    """保护所有 /api/*（login 除外）；静态前端页面壳保持公开。"""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        path = scope.get("path", "")
        method = scope.get("method", "GET")
        if method == "OPTIONS" or not path.startswith("/api/") or path == "/api/auth/login":
            await self.app(scope, receive, send)
            return

        auth_header = None
        for name, value in scope.get("headers", []):
            if name == b"authorization":
                auth_header = value.decode("latin-1")
                break
        if authorize(auth_header):
            await self.app(scope, receive, send)
            return

        response = JSONResponse({"detail": "unauthorized"}, status_code=401)
        await response(scope, receive, send)
