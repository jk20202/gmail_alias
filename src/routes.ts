// 所有 HTTP 路由处理 - 按模块分组,每个函数接收 ctx 返回 Response
import type { Env, SafeUser, FetchParams, Email } from './types';
import * as db from './db';
import {
  buildAuthURL, handleOAuthCallback, checkAccountAuthStatus, startDeviceFlow, pollDeviceFlow,
  startGoogleDeviceFlow, pollGoogleDeviceFlow, getGoogleCreds, saveGoogleCreds, googleConfigStatus,
} from './oauth';
import { fetchEmails, markEmailsRead } from './emailService';
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
export async function accountGoogleDeviceStart(ctx: Ctx): Promise<Response> {
  const user = await requireSession(ctx);
  try {
    const data = await startGoogleDeviceFlow(ctx.env, user.id);
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

// 普通用户:查看 Google OAuth 凭据是否已配置(供绑定弹窗判断是否要现场填凭据)
export async function accountGoogleOAuthStatus(ctx: Ctx): Promise<Response> {
  await requireSession(ctx);
  const status = await googleConfigStatus(ctx.env);
  return ok(status);
}

// 普通用户:在绑定弹窗内当场提交 Google OAuth 凭据(全站共享,只需填一次)
export async function accountSaveGoogleCreds(ctx: Ctx): Promise<Response> {
  await requireSession(ctx);
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
  await saveGoogleCreds(ctx.env, client_id.trim(), client_secret.trim());
  return ok(await googleConfigStatus(ctx.env));
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

// 授权状态探测:校验 token 是否有效,前端列表「授权状态」列用
// 路径 /api/account/mail_accounts/{id}/status, id 为倒数第二段
export async function accountAuthStatus(ctx: Ctx): Promise<Response> {
  const user = await requireSession(ctx);
  const segs = ctx.url.pathname.split('/');
  const id = segs[segs.length - 2];
  // 越权防护:校验邮箱归属(自己的或公开的)
  const account = await db.getMailAccountRaw(ctx.env, user.id, id);
  if (!account) return fail('无权操作该邮箱', 403);
  const status = await checkAccountAuthStatus(ctx.env, id);
  return ok(status);
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
    const count = await markEmailsRead(ctx.env, account.id, sender, subject);
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
  } else if (ctx.body?.all_aliases === false) {
    // 管理员整箱查询
    if (!user.is_admin) return fail('仅管理员可查询整箱邮件', 403);
    if (!params.mail_account_id) return fail('请选择查询邮箱');
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
  const fetchCap = clamp(offset + limit, FETCH_CAP_MIN, FETCH_CAP_MAX);
  const perTarget = clamp(Math.ceil(fetchCap / targets.length), 20, fetchCap);

  const merged: Array<Email & { alias?: string }> = [];
  const seen = new Set<string>();
  const errors: string[] = [];
  const touched: string[] = [];

  for (const t of targets) {
    // 越权防护:校验该邮箱账号归属当前用户(自己的或公开的)
    const account = await db.getMailAccountRaw(ctx.env, user.id, t.accountId);
    if (!account) continue;
    try {
      const list = await fetchEmails(ctx.env, t.accountId, {
        ...params,
        to: t.to,
        q,
        limit: perTarget,
      });
      for (const e of list) {
        const key = e.id || `${e.subject}|${e.date_iso}|${e.from}`;
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push({ ...e, alias: t.aliasFull });
      }
      if (list.length > 0 && t.aliasId) touched.push(t.aliasId);
    } catch (e) {
      errors.push((e as Error).message);
    }
  }

  merged.sort((a, b) => String(b.date_iso || '').localeCompare(String(a.date_iso || '')));
  const emails = merged.slice(offset, offset + limit);
  const hasMore = merged.length >= fetchCap;

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
    total: merged.length,
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
    const count = await markEmailsRead(ctx.env, accountId, sender, subject);
    // 标记已读不记录日志 (避免自动查看时撑爆日志)
    return ok({ marked: count });
  } catch (e) {
    return fail('标记已读失败,请稍后重试', 500);
  }
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
  const { mail_account_id, target_alias, url, secret, events, format } = ctx.body;
  if (!mail_account_id) return fail('请选择监听的邮箱');
  if (!url) return fail('请填写回调 URL');
  if (!/^https?:\/\//.test(url)) return fail('URL 必须以 http(s):// 开头');
  if (!events) return fail('请选择订阅事件');
  const fmt = ['card', 'markdown', 'text', 'json'].indexOf(String(format || 'card')) >= 0
    ? String(format || 'card') : 'card';
  // 越权防护 + 权限逻辑:
  //  - 自己拥有的邮箱:可监听整个邮箱(target_alias 可选)
  //  - 公开但非自己的邮箱:仅当 target_alias 等于自己设置的别名 full 时允许(别人只能订阅自己的别名)
  const account = await db.getMailAccountRaw(ctx.env, user.id, mail_account_id);
  if (!account) return fail('无权操作该邮箱', 403);
  const isOwner = account.user_id === user.id;
  if (!isOwner) {
    // 非所有者:必须指定别名,且别名必须是当前用户已设置的别名
    if (!target_alias) return fail('订阅他人公开邮箱时必须指定自己的别名');
    if (!user.alias || user.alias.full !== target_alias) return fail('目标别名必须是您已设置的别名', 403);
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
