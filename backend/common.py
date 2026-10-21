from __future__ import annotations

import json
import os
import re
import shutil
import tempfile
import sqlite3
import threading
import time as time_module
import hashlib
import subprocess
import signal
import asyncio
import urllib.error
import urllib.request
import urllib.parse
from contextlib import asynccontextmanager
from datetime import datetime, time, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from fastapi import FastAPI, HTTPException, Query, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse

import auth
from db import (
    DB_PATH,
    SCHEMA_VERSION,
    canonicalize_url,
    connect,
    infer_source_job_id,
    init_db,
    json_text,
    now,
    snapshot_hash,
)
from schemas import (
    AutomationStatusUpdate,
    ApplicationPatch,
    ApplyRecordsInput,
    ChatImportInput,
    EvaluationInput,
    EvaluationQueueClaim,
    EvaluationQueueCreate,
    EvaluationQueueFinish,
    JobFeedback,
    JobIngest,
    JobPatch,
    LoginRequest,
    ReplyDraftPatch,
    ReplyDraftUpsert,
    ScreeningRejectionInput,
    SearchRunCreate,
    SearchRunFinish,
)

REVIEW_STATUSES = {
    "unreviewed": "未查看",
    "viewed": "已查看",
    "hold": "待复核",
    "relevant": "相关",
    "recommended": "重点",
    "rejected": "已排除",
}
APPLICATION_STATUSES = {
    "not_started": "未处理",
    "preparing": "准备投递",
    "applied": "已投递",
    "contacted": "已沟通",
    "interview": "面试中",
    "offer": "已获 Offer",
    "closed": "流程结束",
}
SHANGHAI_TZ = ZoneInfo("Asia/Shanghai")
PEAK_WINDOWS = ((time(9, 0), time(12, 0)), (time(14, 0), time(18, 0)))

# ---------------------------------------------------------------------------
# 看板统计/评价时段 TTL 缓存（tweets 项目同款模式：写操作失效 + 有界）
# 前端每 10s 轮询 /api/stats 与 /api/evaluation-schedule，每次都重跑 COUNT 查询；
# 缓存 10s 并把写操作统一失效，避免高频读放大。
# ---------------------------------------------------------------------------
DASHBOARD_CACHE_TTL_SECONDS = 10
_automation_budget_lock = threading.Lock()
_task_lock = threading.Lock()
_panel_tasks: dict[str, dict] = {}

_dashboard_cache: dict[str, tuple[float, object]] = {}
_dashboard_cache_lock = threading.Lock()


def _cached_dashboard(key: str, producer):
    now = time_module.monotonic()
    with _dashboard_cache_lock:
        hit = _dashboard_cache.get(key)
        if hit is not None and now - hit[0] < DASHBOARD_CACHE_TTL_SECONDS:
            return hit[1]
    value = producer()
    with _dashboard_cache_lock:
        _dashboard_cache[key] = (time_module.monotonic(), value)
        if len(_dashboard_cache) > 32:
            oldest = min(_dashboard_cache, key=lambda k: _dashboard_cache[k][0])
            _dashboard_cache.pop(oldest, None)
    return value


def invalidate_dashboard_cache() -> None:
    with _dashboard_cache_lock:
        _dashboard_cache.clear()

# 服务器模式：TRACKER_STATIC_DIR 指向前端静态产物目录（frontend/dist）。
# 设置后 "/" 返回 index.html，其余非 /api 路径由底部挂载的 StaticFiles 托管；
# 本地开发不设置，保持原 JSON 行为。
STATIC_DIR = os.environ.get("TRACKER_STATIC_DIR", "")
STATIC_INDEX = str(Path(STATIC_DIR) / "index.html") if STATIC_DIR else ""
# 岗位定制简历存储目录（按 job_id 分子目录，文件系统即数据，不落库）
RESUMES_DIR = Path(os.environ.get("TRACKER_RESUMES_DIR", str(DB_PATH.parent / "resumes")))
PROJECT_ROOT = Path(__file__).resolve().parent.parent
CONFIG_DIR = Path(os.environ.get("TRACKER_CONFIG_DIR", str(PROJECT_ROOT / "automation" / "config")))


def config_path(name: str) -> Path:
    """优先读取 Git 忽略的 config/private/ 下的本人配置，缺失时回退到公开示例。"""
    private = CONFIG_DIR / "private" / name
    return private if private.exists() else CONFIG_DIR / name


_directions_cache: tuple[int, dict[str, str]] | None = None
_directions_lock = threading.Lock()


def configured_directions() -> dict[str, str]:
    global _directions_cache
    path = config_path("search-plan-v2.json")
    try:
        mtime = path.stat().st_mtime_ns
        with _directions_lock:
            if _directions_cache and _directions_cache[0] == mtime:
                return _directions_cache[1]
        plan = json.loads(path.read_text(encoding="utf-8"))
        result = {str(item["id"]): str(item.get("label") or item["id"])
                  for item in plan.get("directions", []) if isinstance(item, dict) and item.get("id")}
    except (OSError, ValueError, TypeError, KeyError):
        result = {}
        mtime = 0
    with _directions_lock:
        _directions_cache = (mtime, result)
    return result


def validate_direction(value: str | None, field: str = "direction") -> None:
    if value and value not in configured_directions():
        raise HTTPException(status_code=422, detail=f"未知{field}：{value}")


def atomic_save_config(name: str, value: dict) -> Path:
    private_dir = CONFIG_DIR / "private"
    private_dir.mkdir(parents=True, exist_ok=True)
    target = private_dir / name
    if target.exists():
        backups = private_dir / "backups"
        backups.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now(SHANGHAI_TZ).strftime("%Y%m%d-%H%M%S-%f")
        shutil.copy2(target, backups / f"{target.stem}-{stamp}{target.suffix}")
        old = sorted(backups.glob(f"{target.stem}-*{target.suffix}"), key=lambda p: p.stat().st_mtime, reverse=True)
        for path in old[10:]:
            path.unlink()
    temp_name = None
    try:
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=private_dir, prefix=f".{name}.", suffix=".tmp", delete=False) as temp:
            temp_name = temp.name
            temp.write(json.dumps(value, ensure_ascii=False, indent=2) + "\n")
        Path(temp_name).replace(target)
    finally:
        if temp_name:
            Path(temp_name).unlink(missing_ok=True)
    return target


def read_config(name: str) -> tuple[dict, str]:
    path = config_path(name)
    try:
        return json.loads(path.read_text(encoding="utf-8")), ("private" if path.parent.name == "private" else "example")
    except (OSError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=500, detail=f"无法读取配置：{name}") from exc


REPLY_PROMPT_PATH = config_path("reply-draft-prompt.md")
CANDIDATE_PROFILE_PATH = config_path("candidate-profile-v2.json")
REPLY_PROMPT_VERSION = "reply-draft-v2-on-demand"


def _resume_path(job_id: int) -> Path:
    return RESUMES_DIR / str(job_id) / "resume.pdf"


def evaluation_disabled_reason() -> str:
    # 演示模式写入的是虚构评价，不调用模型，不受“示例画像”限制
    if os.environ.get("TRACKER_DEMO") == "1":
        return ""
    profile, _ = read_config("candidate-profile-v2.json")
    return "候选人画像仍是公开示例，请先在设置中填写并保存个人画像后再运行评价。" if "example" in str(profile.get("version", "")).lower() else ""


def evaluation_schedule(at: datetime | None = None) -> dict:
    current = (at or datetime.now(SHANGHAI_TZ)).astimezone(SHANGHAI_TZ)
    local_time = current.time().replace(tzinfo=None)
    peak = any(start <= local_time < end for start, end in PEAK_WINDOWS)
    if peak:
        current_end = next(end for start, end in PEAK_WINDOWS if start <= local_time < end)
        next_offpeak = current.replace(hour=current_end.hour, minute=current_end.minute, second=0, microsecond=0)
    else:
        next_offpeak = current
    return {
        "timezone": "Asia/Shanghai",
        "now": current.isoformat(timespec="seconds"),
        "is_peak": peak,
        "is_offpeak": not peak,
        "price_multiplier": 1.0 if peak else 0.5,
        "peak_windows": ["09:00-12:00", "14:00-18:00"],
        "next_offpeak_at": next_offpeak.isoformat(timespec="seconds"),
    }

LATEST_JOB_SELECT = """
SELECT j.*,
       e.id AS evaluation_id,
       e.strategy_version,
       e.evaluator,
       e.relevance_score,
       e.recommendation_level,
       e.direction AS evaluation_direction,
       e.summary,
       e.match_evidence,
       e.gaps,
       e.risk_notes,
       e.hard_requirements,
       e.filter_result,
       e.filter_reasons,
       e.filter_version,
       e.resume_direction,
       e.needs_resume_tailoring,
       e.provider,
       e.model_name,
       e.prompt_version,
       e.profile_version,
       e.job_content_hash,
       e.input_hash,
       e.confidence_score,
       e.dimension_scores,
       e.prompt_tokens,
       e.completion_tokens,
       e.total_tokens,
       e.latency_ms,
       e.evaluated_at,
       a.status AS application_status,
       a.notes AS application_notes,
       a.chat_synced_at AS chat_synced_at,
       a.apply_feedback AS apply_feedback,
       a.apply_feedback_at AS apply_feedback_at,
       a.chat_summary AS stored_chat_summary,
       q.id AS evaluation_queue_id,
       q.mode AS evaluation_queue_mode,
       q.status AS evaluation_queue_status,
       q.requested_at AS evaluation_queue_requested_at,
       q.started_at AS evaluation_queue_started_at,
       q.finished_at AS evaluation_queue_finished_at,
       q.error AS evaluation_queue_error,
       (SELECT COUNT(*) FROM job_discoveries d WHERE d.job_id = j.id) AS discovery_count,
       (SELECT GROUP_CONCAT(DISTINCT d.keyword) FROM job_discoveries d
         WHERE d.job_id = j.id AND d.keyword != '') AS search_keywords,
       (SELECT GROUP_CONCAT(DISTINCT d.search_direction) FROM job_discoveries d
         WHERE d.job_id = j.id AND d.search_direction != '') AS search_directions,
       (SELECT COUNT(*) FROM job_snapshots s WHERE s.job_id = j.id) AS snapshot_count,
       (SELECT COUNT(*) FROM evaluations ex WHERE ex.job_id = j.id) AS evaluation_count,
       (SELECT COUNT(*) FROM chat_messages cm WHERE cm.job_id = j.id) AS chat_message_count,
       (SELECT cm2.sent_at FROM chat_messages cm2
         WHERE cm2.job_id = j.id ORDER BY cm2.sent_at DESC, cm2.id DESC LIMIT 1) AS chat_last_at,
       (SELECT cm3.sent_at FROM chat_messages cm3
         WHERE cm3.job_id = j.id AND cm3.direction = 'in'
         ORDER BY cm3.sent_at DESC, cm3.id DESC LIMIT 1) AS chat_last_inbound_at,
       (SELECT cm4.sent_at FROM chat_messages cm4
         WHERE cm4.job_id = j.id AND cm4.direction = 'out'
         ORDER BY cm4.sent_at DESC, cm4.id DESC LIMIT 1) AS chat_outbound_sent_at,
       (SELECT cm5.read_status FROM chat_messages cm5
         WHERE cm5.job_id = j.id AND cm5.direction = 'out'
         ORDER BY cm5.sent_at DESC, cm5.id DESC LIMIT 1) AS chat_outbound_read_status,
       (SELECT COUNT(*) FROM chat_messages cm7 WHERE cm7.job_id = j.id AND cm7.direction = 'in') AS chat_inbound_count,
       (SELECT CASE WHEN EXISTS (
            SELECT 1 FROM chat_messages c6 WHERE c6.job_id = j.id AND c6.direction = 'in' AND (
                c6.content LIKE '%没有特别适合%' OR c6.content LIKE '%暂时没有%'
             OR c6.content LIKE '%不合适%' OR c6.content LIKE '%不太合适%'
             OR c6.content LIKE '%不匹配%' OR c6.content LIKE '%不考虑%'
             OR c6.content LIKE '%已招满%' OR c6.content LIKE '%已关闭%'
             OR c6.content LIKE '%暂停招聘%' OR c6.content LIKE '%没有符合%'
             OR c6.content LIKE '%目标画像%' OR c6.content LIKE '%与岗位%不符%'
             OR c6.content LIKE '%与您的期望%不符%'))
         THEN 1 ELSE 0 END) AS chat_rejected
  FROM jobs j
  LEFT JOIN evaluations e ON e.id = (
      SELECT e2.id FROM evaluations e2
       WHERE e2.job_id = j.id
       ORDER BY e2.evaluated_at DESC, e2.id DESC LIMIT 1
  )
  LEFT JOIN applications a ON a.job_id = j.id
  LEFT JOIN evaluation_queue q ON q.id = (
      SELECT q2.id FROM evaluation_queue q2
       WHERE q2.job_id = j.id
       ORDER BY q2.requested_at DESC, q2.id DESC LIMIT 1
  )
"""

EVALUATION_INSERT = """
INSERT INTO evaluations(
    job_id, strategy_version, evaluator, relevance_score, recommendation_level, direction,
    summary, match_evidence, gaps, risk_notes, hard_requirements, filter_result,
    filter_reasons, filter_version, resume_direction, needs_resume_tailoring,
    provider, model_name, prompt_version, profile_version, job_content_hash, input_hash,
    confidence_score, dimension_scores, raw_response, prompt_tokens, completion_tokens,
    total_tokens, latency_ms, evaluated_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
"""


def evaluation_values(job_id: int, payload: EvaluationInput, stamp: str) -> tuple:
    return (
        job_id,
        payload.strategy_version,
        payload.evaluator,
        payload.relevance_score,
        payload.recommendation_level,
        payload.direction,
        payload.summary,
        json_text(payload.match_evidence),
        json_text(payload.gaps),
        payload.risk_notes,
        json_text(payload.hard_requirements),
        payload.filter_result,
        json_text(payload.filter_reasons),
        payload.filter_version,
        payload.resume_direction,
        None if payload.needs_resume_tailoring is None else int(payload.needs_resume_tailoring),
        payload.provider,
        payload.model_name,
        payload.prompt_version,
        payload.profile_version,
        payload.job_content_hash,
        payload.input_hash,
        payload.confidence_score,
        json_text(payload.dimension_scores),
        json_text(payload.raw_response),
        payload.prompt_tokens,
        payload.completion_tokens,
        payload.total_tokens,
        payload.latency_ms,
        stamp,
    )


def enqueue_evaluation(conn: sqlite3.Connection, job_id: int, mode: str, requested_by: str, stamp: str):
    active = conn.execute(
        "SELECT * FROM evaluation_queue WHERE job_id=? AND status IN ('queued', 'running') ORDER BY id DESC LIMIT 1",
        (job_id,),
    ).fetchone()
    if active:
        if active["status"] == "queued" and active["mode"] != mode:
            conn.execute(
                "UPDATE evaluation_queue SET mode=?, requested_by=?, requested_at=? WHERE id=?",
                (mode, requested_by, stamp, active["id"]),
            )
            active = conn.execute("SELECT * FROM evaluation_queue WHERE id=?", (active["id"],)).fetchone()
        return active
    cursor = conn.execute(
        "INSERT INTO evaluation_queue(job_id, mode, status, requested_by, requested_at) VALUES (?, ?, 'queued', ?, ?)",
        (job_id, mode, requested_by, stamp),
    )
    return conn.execute("SELECT * FROM evaluation_queue WHERE id=?", (cursor.lastrowid,)).fetchone()


def decode_json(value: str | None, fallback):
    try:
        return json.loads(value) if value else fallback
    except json.JSONDecodeError:
        return fallback


def redact_reply_input(value: str) -> str:
    """发送给回复模型前移除常见直接身份信息。"""
    text = str(value or "")
    text = re.sub(r"(?<!\d)(?:\+?86[-\s]?)?1[3-9]\d[-\s]?\d{4}[-\s]?\d{4}(?!\d)", "[手机号已隐藏]", text)
    text = re.sub(r"[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}", "[邮箱已隐藏]", text, flags=re.I)
    text = re.sub(
        r"(微信|vx|wechat)\s*[:：]?\s*[a-zA-Z][-_a-zA-Z0-9]{5,19}",
        r"\1：[账号已隐藏]", text, flags=re.I,
    )
    return text


def extract_reply_json(value: str) -> dict:
    text = str(value or "")
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        raise ValueError("模型响应不包含 JSON")
    result = json.loads(text[start:end + 1])
    if not isinstance(result, dict):
        raise ValueError("模型响应格式错误")
    return result


def call_reply_model(input_data: dict) -> tuple[dict, str]:
    """同步 HTTP 调用；API 端点通过 asyncio.to_thread 避免阻塞事件循环。"""
    api_key = os.environ.get("LLM_API_KEY") or os.environ.get("DEEPSEEK_API_KEY", "")
    if not api_key:
        raise RuntimeError("服务器未配置 LLM_API_KEY（或 DEEPSEEK_API_KEY）")
    reply_prompt_path = config_path("reply-draft-prompt.md")
    if not reply_prompt_path.exists():
        raise RuntimeError("回复提示词文件不存在")
    strategy, _ = read_config("evaluation-strategy-v2.json")
    model = os.environ.get("LLM_MODEL") or os.environ.get("DEEPSEEK_MODEL") or strategy.get("api", {}).get("model", "deepseek-v4-flash")
    base_url = (os.environ.get("LLM_BASE_URL") or os.environ.get("DEEPSEEK_BASE_URL") or "https://api.deepseek.com").rstrip("/")
    thinking = os.environ.get("LLM_THINKING") or os.environ.get("DEEPSEEK_THINKING")
    max_tokens = os.environ.get("LLM_MAX_TOKENS") or os.environ.get("DEEPSEEK_MAX_TOKENS") or "2200"
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": reply_prompt_path.read_text(encoding="utf-8").strip()},
            {"role": "user", "content": json.dumps(input_data, ensure_ascii=False)},
        ],
        "temperature": 0.2,
        "max_tokens": int(max_tokens),
        "response_format": {"type": "json_object"},
    }
    if thinking:
        payload["thinking"] = {"type": thinking}
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        f"{base_url}/chat/completions", data=body, method="POST",
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=90) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")[:240]
        raise RuntimeError(f"LLM HTTP {error.code}: {detail}") from error
    message = ((payload.get("choices") or [{}])[0].get("message") or {})
    result = extract_reply_json(message.get("content") or message.get("reasoning_content") or "")
    return result, model


def chat_state(item: dict) -> str:
    """从聊天消息事实推导沟通状态（不物化，实时计算）。

    - none: 无沟通记录
    - unread: 我方最后一条消息对方未读
    - read_no_reply: 我方最后一条消息对方已读且此后无回复 → 变相拒绝信号
    - replied: 对方在最后一条我方消息之后有回复（或对方主动发起沟通）
    - unknown: 有消息但无法判定（如只有系统提示）
    """
    count = item.get("chat_message_count") or 0
    if not count:
        return "none"
    last_out = item.get("chat_outbound_sent_at") or ""
    last_in = item.get("chat_last_inbound_at") or ""
    out_read = item.get("chat_outbound_read_status") or "unknown"
    in_count = item.get("chat_inbound_count") or 0
    # 对方回复过（存在 in 消息，含对方主动发起）→ 已回复。
    # 我方后续消息（如致谢）的已读状态只是局部信息，不把整体降级为未读。
    if last_in or in_count > 0:
        return "replied"
    if not last_out:
        return "unknown"
    if out_read == "read":
        return "read_no_reply"
    if out_read == "unread":
        return "unread"
    return "unknown"


TERMINAL_FEEDBACK = {"不合适", "暂不合适", "已拒绝", "已结束", "已关闭", "已下线", "岗位已关闭"}


def chat_summary(item: dict) -> str:
    """沟通进度的简洁人工可读摘要（用于备注区展示，不写入 notes）。

    优先采用明确投递反馈（如 暂不合适）作为结论；否则按聊天状态推导。
    """
    feedback = (item.get("apply_feedback") or "").strip()
    if feedback in TERMINAL_FEEDBACK:
        at = item.get("apply_feedback_at") or ""
        return f"不合适（投递反馈{f' {at[:10]}' if at else ''}）"
    state = chat_state(item)
    last_in = item.get("chat_last_inbound_at") or ""
    last_out = item.get("chat_outbound_sent_at") or ""
    summary = {
        "none": "",
        "unread": "已发送，对方未读",
        "read_no_reply": "已读未回",
        "replied": "已回复",
        "unknown": "有沟通记录，状态待确认",
    }[state]
    if state == "read_no_reply" and last_out:
        summary += f"（我方最后消息 {last_out[:10]}）"
    if state == "replied" and last_in:
        # 对方消息含明确拒绝语义 → 已回复，不合适
        rejected = bool(item.get("chat_rejected"))
        summary += ("，不合适" if rejected else "，待进一步反馈") + f"（最近回复 {last_in[:10]}）"
    elif state == "replied":
        rejected = bool(item.get("chat_rejected"))
        summary += "，不合适" if rejected else "，待进一步反馈"
    return summary


def job_dict(row: sqlite3.Row) -> dict:
    item = dict(row)
    for key in ("match_evidence", "gaps", "hard_requirements", "filter_reasons"):
        item[key] = decode_json(item.get(key), [])
    for key in ("dimension_scores", "raw_response"):
        item[key] = decode_json(item.get(key), {})
    item["needs_resume_tailoring"] = (
        None if item.get("needs_resume_tailoring") is None else bool(item["needs_resume_tailoring"])
    )
    item["job_tags"] = decode_json(item.get("job_tags"), [])
    item["benefits"] = decode_json(item.get("benefits"), [])
    item["recruiter_tags"] = decode_json(item.get("recruiter_tags"), [])
    item["metadata"] = decode_json(item.get("metadata"), {})
    item["recruiter_verified"] = (
        None if item.get("recruiter_verified") is None else bool(item["recruiter_verified"])
    )
    item["search_keywords"] = [part for part in (item.get("search_keywords") or "").split(",") if part]
    item["search_directions"] = [part for part in (item.get("search_directions") or "").split(",") if part]
    item["application_status"] = item.get("application_status") or "not_started"
    app_status = item["application_status"]
    item["funnel_status"] = ("excluded" if item.get("review_status") == "rejected" else
        "offer" if app_status == "offer" else "closed" if app_status == "closed" else
        "interview" if app_status == "interview" else "contacted" if app_status in {"applied", "contacted"} else
        "interested" if item.get("review_status") in {"relevant", "recommended"} or app_status == "preparing" else "todo")
    item["chat_state"] = chat_state(item)
    item["chat_summary"] = item.get("stored_chat_summary") or chat_summary(item)
    item["status"] = item["review_status"]
    item["score"] = item.get("relevance_score")
    item["rationale"] = item.get("summary") or ""
    item["link"] = item["url"]
    return item


def event(
    conn: sqlite3.Connection,
    job_id: int,
    event_type: str,
    old_value: object = None,
    new_value: object = None,
    note: str = "",
    actor: str = "system",
    created_at: str | None = None,
) -> None:
    conn.execute(
        """INSERT INTO job_events(job_id, event_type, old_value, new_value, note, actor, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)""",
        (
            job_id,
            event_type,
            None if old_value is None else str(old_value),
            None if new_value is None else str(new_value),
            note,
            actor,
            created_at or now(),
        ),
    )


def get_job_row(conn: sqlite3.Connection, job_id: int) -> sqlite3.Row:
    row = conn.execute(f"{LATEST_JOB_SELECT} WHERE j.id = ?", (job_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Job not found")
    return row


# ---------------------------------------------------------------------------
# 共享筛选条件构造：列表接口与统计接口（侧栏实时交集计数）共用同一套逻辑
# ---------------------------------------------------------------------------
FUNNEL_STATUS_SQL = "CASE WHEN j.review_status='rejected' THEN 'excluded' WHEN a.status='offer' THEN 'offer' WHEN a.status='closed' THEN 'closed' WHEN a.status='interview' THEN 'interview' WHEN a.status IN ('applied','contacted') THEN 'contacted' WHEN j.review_status IN ('relevant','recommended') OR a.status='preparing' THEN 'interested' ELSE 'todo' END"


def _job_where(
    *,
    state: str | None = None,
    review_status: str | None = None,
    application_status: str | None = None,
    funnel_status: str | None = None,
    source: str | None = None,
    search_direction: str | None = None,
    evaluation_direction: str | None = None,
    evaluation_status: str | None = None,
    rating_status: str | None = None,
    min_score: int = 0,
    max_score: int | None = None,
    q: str = "",
) -> tuple[str, list[object]]:
    where: list[str] = []
    # 岗位状态（派生组合视图）：未处理 / 已投递·沟通 / 面试中 / 已排除
    # 支持逗号分隔多选（如 state=not_started,interview → 各状态并集）
    if state and state != "all":
        state_conds = []
        for s in [x.strip() for x in state.split(",") if x.strip()]:
            if s == "not_started":
                state_conds.append("(a.status IS NULL OR a.status = 'not_started') AND j.review_status != 'rejected'")
            elif s == "applied_contacted":
                state_conds.append("a.status IN ('applied', 'contacted')")
            elif s == "interview":
                state_conds.append("a.status = 'interview'")
            elif s == "rejected":
                state_conds.append("j.review_status = 'rejected'")
        if state_conds:
            where.append("(" + " OR ".join(state_conds) + ")")
    params: list[object] = []
    if funnel_status and funnel_status != "all":
        where.append(f"({FUNNEL_STATUS_SQL}) = ?")
        params.append(funnel_status)
    if review_status and review_status != "all":
        if review_status == "not_rejected":
            where.append("j.review_status != 'rejected'")
        else:
            where.append("j.review_status = ?")
            params.append(review_status)
    if application_status and application_status != "all":
        if application_status == "not_started":
            where.append("(a.status IS NULL OR a.status = 'not_started')")
        else:
            where.append("a.status = ?")
            params.append(application_status)
    if source and source != "all":
        where.append("j.source = ?")
        params.append(source)
    if search_direction and search_direction != "all":
        if search_direction == "unclassified":
            where.append("NOT EXISTS (SELECT 1 FROM job_discoveries sd WHERE sd.job_id=j.id AND sd.search_direction != '')")
        else:
            where.append("EXISTS (SELECT 1 FROM job_discoveries sd WHERE sd.job_id=j.id AND sd.search_direction = ?)")
            params.append(search_direction)
    if evaluation_direction and evaluation_direction != "all":
        where.append("e.direction = ?")
        params.append(evaluation_direction)
    if evaluation_status == "evaluated":
        where.append("e.id IS NOT NULL")
    elif evaluation_status == "unevaluated":
        where.append("e.id IS NULL")
    if rating_status == "rated":
        where.append("j.user_score IS NOT NULL")
    elif rating_status == "unrated":
        where.append("j.user_score IS NULL")
    score_min = min_score
    score_max = 100 if max_score is None else max_score
    if score_min > 0 or score_max < 100:
        # 非平凡区间只作用于已评估岗位，避免未评估（COALESCE 0）混入结果
        where.append("e.id IS NOT NULL AND COALESCE(e.relevance_score, 0) BETWEEN ? AND ?")
        params.extend([score_min, score_max])
    token = q.strip()
    if token:
        # 纯数字（或 #数字）输入按岗位 id 精确匹配，如 q=249 或 q=#249
        id_match = re.match(r"^#?(\d+)$", token)
        if id_match:
            where.append("j.id = ?")
            params.append(int(id_match.group(1)))
        elif len(token) >= 3:
            like = f"%{token}%"
            match = f'"{token.replace(chr(34), chr(34) * 2)}"'
            where.append("(j.id IN (SELECT rowid FROM jobs_fts WHERE jobs_fts MATCH ?) OR e.summary LIKE ?)")
            params.extend([match, like])
        else:
            like = f"%{token}%"
            where.append("(j.title LIKE ? OR j.company LIKE ? OR j.jd LIKE ? OR e.summary LIKE ?)")
            params.extend([like] * 4)
    clause = f"WHERE {' AND '.join(where)}" if where else ""
    return clause, params


# 统计用精简 FROM 主体（与列表同构的 latest-evaluation / application 连接，不含展示字段）
JOB_COUNT_FROM = """
jobs j
LEFT JOIN evaluations e ON e.id = (
    SELECT e2.id FROM evaluations e2
     WHERE e2.job_id = j.id
     ORDER BY e2.evaluated_at DESC, e2.id DESC LIMIT 1
)
LEFT JOIN applications a ON a.job_id = j.id
"""


def _count_group(conn: sqlite3.Connection, group_expr: str, where_clause: str, params: list[object]) -> dict:
    rows = conn.execute(
        f"SELECT {group_expr} AS k, COUNT(*) AS c FROM {JOB_COUNT_FROM} {where_clause} GROUP BY {group_expr}",
        params,
    ).fetchall()
    return {row["k"] or "not_started": row["c"] for row in rows}


# 列表接口裁剪：只保留前端展示所需字段，减小响应体积（详情接口仍返回全量）。
LIST_TRIM_FIELDS = {
    "source_job_id", "content_hash", "job_content_hash", "input_hash", "provider",
    "prompt_version", "profile_version", "prompt_tokens", "completion_tokens",
    "total_tokens", "latency_ms", "evaluated_at", "listing_status", "filter_version",
    "needs_resume_tailoring", "raw_response", "rationale", "link", "resume_direction",
}
LIST_METADATA_KEYS = ("department", "language_requirement", "industry_requirement")


def list_job_projection(item: dict) -> dict:
    """把完整 job_dict 精简为列表展示所需字段。"""
    for key in LIST_TRIM_FIELDS:
        item.pop(key, None)
    meta = item.get("metadata") or {}
    item["metadata"] = {k: meta.get(k) for k in LIST_METADATA_KEYS if meta.get(k)}
    return item


LIST_CONFIGS = {
    "hardTitleBlacklist", "hardIrrelevantTitleTerms", "hardIrrelevantDetailTerms",
    "hardExperienceTerms", "downrankTitleTerms", "positiveTitleTerms", "domainTerms",
    "taskTerms", "preferredLocations",
}












def mask_resume_text(text: str) -> str:
    lines = str(text or "").splitlines()
    if lines and len(lines[0].strip()) <= 40 and re.fullmatch(r"[\u4e00-\u9fff·•\s]{2,12}|[A-Za-z][A-Za-z .'-]{1,39}", lines[0].strip()):
        lines[0] = "[姓名已隐藏]"
    value = "\n".join(lines)
    value = re.sub(r"[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}", "[邮箱已隐藏]", value, flags=re.I)
    value = re.sub(r"(?<!\d)(?:\+?86[-\s]?)?1[3-9]\d[-\s]?\d{4}[-\s]?\d{4}(?!\d)", "[手机号已隐藏]", value)
    value = re.sub(r"(?i)(微信|wechat|vx|v信)\s*[:：]?\s*[A-Za-z][-_A-Za-z0-9]{5,19}", r"\1[账号已隐藏]", value)
    value = re.sub(r"(?<!\d)(?:\d{18}|\d{17}[Xx]|\d{15})(?!\d)", "[证件号已隐藏]", value)
    return value[:30000]


def call_profile_draft_model(masked_text: str) -> dict:
    api_key = os.environ.get("LLM_API_KEY") or os.environ.get("DEEPSEEK_API_KEY", "")
    if not api_key:
        raise RuntimeError("未配置模型 API 密钥，请设置 LLM_API_KEY 或 DEEPSEEK_API_KEY")
    prompt_path = CONFIG_DIR / "profile-draft-prompt.md"
    if not prompt_path.exists():
        prompt_path = PROJECT_ROOT / "automation" / "config" / "profile-draft-prompt.md"
    strategy, _ = read_config("evaluation-strategy-v2.json")
    model = os.environ.get("LLM_MODEL") or os.environ.get("DEEPSEEK_MODEL") or strategy.get("api", {}).get("model", "deepseek-v4-flash")
    base_url = (os.environ.get("LLM_BASE_URL") or os.environ.get("DEEPSEEK_BASE_URL") or "https://api.deepseek.com").rstrip("/")
    thinking = os.environ.get("LLM_THINKING") or os.environ.get("DEEPSEEK_THINKING")
    max_tokens = int(os.environ.get("LLM_MAX_TOKENS") or os.environ.get("DEEPSEEK_MAX_TOKENS") or "3000")
    payload = {"model": model, "messages": [{"role": "system", "content": prompt_path.read_text(encoding="utf-8")}, {"role": "user", "content": masked_text}], "temperature": 0.1, "max_tokens": max_tokens, "response_format": {"type": "json_object"}}
    if thinking: payload["thinking"] = {"type": thinking}
    request = urllib.request.Request(f"{base_url}/chat/completions", data=json.dumps(payload, ensure_ascii=False).encode(), method="POST", headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=90) as response:
        result = extract_reply_json(json.loads(response.read().decode()).get("choices", [{}])[0].get("message", {}).get("content", ""))
    return result
















def automation_status_dict(row) -> dict:
    item = dict(row)
    item["metadata"] = decode_json(item.get("metadata"), {})
    item.pop("qr_image", None)
    item.pop("qr_updated_at", None)
    return item




def _automation_policy() -> dict:
    try:
        return json.loads(config_path("automation-policy.json").read_text(encoding="utf-8"))
    except Exception:
        return {"daily_caps": {"boss": {"detail_opens": 80, "chat_opens": 200}, "liepin": {"detail_opens": 80, "chat_opens": 60}}, "cooldown_minutes": 60}


def _budget_file() -> Path:
    return DB_PATH.parent / "automation-budget.json"


def _read_budget() -> dict:
    try:
        return json.loads(_budget_file().read_text(encoding="utf-8"))
    except Exception:
        return {"usage": {}, "cooldowns": {}, "runs": {}}


def _cooldown_active(until: str) -> bool:
    try:
        parsed = datetime.fromisoformat(until)
        if parsed.tzinfo is None: parsed = parsed.replace(tzinfo=SHANGHAI_TZ)
        return parsed > datetime.now(SHANGHAI_TZ)
    except (TypeError, ValueError):
        return False


def _write_budget(value: dict) -> None:
    target = _budget_file()
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix="automation-budget-", dir=target.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(value, handle, ensure_ascii=False)
        os.replace(temporary, target)
    finally:
        if os.path.exists(temporary): os.unlink(temporary)






































def _panel_task_snapshot() -> dict:
    result = {}
    for task_id, item in list(_panel_tasks.items()):
        proc = item.get("process")
        if proc and proc.poll() is not None and item.get("status") == "running":
            item["status"] = "completed" if proc.returncode == 0 else "failed"
            item["exit_code"] = proc.returncode
            item["finished_at"] = now()
        result[task_id] = {k: v for k, v in item.items() if k != "process"}
    budget = _read_budget()
    running = next((x for x in result.values() if x["status"] == "running"), None)
    lock_path = PROJECT_ROOT / ".run" / "browser-automation.lock"
    if running is None and lock_path.exists():
        try:
            owner = json.loads(lock_path.read_text(encoding="utf-8"))
            os.kill(int(owner.get("pid", 0)), 0)
            running = {"id": "browser-lock", "name": owner.get("kind", "browser-automation"), "status": "running", "pid": owner.get("pid"), "started_at": owner.get("started_at", ""), "panel_managed": False}
            result["browser-lock"] = running
        except PermissionError:
            running = {"id": "browser-lock", "name": "browser-automation", "status": "running", "panel_managed": False}
            result["browser-lock"] = running
        except (ProcessLookupError, ValueError, json.JSONDecodeError):
            pass
    return {"running": running, "tasks": list(result.values()), "last_runs": budget.get("runs", {})}








































def _refresh_chat_summary(conn: sqlite3.Connection, job_id: int, stamp: str) -> None:
    """反馈/沟通变化后刷新 applications.chat_summary（不触碰人工 notes）。"""
    row = get_job_row(conn, job_id)
    if row is None:
        return
    item = job_dict(row)
    conn.execute(
        "UPDATE applications SET chat_summary = ? WHERE job_id = ?",
        (chat_summary(item), job_id),
    )









