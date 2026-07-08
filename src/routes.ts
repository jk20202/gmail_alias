// 所有 HTTP 路由处理 - 按模块分组,每个函数接收 ctx 返回 Response
import type { Env, SafeUser, FetchParams } from './types';
import * as db from './db';
import { buildAuthURL, handleOAuthCallback } from './oauth';
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
async function requireSession(ctx: Ctx): Promise<SafeUser> {
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
export async function indexPage(ctx: Ctx): Promise<Response> {
  // 走 [assets] 绑定,直接 fetch 静态资源
  const url = new URL(ctx.req.url);
  if (url.pathname === '/' || url.pathname === '/index.html') {
    return ctx.env.ASSETS.fetch(new Request('http://localhost/', { method: 'GET' }));
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
  if (!username || !password) return fail('用户名和密码必填');
  const raw = await db.getUserByUsername(ctx.env, username);
  if (!raw) return fail('用户名或密码错误', 401);
  const hashed = await sha256(password);
  if (raw.password !== hashed) return fail('用户名或密码错误', 401);
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

export async function authMe(ctx: Ctx): Promise<Response> {
  const user = await requireSession(ctx);
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
  const { password, is_admin } = ctx.body;
  const user = await db.updateUser(ctx.env, userId, password, is_admin);
  if (!user) return fail('用户不存在', 404);
  await db.addLog(ctx.env, admin.id, admin.username, '', 'update_user', `更新了用户 ${user.username}`);
  return ok(user);
}

export async function adminDeleteUser(ctx: Ctx): Promise<Response> {
  const admin = await requireAdmin(ctx);
  const userId = ctx.url.pathname.split('/')[4];
  if (userId === 'admin') return fail('不能删除管理员账户');
  const ok2 = await db.deleteUser(ctx.env, userId);
  if (!ok2) return fail('用户不存在', 404);
  await db.addLog(ctx.env, admin.id, admin.username, '', 'delete_user', `删除了用户 ${userId}`);
  return ok(null);
}

export async function adminStats(ctx: Ctx): Promise<Response> {
  await requireAdmin(ctx);
  const [summary, logs, accounts] = await Promise.all([
    db.statsSummary(ctx.env),
    db.listLogs(ctx.env, 500),
    db.adminListAllAccounts(ctx.env),
  ]);
  return ok({ summary: { ...summary, mail_account_count: accounts.length }, logs });
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
  const user = await requireSession(ctx);
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

// 启动 OAuth 绑定
export async function accountOAuthStart(ctx: Ctx): Promise<Response> {
  const user = await requireSession(ctx);
  const provider = ctx.url.searchParams.get('provider') as 'gmail' | 'outlook';
  if (provider !== 'gmail' && provider !== 'outlook') return fail('provider 必须为 gmail 或 outlook');
  const authUrl = await buildAuthURL(ctx.env, user.id, provider);
  return ok({ auth_url: authUrl, provider });
}

// OAuth 回调 (浏览器跳转,返回 HTML 关闭窗口)
export async function oauthCallback(ctx: Ctx): Promise<Response> {
  const code = ctx.url.searchParams.get('code');
  const state = ctx.url.searchParams.get('state');
  const error = ctx.url.searchParams.get('error');
  if (error) return renderOAuthResult(false, `授权失败: ${error}`);
  if (!code || !state) return renderOAuthResult(false, '缺少 code 或 state 参数');
  try {
    const result = await handleOAuthCallback(ctx.env, code, state);
    return renderOAuthResult(true, `已成功绑定 ${result.email}`);
  } catch (e) {
    return renderOAuthResult(false, (e as Error).message);
  }
}

function renderOAuthResult(success: boolean, message: string): Response {
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>OAuth 绑定结果</title>
  <style>body{font-family:sans-serif;padding:40px;text-align:center;color:${success ? '#16a34a' : '#dc2626'};}</style></head>
  <body><h2>${success ? '✓ 绑定成功' : '✗ 绑定失败'}</h2><p>${message}</p>
  <script>setTimeout(()=>window.close(),3000);</script></body></html>`;
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
  const { alias, err } = await db.setAlias(ctx.env, user.id, mail_account_id, label.trim());
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
    return fail(`API错误: ${(e as Error).message}`, 500);
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
    return fail(`API错误: ${(e as Error).message}`, 500);
  }
}

// ============ Web 邮件查询 (Session) ============
export async function webFetchEmails(ctx: Ctx): Promise<Response> {
  const user = await requireSession(ctx);
  const rawUser = await db.getUserById(ctx.env, user.id);
  const params: FetchParams = { limit: 50, ...ctx.body };

  let accountId = params.mail_account_id;
  let toFilter = params.to;

  // 别名优先
  if (rawUser?.alias) {
    accountId = rawUser.alias.mail_account_id;
    toFilter = rawUser.alias.full;
  } else if (!user.is_admin && !toFilter && !accountId) {
    return fail('未设置别名邮箱,请先创建别名');
  }
  if (!accountId) return fail('请选择查询邮箱');

  try {
    const emails = await fetchEmails(ctx.env, accountId, { ...params, to: toFilter });
    await db.addLog(ctx.env, user.id, user.username, toFilter || '(全部)', 'web_fetch', `获取了${emails.length}封邮件`);
    return ok({
      total: emails.length,
      emails,
      query: { email: '', to: toFilter, sender: params.sender, subject: params.subject, keyword: params.keyword, unseen: params.unseen, limit: params.limit },
    });
  } catch (e) {
    return fail(`API错误: ${(e as Error).message}`, 500);
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
  const { mail_account_id, target_alias, url, secret, events } = ctx.body;
  if (!mail_account_id) return fail('请选择监听的邮箱');
  if (!url) return fail('请填写回调 URL');
  if (!/^https?:\/\//.test(url)) return fail('URL 必须以 http(s):// 开头');
  if (!events) return fail('请选择订阅事件');
  const id = await db.createWebhook(ctx.env, user.id, mail_account_id, target_alias || null, url, secret || null, events);
  await db.addLog(ctx.env, user.id, user.username, '', 'create_webhook', `创建了 Webhook ${url}`);
  return ok({ id });
}

export async function webhookDelete(ctx: Ctx): Promise<Response> {
  const user = await requireSession(ctx);
  const id = ctx.url.pathname.split('/').pop()!;
  const ok2 = await db.deleteWebhook(ctx.env, id, user.id);
  if (!ok2) return fail('Webhook 不存在', 404);
  return ok(null);
}

export async function webhookTest(ctx: Ctx): Promise<Response> {
  const user = await requireSession(ctx);
  const id = ctx.url.pathname.split('/').pop()!;
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
  const result = await pollAndPush(ctx.env, accountId);
  await db.addLog(ctx.env, user.id, user.username, accountId, 'webhook_poll', `推送 ${result.pushed} 个`);
  return ok(result);
}
