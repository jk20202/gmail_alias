-- D1 数据库 schema (SQLite)
-- 用法: wrangler d1 execute mail_alias --remote --file=./schema.sql

-- ============ 用户表 ============
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,                  -- 8位短ID
  username      TEXT UNIQUE NOT NULL,
  password      TEXT NOT NULL,                     -- SHA256
  api_key       TEXT UNIQUE NOT NULL,              -- 32位hex
  is_admin      INTEGER NOT NULL DEFAULT 0,        -- 0/1
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============ 邮箱账号表 (OAuth 绑定) ============
CREATE TABLE IF NOT EXISTS mail_accounts (
  id               TEXT PRIMARY KEY,               -- g+8位 / m+8位
  user_id          TEXT NOT NULL,                  -- 所属用户
  provider         TEXT NOT NULL,                  -- 'gmail' | 'outlook'
  email            TEXT NOT NULL,                  -- 邮箱地址
  access_token     TEXT NOT NULL,                  -- OAuth access_token (加密)
  refresh_token    TEXT NOT NULL,                  -- OAuth refresh_token (加密)
  token_expires_at TEXT NOT NULL,                  -- ISO 时间
  is_public        INTEGER NOT NULL DEFAULT 0,     -- 是否公开给其他用户
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_mail_accounts_user ON mail_accounts(user_id);

-- =别名表 (每用户最多一个,关联到 mail_account) ============
CREATE TABLE IF NOT EXISTS aliases (
  user_id          TEXT PRIMARY KEY,                -- 一用户一别名
  mail_account_id  TEXT NOT NULL,
  label            TEXT NOT NULL,
  full             TEXT NOT NULL,                   -- prefix+label@domain
  updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (mail_account_id) REFERENCES mail_accounts(id) ON DELETE CASCADE
);

-- ============ Session 表 (会话,KV 备份) ============
CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- ============ 使用日志 (30天保留) ============
CREATE TABLE IF NOT EXISTS usage_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT NOT NULL,
  username   TEXT NOT NULL,
  target     TEXT,                                 -- 查询的别名/邮箱
  action     TEXT NOT NULL,                         -- fetch_emails / mark_read / set_alias / ...
  detail     TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_logs_user ON usage_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_logs_action ON usage_logs(action);
CREATE INDEX IF NOT EXISTS idx_logs_created ON usage_logs(created_at);

-- ============ Webhook 订阅 ============
CREATE TABLE IF NOT EXISTS webhooks (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,                       -- 订阅归属
  mail_account_id TEXT NOT NULL,                    -- 监听哪个邮箱
  target_alias TEXT,                                -- 仅匹配此别名(空=全部)
  url          TEXT NOT NULL,                       -- 推送地址
  secret       TEXT,                                 -- 签名密钥(HMAC-SHA256)
  events       TEXT NOT NULL,                        -- 逗号分隔: new_mail,unread
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
  payload    TEXT NOT NULL,                          -- JSON 字符串
  status     INTEGER,                               -- HTTP 状态码
  response   TEXT,                                  -- 响应体(截断)
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

-- ============ 触发器:别名的 full 自动维护 ============
CREATE TRIGGER IF NOT EXISTS trg_alias_updated
AFTER UPDATE ON aliases
BEGIN
  UPDATE aliases SET updated_at = datetime('now') WHERE user_id = NEW.user_id;
END;
