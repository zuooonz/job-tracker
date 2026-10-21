from fastapi import APIRouter
from common import (
    ApplyRecordsInput,
    config_path,
    ChatImportInput,
    HTTPException,
    Query,
    REPLY_PROMPT_VERSION,
    ReplyDraftPatch,
    ReplyDraftUpsert,
    _refresh_chat_summary,
    asyncio,
    chat_state,
    chat_summary,
    connect,
    decode_json,
    event,
    get_job_row,
    hashlib,
    job_dict,
    json,
    json_text,
    now,
    re,
    redact_reply_input,
)
import common

router = APIRouter()

@router.post("/api/jobs/{job_id}/chat")
def import_job_chat(job_id: int, payload: ChatImportInput):
    """导入（覆盖式同步）岗位沟通记录。

    语义：每次抓取的结果是当前事实快照，**整岗位替换**旧记录——
    新抓取覆盖旧抓取（适配定期爬取更新）。事务内先删后插，避免半途状态。

    read_status 语义：out（我方发出）消息 = 对方是否已读；in（对方发出）消息 = 我是否已读。
    """
    stamp = now()
    with connect() as conn:
        if not conn.execute("SELECT 1 FROM jobs WHERE id = ?", (job_id,)).fetchone():
            raise HTTPException(status_code=404, detail="Job not found")
        old_rows = conn.execute(
            "SELECT message_hash FROM chat_messages WHERE job_id = ?", (job_id,)
        ).fetchall()
        old_hashes = {row["message_hash"] for row in old_rows}
        had_previous_messages = bool(old_hashes)
        # 覆盖式同步：同一岗位整批替换（事务）。投递反馈等系统记录由其他入口写入，
        # 聊天页抓不到它们，替换时保留，避免重抓聊天把反馈记录冲掉。
        conn.execute("DELETE FROM chat_messages WHERE job_id = ? AND direction != 'system'", (job_id,))
        imported = 0
        new_inbound: list[dict] = []
        for msg in payload.messages:
            if not msg.content:
                continue
            h = hashlib.sha256(
                f"{msg.direction}|{msg.sent_at}|{msg.content}".encode("utf-8")
            ).hexdigest()
            conn.execute(
                """INSERT OR IGNORE INTO chat_messages(
                       job_id, direction, content, content_type, sent_at, read_status,
                       message_hash, raw, collected_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (job_id, msg.direction, msg.content, msg.content_type, msg.sent_at,
                 msg.read_status, h, json_text(msg.raw), stamp),
            )
            imported += 1
            if msg.direction == "in" and h not in old_hashes:
                new_inbound.append({"message_hash": h, "content": msg.content, "sent_at": msg.sent_at})
        agg = conn.execute(
            """SELECT MAX(sent_at) AS last_chat,
                      MAX(CASE WHEN direction='in' THEN sent_at END) AS last_in,
                      (SELECT read_status FROM chat_messages c2
                        WHERE c2.job_id=? AND c2.direction='out'
                        ORDER BY c2.sent_at DESC, c2.id DESC LIMIT 1) AS out_read
                 FROM chat_messages WHERE job_id=?""",
            (job_id, job_id),
        ).fetchone()
        # 已有投递记录时不覆盖人工状态，只更新派生列；无记录则按 contacted 建档
        conn.execute(
            """INSERT INTO applications(job_id, status, created_at, updated_at)
               VALUES (?, 'contacted', ?, ?)
               ON CONFLICT(job_id) DO UPDATE SET updated_at=excluded.updated_at""",
            (job_id, stamp, stamp),
        )
        conn.execute(
            """UPDATE applications SET
                   last_chat_at=COALESCE(?, last_chat_at),
                   last_inbound_at=COALESCE(?, last_inbound_at),
                   outbound_read_status=COALESCE(?, 'none'),
                   chat_synced_at=?,
                   updated_at=?
               WHERE job_id=?""",
            (agg["last_chat"] or "", agg["last_in"] or "", agg["out_read"] or "none",
             stamp, stamp, job_id),
        )
        event(conn, job_id, "chat_synced", None, str(imported),
              note=f"沟通记录覆盖式同步：{imported} 条", actor="scraper")
        row = get_job_row(conn, job_id)
        item = job_dict(row)
        # 写回推导的沟通总结（独立存储，供前端并入备注；不触碰人工 notes）
        conn.execute(
            "UPDATE applications SET chat_summary=? WHERE job_id=?",
            (chat_summary(item), job_id),
        )
    return {
        "imported": imported,
        "chat_state": chat_state(item),
        "chat_summary": chat_summary(item),
        "message_count": item["chat_message_count"],
        "chat_synced_at": item["chat_synced_at"],
        "last_chat_at": item["chat_last_at"],
        "last_inbound_at": item["chat_last_inbound_at"],
        "outbound_read_status": item["chat_outbound_read_status"],
        # 只报告变化，不自动创建或生成回复。回复由岗位卡片中的人工操作触发。
        "new_inbound": new_inbound if had_previous_messages else [],
    }


@router.post("/api/jobs/{job_id}/chat-sync-touch")
def touch_job_chat_sync(job_id: int, payload: dict | None = None):
    """记录已成功检查聊天 UI，但不覆盖或删除既有消息。"""
    stamp = now()
    data = payload or {}
    outcome = str(data.get("outcome") or "checked")[:80]
    source = str(data.get("source") or "")[:30]
    with connect() as conn:
        if not conn.execute("SELECT 1 FROM jobs WHERE id = ?", (job_id,)).fetchone():
            raise HTTPException(status_code=404, detail="Job not found")
        conn.execute(
            """INSERT INTO applications(job_id, status, created_at, updated_at)
               VALUES (?, 'contacted', ?, ?)
               ON CONFLICT(job_id) DO UPDATE SET
                   chat_synced_at=excluded.updated_at,
                   updated_at=excluded.updated_at""",
            (job_id, stamp, stamp),
        )
        # INSERT 新建时上面的 chat_synced_at 没有列值，显式统一写入。
        conn.execute(
            "UPDATE applications SET chat_synced_at=?, updated_at=? WHERE job_id=?",
            (stamp, stamp, job_id),
        )
        event(conn, job_id, "chat_sync_checked", None, outcome,
              note=f"沟通页面已检查（{source or 'unknown'}），未覆盖既有消息", actor="scraper")
        count = conn.execute(
            "SELECT COUNT(*) AS n FROM chat_messages WHERE job_id=?", (job_id,)
        ).fetchone()["n"]
    return {"job_id": job_id, "chat_synced_at": stamp, "message_count": count,
            "imported": 0, "outcome": outcome}


@router.post("/api/jobs/{job_id}/chat-append")
def append_job_chat(job_id: int, payload: ChatImportInput):
    """非破坏性合并沟通记录；可区分列表快照与完整历史检查。"""
    stamp = now()
    with connect() as conn:
        if not conn.execute("SELECT 1 FROM jobs WHERE id = ?", (job_id,)).fetchone():
            raise HTTPException(status_code=404, detail="Job not found")
        imported = 0
        for msg in payload.messages:
            if not msg.content:
                continue
            # 列表快照的精确毫秒时间与详情页相对时间可能不同；同岗位、同方向、同正文
            # 已存在时视为同一条最新消息，避免仅因时间格式差异重复追加。
            if conn.execute(
                """SELECT 1 FROM chat_messages
                    WHERE job_id=? AND direction=? AND content=? LIMIT 1""",
                (job_id, msg.direction, msg.content),
            ).fetchone():
                continue
            h = hashlib.sha256(
                f"{msg.direction}|{msg.sent_at}|{msg.content}".encode("utf-8")
            ).hexdigest()
            cursor = conn.execute(
                """INSERT OR IGNORE INTO chat_messages(
                       job_id, direction, content, content_type, sent_at, read_status,
                       message_hash, raw, collected_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (job_id, msg.direction, msg.content, msg.content_type, msg.sent_at,
                 msg.read_status, h, json_text(msg.raw), stamp),
            )
            imported += cursor.rowcount
        agg = conn.execute(
            """SELECT MAX(sent_at) AS last_chat,
                      MAX(CASE WHEN direction='in' THEN sent_at END) AS last_in,
                      (SELECT read_status FROM chat_messages c2
                        WHERE c2.job_id=? AND c2.direction='out'
                        ORDER BY c2.sent_at DESC, c2.id DESC LIMIT 1) AS out_read
                 FROM chat_messages WHERE job_id=?""",
            (job_id, job_id),
        ).fetchone()
        conn.execute(
            """INSERT INTO applications(job_id, status, created_at, updated_at)
               VALUES (?, 'contacted', ?, ?)
               ON CONFLICT(job_id) DO UPDATE SET updated_at=excluded.updated_at""",
            (job_id, stamp, stamp),
        )
        conn.execute(
            """UPDATE applications SET last_chat_at=COALESCE(?, last_chat_at),
                   last_inbound_at=COALESCE(?, last_inbound_at),
                   outbound_read_status=COALESCE(?, outbound_read_status),
                   chat_synced_at=?, updated_at=? WHERE job_id=?""",
            (agg["last_chat"] or "", agg["last_in"] or "", agg["out_read"] or "none",
             stamp, stamp, job_id),
        )
        if payload.sync_kind == "full_history":
            # 即使没有新消息，也保留一次完整历史成功检查的事实；断点文件会
            # 避免同一轮任务重复制造事件。
            event(conn, job_id, "chat_full_history_synced", None, str(imported),
                  note=f"沟通完整历史非破坏性合并：新增 {imported} 条", actor="scraper")
        elif imported:
            # 列表快照没有变化时不写审计事件，避免高频监测污染 job_events。
            event(conn, job_id, "chat_snapshot_appended", None, str(imported),
                  note=f"沟通列表最新消息增量：{imported} 条", actor="scraper")
        row = get_job_row(conn, job_id)
        item = job_dict(row)
        conn.execute("UPDATE applications SET chat_summary=? WHERE job_id=?",
                     (chat_summary(item), job_id))
    return {"job_id": job_id, "imported": imported,
            "message_count": item["chat_message_count"],
            "chat_state": chat_state(item), "chat_synced_at": item["chat_synced_at"]}


@router.get("/api/communication/inbox")
def communication_inbox(status: str = "pending", limit: int = Query(100, ge=1, le=500)):
    if status not in {"pending", "sent", "dismissed", "all"}:
        raise HTTPException(status_code=400, detail="Invalid draft status")
    where = "" if status == "all" else "WHERE d.status = ?"
    params: list[object] = [] if status == "all" else [status]
    params.append(limit)
    with connect() as conn:
        rows = conn.execute(
            f"""SELECT d.*, j.title, j.company, j.source, j.url, j.salary,
                       a.status AS application_status,
                       (SELECT cm.content FROM chat_messages cm
                         WHERE cm.job_id=d.job_id AND cm.direction='in'
                         ORDER BY cm.sent_at DESC, cm.id DESC LIMIT 1) AS latest_inbound,
                       (SELECT cm.sent_at FROM chat_messages cm
                         WHERE cm.job_id=d.job_id AND cm.direction='in'
                         ORDER BY cm.sent_at DESC, cm.id DESC LIMIT 1) AS latest_inbound_at
                  FROM reply_drafts d
                  JOIN jobs j ON j.id=d.job_id
                  LEFT JOIN applications a ON a.job_id=d.job_id
                  {where}
                 ORDER BY d.created_at DESC LIMIT ?""",
            params,
        ).fetchall()
    result = []
    for row in rows:
        item = dict(row)
        item["risk_flags"] = decode_json(item.get("risk_flags"), [])
        result.append(item)
    return result


@router.post("/api/reply-drafts")
def upsert_reply_draft(payload: ReplyDraftUpsert):
    stamp = now()
    with connect() as conn:
        if not conn.execute("SELECT 1 FROM jobs WHERE id=?", (payload.job_id,)).fetchone():
            raise HTTPException(status_code=404, detail="Job not found")
        conn.execute(
            """INSERT INTO reply_drafts(
                   job_id, trigger_message_hash, trigger_content, generation_status,
                   suggested_reply, edited_reply, rationale, risk_flags,
                   model_name, prompt_version, error, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(job_id, trigger_message_hash) DO UPDATE SET
                   trigger_content=excluded.trigger_content,
                   generation_status=excluded.generation_status,
                   suggested_reply=excluded.suggested_reply,
                   edited_reply=CASE WHEN reply_drafts.edited_reply='' THEN excluded.edited_reply ELSE reply_drafts.edited_reply END,
                   rationale=excluded.rationale, risk_flags=excluded.risk_flags,
                   model_name=excluded.model_name, prompt_version=excluded.prompt_version,
                   error=excluded.error, updated_at=excluded.updated_at""",
            (payload.job_id, payload.trigger_message_hash, payload.trigger_content,
             payload.generation_status, payload.suggested_reply, payload.edited_reply,
             payload.rationale, json_text(payload.risk_flags), payload.model_name,
             payload.prompt_version, payload.error, stamp, stamp),
        )
        row = conn.execute(
            "SELECT * FROM reply_drafts WHERE job_id=? AND trigger_message_hash=?",
            (payload.job_id, payload.trigger_message_hash),
        ).fetchone()
    item = dict(row)
    item["risk_flags"] = decode_json(item.get("risk_flags"), [])
    return item


@router.patch("/api/reply-drafts/{draft_id}")
def patch_reply_draft(draft_id: int, payload: ReplyDraftPatch):
    changes = payload.model_dump(exclude_unset=True)
    if not changes:
        raise HTTPException(status_code=400, detail="No fields supplied")
    stamp = now()
    if changes.get("status") == "sent":
        changes["sent_at"] = stamp
    changes["updated_at"] = stamp
    with connect() as conn:
        old = conn.execute("SELECT * FROM reply_drafts WHERE id=?", (draft_id,)).fetchone()
        if not old:
            raise HTTPException(status_code=404, detail="Draft not found")
        conn.execute(
            f"UPDATE reply_drafts SET {', '.join(f'{key}=?' for key in changes)} WHERE id=?",
            [*changes.values(), draft_id],
        )
        row = conn.execute("SELECT * FROM reply_drafts WHERE id=?", (draft_id,)).fetchone()
        event(conn, row["job_id"], "reply_draft_updated", old["status"], row["status"],
              note="人工编辑/确认回复草稿", actor="user", created_at=stamp)
    item = dict(row)
    item["risk_flags"] = decode_json(item.get("risk_flags"), [])
    return item


@router.post("/api/reply-drafts/{draft_id}/retry")
def retry_reply_draft(draft_id: int):
    stamp = now()
    with connect() as conn:
        row = conn.execute("SELECT * FROM reply_drafts WHERE id=?", (draft_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Draft not found")
        if row["status"] != "pending":
            raise HTTPException(status_code=409, detail="Only pending drafts can be retried")
        conn.execute(
            """UPDATE reply_drafts
                  SET generation_status='queued', error='', updated_at=?
                WHERE id=?""",
            (stamp, draft_id),
        )
        updated = conn.execute("SELECT * FROM reply_drafts WHERE id=?", (draft_id,)).fetchone()
    item = dict(updated)
    item["risk_flags"] = decode_json(item.get("risk_flags"), [])
    return item


@router.post("/api/apply-records/import")
def import_apply_records(payload: ApplyRecordsInput):
    """导入猎聘「我的投递」反馈记录（c.liepin.com/job/record/apply）。

    通过岗位链接（/job/{id}.shtml 或 /a/{id}.shtml）匹配数据库岗位，
    更新 applications.apply_feedback，并写入一条 system 聊天消息（去重）。
    """
    stamp = now()
    matched: list[dict] = []
    unmatched: list[dict] = []
    with connect() as conn:
        for rec in payload.records:
            if not rec.url:
                unmatched.append({"url": rec.url, "title": rec.title, "feedback": rec.feedback, "feedback_at": rec.feedback_at, "reason": "empty url"})
                continue
            m = re.search(r"/(?:job|a)/(\d+)\.shtml", rec.url)
            if not m:
                unmatched.append({"url": rec.url, "title": rec.title, "feedback": rec.feedback, "feedback_at": rec.feedback_at, "reason": "no liepin id"})
                continue
            jid = m.group(1)
            row = conn.execute(
                """SELECT id FROM jobs
                   WHERE canonical_url IN (?, ?)
                      OR source_job_id IN (?, ?)
                      OR url LIKE ? OR url LIKE ?
                   LIMIT 1""",
                (f"https://www.liepin.com/job/{jid}.shtml", f"https://www.liepin.com/a/{jid}.shtml",
                 f"job:{jid}", f"a:{jid}", f"%/job/{jid}.shtml%", f"%/a/{jid}.shtml%"),
            ).fetchone()
            if not row:
                unmatched.append({"url": rec.url, "title": rec.title, "feedback": rec.feedback, "feedback_at": rec.feedback_at, "reason": "no matching job"})
                continue
            job_id = row["id"]
            feedback = (rec.feedback or "").strip()
            at = (rec.feedback_at or "").strip()
            conn.execute(
                """INSERT INTO applications(job_id, status, created_at, updated_at)
                   VALUES (?, 'applied', ?, ?)
                   ON CONFLICT(job_id) DO UPDATE SET updated_at=excluded.updated_at""",
                (job_id, stamp, stamp),
            )
            conn.execute(
                "UPDATE applications SET apply_feedback=?, apply_feedback_at=?, updated_at=? WHERE job_id=?",
                (feedback, at, stamp, job_id),
            )
            _refresh_chat_summary(conn, job_id, stamp)
            if feedback:
                content = f"[投递反馈] {feedback}" + (f"（{at}）" if at else "")
                h = hashlib.sha256(f"system|{at}|{content}".encode("utf-8")).hexdigest()
                conn.execute(
                    """INSERT OR IGNORE INTO chat_messages(
                           job_id, direction, content, content_type, sent_at, read_status,
                           message_hash, raw, collected_at)
                       VALUES (?, 'system', ?, 'feedback', ?, 'unknown', ?, '{}', ?)""",
                    (job_id, content, at or stamp, h, stamp),
                )
            event(conn, job_id, "apply_feedback", None, feedback,
                  note=f"投递反馈：{feedback}", actor="scraper")
            matched.append({"job_id": job_id, "url": rec.url, "title": rec.title, "feedback": feedback})
    return {"matched": matched, "unmatched": unmatched,
            "matched_count": len(matched), "unmatched_count": len(unmatched)}


@router.get("/api/chat-sync/targets")
def chat_sync_targets(source: str | None = None):
    """定期沟通抓取的岗位目标列表：有投递/沟通记录且状态为进行中的岗位。

    已明确结案的岗位跳过（供 chat-sync 使用）：
      - 投递反馈为终态（不合适/已拒绝/已关闭/已下线等）
      - 投递状态为 closed
      - 对方消息中已明确给出不合适/不匹配/已招满等结论
      - 岗位已关闭（listing_status）或已人工排除（review_status=rejected）
    """
    params: list[object] = []
    where = "a.status IN ('applied', 'contacted', 'interview', 'offer')"
    where += """ AND COALESCE(a.apply_feedback, '') NOT IN
        ('不合适', '暂不合适', '已拒绝', '已结束', '已关闭', '已下线', '岗位已关闭')"""
    where += """ AND COALESCE(j.listing_status, '') NOT IN ('已关闭', '已下线', '已失效', '已下架')"""
    where += """ AND j.review_status != 'rejected'"""
    where += """ AND NOT EXISTS (
        SELECT 1 FROM chat_messages c
         WHERE c.job_id = a.job_id AND c.direction = 'in' AND (
               c.content LIKE '%没有特别适合%' OR c.content LIKE '%暂时没有%'
            OR c.content LIKE '%不合适%' OR c.content LIKE '%不太合适%'
            OR c.content LIKE '%不匹配%' OR c.content LIKE '%不考虑%'
            OR c.content LIKE '%已招满%' OR c.content LIKE '%已关闭%'
            OR c.content LIKE '%暂停招聘%' OR c.content LIKE '%没有符合%'
            OR c.content LIKE '%目标画像%' OR c.content LIKE '%与岗位%不符%'
            OR c.content LIKE '%与您的期望%不符%'))"""
    if source:
        where += " AND j.source = ?"
        params.append(source)
    with connect() as conn:
        rows = conn.execute(
            f"""SELECT a.job_id AS job_id, j.source, j.url, a.status AS application_status,
                       a.chat_synced_at, a.apply_feedback,
                       (SELECT MAX(e.created_at) FROM job_events e
                         WHERE e.job_id=a.job_id
                           AND e.event_type IN ('chat_synced', 'chat_sync_checked', 'chat_full_history_synced')) AS full_chat_synced_at
                FROM applications a JOIN jobs j ON j.id = a.job_id
                WHERE {where}
                ORDER BY a.updated_at DESC""",
            params,
        ).fetchall()
    return [dict(r) for r in rows]


@router.get("/api/jobs/{job_id}/chat")
def get_job_chat(job_id: int, limit: int = Query(500, ge=1, le=2000)):
    """读取岗位沟通记录（前端展开沟通记录区用）。"""
    with connect() as conn:
        if not conn.execute("SELECT 1 FROM jobs WHERE id = ?", (job_id,)).fetchone():
            raise HTTPException(status_code=404, detail="Job not found")
        rows = conn.execute(
            """SELECT id, direction, content, content_type, sent_at, read_status, collected_at
               FROM chat_messages WHERE job_id = ?
               ORDER BY sent_at, id LIMIT ?""",
            (job_id, limit),
        ).fetchall()
        row = get_job_row(conn, job_id)
        draft = conn.execute(
            """SELECT * FROM reply_drafts WHERE job_id=?
                 ORDER BY updated_at DESC, id DESC LIMIT 1""",
            (job_id,),
        ).fetchone()
    item = job_dict(row)
    draft_item = dict(draft) if draft else None
    if draft_item:
        draft_item["risk_flags"] = decode_json(draft_item.get("risk_flags"), [])
    return {
        "job_id": job_id,
        "chat_state": chat_state(item),
        "chat_summary": chat_summary(item),
        "chat_synced_at": item["chat_synced_at"],
        "messages": [dict(r) for r in rows],
        "reply_draft": draft_item,
    }


@router.post("/api/jobs/{job_id}/reply-draft/generate")
async def generate_job_reply_draft(job_id: int):
    """用户在沟通区明确点击后，才基于最新入站消息生成一份回复建议。"""
    with connect() as conn:
        row = get_job_row(conn, job_id)
        if row is None:
            raise HTTPException(status_code=404, detail="Job not found")
        inbound = conn.execute(
            """SELECT message_hash, content, sent_at FROM chat_messages
                 WHERE job_id=? AND direction='in'
                 ORDER BY sent_at DESC, id DESC LIMIT 1""",
            (job_id,),
        ).fetchone()
        if inbound is None:
            raise HTTPException(status_code=409, detail="没有招聘方消息可供回复")
        messages = conn.execute(
            """SELECT direction, content, sent_at FROM chat_messages
                 WHERE job_id=? ORDER BY sent_at DESC, id DESC LIMIT 20""",
            (job_id,),
        ).fetchall()
    job = job_dict(row)
    try:
        profile = json.loads(config_path("candidate-profile-v2.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise HTTPException(status_code=503, detail="候选人资料配置不可用") from error
    input_data = {
        "candidate": {
            "positioning": profile.get("positioning"),
            "education": profile.get("education"),
            "verified_evidence": profile.get("verified_evidence"),
            "evidence_boundaries": profile.get("evidence_boundaries"),
        },
        "job": {
            "id": job["id"], "title": job.get("title"), "company": job.get("company"),
            "salary": job.get("salary"), "experience": job.get("experience"),
            "education": job.get("education"),
            "description": redact_reply_input(job.get("jd", ""))[:6000],
            "evaluation_summary": job.get("summary", ""),
            "known_gaps": job.get("gaps", []),
        },
        "conversation": [
            {
                "direction": message["direction"], "time": message["sent_at"],
                "content": redact_reply_input(message["content"])[:600],
            }
            for message in reversed(messages)
        ],
        "latest_inbound": redact_reply_input(inbound["content"]),
    }
    try:
        result, model = await asyncio.to_thread(common.call_reply_model, input_data)
    except (RuntimeError, ValueError, json.JSONDecodeError, OSError) as error:
        raise HTTPException(status_code=502, detail=str(error)[:300]) from error
    should_reply = result.get("should_reply") is not False and bool(str(result.get("reply", "")).strip())
    suggested = str(result.get("reply", "")).strip() if should_reply else ""
    rationale = str(result.get("rationale") or ("" if should_reply else "该消息无需回复")).strip()
    risk_flags = [str(value) for value in result.get("risk_flags", [])][:5] \
        if isinstance(result.get("risk_flags"), list) else []
    if not should_reply:
        risk_flags.insert(0, "模型判断该消息无需回复，请人工确认")
    stamp = now()
    with connect() as conn:
        conn.execute(
            """INSERT INTO reply_drafts(
                   job_id, trigger_message_hash, trigger_content, status, generation_status,
                   suggested_reply, edited_reply, rationale, risk_flags,
                   model_name, prompt_version, error, created_at, updated_at)
               VALUES (?, ?, ?, 'pending', 'completed', ?, ?, ?, ?, ?, ?, '', ?, ?)
               ON CONFLICT(job_id, trigger_message_hash) DO UPDATE SET
                   status='pending', generation_status='completed',
                   trigger_content=excluded.trigger_content,
                   suggested_reply=excluded.suggested_reply, edited_reply=excluded.edited_reply,
                   rationale=excluded.rationale, risk_flags=excluded.risk_flags,
                   model_name=excluded.model_name, prompt_version=excluded.prompt_version,
                   error='', updated_at=excluded.updated_at""",
            (job_id, inbound["message_hash"], inbound["content"], suggested, suggested,
             rationale, json_text(risk_flags), model, REPLY_PROMPT_VERSION, stamp, stamp),
        )
        stored = conn.execute(
            "SELECT * FROM reply_drafts WHERE job_id=? AND trigger_message_hash=?",
            (job_id, inbound["message_hash"]),
        ).fetchone()
        event(conn, job_id, "reply_draft_generated", None, str(stored["id"]),
              note="用户按需生成回复建议", actor="user", created_at=stamp)
    item = dict(stored)
    item["risk_flags"] = decode_json(item.get("risk_flags"), [])
    return item
