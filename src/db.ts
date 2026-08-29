// D1 数据访问层 - 封装所有 SQL 操作
import type { Env, SafeUser, SafeMailAccount, MailAccountRaw, Alias, Webhook, UserAlias } from './types';
import { sha256, randomHex, maskToken, nowISO, buildAliasFull, decrypt, encrypt, splitEmail, isAliasUnsupportedDomain } from './utils';

const SESSION_TTL_DAYS = 7;
const LOG_RETENTION_DAYS = 30;
const LOG_MAX_RECORDS = 20000; // 日志最大记录数,超过则舍弃旧的

// ============ 多别名业务常量 ============
export const MAX_ACTIVE_ALIASES = 5;            // 每用户同时生效的别名上限
export const ALIAS_TTL_MS = 60 * 60 * 1000;     // 别名有效期 1 小时
export const ALIAS_HISTORY_KEEP = 30;           // 非收藏别名最多保留条数(历史列表 3 页 x 10 条)
export const ALIAS_HISTORY_PAGE_SIZE = 10;

// ============ Schema 版本迁移 ============
// Cloudflare 自动部署只跑 wrangler deploy,不会执行 schema.sql,
// 因此这里做运行时的一次性迁移(用 KV 记录版本号,避免每次请求都跑 DDL)
// 注意: 每次新增列 / 表,必须 +1 本版本号,否则 ensureSchema 会因 KV 已记录旧版本而直接返回,
// 导致新迁移(如 users.google_client_id)在生产环境永远不执行。
const SCHEMA_VERSION = '5';

export async function ensureSchema(env: Env): Promise<void> {
  try {
    const cur = await env.KV.get('schema_version');
    if (cur === SCHEMA_VERSION) return;
  } catch {
    return; // KV 不可用时不阻塞请求
  }

  const ddl: string[] = [
    // 多别名表:一个用户可同时拥有多个别名,支持收藏/过期/历史
    `CREATE TABLE IF NOT EXISTS user_aliases (
      id              TEXT PRIMARY KEY,
      user_id         TEXT NOT NULL,
      mail_account_id TEXT NOT NULL,
      label           TEXT NOT NULL,
      full            TEXT NOT NULL,
      is_favorite     INTEGER NOT NULL DEFAULT 0,
      status          TEXT NOT NULL DEFAULT 'active',
      expires_at      TEXT,
      last_used_at    TEXT NOT NULL,
      created_at      TEXT NOT NULL
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_user_aliases_unique
       ON user_aliases(user_id, full)`,
    `CREATE INDEX IF NOT EXISTS idx_user_aliases_user
       ON user_aliases(user_id, status)`,
    `CREATE INDEX IF NOT EXISTS idx_user_aliases_used
       ON user_aliases(user_id, last_used_at)`,
  ];
  for (const sql of ddl) {
    try { await env.DB.prepare(sql).run(); } catch { /* 已存在则忽略 */ }
  }

  // webhooks 增加推送格式字段(旧库无此列,失败即说明已存在)
  try {
    await env.DB.prepare(`ALTER TABLE webhooks ADD COLUMN format TEXT NOT NULL DEFAULT 'card'`).run();
  } catch { /* 列已存在 */ }

  // mail_accounts 增加 IMAP(应用密码)绑定字段(旧库无此列,失败即说明已存在)
  // 全部可空: OAuth 账号不受影响; IMAP 账号用前四项, access_token 等留空字符串
  for (const col of [
    'ALTER TABLE mail_accounts ADD COLUMN imap_host TEXT',
    'ALTER TABLE mail_accounts ADD COLUMN imap_port INTEGER',
    'ALTER TABLE mail_accounts ADD COLUMN imap_user TEXT',
    'ALTER TABLE mail_accounts ADD COLUMN imap_pass TEXT',
  ]) {
    try { await env.DB.prepare(col).run(); } catch { /* 列已存在 */ }
  }

  // users 表增加 per-user Google OAuth 凭据(每个用户自行填写,与系统设置完全解耦)
  // 这样普通用户在「绑定 Gmail」弹窗内即可填写 / 修改自己的 Client ID / Secret,
  // 不会因一次填错而被全局配置卡死,也无需进入系统设置
  for (const col of [
    'ALTER TABLE users ADD COLUMN google_client_id TEXT',
    'ALTER TABLE users ADD COLUMN google_client_secret TEXT',
  ]) {
    try { await env.DB.prepare(col).run(); } catch { /* 列已存在 */ }
  }

  // mail_accounts 增加「别名规则模板」(per-account 别名生成规则,支持 {local}/{domain}/{label})
  // 不同邮箱服务商别名形式不同: 微软 / 2925 用加号,部分自建域名用 catch-all;
  // 该列允许每个绑定账号单独配置,打破此前全局硬编码 "+" 的限制。
  try {
    await env.DB.prepare('ALTER TABLE mail_accounts ADD COLUMN alias_template TEXT').run();
  } catch { /* 列已存在 */ }

  // mail_accounts 增加「用户备注」列(编辑弹窗里给邮箱加备注用,如"工作邮箱/主收信箱")
  try {
    await env.DB.prepare('ALTER TABLE mail_accounts ADD COLUMN notes TEXT').run();
  } catch { /* 列已存在 */ }

  // 迁移旧版单别名数据 -> user_aliases(给 1 小时有效期,避免一升级就全部过期)
  // 注意:时间统一用 JS 生成的 ISO 字符串,不能用 SQLite 的 datetime('now')(格式不同会导致比较失效)
  try {
    const iso = nowISO();
    const exp = new Date(Date.now() + ALIAS_TTL_MS).toISOString();
    await env.DB.prepare(
      `INSERT OR IGNORE INTO user_aliases
         (id, user_id, mail_account_id, label, full, is_favorite, status, expires_at, last_used_at, created_at)
       SELECT lower(hex(randomblob(6))), a.user_id, a.mail_account_id, a.label, a.full, 0, 'active',
              ?, ?, ?
       FROM aliases a`
    ).bind(exp, iso, iso).run();
  } catch { /* 旧表不存在则跳过 */ }

  try {
    await env.KV.put('schema_version', SCHEMA_VERSION);
  } catch { /* ignore */ }
}

// ============ 转换函数 (DB 行 -> 安全对象) ============
interface UserRow {
  id: string; username: string; password: string; api_key: string;
  is_admin: number; disabled: number; created_at: string;
}
interface MailAccountRow {
  id: string; user_id: string; provider: string; email: string;
  access_token: string; refresh_token: string; token_expires_at: string;
  is_public: number; created_at: string;
  imap_host?: string | null; imap_port?: number | null;
  imap_user?: string | null; imap_pass?: string | null;
  alias_template?: string | null;
  notes?: string | null;
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
  format?: string | null;
}
interface UserAliasRow {
  id: string; user_id: string; mail_account_id: string; label: string; full: string;
  is_favorite: number; status: string; expires_at: string | null; last_used_at: string; created_at: string;
}

// 安全邮箱账号(脱敏)
function toSafeMailAccount(row: MailAccountRow): SafeMailAccount {
  const provider = row.provider as 'gmail' | 'outlook' | 'imap';
  return {
    id: row.id,
    provider,
    email: row.email,
    is_public: row.is_public === 1,
    created_at: row.created_at,
    // IMAP(应用密码)绑定: 有密文即视为已配置,但绝不回显明文/密文
    token_masked: provider === 'imap'
      ? (row.imap_pass ? '应用密码' : '')
      : maskToken(row.access_token || ''),
    // 别名规则模板 / 备注 / IMAP 连接(供前端编辑弹窗预填;不含密码)
    alias_template: row.alias_template || null,
    notes: row.notes || '',
    imap_host: row.imap_host || null,
    imap_port: row.imap_port || null,
  };
}

// 完整用户(含邮箱账号 + 别名) - 脱敏版本
async function toSafeUser(env: Env, row: UserRow): Promise<SafeUser> {
  const accounts = await env.DB.prepare(
    'SELECT * FROM mail_accounts WHERE user_id = ? ORDER BY created_at'
  ).bind(row.id).all<MailAccountRow>();

  // 主别名:优先取 user_aliases 中生效的第一个,没有则回退旧 aliases 表(平滑过渡)
  const activeRow = await env.DB.prepare(
    `SELECT ua.*, ma.email, ma.provider
       FROM user_aliases ua JOIN mail_accounts ma ON ma.id = ua.mail_account_id
      WHERE ua.user_id = ? AND ua.status = 'active'
      ORDER BY ua.is_favorite DESC, ua.last_used_at DESC LIMIT 1`
  ).bind(row.id).first<UserAliasRow & { email: string; provider: string }>();

  let alias: Alias | null = null;
  if (activeRow) {
    alias = {
      mail_account_id: activeRow.mail_account_id,
      label: activeRow.label,
      full: activeRow.full,
      updated_at: activeRow.last_used_at,
    };
  } else {
    const aliasRow = await env.DB.prepare(
      'SELECT * FROM aliases WHERE user_id = ?'
    ).bind(row.id).first<AliasRow>();
    if (aliasRow) {
      alias = {
        mail_account_id: aliasRow.mail_account_id,
        label: aliasRow.label,
        full: aliasRow.full,
        updated_at: aliasRow.updated_at,
      };
    }
  }

  const cntRow = await env.DB.prepare(
    `SELECT COUNT(*) AS cnt FROM user_aliases WHERE user_id = ? AND status = 'active'`
  ).bind(row.id).first<{ cnt: number }>();

  return {
    id: row.id,
    username: row.username,
    api_key: row.api_key,
    is_admin: row.is_admin === 1,
    disabled: row.disabled === 1,
    mail_accounts: (accounts.results || []).map(toSafeMailAccount),
    alias,
    active_alias_count: cntRow?.cnt || 0,
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

// ---- 轻量用户查询(热路径优化) ----
// toSafeUser() 内部有 3 次关联查询(mail_accounts / 主别名 / 别名计数),
// 每个请求都跑会显著拖慢响应。绝大多数接口其实只需要 id / username / is_admin,
// 因此这里提供一个不带关联数据的版本,并加 isolate 级内存缓存。
export interface BasicUser {
  id: string;
  username: string;
  is_admin: boolean;
  disabled: boolean;
  created_at: string;
}

const userCache = new Map<string, { user: BasicUser; ts: number }>();
const USER_CACHE_TTL = 30_000; // 30 秒

export async function getUserBasic(env: Env, userId: string): Promise<BasicUser | null> {
  const hit = userCache.get(userId);
  if (hit && Date.now() - hit.ts < USER_CACHE_TTL) return hit.user;
  const row = await env.DB.prepare(
    'SELECT id, username, is_admin, disabled, created_at FROM users WHERE id = ?'
  ).bind(userId).first<{ id: string; username: string; is_admin: number; disabled: number; created_at: string }>();
  if (!row) return null;
  const user: BasicUser = {
    id: row.id,
    username: row.username,
    is_admin: row.is_admin === 1,
    disabled: row.disabled === 1,
    created_at: row.created_at,
  };
  userCache.set(userId, { user, ts: Date.now() });
  return user;
}

// 用户信息变更后调用,避免读到旧缓存
export function invalidateUserCache(userId: string): void {
  userCache.delete(userId);
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

// 更新用户: 支持用户名/密码/管理员/禁用状态 (管理员编辑功能)
export async function updateUser(env: Env, userId: string, opts: {
  username?: string; password?: string; isAdmin?: boolean; disabled?: boolean;
}): Promise<SafeUser | null> {
  if (opts.username !== undefined) {
    await env.DB.prepare('UPDATE users SET username = ? WHERE id = ?')
      .bind(opts.username, userId).run();
  }
  if (opts.password !== undefined) {
    const hashed = await sha256(opts.password);
    await env.DB.prepare('UPDATE users SET password = ? WHERE id = ?')
      .bind(hashed, userId).run();
  }
  if (opts.isAdmin !== undefined) {
    await env.DB.prepare('UPDATE users SET is_admin = ? WHERE id = ?')
      .bind(opts.isAdmin ? 1 : 0, userId).run();
  }
  if (opts.disabled !== undefined) {
    await env.DB.prepare('UPDATE users SET disabled = ? WHERE id = ?')
      .bind(opts.disabled ? 1 : 0, userId).run();
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

// 热路径最轻量版:只把 session 解析成 userId,不做用户表查询。
// KV 未命中时查一次 D1 并回填 KV(与会话有效期一致),后续请求即可零 D1 命中。
export async function getSessionUserId(env: Env, token: string): Promise<string | null> {
  if (!token) return null;
  const cachedUserId = await env.KV.get(`sess:${token}`);
  if (cachedUserId) return cachedUserId;
  const row = await env.DB.prepare(
    'SELECT user_id FROM sessions WHERE token = ? AND expires_at > ?'
  ).bind(token, nowISO()).first<{ user_id: string }>();
  if (!row) return null;
  await env.KV.put(`sess:${token}`, row.user_id, { expirationTtl: SESSION_TTL_DAYS * 86400 });
  return row.user_id;
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

// 按 user + provider + email 查询(用于 OAuth 重新授权时 upsert,避免重复绑定)
export async function getMailAccountByUserAndEmail(env: Env, userId: string, provider: string, email: string): Promise<MailAccountRow | null> {
  return env.DB.prepare(
    'SELECT * FROM mail_accounts WHERE user_id = ? AND provider = ? AND email = ?'
  ).bind(userId, provider, email).first<MailAccountRow>();
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
  accessToken: string, refreshToken: string, expiresAt: string, isPublic = false,
  aliasTemplate?: string | null
): Promise<void> {
  const prefix = provider === 'gmail' ? 'g' : 'm';
  const id = prefix + randomHex(4);
  await env.DB.prepare(
    `INSERT INTO mail_accounts(id, user_id, provider, email, access_token, refresh_token, token_expires_at, is_public, alias_template)
     VALUES(?,?,?,?,?,?,?,?,?)`
  ).bind(id, userId, provider, email, accessToken, refreshToken, expiresAt, isPublic ? 1 : 0, aliasTemplate || null).run();
}

export async function updateMailAccountToken(
  env: Env, accountId: string, accessToken: string, refreshToken: string, expiresAt: string
): Promise<void> {
  await env.DB.prepare(
    'UPDATE mail_accounts SET access_token = ?, refresh_token = ?, token_expires_at = ? WHERE id = ?'
  ).bind(accessToken, refreshToken, expiresAt, accountId).run();
}

// ============ IMAP(应用密码)绑定 ============
// 解密后的 IMAP 连接配置(内部使用)
export interface ImapConfig {
  id: string;
  user_id: string;
  email: string;
  host: string;
  port: number;
  username: string;
  password: string;      // 已解密
  is_public: boolean;
}

// 新增或更新 IMAP 账号(按 user_id + provider('imap') + email upsert)
// imap_pass 为已加密字符串; access_token/refresh_token/token_expires_at 对 IMAP 无意义,留空
// aliasTemplate: 该账号的别名生成规则(留空则用默认加号形式)
export async function addImapAccount(
  env: Env, userId: string, email: string,
  imapHost: string, imapPort: number, imapUser: string, encPass: string, isPublic = false,
  aliasTemplate?: string | null
): Promise<string> {
  const existing = await env.DB.prepare(
    'SELECT * FROM mail_accounts WHERE user_id = ? AND provider = ? AND email = ?'
  ).bind(userId, 'imap', email).first<MailAccountRow>();
  if (existing) {
    await env.DB.prepare(
      `UPDATE mail_accounts
          SET imap_host = ?, imap_port = ?, imap_user = ?, imap_pass = ?, is_public = ?, alias_template = ?
        WHERE id = ?`
    ).bind(imapHost, imapPort, imapUser, encPass, isPublic ? 1 : 0, aliasTemplate || null, existing.id).run();
    return existing.id;
  }
  const id = 'i' + randomHex(4);
  await env.DB.prepare(
    `INSERT INTO mail_accounts
       (id, user_id, provider, email, access_token, refresh_token, token_expires_at, is_public, imap_host, imap_port, imap_user, imap_pass, alias_template)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    id, userId, 'imap', email, '', '', '', isPublic ? 1 : 0,
    imapHost, imapPort, imapUser, encPass, aliasTemplate || null
  ).run();
  return id;
}

// 取 IMAP 账号连接配置(解密 imap_pass); 不存在或字段不全返回 null
export async function getImapAccountById(env: Env, accountId: string): Promise<ImapConfig | null> {
  const row = await env.DB.prepare(
    `SELECT id, user_id, email, imap_host, imap_port, imap_user, imap_pass, is_public
       FROM mail_accounts WHERE id = ?`
  ).bind(accountId).first<{
    id: string; user_id: string; email: string;
    imap_host: string | null; imap_port: number | null;
    imap_user: string | null; imap_pass: string | null; is_public: number;
  }>();
  if (!row || !row.imap_host || !row.imap_pass) return null;
  let password = '';
  try { password = await decrypt(row.imap_pass, env); }
  catch { return null; }
  return {
    id: row.id,
    user_id: row.user_id,
    email: row.email,
    host: row.imap_host,
    port: row.imap_port || 993,
    username: row.imap_user || row.email,
    password,
    is_public: row.is_public === 1,
  };
}

export async function updateMailAccount(env: Env, userId: string, accountId: string, isPublic?: boolean): Promise<void> {
  if (isPublic !== undefined) {
    await env.DB.prepare('UPDATE mail_accounts SET is_public = ? WHERE id = ? AND user_id = ?')
      .bind(isPublic ? 1 : 0, accountId, userId).run();
  }
}

// 更新邮箱的「别名规则模板 / 备注」等配置(不涉及重新授权)
// 仅改这两项时前端走 PATCH,无需重走连接/授权流程
export async function updateMailAccountConfig(
  env: Env, userId: string, accountId: string,
  opts: { aliasTemplate?: string | null; notes?: string | null },
): Promise<void> {
  const sets: string[] = [];
  const binds: any[] = [];
  if (opts.aliasTemplate !== undefined) { sets.push('alias_template = ?'); binds.push(opts.aliasTemplate || null); }
  if (opts.notes !== undefined) { sets.push('notes = ?'); binds.push(opts.notes || null); }
  if (!sets.length) return;
  binds.push(accountId, userId);
  await env.DB.prepare(`UPDATE mail_accounts SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`)
    .bind(...binds).run();
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
    await env.DB.prepare('DELETE FROM user_aliases WHERE mail_account_id = ?').bind(accountId).run();
    return true;
  }
  return false;
}

export async function adminDeleteMailAccount(env: Env, accountId: string): Promise<boolean> {
  const r = await env.DB.prepare('DELETE FROM mail_accounts WHERE id = ?').bind(accountId).run();
  if (r.meta.changes > 0) {
    await env.DB.prepare('DELETE FROM aliases WHERE mail_account_id = ?').bind(accountId).run();
    await env.DB.prepare('DELETE FROM user_aliases WHERE mail_account_id = ?').bind(accountId).run();
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

  // 不支持别名收信的域名(QQ/163 等): 绑定可读信,但禁止创建别名
  const accDomain = splitEmail(account.email).domain;
  if (isAliasUnsupportedDomain(accDomain)) {
    return { alias: null, err: '该邮箱域名不支持别名收信,无法创建别名(仅可读取该收件箱)' };
  }

  const full = buildAliasFull(account.email, label, account.alias_template || null);
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

// 管理员为指定用户设置别名 (复用 setAlias 逻辑,不校验所有权,由调用方保证邮箱存在)
export async function adminSetAlias(env: Env, userId: string, mailAccountId: string, label: string): Promise<{ alias: Alias | null; err?: string }> {
  const account = await env.DB.prepare('SELECT * FROM mail_accounts WHERE id = ?').bind(mailAccountId).first<MailAccountRow>();
  if (!account) return { alias: null, err: '未找到指定的邮箱' };
  const full = buildAliasFull(account.email, label, account.alias_template || null);
  if (!full) return { alias: null, err: '别名生成失败,邮箱格式错误' };
  await env.DB.prepare(
    `INSERT INTO aliases(user_id, mail_account_id, label, full, updated_at) VALUES(?,?,?,?,?)
     ON CONFLICT(user_id) DO UPDATE SET mail_account_id=excluded.mail_account_id, label=excluded.label, full=excluded.full, updated_at=excluded.updated_at`
  ).bind(userId, mailAccountId, label, full, nowISO()).run();
  return { alias: await getAlias(env, userId) };
}

// ==================== 多别名管理 ====================

function toUserAlias(r: UserAliasRow & { email?: string; provider?: string }): UserAlias {
  const remain = r.expires_at ? Date.parse(r.expires_at) - Date.now() : 0;
  return {
    id: r.id,
    user_id: r.user_id,
    mail_account_id: r.mail_account_id,
    label: r.label,
    full: r.full,
    is_favorite: r.is_favorite === 1,
    status: (r.status as UserAlias['status']) || 'active',
    expires_at: r.expires_at,
    last_used_at: r.last_used_at,
    created_at: r.created_at,
    email: r.email,
    provider: (r.provider as 'gmail' | 'outlook') || undefined,
    remain_ms: r.status === 'active' ? Math.max(0, remain) : 0,
  };
}

// 把已到期仍标记为 active 的别名置为 expired(惰性过期,无需后台任务)
export async function expireStaleAliases(env: Env, userId?: string): Promise<void> {
  const sql = userId
    ? `UPDATE user_aliases SET status='expired'
        WHERE status='active' AND user_id = ? AND expires_at IS NOT NULL AND expires_at < ?`
    : `UPDATE user_aliases SET status='expired'
        WHERE status='active' AND expires_at IS NOT NULL AND expires_at < ?`;
  const stmt = env.DB.prepare(sql);
  await (userId ? stmt.bind(userId, nowISO()) : stmt.bind(nowISO())).run();
}

// 历史裁剪:收藏的永久保留,其余只保留最近 ALIAS_HISTORY_KEEP 条
export async function pruneAliasHistory(env: Env, userId: string): Promise<void> {
  await env.DB.prepare(
    `DELETE FROM user_aliases
      WHERE user_id = ? AND is_favorite = 0 AND status <> 'active'
        AND id NOT IN (
          SELECT id FROM user_aliases
           WHERE user_id = ? AND is_favorite = 0 AND status <> 'active'
           ORDER BY last_used_at DESC LIMIT ?
        )`
  ).bind(userId, userId, ALIAS_HISTORY_KEEP).run();
}

// 生效中的别名(自动剔除已过期)
export async function listActiveAliases(env: Env, userId: string): Promise<UserAlias[]> {
  await expireStaleAliases(env, userId);
  const { results } = await env.DB.prepare(
    `SELECT ua.*, ma.email, ma.provider
       FROM user_aliases ua JOIN mail_accounts ma ON ma.id = ua.mail_account_id
      WHERE ua.user_id = ? AND ua.status = 'active'
      ORDER BY ua.is_favorite DESC, ua.last_used_at DESC`
  ).bind(userId).all<UserAliasRow & { email: string; provider: string }>();
  return (results || []).map(toUserAlias);
}

export async function getAllAliases(env: Env, userId: string): Promise<UserAlias[]> {
  const { results } = await env.DB.prepare(
    `SELECT ua.*, ma.email, ma.provider
       FROM user_aliases ua JOIN mail_accounts ma ON ma.id = ua.mail_account_id
      WHERE ua.user_id = ?
      ORDER BY ua.is_favorite DESC, ua.last_used_at DESC`
  ).bind(userId).all<UserAliasRow & { email: string; provider: string }>();
  return (results || []).map(toUserAlias);
}

export async function getAliasRowById(env: Env, userId: string, aliasId: string): Promise<UserAlias | null> {
  const row = await env.DB.prepare(
    `SELECT ua.*, ma.email, ma.provider
       FROM user_aliases ua JOIN mail_accounts ma ON ma.id = ua.mail_account_id
      WHERE ua.id = ? AND ua.user_id = ?`
  ).bind(aliasId, userId).first<UserAliasRow & { email: string; provider: string }>();
  return row ? toUserAlias(row) : null;
}

export async function countActiveAliases(env: Env, userId: string): Promise<number> {
  await expireStaleAliases(env, userId);
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS cnt FROM user_aliases WHERE user_id = ? AND status = 'active'`
  ).bind(userId).first<{ cnt: number }>();
  return row?.cnt || 0;
}

// 创建别名:校验邮箱可用 + 生效数量上限 + full 唯一
export async function createUserAlias(
  env: Env, userId: string, mailAccountId: string, label: string
): Promise<{ alias: UserAlias | null; err?: string }> {
  const account = await env.DB.prepare(
    'SELECT * FROM mail_accounts WHERE id = ? AND (user_id = ? OR is_public = 1)'
  ).bind(mailAccountId, userId).first<MailAccountRow>();
  if (!account) return { alias: null, err: '未找到指定的邮箱或无权使用' };

  // 不支持别名收信的域名(QQ/163 等): 绑定可读信,但禁止创建别名
  const accDomain = splitEmail(account.email).domain;
  if (isAliasUnsupportedDomain(accDomain)) {
    return { alias: null, err: '该邮箱域名不支持别名收信,无法创建别名(仅可读取该收件箱)' };
  }

  const full = buildAliasFull(account.email, label, account.alias_template || null);
  if (!full) return { alias: null, err: '别名生成失败,邮箱格式错误' };

  await expireStaleAliases(env, userId);
  const active = await countActiveAliases(env, userId);
  if (active >= MAX_ACTIVE_ALIASES) {
    return { alias: null, err: `可创建邮箱已达到上限(${MAX_ACTIVE_ALIASES}个),请先停用或删除一个` };
  }

  const dup = await env.DB.prepare(
    'SELECT id FROM user_aliases WHERE user_id = ? AND full = ?'
  ).bind(userId, full).first<{ id: string }>();

  const now = nowISO();
  const expiresAt = new Date(Date.now() + ALIAS_TTL_MS).toISOString();
  if (dup) {
    // 已存在同名别名 -> 直接重新启用(续期)
    await env.DB.prepare(
      `UPDATE user_aliases SET status='active', expires_at=?, last_used_at=?, mail_account_id=? WHERE id=?`
    ).bind(expiresAt, now, mailAccountId, dup.id).run();
    return { alias: await getAliasRowById(env, userId, dup.id) };
  }

  const id = 'a' + randomHex(6);
  await env.DB.prepare(
    `INSERT INTO user_aliases(id, user_id, mail_account_id, label, full, is_favorite, status, expires_at, last_used_at, created_at)
     VALUES(?,?,?,?,?,0,'active',?,?,?)`
  ).bind(id, userId, mailAccountId, label, full, expiresAt, now, now).run();

  await pruneAliasHistory(env, userId);
  return { alias: await getAliasRowById(env, userId, id) };
}

// 恢复启用(历史别名重新收件):同样受上限约束
export async function restoreAlias(
  env: Env, userId: string, aliasId: string
): Promise<{ alias: UserAlias | null; err?: string }> {
  const row = await env.DB.prepare(
    'SELECT * FROM user_aliases WHERE id = ? AND user_id = ?'
  ).bind(aliasId, userId).first<UserAliasRow>();
  if (!row) return { alias: null, err: '别名不存在' };

  await expireStaleAliases(env, userId);
  if (row.status !== 'active') {
    const active = await countActiveAliases(env, userId);
    if (active >= MAX_ACTIVE_ALIASES) {
      return { alias: null, err: `可创建邮箱已达到上限(${MAX_ACTIVE_ALIASES}个),请先停用或删除一个` };
    }
  }
  const expiresAt = new Date(Date.now() + ALIAS_TTL_MS).toISOString();
  await env.DB.prepare(
    `UPDATE user_aliases SET status='active', expires_at=?, last_used_at=? WHERE id=? AND user_id=?`
  ).bind(expiresAt, nowISO(), aliasId, userId).run();
  await pruneAliasHistory(env, userId);
  return { alias: await getAliasRowById(env, userId, aliasId) };
}

// 续期:再延 1 小时
export async function renewAlias(
  env: Env, userId: string, aliasId: string
): Promise<{ alias: UserAlias | null; err?: string }> {
  const row = await env.DB.prepare(
    'SELECT status FROM user_aliases WHERE id = ? AND user_id = ?'
  ).bind(aliasId, userId).first<{ status: string }>();
  if (!row) return { alias: null, err: '别名不存在' };
  if (row.status !== 'active') return { alias: null, err: '别名已失效,请点击恢复启用' };
  const expiresAt = new Date(Date.now() + ALIAS_TTL_MS).toISOString();
  await env.DB.prepare(
    `UPDATE user_aliases SET expires_at=?, last_used_at=? WHERE id=? AND user_id=?`
  ).bind(expiresAt, nowISO(), aliasId, userId).run();
  return { alias: await getAliasRowById(env, userId, aliasId) };
}

// 停用(暂停收件),但保留在历史列表中
export async function deactivateAlias(env: Env, userId: string, aliasId: string): Promise<boolean> {
  const r = await env.DB.prepare(
    `UPDATE user_aliases SET status='archived', expires_at=NULL WHERE id=? AND user_id=?`
  ).bind(aliasId, userId).run();
  return r.meta.changes > 0;
}

export async function deleteAlias(env: Env, userId: string, aliasId: string): Promise<boolean> {
  const r = await env.DB.prepare('DELETE FROM user_aliases WHERE id = ? AND user_id = ?')
    .bind(aliasId, userId).run();
  return r.meta.changes > 0;
}

export async function setAliasFavorite(
  env: Env, userId: string, aliasId: string, favorite: boolean
): Promise<boolean> {
  const r = await env.DB.prepare(
    'UPDATE user_aliases SET is_favorite = ? WHERE id = ? AND user_id = ?'
  ).bind(favorite ? 1 : 0, aliasId, userId).run();
  return r.meta.changes > 0;
}

// 刷新使用时间(查询命中时调用,用于历史列表排序)
export async function touchAliases(env: Env, userId: string, aliasIds: string[]): Promise<void> {
  if (!aliasIds.length) return;
  const now = nowISO();
  for (const id of aliasIds) {
    await env.DB.prepare('UPDATE user_aliases SET last_used_at = ? WHERE id = ? AND user_id = ?')
      .bind(now, id, userId).run();
  }
}

// 历史列表:收藏置顶 + 最近使用降序,支持别名地址/标签/主邮箱模糊搜索 + 分页
export async function listAliasHistory(
  env: Env, userId: string, keyword: string, page: number, pageSize = ALIAS_HISTORY_PAGE_SIZE
): Promise<{ list: UserAlias[]; total: number; page: number; page_size: number; total_pages: number }> {
  await expireStaleAliases(env, userId);
  const kw = (keyword || '').trim().toLowerCase();
  const where = kw
    ? `WHERE ua.user_id = ? AND (lower(ua.full) LIKE ? OR lower(ua.label) LIKE ? OR lower(ma.email) LIKE ?)`
    : `WHERE ua.user_id = ?`;
  const like = `%${kw}%`;
  const countStmt = env.DB.prepare(
    `SELECT COUNT(*) AS cnt FROM user_aliases ua JOIN mail_accounts ma ON ma.id = ua.mail_account_id ${where}`
  );
  const countRow = await (kw ? countStmt.bind(userId, like, like, like) : countStmt.bind(userId))
    .first<{ cnt: number }>();
  const total = countRow?.cnt || 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const offset = (safePage - 1) * pageSize;

  const listStmt = env.DB.prepare(
    `SELECT ua.*, ma.email, ma.provider
       FROM user_aliases ua JOIN mail_accounts ma ON ma.id = ua.mail_account_id
       ${where}
      ORDER BY ua.is_favorite DESC, ua.last_used_at DESC
      LIMIT ? OFFSET ?`
  );
  const { results } = await (kw
    ? listStmt.bind(userId, like, like, like, pageSize, offset)
    : listStmt.bind(userId, pageSize, offset)
  ).all<UserAliasRow & { email: string; provider: string }>();

  return {
    list: (results || []).map(toUserAlias),
    total,
    page: safePage,
    page_size: pageSize,
    total_pages: totalPages,
  };
}

// ============ 使用日志 ============
export async function addLog(env: Env, userId: string, username: string, target: string, action: string, detail: string): Promise<void> {
  await env.DB.prepare(
    'INSERT INTO usage_logs(user_id, username, target, action, detail) VALUES(?,?,?,?,?)'
  ).bind(userId, username, target, action, detail).run();
  // 清理过期日志 (30天前)
  const cutoff = new Date(Date.now() - LOG_RETENTION_DAYS * 86400 * 1000).toISOString();
  await env.DB.prepare('DELETE FROM usage_logs WHERE created_at < ?').bind(cutoff).run();
  // 清理超量日志: 仅保留最新的 LOG_MAX_RECORDS 条
  await env.DB.prepare(
    `DELETE FROM usage_logs WHERE id NOT IN (
      SELECT id FROM usage_logs ORDER BY id DESC LIMIT ?
    )`
  ).bind(LOG_MAX_RECORDS).run();
}

export async function listLogs(env: Env, limit = 500): Promise<LogRow[]> {
  const { results } = await env.DB.prepare(
    'SELECT * FROM usage_logs ORDER BY created_at DESC LIMIT ?'
  ).bind(limit).all<LogRow>();
  return results || [];
}

// 分页查询日志(每页 100 条,支持跳转)
export async function listLogsPaged(env: Env, page: number, pageSize = 100): Promise<{ logs: LogRow[]; total: number; page: number; page_size: number; total_pages: number }> {
  const offset = Math.max(0, (page - 1) * pageSize);
  const countRow = await env.DB.prepare('SELECT COUNT(*) as cnt FROM usage_logs').first<{ cnt: number }>();
  const total = countRow?.cnt || 0;
  const { results } = await env.DB.prepare(
    'SELECT * FROM usage_logs ORDER BY created_at DESC LIMIT ? OFFSET ?'
  ).bind(pageSize, offset).all<LogRow>();
  return {
    logs: results || [],
    total,
    page,
    page_size: pageSize,
    total_pages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

// 直接更新密码 hash (用户自助修改密码时调用)
export async function updateUserPassword(env: Env, userId: string, passwordHash: string): Promise<void> {
  await env.DB.prepare('UPDATE users SET password = ? WHERE id = ?')
    .bind(passwordHash, userId).run();
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
  url: string, secret: string | null, events: string, format = 'card'
): Promise<string> {
  const id = 'w' + randomHex(4);
  // 兼容未执行 ALTER 的旧库:先尝试带 format 插入,失败则退回旧列
  try {
    await env.DB.prepare(
      `INSERT INTO webhooks(id, user_id, mail_account_id, target_alias, url, secret, events, format, is_active)
       VALUES(?,?,?,?,?,?,?,?,1)`
    ).bind(id, userId, mailAccountId, targetAlias, url, secret, events, format).run();
  } catch {
    await env.DB.prepare(
      `INSERT INTO webhooks(id, user_id, mail_account_id, target_alias, url, secret, events, is_active)
       VALUES(?,?,?,?,?,?,?,1)`
    ).bind(id, userId, mailAccountId, targetAlias, url, secret, events).run();
  }
  return id;
}

export async function listWebhooks(env: Env, userId: string): Promise<Webhook[]> {
  const { results } = await env.DB.prepare(
    'SELECT * FROM webhooks WHERE user_id = ? ORDER BY created_at DESC'
  ).bind(userId).all<WebhookRow>();
  return (results || []).map(r => ({
    id: r.id, user_id: r.user_id, mail_account_id: r.mail_account_id,
    target_alias: r.target_alias, url: r.url, secret: r.secret,
    events: r.events, format: r.format || 'card', is_active: r.is_active === 1, created_at: r.created_at,
  }));
}

export async function deleteWebhook(env: Env, id: string, userId: string): Promise<boolean> {
  const r = await env.DB.prepare('DELETE FROM webhooks WHERE id = ? AND user_id = ?')
    .bind(id, userId).run();
  return r.meta.changes > 0;
}

// 删除某用户的全部 webhook (用于"每用户仅一个 webhook"约束 + 换别名时清理)
export async function deleteWebhooksByUser(env: Env, userId: string): Promise<number> {
  const r = await env.DB.prepare('DELETE FROM webhooks WHERE user_id = ?').bind(userId).run();
  return r.meta.changes || 0;
}

// 按邮箱账号查所有活跃订阅(系统推送时用)
export async function getWebhooksForAccount(env: Env, mailAccountId: string): Promise<Webhook[]> {
  const { results } = await env.DB.prepare(
    'SELECT * FROM webhooks WHERE mail_account_id = ? AND is_active = 1'
  ).bind(mailAccountId).all<WebhookRow>();
  return (results || []).map(r => ({
    id: r.id, user_id: r.user_id, mail_account_id: r.mail_account_id,
    target_alias: r.target_alias, url: r.url, secret: r.secret,
    events: r.events, format: r.format || 'card', is_active: r.is_active === 1, created_at: r.created_at,
  }));
}

export async function toggleWebhook(env: Env, id: string, userId: string, active: boolean): Promise<boolean> {
  const r = await env.DB.prepare('UPDATE webhooks SET is_active = ? WHERE id = ? AND user_id = ?')
    .bind(active ? 1 : 0, id, userId).run();
  return r.meta.changes > 0;
}

// 获取所有有活跃 webhook 的邮箱账号ID (用于定时轮询)
export async function getActiveWebhookAccountIds(env: Env): Promise<string[]> {
  const { results } = await env.DB.prepare(
    'SELECT DISTINCT mail_account_id FROM webhooks WHERE is_active = 1'
  ).all<{ mail_account_id: string }>();
  return (results || []).map(r => r.mail_account_id);
}

export async function updateWebhookFormat(env: Env, id: string, userId: string, format: string): Promise<boolean> {
  try {
    const r = await env.DB.prepare('UPDATE webhooks SET format = ? WHERE id = ? AND user_id = ?')
      .bind(format, id, userId).run();
    return r.meta.changes > 0;
  } catch {
    return false; // 旧库无 format 列
  }
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

// ============ 用户级 Google OAuth 凭据(普通用户自行填写,与系统设置解耦) ============
// 每个用户把自己的 Google 客户端凭据保存在自己的 users 行里;
// 优先级高于环境变量与管理后台全局配置,因此不会因他人/全局填错而被卡死。
export interface UserGoogleCreds { clientId: string; clientSecret: string; }

export async function getUserGoogleCreds(env: Env, userId: string): Promise<UserGoogleCreds | null> {
  const row = await env.DB.prepare(
    'SELECT google_client_id, google_client_secret FROM users WHERE id = ?'
  ).bind(userId).first<{ google_client_id: string | null; google_client_secret: string | null }>();
  if (!row) return null;
  let clientId = '';
  let clientSecret = '';
  if (row.google_client_id) {
    try { clientId = await decrypt(row.google_client_id, env); } catch { clientId = ''; }
  }
  if (row.google_client_secret) {
    try { clientSecret = await decrypt(row.google_client_secret, env); } catch { clientSecret = ''; }
  }
  if (!clientId) return null;
  return { clientId, clientSecret };
}

export async function saveUserGoogleCreds(env: Env, userId: string, clientId: string, clientSecret: string): Promise<void> {
  await env.DB.prepare(
    'UPDATE users SET google_client_id = ?, google_client_secret = ? WHERE id = ?'
  ).bind(
    clientId ? await encrypt(clientId, env) : '',
    clientSecret ? await encrypt(clientSecret, env) : '',
    userId
  ).run();
}
