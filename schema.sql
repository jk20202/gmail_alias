-- D1 数据库 schema (SQLite) —— mail-alias v2 邮件转发聚合版
-- 用法: npx wrangler d1 execute mail_alias_v2 --remote --file=./schema.sql
-- 说明: 首次部署执行一次即可。后续升级由代码内 ensureSchema() 自动 ALTER 补齐,无需手工执行。

-- ============ 用户表 ============
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,                  -- 短ID
  username      TEXT UNIQUE NOT NULL,
  password      TEXT NOT NULL,                     -- SHA256
  api_key       TEXT UNIQUE NOT NULL,              -- hex
  is_admin      INTEGER NOT NULL DEFAULT 0,        -- 0/1
  disabled      INTEGER NOT NULL DEFAULT 0,        -- 0=正常 1=禁用(管理员可禁用用户)
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============ 邮箱账号表 ============
-- v2: 绑定邮箱无需授权,只登记主邮箱地址 + 系统分配的专属转发地址。
CREATE TABLE IF NOT EXISTS mail_accounts (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL,                  -- 所属用户
  provider         TEXT NOT NULL DEFAULT 'forward',-- v2 统一为 'forward'(邮件转发)
  email            TEXT NOT NULL,                  -- 主邮箱地址
  -- 专属转发地址:用户在原邮箱设置「自动转发」到该地址,系统据此判定邮件归属
  forward_address  TEXT,
  -- 是否支持别名:0=不支持(默认,只能直接选中该邮箱收信) 1=支持(可按别名规则生成别名)
  supports_alias   INTEGER NOT NULL DEFAULT 0,
  alias_template   TEXT,                           -- 别名规则模板 {local}/{domain}/{label}
  notes            TEXT,                           -- 用户备注
  is_public        INTEGER NOT NULL DEFAULT 0,     -- 是否公开给其他用户使用
  -- 以下为 v1(OAuth/IMAP)遗留列,保留仅为兼容旧数据,v2 不使用
  access_token     TEXT NOT NULL DEFAULT '',
  refresh_token    TEXT NOT NULL DEFAULT '',
  token_expires_at TEXT NOT NULL DEFAULT '',
  imap_host        TEXT,
  imap_port        INTEGER,
  imap_user        TEXT,
  imap_pass        TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_mail_accounts_user ON mail_accounts(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_mail_accounts_forward ON mail_accounts(forward_address);

-- ============ 别名表(每用户可有多个,1小时有效期) ============
CREATE TABLE IF NOT EXISTS user_aliases (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL,
  mail_account_id TEXT NOT NULL,
  label           TEXT NOT NULL,
  full            TEXT NOT NULL,                   -- 完整别名地址,如 me+shop@gmail.com
  is_favorite     INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'active',  -- active / expired / archived
  expires_at      TEXT,
  last_used_at    TEXT NOT NULL,
  created_at      TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_aliases_unique ON user_aliases(user_id, full);
CREATE INDEX IF NOT EXISTS idx_user_aliases_user ON user_aliases(user_id, status);
CREATE INDEX IF NOT EXISTS idx_user_aliases_used ON user_aliases(user_id, last_used_at);

-- ============ 已接收邮件 ============
-- 只存「元数据 + R2 对象 key」,不存正文:
-- 正文/附件由前端下载 raw 后用 postal-mime 在浏览器解析,
-- 这样 Worker 完全不做 MIME 解析,不会触碰免费套餐 10ms CPU 上限。
CREATE TABLE IF NOT EXISTS emails (
  id              TEXT PRIMARY KEY,
  account_id      TEXT NOT NULL,                   -- 所属邮箱
  alias_id        TEXT,                            -- 命中的别名(直接投到主邮箱时为 NULL)
  message_id      TEXT,                            -- Message-ID,用于重复收信去重
  subject         TEXT,
  from_name       TEXT,
  from_address    TEXT,
  delivered_to    TEXT,                            -- 实际命中的收件地址
  recipient       TEXT,                            -- To 原文
  cc              TEXT,
  sent_at         INTEGER NOT NULL DEFAULT 0,      -- UTC 秒级时间戳
  size            INTEGER NOT NULL DEFAULT 0,      -- raw 字节数
  raw_key         TEXT,                            -- R2 对象 key
  has_attachments INTEGER NOT NULL DEFAULT 0,      -- 由头部推断,精确列表由前端解析
  read            INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_emails_account_sent ON emails(account_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_emails_alias_sent ON emails(alias_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_emails_account_read ON emails(account_id, read);

-- ============ Session 表(会话) ============
CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- ============ 使用日志 ============
CREATE TABLE IF NOT EXISTS usage_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT NOT NULL,
  username   TEXT NOT NULL,
  target     TEXT,
  action     TEXT NOT NULL,
  detail     TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_logs_user ON usage_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_logs_action ON usage_logs(action);
CREATE INDEX IF NOT EXISTS idx_logs_created ON usage_logs(created_at);

-- ============ Webhook 订阅 ============
CREATE TABLE IF NOT EXISTS webhooks (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  mail_account_id TEXT NOT NULL,
  target_alias TEXT,                                -- 仅匹配此别名(空=全部)
  url          TEXT NOT NULL,
  secret       TEXT,                                -- 签名密钥(HMAC-SHA256)
  events       TEXT NOT NULL,                       -- 逗号分隔: new_mail,unread
  format       TEXT NOT NULL DEFAULT 'card',        -- card | markdown | text | json
  is_active    INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (mail_account_id) REFERENCES mail_accounts(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_webhooks_account ON webhooks(mail_account_id);
CREATE INDEX IF NOT EXISTS idx_webhooks_user ON webhooks(user_id);

-- ============ Webhook 推送记录 ============
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  webhook_id TEXT NOT NULL,
  payload    TEXT NOT NULL,
  status     INTEGER,
  response   TEXT,
  success    INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (webhook_id) REFERENCES webhooks(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_deliveries_webhook ON webhook_deliveries(webhook_id);

-- ============ 系统设置 ============
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT OR IGNORE INTO settings(key, value) VALUES('allow_registration', 'true');
