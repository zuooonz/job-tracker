#!/usr/bin/env bash
# 将 Jobs/<岗位文件夹>/ 下的定制简历 PDF 上传到 tracker 服务器，
# 与数据库岗位通过 _job.json 中的 job_id 对应。
#
# 用法: TRACKER_API_URL=http://<server-host>:5175 \
#       TRACKER_API_TOKEN=xxx \
#       bash contrib/sync_resumes.sh [/path/to/Jobs]
set -euo pipefail

API_URL="${TRACKER_API_URL:-http://127.0.0.1:5175}"
TOKEN="${TRACKER_API_TOKEN:?需要设置 TRACKER_API_TOKEN}"
JOBS_ROOT="${1:-${JOBS_ROOT:?需要设置 JOBS_ROOT（岗位文件夹根目录）}}"
# 定制简历文件名前缀，例如“张三”对应“张三-*.pdf”；在 .env 中设置，不写进仓库
RESUME_PREFIX="${RESUME_FILE_PREFIX:?需要设置 RESUME_FILE_PREFIX}"

uploaded=0
skipped=0
for dir in "$JOBS_ROOT"/*/; do
  meta="$dir/_job.json"
  [[ -f "$meta" ]] || { continue; }

  job_id="$(python3 -c "import json,sys;print(json.load(open('$meta')).get('job_id',''))" 2>/dev/null || true)"
  if [[ -z "$job_id" ]]; then
    echo "跳过 $(basename "$dir"): _job.json 无 job_id"
    skipped=$((skipped + 1))
    continue
  fi

  pdf="$(ls "$dir"/"$RESUME_PREFIX"-*.pdf 2>/dev/null | head -1 || true)"
  if [[ -z "$pdf" ]]; then
    echo "跳过 $(basename "$dir") (job $job_id): 未找到 $RESUME_PREFIX-*.pdf"
    skipped=$((skipped + 1))
    continue
  fi

  resp="$(curl -s --max-time 30 -X POST \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/pdf" \
    --data-binary "@$pdf" \
    "$API_URL/api/jobs/$job_id/resume")"
  if [[ "$resp" == *'"size"'* ]]; then
    size="$(python3 -c "import json;print(json.loads('''$resp''')['size'])" 2>/dev/null || echo '?')"
    echo "OK   job $job_id <- $(basename "$pdf") (${size}B)"
    uploaded=$((uploaded + 1))
  else
    echo "FAIL job $job_id: $resp"
    skipped=$((skipped + 1))
  fi
done

echo "完成：上传 $uploaded，跳过 $skipped"
