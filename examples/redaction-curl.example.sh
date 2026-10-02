#!/usr/bin/env bash
# 出处遮盖：按出处原文撤回其公开展示（预览 → 确认）
#
# 用法：
#   TOKEN=change-me-please ./redaction-curl.example.sh "李宝山口述，2021-07-05 访谈"
#
# 环境变量：
#   BASE_URL  默认 http://localhost:3000
#   TOKEN     编辑者口令（默认 editor；Compose 默认为 change-me-please）
#
# 流程：
#   1) POST /api/editor/redaction-preview 只读预览命中范围与最新版本号；
#   2) POST /api/editor/redaction 携带预览返回的 currentVersionNo 确认。
#   预览后若有新版本，第 2 步返回 409 REDACTION_VERSION_CONFLICT，重跑本脚本即可。
#   空文本会被 400 拒绝；同一文本重复确认幂等（alreadyRedacted:true）。
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
TOKEN="${TOKEN:-editor}"
SOURCE="${1:-}"

if [ -z "$(printf '%s' "$SOURCE" | tr -d '[:space:]')" ]; then
  echo "用法: $0 \"要撤回的精确出处文本（不能为空）\"" >&2
  exit 2
fi

echo "== 1) 只读预览（不改任何数据） =="
PREVIEW=$(curl -sS -X POST "$BASE_URL/api/editor/redaction-preview" \
  -H 'Content-Type: application/json' -H "X-Editor-Token: $TOKEN" \
  -d "$(python3 -c 'import json,sys;print(json.dumps({"source":sys.argv[1]},ensure_ascii=False))' "$SOURCE")")
echo "$PREVIEW" | python3 -m json.tool

CURRENT=$(echo "$PREVIEW" | python3 -c 'import sys,json;print(json.load(sys.stdin)["currentVersionNo"])')

echo
echo "== 2) 携带预览时最新版本号 $CURRENT 确认遮盖 =="
curl -sS -X POST "$BASE_URL/api/editor/redaction" \
  -H 'Content-Type: application/json' -H "X-Editor-Token: $TOKEN" \
  -d "$(python3 -c 'import json,sys
src,ver=sys.argv[1],int(sys.argv[2])
print(json.dumps({"source":src,"currentVersionNo":ver,"editor":"curl 示例"},ensure_ascii=False))' "$SOURCE" "$CURRENT")" \
  | python3 -m json.tool

echo
echo "== 3) 效果核对：访客最新年表（命中处应为「出处已遮盖」） =="
curl -sS "$BASE_URL/api/public/chronicle" \
  | python3 -c '
import sys,json
d=json.load(sys.stdin)
if not d.get("published"):
    print("（尚无已发布版本；登记已保存，未来含该文本的版本会自动遮盖）")
else:
    v=d["version"]
    for e in v["events"]:
        print("  事件「{}」出处: {}".format(e["title"], e["source"]))
    for r in v["relations"]:
        print("  关系 #{} 出处: {}".format(r["relationId"], r["source"]))'
