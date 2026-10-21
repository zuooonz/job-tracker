#!/usr/bin/env python3
"""
岗位筛选台（Jobs/_tracker）— 远程服务器部署工具 (本机 Linux → 服务器)

与 systemd 服务配合，使用 systemctl 管理进程。

推荐用法:
    python3 contrib/deploy.py status                     # 服务器总体状态
    python3 contrib/deploy.py env init                   # 本地生成服务器密钥（contrib/server.env）
    python3 contrib/deploy.py env push                   # 备份后推送服务器 .env
    python3 contrib/deploy.py code                       # 本机构建前端 + 部署代码 + 重启服务
    python3 contrib/deploy.py db push --dry-run          # 数据库推送预检
    python3 contrib/deploy.py db push --yes              # 安全推送本机数据库（首次迁移用）
    python3 contrib/deploy.py service status|restart|logs
    python3 contrib/deploy.py rollback                   # 回滚最近一次代码备份

部署拓扑：
    服务器:    $TRACKER_SERVER_HOST（密钥登录，用户见 DEPLOY_SERVER_USER）
    项目路径:  /opt/jobs-tracker
    后端:      venv uvicorn main:app --port 5175（同时托管 frontend/dist 静态产物）
    systemd:   jobs-tracker.service
    配置:      /opt/jobs-tracker/.env（含登录密码/密钥，只读 600）

原则（对齐 tweets deploy.py 的安全习惯）：
    - code 命令永不触碰数据库；
    - db push 先备份远程、校验 schema、停服替换、启动验证；
    - 代码部署先在远端 staging 验证模块可导入，成功才原子切换，失败不打断现有服务；
    - 密钥只存在于 .env / contrib/server.env，不进 git。
"""

from __future__ import annotations

import argparse
import getpass
import hashlib
import os
import secrets
import sqlite3
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

# ---------------------------------------------------------------------------
# 配置
# ---------------------------------------------------------------------------
def _load_root_env() -> None:
    """读取项目根 .env 中的部署配置；服务器地址等不写进仓库。"""
    env_file = Path(__file__).resolve().parent.parent / ".env"
    if not env_file.exists():
        return
    for line in env_file.read_text(encoding="utf-8").splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            key, value = line.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip().strip('"\''))


_load_root_env()
SERVER_HOST = os.environ.get("DEPLOY_SERVER_HOST") or os.environ.get("TRACKER_SERVER_HOST", "")
SERVER_USER = os.environ.get("DEPLOY_SERVER_USER", "deploy")
if not SERVER_HOST and __name__ == "__main__":
    sys.exit("缺少服务器地址：请在 .env 设置 TRACKER_SERVER_HOST（或 DEPLOY_SERVER_HOST）")
REMOTE_DIR = "/opt/jobs-tracker"
PORT = 5175
SERVICE = "jobs-tracker.service"
VENV_DIR = f"{REMOTE_DIR}/venv"
REMOTE_ENV = f"{REMOTE_DIR}/.env"

PROJECT_ROOT = Path(__file__).resolve().parent.parent
BACKEND_DIR = PROJECT_ROOT / "backend"
FRONTEND_DIR = PROJECT_ROOT / "frontend"
DIST_DIR = FRONTEND_DIR / "dist"
REQUIREMENTS = PROJECT_ROOT / "requirements.txt"
LOCAL_DB = PROJECT_ROOT / "data" / "jobs.sqlite3"
SERVER_ENV_FILE = Path(__file__).resolve().parent / "server.env"
BACKUP_KEEP = 5

SYSTEMD_UNIT = f"""[Unit]
Description=Job Tracker (FastAPI + static frontend)
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory={REMOTE_DIR}/backend
EnvironmentFile={REMOTE_ENV}
ExecStart={VENV_DIR}/bin/uvicorn main:app --host 0.0.0.0 --port {PORT} --timeout-keep-alive 5 --timeout-graceful-shutdown 10
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
"""

QUICK_HELP = """岗位筛选台部署工具

  status                 服务器总体状态（服务 + HTTP + 资源）
  code [--skip-build]    本机构建前端并部署代码（不碰数据库）
  env init               本地生成服务器密钥（写 contrib/server.env，chmod 600）
  env push [--dry-run]   备份后推送 .env 到服务器并重启服务
  env status             对比本地/服务器 .env 键（不显示值）
  db push [--dry-run|--yes]   安全推送本机数据库到服务器（首次迁移用）
  service status|restart|logs  查看/重启服务、查看日志
  rollback               回滚最近一次代码备份并重启

安全约定：code 永不上传数据库；db push 需 --yes；密钥不进 git。
"""


# ---------------------------------------------------------------------------
# 基础工具
# ---------------------------------------------------------------------------
def ssh(cmd: str, check: bool = True) -> str:
    result = subprocess.run(
        ["ssh", f"{SERVER_USER}@{SERVER_HOST}", cmd],
        capture_output=True, text=True, encoding="utf-8",
    )
    if check and result.returncode != 0:
        raise RuntimeError(f"SSH 命令失败: {cmd}\nstderr: {result.stderr}")
    return result.stdout


def scp(local: str, remote: str) -> None:
    subprocess.run(["scp", str(local), f"{SERVER_USER}@{SERVER_HOST}:{remote}"], check=True)


def remote_file(path: str) -> bool:
    return ssh(f"test -f {path} && echo yes || echo no").strip() == "yes"


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def zip_local(source_paths: list[Path], zip_path: Path, cwd: Path) -> int:
    """以 cwd 为根打包，返回文件数。"""
    if zip_path.exists():
        zip_path.unlink()
    count = 0
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for src in source_paths:
            if src.is_dir():
                for f in src.rglob("*"):
                    if f.is_file():
                        zf.write(f, f.relative_to(cwd))
                        count += 1
            elif src.is_file():
                zf.write(src, src.relative_to(cwd))
                count += 1
    return count


# ---------------------------------------------------------------------------
# 部署内容
# ---------------------------------------------------------------------------
def code_payload() -> list[Path]:
    """代码部署包：后端 + 前端产物 + 依赖清单 + 文档 + systemd 模板 + worker 运行文件。"""
    payload = [f for f in BACKEND_DIR.glob("*.py")]
    if not payload:
        raise RuntimeError(f"后端目录没有 .py 文件: {BACKEND_DIR}")
    payload.append(REQUIREMENTS)
    if DIST_DIR.is_dir():
        payload.append(DIST_DIR)
    docs_dir = PROJECT_ROOT / "docs"
    if docs_dir.is_dir():
        payload.append(docs_dir)
    contrib_dir = PROJECT_ROOT / "contrib"
    if contrib_dir.is_dir():
        payload.extend(f for f in contrib_dir.iterdir() if f.is_file() and f.name != "server.env")
    # 评价 worker 运行文件（服务器 cron 低谷批量用；无 node_modules 依赖）
    for sub in ("src", "config"):
        d = PROJECT_ROOT / "automation" / sub
        if d.is_dir():
            payload.append(d)
    return payload


# ---------------------------------------------------------------------------
# 步骤：代码部署
# ---------------------------------------------------------------------------
def step_connectivity() -> None:
    ssh("echo ok")


def step_build_frontend() -> None:
    print("[前端] 本地构建 (npm run build)...")
    env = os.environ.copy()
    env.pop("NODE_OPTIONS", None)
    subprocess.run("npm run build", shell=True, cwd=FRONTEND_DIR, check=True, env=env)
    print(f"[前端] 构建完成: {DIST_DIR.stat().st_size / 1024:.0f} KB")


def step_ensure_remote_dirs() -> None:
    ssh(f"mkdir -p {REMOTE_DIR}/data {REMOTE_DIR}/code_backups {REMOTE_DIR}/db_backups")


def step_backup_remote_code() -> str:
    ts = ssh("date +%Y%m%d_%H%M%S").strip()
    for d in ("backend", "frontend", "automation", "docs", "contrib"):
        ssh(f"""
            cd {REMOTE_DIR}
            if [ -d {d} ] && [ ! -d {d}_backup_{ts} ]; then
                cp -r {d} {d}_backup_{ts}
            fi
        """, check=False)
    # 清理过旧备份：按前缀保留最近 BACKUP_KEEP 份（回滚依赖根目录备份）
    for d in ("backend", "frontend", "automation", "docs", "contrib"):
        ssh(f"""cd {REMOTE_DIR} && \
            ls -d {d}_backup_* 2>/dev/null | sort | head -n -{BACKUP_KEEP} | xargs -r rm -rf""", check=False)
    return ts


def step_upload_and_swap(payload: list[Path]) -> None:
    with tempfile.TemporaryDirectory() as tmp:
        zip_path = Path(tmp) / "jobs_code.zip"
        count = zip_local(payload, zip_path, cwd=PROJECT_ROOT)
        print(f"[代码] 打包 {count} 个文件，{zip_path.stat().st_size / 1024:.0f} KB，上传中...")
        scp(str(zip_path), f"{REMOTE_DIR}/jobs_code.zip")
        ssh(f"rm -rf {REMOTE_DIR}/code_staging && mkdir -p {REMOTE_DIR}/code_staging")
        ssh(f"cd {REMOTE_DIR}/code_staging && python3 -m zipfile -e {REMOTE_DIR}/jobs_code.zip . && rm -f {REMOTE_DIR}/jobs_code.zip")


def step_ensure_venv() -> None:
    """按 requirements.txt 哈希决定是否重建/重装依赖。"""
    local_hash = sha256_file(REQUIREMENTS)
    hash_path = f"{REMOTE_DIR}/.requirements.sha256"
    need_install = not remote_file(hash_path)
    if not need_install:
        remote_hash = ssh(f"cat {hash_path}").strip()
        need_install = remote_hash != local_hash
    if not remote_file(f"{VENV_DIR}/bin/uvicorn"):
        print("[依赖] 创建 venv...")
        ssh(f"python3 -m venv {VENV_DIR}")
        need_install = True
    if need_install:
        print("[依赖] 安装 requirements.txt（首次或变更时）...")
        ssh(f"{VENV_DIR}/bin/pip install --quiet -r {REMOTE_DIR}/code_staging/requirements.txt")
        ssh(f"echo {local_hash} > {hash_path}")
    else:
        print("[依赖] requirements 未变化，跳过安装")


def step_verify_import() -> None:
    print("[验证] 后端模块导入检查...")
    ssh(f"cd {REMOTE_DIR}/code_staging/backend && {VENV_DIR}/bin/python -c 'import main'")


def step_swap_code() -> None:
    print("[代码] 原子切换新版本...")
    ssh(f"""
        cd {REMOTE_DIR}
        rm -rf backend_old frontend_old automation_old docs_old contrib_old
        [ -d backend ] && mv backend backend_old || true
        [ -d frontend ] && mv frontend frontend_old || true
        [ -d automation ] && mv automation automation_old || true
        [ -d contrib ] && mv contrib contrib_old || true
        [ -d docs ] && mv docs docs_old || true
        mv code_staging/backend backend
        [ -d code_staging/frontend ] && mv code_staging/frontend frontend || true
        [ -d code_staging/automation ] && mv code_staging/automation automation || true
        [ -d code_staging/contrib ] && mv code_staging/contrib contrib || true
        [ -d code_staging/docs ] && mv code_staging/docs docs || true
        cp code_staging/requirements.txt requirements.txt 2>/dev/null || true
        rm -rf code_staging
    """)


def step_ensure_env() -> None:
    if remote_file(REMOTE_ENV):
        return
    print("[配置] 服务器 .env 不存在，先生成本地密钥并推送...")
    step_env_init(assume_yes=True)
    step_env_push()


def step_install_unit() -> None:
    print("[服务] 安装 systemd unit...")
    # 直接从本机脚本目录上传模板，不依赖代码包内的副本
    unit_local = Path(__file__).resolve().parent / "jobs-tracker.service"
    if unit_local.exists():
        scp(str(unit_local), f"/etc/systemd/system/{SERVICE}")
    else:
        with tempfile.NamedTemporaryFile("w", suffix=".service", delete=False) as f:
            f.write(SYSTEMD_UNIT)
            tmp = f.name
        scp(tmp, f"/etc/systemd/system/{SERVICE}")
        os.unlink(tmp)
    ssh(f"systemctl daemon-reload && systemctl enable {SERVICE} >/dev/null 2>&1 || true")
    ssh(f"systemctl restart {SERVICE}")
    import time
    time.sleep(3)


def step_verify_service() -> None:
    active = ssh(f"systemctl is-active {SERVICE}", check=False).strip()
    root_code = ssh(
        f"curl -s -o /dev/null -w '%{{http_code}}' http://127.0.0.1:{PORT}/", check=False
    ).strip()
    api_code = ssh(
        f"curl -s -o /dev/null -w '%{{http_code}}' http://127.0.0.1:{PORT}/api/jobs", check=False
    ).strip()
    print("=" * 56)
    print(f"  jobs-tracker.service: {active}")
    print(f"  页面 http://{SERVER_HOST}:{PORT}/            HTTP {root_code}")
    print(f"  API  /api/jobs（未带令牌）     HTTP {api_code}（鉴权开启时应为 401）")
    print("=" * 56)
    if active != "active" or root_code != "200":
        print("[WARN] 服务状态异常，请检查：journalctl -u jobs-tracker.service -n 50 --no-pager")
        return False
    print("[OK] 部署验证通过")
    return True


def cmd_code(args) -> int:
    step_connectivity()
    if not args.skip_build:
        step_build_frontend()
    step_ensure_remote_dirs()
    ts = step_backup_remote_code()
    step_upload_and_swap(code_payload())
    step_ensure_venv()
    step_verify_import()
    step_swap_code()
    step_ensure_env()
    step_install_unit()
    if not step_verify_service():
        print(f"[提示] 可回滚：python3 contrib/deploy.py rollback（备份时间戳 {ts}）")
        return 1
    # 验证通过后清理切换前的旧目录（备份仍在 code_backups/）
    ssh(f"cd {REMOTE_DIR} && rm -rf backend_old frontend_old automation_old docs_old contrib_old", check=False)
    return 0


# ---------------------------------------------------------------------------
# 步骤：环境变量（密钥）
# ---------------------------------------------------------------------------
def _env_template(password: str) -> str:
    local_env = PROJECT_ROOT / ".env"
    llm_key = ""
    if local_env.exists():
        for line in local_env.read_text(encoding="utf-8").splitlines():
            if line.startswith(("LLM_API_KEY=", "DEEPSEEK_API_KEY=")):
                llm_key = line.split("=", 1)[1].strip().strip('"\'')
    return f"""# 由 deploy.py env init 生成 {__import__('datetime').date.today()}，请勿提交
LLM_API_KEY={llm_key or 'replace-with-your-key'}
LLM_BASE_URL=https://api.deepseek.com
LLM_MODEL=deepseek-v4-flash
LLM_THINKING=
LLM_MAX_TOKENS=6000

# 登录鉴权
TRACKER_LOGIN_PASSWORD={password}
TRACKER_AUTH_SECRET={secrets.token_hex(32)}
TRACKER_API_TOKEN={secrets.token_urlsafe(24)}

# 服务器模式
TRACKER_STATIC_DIR={REMOTE_DIR}/frontend/dist
TRACKER_API_URL=http://127.0.0.1:{PORT}
"""


def step_env_init(assume_yes: bool = False) -> None:
    if SERVER_ENV_FILE.exists() and not assume_yes:
        ans = input("contrib/server.env 已存在，覆盖？[y/N] ")
        if ans.strip().lower() != "y":
            print("取消")
            return
    password = os.environ.get("TRACKER_LOGIN_PASSWORD") or secrets.token_urlsafe(12)
    SERVER_ENV_FILE.write_text(_env_template(password), encoding="utf-8")
    os.chmod(SERVER_ENV_FILE, 0o600)
    print(f"[env] 已生成 {SERVER_ENV_FILE}（600 权限，已加入 .gitignore）")
    print(f"[env] 登录密码：{password}")
    print("[env] 如需自定义密码：TRACKER_LOGIN_PASSWORD=xxx python3 contrib/deploy.py env init")


def step_env_push(dry_run: bool = False) -> None:
    if not SERVER_ENV_FILE.exists():
        raise RuntimeError("本地 contrib/server.env 不存在，先运行 env init")
    if dry_run:
        print("[env] dry-run：将推送", SERVER_ENV_FILE)
        print("[env] 远程 .env 存在:", remote_file(REMOTE_ENV))
        return
    step_connectivity()
    ssh(f"mkdir -p {REMOTE_DIR}")
    if remote_file(REMOTE_ENV):
        ts = ssh("date +%Y%m%d_%H%M%S").strip()
        ssh(f"cp {REMOTE_ENV} {REMOTE_ENV}.bak_{ts}")
        print(f"[env] 已备份远程 .env -> .env.bak_{ts}")
    scp(str(SERVER_ENV_FILE), REMOTE_ENV)
    ssh(f"chmod 600 {REMOTE_ENV}")
    ssh(f"systemctl restart {SERVICE}", check=False)
    print("[env] 已推送并重启服务（密钥仅存服务器 .env 与本地 contrib/server.env）")


def step_env_password() -> None:
    """只修改网页登录密码，保留签名密钥和采集器 API Token。"""
    if not SERVER_ENV_FILE.exists():
        raise RuntimeError("本地 contrib/server.env 不存在，不能安全保留现有密钥")
    password = os.environ.get("TRACKER_LOGIN_PASSWORD") or getpass.getpass("新登录密码：")
    if not password:
        raise RuntimeError("登录密码不能为空")
    if "\n" in password or "\r" in password:
        raise RuntimeError("登录密码不能包含换行符")
    if not os.environ.get("TRACKER_LOGIN_PASSWORD"):
        confirmation = getpass.getpass("再次输入新登录密码：")
        if confirmation != password:
            raise RuntimeError("两次输入的密码不一致")

    lines = SERVER_ENV_FILE.read_text(encoding="utf-8").splitlines()
    for index, line in enumerate(lines):
        if line.startswith("TRACKER_LOGIN_PASSWORD="):
            lines[index] = f"TRACKER_LOGIN_PASSWORD={password}"
            break
    else:
        raise RuntimeError("contrib/server.env 缺少 TRACKER_LOGIN_PASSWORD，拒绝修改")
    SERVER_ENV_FILE.write_text("\n".join(lines) + "\n", encoding="utf-8")
    os.chmod(SERVER_ENV_FILE, 0o600)
    print("[env] 已仅更新本地登录密码；签名密钥与 API Token 保持不变")
    step_env_push()


def step_env_status() -> None:
    print("[env] 本地 contrib/server.env 键:")
    if SERVER_ENV_FILE.exists():
        keys = [line.split("=", 1)[0] for line in SERVER_ENV_FILE.read_text().splitlines() if "=" in line and not line.startswith("#")]
        print("  " + ", ".join(keys))
    else:
        print("  （不存在，先运行 env init）")
    print("[env] 服务器 .env 键:")
    out = ssh(f"grep -oE '^[A-Z_]+=' {REMOTE_ENV} 2>/dev/null | tr -d '=' | tr '\\n' ' ' || echo none", check=False)
    print("  " + (out.strip() or "（不存在）"))


# ---------------------------------------------------------------------------
# 步骤：数据库推送
# ---------------------------------------------------------------------------
def _schema_version(db_path: Path) -> int | None:
    if not db_path.exists():
        return None
    conn = sqlite3.connect(db_path)
    try:
        row = conn.execute("SELECT value FROM schema_meta WHERE key='schema_version'").fetchone()
        return int(row[0]) if row else None
    finally:
        conn.close()


def _online_backup(src: Path, dst: Path) -> None:
    s = sqlite3.connect(src)
    d = sqlite3.connect(dst)
    try:
        s.backup(d)
    finally:
        d.close()
        s.close()


def cmd_db_push(args) -> int:
    sys.path.insert(0, str(BACKEND_DIR))
    from db import SCHEMA_VERSION

    step_connectivity()
    if not LOCAL_DB.exists():
        raise RuntimeError(f"本地数据库不存在: {LOCAL_DB}")
    local_ver = _schema_version(LOCAL_DB)
    print(f"[db] 本地数据库: {LOCAL_DB}（schema v{local_ver}）")
    if local_ver != SCHEMA_VERSION:
        raise RuntimeError(f"本地 schema v{local_ver} 与代码期望 v{SCHEMA_VERSION} 不一致，先升级")
    if args.dry_run:
        remote_exists = remote_file(f"{REMOTE_DIR}/data/jobs.sqlite3")
        print("[db] dry-run：远程数据库存在:", remote_exists)
        if remote_exists:
            print("[db] 推送将先备份远程库再整体替换；本地数据成为服务器权威源。")
        return 0
    if not args.yes:
        raise RuntimeError("db push 会整体替换服务器数据库，请加 --yes 确认（可用 --dry-run 预览）")

    # 一致性快照
    with tempfile.TemporaryDirectory() as tmp:
        snap = Path(tmp) / "jobs-snapshot.sqlite3"
        print("[db] 生成本机一致性快照（online backup）...")
        _online_backup(LOCAL_DB, snap)
        print(f"[db] 快照 {snap.stat().st_size / 1024:.0f} KB")

        if remote_file(f"{REMOTE_DIR}/data/jobs.sqlite3"):
            ts = ssh("date +%Y%m%d_%H%M%S").strip()
            ssh(f"cp {REMOTE_DIR}/data/jobs.sqlite3 {REMOTE_DIR}/db_backups/jobs.bak_{ts}.sqlite3")
            print(f"[db] 已备份远程库 -> db_backups/jobs.bak_{ts}.sqlite3")

        print("[db] 停服、上传、替换...")
        ssh(f"systemctl stop {SERVICE}", check=False)
        scp(str(snap), f"{REMOTE_DIR}/data/jobs.sqlite3")
        ssh(f"chmod 600 {REMOTE_DIR}/data/jobs.sqlite3 && systemctl start {SERVICE}")
        import time
        time.sleep(3)

    active = ssh(f"systemctl is-active {SERVICE}", check=False).strip()
    print(f"[db] 服务状态: {active}")
    if active != "active":
        raise RuntimeError("服务未恢复 active，请检查日志；远程库已有备份可恢复")
    print("[db] 推送完成，服务器数据库为权威源")
    return 0


# ---------------------------------------------------------------------------
# 其他命令
# ---------------------------------------------------------------------------
def cmd_service(action: str) -> int:
    if action == "status":
        out = ssh(f"systemctl status {SERVICE} --no-pager -l | head -15", check=False)
        print(out)
    elif action == "restart":
        ssh(f"systemctl restart {SERVICE}")
        step_verify_service()
    elif action == "logs":
        out = ssh(f"journalctl -u {SERVICE} -n 80 --no-pager", check=False)
        print(out)
    return 0


def cmd_status() -> int:
    step_connectivity()
    print("[status] 服务状态:")
    active = ssh(f"systemctl is-active {SERVICE}", check=False).strip()
    print("  jobs-tracker.service:", active)
    root_code = ssh(f"curl -s -o /dev/null -w '%{{http_code}}' http://127.0.0.1:{PORT}/", check=False).strip()
    print(f"  页面 HTTP {root_code}")
    print("[status] 服务器资源:")
    print(ssh("free -h | head -2 && df -h / | tail -1"))
    print("[status] 数据:")
    print(ssh(f"test -f {REMOTE_DIR}/data/jobs.sqlite3 && {VENV_DIR}/bin/python -c \"import sqlite3;c=sqlite3.connect('{REMOTE_DIR}/data/jobs.sqlite3');print('  岗位数:',c.execute('SELECT COUNT(*) FROM jobs').fetchone()[0])\" || echo '  数据库未初始化'", check=False))
    return 0


def cmd_rollback() -> int:
    print("[回滚] 恢复最近一次代码备份...")
    ssh(f"""
        cd {REMOTE_DIR}
        for name in backend frontend automation docs contrib; do
            BAK=$(ls -d ${{name}}_backup_* 2>/dev/null | sort | tail -1)
            if [ -n "$BAK" ]; then
                rm -rf $name
                mv "$BAK" $name
                echo "恢复 $name: $BAK"
            fi
        done
        ls -d backend_backup_* >/dev/null 2>&1 || echo "没有可用备份"
    """)
    ssh(f"systemctl restart {SERVICE}", check=False)
    step_verify_service()
    return 0


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        prog="python3 contrib/deploy.py",
        description="岗位筛选台服务器部署工具",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=QUICK_HELP,
    )
    commands = parser.add_subparsers(dest="command", required=True)

    code_parser = commands.add_parser("code", help="部署程序代码（不碰数据库）")
    code_parser.add_argument("--skip-build", action="store_true", help="跳过本地前端构建（dist 已是最新时用）")

    env_parser = commands.add_parser("env", help="服务器密钥管理")
    env_actions = env_parser.add_subparsers(dest="env_action", required=True)
    env_actions.add_parser("init", help="本地生成 contrib/server.env（含随机密码/密钥）")
    env_push = env_actions.add_parser("push", help="备份后推送 .env 到服务器")
    env_push.add_argument("--dry-run", action="store_true")
    env_actions.add_parser("password", help="仅重置网页登录密码并推送，保留其他密钥")
    env_actions.add_parser("status", help="对比本地/服务器 .env 键")

    db_parser = commands.add_parser("db", help="数据库安全推送")
    db_actions = db_parser.add_subparsers(dest="db_action", required=True)
    db_push = db_actions.add_parser("push", help="整体替换服务器数据库（备份后）")
    db_push.add_argument("--dry-run", action="store_true")
    db_push.add_argument("--yes", action="store_true")

    service_parser = commands.add_parser("service", help="服务管理")
    service_parser.add_argument("action", choices=("status", "restart", "logs"))

    commands.add_parser("status", help="服务器总体状态")
    commands.add_parser("rollback", help="回滚最近一次代码备份")

    args = parser.parse_args(argv)

    try:
        if args.command == "code":
            return cmd_code(args)
        if args.command == "env":
            if args.env_action == "init":
                step_env_init()
            elif args.env_action == "push":
                step_env_push(dry_run=args.dry_run)
            elif args.env_action == "password":
                step_env_password()
            else:
                step_env_status()
            return 0
        if args.command == "db":
            if args.db_action == "push":
                return cmd_db_push(args)
            parser.error("db 只支持 push")
        if args.command == "service":
            return cmd_service(args.action)
        if args.command == "status":
            return cmd_status()
        if args.command == "rollback":
            return cmd_rollback()
    except RuntimeError as exc:
        print(f"[ERROR] {exc}", file=sys.stderr)
        return 1
    parser.error(f"未知命令: {args.command}")
    return 1


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    if len(sys.argv) == 1:
        print(QUICK_HELP)
        raise SystemExit(0)
    raise SystemExit(main(sys.argv[1:]))
