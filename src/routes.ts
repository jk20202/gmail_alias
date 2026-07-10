// 所有 HTTP 路由处理 - 按模块分组,每个函数接收 ctx 返回 Response
import type { Env, SafeUser, FetchParams } from './types';
import * as db from './db';
import { buildAuthURL, handleOAuthCallback, checkAccountAuthStatus, startDeviceFlow, pollDeviceFlow } from './oauth';
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
    const resp = await ctx.env.ASSETS.fetch(new Request('http://localhost/', { method: 'GET' }));
    // HTML 禁用缓存: 防止 CDN 边缘缓存旧版前端导致登录等功能失效
    const h = new Headers(resp.headers);
    h.set('Cache-Control', 'no-cache, no-store, must-revalidate, proxy-no-cache');
    h.set('Pragma', 'no-cache');
    h.set('Surrogate-Control', 'no-store');
    return new Response(resp.body, { status: resp.status, headers: h, statusText: resp.statusText });
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
  if (error) return renderOAuthResult(false, '授权失败,请重试');  // 不回显 error 防注入
  if (!code || !state) return renderOAuthResult(false, '缺少 code 或 state 参数');
  try {
    const result = await handleOAuthCallback(ctx.env, code, state);
    return renderOAuthResult(true, `已成功绑定 ${escapeHtml(result.email)}`);
  } catch (e) {
    return renderOAuthResult(false, '授权流程异常,请重新发起');
  }
}

// HTML 转义防 XSS
function escapeHtml(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function renderOAuthResult(success: boolean, message: string): Response {
  // message 已转义,可安全插入 HTML
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>OAuth 绑定结果</title>
  <style>body{font-family:sans-serif;padding:40px;text-align:center;color:${success ? '#16a34a' : '#dc2626'};}</style></head>
  <body><h2>${success ? '绑定成功' : '绑定失败'}</h2><p>${message}</p>
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
  const { alias, err } = await db.setAlias(ctx.env, user.id, mail_account_id, label.trim());
  if (err) return fail(err);
  if (!alias) return fail('用户不存在', 404);
  await db.addLog(ctx.env, user.id, user.username, alias.full, 'set_alias', '设置了别名');
  // 别名变更后,旧 webhook 的 target_alias 已失效,自动清除该用户全部 webhook
  await db.deleteWebhooksByUser(ctx.env, user.id);
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

  // 越权防护:校验该邮箱账号归属当前用户(自己的或公开的)
  const account = await db.getMailAccountRaw(ctx.env, user.id, accountId);
  if (!account) return fail('无权查询该邮箱', 403);

  try {
    const emails = await fetchEmails(ctx.env, accountId, { ...params, to: toFilter });
    await db.addLog(ctx.env, user.id, user.username, toFilter || '(全部)', 'web_fetch', `获取了${emails.length}封邮件`);
    return ok({
      total: emails.length,
      emails,
      query: { email: '', to: toFilter, sender: params.sender, subject: params.subject, keyword: params.keyword, unseen: params.unseen, limit: params.limit },
    });
  } catch (e) {
    return fail('邮件查询失败,请稍后重试', 500);
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
  // 单 webhook 约束:每用户仅保留一个订阅,创建前清除旧的(换别名时也会自动清)
  await db.deleteWebhooksByUser(ctx.env, user.id);
  const id = await db.createWebhook(ctx.env, user.id, mail_account_id, target_alias || null, url, secret || null, events);
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
