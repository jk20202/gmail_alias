// Worker 入口 - 路由分发 + 错误处理 + CORS + 静态资源托管
import type { Env } from './types';
import { initDB, ensureSchema } from './db';

// Worker isolate 级别一次性初始化标记:避免每次 fetch 都重复 initDB + ensureSchema(KV 往返),
// 显著降低历史别名等接口的"冷启动"感知延迟
let dbReady = false;
import * as routes from './routes';
import { HTTPError, type Ctx } from './routes';
import { getActiveWebhookAccountIds } from './db';
import { pollAndPush } from './webhook';
import { emailHandler, schedulePush } from './email';

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
  buildRoute('POST', '/api/account/mail_accounts/imap', routes.accountBindImap),
  buildRoute('GET',  '/api/account/mail_accounts/:id/status', routes.accountAuthStatus),
  buildRoute('PUT',  '/api/account/mail_accounts/:id/public', routes.accountTogglePublic),
  buildRoute('PATCH', '/api/account/mail_accounts/:id', routes.accountUpdateMailAccount),
  buildRoute('DELETE', '/api/account/mail_accounts/:id', routes.accountDeleteAccount),
  // 别名(多别名: 每用户最多 5 个同时生效,1 小时有效期,支持收藏与历史)
  buildRoute('GET',  '/api/account/aliases/limits',   routes.aliasLimits),
  buildRoute('GET',  '/api/account/aliases/history',  routes.aliasHistory),
  buildRoute('GET',  '/api/account/aliases',          routes.aliasListActive),
  buildRoute('POST', '/api/account/aliases',          routes.aliasCreate),
  buildRoute('POST', '/api/account/aliases/:id/restore',    routes.aliasRestore),
  buildRoute('POST', '/api/account/aliases/:id/renew',       routes.aliasRenew),
  buildRoute('POST', '/api/account/aliases/:id/deactivate',  routes.aliasDeactivate),
  buildRoute('POST', '/api/account/aliases/:id/favorite',    routes.aliasFavorite),
  buildRoute('DELETE', '/api/account/aliases/:id',           routes.aliasDelete),
  // OAuth (Gmail 走 Device Code;微软走 Device Code 轮询;Authorization Code 作为备用)
  buildRoute('GET',  '/api/account/oauth/google/status',  routes.accountGoogleOAuthStatus),
  buildRoute('POST', '/api/account/oauth/google/creds',    routes.accountSaveGoogleCreds),
  buildRoute('GET',  '/api/account/oauth/start', routes.accountOAuthStart),
  buildRoute('POST', '/api/account/oauth/google/device',        routes.accountGoogleDeviceStart),
  buildRoute('GET',  '/api/account/oauth/google/device/status', routes.accountGoogleDeviceStatus),
  buildRoute('POST', '/api/account/oauth/device',       routes.accountDeviceStart),
  buildRoute('GET',  '/api/account/oauth/device/status', routes.accountDeviceStatus),
  buildRoute('GET',  '/oauth/callback',          routes.oauthCallback),
  buildRoute('GET',  '/api/admin/oauth/config',  routes.adminGetOAuthConfig),
  buildRoute('PUT',  '/api/admin/oauth/config',  routes.adminSaveOAuthConfig),
  // 别名(兼容旧接口)
  buildRoute('POST', '/api/account/alias',       routes.accountSetAlias),
  buildRoute('GET',  '/api/account/alias/random_label', routes.accountRandomLabel),
  // 邮件查询
  buildRoute('POST', '/api/email/fetch',         routes.apiFetchEmails),
  buildRoute('POST', '/api/email/mark_read',     routes.apiMarkRead),
  buildRoute('POST', '/api/web/email/fetch',     routes.webFetchEmails),
  buildRoute('POST', '/api/web/email/detail',    routes.webEmailDetail),
  buildRoute('GET',  '/api/web/email/raw',       routes.webEmailRaw),
  buildRoute('POST', '/api/web/email/mark_read', routes.webMarkRead),
  // 收信排查:自检某个收件地址能否被归属 / 查看最近未识别的收件
  buildRoute('POST', '/api/web/email/probe',     routes.webEmailProbe),
  buildRoute('POST', '/api/web/email/unmatched', routes.webEmailUnmatched),
  buildRoute('POST', '/api/admin/fix_forward',   routes.adminFixForwardAddresses),
  // 配置/未读
  buildRoute('GET',  '/api/config/catchall',     routes.webCatchallConfig),
  buildRoute('POST', '/api/web/email/unread_counts', routes.webEmailUnreadCounts),
  // Webhook
  buildRoute('GET',  '/api/webhooks',            routes.webhookList),
  buildRoute('POST', '/api/webhooks',            routes.webhookCreate),
  buildRoute('PATCH', '/api/webhooks/:id',       routes.webhookUpdate),
  buildRoute('GET',  '/api/webhooks/:id/deliveries', routes.webhookDeliveries),
  buildRoute('DELETE', '/api/webhooks/:id',      routes.webhookDelete),
  buildRoute('POST', '/api/webhooks/:id/test',   routes.webhookTest),
  buildRoute('POST', '/api/webhooks/:id/format', routes.webhookSetFormat),
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
    // 1. 每个 Worker isolate 只执行一次数据库初始化 + schema 迁移
    //    避免每次请求都产生 KV / D1 冷启动往返,解决历史别名等接口"卡顿/转圈"问题
    if (!dbReady) {
      try { await initDB(env); dbReady = true; }
      catch (e) { console.error('INIT_DB_ERR', e); }
      try { await ensureSchema(env); }
      catch (e) { console.error('ENSURE_SCHEMA_ERR', e); }
    }
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
        // HTML/JS/CSS 全部禁用边缘缓存,确保用户总能加载最新前端代码(防止登录 bug、webhook 旧版缓存问题)
        const ct = newHeaders.get('Content-Type') || '';
        if (ct.includes('text/html') || ct.includes('javascript') || ct.includes('css')) {
          newHeaders.set('Cache-Control', 'no-cache, no-store, must-revalidate, proxy-no-cache');
          newHeaders.set('Pragma', 'no-cache');
          newHeaders.set('Surrogate-Control', 'no-store');
          // 清除可能已存在的 CDN 缓存指示,防止 Cloudflare 边缘继续返回 HIT 旧版本
          newHeaders.delete('ETag');
          newHeaders.delete('Last-Modified');
        }
        return new Response(assetResp.body, { status: assetResp.status, headers: newHeaders, statusText: assetResp.statusText });
      }
    } catch { /* 走 SPA 回退 */ }

    // 5. SPA 回退: 非 API、非静态资源的页面导航请求,统一返回 index.html。
    //    这样 /mail /account /settings 等独立 URL 可被直接访问 / 书签 / 分享,刷新也不会 404
    const accept = req.headers.get('accept') || '';
    // 浏览器导航带 text/html;无扩展名的路径(如 /account)也视为页面路由(curl 等不带 Accept 时同样生效)
    const isNav = accept.includes('text/html') || !pathname.includes('.');
    if (isNav && !pathname.startsWith('/api/')) {
      return routes.indexPage({ env, req, url });
    }

    return new Response(JSON.stringify({ code: 404, msg: 'Not Found', data: null }), {
      status: 404,
      headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS },
    });
  },

  // ============ 定时任务 (Cron Trigger) ============
  // 每分钟自动轮询所有有活跃 webhook 的邮箱账号,拉取新邮件并推送
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    try {
      try { await ensureSchema(env); } catch { /* ignore */ }
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

  // ============ Email Worker (Cloudflare Email Routing 收信) ============
  // 各邮箱把邮件「自动转发」到本 Worker 绑定的域名后,Cloudflare 会把每封邮件交给这里处理。
  // 需在 Cloudflare 后台 Email → Email Routing → Routing rules 把规则指向本 Worker。
  //
  // 实现刻意保持极轻:只提取头字段 + 原始邮件流式存 R2 + 元数据入库,
  // 不做 MIME 解析(免费套餐 Email Worker 同样只有 10ms CPU 限额)。
  //
  // v9 实时推送:emailHandler 完成后用 ctx.waitUntil() 异步触发 push,
  // 不阻塞 Email Routing 响应,延迟从「等下一次 cron」(最坏 60s)降到「入库即推」(秒级)。
  async email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext): Promise<void> {
    await emailHandler(message, env, ctx);
    ctx.waitUntil(schedulePush(message, env));
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
