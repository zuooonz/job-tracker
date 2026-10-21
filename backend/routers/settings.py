from fastapi import APIRouter
from common import (
    DB_PATH,
    HTTPException,
    LIST_CONFIGS,
    PROJECT_ROOT,
    Path,
    SHANGHAI_TZ,
    atomic_save_config,
    auth,
    call_profile_draft_model,
    config_path,
    datetime,
    mask_resume_text,
    os,
    re,
    read_config,
    urllib,
)
import common
from routers.automation import get_automation_budget

router = APIRouter()

@router.get("/api/search-plan")
def get_search_plan():
    plan, kind = read_config("search-plan-v2.json")
    return {"path_kind": kind, "plan": plan}


@router.put("/api/search-plan")
def put_search_plan(payload: dict):
    plan, _ = read_config("search-plan-v2.json")

    directions = payload.get("directions")
    disabled = payload.get("disabled_queries")
    errors = []
    warnings = []
    if not isinstance(directions, list):
        errors.append("方向必须为列表")
        directions = []
    if not isinstance(disabled, list):
        errors.append("停用词必须为列表")
        disabled = []
    ids = set()
    seen = {"boss": {}, "liepin": {}}
    clean_directions = []
    for index, direction in enumerate(directions):
        if not isinstance(direction, dict):
            errors.append(f"第 {index + 1} 个方向格式错误")
            continue
        identifier = direction.get("id", "")
        label = direction.get("label", "")
        if not isinstance(identifier, str) or not re.fullmatch(r"[a-z][a-z0-9_]{1,40}", identifier):
            errors.append(f"第 {index + 1} 个方向 ID 格式错误")
        elif identifier in ids:
            errors.append(f"方向 ID 重复：{identifier}")
        if isinstance(identifier, str):
            ids.add(identifier)
        if direction.get("priority") not in ("A", "B", "C"):
            errors.append(f"方向 {identifier} 的优先级必须为 A、B 或 C")
        if not isinstance(label, str) or not label.strip() or len(label.strip()) > 40:
            errors.append(f"方向 {identifier} 的名称须为 1 到 40 个字符")
        description = direction.get("description", "")
        if not isinstance(description, str) or len(description) > 240:
            errors.append(f"方向 {identifier} 的描述最多 240 个字符")
            description = ""
        cleaned = {"id": identifier, "priority": direction.get("priority"), "label": label.strip() if isinstance(label, str) else "", "description": description.strip()}
        for platform in ("boss", "liepin"):
            group = direction.get(platform)
            if not isinstance(group, dict):
                errors.append(f"方向 {identifier} 缺少 {platform} 关键词")
                group = {}
            cleaned[platform] = {}
            for kind in ("seed", "variants"):
                values = group.get(kind)
                if not isinstance(values, list):
                    errors.append(f"方向 {identifier} 的 {platform} {kind} 必须为列表")
                    values = []
                if len(values) > 40:
                    errors.append(f"方向 {identifier} 的 {platform} {kind} 最多 40 个关键词")
                normalized = []
                for value in values:
                    if not isinstance(value, str) or not value.strip() or len(value.strip()) > 40:
                        errors.append(f"方向 {identifier} 的 {platform} 关键词须为 1 到 40 个字符")
                        continue
                    word = value.strip()
                    if word not in normalized:
                        normalized.append(word)
                if len(normalized) > 40:
                    errors.append(f"方向 {identifier} 的 {platform} {kind} 最多 40 个关键词")
                for word in normalized:
                    # 跨方向复用同一关键词是允许的（调度器同平台同词只执行一次），只提示不拒绝
                    previous = seen[platform].get(word)
                    if previous and previous != identifier:
                        warnings.append(f"关键词“{word}”在 {platform} 的方向“{previous}”和“{identifier}”中都出现，采集时只执行一次")
                    seen[platform][word] = identifier
                cleaned[platform][kind] = normalized
        clean_directions.append(cleaned)
    clean_disabled = []
    for index, item in enumerate(disabled):
        if not isinstance(item, dict) or item.get("platform") not in ("boss", "liepin"):
            errors.append(f"第 {index + 1} 个停用词的平台必须为 boss 或 liepin")
            continue
        keyword, reason = item.get("keyword"), item.get("reason", "")
        if not isinstance(keyword, str) or not keyword.strip() or len(keyword.strip()) > 40:
            errors.append(f"第 {index + 1} 个停用词须为 1 到 40 个字符")
            continue
        if not isinstance(reason, str):
            errors.append(f"第 {index + 1} 个停用词原因格式错误")
            continue
        clean_disabled.append({"platform": item["platform"], "keyword": keyword.strip(), "reason": reason.strip()})
    if errors:
        raise HTTPException(status_code=422, detail="；".join(errors))

    plan["directions"] = clean_directions
    plan["disabled_queries"] = clean_disabled
    plan["updated_at"] = datetime.now(SHANGHAI_TZ).isoformat(timespec="seconds")
    atomic_save_config("search-plan-v2.json", plan)
    return {"path_kind": "private", "plan": plan, "warnings": warnings}


@router.get("/api/settings/environment")
def settings_environment():
    try:
        with urllib.request.urlopen("http://127.0.0.1:18800/json/version", timeout=0.25):
            cdp_reachable = True
    except Exception:
        cdp_reachable = False
    kinds = {name: ("private" if config_path(name).parent.name == "private" else "example") for name in (
        "search-plan-v2.json", "search-strategy.json", "candidate-profile-v2.json", "evaluation-strategy-v2.json",
        "evaluation-prompt-v2.md", "chat-summary-prompt.md", "reply-draft-prompt.md")}
    strategy, _ = read_config("evaluation-strategy-v2.json")
    profile, profile_kind = read_config("candidate-profile-v2.json")
    plan, plan_kind = read_config("search-plan-v2.json")
    example_profile = "example" in str(profile.get("version", "")).lower()
    automation = get_automation_budget()
    platform_login_state = {}
    for p in ("boss", "liepin"):
        successes = [v.get("at", "") for k, v in automation.get("runs", {}).items() if k.startswith(p + ":") and v.get("status") == "completed"]
        last_success = max(successes, default="")
        interception = automation.get("interceptions", {}).get(p, {})
        platform_login_state[p] = "blocked" if interception.get("at", "") > last_success else "logged_in" if last_success else "unknown"
    platform_logged_in = {p: state == "logged_in" for p, state in platform_login_state.items()}
    api_key_configured = bool(os.getenv("LLM_API_KEY") or os.getenv("DEEPSEEK_API_KEY"))
    model = os.getenv("LLM_MODEL") or os.getenv("DEEPSEEK_MODEL") or strategy.get("api", {}).get("model", "")
    base_url = os.getenv("LLM_BASE_URL") or os.getenv("DEEPSEEK_BASE_URL") or "https://api.deepseek.com"
    return {"llm_api_key_configured": api_key_configured, "deepseek_api_key_configured": api_key_configured, "llm_base_url_host": urllib.parse.urlparse(base_url).hostname or "", "model": model,
            "auth_enabled": auth.auth_enabled(), "browser_mode": os.getenv("BROWSER_MODE", "auto"), "cdp_18800_reachable": cdp_reachable,
            "database_basename": Path(DB_PATH).name, "config_sources": kinds, "secrets_hint": "密钥等秘密信息保存在 .env 中。",
            "env_overrides": {"model": bool(os.getenv("LLM_MODEL") or os.getenv("DEEPSEEK_MODEL")), "thinking": bool(os.getenv("LLM_THINKING") or os.getenv("DEEPSEEK_THINKING")), "max_tokens": bool(os.getenv("LLM_MAX_TOKENS") or os.getenv("DEEPSEEK_MAX_TOKENS")), "base_url": bool(os.getenv("LLM_BASE_URL") or os.getenv("DEEPSEEK_BASE_URL"))},
            "candidate_profile_is_example": example_profile, "search_plan_is_example": plan_kind == "example", "automation": automation,
            "evaluation_enabled": not example_profile, "first_run": {"env_exists": (PROJECT_ROOT / ".env").exists(), "api_key_configured": api_key_configured, "candidate_profile_is_example": example_profile, "search_plan_is_example": plan_kind == "example", "browser_reachable": cdp_reachable, "platform_logged_in": platform_logged_in}, "platform_login_state": platform_login_state}


@router.get("/api/settings/automation-policy")
def get_automation_policy_setting():
    value, kind = read_config("automation-policy.json")
    return {"path_kind": kind, "value": value}


@router.put("/api/settings/automation-policy")
def put_automation_policy_setting(payload: dict):
    value, _ = read_config("automation-policy.json")
    errors = []
    caps = payload.get("daily_caps", {})
    for platform in ("boss", "liepin"):
        for key in ("detail_opens", "chat_opens"):
            n = caps.get(platform, {}).get(key)
            if not isinstance(n, int) or not 0 <= n <= 10000: errors.append(f"{platform}.{key} 须为 0 到 10000 的整数")
            else: value.setdefault("daily_caps", {}).setdefault(platform, {})[key] = n
    minutes = payload.get("cooldown_minutes")
    if not isinstance(minutes, int) or not 1 <= minutes <= 1440: errors.append("冷却时间须为 1 到 1440 分钟")
    else: value["cooldown_minutes"] = minutes
    if errors: raise HTTPException(status_code=422, detail="；".join(errors))
    atomic_save_config("automation-policy.json", value)
    return {"path_kind": "private", "value": value}


@router.get("/api/settings/{config_name}")
def get_editable_setting(config_name: str):
    files = {"search-strategy": "search-strategy.json", "candidate-profile": "candidate-profile-v2.json", "evaluation-strategy": "evaluation-strategy-v2.json"}
    if config_name not in files:
        raise HTTPException(status_code=404, detail="未知设置")
    value, kind = read_config(files[config_name])
    return {"path_kind": kind, "value": value}


@router.put("/api/settings/search-strategy")
def put_search_strategy(payload: dict):
    value, _ = read_config("search-strategy.json")
    errors = []
    floor = payload.get("minimumMonthlySalaryMaxK")
    if not isinstance(floor, (int, float)) or not 0 <= floor <= 1000: errors.append("月薪上限门槛须为 0 到 1000")
    else: value["minimumMonthlySalaryMaxK"] = floor
    for key in LIST_CONFIGS:
        raw = payload.get(key, [])
        if not isinstance(raw, list) or len(raw) > 200 or any(not isinstance(x, str) or len(x.strip()) > 80 for x in raw):
            errors.append(f"{key} 须为最多 200 项、每项不超过 80 字的文本列表")
        else: value[key] = list(dict.fromkeys(x.strip() for x in raw if x.strip()))
    pacing = payload.get("detailPacingMs", {})
    if not isinstance(pacing, dict) or not all(isinstance(pacing.get(k), int) for k in ("min", "max")) or not 0 <= pacing["min"] <= pacing["max"] <= 300000:
        errors.append("详情节奏须满足 0 ≤ 最小间隔 ≤ 最大间隔 ≤ 300000 毫秒")
    else: value["detailPacingMs"] = pacing
    penalty = payload.get("downrankPenalty", value.get("downrankPenalty", 0))
    if not isinstance(penalty, int) or not 0 <= penalty <= 100:
        errors.append("降权惩罚须为 0 到 100 的整数")
    else: value["downrankPenalty"] = penalty
    if errors: raise HTTPException(status_code=422, detail="；".join(errors))
    atomic_save_config("search-strategy.json", value)
    return {"path_kind": "private", "value": value}


@router.post("/api/settings/candidate-profile/draft")
def draft_candidate_profile(payload: dict):
    text = payload.get("resume_text", "")
    if not isinstance(text, str) or not text.strip() or len(text) > 50000:
        raise HTTPException(status_code=422, detail="简历文本须为 1 到 50000 字")
    if not (os.environ.get("LLM_API_KEY") or os.environ.get("DEEPSEEK_API_KEY")):
        raise HTTPException(status_code=503, detail="未配置模型 API 密钥，请设置 LLM_API_KEY 或 DEEPSEEK_API_KEY")
    try:
        draft = call_profile_draft_model(mask_resume_text(text))
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"画像草稿生成失败：{str(exc)[:240]}") from exc
    template, _ = read_config("candidate-profile-v2.json")
    allowed = ("positioning", "education", "verified_evidence", "target_directions", "preferred_locations", "evidence_boundaries")
    result = {key: draft.get(key, template.get(key, [] if key != "positioning" else "")) for key in allowed}
    try:
        # 走与保存 API 相同的字段约束，但绝不写入配置。
        for key in allowed:
            if key == "positioning":
                if not isinstance(result[key], str) or len(result[key]) > 3000: raise ValueError()
            elif not isinstance(result[key], list) or len(result[key]) > 200 or any(not isinstance(x, str) or len(x) > 500 for x in result[key]): raise ValueError()
    except ValueError as exc:
        raise HTTPException(status_code=502, detail="模型返回的画像字段不符合格式") from exc
    return {"draft": result, "saved": False, "notice": "简历文本已脱敏后发送至已配置的模型服务商；草稿尚未保存。"}


@router.put("/api/settings/candidate-profile")
def put_candidate_profile(payload: dict):
    value, _ = read_config("candidate-profile-v2.json")
    errors = []
    for key in ("positioning",):
        raw = payload.get(key, "")
        if not isinstance(raw, str) or len(raw) > 3000: errors.append(f"{key} 须为不超过 3000 字的文本")
        else: value[key] = raw.strip()
    for key in ("education", "verified_evidence", "target_directions", "preferred_locations", "evidence_boundaries"):
        raw = payload.get(key, [])
        if not isinstance(raw, list) or len(raw) > 200 or any(not isinstance(x, str) or len(x.strip()) > 500 for x in raw): errors.append(f"{key} 格式无效")
        else: value[key] = [x.strip() for x in raw if x.strip()]
    if errors: raise HTTPException(status_code=422, detail="；".join(errors))
    atomic_save_config("candidate-profile-v2.json", value)
    return {"path_kind": "private", "value": value}


@router.put("/api/settings/evaluation-strategy")
def put_evaluation_strategy(payload: dict):
    value, _ = read_config("evaluation-strategy-v2.json")
    errors = []
    thresholds = payload.get("thresholds", {})
    for key in value.get("thresholds", {}):
        number = thresholds.get(key)
        if not isinstance(number, int) or not 0 <= number <= 100: errors.append(f"阈值 {key} 须为 0 到 100 的整数")
        else: value["thresholds"][key] = number
    if not (value["thresholds"].get("priority", 0) >= value["thresholds"].get("normal", 0) >= value["thresholds"].get("opportunity", 0)):
        errors.append("推荐阈值须满足 priority ≥ normal ≥ opportunity")
    dimensions = payload.get("dimensions", {})
    for key, old in value.get("dimensions", {}).items():
        item = dimensions.get(key, {})
        weight = item.get("weight") if isinstance(item, dict) else None
        if not isinstance(weight, int) or not 0 <= weight <= 100: errors.append(f"维度权重 {key} 须为 0 到 100 的整数")
        else: old["weight"] = weight
    if sum(item["weight"] for item in value.get("dimensions", {}).values()) != 100: errors.append("维度权重之和必须为 100")
    api = payload.get("api", {})
    model = api.get("model")
    tokens = api.get("max_tokens")
    thinking = api.get("thinking")
    if not isinstance(model, str) or not model.strip() or len(model) > 100: errors.append("模型名称不能为空且最多 100 字")
    else: value.setdefault("api", {})["model"] = model.strip()
    if not isinstance(tokens, int) or not 1 <= tokens <= 100000: errors.append("最大 token 数须为 1 到 100000")
    else: value["api"]["max_tokens"] = tokens
    if thinking not in ("enabled", "disabled"): errors.append("思考模式须为 enabled 或 disabled")
    else: value["api"]["thinking"] = thinking
    if errors: raise HTTPException(status_code=422, detail="；".join(errors))
    atomic_save_config("evaluation-strategy-v2.json", value)
    return {"path_kind": "private", "value": value}
