# 可选自托管材料

本目录包含可选的自托管部署、systemd 服务、评价 worker 和简历文件同步工具，仅供需要自行部署或维护服务的用户使用。日常本机使用不需要这些脚本。

部署前请检查脚本内容及目标服务器配置，并按需设置仓库根目录 `.env`。部署密钥文件写入 `contrib/server.env`，请勿提交。常见入口：

```bash
python3 contrib/deploy.py --help
bash contrib/install-boss-monitor-service.sh
bash contrib/eval-worker.sh status
bash contrib/sync_resumes.sh /path/to/Jobs
```
