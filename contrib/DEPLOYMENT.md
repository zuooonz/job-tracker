# 部署说明

## 本机部署

按根目录 [README](../README.md) 安装 Python、Node.js 依赖并创建 `.env`，然后运行：

```bash
./scripts/manage.sh start
./scripts/manage.sh status
```

默认 API 在 `127.0.0.1:8888`，Vite 前端在 `127.0.0.1:5175`。需要采集时由 `manage.sh` 启动本机 Chrome 并连接 CDP 18800。结束后执行 `./scripts/manage.sh stop`。

## Linux 服务器部署

部署脚本 `contrib/deploy.py` 面向 Linux 与 systemd。请先在 `.env` 设置 `TRACKER_SERVER_HOST`，必要时设置 `DEPLOY_SERVER_USER`，并确认 SSH 密钥、Python、Node/npm 和远端 systemd 已准备好。脚本命令：

```bash
python3 contrib/deploy.py status
python3 contrib/deploy.py env init
python3 contrib/deploy.py env push --dry-run
python3 contrib/deploy.py code
python3 contrib/deploy.py service status
```

首次部署按脚本提示初始化环境文件并推送正式配置。`code` 会在本机构建前端并部署代码，不上传数据库；数据库迁移需单独执行 `python3 contrib/deploy.py db push --dry-run` 检查，再由操作者决定是否使用 `--yes`。部署前应备份 SQLite 数据库与服务器配置。

服务器默认安装到 `/opt/jobs-tracker`，服务监听 `5175`，由 FastAPI 托管 `frontend/dist`。请通过反向代理和 TLS 提供远程访问，并限制登录凭据、API 令牌及配置文件权限。不要将 `data/`、日志、`.env` 或私有配置放进公开归档。

更多参数以 `python3 contrib/deploy.py --help` 和脚本内子命令帮助为准。
