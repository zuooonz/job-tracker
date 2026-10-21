# 架构说明

## 组件

| 组件 | 位置 | 作用 |
|---|---|---|
| 前端 | `frontend/src/` | React + Vite。`App.jsx` 组织页面状态；`components/` 放置岗位卡片、漏斗侧栏和设置区块；`api.js` 处理请求与令牌，通过 `/api` 访问后端 |
| 后端 | `backend/` | FastAPI + SQLite。`main.py` 创建应用并注册 `routers/` 中的 API 路由，`common.py` 提供共享逻辑，`db.py` 管理表结构与迁移，`auth.py` 提供可选登录鉴权 |
| 自动化 | `automation/src/` | Node.js。连接本机 Chrome，采集岗位、同步沟通记录、调用模型评价 |
| 配置 | `automation/config/` | 公开示例配置与提示词；`private/` 下的同名文件覆盖示例（Git 忽略） |
| 管理脚本 | `scripts/manage.sh` | 启停服务和浏览器、执行采集与同步等日常命令 |
| 可选自托管 | `contrib/` | 部署、systemd、worker 与简历同步材料 |

## 浏览器驱动

自动化连接常驻 Chrome 的调试端口（默认 `127.0.0.1:18800`），登录态保存在 `data/browser-profile/`，有头和无头模式共用同一份登录态。

- `cdp-connection.js`：直接建立浏览器级 CDP 连接，只在需要时附着到具体标签，不做自动附着。
- `cdp-page.js`：在单个标签上提供导航、页面求值、截图、鼠标输入等操作，接口与 Puppeteer 的常用部分保持一致，但不启用 `Runtime` 等调试域。
- `browser.js` 的 `connectOrLaunch()` 默认使用以上驱动；浏览器只使用仓库内的 CDP 驱动。

页面在 `about:blank`、登录页或安全验证页时视为被拦截，任务立即停止并保留现场，不会自动处理验证。有头窗口被其他窗口遮挡时，桌面合成器会降低它的渲染帧率，导致页面响应变慢；需要长时间后台运行时使用无头模式。

自动化入口通过 `/api/automation/budget` 共享每日详情页/会话预留、拦截冷却和最近运行结果。预算计数保存在数据库目录的 `automation-budget.json`；公开策略 `automation/config/automation-policy.json` 可由私有同名文件覆盖。浏览器任务使用 `.run/browser-automation.lock` 互斥，并在发现进程已退出时清理陈旧锁。`automation-status` 查看用量，`automation-reset-cooldown boss|liepin` 在本人处理拦截后清除冷却。`boss-chat-monitor` 仅显式启动，不随服务自动运行。

## 数据流

1. **检索计划**：`search-plan-v2.json` 定义求职方向（ID、名称、说明）以及 BOSS / 猎聘各自的种子词和扩展词。`collect-plan` 按 A/B/C 优先级执行，并按净新增率决定是否展开扩展词。
2. **采集与筛选**：平台适配器（`adapters/boss.js`、`adapters/liepin.js`）读取列表与详情；`prefilter.js` 做标题粗筛，`screening.js` 按 `search-strategy.json` 做详情筛选（无关词、薪资底线、经验条件、特殊规则等），`field-quality.js` 检查字段完整性。通过的岗位写入数据库，被筛掉的只记一条轻量排除记录。
3. **评价**：`evaluate-jobs.js` 把候选人画像、评价策略和岗位事实交给模型，返回六个维度的分数与依据。推荐等级由本地阈值重新计算；评价方向必须是检索计划中的方向。相同输入生成相同的 `input_hash`，内容未变时不重复评价。新岗位默认进入低谷时段队列，由 `evaluation-worker.js` 处理。
4. **沟通同步**：
   - BOSS：`boss-chat-full-list.js` 在已打开的“消息”页里逐个点开会话读取完整聊天，只做追加合并。加 `--supplement` 时，库里没有的沟通岗位会通过会话顶部“查看职位”打开详情并入库；详情页打不开时用会话摘要建档，标记为“详情不可访问”。补录间隔按页面响应自适应调整。`boss-chat-snapshot.js` 只读取会话列表里的最新一条消息，适合高频轻量同步。
   - 猎聘：`chat.js` 在岗位页打开聊天读取记录；`apply-records.js` 读取投递记录，补录未入库岗位并写入投递反馈。
   - `chat-pipeline.js` 串起 BOSS 消息页完整历史（`--supplement` 补录）、猎聘岗位页聊天和投递记录；`chat-summarize.js` 生成沟通摘要，`reply-draft.js` 生成回复草稿，草稿需本人审核后再发送。
5. **前端**：读取岗位、评价、沟通与投递状态；“设置”弹窗可编辑检索词、筛选规则、候选人画像和评价设置，并查看运行环境状态。

岗位另提供派生的统一 `funnel_status`：`todo`（待看）→ `interested`（想投）→ `contacted`（已沟通）→ `interview`（面试）→ `offer`（Offer）/`closed`（结束），人工排除映射为 `excluded`（排除）。它由既有 `review_status` 与 `applications.status` 计算，不改变旧字段和筛选参数。沟通摘要中的 `interview` 类别会把适用岗位推进到面试阶段。

## 已关闭岗位

关键词采集遇到已关闭、下线或暂停招聘的岗位时不入库。沟通中涉及的岗位即使已关闭也会入库，以便挂载聊天记录：页面上仍有职位描述就保留，没有则用页面标题、摘要或会话信息建档。这类岗位的 `listing_status` 记为“已关闭 / 已暂停招聘 / 详情不可访问”，不会自动进入评价队列，前端显示灰色状态标签。

## 配置与数据模型

程序优先读取 `automation/config/private/` 下的同名文件，缺失时使用公开示例。设置 API 校验后把 JSON 原子写入私有目录，并保留最近 10 份备份。方向列表按文件修改时间缓存，无效方向在 API 入口返回 422。

主要数据表：岗位 `jobs`、详情快照 `job_snapshots`、检索批次 `search_runs`、检索命中 `job_discoveries`、筛除记录 `screening_rejections`、评价 `evaluations`、评价队列 `evaluation_queue`、投递状态 `applications`、沟通消息 `chat_messages`、回复草稿 `reply_drafts`。表结构由 `backend/db.py` 初始化并逐版迁移。

## 登录

- 本机有头登录：`./scripts/manage.sh chat-pipeline --local-headed-login` 打开 BOSS 与猎聘页面，两个平台都登录后自动开始同步。
- 无头或远程登录：`./scripts/manage.sh qr-login boss|liepin` 在本机 `http://127.0.0.1:3081`（BOSS）或 `3082`（猎聘）提供扫码页，用手机 App 扫码即可，二维码不会上传到任何服务器。
- 前端登录鉴权可选：设置 `TRACKER_LOGIN_PASSWORD` 后所有 `/api/*` 需要令牌，自动化程序使用 `TRACKER_API_TOKEN`。

敏感密钥只从环境变量读取；“运行环境”接口只返回密钥是否已配置、模型服务地址主机及设置覆盖状态，不返回密钥或环境变量值。公开候选人画像会禁止队列领取和评价写入，改为个人画像后恢复。

## 扩展接口

- `GET /api/stats/score-bands` 按最新评价分数汇总岗位、沟通、回复、面试和 Offer 数量及比率。
- `POST /api/settings/candidate-profile/draft` 脱敏简历文本后调用配置的模型，仅返回候选人画像草稿，不写入配置。
- `GET /api/tasks`、`POST /api/tasks/chat-pipeline`、`POST /api/tasks/collect-plan-dry-run` 和 `POST /api/tasks/{id}/stop` 提供固定白名单任务控制。
