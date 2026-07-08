// D1 数据访问层 - 封装所有 SQL 操作
import type { Env, SafeUser, SafeMailAccount, MailAccountRaw, Alias, Webhook } from './types';
import { sha256, randomHex, maskToken, nowISO, buildAliasFull } from './utils';

const SESSION_TTL_DAYS = 7;
const LOG_RETENTION_DAYS = 30;

// ============ 转换函数 (DB 行 -> 安全对象) ============
interface UserRow {
  id: string; username: string; password: string; api_key: string;
  is_admin: number; created_at: string;
}
interface MailAccountRow {
  id: string; user_id: string; provider: string; email: string;
  access_token: string; refresh_token: string; token_expires_at: string;
  is_public: number; created_at: string;
}
interface AliasRow {
  user_id: string; mail_account_id: string; label: string;
  full: string; updated_at: string;
}
interface SessionRow { token: string; user_id: string; expires_at: string; }
interface LogRow {
  id: number; user_id: string; username: string; target: string;
  action: string; detail: string; created_at: string;
}
interface WebhookRow {
  id: string; user_id: string; mail_account_id: string; target_alias: string | null;
  url: string; secret: string | null; events: string; is_active: number; created_at: string;
}

// 安全邮箱账号(脱敏)
function toSafeMailAccount(row: MailAccountRow): SafeMailAccount {
  return {
    id: row.id,
    provider: row.provider as 'gmail' | 'outlook',
    email: row.email,
    is_public: row.is_public === 1,
    created_at: row.created_at,
    token_masked: maskToken(row.access_token || ''),
  };
}

// 完整用户(含邮箱账号 + 别名) - 脱敏版本
async function toSafeUser(env: Env, row: UserRow): Promise<SafeUser> {
  const accounts = await env.DB.prepare(
    'SELECT * FROM mail_accounts WHERE user_id = ? ORDER BY created_at'
  ).bind(row.id).all<MailAccountRow>();

  const aliasRow = await env.DB.prepare(
    'SELECT * FROM aliases WHERE user_id = ?'
  ).bind(row.id).first<AliasRow>();

  const alias: Alias | null = aliasRow
    ? {
        mail_account_id: aliasRow.mail_account_id,
        label: aliasRow.label,
        full: aliasRow.full,
        updated_at: aliasRow.updated_at,
      }
    : null;

  return {
    id: row.id,
    username: row.username,
    api_key: row.api_key,
    is_admin: row.is_admin === 1,
    mail_accounts: (accounts.results || []).map(toSafeMailAccount),
    alias,
    created_at: row.created_at,
  };
}

// ============ 初始化(默认管理员) ============
export async function initDB(env: Env): Promise<void> {
  const exists = await env.DB.prepare('SELECT id FROM users WHERE username = ?')
    .bind(env.ADMIN_USERNAME).first<{ id: string }>();
  if (exists) return;
  const id = randomHex(4);
  const password = await sha256(env.ADMIN_PASSWORD);
  const apiKey = randomHex(16);
  await env.DB.prepare(
    'INSERT INTO users(id, username, password, api_key, is_admin) VALUES(?,?,?,?,1)'
  ).bind(id, env.ADMIN_USERNAME, password, apiKey).run();
}

// ============ 用户 CRUD ============
export async function getUserById(env: Env, userId: string): Promise<SafeUser | null> {
  const row = await env.DB.prepare('SELECT * FROM users WHERE id = ?')
    .bind(userId).first<UserRow>();
  return row ? toSafeUser(env, row) : null;
}

export async function getUserByUsername(env: Env, username: string): Promise<UserRow | null> {
  return env.DB.prepare('SELECT * FROM users WHERE username = ?')
    .bind(username).first<UserRow>();
}

export async function getUserByApiKey(env: Env, apiKey: string): Promise<SafeUser | null> {
  const row = await env.DB.prepare('SELECT * FROM users WHERE api_key = ?')
    .bind(apiKey).first<UserRow>();
  return row ? toSafeUser(env, row) : null;
}

export async function getUserRawByApiKey(env: Env, apiKey: string): Promise<UserRow | null> {
  return env.DB.prepare('SELECT * FROM users WHERE api_key = ?')
    .bind(apiKey).first<UserRow>();
}

export async function listUsers(env: Env): Promise<SafeUser[]> {
  const { results } = await env.DB.prepare('SELECT * FROM users ORDER BY created_at').all<UserRow>();
  return Promise.all((results || []).map(r => toSafeUser(env, r)));
}

export async function createUser(env: Env, username: string, password: string, isAdmin = false): Promise<SafeUser | null> {
  const existing = await getUserByUsername(env, username);
  if (existing) return null;
  const id = randomHex(4);
  const hashed = await sha256(password);
  const apiKey = randomHex(16);
  await env.DB.prepare(
    'INSERT INTO users(id, username, password, api_key, is_admin) VALUES(?,?,?,?,?)'
  ).bind(id, username, hashed, apiKey, isAdmin ? 1 : 0).run();
  return getUserById(env, id);
}

export async function updateUser(env: Env, userId: string, password?: string, isAdmin?: boolean): Promise<SafeUser | null> {
  if (password !== undefined) {
    const hashed = await sha256(password);
    await env.DB.prepare('UPDATE users SET password = ? WHERE id = ?')
      .bind(hashed, userId).run();
  }
  if (isAdmin !== undefined) {
    await env.DB.prepare('UPDATE users SET is_admin = ? WHERE id = ?')
      .bind(isAdmin ? 1 : 0, userId).run();
  }
  return getUserById(env, userId);
}

export async function deleteUser(env: Env, userId: string): Promise<boolean> {
  if (userId === 'admin') return false;
  const r = await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(userId).run();
  return r.meta.changes > 0;
}

export async function regenerateApiKey(env: Env, userId: string): Promise<SafeUser | null> {
  const apiKey = randomHex(16);
  await env.DB.prepare('UPDATE users SET api_key = ? WHERE id = ?')
    .bind(apiKey, userId).run();
  return getUserById(env, userId);
}

// ============ Session ============
export async function createSession(env: Env, userId: string): Promise<string> {
  const token = randomHex(24);
  const expires = new Date(Date.now() + SESSION_TTL_DAYS * 86400 * 1000).toISOString();
  await env.DB.prepare(
    'INSERT INTO sessions(token, user_id, expires_at) VALUES(?,?,?)'
  ).bind(token, userId, expires).run();
  // KV 缓存加速校验
  await env.KV.put(`sess:${token}`, userId, { expirationTtl: SESSION_TTL_DAYS * 86400 });
  return token;
}

export async function getSessionUser(env: Env, token: string): Promise<SafeUser | null> {
  if (!token) return null;
  // KV 优先
  const cachedUserId = await env.KV.get(`sess:${token}`);
  let userId = cachedUserId;
  if (!userId) {
    const row = await env.DB.prepare(
      'SELECT * FROM sessions WHERE token = ? AND expires_at > ?'
    ).bind(token, nowISO()).first<SessionRow>();
    if (!row) return null;
    userId = row.user_id;
  }
  const user = await getUserById(env, userId);
  if (!user) {
    // 用户已被删除,清掉 session
    await env.KV.delete(`sess:${token}`);
    await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
  }
  return user;
}

export async function deleteSession(env: Env, token: string): Promise<void> {
  await env.KV.delete(`sess:${token}`);
  await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
}

// ============ 邮箱账号 ============
export async function listMailAccounts(env: Env, userId: string): Promise<SafeMailAccount[]> {
  const { results } = await env.DB.prepare(
    'SELECT * FROM mail_accounts WHERE user_id = ? ORDER BY created_at'
  ).bind(userId).all<MailAccountRow>();
  return (results || []).map(toSafeMailAccount);
}

// 原始账号(含解密 token),内部用
export async function getMailAccountRaw(env: Env, userId: string, accountId: string): Promise<MailAccountRaw | null> {
  const row = await env.DB.prepare(
    `SELECT * FROM mail_accounts WHERE id = ? AND (user_id = ? OR is_public = 1)`
  ).bind(accountId, userId).first<MailAccountRow>();
  return row ? (row as unknown as MailAccountRaw) : null;
}

export async function getMailAccountById(env: Env, accountId: string): Promise<MailAccountRaw | null> {
  const row = await env.DB.prepare('SELECT * FROM mail_accounts WHERE id = ?')
    .bind(accountId).first<MailAccountRow>();
  return row ? (row as unknown as MailAccountRaw) : null;
}

// 列出用户可用的邮箱(自己的 + 别人公开的),不含 token
export async function listAvailableAccounts(env: Env, userId: string): Promise<Array<SafeMailAccount & { owner: string; is_own: boolean }>> {
  const { results } = await env.DB.prepare(
    `SELECT ma.*, u.username AS owner_name, u.id AS owner_id
     FROM mail_accounts ma JOIN users u ON ma.user_id = u.id
     WHERE ma.user_id = ? OR ma.is_public = 1
     ORDER BY ma.created_at`
  ).bind(userId).all<MailAccountRow & { owner_name: string; owner_id: string }>();
  return (results || []).map(r => ({
    ...toSafeMailAccount(r),
    owner: r.owner_name,
    is_own: r.owner_id === userId,
  }));
}

// 管理员:列出所有
export async function adminListAllAccounts(env: Env): Promise<Array<SafeMailAccount & { owner_id: string; owner_username: string }>> {
  const { results } = await env.DB.prepare(
    `SELECT ma.*, u.username AS owner_name, u.id AS owner_id
     FROM mail_accounts ma JOIN users u ON ma.user_id = u.id
     ORDER BY u.username, ma.created_at`
  ).all<MailAccountRow & { owner_name: string; owner_id: string }>();
  return (results || []).map(r => ({
    ...toSafeMailAccount(r),
    owner_id: r.owner_id,
    owner_username: r.owner_name,
  }));
}

// 新增账号(OAuth 绑定后调用)
export async function addMailAccount(
  env: Env, userId: string, provider: 'gmail' | 'outlook', email: string,
  accessToken: string, refreshToken: string, expiresAt: string, isPublic = false
): Promise<void> {
  const prefix = provider === 'gmail' ? 'g' : 'm';
  const id = prefix + randomHex(4);
  await env.DB.prepare(
    `INSERT INTO mail_accounts(id, user_id, provider, email, access_token, refresh_token, token_expires_at, is_public)
     VALUES(?,?,?,?,?,?,?,?)`
  ).bind(id, userId, provider, email, accessToken, refreshToken, expiresAt, isPublic ? 1 : 0).run();
}

export async function updateMailAccountToken(
  env: Env, accountId: string, accessToken: string, refreshToken: string, expiresAt: string
): Promise<void> {
  await env.DB.prepare(
    'UPDATE mail_accounts SET access_token = ?, refresh_token = ?, token_expires_at = ? WHERE id = ?'
  ).bind(accessToken, refreshToken, expiresAt, accountId).run();
}

export async function updateMailAccount(env: Env, userId: string, accountId: string, isPublic?: boolean): Promise<void> {
  if (isPublic !== undefined) {
    await env.DB.prepare('UPDATE mail_accounts SET is_public = ? WHERE id = ? AND user_id = ?')
      .bind(isPublic ? 1 : 0, accountId, userId).run();
  }
}

export async function adminUpdateMailAccount(env: Env, accountId: string, isPublic?: boolean): Promise<void> {
  if (isPublic !== undefined) {
    await env.DB.prepare('UPDATE mail_accounts SET is_public = ? WHERE id = ?')
      .bind(isPublic ? 1 : 0, accountId).run();
  }
}

export async function deleteMailAccount(env: Env, userId: string, accountId: string): Promise<boolean> {
  const r = await env.DB.prepare('DELETE FROM mail_accounts WHERE id = ? AND user_id = ?')
    .bind(accountId, userId).run();
  if (r.meta.changes > 0) {
    // 关联别名清除
    await env.DB.prepare('DELETE FROM aliases WHERE mail_account_id = ?').bind(accountId).run();
    return true;
  }
  return false;
}

export async function adminDeleteMailAccount(env: Env, accountId: string): Promise<boolean> {
  const r = await env.DB.prepare('DELETE FROM mail_accounts WHERE id = ?').bind(accountId).run();
  if (r.meta.changes > 0) {
    await env.DB.prepare('DELETE FROM aliases WHERE mail_account_id = ?').bind(accountId).run();
    return true;
  }
  return false;
}

// ============ 别名 ============
export async function getAlias(env: Env, userId: string): Promise<Alias | null> {
  const row = await env.DB.prepare('SELECT * FROM aliases WHERE user_id = ?')
    .bind(userId).first<AliasRow>();
  return row ? { mail_account_id: row.mail_account_id, label: row.label, full: row.full, updated_at: row.updated_at } : null;
}

export async function setAlias(env: Env, userId: string, mailAccountId: string, label: string): Promise<{ alias: Alias | null; err?: string }> {
  // 校验邮箱可用(自己或公开)
  const account = await env.DB.prepare(
    'SELECT * FROM mail_accounts WHERE id = ? AND (user_id = ? OR is_public = 1)'
  ).bind(mailAccountId, userId).first<MailAccountRow>();
  if (!account) return { alias: null, err: '未找到指定的邮箱或无权使用' };

  const full = buildAliasFull(account.email, label);
  if (!full) return { alias: null, err: '别名生成失败,邮箱格式错误' };

  await env.DB.prepare(
    `INSERT INTO aliases(user_id, mail_account_id, label, full, updated_at) VALUES(?,?,?,?,?)
     ON CONFLICT(user_id) DO UPDATE SET mail_account_id=excluded.mail_account_id, label=excluded.label, full=excluded.full, updated_at=excluded.updated_at`
  ).bind(userId, mailAccountId, label, full, nowISO()).run();

  const alias = await getAlias(env, userId);
  return { alias };
}

export async function clearAlias(env: Env, userId: string): Promise<void> {
  await env.DB.prepare('DELETE FROM aliases WHERE user_id = ?').bind(userId).run();
}

// ============ 使用日志 ============
export async function addLog(env: Env, userId: string, username: string, target: string, action: string, detail: string): Promise<void> {
  await env.DB.prepare(
    'INSERT INTO usage_logs(user_id, username, target, action, detail) VALUES(?,?,?,?,?)'
  ).bind(userId, username, target, action, detail).run();
  // 顺便清理过期(每次写入触发,简单高效)
  const cutoff = new Date(Date.now() - LOG_RETENTION_DAYS * 86400 * 1000).toISOString();
  await env.DB.prepare('DELETE FROM usage_logs WHERE created_at < ?').bind(cutoff).run();
}

export async function listLogs(env: Env, limit = 500): Promise<LogRow[]> {
  const { results } = await env.DB.prepare(
    'SELECT * FROM usage_logs ORDER BY created_at DESC LIMIT ?'
  ).bind(limit).all<LogRow>();
  return results || [];
}

export async function statsSummary(env: Env): Promise<{ total_calls: number; by_user: Record<string, number>; by_alias: Record<string, number> }> {
  const logs = await listLogs(env, 10000);
  const byUser: Record<string, number> = {};
  const byAlias: Record<string, number> = {};
  for (const l of logs) {
    byUser[l.username] = (byUser[l.username] || 0) + 1;
    const a = l.target || '(无别名)';
    byAlias[a] = (byAlias[a] || 0) + 1;
  }
  return { total_calls: logs.length, by_user: byUser, by_alias: byAlias };
}

// ============ Webhook ============
export async function createWebhook(
  env: Env, userId: string, mailAccountId: string, targetAlias: string | null,
  url: string, secret: string | null, events: string
): Promise<string> {
  const id = 'w' + randomHex(4);
  await env.DB.prepare(
    `INSERT INTO webhooks(id, user_id, mail_account_id, target_alias, url, secret, events, is_active)
     VALUES(?,?,?,?,?,?,?,1)`
  ).bind(id, userId, mailAccountId, targetAlias, url, secret, events).run();
  return id;
}

export async function listWebhooks(env: Env, userId: string): Promise<Webhook[]> {
  const { results } = await env.DB.prepare(
    'SELECT * FROM webhooks WHERE user_id = ? ORDER BY created_at DESC'
  ).bind(userId).all<WebhookRow>();
  return (results || []).map(r => ({
    id: r.id, user_id: r.user_id, mail_account_id: r.mail_account_id,
    target_alias: r.target_alias, url: r.url, secret: r.secret,
    events: r.events, is_active: r.is_active === 1, created_at: r.created_at,
  }));
}

export async function deleteWebhook(env: Env, id: string, userId: string): Promise<boolean> {
  const r = await env.DB.prepare('DELETE FROM webhooks WHERE id = ? AND user_id = ?')
    .bind(id, userId).run();
  return r.meta.changes > 0;
}

// 按邮箱账号查所有活跃订阅(系统推送时用)
export async function getWebhooksForAccount(env: Env, mailAccountId: string): Promise<Webhook[]> {
  const { results } = await env.DB.prepare(
    'SELECT * FROM webhooks WHERE mail_account_id = ? AND is_active = 1'
  ).bind(mailAccountId).all<WebhookRow>();
  return (results || []).map(r => ({
    id: r.id, user_id: r.user_id, mail_account_id: r.mail_account_id,
    target_alias: r.target_alias, url: r.url, secret: r.secret,
    events: r.events, is_active: r.is_active === 1, created_at: r.created_at,
  }));
}

export async function toggleWebhook(env: Env, id: string, userId: string, active: boolean): Promise<boolean> {
  const r = await env.DB.prepare('UPDATE webhooks SET is_active = ? WHERE id = ? AND user_id = ?')
    .bind(active ? 1 : 0, id, userId).run();
  return r.meta.changes > 0;
}

export async function logWebhookDelivery(env: Env, webhookId: string, payload: string, status: number, response: string, success: boolean): Promise<void> {
  await env.DB.prepare(
    'INSERT INTO webhook_deliveries(webhook_id, payload, status, response, success) VALUES(?,?,?,?,?)'
  ).bind(webhookId, payload, status, response.slice(0, 500), success ? 1 : 0).run();
}

// ============ 设置 ============
export async function getSetting(env: Env, key: string): Promise<string | null> {
  const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

export async function setSetting(env: Env, key: string, value: string): Promise<void> {
  await env.DB.prepare(
    'INSERT INTO settings(key, value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
  ).bind(key, value).run();
}
