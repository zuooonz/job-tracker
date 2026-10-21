from fastapi import APIRouter
from common import (
    EvaluationQueueClaim,
    EvaluationQueueFinish,
    HTTPException,
    PROJECT_ROOT,
    Query,
    ScreeningRejectionInput,
    SearchRunCreate,
    SearchRunFinish,
    _cached_dashboard,
    _panel_task_snapshot,
    _panel_tasks,
    _task_lock,
    canonicalize_url,
    connect,
    datetime,
    decode_json,
    evaluation_disabled_reason,
    evaluation_schedule,
    event,
    infer_source_job_id,
    invalidate_dashboard_cache,
    json,
    json_text,
    now,
    os,
    signal,
    subprocess,
    time_module,
    timedelta,
    validate_direction,
)
from routers.automation import get_automation_budget

router = APIRouter()

@router.get("/api/evaluation-schedule")
def get_evaluation_schedule():
    def _produce():
        schedule = evaluation_schedule()
        with connect() as conn:
            rows = conn.execute(
                "SELECT status, COUNT(*) count FROM evaluation_queue GROUP BY status"
            ).fetchall()
        schedule["queue_counts"] = {row["status"]: row["count"] for row in rows}
        return schedule
    return _cached_dashboard("schedule", _produce)


@router.get("/api/screening-rejections")
def list_screening_rejections(source: str | None = None, limit: int = Query(5000, ge=1, le=10000)):
    where = "WHERE source=?" if source else ""
    params = (source, limit) if source else (limit,)
    with connect() as conn:
        rows = conn.execute(
            f"SELECT * FROM screening_rejections {where} ORDER BY last_seen_at DESC, id DESC LIMIT ?",
            params,
        ).fetchall()
    result = []
    for row in rows:
        item = dict(row)
        item["reasons"] = decode_json(item["reasons"], [])
        result.append(item)
    return result


@router.post("/api/screening-rejections")
def record_screening_rejection(payload: ScreeningRejectionInput):
    validate_direction(payload.search_direction, "检索方向")
    invalidate_dashboard_cache()
    stamp = now()
    try:
        canonical_url = canonicalize_url(payload.url)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    source_job_id = payload.source_job_id or infer_source_job_id(payload.source, canonical_url)
    with connect() as conn:
        search_direction = payload.search_direction or ""
        if payload.search_run_id is not None:
            run = conn.execute("SELECT source, search_direction FROM search_runs WHERE id=?", (payload.search_run_id,)).fetchone()
            if not run or run["source"] != payload.source:
                raise HTTPException(status_code=422, detail="Search run does not exist or source does not match")
            if search_direction and search_direction != run["search_direction"]:
                raise HTTPException(status_code=422, detail="Search direction does not match search run")
            search_direction = run["search_direction"]
        conn.execute(
            """INSERT INTO screening_rejections(
                   source, source_job_id, canonical_url, url, title, company, location, salary,
                   reasons, rules_version, search_run_id, keyword, search_direction, search_page_url, result_position,
                   first_seen_at, last_seen_at, seen_count
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
               ON CONFLICT(source, canonical_url) DO UPDATE SET
                   source_job_id=COALESCE(excluded.source_job_id, screening_rejections.source_job_id),
                   url=excluded.url, title=excluded.title, company=excluded.company,
                   location=excluded.location, salary=excluded.salary, reasons=excluded.reasons,
                   rules_version=excluded.rules_version, search_run_id=excluded.search_run_id,
                   keyword=excluded.keyword, search_direction=excluded.search_direction,
                   search_page_url=excluded.search_page_url,
                   result_position=excluded.result_position, last_seen_at=excluded.last_seen_at,
                   seen_count=screening_rejections.seen_count+1""",
            (
                payload.source, source_job_id, canonical_url, payload.url, payload.title.strip(),
                payload.company.strip(), payload.location.strip(), payload.salary.strip(),
                json_text(payload.reasons), payload.rules_version, payload.search_run_id,
                payload.keyword, search_direction, payload.search_page_url, payload.result_position, stamp, stamp,
            ),
        )
        row = conn.execute(
            "SELECT * FROM screening_rejections WHERE source=? AND canonical_url=?",
            (payload.source, canonical_url),
        ).fetchone()
    item = dict(row)
    item["reasons"] = decode_json(item["reasons"], [])
    return item


@router.post("/api/evaluation-queue/claim")
def claim_evaluation(payload: EvaluationQueueClaim):
    if evaluation_disabled_reason(): return None
    invalidate_dashboard_cache()
    stamp = now()
    stale_before = (datetime.now().astimezone() - timedelta(minutes=10)).isoformat(timespec="seconds")
    with connect() as conn:
        conn.execute("BEGIN IMMEDIATE")
        conn.execute(
            """UPDATE evaluation_queue
                  SET status='queued', started_at=NULL, error='worker interrupted; automatically requeued'
                WHERE status='running' AND started_at < ?""",
            (stale_before,),
        )
        where = "status='queued'" if payload.allow_offpeak else "status='queued' AND mode='immediate'"
        row = conn.execute(
            f"""SELECT * FROM evaluation_queue WHERE {where}
                ORDER BY CASE mode WHEN 'immediate' THEN 0 ELSE 1 END, requested_at, id LIMIT 1"""
        ).fetchone()
        if not row:
            return None
        updated = conn.execute(
            """UPDATE evaluation_queue SET status='running', started_at=?, attempts=attempts+1, error=''
               WHERE id=? AND status='queued'""",
            (stamp, row["id"]),
        )
        if updated.rowcount != 1:
            return None
        claimed = conn.execute("SELECT * FROM evaluation_queue WHERE id=?", (row["id"],)).fetchone()
        event(conn, row["job_id"], "evaluation_started", new_value=payload.worker_id, actor="system", created_at=stamp)
    return dict(claimed)


@router.patch("/api/evaluation-queue/{queue_id}")
def finish_evaluation_queue(queue_id: int, payload: EvaluationQueueFinish):
    invalidate_dashboard_cache()
    stamp = now()
    with connect() as conn:
        row = conn.execute("SELECT * FROM evaluation_queue WHERE id=?", (queue_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Evaluation queue item not found")
        if row["status"] != "running":
            raise HTTPException(status_code=409, detail="Evaluation queue item is not running")
        if payload.evaluation_id is not None and not conn.execute(
            "SELECT 1 FROM evaluations WHERE id=? AND job_id=?", (payload.evaluation_id, row["job_id"])
        ).fetchone():
            raise HTTPException(status_code=422, detail="Evaluation does not belong to queued job")
        error = payload.error.strip()[:1000] if payload.status == "failed" else ""
        conn.execute(
            "UPDATE evaluation_queue SET status=?, evaluation_id=?, error=?, finished_at=? WHERE id=?",
            (payload.status, payload.evaluation_id, error, stamp, queue_id),
        )
        event(
            conn, row["job_id"], f"evaluation_{payload.status}",
            new_value=payload.evaluation_id, note=error, actor="system", created_at=stamp,
        )
        updated = conn.execute("SELECT * FROM evaluation_queue WHERE id=?", (queue_id,)).fetchone()
    return dict(updated)


@router.get("/api/tasks")
def list_tasks():
    return _panel_task_snapshot()


@router.post("/api/tasks/{task_name}")
def start_task(task_name: str):
    allowed = {"chat-pipeline": ["src/chat-pipeline.js"], "collect-plan-dry-run": ["src/collect-plan.js", "--dry-run"]}
    if task_name not in allowed:
        raise HTTPException(status_code=404, detail="未知任务")
    with _task_lock:
        snapshot = _panel_task_snapshot()
        if snapshot["running"]:
            raise HTTPException(status_code=409, detail="已有面板任务运行中")
        lock_path = PROJECT_ROOT / ".run" / "browser-automation.lock"
        if lock_path.exists():
            try:
                owner = json.loads(lock_path.read_text(encoding="utf-8"))
                os.kill(int(owner.get("pid", 0)), 0)
                raise HTTPException(status_code=409, detail=f"浏览器任务正在运行：{owner.get('kind', '未知')}")
            except ProcessLookupError:
                try: lock_path.unlink()
                except OSError: pass
            except PermissionError:
                raise HTTPException(status_code=409, detail="浏览器任务正在运行")
            except (ValueError, json.JSONDecodeError):
                raise HTTPException(status_code=409, detail="浏览器锁状态无法确认，请先检查 .run/browser-automation.lock")
        budget = get_automation_budget()
        for platform in ("boss", "liepin"):
            if platform in budget["cooldowns"]:
                raise HTTPException(status_code=409, detail=f"{platform} 仍在冷却中")
            used = budget.get("usage", {}).get(platform, {})
            caps = budget.get("policy", {}).get("daily_caps", {}).get(platform, {})
            if any(int(used.get(k, 0)) >= int(caps.get(k, 0)) for k in ("detail_opens", "chat_opens")):
                raise HTTPException(status_code=409, detail=f"{platform} 今日访问预算已用尽")
        log_dir = PROJECT_ROOT / "logs"
        log_dir.mkdir(parents=True, exist_ok=True)
        task_id = f"{task_name}-{int(time_module.time())}"
        log_path = log_dir / f"{task_id}.log"
        command = ["node", *allowed[task_name]]
        try:
            log_handle = log_path.open("ab")
            proc = subprocess.Popen(command, cwd=PROJECT_ROOT / "automation", stdout=log_handle, stderr=subprocess.STDOUT, start_new_session=True, env=os.environ.copy())
            log_handle.close()
        except OSError as exc:
            raise HTTPException(status_code=500, detail=f"启动失败：{exc}") from exc
        _panel_tasks[task_id] = {"id": task_id, "name": task_name, "status": "running", "pid": proc.pid, "started_at": now(), "log_file": str(log_path.relative_to(PROJECT_ROOT)), "panel_managed": True, "process": proc}
        return _panel_task_snapshot()


@router.post("/api/tasks/{task_id}/stop")
def stop_task(task_id: str):
    with _task_lock:
        item = _panel_tasks.get(task_id)
        if not item or item.get("status") != "running" or not item.get("process"):
            raise HTTPException(status_code=404, detail="没有可停止的面板任务")
        proc = item["process"]
        try: os.killpg(proc.pid, signal.SIGTERM)
        except OSError: proc.terminate()
        try: proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            try: os.killpg(proc.pid, signal.SIGKILL)
            except OSError: proc.kill()
        item["status"] = "stopped"
        item["finished_at"] = now()
        return _panel_task_snapshot()


@router.post("/api/search-runs")
def create_search_run(payload: SearchRunCreate):
    validate_direction(payload.search_direction, "检索方向")
    stamp = now()
    with connect() as conn:
        cursor = conn.execute(
            """INSERT INTO search_runs(source, keyword, search_direction, filters, started_at, status, notes)
               VALUES (?, ?, ?, ?, ?, 'running', ?)""",
            (payload.source, payload.keyword, payload.search_direction, json_text(payload.filters), stamp, payload.notes),
        )
        row = conn.execute("SELECT * FROM search_runs WHERE id = ?", (cursor.lastrowid,)).fetchone()
    item = dict(row)
    item["filters"] = decode_json(item["filters"], {})
    return item


@router.patch("/api/search-runs/{run_id}")
def finish_search_run(run_id: int, payload: SearchRunFinish):
    stamp = now()
    with connect() as conn:
        old = conn.execute("SELECT * FROM search_runs WHERE id = ?", (run_id,)).fetchone()
        if not old:
            raise HTTPException(status_code=404, detail="Search run not found")
        counts = conn.execute(
            """SELECT COUNT(DISTINCT d.job_id) result_count,
                      COUNT(DISTINCT CASE WHEN j.first_seen_at >= ? THEN d.job_id END) new_job_count,
                      COUNT(DISTINCT CASE WHEN j.review_status IN ('relevant', 'recommended') THEN d.job_id END) relevant_count,
                      COUNT(DISTINCT CASE WHEN j.review_status = 'recommended' THEN d.job_id END) recommended_count
                 FROM job_discoveries d JOIN jobs j ON j.id = d.job_id
                WHERE d.search_run_id = ?""",
            (old["started_at"], run_id),
        ).fetchone()
        rejected_count = conn.execute(
            "SELECT COUNT(*) FROM screening_rejections WHERE search_run_id=?", (run_id,)
        ).fetchone()[0]
        notes = old["notes"] if payload.notes is None else payload.notes
        conn.execute(
            """UPDATE search_runs SET status=?, finished_at=?, result_count=?, new_job_count=?,
                      relevant_count=?, recommended_count=?, notes=? WHERE id=?""",
            (
                payload.status, stamp, counts["result_count"] + rejected_count, counts["new_job_count"],
                counts["relevant_count"], counts["recommended_count"], notes, run_id,
            ),
        )
        row = conn.execute("SELECT * FROM search_runs WHERE id = ?", (run_id,)).fetchone()
    item = dict(row)
    item["filters"] = decode_json(item["filters"], {})
    return item


@router.get("/api/search-runs")
def list_search_runs(limit: int = Query(100, ge=1, le=1000)):
    with connect() as conn:
        rows = conn.execute("SELECT * FROM search_runs ORDER BY started_at DESC, id DESC LIMIT ?", (limit,)).fetchall()
    result = []
    for row in rows:
        item = dict(row)
        item["filters"] = decode_json(item["filters"], {})
        result.append(item)
    return result
