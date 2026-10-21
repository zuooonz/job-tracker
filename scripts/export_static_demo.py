#!/usr/bin/env python3
"""Seed an isolated fictional database and export the static demo API fixtures."""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent.parent
OUTPUT = ROOT / "frontend" / "public" / "demo-data"


def filename_for(path: str) -> str:
    """Keep in sync with the static route mapping in frontend/src/api.js."""
    return urlsplit(path).path.strip("/").replace("/", "__") + ".json"


def main() -> None:
    OUTPUT.mkdir(parents=True, exist_ok=True)
    for existing in OUTPUT.glob("*.json"):
        existing.unlink()

    with tempfile.TemporaryDirectory(prefix="tracker-pages-demo-") as tmp:
        temp = Path(tmp)
        db_path = temp / "demo.sqlite3"
        config_path = temp / "demo-config"
        env = os.environ.copy()
        for key in list(env):
            if key.startswith(("TRACKER_", "LLM_", "DEEPSEEK_")) or key in ("BROWSER_MODE", "JOB_TRACKER_CONFIG"):
                env.pop(key, None)
        env["TRACKER_DEMO"] = "1"
        env["JOB_TRACKER_CONFIG"] = "example"
        subprocess.run([sys.executable, str(ROOT / "scripts" / "seed_demo.py"), "--db", str(db_path)],
                       cwd=ROOT, env=env, check=True, capture_output=True, text=True)

        env["TRACKER_DB_PATH"] = str(db_path)
        env["TRACKER_CONFIG_DIR"] = str(config_path)
        env["TRACKER_DEMO"] = "1"
        for key in list(os.environ):
            if key.startswith(("TRACKER_", "LLM_", "DEEPSEEK_")) or key in ("BROWSER_MODE", "JOB_TRACKER_CONFIG"):
                os.environ.pop(key, None)
        os.environ.update({"TRACKER_DB_PATH": str(db_path), "TRACKER_CONFIG_DIR": str(config_path),
                           "TRACKER_DEMO": "1", "JOB_TRACKER_CONFIG": "example"})
        sys.path.insert(0, str(ROOT / "backend"))
        import main as app_main  # noqa: E402
        from fastapi.testclient import TestClient  # noqa: E402

        with TestClient(app_main.app) as client:
            paths = [
                "/api/auth/status", "/api/resumes", "/api/jobs?limit=1000&include_jd=1",
                "/api/config", "/api/stats", "/api/evaluation-schedule",
                "/api/search-plan", "/api/settings/search-strategy",
                "/api/settings/candidate-profile", "/api/settings/evaluation-strategy",
                "/api/settings/automation-policy", "/api/settings/environment",
                "/api/stats/score-bands", "/api/tasks",
            ]
            responses: dict[str, object] = {}
            jobs_response = client.get("/api/jobs?limit=1000&include_jd=1")
            jobs_response.raise_for_status()
            jobs = jobs_response.json()
            for path in paths:
                response = client.get(path)
                response.raise_for_status()
                value = response.json()
                pathname = urlsplit(path).path
                if pathname == "/api/settings/environment":
                    # This page is informational only; remove machine and runtime details.
                    value["browser_mode"] = "static demo"
                    value["database_basename"] = "demo.sqlite3"
                    value["cdp_18800_reachable"] = False
                    value["automation"] = {}
                    value["first_run"]["env_exists"] = False
                    value["first_run"]["browser_reachable"] = False
                responses[pathname] = value
            for job in jobs:
                job_id = job["id"]
                for suffix in ("", "/chat"):
                    path = f"/api/jobs/{job_id}{suffix}"
                    response = client.get(path)
                    response.raise_for_status()
                    responses[path] = response.json()

        for path, value in responses.items():
            (OUTPUT / filename_for(path)).write_text(
                json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8"
            )
        print(f"已导出 {len(responses)} 个虚构演示接口响应到 {OUTPUT}")


if __name__ == "__main__":
    main()
