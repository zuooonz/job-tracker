# 自动化命令参考

安装、配置、隐私说明见根目录 [README](../README.md)，原理见 [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md)。以下命令都在仓库根目录运行；`manage.sh` 会自动加载 `.env`。

## 浏览器与登录

```bash
./scripts/manage.sh browser-start      # 启动常驻 Chrome（BROWSER_MODE=auto|headed|headless）
./scripts/manage.sh browser-status
./scripts/manage.sh browser-stop
./scripts/manage.sh qr-login boss      # 本机扫码登录：http://127.0.0.1:3081
./scripts/manage.sh qr-login liepin    # 本机扫码登录：http://127.0.0.1:3082
```

## 岗位采集

```bash
# 单个关键词小样（关键词不在检索计划中时需指定方向 ID）
./scripts/manage.sh collect boss "数据产品 经理" --direction=product_role --max-pages=1 --detail-limit=2
./scripts/manage.sh collect liepin "数据产品经理" --direction=product_role --max-pages=1 --detail-limit=2 --dry-run

# 按检索计划批量采集，支持断点续跑
./scripts/manage.sh collect-plan --scope=full --resume --dry-run
./scripts/manage.sh collect-plan --scope=full --resume
./scripts/manage.sh collect-plan --scope=full --resume --new-run   # 重新开一轮
```

`--dry-run` 只采集不写库。遇到登录页、验证码或 `about:blank` 会立即停止并保留现场。
所有已接入的详情与会话打开操作先向后端预留平台预算；同一浏览器上的采集和沟通同步由 `.run/browser-automation.lock` 互斥。默认每日上限为 BOSS 详情 80 次、会话 200 次，猎聘详情 80 次、会话 60 次，拦截冷却 60 分钟，可在“设置 → 自动化访问预算”修改。

```bash
./scripts/manage.sh automation-status
./scripts/manage.sh automation-reset-cooldown boss   # 本人处理拦截后清除
./scripts/manage.sh automation-reset-cooldown liepin
```

## 沟通同步

```bash
./scripts/manage.sh chat-pipeline                    # BOSS 消息页完整历史（含补录）+ 猎聘岗位页与投递记录
./scripts/manage.sh chat-pipeline --only=boss
./scripts/manage.sh chat-pipeline --only=liepin --stale-after=6
./scripts/manage.sh chat-pipeline --local-headed-login
./scripts/manage.sh boss-chat-snapshot               # 只读 BOSS 会话列表里的最新消息
./scripts/manage.sh chat-summarize                   # 生成沟通摘要
```

常用参数：`--limit=N` 每个入口最多处理 N 个；`--stale-after=小时` 跳过近期同步过的岗位；`--delay-min/--delay-max/--batch-size/--batch-break-min/--batch-break-max` 调整猎聘节奏。

BOSS 完整历史也可以单独运行（`automation/` 目录下）：

```bash
npm run boss-chat-full-list -- --limit=3 --dry-run
npm run boss-chat-full-list -- --supplement          # 先补录缺失岗位，再导入完整聊天
npm run boss-chat-full-list -- --resume-file=data/chat-runs/boss-chat-full-list-xxx.json
```

补录间隔默认自适应（从 9 秒起，连续成功逐步缩短，页面变卡则翻倍并冷却），可用 `--fixed-delay --detail-delay-min=毫秒 --detail-delay-max=毫秒` 改为固定间隔。

## 排障工具

- `npm run inspect-fields -- boss|liepin URL`：读取指定岗位页的 DOM 字段，排查页面字段定位问题。
- `npm run audit-samples`：检查岗位采集样本字段与数据质量；只读，不写入岗位记录。

## 评价

```bash
./scripts/manage.sh evaluate preview --limit=10   # 只预览队列，不调用模型
./scripts/manage.sh evaluate test --limit=1       # 调用模型但不写库
./scripts/manage.sh evaluate write --limit=10     # 写入新的评价版本
```

## 其他

```bash
./scripts/manage.sh verify-status                 # 核验岗位是否仍在招聘
./scripts/manage.sh boss-chat-monitor-start       # 显式启用 BOSS 沟通近实时监测（白天时段）
./scripts/manage.sh boss-chat-monitor-stop
```

`automation/` 目录下：`npm test`（单元测试，固定使用公开示例配置）、`npm run check`（语法检查）。

监测器默认关闭；安装 systemd 单元不会设置登录自启动。首次使用时先在“设置”填写并保存候选人画像，否则 `evaluate test/write`、后台评价队列和 API 评价写入会拒绝执行；`evaluate preview` 可用于查看候选岗位。
