// Worker 入口 - 路由分发 + 错误处理 + CORS + 静态资源托管
import type { Env } from './types';
import { initDB } from './db';
import * as routes from './routes';
import { HTTPError, type Ctx } from './routes';
import { getActiveWebhookAccountIds } from './db';
import { pollAndPush } from './webhook';

// CORS 头
const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// 路由表: [METHOD, PATTERN, HANDLER]
// PATTERN 支持 :param 占位 (用于 RESTful)
interface RouteEntry {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: (ctx: Ctx) => Promise<Response>;
}

function buildRoute(method: string, path: string, handler: (ctx: Ctx) => Promise<Response>): RouteEntry {
  const keys: string[] = [];
  // /api/admin/users/:id -> /api/admin/users/([^/]+)
  const regexStr = path.replace(/:([^/]+)/g, (_, k) => {
    keys.push(k);
    return '([^/]+)';
  });
  return { method, pattern: new RegExp(`^${regexStr}$`), keys, handler };
}

// 路由表 (注意:静态路由放在动态路由前,避免误匹配)
const ROUTE_TABLE: RouteEntry[] = [
  // 页面
  buildRoute('GET',  '/',                       routes.indexPage),
  buildRoute('GET',  '/health',                 routes.health),
  // Auth
  buildRoute('POST', '/api/auth/login',         routes.authLogin),
  buildRoute('POST', '/api/auth/register',      routes.authRegister),
  buildRoute('POST', '/api/auth/logout',        routes.authLogout),
  buildRoute('POST', '/api/auth/change_password', routes.accountChangePassword),
  buildRoute('GET',  '/api/auth/me',            routes.authMe),
  // Admin - users
  buildRoute('GET',  '/api/admin/users',        routes.adminListUsers),
  buildRoute('POST', '/api/admin/users',        routes.adminCreateUser),
  buildRoute('PUT',  '/api/admin/users/:id',   routes.adminUpdateUser),
  buildRoute('POST', '/api/admin/users/:id/alias', routes.adminSetUserAlias),
  buildRoute('DELETE', '/api/admin/users/:id',  routes.adminDeleteUser),
  // Admin - 其他
  buildRoute('GET',  '/api/admin/stats',        routes.adminStats),
  buildRoute('GET',  '/api/admin/logs',         routes.adminLogs),
  buildRoute('GET',  '/api/admin/settings',     routes.adminGetSettings),
  buildRoute('PUT',  '/api/admin/settings',     routes.adminUpdateSettings),
  buildRoute('GET',  '/api/admin/mail_accounts',     routes.adminListAllAccounts),
  buildRoute('PUT',  '/api/admin/mail_accounts/:id', routes.adminUpdateAccount),
  buildRoute('DELETE', '/api/admin/mail_accounts/:id', routes.adminDeleteAccount),
  // Account 自助
  buildRoute('GET',  '/api/account',             routes.accountSelf),
  buildRoute('POST', '/api/account/api_key',     routes.accountRegenApiKey),
  buildRoute('GET',  '/api/account/mail_accounts',     routes.accountListAccounts),
  buildRoute('GET',  '/api/account/mail_accounts/available', routes.accountAvailableAccounts),
  buildRoute('GET',  '/api/account/mail_accounts/:id/status', routes.accountAuthStatus),
  buildRoute('PUT',  '/api/account/mail_accounts/:id/public', routes.accountTogglePublic),
  buildRoute('DELETE', '/api/account/mail_accounts/:id', routes.accountDeleteAccount),
  // OAuth (Gmail 走 Authorization Code 回调;微软走 Device Code 轮询,无需回调)
  buildRoute('GET',  '/api/account/oauth/start', routes.accountOAuthStart),
  buildRoute('POST', '/api/account/oauth/device',       routes.accountDeviceStart),
  buildRoute('GET',  '/api/account/oauth/device/status', routes.accountDeviceStatus),
  buildRoute('GET',  '/oauth/callback',          routes.oauthCallback),
  // 别名
  buildRoute('POST', '/api/account/alias',       routes.accountSetAlias),
  buildRoute('GET',  '/api/account/alias/random_label', routes.accountRandomLabel),
  // 邮件查询
  buildRoute('POST', '/api/email/fetch',         routes.apiFetchEmails),
  buildRoute('POST', '/api/email/mark_read',     routes.apiMarkRead),
  buildRoute('POST', '/api/web/email/fetch',     routes.webFetchEmails),
  // Webhook
  buildRoute('GET',  '/api/webhooks',            routes.webhookList),
  buildRoute('POST', '/api/webhooks',            routes.webhookCreate),
  buildRoute('DELETE', '/api/webhooks/:id',      routes.webhookDelete),
  buildRoute('POST', '/api/webhooks/:id/test',   routes.webhookTest),
  buildRoute('GET',  '/api/webhook/poll',        routes.webhookPoll),
];

// 匹配路由
function matchRoute(method: string, pathname: string): RouteEntry | null {
  for (const r of ROUTE_TABLE) {
    if (r.method !== method) continue;
    if (r.pattern.test(pathname)) return r;
  }
  return null;
}

// Worker fetch handler
export default {
  async fetch(req: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    // 1. 初始化数据库(默认管理员)
    try { await initDB(env); } catch { /* 已初始化则忽略 */ }
    // 2. CORS 预检
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(req.url);
    const pathname = url.pathname;

    // 3. 匹配 API 路由
    const route = matchRoute(req.method, pathname);
    if (route) {
      const ctx: Ctx = { env, req, url };
      // 解析 body (非 GET/DELETE 时)
      if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
        ctx.body = await parseBodySafe(req);
      }
      try {
        const resp = await route.handler(ctx);
        // 注入 CORS 头
        const newHeaders = new Headers(resp.headers);
        for (const [k, v] of Object.entries(CORS_HEADERS)) newHeaders.set(k, v);
        return new Response(resp.body, { status: resp.status, headers: newHeaders, statusText: resp.statusText });
      } catch (e) {
        return handleError(e);
      }
    }

    // 4. 静态资源 (前端 index.html 等)
    try {
      const assetResp = await env.ASSETS.fetch(req);
      if (assetResp.status !== 404) {
        const newHeaders = new Headers(assetResp.headers);
        for (const [k, v] of Object.entries(CORS_HEADERS)) newHeaders.set(k, v);
        // HTML 禁用缓存,确保用户总能加载最新前端代码(防止登录 bug 等旧版缓存问题)
        const ct = newHeaders.get('Content-Type') || '';
        if (ct.includes('text/html')) {
          newHeaders.set('Cache-Control', 'no-cache, no-store, must-revalidate, proxy-no-cache');
          newHeaders.set('Pragma', 'no-cache');
          newHeaders.set('Surrogate-Control', 'no-store');
        }
        return new Response(assetResp.body, { status: assetResp.status, headers: newHeaders, statusText: assetResp.statusText });
      }
    } catch { /* 走 404 */ }

    return new Response(JSON.stringify({ code: 404, msg: 'Not Found', data: null }), {
      status: 404,
      headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS },
    });
  },

  // ============ 定时任务 (Cron Trigger) ============
  // 每分钟自动轮询所有有活跃 webhook 的邮箱账号,拉取新邮件并推送
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    try {
      const accountIds = await getActiveWebhookAccountIds(env);
      if (accountIds.length === 0) return;
      // 并发轮询所有账号 (Cloudflare Workers 支持)
      ctx.waitUntil(Promise.allSettled(
        accountIds.map(id => pollAndPush(env, id).catch(e => {
          console.error(`Webhook poll failed for ${id}:`, e);
        }))
      ));
    } catch (e) {
      console.error('Scheduled webhook poll error:', e);
    }
  },
};

// 错误统一处理
function handleError(e: unknown): Response {
  if (e instanceof HTTPError) {
    return Response.json({ code: 1, msg: e.message, data: null }, { status: e.status, headers: CORS_HEADERS });
  }
  console.error('Unhandled error:', e);
  return Response.json(
    { code: 1, msg: `服务器内部错误: ${(e as Error).message}`, data: null },
    { status: 500, headers: CORS_HEADERS }
  );
}

async function parseBodySafe(req: Request): Promise<any> {
  try {
    return await req.json();
  } catch {
    return {};
  }
}
