from fastapi import APIRouter
from fastapi import Request
from common import (
    APPLICATION_STATUSES,
    ApplicationPatch,
    DB_PATH,
    EVALUATION_INSERT,
    EvaluationInput,
    EvaluationQueueCreate,
    FUNNEL_STATUS_SQL,
    FileResponse,
    HTTPException,
    JOB_COUNT_FROM,
    JobFeedback,
    JobIngest,
    JobPatch,
    LATEST_JOB_SELECT,
    LoginRequest,
    Query,
    RESUMES_DIR,
    REVIEW_STATUSES,
    Response,
    SCHEMA_VERSION,
    STATIC_INDEX,
    _cached_dashboard,
    _count_group,
    _job_where,
    _resume_path,
    auth,
    canonicalize_url,
    configured_directions,
    connect,
    decode_json,
    enqueue_evaluation,
    evaluation_disabled_reason,
    evaluation_values,
    event,
    get_job_row,
    infer_source_job_id,
    invalidate_dashboard_cache,
    job_dict,
    json_text,
    list_job_projection,
    now,
    re,
    snapshot_hash,
    validate_direction,
)

router = APIRouter()

@router.get("/")
def root(request: Request):
    if STATIC_INDEX:
        # index.html 不缓存：保证每次加载拿到最新的资源哈希，避免部署后旧页面残留
        return FileResponse(STATIC_INDEX, headers={"Cache-Control": "no-cache"})
    return {
        "service": "job-tracker",
        "version": request.app.version,
        "schema_version": SCHEMA_VERSION,
        "database": str(DB_PATH),
        "auth_enabled": auth.auth_enabled(),
        "status": "ok",
    }


@router.get("/api/auth/status")
def auth_status():
    """登录页探测用：返回鉴权是否开启，不泄露任何凭据。"""
    return {"auth_enabled": auth.auth_enabled()}


@router.post("/api/auth/login")
def login(payload: LoginRequest, request: Request):
    if not auth.auth_enabled():
        raise HTTPException(status_code=403, detail="authentication is disabled")
    client_ip = request.client.host if request.client else "unknown"
    if auth.login_throttled(client_ip):
        raise HTTPException(status_code=429, detail="too many login attempts, try again later")
    if not auth.check_credentials(payload.password):
        auth.record_login_failure(client_ip)
        raise HTTPException(status_code=401, detail="invalid password")
    return {
        "token": auth.create_token(),
        "expires_in": auth.TOKEN_TTL_SECONDS,
    }


@router.get("/api/config")
def config():
    return {
        "review_statuses": REVIEW_STATUSES,
        "application_statuses": APPLICATION_STATUSES,
        "directions": configured_directions(),
        "evaluation_default_mode": "offpeak",
        "evaluation_auto_queue_new_jobs": True,
        "screening_before_evaluation": True,
    }


@router.post("/api/jobs/{job_id}/evaluation-queue")
def queue_job_evaluation(job_id: int, payload: EvaluationQueueCreate):
    if reason := evaluation_disabled_reason(): raise HTTPException(status_code=409, detail=reason)
    invalidate_dashboard_cache()
    stamp = now()
    with connect() as conn:
        if not conn.execute("SELECT 1 FROM jobs WHERE id=?", (job_id,)).fetchone():
            raise HTTPException(status_code=404, detail="Job not found")
        row = enqueue_evaluation(conn, job_id, payload.mode, "user", stamp)
        event(conn, job_id, "evaluation_queued", new_value=payload.mode, note="frontend request", actor="user", created_at=stamp)
    return dict(row)


@router.delete("/api/jobs/{job_id}/evaluation-queue")
def cancel_job_evaluation(job_id: int):
    invalidate_dashboard_cache()
    stamp = now()
    with connect() as conn:
        row = conn.execute(
            "SELECT * FROM evaluation_queue WHERE job_id=? AND status='queued' ORDER BY id DESC LIMIT 1",
            (job_id,),
        ).fetchone()
        if not row:
            raise HTTPException(status_code=409, detail="No queued evaluation can be cancelled")
        conn.execute("UPDATE evaluation_queue SET status='cancelled', finished_at=? WHERE id=?", (stamp, row["id"]))
        event(conn, job_id, "evaluation_queue_cancelled", old_value=row["mode"], actor="user", created_at=stamp)
        updated = conn.execute("SELECT * FROM evaluation_queue WHERE id=?", (row["id"],)).fetchone()
    return dict(updated)


@router.get("/api/jobs")
def list_jobs(
    response: Response,
    state: str | None = Query(None, description="岗位状态：not_started / applied_contacted / interview / rejected，逗号分隔可多选"),
    review_status: str | None = None,
    application_status: str | None = None,
    funnel_status: str | None = None,
    source: str | None = None,
    search_direction: str | None = None,
    evaluation_direction: str | None = None,
    direction: str | None = None,
    evaluation_status: str | None = None,
    rating_status: str | None = None,
    min_score: int = Query(0, ge=0, le=100),
    max_score: int | None = Query(None, ge=0, le=100, description="匹配分上限；与 min_score 构成区间。非平凡区间只作用于已评估岗位"),
    sort: str = Query("score_desc", pattern="^(score_desc|score_asc|manual_score_desc|manual_score_asc|updated_desc|updated_asc)$",
                      description="排序：score_desc AI评分高→低（默认，未评估排最后）/ score_asc AI评分低→高 / manual_score_desc 人工评分高→低 / manual_score_asc 人工评分低→高 / updated_desc 最新更新 / updated_asc 最早更新"),
    q: str = "",
    include_jd: bool = Query(False, description="列表响应是否携带完整 JD；默认不携带，展开卡片时按需拉取"),
    limit: int = Query(200, ge=1, le=1000),
    offset: int = Query(0, ge=0),
):
    requested_search_direction = search_direction or direction
    if requested_search_direction not in (None, "", "all", "unclassified"):
        validate_direction(requested_search_direction, "检索方向")
    if evaluation_direction not in (None, "", "all"):
        validate_direction(evaluation_direction, "评价方向")
    clause, params = _job_where(
        state=state, review_status=review_status,
        application_status=application_status, source=source,
        funnel_status=funnel_status,
        search_direction=search_direction or direction,
        evaluation_direction=evaluation_direction, evaluation_status=evaluation_status,
        rating_status=rating_status, min_score=min_score, max_score=max_score, q=q,
    )
    order_clause = {
        "score_desc": "ORDER BY e.relevance_score DESC NULLS LAST, j.updated_at DESC, j.id DESC",
        "score_asc": "ORDER BY e.relevance_score ASC NULLS LAST, j.updated_at DESC, j.id DESC",
        "manual_score_desc": "ORDER BY j.user_score DESC NULLS LAST, j.updated_at DESC, j.id DESC",
        "manual_score_asc": "ORDER BY j.user_score ASC NULLS LAST, j.updated_at DESC, j.id DESC",
        "updated_desc": "ORDER BY j.updated_at DESC, j.id DESC",
        "updated_asc": "ORDER BY j.updated_at ASC, j.id ASC",
    }[sort]
    with connect() as conn:
        total = conn.execute(
            f"SELECT COUNT(*) FROM ({LATEST_JOB_SELECT} {clause}) filtered_jobs",
            params,
        ).fetchone()[0]
        rows = conn.execute(
            f"{LATEST_JOB_SELECT} {clause} {order_clause} LIMIT ? OFFSET ?",
            [*params, limit, offset],
        ).fetchall()
    response.headers["X-Total-Count"] = str(total)
    result = [list_job_projection(job_dict(row)) for row in rows]
    if not include_jd:
        for item in result:
            item.pop("jd", None)
    return result


@router.get("/api/jobs/{job_id}")
def get_job(job_id: int):
    with connect() as conn:
        job = job_dict(get_job_row(conn, job_id))
        discoveries = [dict(row) for row in conn.execute(
            "SELECT * FROM job_discoveries WHERE job_id = ? ORDER BY discovered_at DESC, id DESC", (job_id,)
        ).fetchall()]
        snapshots = [dict(row) for row in conn.execute(
            "SELECT * FROM job_snapshots WHERE job_id = ? ORDER BY observed_at DESC, id DESC", (job_id,)
        ).fetchall()]
        evaluations = [dict(row) for row in conn.execute(
            "SELECT * FROM evaluations WHERE job_id = ? ORDER BY evaluated_at DESC, id DESC", (job_id,)
        ).fetchall()]
        events = [dict(row) for row in conn.execute(
            "SELECT * FROM job_events WHERE job_id = ? ORDER BY created_at DESC, id DESC", (job_id,)
        ).fetchall()]
    for snapshot in snapshots:
        snapshot["fields"] = decode_json(snapshot["fields"], {})
    for evaluation in evaluations:
        for key in ("match_evidence", "gaps", "hard_requirements", "filter_reasons"):
            evaluation[key] = decode_json(evaluation[key], [])
        for key in ("dimension_scores", "raw_response"):
            evaluation[key] = decode_json(evaluation.get(key), {})
        evaluation["needs_resume_tailoring"] = (
            None if evaluation["needs_resume_tailoring"] is None else bool(evaluation["needs_resume_tailoring"])
        )
    return {
        "job": job,
        "discoveries": discoveries,
        "snapshots": snapshots,
        "evaluations": evaluations,
        "events": events,
    }


@router.get("/api/resumes")
def list_resumes():
    """返回已上传定制简历的岗位 id 列表（供前端一次性拉取）。"""
    if not RESUMES_DIR.is_dir():
        return {"job_ids": []}
    job_ids = []
    try:
        for entry in RESUMES_DIR.iterdir():
            if entry.is_dir() and entry.name.isdigit() and (entry / "resume.pdf").is_file():
                job_ids.append(int(entry.name))
    except OSError:
        return {"job_ids": []}
    return {"job_ids": sorted(job_ids)}


@router.post("/api/jobs/{job_id}/resume")
async def upload_job_resume(job_id: int, request: Request):
    """上传岗位定制简历 PDF（请求体为原始 PDF 字节，Content-Type: application/pdf）。"""
    with connect() as conn:
        get_job_row(conn, job_id)  # 岗位不存在则 404
    data = await request.body()
    if not data:
        raise HTTPException(status_code=400, detail="empty body")
    if len(data) > 20 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="简历文件不能超过 20MB")
    if not data.startswith(b"%PDF-"):
        raise HTTPException(status_code=415, detail="只接受 PDF 文件")
    dest = _resume_path(job_id)
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(data)
    return {"job_id": job_id, "size": len(data)}


@router.get("/api/jobs/{job_id}/resume")
def get_job_resume(job_id: int):
    """返回岗位定制简历 PDF。"""
    dest = _resume_path(job_id)
    if not dest.is_file():
        raise HTTPException(status_code=404, detail="no resume for this job")
    return FileResponse(dest, media_type="application/pdf", filename=f"resume-{job_id}.pdf")


@router.get("/api/stats")
def stats(
    state: str | None = None,
    review_status: str | None = None,
    application_status: str | None = None,
    source: str | None = None,
    evaluation_status: str | None = None,
    rating_status: str | None = None,
    min_score: int = Query(0, ge=0, le=100),
    max_score: int | None = Query(None, ge=0, le=100),
    q: str = "",
):
    """侧栏交集计数：按当前筛选条件统计，每个分组去掉自身维度后再计数。"""
    def _produce():
        base = dict(
            state=state, review_status=review_status, application_status=application_status,
            source=source,
            evaluation_status=evaluation_status, rating_status=rating_status,
            min_score=min_score, max_score=max_score, q=q,
        )
        # 当前筛选总数（全部条件）
        clause, params = _job_where(**base)
        with connect() as conn:
            total = conn.execute(
                f"SELECT COUNT(*) FROM {JOB_COUNT_FROM} {clause}", params
            ).fetchone()[0]
            # 岗位状态分组：去掉 state 自身维度，再按各状态计数
            clause_s, params_s = _job_where(**{**base, "state": None})
            state_total = conn.execute(
                f"SELECT COUNT(*) FROM {JOB_COUNT_FROM} {clause_s}", params_s
            ).fetchone()[0]
            state_conds = {
                "not_started": "AND (a.status IS NULL OR a.status = 'not_started') AND j.review_status != 'rejected'",
                "applied_contacted": "AND a.status IN ('applied', 'contacted')",
                "interview": "AND a.status = 'interview'",
                "rejected": "AND j.review_status = 'rejected'",
            }
            base_where = clause_s or "WHERE 1=1"  # 无筛选时给 AND 条件一个落点
            state_statuses = {}
            for name, cond in state_conds.items():
                state_statuses[name] = conn.execute(
                    f"SELECT COUNT(*) FROM {JOB_COUNT_FROM} {base_where} {cond}", params_s
                ).fetchone()[0]
            # 漏斗计数：去掉漏斗自身维度，保留来源、搜索、评分等交集筛选。
            clause_f, params_f = _job_where(**{**base, "state": None, "funnel_status": None})
            funnel_where = clause_f or "WHERE 1=1"
            funnel_statuses = {
                status: conn.execute(
                    f"SELECT COUNT(*) FROM {JOB_COUNT_FROM} {funnel_where} AND ({FUNNEL_STATUS_SQL}) = ?",
                    [*params_f, status],
                ).fetchone()[0]
                for status in ("todo", "interested", "contacted", "interview", "offer", "closed", "excluded")
            }
            # 处理状态分组：去掉 review_status 自身维度
            clause_r, params_r = _job_where(**{**base, "review_status": None})
            review_total = conn.execute(
                f"SELECT COUNT(*) FROM {JOB_COUNT_FROM} {clause_r}", params_r
            ).fetchone()[0]
            review = _count_group(conn, "j.review_status", clause_r, params_r)
            # 投递进度分组：去掉 application_status 自身维度
            clause_a, params_a = _job_where(**{**base, "application_status": None})
            application_total = conn.execute(
                f"SELECT COUNT(*) FROM {JOB_COUNT_FROM} {clause_a}", params_a
            ).fetchone()[0]
            application = _count_group(conn, "COALESCE(a.status, 'not_started')", clause_a, params_a)
        for status in REVIEW_STATUSES:
            review.setdefault(status, 0)
        for status in APPLICATION_STATUSES:
            application.setdefault(status, 0)
        return {
            "total": total,
            "state_total": state_total,
            "state_statuses": state_statuses,
            "funnel_statuses": funnel_statuses,
            "review_total": review_total,
            "application_total": application_total,
            "review_statuses": review,
            "application_statuses": application,
        }
    key = f"stats|{state or '-'}|{review_status or '-'}|{application_status or '-'}|{source or '-'}|{evaluation_status or '-'}|{rating_status or '-'}|{min_score}|{max_score if max_score is not None else '-'}|{q.strip()}"
    return _cached_dashboard(key, _produce)


@router.get("/api/stats/score-bands")
def stats_score_bands():
    bands = [
        ("≥80", "e.relevance_score >= 80 AND e.relevance_score <= 100"),
        ("65–79", "e.relevance_score >= 65 AND e.relevance_score < 80"),
        ("45–64", "e.relevance_score >= 45 AND e.relevance_score < 65"),
        ("<45", "e.relevance_score >= 0 AND e.relevance_score < 45"),
        ("未评分", "e.relevance_score IS NULL"),
    ]
    rows = []
    with connect() as conn:
        for label, condition in bands:
            row = conn.execute(f"""SELECT COUNT(*) AS jobs,
                SUM(CASE WHEN a.status IN ('contacted','interview','offer') OR EXISTS (SELECT 1 FROM chat_messages cm WHERE cm.job_id=j.id) THEN 1 ELSE 0 END) AS contacted,
                SUM(CASE WHEN EXISTS (SELECT 1 FROM chat_messages cm WHERE cm.job_id=j.id AND cm.direction='in') THEN 1 ELSE 0 END) AS replied,
                SUM(CASE WHEN a.status IN ('interview','offer') THEN 1 ELSE 0 END) AS interview,
                SUM(CASE WHEN a.status='offer' THEN 1 ELSE 0 END) AS offer
                FROM jobs j
                LEFT JOIN evaluations e ON e.id=(SELECT e2.id FROM evaluations e2 WHERE e2.job_id=j.id ORDER BY e2.evaluated_at DESC,e2.id DESC LIMIT 1)
                LEFT JOIN applications a ON a.job_id=j.id WHERE {condition}""").fetchone()
            jobs = int(row["jobs"] or 0)
            item = {"band": label, "jobs": jobs}
            for key in ("contacted", "replied", "interview", "offer"):
                count = int(row[key] or 0)
                item[key] = count
                item[f"{key}_rate"] = round(count / jobs, 4) if jobs else 0
            rows.append(item)
    return {"bands": rows}


@router.post("/api/jobs")
def ingest_job(payload: JobIngest):
    if payload.evaluation and (reason := evaluation_disabled_reason()): raise HTTPException(status_code=409, detail=reason)
    if payload.discovery:
        validate_direction(payload.discovery.search_direction, "检索方向")
    if payload.evaluation:
        validate_direction(payload.evaluation.direction, "评价方向")
    invalidate_dashboard_cache()
    stamp = now()
    try:
        canonical_url = canonicalize_url(payload.url)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    source_job_id = payload.source_job_id or infer_source_job_id(payload.source, canonical_url)
    raw_fields = {
        "title": payload.title.strip(),
        "company": payload.company.strip(),
        "location": payload.location.strip(),
        "salary": payload.salary.strip(),
        "update_time": payload.update_time.strip(),
        "relative_update_time": payload.relative_update_time.strip(),
        "listing_status": payload.listing_status.strip(),
        "experience": payload.experience.strip(),
        "education": payload.education.strip(),
        "headcount": payload.headcount.strip(),
        "job_tags": None if payload.job_tags is None else json_text(payload.job_tags),
        "benefits": None if payload.benefits is None else json_text(payload.benefits),
        "recruiter_name": payload.recruiter_name.strip(),
        "recruiter_title": payload.recruiter_title.strip(),
        "recruiter_company": payload.recruiter_company.strip(),
        "recruiter_tags": None if payload.recruiter_tags is None else json_text(payload.recruiter_tags),
        "recruiter_activity": payload.recruiter_activity.strip(),
        "recruiter_verified": None if payload.recruiter_verified is None else int(payload.recruiter_verified),
        "publisher_type": payload.publisher_type,
        "company_industry": payload.company_industry.strip(),
        "company_size": payload.company_size.strip(),
        "company_stage": payload.company_stage.strip(),
        "work_address": payload.work_address.strip(),
        "metadata": None if payload.metadata is None else json_text(payload.metadata),
        "jd": payload.jd.strip(),
    }
    with connect() as conn:
        discovery_direction = payload.discovery.search_direction if payload.discovery else None
        if payload.discovery and payload.discovery.search_run_id is not None:
            search_run = conn.execute("SELECT * FROM search_runs WHERE id = ?", (payload.discovery.search_run_id,)).fetchone()
            if not search_run:
                raise HTTPException(status_code=422, detail="Search run not found")
            if search_run["source"] != payload.source:
                raise HTTPException(status_code=422, detail="Search run source does not match job source")
            if discovery_direction and discovery_direction != search_run["search_direction"]:
                raise HTTPException(status_code=422, detail="Discovery direction does not match search run")
            discovery_direction = search_run["search_direction"]
        if payload.discovery and not discovery_direction:
            raise HTTPException(status_code=422, detail="Discovery requires a search direction or a search run with one")

        existing = None
        if source_job_id:
            existing = conn.execute(
                "SELECT * FROM jobs WHERE source = ? AND source_job_id = ?", (payload.source, source_job_id)
            ).fetchone()
        if not existing:
            existing = conn.execute(
                "SELECT * FROM jobs WHERE source = ? AND canonical_url = ?", (payload.source, canonical_url)
            ).fetchone()

        is_new = existing is None
        if is_new:
            stored_fields = {
                key: ("[]" if key in {"job_tags", "benefits", "recruiter_tags"} and value is None
                      else "{}" if key == "metadata" and value is None
                      else "unknown" if key == "publisher_type" and value is None
                      else value)
                for key, value in raw_fields.items()
            }
        else:
            stored_fields = {
                key: (existing[key] if value is None or value == "" else value)
                for key, value in raw_fields.items()
            }
        content_hash = snapshot_hash(stored_fields)
        content_changed = is_new or existing["content_hash"] != content_hash
        if is_new:
            review_status = payload.review_status or "unreviewed"
            columns = ["source", "source_job_id", "canonical_url", "url", *stored_fields.keys(),
                       "content_hash", "review_status", "first_seen_at",
                       "last_seen_at", "last_checked_at", "updated_at"]
            values = [payload.source, source_job_id, canonical_url, payload.url, *stored_fields.values(),
                      content_hash, review_status, stamp, stamp, stamp, stamp]
            cursor = conn.execute(
                f"INSERT INTO jobs({', '.join(columns)}) VALUES ({', '.join('?' for _ in columns)})",
                values,
            )
            job_id = cursor.lastrowid
            event(conn, job_id, "created", new_value=review_status, note="browser ingest", actor="codex", created_at=stamp)
        else:
            job_id = existing["id"]
            review_status = payload.review_status or existing["review_status"]
            assignments = ", ".join(f"{key}=?" for key in stored_fields)
            conn.execute(
                f"""UPDATE jobs SET source_job_id=COALESCE(NULLIF(?, ''), source_job_id),
                    canonical_url=?, url=?, {assignments}, content_hash=?, review_status=?,
                    last_seen_at=?, last_checked_at=?, updated_at=? WHERE id=?""",
                (source_job_id, canonical_url, payload.url, *stored_fields.values(), content_hash,
                 review_status, stamp, stamp, stamp, job_id),
            )
            if existing["review_status"] != review_status:
                event(conn, job_id, "review_status_changed", existing["review_status"], review_status, "browser ingest", "codex", stamp)
            if existing["content_hash"] and existing["content_hash"] != content_hash:
                event(conn, job_id, "content_changed", existing["content_hash"], content_hash, "new page snapshot", "codex", stamp)

        conn.execute(
            "INSERT OR IGNORE INTO job_snapshots(job_id, content_hash, fields, observed_at) VALUES (?, ?, ?, ?)",
            (job_id, content_hash, json_text(stored_fields), stamp),
        )
        if payload.discovery:
            conn.execute(
                """INSERT OR IGNORE INTO job_discoveries(
                    job_id, search_run_id, source, keyword, search_direction,
                    search_page_url, result_position, discovered_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    job_id, payload.discovery.search_run_id, payload.source, payload.discovery.keyword,
                    discovery_direction, payload.discovery.search_page_url,
                    payload.discovery.result_position, stamp,
                ),
            )
        if payload.evaluation:
            conn.execute(EVALUATION_INSERT, evaluation_values(job_id, payload.evaluation, stamp))
            event(
                conn, job_id, "evaluated", new_value=payload.evaluation.relevance_score,
                note=payload.evaluation.strategy_version, actor=payload.evaluation.evaluator, created_at=stamp,
            )
        elif content_changed and stored_fields["jd"]:
            metadata = decode_json(stored_fields["metadata"], {})
            quality_status = metadata.get("extraction_quality", {}).get("status")
            screening_status = metadata.get("screening", {}).get("status")
            # 已关闭/暂停招聘/详情不可访问的岗位只用于挂沟通记录，不自动消耗评价额度
            closed = bool(re.search(r"关闭|暂停|下线|下架|失效|不可访问", raw_fields["listing_status"]))
            if quality_status != "reject" and screening_status != "reject" and review_status != "rejected" and not closed and not evaluation_disabled_reason():
                enqueue_evaluation(conn, job_id, "offpeak", "auto-ingest", stamp)
                event(
                    conn, job_id, "evaluation_queued", new_value="offpeak",
                    note="new or changed job content", actor="system", created_at=stamp,
                )
        row = get_job_row(conn, job_id)
    result = job_dict(row)
    result["is_new"] = is_new
    return result


@router.post("/api/jobs/{job_id}/evaluations")
def create_evaluation(job_id: int, payload: EvaluationInput):
    if reason := evaluation_disabled_reason(): raise HTTPException(status_code=409, detail=reason)
    validate_direction(payload.direction, "评价方向")
    invalidate_dashboard_cache()
    stamp = now()
    with connect() as conn:
        if not conn.execute("SELECT 1 FROM jobs WHERE id = ?", (job_id,)).fetchone():
            raise HTTPException(status_code=404, detail="Job not found")
        cursor = conn.execute(EVALUATION_INSERT, evaluation_values(job_id, payload, stamp))
        # 不刷新 jobs.updated_at：评价是自动行为，不应打乱列表排序
        event(conn, job_id, "evaluated", new_value=payload.relevance_score, note=payload.strategy_version, actor=payload.evaluator, created_at=stamp)
        row = conn.execute("SELECT * FROM evaluations WHERE id = ?", (cursor.lastrowid,)).fetchone()
    item = dict(row)
    for key in ("match_evidence", "gaps", "hard_requirements", "filter_reasons"):
        item[key] = decode_json(item[key], [])
    for key in ("dimension_scores", "raw_response"):
        item[key] = decode_json(item.get(key), {})
    item["needs_resume_tailoring"] = None if item["needs_resume_tailoring"] is None else bool(item["needs_resume_tailoring"])
    return item


@router.patch("/api/jobs/{job_id}")
def patch_job(job_id: int, payload: JobPatch):
    invalidate_dashboard_cache()
    changes = payload.model_dump(exclude_unset=True)
    if not changes:
        raise HTTPException(status_code=400, detail="No fields supplied")
    with connect() as conn:
        old = conn.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
        if not old:
            raise HTTPException(status_code=404, detail="Job not found")
        stamp = now()
        # chat_summary 属于 applications，先分离，不参与 jobs 更新
        chat_summary_value = changes.pop("chat_summary", None)
        # 用户编辑（评分/状态/备注/排除等）刷新 updated_at："最新更新"反映最近有动作的岗位
        changes["updated_at"] = stamp
        conn.execute(
            f"UPDATE jobs SET {', '.join(f'{key} = ?' for key in changes)} WHERE id = ?",
            [*changes.values(), job_id],
        )
        for field in ("review_status", "user_score", "user_notes"):
            if field in changes and changes[field] != old[field]:
                event(conn, job_id, f"{field}_changed", old[field], changes[field], "frontend update", "user", stamp)
        if chat_summary_value is not None:
            old_summary = conn.execute("SELECT chat_summary FROM applications WHERE job_id = ?", (job_id,)).fetchone()
            conn.execute("UPDATE applications SET chat_summary = ?, updated_at = ? WHERE job_id = ?",
                         (chat_summary_value, stamp, job_id))
            if old_summary and old_summary[0] != chat_summary_value:
                event(conn, job_id, "chat_summary_changed", old_summary[0], chat_summary_value, "frontend update", "user", stamp)
        row = get_job_row(conn, job_id)
    return job_dict(row)


@router.post("/api/jobs/{job_id}/feedback")
def feedback(job_id: int, payload: JobFeedback):
    return patch_job(job_id, JobPatch(user_score=payload.user_score, user_notes=payload.user_notes))


@router.patch("/api/jobs/{job_id}/application")
def patch_application(job_id: int, payload: ApplicationPatch):
    invalidate_dashboard_cache()
    changes = payload.model_dump(exclude_unset=True)
    if not changes:
        raise HTTPException(status_code=400, detail="No fields supplied")
    stamp = now()
    with connect() as conn:
        if not conn.execute("SELECT 1 FROM jobs WHERE id = ?", (job_id,)).fetchone():
            raise HTTPException(status_code=404, detail="Job not found")
        old = conn.execute("SELECT * FROM applications WHERE job_id = ?", (job_id,)).fetchone()
        if not old:
            defaults = {
                "status": "not_started", "notes": "",
            }
            defaults.update(changes)
            conn.execute(
                """INSERT INTO applications(job_id, status, notes, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?)""",
                (job_id, defaults["status"], defaults["notes"], stamp, stamp),
            )
            event(conn, job_id, "application_created", new_value=defaults["status"], actor="user", created_at=stamp)
        else:
            changes["updated_at"] = stamp
            conn.execute(
                f"UPDATE applications SET {', '.join(f'{key} = ?' for key in changes)} WHERE job_id = ?",
                [*changes.values(), job_id],
            )
            for field, value in changes.items():
                if field != "updated_at" and value != old[field]:
                    event(conn, job_id, f"application_{field}_changed", old[field], value, actor="user", created_at=stamp)
        conn.execute("UPDATE jobs SET updated_at = ? WHERE id = ?", (stamp, job_id))
        row = get_job_row(conn, job_id)
    return job_dict(row)
