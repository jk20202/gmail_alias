// 所有 HTTP 路由处理 - 按模块分组,每个函数接收 ctx 返回 Response
import type { Env, SafeUser, FetchParams, Email } from './types';
import * as db from './db';
import {
  buildAuthURL, handleOAuthCallback, checkAccountAuthStatus, startDeviceFlow, pollDeviceFlow,
  startGoogleDeviceFlow, pollGoogleDeviceFlow, getGoogleCreds, saveGoogleCreds, googleConfigStatus,
} from './oauth';
import { fetchEmails, markEmailsRead, markEmailsReadBySender, toEmail } from './emailService';
import { sha256, randomLabel } from './utils';
import { pollAndPush, sendTestEvent } from './webhook';

// 路由上下文
export interface Ctx {
  env: Env;
  req: Request;
  url: URL;
  user?: SafeUser;        // session 用户(可选)
  rawUser?: SafeUser;     // 用于内部解析凭据 (含 alias 关联)
  body?: any;
}

// ============ 中间件: 提取 session 用户 ============
// 热路径优化: session -> userId(KV 缓存) -> 基础用户(isolate 内存缓存),
// 不再每个请求都跑 toSafeUser() 里的 3 次关联查询(mail_accounts / 主别名 / 别名计数)。
// 需要完整资料(含邮箱列表、别名)的接口请改用 requireSessionFull()。
async function requireSession(ctx: Ctx): Promise<SafeUser> {
  const auth = ctx.req.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) throw new HTTPError(401, '未登录或会话过期');
  const token = auth.slice(7);
  const userId = await db.getSessionUserId(ctx.env, token);
  if (!userId) throw new HTTPError(401, '未登录或会话过期');
  const basic = await db.getUserBasic(ctx.env, userId);
  if (!basic) throw new HTTPError(401, '未登录或会话过期');
  return {
    id: basic.id,
    username: basic.username,
    api_key: '',
    is_admin: basic.is_admin,
    disabled: basic.disabled,
    mail_accounts: [],
    alias: null,
    active_alias_count: 0,
    created_at: basic.created_at,
  };
}

// 需要完整用户资料(关联邮箱列表 / 别名)时使用
async function requireSessionFull(ctx: Ctx): Promise<SafeUser> {
  const auth = ctx.req.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) throw new HTTPError(401, '未登录或会话过期');
  const token = auth.slice(7);
  const user = await db.getSessionUser(ctx.env, token);
  if (!user) throw new HTTPError(401, '未登录或会话过期');
  return user;
}

async function requireAdmin(ctx: Ctx): Promise<SafeUser> {
  const user = await requireSession(ctx);
  if (!user.is_admin) throw new HTTPError(403, '需要管理员权限');
  return user;
}

async function requireApiKey(ctx: Ctx): Promise<SafeUser> {
  const key = ctx.url.searchParams.get('key');
  if (!key) throw new HTTPError(401, '缺少 API Key');
  const user = await db.getUserByApiKey(ctx.env, key);
  if (!user) throw new HTTPError(401, '无效的 API Key');
  return user;
}

// 自定义错误
export class HTTPError extends Error {
  status: number;
  constructor(status: number, msg: string) {
    super(msg);
    this.status = status;
  }
}

// ============ 工具 ============
function ok(data: unknown, msg = 'success') {
  return Response.json({ code: 0, msg, data });
}
function fail(msg: string, status = 400, code = 1) {
  return Response.json({ code, msg, data: null }, { status });
}

// 解析 JSON body
async function parseBody(req: Request): Promise<any> {
  try {
    return await req.json();
  } catch {
    return {};
  }
}

// ============ 页面 ============
const SPA_PAGES = ['/mail', '/account', '/webhook', '/docs', '/users', '/settings', '/login'];

export async function indexPage(ctx: Ctx): Promise<Response> {
  // 走 [assets] 绑定,直接 fetch 静态资源
  const url = new URL(ctx.req.url);
  // 归一化: 去掉末尾斜杠,避免 /account/ 这类路径无法匹配
  const p = url.pathname.replace(/\/+$/, '') || '/';
  // 根路径或任意 SPA 子路径(如 /mail /account /settings)都返回 index.html,
  // 使各功能页拥有独立、可分享、可书签、刷新不 404 的 URL
  const isSpa = p === '/' || p === '/index.html' || SPA_PAGES.includes(p);
  if (isSpa) {
    const resp = await ctx.env.ASSETS.fetch(new Request('http://localhost/', { method: 'GET' }));
    // 读取完整body避免流式传输导致内容截断
    const body = await resp.arrayBuffer();
    // HTML 禁用缓存: 防止 CDN 边缘缓存旧版前端导致登录等功能失效
    const h = new Headers(resp.headers);
    h.set('Cache-Control', 'no-cache, no-store, must-revalidate, proxy-no-cache');
    h.set('Pragma', 'no-cache');
    h.set('Surrogate-Control', 'no-store');
    h.set('Content-Length', body.byteLength.toString());
    return new Response(body, { status: resp.status, headers: h, statusText: resp.statusText });
  }
  // 其他静态文件交给 ASSETS
  return ctx.env.ASSETS.fetch(ctx.req);
}

export async function health(ctx: Ctx): Promise<Response> {
  const users = await db.listUsers(ctx.env);
  return ok({ status: 'ok', users: users.length });
}

// ============ Auth ============
export async function authLogin(ctx: Ctx): Promise<Response> {
  const { username, password } = ctx.body;
  if (!username || !password) return fail('账户不存在,或是密码不匹配', 401);
  const raw = await db.getUserByUsername(ctx.env, username);
  if (!raw) return fail('账户不存在,或是密码不匹配', 401);
  const hashed = await sha256(password);
  if (raw.password !== hashed) return fail('账户不存在,或是密码不匹配', 401);
  // 禁用用户禁止登录 (同样返回统一提示,不暴露账户存在性)
  if (raw.disabled === 1) return fail('账户不存在,或是密码不匹配', 401);
  const token = await db.createSession(ctx.env, raw.id);
  const user = await db.getUserById(ctx.env, raw.id);
  return ok({ session_token: token, user });
}

export async function authRegister(ctx: Ctx): Promise<Response> {
  const allowed = await db.getSetting(ctx.env, 'allow_registration');
  if (allowed !== 'true') return fail('管理员已关闭注册功能', 403);
  const { username, password } = ctx.body;
  if (!username || username.length < 3) return fail('用户名至少3个字符');
  if (!password || password.length < 6) return fail('密码至少6个字符');
  const user = await db.createUser(ctx.env, username, password, false);
  if (!user) return fail('用户名已存在', 409);
  return ok(user);
}

export async function authLogout(ctx: Ctx): Promise<Response> {
  const auth = ctx.req.headers.get('Authorization') || '';
  if (auth.startsWith('Bearer ')) {
    await db.deleteSession(ctx.env, auth.slice(7));
  }
  return ok(null);
}

// 用户自助修改密码
export async function accountChangePassword(ctx: Ctx): Promise<Response> {
  const user = await requireSession(ctx);
  const { old_password, new_password } = ctx.body;
  if (!old_password || !new_password) return fail('请填写原密码和新密码');
  if (new_password.length < 6) return fail('新密码至少 6 个字符');
  const raw = await db.getUserByUsername(ctx.env, user.username);
  if (!raw) return fail('用户不存在', 404);
  const oldHash = await sha256(old_password);
  if (raw.password !== oldHash) return fail('原密码错误', 401);
  const newHash = await sha256(new_password);
  await db.updateUserPassword(ctx.env, user.id, newHash);
  await db.addLog(ctx.env, user.id, user.username, '', 'change_password', '修改了密码');
  return ok(null);
}

export async function authMe(ctx: Ctx): Promise<Response> {
  const user = await requireSessionFull(ctx);
  return ok(user);
}

// ============ Admin ============
export async function adminListUsers(ctx: Ctx): Promise<Response> {
  await requireAdmin(ctx);
  const users = await db.listUsers(ctx.env);
  return ok(users);
}

export async function adminCreateUser(ctx: Ctx): Promise<Response> {
  const admin = await requireAdmin(ctx);
  const { username, password, is_admin } = ctx.body;
  const user = await db.createUser(ctx.env, username, password, !!is_admin);
  if (!user) return fail('用户名已存在', 409);
  await db.addLog(ctx.env, admin.id, admin.username, '', 'create_user', `创建了用户 ${username}`);
  return ok(user);
}

export async function adminUpdateUser(ctx: Ctx): Promise<Response> {
  const admin = await requireAdmin(ctx);
  const userId = ctx.url.pathname.split('/')[4];
  const { username, password, is_admin, disabled } = ctx.body;
  // 用户名若修改需校验唯一性
  if (username !== undefined) {
    const exist = await db.getUserByUsername(ctx.env, username);
    if (exist && exist.id !== userId) return fail('用户名已存在', 409);
  }
  const user = await db.updateUser(ctx.env, userId, {
    username, password, isAdmin: is_admin, disabled,
  });
  if (!user) return fail('用户不存在', 404);
  await db.addLog(ctx.env, admin.id, admin.username, '', 'update_user', `更新了用户 ${user.username}`);
  return ok(user);
}

// 管理员为指定用户设置别名 (管理员编辑用户时的别名设置)
// 路径 /api/admin/users/:id/alias
export async function adminSetUserAlias(ctx: Ctx): Promise<Response> {
  const admin = await requireAdmin(ctx);
  const userId = ctx.url.pathname.split('/')[4];
  const { mail_account_id, label } = ctx.body;
  if (!mail_account_id || !label) return fail('邮箱和别名标签必填');
  const result = await db.adminSetAlias(ctx.env, userId, mail_account_id, label);
  if (result.err) return fail(result.err);
  await db.addLog(ctx.env, admin.id, admin.username, '', 'admin_set_alias', `为用户 ${userId} 设置别名 ${result.alias?.full}`);
  return ok(result.alias);
}

export async function adminDeleteUser(ctx: Ctx): Promise<Response> {
  const admin = await requireAdmin(ctx);
  const userId = ctx.url.pathname.split('/')[4];
  // 通过 is_admin 字段判断,而非硬编码 id='admin'(因为用户 id 是随机 hex)
  const targetUser = await db.getUserById(ctx.env, userId);
  if (!targetUser) return fail('用户不存在', 404);
  if (targetUser.is_admin) return fail('不能删除管理员账户');
  const ok2 = await db.deleteUser(ctx.env, userId);
  if (!ok2) return fail('用户不存在', 404);
  await db.addLog(ctx.env, admin.id, admin.username, '', 'delete_user', `删除了用户 ${targetUser.username}`);
  return ok(null);
}

export async function adminStats(ctx: Ctx): Promise<Response> {
  await requireAdmin(ctx);
  const [summary, accounts] = await Promise.all([
    db.statsSummary(ctx.env),
    db.adminListAllAccounts(ctx.env),
  ]);
  return ok({ summary: { ...summary, mail_account_count: accounts.length } });
}

// 分页查询日志 (每页 100 条)
export async function adminLogs(ctx: Ctx): Promise<Response> {
  await requireAdmin(ctx);
  const page = parseInt(ctx.url.searchParams.get('page') || '1', 10);
  const result = await db.listLogsPaged(ctx.env, page, 100);
  return ok(result);
}

export async function adminUpdateSettings(ctx: Ctx): Promise<Response> {
  const admin = await requireAdmin(ctx);
  const { allow_registration } = ctx.body;
  await db.setSetting(ctx.env, 'allow_registration', allow_registration ? 'true' : 'false');
  await db.addLog(ctx.env, admin.id, admin.username, '', 'update_settings', `注册开关: ${allow_registration}`);
  return ok({ allow_registration });
}

export async function adminGetSettings(ctx: Ctx): Promise<Response> {
  const allowed = await db.getSetting(ctx.env, 'allow_registration');
  return ok({ allow_registration: allowed === 'true' });
}

export async function adminListAllAccounts(ctx: Ctx): Promise<Response> {
  await requireAdmin(ctx);
  return ok(await db.adminListAllAccounts(ctx.env));
}

export async function adminUpdateAccount(ctx: Ctx): Promise<Response> {
  const admin = await requireAdmin(ctx);
  // /api/admin/mail_accounts/{id}
  const id = ctx.url.pathname.split('/').pop()!;
  const { is_public } = ctx.body;
  await db.adminUpdateMailAccount(ctx.env, id, is_public);
  await db.addLog(ctx.env, admin.id, admin.username, '', 'admin_update_account', `修改了邮箱 ${id}`);
  return ok(null);
}

export async function adminDeleteAccount(ctx: Ctx): Promise<Response> {
  const admin = await requireAdmin(ctx);
  const id = ctx.url.pathname.split('/').pop()!;
  const ok2 = await db.adminDeleteMailAccount(ctx.env, id);
  if (!ok2) return fail('邮箱账号不存在', 404);
  await db.addLog(ctx.env, admin.id, admin.username, '', 'admin_delete_account', `删除了邮箱 ${id}`);
  return ok(null);
}

// ============ Account 自助 ============
export async function accountSelf(ctx: Ctx): Promise<Response> {
  const user = await requireSessionFull(ctx);
  return ok(user);
}

export async function accountRegenApiKey(ctx: Ctx): Promise<Response> {
  const user = await requireSession(ctx);
  const updated = await db.regenerateApiKey(ctx.env, user.id);
  if (!updated) return fail('用户不存在', 404);
  await db.addLog(ctx.env, user.id, user.username, '', 'regen_api_key', '重新生成了API Key');
  return ok(updated);
}

export async function accountListAccounts(ctx: Ctx): Promise<Response> {
  const user = await requireSession(ctx);
  const accounts = await db.listMailAccounts(ctx.env, user.id);
  return ok(accounts);
}

// 启动 OAuth 绑定 (Authorization Code Flow)
// Gmail 默认不再走这条链路(改用 Device Code),此处保留给自建应用使用
export async function accountOAuthStart(ctx: Ctx): Promise<Response> {
  const user = await requireSession(ctx);
  const provider = ctx.url.searchParams.get('provider') as 'gmail' | 'outlook';
  if (provider !== 'gmail' && provider !== 'outlook') return fail('provider 必须为 gmail 或 outlook');
  try {
    const authUrl = await buildAuthURL(ctx.env, user.id, provider);
    return ok({ auth_url: authUrl, provider });
  } catch (e) {
    // 未配置凭据等场景:直接把中文原因返回给前端,不再让用户跳到 Google 的 401 页面
    return fail((e as Error).message);
  }
}

// Gmail: Device Code Flow 授权(推荐,无需回调地址)
// 前端把用户在弹窗内填写的 Client ID / Secret 一并提交;后端:
//  1) 持久化到该用户自己的账号下(便于下次预填;用户级凭据优先级最高)
//  2) 用本次提交(或已保存)的凭据发起设备码,避免被历史全局配置卡死
export async function accountGoogleDeviceStart(ctx: Ctx): Promise<Response> {
  const user = await requireSession(ctx);
  const body = ctx.body || {};
  const cid = typeof body.client_id === 'string' ? body.client_id.trim() : '';
  const sec = typeof body.client_secret === 'string' ? body.client_secret.trim() : '';

  let explicitCreds: { clientId: string; clientSecret: string } | null = null;
  if (cid) {
    // 仅在有值时写入,且不因本次留空而把已保存的 Secret 清空
    const existing = await db.getUserGoogleCreds(ctx.env, user.id);
    const secretToSave = sec || (existing ? existing.clientSecret : '');
    await db.saveUserGoogleCreds(ctx.env, user.id, cid, secretToSave);
    explicitCreds = { clientId: cid, clientSecret: secretToSave };
  }
  // 别名规则模板(可空): 随设备码会话带入,落库到该 Gmail 账号,使 Gmail 可用非 "+" 的别名形式
  const aliasTpl = typeof body.alias_template === 'string' ? body.alias_template.trim() : '';
  try {
    const data = await startGoogleDeviceFlow(ctx.env, user.id, explicitCreds, aliasTpl || null);
    return ok({ ...data, provider: 'gmail' });
  } catch (e) {
    return fail((e as Error).message);
  }
}

export async function accountGoogleDeviceStatus(ctx: Ctx): Promise<Response> {
  const user = await requireSession(ctx);
  const result = await pollGoogleDeviceFlow(ctx.env, user.id);
  return ok(result);
}

// 管理员:查看 / 保存 Google OAuth 凭据(加密落库,优先于环境变量)
export async function adminGetOAuthConfig(ctx: Ctx): Promise<Response> {
  await requireAdmin(ctx);
  const status = await googleConfigStatus(ctx.env);
  const hasSecret = !!(await getGoogleCreds(ctx.env))?.clientSecret;
  return ok({ ...status, has_client_secret: hasSecret });
}

// 普通用户:查看自己的 Google OAuth 凭据是否已配置(供绑定弹窗预填)
export async function accountGoogleOAuthStatus(ctx: Ctx): Promise<Response> {
  const user = await requireSession(ctx);
  const own = await db.getUserGoogleCreds(ctx.env, user.id);
  const envId = (ctx.env.GOOGLE_CLIENT_ID || '').trim();
  return ok({
    configured: !!(own || envId),
    // Client ID 非机密,可直接回显便于预填;Secret 不回显(只告知是否已保存)
    client_id: own ? own.clientId : envId,
    has_client_secret: !!(own && own.clientSecret),
    source: own ? 'user' : (envId ? 'env' : ''),
  });
}

// 普通用户:在绑定弹窗内当场提交自己的 Google OAuth 凭据(保存在个人账号下,与系统设置无关)
export async function accountSaveGoogleCreds(ctx: Ctx): Promise<Response> {
  const user = await requireSession(ctx);
  const { client_id, client_secret } = ctx.body || {};
  if (!client_id || typeof client_id !== 'string' || !client_id.trim()) {
    return fail('请填写 Client ID');
  }
  if (!/^[0-9]+-[0-9a-z]+\.apps\.googleusercontent\.com$/i.test(client_id.trim())) {
    return fail('Client ID 格式不正确,应形如 1234567890-xxxx.apps.googleusercontent.com');
  }
  if (!client_secret || typeof client_secret !== 'string' || !client_secret.trim()) {
    return fail('请填写 Client Secret');
  }
  await db.saveUserGoogleCreds(ctx.env, user.id, client_id.trim(), client_secret.trim());
  return ok({ configured: true });
}

export async function adminSaveOAuthConfig(ctx: Ctx): Promise<Response> {
  const admin = await requireAdmin(ctx);
  const { client_id, client_secret } = ctx.body || {};
  if (client_id !== undefined && typeof client_id !== 'string') return fail('参数格式错误');
  if (client_secret !== undefined && typeof client_secret !== 'string') return fail('参数格式错误');
  if (client_id && !/^[0-9]+-[0-9a-z]+\.apps\.googleusercontent\.com$/i.test(client_id.trim())) {
    return fail('Client ID 格式不正确,应形如 1234567890-xxxx.apps.googleusercontent.com');
  }
  await saveGoogleCreds(ctx.env, (client_id || '').trim(), (client_secret || '').trim());
  await db.addLog(ctx.env, admin.id, admin.username, '', 'update_oauth', '更新了 Google OAuth 凭据');
  return ok(await googleConfigStatus(ctx.env));
}

// ============ 多别名 (每用户最多 5 个同时生效) ============
export async function aliasLimits(ctx: Ctx): Promise<Response> {
  const user = await requireSession(ctx);
  const active = await db.listActiveAliases(ctx.env, user.id);
  return ok({
    max: db.MAX_ACTIVE_ALIASES,
    ttl_ms: db.ALIAS_TTL_MS,
    history_keep: db.ALIAS_HISTORY_KEEP,
    history_page_size: db.ALIAS_HISTORY_PAGE_SIZE,
    active_count: active.length,
  });
}

export async function aliasListActive(ctx: Ctx): Promise<Response> {
  const user = await requireSession(ctx);
  const list = await db.listActiveAliases(ctx.env, user.id);
  return ok({
    list,
    max: db.MAX_ACTIVE_ALIASES,
    ttl_ms: db.ALIAS_TTL_MS,
  });
}

export async function aliasCreate(ctx: Ctx): Promise<Response> {
  const user = await requireSession(ctx);
  const { mail_account_id, label } = ctx.body || {};
  if (!mail_account_id) return fail('请选择主邮箱');
  if (!label || !String(label).trim()) return fail('别名标签不能为空');

  // v2: 只有开启「支持别名」的邮箱才能派生别名地址。
  // 该开关默认关闭 —— 关闭时此邮箱只能被直接选中收信,不能生成别名。
  const account = await db.getMailAccountRaw(ctx.env, user.id, mail_account_id);
  if (!account) return fail('无权操作该邮箱', 403);
  if (account.supports_alias !== 1) {
    return fail('该邮箱未开启「支持别名」,请先在邮箱设置中开启后再创建别名');
  }

  const { alias, err } = await db.createUserAlias(ctx.env, user.id, mail_account_id, String(label).trim());
  if (err) return fail(err);
  await db.addLog(ctx.env, user.id, user.username, alias?.full || '', 'create_alias', `创建了别名 ${alias?.full}`);
  return ok(alias);
}

export async function aliasHistory(ctx: Ctx): Promise<Response> {
  const user = await requireSession(ctx);
  const page = parseInt(ctx.url.searchParams.get('page') || '1', 10);
  const pageSize = parseInt(ctx.url.searchParams.get('page_size') || String(db.ALIAS_HISTORY_PAGE_SIZE), 10);
  const keyword = ctx.url.searchParams.get('keyword') || '';
  const result = await db.listAliasHistory(ctx.env, user.id, keyword, page, pageSize);
  return ok({
    ...result,
    max: db.MAX_ACTIVE_ALIASES,
    history_keep: db.ALIAS_HISTORY_KEEP,
  });
}

export async function aliasRestore(ctx: Ctx): Promise<Response> {
  const user = await requireSession(ctx);
  const id = ctx.url.pathname.split('/').slice(-2, -1)[0];
  const { alias, err } = await db.restoreAlias(ctx.env, user.id, id);
  if (err) return fail(err);
  await db.addLog(ctx.env, user.id, user.username, alias?.full || '', 'restore_alias', `恢复启用别名 ${alias?.full}`);
  return ok(alias);
}

export async function aliasRenew(ctx: Ctx): Promise<Response> {
  const user = await requireSession(ctx);
  const id = ctx.url.pathname.split('/').slice(-2, -1)[0];
  const { alias, err } = await db.renewAlias(ctx.env, user.id, id);
  if (err) return fail(err);
  return ok(alias);
}

export async function aliasDeactivate(ctx: Ctx): Promise<Response> {
  const user = await requireSession(ctx);
  const id = ctx.url.pathname.split('/').slice(-2, -1)[0];
  const ok2 = await db.deactivateAlias(ctx.env, user.id, id);
  if (!ok2) return fail('别名不存在', 404);
  return ok(null);
}

export async function aliasFavorite(ctx: Ctx): Promise<Response> {
  const user = await requireSession(ctx);
  const id = ctx.url.pathname.split('/').slice(-2, -1)[0];
  const favorite = ctx.body?.favorite === true || ctx.body?.favorite === 'true';
  const ok2 = await db.setAliasFavorite(ctx.env, user.id, id, favorite);
  if (!ok2) return fail('别名不存在', 404);
  return ok({ favorite });
}

export async function aliasDelete(ctx: Ctx): Promise<Response> {
  const user = await requireSession(ctx);
  const id = ctx.url.pathname.split('/').pop()!;
  const ok2 = await db.deleteAlias(ctx.env, user.id, id);
  if (!ok2) return fail('别名不存在', 404);
  return ok(null);
}

// 兼容旧接口:设置别名(现在走多别名逻辑,不再清空 Webhook)
export async function accountSetAliasCompat(ctx: Ctx): Promise<Response> {
  const user = await requireSession(ctx);
  const { mail_account_id, label } = ctx.body || {};
  if (!label || !String(label).trim()) return fail('别名标签不能为空');
  if (!mail_account_id) return fail('请选择邮箱');
  const { alias, err } = await db.createUserAlias(ctx.env, user.id, mail_account_id, String(label).trim());
  if (err) return fail(err);
  await db.addLog(ctx.env, user.id, user.username, alias?.full || '', 'set_alias', '设置了别名');
  const updated = await db.getUserById(ctx.env, user.id);
  return ok(updated);
}

// OAuth 回调 (浏览器跳转,返回 HTML 关闭窗口)
export async function oauthCallback(ctx: Ctx): Promise<Response> {
  const code = ctx.url.searchParams.get('code');
  const state = ctx.url.searchParams.get('state');
  const error = ctx.url.searchParams.get('error');
  if (error) return renderOAuthResult(false, '授权失败,请重试');  // 不回显 error 防注入
  if (!code || !state) return renderOAuthResult(false, '缺少 code 或 state 参数');
  try {
    const result = await handleOAuthCallback(ctx.env, code, state);
    return renderOAuthResult(true, `已成功绑定 ${escapeHtml(result.email)}`, result.email);
  } catch (e) {
    return renderOAuthResult(false, '授权流程异常,请重新发起');
  }
}

// HTML 转义防 XSS
function escapeHtml(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function renderOAuthResult(success: boolean, message: string, email = ''): Response {
  // message 已转义,可安全插入 HTML
  const postMsg = success
    ? `{type:'oauth_bind_success',email:'${escapeHtml(email)}'}`
    : `{type:'oauth_bind_failed',message:'${escapeHtml(message)}'}`;
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>OAuth 绑定结果</title>
  <style>body{font-family:sans-serif;padding:40px;text-align:center;color:${success ? '#16a34a' : '#dc2626'};}</style></head>
  <body><h2>${success ? '绑定成功' : '绑定失败'}</h2><p>${message}</p>
  <script>
    try { if(window.opener) window.opener.postMessage(${postMsg}, '*'); } catch(e) {}
    setTimeout(()=>window.close(),3000);
  </script></body></html>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

export async function accountDeleteAccount(ctx: Ctx): Promise<Response> {
  const user = await requireSession(ctx);
  const id = ctx.url.pathname.split('/').pop()!;
  const ok2 = await db.deleteMailAccount(ctx.env, user.id, id);
  if (!ok2) return fail('邮箱账号不存在', 404);
  await db.addLog(ctx.env, user.id, user.username, '', 'delete_account', `删除了邮箱 ${id}`);
  return ok(null);
}

// ============ Device Code Flow (微软,绕过 redirect_uri) ============
// 发起 device code 授权,前端弹窗显示 user_code
export async function accountDeviceStart(ctx: Ctx): Promise<Response> {
  const user = await requireSession(ctx);
  try {
    const data = await startDeviceFlow(ctx.env, user.id);
    return ok(data);
  } catch (e) {
    return fail((e as Error).message);
  }
}

// 轮询 device code 授权状态,前端每 3-5 秒调用一次
export async function accountDeviceStatus(ctx: Ctx): Promise<Response> {
  const user = await requireSession(ctx);
  const result = await pollDeviceFlow(ctx.env, user.id);
  return ok(result);
}

// 用户自助切换自己邮箱的公开状态 (是否允许其他用户使用该邮箱)
// 路径 /api/account/mail_accounts/:id/public
export async function accountTogglePublic(ctx: Ctx): Promise<Response> {
  const user = await requireSession(ctx);
  const id = ctx.url.pathname.split('/').slice(-2, -1)[0];
  const { is_public } = ctx.body;
  await db.updateMailAccount(ctx.env, user.id, id, is_public);
  await db.addLog(ctx.env, user.id, user.username, '', 'toggle_public', `邮箱 ${id} 公开状态改为 ${is_public}`);
  return ok(null);
}

// 更新自己邮箱的「别名规则模板 / 备注」配置(不涉及重新授权)
// 路径 /api/account/mail_accounts/:id  (PATCH)
export async function accountUpdateMailAccount(ctx: Ctx): Promise<Response> {
  const user = await requireSession(ctx);
  const id = ctx.url.pathname.split('/').slice(-1)[0];
  // 越权防护:校验邮箱归属(自己的)
  const account = await db.getMailAccountRaw(ctx.env, user.id, id);
  if (!account) return fail('无权操作该邮箱', 403);
  const body = ctx.body || {};
  const aliasTemplate = typeof body.alias_template === 'string' ? body.alias_template.trim() : undefined;
  const notes = typeof body.notes === 'string' ? body.notes.trim() : undefined;
  // v2: 别名开关(是否允许为该邮箱生成别名) + 是否公开共享
  const supportsAlias = typeof body.supports_alias === 'boolean' ? body.supports_alias : undefined;
  const isPublic = typeof body.is_public === 'boolean' ? body.is_public : undefined;
  if (aliasTemplate === undefined && notes === undefined
      && supportsAlias === undefined && isPublic === undefined) {
    return fail('没有需要更新的字段');
  }
  try {
    await db.updateForwardAccountConfig(ctx.env, user.id, id, {
      aliasTemplate, notes, supportsAlias, isPublic,
    });
  } catch (e) {
    return fail((e as Error).message || '更新失败');
  }
  await db.addLog(ctx.env, user.id, user.username, '', 'update_account', `邮箱 ${id} 更新别名规则/备注/开关`);
  return ok(null);
}

// 收信自检:给一个收件地址,回报它会被归属到哪个邮箱(纯查询,不实际收信)。
// 用于排查「原邮箱自动转发设置是否正确」—— 把原邮箱里填的转发目标贴进来即可验证。
export async function webEmailProbe(ctx: Ctx): Promise<Response> {
  const user = await requireSession(ctx);
  const addr = String(ctx.body?.addr || '').trim();
  if (!addr) return fail('缺少 addr');
  const r = await db.probeRecipient(ctx.env, addr);
  return ok({
    ...r,
    recv_domain: (ctx.env.RECV_DOMAIN || '').trim() || '(未配置)',
    hint: r.matched === null
      ? `该地址未登记到任何邮箱/别名,邮件会被拒收。请在「我的账户」把它设为某个邮箱的专属转发地址。`
      : `该地址可正常收信,归属邮箱 ${r.accountEmail || r.accountId}`,
  });
}

// 收信诊断:列出最近到达 Worker 但没匹配到任何邮箱的收件(仅管理员)。
// 只要这里有记录,就证明 Cloudflare Email Routing 与路由规则都已经生效。
export async function webEmailUnmatched(ctx: Ctx): Promise<Response> {
  const user = await requireSession(ctx);
  // 说明:这里刻意不限制为管理员 —— 收信诊断的核心用途就是排查「转发到底通没通」,
  // 普通用户(往往就是唯一使用者)必须能自己看到。记录只含头字段,不含正文。
  // 若部署在多人共用环境且不希望互相看到收件地址,可把下一行注释取消。
  // if (!user.is_admin) return fail('仅管理员可查看收信诊断', 403);
  void user;
  const limit = Math.min(parseInt(String(ctx.body?.limit || '20'), 10) || 20, 100);
  const list = await db.listUnmatchedEmails(ctx.env, limit);
  return ok({ list, total: list.length });
}

// 管理员:把历史数据中仍然持有专属转发地址的邮箱统一重置为环境变量里的统一地址。
export async function adminFixForwardAddresses(ctx: Ctx): Promise<Response> {
  const user = await requireSession(ctx);
  if (!user.is_admin) return fail('仅管理员可操作', 403);
  const n = await db.resetForwardAddressesToUnified(ctx.env);
  return ok({ fixed: n });
}

// 授权状态探测:校验 token 是否有效,前端列表「授权状态」列用
// 路径 /api/account/mail_accounts/{id}/status, id 为倒数第二段
export async function accountAuthStatus(ctx: Ctx): Promise<Response> {
  const user = await requireSession(ctx);
  const segs = ctx.url.pathname.split('/');
  const id = segs[segs.length - 2];
  // 越权防护:校验邮箱归属(自己的或公开的)
  const account = await db.getMailAccountRaw(ctx.env, user.id, id);
  if (!account) return fail('无权操作该邮箱', 403);
  // v2 无需任何授权:绑定即可用。
  // 状态改为反映「是否已收到过转发邮件」,便于用户确认原邮箱的自动转发设置是否生效。
  const row = await ctx.env.DB.prepare('SELECT COUNT(*) AS c FROM emails WHERE account_id = ?')
    .bind(id).first<{ c: number }>();
  const received = row?.c || 0;
  return ok({
    ok: true,
    forward_address: null,
    received,
    hint: received === 0 ? '尚未收到转发邮件,请在原邮箱检查「自动转发」设置是否指向统一转发地址' : '',
  });
}

// 绑定 IMAP(应用密码)收信账号
// 校验字段 -> 加密密码 -> 测试连接(能登录 INBOX 才算通过) -> 落库(upsert) -> 记日志
export async function accountBindImap(ctx: Ctx): Promise<Response> {
  const user = await requireSession(ctx);
  const body = ctx.body || {};
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const isPublic = body.is_public === true;
  // 是否支持别名: 默认 false —— 关闭时该邮箱只能被直接选中,不能生成别名;
  // 开启后才允许按 alias_template 生成别名(如 Gmail 的 jk+ui@gmail.com 加号别名)。
  const supportsAlias = body.supports_alias === true;
  // 别名规则模板(可空): 如 "{local}+{label}@{domain}" / "{label}@{domain}"
  const aliasTemplate = typeof body.alias_template === 'string' ? body.alias_template.trim() : '';
  const notes = typeof body.notes === 'string' ? body.notes.trim() : '';

  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return fail('请填写有效的邮箱地址');

  // 同一用户不要重复绑定同一个邮箱
  const dup = await db.getMailAccountByUserAndEmail(ctx.env, user.id, 'forward', email);
  if (dup) return fail('该邮箱已绑定,请勿重复添加');

  const { id, forward_address } = await db.addForwardAccount(ctx.env, user.id, email, {
    isPublic,
    supportsAlias,
    aliasTemplate: aliasTemplate || null,
    notes: notes || null,
  });
  await db.addLog(
    ctx.env, user.id, user.username, email, 'bind_mailbox',
    `绑定了邮箱 ${email}`,
  );
  return ok({
    id, provider: 'forward', email,
    supports_alias: supportsAlias,
  });
}

export async function accountAvailableAccounts(ctx: Ctx): Promise<Response> {
  const user = await requireSession(ctx);
  const accounts = await db.listAvailableAccounts(ctx.env, user.id);
  return ok(accounts);
}

// ============ 别名 ============
export async function accountSetAlias(ctx: Ctx): Promise<Response> {
  const user = await requireSession(ctx);
  const { mail_account_id, label } = ctx.body;
  if (!label || !label.trim()) return fail('别名标签不能为空');
  if (!mail_account_id) return fail('请选择邮箱');
  // 旧版「替换唯一别名」语义:先停用其它生效别名,再创建/启用新的
  const active = await db.listActiveAliases(ctx.env, user.id);
  for (const a of active) {
    if (a.mail_account_id !== mail_account_id || a.label !== label.trim()) {
      await db.deactivateAlias(ctx.env, user.id, a.id);
    }
  }
  const { alias, err } = await db.createUserAlias(ctx.env, user.id, mail_account_id, label.trim());
  if (err) return fail(err);
  if (!alias) return fail('用户不存在', 404);
  await db.addLog(ctx.env, user.id, user.username, alias.full, 'set_alias', '设置了别名');
  const updated = await db.getUserById(ctx.env, user.id);
  return ok(updated);
}

export async function accountRandomLabel(ctx: Ctx): Promise<Response> {
  await requireSession(ctx);
  return ok({ label: randomLabel() });
}

// ============ 邮件查询 (API Key) ============
function resolveAccountByTo(user: SafeUser, toEmail: string): SafeUser['mail_accounts'][0] | null {
  // to 邮箱反查主邮箱 (含公开邮箱)
  // 这里只查自己绑定的;公开邮箱需走 list_available
  // 简化: 直接用 user.mail_accounts 中的 email 做 prefix 匹配
  const [local, domain] = toEmail.split('@');
  if (!domain) return null;
  const mainPrefix = local.split('+')[0];
  const mainEmail = `${mainPrefix}@${domain}`;
  return user.mail_accounts.find(a => a.email === mainEmail) || null;
}

export async function apiFetchEmails(ctx: Ctx): Promise<Response> {
  const user = await requireApiKey(ctx);
  const params: FetchParams = { limit: 50, ...ctx.body };
  if (!params.to) return fail('API调用必须指定to查询邮箱');

  // 反查可用的邮箱账号(含公开)
  const available = await db.listAvailableAccounts(ctx.env, user.id);
  const account = resolveAccountByTo({ ...user, mail_accounts: available } as SafeUser, params.to);
  if (!account) return fail(`未找到 ${params.to} 对应的邮箱或无权使用`);

  try {
    const emails = await fetchEmails(ctx.env, account.id, params);
    await db.addLog(ctx.env, user.id, user.username, params.to, 'fetch_emails', `获取了${emails.length}封邮件`);
    return ok({
      total: emails.length,
      emails,
      query: {
        email: account.email,
        to: params.to,
        sender: params.sender,
        subject: params.subject,
        body: params.body,
        keyword: params.keyword,
        unseen: params.unseen,
        start_time: params.start_time,
        end_time: params.end_time,
        limit: params.limit,
      },
    });
  } catch (e) {
    return fail('邮件查询失败,请稍后重试', 500);
  }
}

export async function apiMarkRead(ctx: Ctx): Promise<Response> {
  const user = await requireApiKey(ctx);
  const { to, sender, subject } = ctx.body;
  if (!to) return fail('必须指定 to 查询邮箱');
  const available = await db.listAvailableAccounts(ctx.env, user.id);
  const account = resolveAccountByTo({ ...user, mail_accounts: available } as SafeUser, to);
  if (!account) return fail('未找到对应邮箱或无权使用');
  try {
    const count = await markEmailsReadBySender(ctx.env, account.id, sender, subject);
    await db.addLog(ctx.env, user.id, user.username, to, 'mark_read', `标记${count}封已读`);
    return ok({ marked: count });
  } catch (e) {
    return fail('标记已读失败,请稍后重试', 500);
  }
}

// ============ Web 邮件查询 (Session) ============
// 支持三种查询范围:
//   1) alias_id       查询指定别名
//   2) all_aliases    聚合并去重查询当前用户全部生效别名
//   3) all_aliases=false + mail_account_id  管理员查询整箱(不过滤别名)
// 统一模糊搜索走 q 参数(发件人/收件人/主题/正文/HTML/附件名)
const FETCH_CAP_MIN = 40;
const FETCH_CAP_MAX = 150;

function clamp(n: number, min: number, max: number): number {
  return Math.min(Math.max(n, min), max);
}

export async function webFetchEmails(ctx: Ctx): Promise<Response> {
  const user = await requireSession(ctx);
  const params: FetchParams = { limit: 10, ...ctx.body };
  // silent=true: 自动收件模式,不记录日志
  const silent = ctx.body?.silent === true;
  const q = typeof ctx.body?.q === 'string' ? ctx.body.q.trim() : '';
  const offset = Math.max(0, parseInt(String(ctx.body?.offset || '0'), 10) || 0);
  const limit = clamp(parseInt(String(ctx.body?.limit || '10'), 10) || 10, 5, 50);

  const activeAliases = await db.listActiveAliases(ctx.env, user.id);

  interface Target { accountId: string; to?: string; aliasId?: string; aliasFull?: string; aliasCreated?: string; }
  let targets: Target[] = [];
  let scopeLabel = '';
  let aliasCreatedAt: string | undefined;

  if (params.alias_id) {
    const a = await db.getAliasRowById(ctx.env, user.id, params.alias_id);
    if (!a) return fail('别名不存在');
    if (a.status !== 'active') return fail('该别名已过期,请在历史别名中恢复启用');
    targets = [{ accountId: a.mail_account_id, to: a.full, aliasId: a.id, aliasFull: a.full, aliasCreated: a.created_at }];
    scopeLabel = a.full;
    aliasCreatedAt = a.created_at;
  } else if (ctx.body?.all_aliases === false && params.mail_account_id) {
    // 直接选中某个邮箱查询(不按别名过滤)
    // v2 关键: 关闭「支持别名」的邮箱无法生成别名,只能被直接选中收信,
    // 因此**普通用户也必须能按邮箱整箱查询**,不能再限制为管理员。
    // 权限由后文 listAvailableAccounts 校验:只能是自己的,或已被公开共享的。
    targets = [{ accountId: params.mail_account_id, to: params.to }];
    scopeLabel = '(整箱)';
  } else if (activeAliases.length > 0) {
    targets = activeAliases.map(a => ({
      accountId: a.mail_account_id, to: a.full, aliasId: a.id, aliasFull: a.full, aliasCreated: a.created_at,
    }));
    scopeLabel = `(全部 ${activeAliases.length} 个别名)`;
  } else if (user.is_admin && params.mail_account_id) {
    targets = [{ accountId: params.mail_account_id, to: params.to }];
    scopeLabel = '(整箱)';
  } else {
    return fail('暂无生效中的别名,请先创建别名邮箱');
  }

  // 如果指定了别名且前端未传时间范围,默认查询该别名创建(激活)时间至今的邮件,
  // 续期不改变 created_at,因此旧邮件也包含在内
  if (aliasCreatedAt && !params.start_time) {
    params.start_time = aliasCreatedAt;
  }

  // 抓取上限:随 offset 增长,但不超过 FETCH_CAP_MAX(保护 Gmail / Graph 配额)
  const errors: string[] = [];
  const touched: string[] = [];

  // ===== v2: 邮件已由 Email Worker 接收并落库,这里直接查本地 D1 =====
  // 不再实时连 IMAP / 调 Gmail API,因此不会再触发免费套餐的 CPU 超限(error 1102),
  // 也不再依赖任何 OAuth 授权。
  //
  // 权限分离:只能查询「属于自己的邮箱」或「已被公开共享的邮箱」。
  // 管理员可查询任意邮箱(便于帮用户排查)。
  let targetIds: string[];
  if (user.is_admin) {
    targetIds = targets.map(t => t.accountId);
  } else {
    const available = await db.listAvailableAccounts(ctx.env, user.id);
    const allowedIds = new Set(available.map(a => a.id));
    targetIds = targets.map(t => t.accountId).filter(id => allowedIds.has(id));
    if (targetIds.length === 0) {
      return fail('暂无可用邮箱,请先绑定邮箱(或该邮箱未对你公开共享)');
    }
  }

  const { rows, total } = await db.listEmails(ctx.env, {
    accountIds: targetIds,
    aliasId: params.alias_id,
    q,
    startTime: params.start_time,
    endTime: params.end_time,
    unreadOnly: params.unseen === true,
    limit,
    offset,
  });

  const emails = rows.map(toEmail);
  const hasMore = offset + emails.length < total;
  if (emails.length > 0 && params.alias_id) touched.push(params.alias_id);

  // 命中邮件的别名刷新「最后使用时间」(带 60 秒节流,避免自动收件疯狂写库)
  if (touched.length) {
    const now = Date.now();
    const needTouch = activeAliases
      .filter(a => touched.indexOf(a.id) !== -1)
      .filter(a => now - Date.parse(a.last_used_at || '') > 60_000)
      .map(a => a.id);
    if (needTouch.length) await db.touchAliases(ctx.env, user.id, needTouch);
  }

  // 仅非静默模式记录日志,避免自动收件撑爆日志
  if (!silent) {
    await db.addLog(ctx.env, user.id, user.username, scopeLabel, 'web_fetch', `获取了${emails.length}封邮件`);
  }

  return ok({
    total,
    offset,
    limit,
    has_more: hasMore,
    emails,
    query: {
      email: '',
      to: scopeLabel,
      q,
      unseen: params.unseen,
      start_time: params.start_time,
      end_time: params.end_time,
      limit,
      offset,
    },
    aliases: activeAliases.map(a => ({
      id: a.id, full: a.full, label: a.label, remain_ms: a.remain_ms || 0, created_at: a.created_at,
    })),
    errors,
  });
}

// ============ Web 邮件标记已读 (Session) ============
// 前端弹窗查看邮件时自动调用,使用 session 认证,无需 API Key
export async function webMarkRead(ctx: Ctx): Promise<Response> {
  const user = await requireSession(ctx);
  const rawUser = await db.getUserById(ctx.env, user.id);
  const { sender, subject, mail_account_id, alias_id } = ctx.body;

  let accountId = mail_account_id;
  if (alias_id) {
    const a = await db.getAliasRowById(ctx.env, user.id, alias_id);
    if (!a) return fail('别名不存在', 404);
    accountId = a.mail_account_id;
  } else if (rawUser?.alias) {
    // 兼容:未指定时落到主别名
    accountId = rawUser.alias.mail_account_id;
  }
  if (!accountId) return fail('请选择邮箱');
  // 越权防护
  const account = await db.getMailAccountRaw(ctx.env, user.id, accountId);
  if (!account) return fail('无权操作该邮箱', 403);

  try {
    // v2: 优先按邮件 id 批量标记(列表里直接带 id);
    // 未传 ids 时退回按「发件人 + 主题」匹配,兼容旧调用方式。
    const ids: string[] = Array.isArray(ctx.body?.ids) ? ctx.body.ids.map(String) : [];
    const count = ids.length
      ? await markEmailsRead(ctx.env, accountId, ids)
      : await markEmailsReadBySender(ctx.env, accountId, sender, subject);
    // 标记已读不记录日志 (避免自动查看时撑爆日志)
    return ok({ marked: count });
  } catch (e) {
    return fail('标记已读失败,请稍后重试', 500);
  }
}

// ============ Web 邮件详情(按需拉取单封完整正文) ============
// IMAP 列表只拉头部(轻量),打开详情时再调此接口拉取该封完整邮件(含正文/HTML/附件)。
export async function webEmailDetail(ctx: Ctx): Promise<Response> {
  const user = await requireSession(ctx);
  const { id } = ctx.body || {};
  if (!id) return fail('缺少邮件 id');
  const row = await db.getEmailRow(ctx.env, String(id));
  if (!row) return fail('邮件不存在', 404);
  // 越权防护:该邮件所属邮箱必须是自己的或已公开共享的
  const account = await db.getMailAccountRaw(ctx.env, user.id, row.account_id);
  if (!account) return fail('无权查看该邮件', 403);
  // 正文/附件不入库,返回 raw 下载地址;前端用 postal-mime 在浏览器解析,
  // 这样 Worker 完全不做 MIME 解析,不会触碰免费套餐 10ms CPU 上限。
  return ok({ email: toEmail(row) });
}

// ============ 下载原始邮件(.eml) ============
// 只做 R2 流式转发(几乎不耗 CPU),解析工作全部交给浏览器端的 postal-mime。
export async function webEmailRaw(ctx: Ctx): Promise<Response> {
  const user = await requireSession(ctx);
  const id = ctx.url.searchParams.get('id') || (ctx.body && ctx.body.id);
  if (!id) return fail('缺少邮件 id');
  const row = await db.getEmailRow(ctx.env, String(id));
  if (!row) return fail('邮件不存在', 404);
  if (!user.is_admin) {
    const account = await db.getMailAccountRaw(ctx.env, user.id, row.account_id);
    if (!account) return fail('无权查看该邮件', 403);
  }
  if (!row.raw_key) return fail('该邮件未保存原始内容', 404);
  const obj = await ctx.env.EMAIL_RAW.get(row.raw_key);
  if (!obj) return fail('原始邮件已丢失', 404);
  const headers = new Headers({
    'Content-Type': 'message/rfc822',
    'Content-Disposition': `attachment; filename="${row.id}.eml"`,
    'Access-Control-Allow-Origin': '*',
  });
  return new Response(obj.body, { status: 200, headers });
}

// 统一转发地址配置:返回系统配置的唯一收信地址(来自 UNIFIED_FORWARD_ADDRESS 环境变量)。
// 该地址对所有邮箱一致,无需再通过 CATCHALL_ACCOUNT_ID 去 DB 查。
export async function webCatchallConfig(ctx: Ctx): Promise<Response> {
  const addr = (ctx.env.UNIFIED_FORWARD_ADDRESS || '').trim() || null;
  return ok({ enabled: !!addr, forward_address: addr });
}

// 未读邮件计数:给前端 alias/account 小板块的红点提供数据。
// 只统计用户自己可见的别名与邮箱(含公开账号,但仅按账号 ID 统计,不暴露主邮箱)。
export async function webEmailUnreadCounts(ctx: Ctx): Promise<Response> {
  const user = await requireSession(ctx);
  const aliases = await db.listActiveAliases(ctx.env, user.id);
  const accounts = await db.listAvailableAccounts(ctx.env, user.id);
  const counts = await db.countUnreadByScope(
    ctx.env,
    aliases.map(a => a.id),
    accounts.map(a => a.id),
  );
  return ok({
    aliases: counts.aliases,
    accounts: counts.accounts,
    total_alias: Object.values(counts.aliases).reduce((a, b) => a + b, 0),
    total_account: Object.values(counts.accounts).reduce((a, b) => a + b, 0),
  });
}

// ============ Webhook 管理 ============
export async function webhookList(ctx: Ctx): Promise<Response> {
  const user = await requireSession(ctx);
  const list = await db.listWebhooks(ctx.env, user.id);
  // 不返回 secret
  return ok(list.map(w => ({ ...w, secret: w.secret ? '***' : null })));
}

export async function webhookCreate(ctx: Ctx): Promise<Response> {
  const user = await requireSession(ctx);
  const { mail_account_id, scope, target_alias, url, secret, events, format } = ctx.body;
  if (!mail_account_id) return fail('请选择监听的邮箱');
  if (!url) return fail('请填写回调 URL');
  if (!/^https?:\/\//.test(url)) return fail('URL 必须以 http(s):// 开头');
  if (!events) return fail('请选择订阅事件');
  const fmt = ['card', 'markdown', 'text', 'json'].indexOf(String(format || 'card')) >= 0
    ? String(format || 'card') : 'card';
  // scope: alias(指定别名) | alias_all(全部别名) | account(整箱)
  const validScope = ['alias', 'alias_all', 'account'].includes(String(scope || 'alias'));
  if (!validScope) return fail('无效的监听范围');

  // 权限: 邮箱必须存在且可见(自己的 或 公开的)
  const account = await db.getMailAccountRaw(ctx.env, user.id, mail_account_id);
  if (!account) return fail('无权操作该邮箱', 403);
  const isOwn = account.user_id === user.id;

  // 权限校验: 别人的公开邮箱 只能监听自己的别名
  if (!isOwn) {
    if (scope !== 'alias') return fail('监听他人公开邮箱只能选择「指定别名」');
    // target_alias 必须是当前用户自己的活跃别名
    if (!target_alias) return fail('请选择你要监听的别名');
    const aliasRow = await ctx.env.DB.prepare(
      "SELECT id FROM user_aliases WHERE full = ? AND user_id = ? AND status = 'active'"
    ).bind(target_alias, user.id).first<{ id: string }>();
    if (!aliasRow) return fail('该别名不是你存活的别名', 403);
  } else {
    // 自己的邮箱: alias/alias_all 时 target_alias 可选
    if ((scope === 'alias' || scope === 'alias_all') && target_alias) {
      const aliasRow = await ctx.env.DB.prepare(
        "SELECT id FROM user_aliases WHERE full = ? AND mail_account_id = ? AND status = 'active'"
      ).bind(target_alias, mail_account_id).first<{ id: string }>();
      if (!aliasRow) return fail('该别名不存在或已过期', 403);
    }
  }

  // SSRF 防护:拒绝内网/元数据地址
  if (isPrivateOrUnsafeUrl(url)) return fail('不允许的回调地址');
  // 单 webhook 约束:每用户仅保留一个订阅,创建前清除旧的
  await db.deleteWebhooksByUser(ctx.env, user.id);
  const id = await db.createWebhook(ctx.env, user.id, mail_account_id, target_alias || null, url, secret || null, events, fmt);
  await db.addLog(ctx.env, user.id, user.username, '', 'create_webhook', `创建了 Webhook ${url}`);
  return ok({ id });
}

// SSRF 防护:拦截内网 IP 和云元数据地址
// 放行常见第三方推送平台域名(飞书/钉钉/企业微信/Slack/Discord 等),便于直接推送
function isPrivateOrUnsafeUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    // 白名单:允许的第三方推送平台
    const PUSH_WHITELIST = [
      'open.feishu.cn',           // 飞书机器人
      'oapi.dingtalk.com',        // 钉钉机器人
      'qyapi.weixin.qq.com',      // 企业微信机器人
      'hooks.slack.com',          // Slack
      'discord.com',              // Discord
      'discordapp.com',
    ];
    if (PUSH_WHITELIST.some(d => host === d || host.endsWith('.' + d))) return false;
    // 拒绝 localhost 和私有 IP 段
    if (host === 'localhost' || host === '0.0.0.0') return true;
    if (/^127\./.test(host)) return true;
    if (/^10\./.test(host)) return true;
    if (/^192\.168\./.test(host)) return true;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
    if (/^169\.254\./.test(host)) return true;  // 云元数据
    if (host.startsWith('::1') || host.startsWith('fc') || host.startsWith('fd')) return true;  // IPv6 内网
    return false;
  } catch {
    return true;
  }
}

export async function webhookDelete(ctx: Ctx): Promise<Response> {
  const user = await requireSession(ctx);
  const id = ctx.url.pathname.split('/').pop()!;
  const ok2 = await db.deleteWebhook(ctx.env, id, user.id);
  if (!ok2) return fail('Webhook 不存在', 404);
  return ok(null);
}

// 切换推送格式: card / markdown / text / json
export async function webhookSetFormat(ctx: Ctx): Promise<Response> {
  const user = await requireSession(ctx);
  const id = ctx.url.pathname.split('/').slice(-2, -1)[0];
  const format = String(ctx.body?.format || 'card');
  if (['card', 'markdown', 'text', 'json'].indexOf(format) < 0) return fail('不支持的推送格式');
  const ok2 = await db.updateWebhookFormat(ctx.env, id, user.id, format);
  if (!ok2) return fail('Webhook 不存在', 404);
  return ok({ format });
}

export async function webhookTest(ctx: Ctx): Promise<Response> {
  const user = await requireSession(ctx);
  // 路径 /api/webhooks/:id/test, id 为倒数第二段(不能 pop,会拿到 'test')
  const id = ctx.url.pathname.split('/').slice(-2, -1)[0];
  const list = await db.listWebhooks(ctx.env, user.id);
  const wh = list.find(w => w.id === id);
  if (!wh) return fail('Webhook 不存在', 404);
  const ok2 = await sendTestEvent(ctx.env, wh);
  return ok({ success: ok2 });
}

// 触发轮询推送 (需要 API Key)
export async function webhookPoll(ctx: Ctx): Promise<Response> {
  const user = await requireApiKey(ctx);
  const accountId = ctx.url.searchParams.get('account_id');
  if (!accountId) return fail('缺少 account_id');
  // 越权防护:校验 account_id 归属当前用户
  const account = await db.getMailAccountRaw(ctx.env, user.id, accountId);
  if (!account) return fail('无权操作该邮箱', 403);
  const result = await pollAndPush(ctx.env, accountId);
  await db.addLog(ctx.env, user.id, user.username, accountId, 'webhook_poll', `推送 ${result.pushed} 个`);
  return ok(result);
}
