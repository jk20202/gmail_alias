#!/usr/bin/env bash
# ==================================================================
# mail-alias v2 —— 一键开通独立资源(D1 / KV / R2)并回填 wrangler.toml
#
# 前置条件: 已登录 wrangler
#   npx wrangler login
# 或设置 API Token(需含 Workers / D1 / KV / R2 的编辑权限):
#   export CLOUDFLARE_API_TOKEN=xxxx
#   export CLOUDFLARE_ACCOUNT_ID=xxxx
#
# 用法: bash scripts/provision.sh
# 执行成功后 wrangler.toml 里的占位符会被替换成真实 ID,即可 push 触发自动部署。
# ==================================================================
set -uo pipefail

DB_NAME="mail_alias_v2"
KV_TITLE="MAIL_ALIAS_V2_KV"
BUCKET="mail-alias-v2-raw"
TOML="wrangler.toml"

echo "=============================================="
echo " mail-alias v2 资源开通"
echo "=============================================="

# ---------- 1. D1 ----------
echo ""
echo "==> D1 数据库: $DB_NAME"
DB_OUT=$(npx wrangler d1 create "$DB_NAME" 2>&1)
echo "$DB_OUT"
DB_ID=$(printf '%s' "$DB_OUT" | grep -o 'database_id = "[^"]*"' | head -1 | sed 's/database_id = "//; s/"$//')
if [ -z "$DB_ID" ]; then
  # 已存在时 create 会报错,改从列表里取
  DB_ID=$(npx wrangler d1 list --json 2>/dev/null | tr ',' '\n' | grep -A1 "\"name\":\"$DB_NAME\"" | grep -o '"uuid":"[^"]*"' | head -1 | sed 's/"uuid":"//; s/"$//')
fi
if [ -n "$DB_ID" ]; then echo "    database_id = $DB_ID"; else echo "    [!] 未能自动获取 database_id,请从上方输出里手动复制"; fi

# ---------- 2. KV ----------
echo ""
echo "==> KV 命名空间: $KV_TITLE"
KV_OUT=$(npx wrangler kv namespace create "$KV_TITLE" 2>&1)
echo "$KV_OUT"
KV_ID=$(printf '%s' "$KV_OUT" | grep -oE "id = ['\"][^'\"]+['\"]" | head -1 | sed -E "s/id = ['\"]//; s/['\"]$//")
if [ -n "$KV_ID" ]; then echo "    kv id = $KV_ID"; else echo "    [!] 未能自动获取 KV id,请从上方输出里手动复制"; fi

# ---------- 3. R2 ----------
echo ""
echo "==> R2 存储桶: $BUCKET"
npx wrangler r2 bucket create "$BUCKET" 2>&1 || echo "    (若提示已存在可忽略)"

# ---------- 4. 回填 wrangler.toml ----------
echo ""
echo "==> 回填 $TOML"
if [ -n "$DB_ID" ]; then
  sed -i.bak "s|database_id = \"REPLACE_WITH_D1_DATABASE_ID\"|database_id = \"$DB_ID\"|" "$TOML"
fi
if [ -n "$KV_ID" ]; then
  # KV 段里的 id = "REPLACE_WITH_KV_NAMESPACE_ID"
  sed -i.bak "s|id = \"REPLACE_WITH_KV_NAMESPACE_ID\"|id = \"$KV_ID\"|" "$TOML"
fi
rm -f "$TOML.bak"

echo ""
echo "==> 校验结果:"
grep -nE 'database_id|^id = |bucket_name' "$TOML" || true

if grep -q "REPLACE_WITH" "$TOML"; then
  echo ""
  echo "[!] 仍有占位符未替换,请手动编辑 $TOML 填入上面的 ID。"
  exit 1
fi

echo ""
echo "完成。接下来:"
echo "  1) 编辑 $TOML,把 RECV_DOMAIN 改成你的收信域名(须已接入 Cloudflare)"
echo "  2) 如需修改默认管理员密码,同样在 $TOML 的 [vars] 里改"
echo "  3) git add -A && git commit && git push origin cloudflarev2  →  自动部署"
