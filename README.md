# 本地求职跟踪台

## 简介

一个可在本机运行的求职跟踪工具。它把 BOSS 直聘、猎聘的岗位采集、筛选、评价、沟通记录和申请进度放在一个本地界面中。求职方向、候选人画像和筛选规则均由配置决定；公开配置只是通用示例。

## 功能

- 通过本机 CDP 浏览器采集岗位详情并去重，记录检索词和来源。
- 按可编辑规则筛选，支持 AI 岗位评价、沟通同步、摘要和回复草稿。
- 前端跟踪岗位状态、收藏、评价、沟通与申请进度。
- 配置按公开示例与本机私有配置分层；设置页面可维护检索计划、筛选规则、候选人画像和评价策略，并支持脱敏简历生成画像草稿。
- 提供分数区间统计和固定白名单自动化任务面板。

## 使用边界与免责声明

本项目是个人求职辅助工具，设计边界如下：

- **只在本机自用**：数据、登录态和配置都保存在你自己的电脑上，不提供多人服务或数据共享。
- **只读采集**：只读取你账号下本来就能看到的岗位与沟通信息，节奏接近人工浏览；遇到登录页、安全验证或拦截页会立即停止，由你本人处理，程序不会自动完成任何验证。
- **不自动打招呼、投递或发消息**：程序不会点击“立即沟通”“投递”等会向招聘者发出内容的按钮，也不会代你发送任何消息。
- **回复草稿需人工审核**：AI 生成的回复只是草稿，是否发送、如何修改由你决定。

使用前请阅读并遵守 BOSS 直聘、猎聘等平台的用户协议与相关法律法规，合理控制访问频率。因使用本项目导致的账号限制或其他后果由使用者自行承担。本项目与上述平台无任何关联。

## 目录结构

- `backend/`：FastAPI、SQLite 数据访问和 API。
- `frontend/`：React + Vite 前端。
- `automation/`：Node.js 浏览器自动化、采集、筛选、评价和沟通同步。
- `automation/config/`：可提交的通用配置示例与提示词。
- `automation/config/private/`：本机个人配置，Git 忽略。
- `scripts/manage.sh`：本地服务、浏览器和日常命令入口。
- `docs/`：架构说明。
- `contrib/`：可选自托管部署材料。

## 快速开始

需要 Python 3、Node.js/npm 和本机 Chrome/Chromium。安装依赖：

```bash
python3 -m pip install -r requirements.txt
(cd automation && npm ci)
(cd frontend && npm ci)
cp .env.example .env
```

按需编辑 `.env`：设置 `TRACKER_LOGIN_PASSWORD` 开启前端登录；使用模型功能时填写 `LLM_API_KEY`（兼容 `DEEPSEEK_API_KEY`）。首次启动后请在“设置 → 候选人画像”保存自己的画像；公开示例画像会停用评价（preview 预览仍可用）。密钥仅放 `.env`，不要提交。首次启动：

```bash
./scripts/manage.sh start
```

打开 `http://127.0.0.1:5175`。未设置登录密码时本机免登录；设置后用该密码首次登录。浏览器自动化需要先登录招聘平台：有桌面时 `./scripts/manage.sh browser-start` 打开浏览器直接登录；无桌面或无头模式用 `./scripts/manage.sh qr-login boss`（或 `liepin`），在本机 `http://127.0.0.1:3081`（猎聘为 3082）扫码。

演示模式使用虚构示例数据和独立数据库：

```bash
./scripts/manage.sh demo
```

重置演示数据：`./scripts/manage.sh demo --reset`。停止服务：`./scripts/manage.sh stop`；查看状态：`./scripts/manage.sh status`。

## 日常使用

- **采集**：按检索计划批量采集 `./scripts/manage.sh collect-plan --scope=full --resume`（先加 `--dry-run` 预览）。单个关键词：`./scripts/manage.sh collect boss "数据产品 经理" --direction=product_role --max-pages=1 --detail-limit=2`（不在计划里的关键词要用 `--direction` 指定方向）。
- **沟通同步**：`./scripts/manage.sh chat-pipeline` 一次完成 BOSS 消息页完整聊天（含补录沟通岗位）与猎聘聊天、投递记录；只想快速拿到 BOSS 最新消息用 `./scripts/manage.sh boss-chat-snapshot`。需要先用 `./scripts/manage.sh browser-start` 启动浏览器并保持 BOSS“消息”页打开。
- **评价**：`./scripts/manage.sh evaluate preview` 预览；`./scripts/manage.sh evaluate test --limit=1` 调用模型但不写回；`./scripts/manage.sh evaluate write --limit=1` 写回结果。
- **前端设置**：点击“设置”，修改检索词、筛选规则、候选人画像或评价设置，并查看运行环境（密钥是否已配置、浏览器连接状态等）。每节独立保存；设置写入 `automation/config/private/`，错误会以内联提示显示。
- **自动化安全预算**：默认按平台每日最多打开 80 个详情页、40 个会话；在“设置 → 自动化访问预算”调整。登录墙、安全验证或 `about:blank` 拦截会触发 60 分钟全局冷却。查看 `./scripts/manage.sh automation-status`，本人处理后可运行 `./scripts/manage.sh automation-reset-cooldown boss|liepin`。
- `boss-chat-monitor` 默认不启动，只有显式运行 `./scripts/manage.sh boss-chat-monitor-start` 才会开启；安装 systemd 单元不会设置登录自启动。

更多自动化参数见 [automation/README.md](automation/README.md)。

## 配置说明

`automation/config/` 保存通用公开示例；程序优先读取同名 `automation/config/private/` 文件。私有目录已加入 Git 忽略。测试通过 `JOB_TRACKER_CONFIG=example` 强制读取公开示例。后端可用 `TRACKER_CONFIG_DIR` 指定配置根目录（该目录下可放 `private/`）。

| 环境变量 | 用途 |
|---|---|
| `LLM_API_KEY` | OpenAI 兼容模型 API 密钥；未设置时回退到 `DEEPSEEK_API_KEY` |
| `LLM_BASE_URL` | OpenAI 兼容 API 地址；回退到 `DEEPSEEK_BASE_URL` |
| `LLM_MODEL` | 模型名；回退到 `DEEPSEEK_MODEL`，再回退到评价策略模型名 |
| `LLM_THINKING` / `LLM_MAX_TOKENS` | 可选思考参数与最大 token；回退到对应 `DEEPSEEK_*` |
| `DEEPSEEK_API_KEY` / `DEEPSEEK_BASE_URL` / `DEEPSEEK_MODEL` | 兼容旧版模型设置变量 |


| `TRACKER_LOGIN_PASSWORD` / `TRACKER_AUTH_SECRET` | 前端登录密码和签名密钥 |
| `TRACKER_API_TOKEN` | 自动化程序访问后端的令牌 |
| `TRACKER_DB_PATH` | SQLite 文件位置 |
| `TRACKER_CONFIG_DIR` | 后端配置根目录 |
| `BROWSER_MODE` | 浏览器模式：`auto`、`headed` 或 `headless` |
| `TRACKER_API_URL` | 自动化程序使用的后端地址 |
| `TRACKER_STATIC_DIR` | 服务器模式下由后端托管的前端静态目录 |
| `TRACKER_SERVER_HOST` / `TRACKER_SERVER_URL` | 部署脚本使用的服务器地址 |
| `DEPLOY_SERVER_USER` | 部署 SSH 用户（默认 `deploy`） |
| `BOSS_LOGIN_PHONE` | 可选的 BOSS 短信登录手机号 |
| `JOBS_ROOT` / `RESUME_FILE_PREFIX` | 可选的本地简历整理脚本参数 |

可选自托管部署材料见 [contrib/README.md](contrib/README.md)。

## 隐私与脱敏

岗位、聊天和申请记录保存在本机 SQLite 数据库；浏览器配置、日志也可能含账号或个人信息。不要分享 `data/`、`logs/`、`.env`、`contrib/server.env` 或 `automation/config/private/`。候选人画像只填写评价所需事实，不要填写姓名、电话、邮箱；简历草稿会先脱敏，再发送至配置的模型服务商。

## 常见问题

- **窗口被遮挡后采集卡顿**：有头模式下浏览器窗口被其他窗口挡住时，系统会降低它的渲染速度，页面响应变得很慢。需要后台长时间运行时，将 `BROWSER_MODE=headless` 写入 `.env` 后重启浏览器：`./scripts/manage.sh browser-stop && ./scripts/manage.sh browser-start`。
- **登录失效**：运行 `./scripts/manage.sh browser-start` 打开复用浏览器并在招聘平台重新登录。可用 `./scripts/manage.sh browser-status` 查看 CDP 状态。
- **反爬或页面异常**：遵守平台规则，降低采集页数与详情数，放慢配置中的详情访问节奏；不要高频重复检索。
- **前端要求登录**：检查 `.env` 的 `TRACKER_LOGIN_PASSWORD`；未配置时重启后为免登录模式。

## 测试

```bash
(cd automation && npm test && npm run check)
python3 backend/test_api.py
(cd frontend && npx eslint src && npm test && npx vite build --outDir /tmp/fe-clean)
```
