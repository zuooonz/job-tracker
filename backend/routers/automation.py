from fastapi import APIRouter
from common import (
    AutomationStatusUpdate,
    HTTPException,
    SHANGHAI_TZ,
    _automation_budget_lock,
    _automation_policy,
    _cooldown_active,
    _read_budget,
    _write_budget,
    automation_status_dict,
    connect,
    datetime,
    json_text,
    now,
    timedelta,
)

router = APIRouter()

@router.get("/api/automation/status")
def list_automation_status():
    with connect() as conn:
        rows = conn.execute("SELECT * FROM automation_status ORDER BY platform").fetchall()
    return [automation_status_dict(row) for row in rows]


@router.get("/api/automation/budget")
def get_automation_budget():
    policy = _automation_policy()
    data = _read_budget()
    day = datetime.now(SHANGHAI_TZ).date().isoformat()
    usage = data.get("usage", {}).get(day, {})
    cooldowns = {p: until for p, until in data.get("cooldowns", {}).items() if _cooldown_active(until)}
    return {"date": day, "policy": policy, "usage": usage, "cooldowns": cooldowns, "interceptions": data.get("interceptions", {}), "runs": data.get("runs", {})}


@router.post("/api/automation/budget")
def update_automation_budget(payload: dict):
    platform = payload.get("platform")
    action = payload.get("action")
    if platform not in {"boss", "liepin"}: raise HTTPException(status_code=422, detail="platform 须为 boss 或 liepin")
    stamp = now()
    policy = _automation_policy()
    with _automation_budget_lock:
        data = _read_budget()
        if action == "check":
            until = data.get("cooldowns", {}).get(platform, "")
            if _cooldown_active(until): raise HTTPException(status_code=409, detail=f"{platform} 冷却中，至 {until}")
        elif action == "reserve":
            kind = payload.get("kind")
            if kind not in {"detail_opens", "chat_opens"}: raise HTTPException(status_code=422, detail="未知预算类型")
            until = data.get("cooldowns", {}).get(platform, "")
            if _cooldown_active(until): raise HTTPException(status_code=409, detail=f"{platform} 冷却中，至 {until}")
            day = datetime.now(SHANGHAI_TZ).date().isoformat()
            daily = data.setdefault("usage", {}).setdefault(day, {}).setdefault(platform, {"detail_opens": 0, "chat_opens": 0})
            used, cap = int(daily.get(kind, 0)), int(policy.get("daily_caps", {}).get(platform, {}).get(kind, 0))
            if used >= cap: raise HTTPException(status_code=409, detail=f"{platform} 今日{ '详情' if kind == 'detail_opens' else '会话'}访问预算已用尽（{used}/{cap}）")
            daily[kind] = used + 1
        elif action == "intercept":
            minutes = max(1, min(1440, int(policy.get("cooldown_minutes", 60))))
            until = (datetime.now(SHANGHAI_TZ) + timedelta(minutes=minutes)).isoformat(timespec="seconds")
            data.setdefault("cooldowns", {})[platform] = until
            data.setdefault("interceptions", {})[platform] = {"at": stamp, "until": until, "message": str(payload.get("message", ""))[:500]}
        elif action == "reset_cooldown":
            data.setdefault("cooldowns", {}).pop(platform, None)
        elif action == "run":
            data.setdefault("runs", {})[f"{platform}:{payload.get('kind', 'collect')}"] = {"at": stamp, "status": payload.get("status", "completed"), "message": str(payload.get("message", ""))[:500], "counts": payload.get("counts", {})}
        else: raise HTTPException(status_code=422, detail="action 须为 reserve/intercept/reset_cooldown/run")
        _write_budget(data)
    return get_automation_budget()


@router.get("/api/automation/{platform}/status")
def get_automation_status(platform: str):
    if platform not in {"boss", "liepin"}:
        raise HTTPException(status_code=404, detail="Unknown platform")
    with connect() as conn:
        row = conn.execute("SELECT * FROM automation_status WHERE platform=?", (platform,)).fetchone()
    if not row:
        return {
            "platform": platform, "status": "offline", "message": "执行器尚未上报",
            "last_heartbeat_at": "",
            "last_success_at": "", "next_run_at": "", "metadata": {}, "updated_at": "",
        }
    return automation_status_dict(row)


@router.post("/api/automation/{platform}/status")
def update_automation_status(platform: str, payload: AutomationStatusUpdate):
    if platform not in {"boss", "liepin"}:
        raise HTTPException(status_code=404, detail="Unknown platform")
    stamp = now()
    with connect() as conn:
        old = conn.execute("SELECT * FROM automation_status WHERE platform=?", (platform,)).fetchone()
        last_success = payload.last_success_at
        if last_success is None:
            last_success = stamp if payload.status == "online" else (old["last_success_at"] if old else "")
        conn.execute(
            """INSERT INTO automation_status(
                   platform, status, message, last_heartbeat_at,
                   last_success_at, next_run_at, metadata, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(platform) DO UPDATE SET
                   status=excluded.status, message=excluded.message,
                   qr_image=NULL, qr_updated_at='',
                   last_heartbeat_at=excluded.last_heartbeat_at,
                   last_success_at=excluded.last_success_at, next_run_at=excluded.next_run_at,
                   metadata=excluded.metadata, updated_at=excluded.updated_at""",
            (platform, payload.status, payload.message, stamp,
             last_success, payload.next_run_at or "", json_text(payload.metadata), stamp),
        )
        row = conn.execute("SELECT * FROM automation_status WHERE platform=?", (platform,)).fetchone()
    return automation_status_dict(row)
