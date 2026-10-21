from __future__ import annotations

import hashlib
import json
import os
import re
import sqlite3
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
# TRACKER_DB_PATH 可切换数据库，例如演示模式使用 data/demo.sqlite3
DB_PATH = Path(os.environ.get("TRACKER_DB_PATH") or DATA_DIR / "jobs.sqlite3")
SCHEMA_VERSION = 16


def now() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def json_text(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def canonicalize_url(url: str) -> str:
    """Return a stable detail URL without tracking parameters or fragments."""
    parts = urlsplit(url.strip())
    if parts.scheme not in {"http", "https"} or not parts.netloc:
        raise ValueError("岗位 URL 必须是完整的 http(s) 地址")
    path = parts.path.rstrip("/") or "/"
    return urlunsplit((parts.scheme.lower(), parts.netloc.lower(), path, "", ""))


def infer_source_job_id(source: str, canonical_url: str) -> str | None:
    path = urlsplit(canonical_url).path
    if source == "boss":
        match = re.search(r"/job_detail/([^/.]+)\.html", path)
        return match.group(1) if match else None
    match = re.search(r"/(job|a)/(\d+)\.shtml", path)
    return f"{match.group(1)}:{match.group(2)}" if match else None


def snapshot_hash(fields: dict) -> str:
    stable = json_text(fields).encode("utf-8")
    return hashlib.sha256(stable).hexdigest()


@contextmanager
def connect():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=15)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA busy_timeout = 15000")
    # FTS5 段合并等操作按 temp_store 决定是否在系统临时目录写临时文件。
    # 固定为内存，避免依赖 /tmp（沙箱或小磁盘环境下曾出现 SQLITE_CANTOPEN）；
    # 当前数据量级下内存开销可忽略。
    conn.execute("PRAGMA temp_store = MEMORY")
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS schema_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS search_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL CHECK (source IN ('boss', 'liepin')),
    keyword TEXT NOT NULL,
    search_direction TEXT NOT NULL DEFAULT '',
    filters TEXT NOT NULL DEFAULT '{}',
    started_at TEXT NOT NULL,
    finished_at TEXT,
    status TEXT NOT NULL DEFAULT 'running'
        CHECK (status IN ('running', 'completed', 'interrupted', 'failed')),
    result_count INTEGER NOT NULL DEFAULT 0,
    new_job_count INTEGER NOT NULL DEFAULT 0,
    relevant_count INTEGER NOT NULL DEFAULT 0,
    recommended_count INTEGER NOT NULL DEFAULT 0,
    notes TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_search_runs_source_time
    ON search_runs(source, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_search_runs_keyword_time
    ON search_runs(keyword, started_at DESC);

CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL CHECK (source IN ('boss', 'liepin')),
    source_job_id TEXT,
    canonical_url TEXT NOT NULL,
    url TEXT NOT NULL,
    title TEXT NOT NULL,
    company TEXT NOT NULL DEFAULT '',
    location TEXT NOT NULL DEFAULT '',
    salary TEXT NOT NULL DEFAULT '',
    update_time TEXT NOT NULL DEFAULT '',
    relative_update_time TEXT NOT NULL DEFAULT '',
    listing_status TEXT NOT NULL DEFAULT '',
    experience TEXT NOT NULL DEFAULT '',
    education TEXT NOT NULL DEFAULT '',
    headcount TEXT NOT NULL DEFAULT '',
    job_tags TEXT NOT NULL DEFAULT '[]',
    benefits TEXT NOT NULL DEFAULT '[]',
    recruiter_name TEXT NOT NULL DEFAULT '',
    recruiter_title TEXT NOT NULL DEFAULT '',
    recruiter_company TEXT NOT NULL DEFAULT '',
    recruiter_tags TEXT NOT NULL DEFAULT '[]',
    recruiter_activity TEXT NOT NULL DEFAULT '',
    recruiter_verified INTEGER,
    publisher_type TEXT NOT NULL DEFAULT 'unknown',
    company_industry TEXT NOT NULL DEFAULT '',
    company_size TEXT NOT NULL DEFAULT '',
    company_stage TEXT NOT NULL DEFAULT '',
    work_address TEXT NOT NULL DEFAULT '',
    metadata TEXT NOT NULL DEFAULT '{}',
    jd TEXT NOT NULL DEFAULT '',
    content_hash TEXT NOT NULL DEFAULT '',
    review_status TEXT NOT NULL DEFAULT 'viewed'
        CHECK (review_status IN ('unreviewed', 'viewed', 'hold', 'relevant', 'recommended', 'rejected')),
    user_score INTEGER CHECK (user_score IS NULL OR user_score BETWEEN 0 AND 100),
    user_notes TEXT NOT NULL DEFAULT '',
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    last_checked_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(source, canonical_url)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_source_job_id
    ON jobs(source, source_job_id)
    WHERE source_job_id IS NOT NULL AND source_job_id != '';
CREATE INDEX IF NOT EXISTS idx_jobs_review_updated
    ON jobs(review_status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_source_updated
    ON jobs(source, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_company_title
    ON jobs(company, title);
CREATE INDEX IF NOT EXISTS idx_jobs_updated
    ON jobs(updated_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS job_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    content_hash TEXT NOT NULL,
    fields TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    UNIQUE(job_id, content_hash)
);
CREATE INDEX IF NOT EXISTS idx_snapshots_job_time
    ON job_snapshots(job_id, observed_at DESC);

CREATE TABLE IF NOT EXISTS job_discoveries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    search_run_id INTEGER REFERENCES search_runs(id) ON DELETE SET NULL,
    source TEXT NOT NULL CHECK (source IN ('boss', 'liepin')),
    keyword TEXT NOT NULL DEFAULT '',
    search_direction TEXT NOT NULL DEFAULT '',
    search_page_url TEXT NOT NULL DEFAULT '',
    result_position INTEGER,
    discovered_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_discoveries_job_time
    ON job_discoveries(job_id, discovered_at DESC);
CREATE INDEX IF NOT EXISTS idx_discoveries_run_position
    ON job_discoveries(search_run_id, result_position);
CREATE UNIQUE INDEX IF NOT EXISTS idx_discoveries_run_job
    ON job_discoveries(search_run_id, job_id)
    WHERE search_run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_discoveries_keyword_time
    ON job_discoveries(keyword, discovered_at DESC);

CREATE TABLE IF NOT EXISTS screening_rejections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL CHECK (source IN ('boss', 'liepin')),
    source_job_id TEXT,
    canonical_url TEXT NOT NULL,
    url TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    company TEXT NOT NULL DEFAULT '',
    location TEXT NOT NULL DEFAULT '',
    salary TEXT NOT NULL DEFAULT '',
    reasons TEXT NOT NULL DEFAULT '[]',
    rules_version TEXT NOT NULL DEFAULT '',
    search_run_id INTEGER REFERENCES search_runs(id) ON DELETE SET NULL,
    keyword TEXT NOT NULL DEFAULT '',
    search_direction TEXT NOT NULL DEFAULT '',
    search_page_url TEXT NOT NULL DEFAULT '',
    result_position INTEGER,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    seen_count INTEGER NOT NULL DEFAULT 1,
    UNIQUE(source, canonical_url)
);
CREATE INDEX IF NOT EXISTS idx_screening_rejections_source_time
    ON screening_rejections(source, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_screening_rejections_run
    ON screening_rejections(search_run_id, result_position);

CREATE TABLE IF NOT EXISTS evaluations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    strategy_version TEXT NOT NULL,
    evaluator TEXT NOT NULL DEFAULT 'codex',
    relevance_score INTEGER CHECK (relevance_score IS NULL OR relevance_score BETWEEN 0 AND 100),
    recommendation_level TEXT NOT NULL DEFAULT ''
        CHECK (recommendation_level IN ('priority', 'normal', 'opportunity', '')),
    direction TEXT NOT NULL DEFAULT 'general',
    summary TEXT NOT NULL DEFAULT '',
    match_evidence TEXT NOT NULL DEFAULT '[]',
    gaps TEXT NOT NULL DEFAULT '[]',
    risk_notes TEXT NOT NULL DEFAULT '',
    hard_requirements TEXT NOT NULL DEFAULT '[]',
    filter_result TEXT NOT NULL DEFAULT 'pass'
        CHECK (filter_result IN ('pass', 'flag', 'reject')),
    filter_reasons TEXT NOT NULL DEFAULT '[]',
    filter_version TEXT NOT NULL DEFAULT '',
    resume_direction TEXT NOT NULL DEFAULT '',
    needs_resume_tailoring INTEGER,
    provider TEXT NOT NULL DEFAULT '',
    model_name TEXT NOT NULL DEFAULT '',
    prompt_version TEXT NOT NULL DEFAULT '',
    profile_version TEXT NOT NULL DEFAULT '',
    job_content_hash TEXT NOT NULL DEFAULT '',
    input_hash TEXT NOT NULL DEFAULT '',
    confidence_score INTEGER CHECK (confidence_score IS NULL OR confidence_score BETWEEN 0 AND 100),
    dimension_scores TEXT NOT NULL DEFAULT '{}',
    raw_response TEXT NOT NULL DEFAULT '{}',
    prompt_tokens INTEGER,
    completion_tokens INTEGER,
    total_tokens INTEGER,
    latency_ms INTEGER,
    evaluated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_evaluations_job_time
    ON evaluations(job_id, evaluated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_evaluations_score
    ON evaluations(relevance_score DESC);
CREATE INDEX IF NOT EXISTS idx_evaluations_direction_score
    ON evaluations(direction, relevance_score DESC);

CREATE TABLE IF NOT EXISTS evaluation_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    mode TEXT NOT NULL DEFAULT 'offpeak'
        CHECK (mode IN ('offpeak', 'immediate')),
    status TEXT NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
    requested_by TEXT NOT NULL DEFAULT 'system',
    requested_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    evaluation_id INTEGER REFERENCES evaluations(id) ON DELETE SET NULL,
    error TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_evaluation_queue_status_mode_time
    ON evaluation_queue(status, mode, requested_at);
CREATE INDEX IF NOT EXISTS idx_evaluation_queue_job_time
    ON evaluation_queue(job_id, requested_at DESC, id DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_evaluation_queue_one_active_job
    ON evaluation_queue(job_id)
    WHERE status IN ('queued', 'running');

CREATE TABLE IF NOT EXISTS applications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id INTEGER NOT NULL UNIQUE REFERENCES jobs(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'not_started'
        CHECK (status IN ('not_started', 'preparing', 'applied', 'contacted', 'interview', 'offer', 'closed')),
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_applications_status
    ON applications(status);

CREATE TABLE IF NOT EXISTS job_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL,
    old_value TEXT,
    new_value TEXT,
    note TEXT NOT NULL DEFAULT '',
    actor TEXT NOT NULL DEFAULT 'system',
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_job_time
    ON job_events(job_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    direction TEXT NOT NULL CHECK (direction IN ('out', 'in', 'system')),
    content TEXT NOT NULL DEFAULT '',
    content_type TEXT NOT NULL DEFAULT 'text',
    sent_at TEXT NOT NULL DEFAULT '',
    read_status TEXT NOT NULL DEFAULT 'unknown'
        CHECK (read_status IN ('unread', 'read', 'unknown')),
    message_hash TEXT NOT NULL,
    raw TEXT NOT NULL DEFAULT '{}',
    collected_at TEXT NOT NULL,
    UNIQUE (job_id, message_hash)
);
CREATE INDEX IF NOT EXISTS idx_chat_messages_job_time
    ON chat_messages(job_id, sent_at, id);

CREATE TABLE IF NOT EXISTS reply_drafts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    trigger_message_hash TEXT NOT NULL,
    trigger_content TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'sent', 'dismissed')),
    generation_status TEXT NOT NULL DEFAULT 'queued'
        CHECK (generation_status IN ('queued', 'completed', 'failed')),
    suggested_reply TEXT NOT NULL DEFAULT '',
    edited_reply TEXT NOT NULL DEFAULT '',
    rationale TEXT NOT NULL DEFAULT '',
    risk_flags TEXT NOT NULL DEFAULT '[]',
    model_name TEXT NOT NULL DEFAULT '',
    prompt_version TEXT NOT NULL DEFAULT '',
    error TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    sent_at TEXT NOT NULL DEFAULT '',
    UNIQUE(job_id, trigger_message_hash)
);
CREATE INDEX IF NOT EXISTS idx_reply_drafts_status_time
    ON reply_drafts(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reply_drafts_job_time
    ON reply_drafts(job_id, created_at DESC);

CREATE TABLE IF NOT EXISTS automation_status (
    platform TEXT PRIMARY KEY CHECK (platform IN ('boss', 'liepin')),
    status TEXT NOT NULL DEFAULT 'offline'
        CHECK (status IN ('online', 'sleeping', 'login_required', 'login_pending', 'offline', 'error')),
    message TEXT NOT NULL DEFAULT '',
    qr_image BLOB,
    qr_updated_at TEXT NOT NULL DEFAULT '',
    last_heartbeat_at TEXT NOT NULL DEFAULT '',
    last_success_at TEXT NOT NULL DEFAULT '',
    next_run_at TEXT NOT NULL DEFAULT '',
    metadata TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS jobs_fts USING fts5(
    title,
    company,
    jd,
    content='jobs',
    content_rowid='id',
    tokenize='trigram'
);
CREATE TRIGGER IF NOT EXISTS jobs_fts_insert AFTER INSERT ON jobs BEGIN
    INSERT INTO jobs_fts(rowid, title, company, jd)
    VALUES (new.id, new.title, new.company, new.jd);
END;
CREATE TRIGGER IF NOT EXISTS jobs_fts_delete AFTER DELETE ON jobs BEGIN
    INSERT INTO jobs_fts(jobs_fts, rowid, title, company, jd)
    VALUES ('delete', old.id, old.title, old.company, old.jd);
END;
CREATE TRIGGER IF NOT EXISTS jobs_fts_update AFTER UPDATE OF title, company, jd ON jobs BEGIN
    INSERT INTO jobs_fts(jobs_fts, rowid, title, company, jd)
    VALUES ('delete', old.id, old.title, old.company, old.jd);
    INSERT INTO jobs_fts(rowid, title, company, jd)
    VALUES (new.id, new.title, new.company, new.jd);
END;
"""


def _legacy_columns(conn: sqlite3.Connection) -> set[str]:
    return {row["name"] for row in conn.execute("PRAGMA table_info(jobs)")}


def _migrate_prototype_v1(conn: sqlite3.Connection) -> None:
    columns = _legacy_columns(conn)
    if not columns or "status" not in columns:
        return

    legacy_jobs = [dict(row) for row in conn.execute("SELECT * FROM jobs ORDER BY id")]
    legacy_events = []
    if conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='status_events'").fetchone():
        legacy_events = [dict(row) for row in conn.execute("SELECT * FROM status_events ORDER BY id")]
        conn.execute("DROP TABLE status_events")
    conn.execute("DROP TABLE jobs")
    conn.executescript(SCHEMA_SQL)

    id_map: dict[int, int] = {}
    for item in legacy_jobs:
        canonical_url = canonicalize_url(item["url"])
        source_job_id = item.get("source_job_id") or infer_source_job_id(item["source"], canonical_url)
        raw_status = item.get("status") or "viewed"
        review_status = "viewed" if raw_status == "expired" else raw_status
        if review_status not in {"unreviewed", "viewed", "hold", "relevant", "recommended", "rejected"}:
            review_status = "viewed"
        first_seen = item.get("captured_at") or item.get("updated_at") or now()
        last_seen = item.get("last_seen_at") or first_seen
        fields = {
            "title": item["title"],
            "company": item.get("company", ""),
            "location": item.get("location", ""),
            "salary": item.get("salary", ""),
            "update_time": item.get("update_time", ""),
            "jd": item.get("jd", ""),
        }
        content_hash = snapshot_hash(fields)
        cursor = conn.execute(
            """INSERT INTO jobs(
                source, source_job_id, canonical_url, url, title, company, location, salary,
                update_time, jd, content_hash, review_status, user_score,
                user_notes, first_seen_at, last_seen_at, last_checked_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                item["source"], source_job_id, canonical_url, item["url"], fields["title"],
                fields["company"], fields["location"], fields["salary"], fields["update_time"],
                fields["jd"], content_hash, review_status,
                item.get("user_score"), item.get("user_notes", ""), first_seen, last_seen,
                last_seen, item.get("updated_at") or last_seen,
            ),
        )
        job_id = cursor.lastrowid
        id_map[item["id"]] = job_id
        conn.execute(
            "INSERT INTO job_snapshots(job_id, content_hash, fields, observed_at) VALUES (?, ?, ?, ?)",
            (job_id, content_hash, json_text(fields), first_seen),
        )
        if item.get("search_keyword"):
            conn.execute(
                "INSERT INTO job_discoveries(job_id, source, keyword, discovered_at) VALUES (?, ?, ?, ?)",
                (job_id, item["source"], item["search_keyword"], first_seen),
            )
        if item.get("relevance_score") is not None or item.get("summary"):
            conn.execute(
                """INSERT INTO evaluations(
                    job_id, strategy_version, evaluator, relevance_score, recommendation_level,
                    direction, summary, match_evidence, gaps, risk_notes, filter_version, evaluated_at
                ) VALUES (?, 'prototype-v1', 'migration', ?, ?, ?, ?, ?, ?, ?, 'prototype-v1', ?)""",
                (
                    job_id, item.get("relevance_score"), item.get("recommendation_level", ""),
                    item.get("direction", "general"), item.get("summary", ""),
                    item.get("match_evidence", "[]"), item.get("gaps", "[]"),
                    item.get("risk_notes", ""), item.get("updated_at") or last_seen,
                ),
            )

    for item in legacy_events:
        job_id = id_map.get(item["job_id"])
        if not job_id:
            continue
        event_type = "availability_status_changed" if item["new_status"] == "expired" else "review_status_changed"
        conn.execute(
            """INSERT INTO job_events(job_id, event_type, old_value, new_value, note, actor, created_at)
               VALUES (?, ?, ?, ?, ?, 'migration', ?)""",
            (job_id, event_type, item.get("old_status"), item["new_status"], item.get("note", ""), item["created_at"]),
        )


def _migrate_rich_job_fields(conn: sqlite3.Connection) -> None:
    columns = _legacy_columns(conn)
    additions = {
        "relative_update_time": "TEXT NOT NULL DEFAULT ''",
        "listing_status": "TEXT NOT NULL DEFAULT ''",
        "experience": "TEXT NOT NULL DEFAULT ''",
        "education": "TEXT NOT NULL DEFAULT ''",
        "headcount": "TEXT NOT NULL DEFAULT ''",
        "job_tags": "TEXT NOT NULL DEFAULT '[]'",
        "benefits": "TEXT NOT NULL DEFAULT '[]'",
        "recruiter_name": "TEXT NOT NULL DEFAULT ''",
        "recruiter_title": "TEXT NOT NULL DEFAULT ''",
        "recruiter_company": "TEXT NOT NULL DEFAULT ''",
        "recruiter_tags": "TEXT NOT NULL DEFAULT '[]'",
        "recruiter_activity": "TEXT NOT NULL DEFAULT ''",
        "recruiter_verified": "INTEGER",
        "publisher_type": "TEXT NOT NULL DEFAULT 'unknown'",
        "company_industry": "TEXT NOT NULL DEFAULT ''",
        "company_size": "TEXT NOT NULL DEFAULT ''",
        "company_stage": "TEXT NOT NULL DEFAULT ''",
        "work_address": "TEXT NOT NULL DEFAULT ''",
        "metadata": "TEXT NOT NULL DEFAULT '{}'",
    }
    for name, declaration in additions.items():
        if name not in columns:
            conn.execute(f"ALTER TABLE jobs ADD COLUMN {name} {declaration}")


def _repair_legacy_field_semantics(conn: sqlite3.Connection) -> None:
    """Move page-level dates out of the job update field and remove known tag contamination."""
    rows = conn.execute(
        "SELECT id, source, update_time, relative_update_time, job_tags, metadata, first_seen_at FROM jobs"
    ).fetchall()
    for row in rows:
        try:
            metadata = json.loads(row["metadata"] or "{}")
        except json.JSONDecodeError:
            metadata = {}
        try:
            tags = json.loads(row["job_tags"] or "[]")
        except json.JSONDecodeError:
            tags = []
        old_update = row["update_time"] or ""
        update_time = old_update
        changed = False
        if row["source"] == "boss":
            if old_update:
                metadata.setdefault("page_updated_at", old_update)
                metadata["page_updated_at_semantics"] = "page_not_job"
                update_time = ""
                changed = True
            cleaned_tags = [tag for tag in tags if not re.search(r"许可证|认证资质", str(tag))]
            if cleaned_tags != tags:
                tags = cleaned_tags
                changed = True
        elif row["source"] == "liepin":
            if old_update:
                metadata.setdefault("page_updated_at", old_update)
                metadata["page_updated_at_semantics"] = "page_not_job"
            match = re.fullmatch(r"(\d{1,2})月(\d{1,2})日更新", row["relative_update_time"] or "")
            if match:
                observed = datetime.fromisoformat(row["first_seen_at"])
                year = observed.year
                candidate = datetime(year, int(match.group(1)), int(match.group(2)), tzinfo=observed.tzinfo)
                if (candidate - observed).days > 2:
                    year -= 1
                update_time = f"{year:04d}-{int(match.group(1)):02d}-{int(match.group(2)):02d}"
            else:
                update_time = ""
            changed = changed or update_time != old_update
        if changed:
            quality = metadata.setdefault("extraction_quality", {})
            quality.update({
                "rules_version": "field-quality-v1",
                "status": "warn",
                "warnings": sorted(set([*quality.get("warnings", []), "legacy_field_semantics_repaired"])),
                "errors": quality.get("errors", []),
            })
            conn.execute(
                "UPDATE jobs SET update_time=?, job_tags=?, metadata=? WHERE id=?",
                (update_time, json_text(tags), json_text(metadata), row["id"]),
            )


def _migrate_evaluation_audit_fields(conn: sqlite3.Connection) -> None:
    columns = {row["name"] for row in conn.execute("PRAGMA table_info(evaluations)").fetchall()}
    additions = {
        "provider": "TEXT NOT NULL DEFAULT ''",
        "model_name": "TEXT NOT NULL DEFAULT ''",
        "prompt_version": "TEXT NOT NULL DEFAULT ''",
        "profile_version": "TEXT NOT NULL DEFAULT ''",
        "job_content_hash": "TEXT NOT NULL DEFAULT ''",
        "input_hash": "TEXT NOT NULL DEFAULT ''",
        "confidence_score": "INTEGER",
        "dimension_scores": "TEXT NOT NULL DEFAULT '{}'",
        "raw_response": "TEXT NOT NULL DEFAULT '{}'",
        "prompt_tokens": "INTEGER",
        "completion_tokens": "INTEGER",
        "total_tokens": "INTEGER",
        "latency_ms": "INTEGER",
    }
    for name, declaration in additions.items():
        if name not in columns:
            conn.execute(f"ALTER TABLE evaluations ADD COLUMN {name} {declaration}")
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_evaluations_input_hash ON evaluations(input_hash, model_name) WHERE input_hash != ''"
    )


def _migrate_chat_storage(conn: sqlite3.Connection) -> None:
    """沟通记录存储：chat_messages 表 + applications 派生列（schema v11）。

    chat_messages 保存逐条消息事实；applications 上的派生列在抓取时更新，
    供前端过滤/排序。会话状态（unread/read_no_reply/replied）由 API 从
    chat_messages 实时推导，不物化，避免过期。
    """
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS chat_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
            direction TEXT NOT NULL CHECK (direction IN ('out', 'in', 'system')),
            content TEXT NOT NULL DEFAULT '',
            content_type TEXT NOT NULL DEFAULT 'text',
            sent_at TEXT NOT NULL DEFAULT '',
            read_status TEXT NOT NULL DEFAULT 'unknown'
                CHECK (read_status IN ('unread', 'read', 'unknown')),
            message_hash TEXT NOT NULL,
            raw TEXT NOT NULL DEFAULT '{}',
            collected_at TEXT NOT NULL,
            UNIQUE (job_id, message_hash)
        );
        CREATE INDEX IF NOT EXISTS idx_chat_messages_job_time
            ON chat_messages(job_id, sent_at, id);
    """)
    app_columns = {row["name"] for row in conn.execute("PRAGMA table_info(applications)")}
    additions = {
        "last_chat_at": "TEXT NOT NULL DEFAULT ''",
        "last_inbound_at": "TEXT NOT NULL DEFAULT ''",
        "outbound_read_status": "TEXT NOT NULL DEFAULT 'none'",
        "chat_synced_at": "TEXT NOT NULL DEFAULT ''",
        "apply_feedback": "TEXT NOT NULL DEFAULT ''",
        "apply_feedback_at": "TEXT NOT NULL DEFAULT ''",
        "chat_summary": "TEXT NOT NULL DEFAULT ''",
    }
    for name, declaration in additions.items():
        if name not in app_columns:
            conn.execute(f"ALTER TABLE applications ADD COLUMN {name} {declaration}")


def _migrate_reply_drafts(conn: sqlite3.Connection) -> None:
    """schema v15：新入站消息对应的 AI 回复草稿与人工处理状态。"""
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS reply_drafts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
            trigger_message_hash TEXT NOT NULL,
            trigger_content TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'sent', 'dismissed')),
            generation_status TEXT NOT NULL DEFAULT 'queued'
                CHECK (generation_status IN ('queued', 'completed', 'failed')),
            suggested_reply TEXT NOT NULL DEFAULT '',
            edited_reply TEXT NOT NULL DEFAULT '',
            rationale TEXT NOT NULL DEFAULT '',
            risk_flags TEXT NOT NULL DEFAULT '[]',
            model_name TEXT NOT NULL DEFAULT '',
            prompt_version TEXT NOT NULL DEFAULT '',
            error TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            sent_at TEXT NOT NULL DEFAULT '',
            UNIQUE(job_id, trigger_message_hash)
        );
        CREATE INDEX IF NOT EXISTS idx_reply_drafts_status_time
            ON reply_drafts(status, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_reply_drafts_job_time
            ON reply_drafts(job_id, created_at DESC);
    """)


def _migrate_automation_status(conn: sqlite3.Connection) -> None:
    """schema v16：本机浏览器执行器心跳、登录状态和短期二维码。"""
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS automation_status (
            platform TEXT PRIMARY KEY CHECK (platform IN ('boss', 'liepin')),
            status TEXT NOT NULL DEFAULT 'offline'
                CHECK (status IN ('online', 'sleeping', 'login_required', 'login_pending', 'offline', 'error')),
            message TEXT NOT NULL DEFAULT '',
            qr_image BLOB,
            qr_updated_at TEXT NOT NULL DEFAULT '',
            last_heartbeat_at TEXT NOT NULL DEFAULT '',
            last_success_at TEXT NOT NULL DEFAULT '',
            next_run_at TEXT NOT NULL DEFAULT '',
            metadata TEXT NOT NULL DEFAULT '{}',
            updated_at TEXT NOT NULL
        );
    """)


def _migrate_search_directions(conn: sqlite3.Connection) -> None:
    """Persist the retrieval strategy independently from model classification."""
    for table in ("search_runs", "job_discoveries", "screening_rejections"):
        columns = {row["name"] for row in conn.execute(f"PRAGMA table_info({table})")}
        if "search_direction" not in columns:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN search_direction TEXT NOT NULL DEFAULT ''")

    # Historical query-to-direction mappings are intentionally not inferred here;
    # direction IDs belong to each install's search-plan configuration.
    conn.execute(
        """UPDATE job_discoveries
              SET search_direction=COALESCE((SELECT r.search_direction FROM search_runs r
                                              WHERE r.id=job_discoveries.search_run_id), '')
            WHERE search_direction='' AND search_run_id IS NOT NULL"""
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_search_runs_direction_time ON search_runs(search_direction, started_at DESC)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_discoveries_direction_time ON job_discoveries(search_direction, discovered_at DESC)")


def _migrate_drop_dormant_columns(conn: sqlite3.Connection) -> None:
    """schema v10：删除已弃用的 availability_status 与 applications 休眠字段。

    DROP COLUMN 前必须先删依赖它们的索引；列级 CHECK 在 3.35+ 下不阻塞删除。
    """
    job_cols = {row["name"] for row in conn.execute("PRAGMA table_info(jobs)")}
    if "availability_status" in job_cols:
        conn.execute("DROP INDEX IF EXISTS idx_jobs_availability_updated")
        conn.execute("ALTER TABLE jobs DROP COLUMN availability_status")
    app_cols = {row["name"] for row in conn.execute("PRAGMA table_info(applications)")}
    # 先删依赖旧列的索引，再删列
    conn.execute("DROP INDEX IF EXISTS idx_applications_status_action")
    for column in ("resume_path", "applied_at", "next_action", "next_action_at"):
        if column in app_cols:
            conn.execute(f"ALTER TABLE applications DROP COLUMN {column}")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_applications_status ON applications(status)")


def init_db() -> None:
    with connect() as conn:
        conn.execute("PRAGMA journal_mode = WAL")
        conn.execute("PRAGMA synchronous = NORMAL")
        _migrate_prototype_v1(conn)
        conn.executescript(SCHEMA_SQL)
        _migrate_drop_dormant_columns(conn)
        _migrate_rich_job_fields(conn)
        _repair_legacy_field_semantics(conn)
        _migrate_evaluation_audit_fields(conn)
        _migrate_search_directions(conn)
        _migrate_chat_storage(conn)
        _migrate_reply_drafts(conn)
        _migrate_automation_status(conn)
        conn.execute(
            """INSERT INTO schema_meta(key, value) VALUES ('schema_version', ?)
               ON CONFLICT(key) DO UPDATE SET value=excluded.value""",
            (str(SCHEMA_VERSION),),
        )
        conn.execute("PRAGMA optimize")
