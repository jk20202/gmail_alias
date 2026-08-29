// OAuth 流程: Google (Gmail) + Microsoft (Outlook/Hotmail/Live)
// Google: Device Code Flow(推荐,无需 redirect_uri,天然适配 Cloudflare) + Authorization Code Flow(可选)
// 微软: Device Code Flow(公共客户端无回调地址)
import type { Env, MailAccountRaw } from './types';
import { randomHex, encrypt, decrypt, isExpired, nowISO } from './utils';
import { addMailAccount, updateMailAccountToken, getMailAccountById, getMailAccountByUserAndEmail, getSetting, setSetting, getUserGoogleCreds } from './db';

// ============ 公共配置 ============
// Gmail OAuth 端点
const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';
// Google Device Code Flow 端点(无需回调地址,适配部署在任意域名的 Worker)
const GOOGLE_DEVICE_CODE_URL = 'https://oauth2.googleapis.com/device/code';
const GOOGLE_DEVICE_VERIFY_URL = 'https://google.com/device';
// Scope: gmail.readonly 读邮件 + userinfo.email 拿邮箱地址
const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/userinfo.email',
].join(' ');

// Microsoft OAuth 端点
// 使用 consumers 租户:仅支持个人微软账号(hotmail/outlook/live),与公共客户端搭配无需 client_secret
// (参考 emails_cloud 仓库实现:common 端点 + client_secret 对个人账号常出问题)
const MS_AUTH_URL = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize';
const MS_TOKEN_URL = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token';
const MS_DEVICECODE_URL = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode';
const MS_USERINFO_URL = 'https://graph.microsoft.com/v1.0/me';
// Graph API 全限定 scope: Mail.Read 读邮件 + Mail.ReadWrite 标记已读 + User.Read 拿邮箱 + offline_access 拿 refresh_token
const MS_SCOPES = [
  'https://graph.microsoft.com/Mail.Read',
  'https://graph.microsoft.com/Mail.ReadWrite',
  'https://graph.microsoft.com/User.Read',
  'offline_access',
].join(' ');

// Thunderbird 公开注册的 Azure 应用 client_id (公共客户端,无需 client_secret)
// 作为默认值;如自注册了应用,可用环境变量 MS_CLIENT_ID 覆盖
const MS_DEFAULT_CLIENT_ID = '9e5f94bc-e8a4-4e73-b8be-63364c29d753';

// 取微软 client_id:优先环境变量,否则用 Thunderbird 公共客户端
function msClientId(env: Env): string {
  return env.MS_CLIENT_ID || MS_DEFAULT_CLIENT_ID;
}

// ============ Google 凭据读取 ============
// 优先级:① 用户自己填写并保存在 users 行的凭据(普通用户自助,完全与系统设置解耦)
//         ② Worker 环境变量(wrangler secret,适合自托管统一提供)
//         ③ 管理后台写入 D1 settings 的全局凭据(旧方案兜底)
// 用户级凭据优先,意味着任何人(含普通用户)填错都不会"卡死"全局,改自己那一份即可。
export interface GoogleCreds { clientId: string; clientSecret: string; source: 'user' | 'env' | 'db'; }

export async function getGoogleCreds(env: Env, userId?: string): Promise<GoogleCreds | null> {
  // ① 用户自身凭据(最高优先级)
  if (userId) {
    try {
      const u = await getUserGoogleCreds(env, userId);
      if (u && u.clientId) return { clientId: u.clientId, clientSecret: u.clientSecret, source: 'user' };
    } catch { /* 用户行异常时忽略,继续降级 */ }
  }
  // ② 环境变量
  const envId = (env.GOOGLE_CLIENT_ID || '').trim();
  const envSecret = (env.GOOGLE_CLIENT_SECRET || '').trim();
  const placeholder = ['', 'undefined', 'null', 'xxx', 'YOUR_CLIENT_ID', 'CHANGEME'];
  if (envId && placeholder.indexOf(envId) === -1) {
    return { clientId: envId, clientSecret: envSecret, source: 'env' };
  }
  // ③ 管理后台全局凭据(兜底)
  let dbId = '';
  let dbSecret = '';
  try {
    const rawId = await getSetting(env, 'google_client_id');
    const rawSecret = await getSetting(env, 'google_client_secret');
    if (rawId) dbId = await decrypt(rawId, env).catch(() => '');
    if (rawSecret) dbSecret = await decrypt(rawSecret, env).catch(() => '');
  } catch { /* settings 表异常时忽略 */ }
  if (dbId) return { clientId: dbId, clientSecret: dbSecret, source: 'db' };
  return null;
}

// 管理后台保存 Google 凭据(加密落库)
export async function saveGoogleCreds(env: Env, clientId: string, clientSecret: string): Promise<void> {
  await setSetting(env, 'google_client_id', clientId ? await encrypt(clientId, env) : '');
  await setSetting(env, 'google_client_secret', clientSecret ? await encrypt(clientSecret, env) : '');
}

// 对外展示用的脱敏信息(配置状态自检)
export async function googleConfigStatus(env: Env): Promise<{ configured: boolean; client_id_masked: string; source: string }> {
  const creds = await getGoogleCreds(env);
  if (!creds) return { configured: false, client_id_masked: '', source: '' };
  const id = creds.clientId;
  const masked = id.length > 12
    ? id.slice(0, 6) + '****' + id.slice(-4)
    : '****';
  return { configured: true, client_id_masked: masked, source: creds.source };
}

// ============ 1) 生成授权 URL ============
// state 存到 KV (5分钟过期),防 CSRF
export async function buildAuthURL(env: Env, userId: string, provider: 'gmail' | 'outlook'): Promise<string> {
  // Gmail 用 Device Code Flow 更稳(无需在 Google Cloud 控制台登记回调地址),
  // 这里保留 Authorization Code 通道作为备用:未配置凭据时直接给中文提示,不再跳 Google 的 401 页
  let clientId = '';
  if (provider === 'gmail') {
    const creds = await getGoogleCreds(env, userId);
    if (!creds) {
      throw new Error('尚未配置 Google OAuth 客户端凭据,请在「绑定 Gmail」弹窗内填写你的 Client ID / Client Secret');
    }
    clientId = creds.clientId;
  } else {
    clientId = msClientId(env);
  }

  const state = randomHex(16);
  const redirectUri = `${env.BASE_URL}/oauth/callback`;
  const stateData = JSON.stringify({ user_id: userId, provider, ts: Date.now() });
  await env.KV.put(`oauth:${state}`, stateData, { expirationTtl: 300 });

  // 公共参数
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: provider === 'gmail' ? GOOGLE_SCOPES : MS_SCOPES,
    state,
    prompt: 'consent',             // 强制重新同意,保证拿到 refresh_token
  });
  // access_type=offline 是 Google 专有参数,微软靠 offline_access scope 拿 refresh_token
  if (provider === 'gmail') params.set('access_type', 'offline');

  const base = provider === 'gmail' ? GOOGLE_AUTH_URL : MS_AUTH_URL;
  return `${base}?${params.toString()}`;
}

// ============ 2) 处理回调,拿 token + 邮箱 ============
export interface OAuthResult {
  provider: 'gmail' | 'outlook';
  email: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
}

export async function handleOAuthCallback(env: Env, code: string, state: string): Promise<OAuthResult> {
  // 1. 校验 state
  const stateRaw = await env.KV.get(`oauth:${state}`);
  if (!stateRaw) throw new Error('OAuth state 无效或已过期,请重新发起授权');
  await env.KV.delete(`oauth:${state}`);
  const stateData = JSON.parse(stateRaw) as { user_id: string; provider: 'gmail' | 'outlook'; ts: number };
  if (Date.now() - stateData.ts > 300_000) throw new Error('OAuth state 已过期');

  // 2. 换 access_token
  const redirectUri = `${env.BASE_URL}/oauth/callback`;
  const tokenResp = await (stateData.provider === 'gmail' ? exchangeGoogleCode : exchangeMicrosoftCode)(
    env, code, redirectUri
  );
  // refresh_token 必须存在(首次授权才返回,refresh 时会保留原值)
  if (!tokenResp.refresh_token) throw new Error('未返回 refresh_token (可能用户之前已授权,需撤销后重试)');

  // 3. 拿邮箱地址
  const email = stateData.provider === 'gmail'
    ? await getGoogleEmail(tokenResp.access_token)
    : await getMicrosoftEmail(tokenResp.access_token);

  // 4. 加密存储 (upsert: 同一用户同 provider 同 email 已存在则更新 token,避免重复绑定)
  const encAccess = await encrypt(tokenResp.access_token, env);
  const encRefresh = await encrypt(tokenResp.refresh_token, env);
  const expiresAt = new Date(Date.now() + (tokenResp.expires_in || 3600) * 1000).toISOString();

  const existing = await getMailAccountByUserAndEmail(env, stateData.user_id, stateData.provider, email);
  if (existing) {
    // 重新授权:仅更新 token,保留 id / is_public 等属性
    await updateMailAccountToken(env, existing.id, encAccess, encRefresh, expiresAt);
  } else {
    await addMailAccount(env, stateData.user_id, stateData.provider, email, encAccess, encRefresh, expiresAt, false);
  }

  return {
    provider: stateData.provider,
    email,
    accessToken: tokenResp.access_token,
    refreshToken: tokenResp.refresh_token,
    expiresAt,
  };
}

// ============ Google: 换 token ============
interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
}

async function exchangeGoogleCode(env: Env, code: string, redirectUri: string, creds?: GoogleCreds | null): Promise<TokenResponse> {
  const c = creds || await getGoogleCreds(env);
  if (!c) throw new Error('尚未配置 Google OAuth 客户端凭据');
  const body = new URLSearchParams({
    code,
    client_id: c.clientId,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  });
  if (c.clientSecret) body.set('client_secret', c.clientSecret);
  const resp = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await resp.json() as TokenResponse & { error?: string; error_description?: string };
  if (!resp.ok) {
    const e = data.error || '';
    if (e === 'invalid_client') {
      throw new Error('Google 返回 invalid_client: Client ID 无效或客户端类型不支持该授权方式。请在「绑定 Gmail」弹窗内核对并修改 Client ID / Client Secret 后重试');
    }
    throw new Error(`Google token error: ${data.error_description || data.error}`);
  }
  return data;
}

async function getGoogleEmail(accessToken: string): Promise<string> {
  const resp = await fetch(GOOGLE_USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = await resp.json() as { email?: string; error?: string };
  if (!data.email) throw new Error('获取 Gmail 邮箱失败');
  return data.email;
}

// ============ Microsoft: 换 token ============
// 公共客户端(无 client_secret):仅用 client_id + code 换 token
async function exchangeMicrosoftCode(env: Env, code: string, redirectUri: string): Promise<TokenResponse> {
  const params = new URLSearchParams({
    code,
    client_id: msClientId(env),
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
    scope: MS_SCOPES,
  });
  const resp = await fetch(MS_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
  });
  const data = await resp.json() as TokenResponse & { error?: string; error_description?: string };
  if (!resp.ok) throw new Error(`Microsoft token error: ${data.error_description || data.error}`);
  return data;
}

async function getMicrosoftEmail(accessToken: string): Promise<string> {
  const resp = await fetch(MS_USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = await resp.json() as { mail?: string; userPrincipalName?: string; error?: string };
  const email = data.mail || data.userPrincipalName;
  if (!email) throw new Error('获取 Microsoft 邮箱失败');
  return email;
}

// ============ Token 刷新 (在邮件查询前调用) ============
// 自动检测过期并刷新,返回解密后的可访问 token
export async function ensureValidToken(env: Env, accountId: string): Promise<{ token: string; provider: 'gmail' | 'outlook' | 'imap'; email: string }> {
  const account = await getMailAccountById(env, accountId);
  if (!account) throw new Error('邮箱账号不存在');

  const accessToken = await decrypt(account.access_token, env);
  const expiresAt = account.token_expires_at;

  // 提前 60 秒刷新
  if (!isExpired(new Date(Date.parse(expiresAt) - 60_000).toISOString())) {
    return { token: accessToken, provider: account.provider, email: account.email };
  }

  // 刷新 token
  const refreshToken = await decrypt(account.refresh_token, env);
  const refreshed = account.provider === 'gmail'
    ? await refreshGoogleToken(env, refreshToken, await getGoogleCreds(env, account.user_id))
    : await refreshMicrosoftToken(env, refreshToken);

  // 重新加密存储
  const encAccess = await encrypt(refreshed.access_token, env);
  const encRefresh = refreshed.refresh_token ? await encrypt(refreshed.refresh_token, env) : account.refresh_token;
  const newExpiresAt = new Date(Date.now() + (refreshed.expires_in || 3600) * 1000).toISOString();
  await updateMailAccountToken(env, accountId, encAccess, encRefresh, newExpiresAt);

  return { token: refreshed.access_token, provider: account.provider, email: account.email };
}

// Google 刷新
async function refreshGoogleToken(env: Env, refreshToken: string, creds?: GoogleCreds | null): Promise<TokenResponse> {
  const c = creds || await getGoogleCreds(env);
  if (!c) throw new Error('尚未配置 Google OAuth 客户端凭据');
  const body = new URLSearchParams({
    client_id: c.clientId,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  if (c.clientSecret) body.set('client_secret', c.clientSecret);
  const resp = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await resp.json() as TokenResponse & { error?: string };
  if (!resp.ok) throw new Error(`Google refresh error: ${data.error}`);
  return { ...data, refresh_token: data.refresh_token || refreshToken };
}

// Microsoft 刷新 (公共客户端,无 client_secret)
async function refreshMicrosoftToken(env: Env, refreshToken: string): Promise<TokenResponse> {
  const resp = await fetch(MS_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: msClientId(env),
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
      scope: MS_SCOPES,
    }),
  });
  const data = await resp.json() as TokenResponse & { error?: string; error_description?: string };
  if (!resp.ok) throw new Error(`Microsoft refresh error: ${data.error_description || data.error}`);
  return { ...data, refresh_token: data.refresh_token || refreshToken };
}

// ============ 授权状态探测 ============
// 用 access_token 调一次 Graph /me 或 Gmail userinfo,能成功说明 token 有效
// 失败则尝试刷新一次,刷新也失败说明需重新授权
export async function checkAccountAuthStatus(env: Env, accountId: string): Promise<{ ok: boolean; reason?: string }> {
  let account: MailAccountRaw | null;
  try {
    account = await getMailAccountById(env, accountId);
  } catch {
    return { ok: false, reason: '账号不存在' };
  }
  if (!account) return { ok: false, reason: '账号不存在' };

  // 直接用 access_token 试探(不触发自动刷新)
  const accessToken = await decrypt(account.access_token, env);
  const probeResp = account.provider === 'gmail'
    ? await fetch(GOOGLE_USERINFO_URL, { headers: { Authorization: `Bearer ${accessToken}` } })
    : await fetch(MS_USERINFO_URL, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (probeResp.ok) return { ok: true };

  // access_token 失效,尝试刷新一次
  try {
    const refreshToken = await decrypt(account.refresh_token, env);
    const refreshed = account.provider === 'gmail'
      ? await refreshGoogleToken(env, refreshToken, await getGoogleCreds(env, account.user_id))
      : await refreshMicrosoftToken(env, refreshToken);
    const encAccess = await encrypt(refreshed.access_token, env);
    const encRefresh = refreshed.refresh_token ? await encrypt(refreshed.refresh_token, env) : account.refresh_token;
    const newExpiresAt = new Date(Date.now() + (refreshed.expires_in || 3600) * 1000).toISOString();
    await updateMailAccountToken(env, accountId, encAccess, encRefresh, newExpiresAt);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: 'refresh_token 已失效,需重新授权' };
  }
}

// ============ Device Code Flow (微软,绕过 redirect_uri 限制) ============
// Thunderbird 公共客户端注册了固定的 redirect_uri,我们的 Worker 回调地址不匹配,
// 因此改用 Device Code Flow:用户在任意设备打开验证链接输入 user_code,无需回调。
// 会话存 KV,前端轮询 status 接口,每次轮询时 Worker 调一次 token 端点。

export interface DeviceSession {
  user_id: string;
  provider: 'outlook';
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_at: number;       // device_code 过期时间戳(ms)
  interval: number;         // 轮询间隔(秒)
}

// 发起 device code 授权,返回 user_code / 验证链接给前端展示
export async function startDeviceFlow(env: Env, userId: string): Promise<{ user_code: string; verification_uri: string; expires_in: number }> {
  const resp = await fetch(MS_DEVICECODE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: msClientId(env),
      scope: MS_SCOPES,
    }),
  });
  const data = await resp.json() as {
    device_code: string; user_code: string; verification_uri: string;
    expires_in: number; interval: number; error?: string; error_description?: string;
  };
  if (!resp.ok) throw new Error(`Device code 请求失败: ${data.error_description || data.error}`);

  // 存会话到 KV (15分钟过期)
  const session: DeviceSession = {
    user_id: userId,
    provider: 'outlook',
    device_code: data.device_code,
    user_code: data.user_code,
    verification_uri: data.verification_uri,
    expires_at: Date.now() + data.expires_in * 1000,
    interval: data.interval || 5,
  };
  await env.KV.put(`device:${userId}`, JSON.stringify(session), { expirationTtl: data.expires_in });
  return { user_code: data.user_code, verification_uri: data.verification_uri, expires_in: data.expires_in };
}

// 轮询 device code 授权状态: 用 device_code 调 token 端点
// 返回 status: success(已授权) / pending(等待用户操作) / failed(失败)
export async function pollDeviceFlow(env: Env, userId: string): Promise<{ status: 'success' | 'pending' | 'failed'; reason?: string; email?: string }> {
  const raw = await env.KV.get(`device:${userId}`);
  if (!raw) return { status: 'failed', reason: '授权会话不存在或已过期,请重新发起' };
  const session = JSON.parse(raw) as DeviceSession;
  if (Date.now() > session.expires_at) {
    await env.KV.delete(`device:${userId}`);
    return { status: 'failed', reason: '授权已超时,请重新发起' };
  }

  // 调 token 端点轮询
  const resp = await fetch(MS_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: msClientId(env),
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: session.device_code,
    }),
  });
  const data = await resp.json() as TokenResponse & { error?: string; error_description?: string; interval?: number };

  if (resp.ok && data.access_token) {
    // 授权成功:拿邮箱 + upsert 存储 token
    await env.KV.delete(`device:${userId}`);
    const email = await getMicrosoftEmail(data.access_token);
    if (!data.refresh_token) throw new Error('未返回 refresh_token');
    const encAccess = await encrypt(data.access_token, env);
    const encRefresh = await encrypt(data.refresh_token, env);
    const expiresAt = new Date(Date.now() + (data.expires_in || 3600) * 1000).toISOString();
    const existing = await getMailAccountByUserAndEmail(env, userId, 'outlook', email);
    if (existing) {
      await updateMailAccountToken(env, existing.id, encAccess, encRefresh, expiresAt);
    } else {
      await addMailAccount(env, userId, 'outlook', email, encAccess, encRefresh, expiresAt, false);
    }
    return { status: 'success', email };
  }

  // 处理错误码: pending 是正常的,declined/expired 是终止
  const err = data.error;
  if (err === 'authorization_pending' || err === 'slow_down') {
    return { status: 'pending' };
  }
  if (err === 'authorization_declined') {
    await env.KV.delete(`device:${userId}`);
    return { status: 'failed', reason: '用户拒绝了授权' };
  }
  if (err === 'expired_token') {
    await env.KV.delete(`device:${userId}`);
    return { status: 'failed', reason: 'device code 已过期,请重新发起' };
  }
  return { status: 'failed', reason: data.error_description || err || '未知错误' };
}

// ============ Google Device Code Flow ============
// 与微软 Device Code 类似:用户在 https://google.com/device 输入 user_code 完成授权。
// 优点:不需要在 Google Cloud 控制台配置任何回调地址,Worker 部署在哪个域名都能用,
// 也不会出现 redirect_uri_mismatch / invalid_client(未配置) 之类的跳转报错。
export interface GoogleDeviceSession {
  user_id: string;
  device_code: string;
  user_code: string;
  verification_url: string;
  expires_at: number;
  interval: number;
  client_id: string;          // 本次会话绑定的凭据(用户在弹窗内填写的,不再依赖全局配置)
  client_secret: string;
}

export interface DeviceStartResult {
  user_code: string;
  verification_url: string;
  verification_url_complete?: string;
  expires_in: number;
}

export async function startGoogleDeviceFlow(
  env: Env, userId: string, explicitCreds?: { clientId: string; clientSecret: string } | null
): Promise<DeviceStartResult> {
  // 优先用用户本次在弹窗内填写的凭据;否则回退到(用户级 → 环境变量 → 全局)配置
  const creds = explicitCreds && explicitCreds.clientId
    ? { clientId: explicitCreds.clientId, clientSecret: explicitCreds.clientSecret || '', source: 'user' as const }
    : await getGoogleCreds(env, userId);
  if (!creds) {
    throw new Error('尚未填写 Google OAuth 客户端凭据,请在「绑定 Gmail」弹窗内填写你的 Client ID / Client Secret');
  }
  const body = new URLSearchParams({
    client_id: creds.clientId,
    scope: GOOGLE_SCOPES,
  });
  const resp = await fetch(GOOGLE_DEVICE_CODE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await resp.json() as {
    device_code?: string; user_code?: string; verification_url?: string;
    verification_url_complete?: string; expires_in?: number; interval?: number;
    error?: string; error_description?: string;
  };
  if (!resp.ok || !data.device_code || !data.user_code) {
    const e = data.error || '';
    if (e === 'invalid_client') {
      throw new Error('Google 返回 invalid_client: Client ID 无效或客户端类型不支持设备授权。请在「绑定 Gmail」弹窗内核对并修改 Client ID / Client Secret 后重试');
    }
    throw new Error(`Google 设备码申请失败: ${data.error_description || data.error || resp.status}`);
  }

  const session: GoogleDeviceSession = {
    user_id: userId,
    device_code: data.device_code,
    user_code: data.user_code,
    verification_url: data.verification_url || GOOGLE_DEVICE_VERIFY_URL,
    expires_at: Date.now() + (data.expires_in || 1800) * 1000,
    interval: data.interval || 5,
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
  };
  await env.KV.put(`gdevice:${userId}`, JSON.stringify(session), {
    expirationTtl: Math.max(60, data.expires_in || 1800),
  });
  return {
    user_code: data.user_code,
    verification_url: session.verification_url,
    verification_url_complete: data.verification_url_complete,
    expires_in: data.expires_in || 1800,
  };
}

// 把 Google 换到的 token 落库(新绑定则新增,重复授权则更新 token)
async function persistGoogleAccount(env: Env, userId: string, tokenResp: TokenResponse): Promise<string> {
  const email = await getGoogleEmail(tokenResp.access_token);
  const encAccess = await encrypt(tokenResp.access_token, env);
  const encRefresh = tokenResp.refresh_token ? await encrypt(tokenResp.refresh_token, env) : '';
  const expiresAt = new Date(Date.now() + (tokenResp.expires_in || 3600) * 1000).toISOString();

  const existing = await getMailAccountByUserAndEmail(env, userId, 'gmail', email);
  if (existing) {
    await updateMailAccountToken(
      env, existing.id, encAccess, encRefresh || existing.refresh_token, expiresAt
    );
  } else {
    await addMailAccount(env, userId, 'gmail', email, encAccess, encRefresh, expiresAt, false);
  }
  return email;
}

// 轮询 Google 设备码授权状态,前端每 4~5 秒调用一次
export async function pollGoogleDeviceFlow(
  env: Env, userId: string
): Promise<{ status: 'success' | 'pending' | 'failed'; reason?: string; email?: string }> {
  const raw = await env.KV.get(`gdevice:${userId}`);
  if (!raw) return { status: 'failed', reason: '授权会话不存在或已过期,请重新发起' };
  const session = JSON.parse(raw) as GoogleDeviceSession;
  if (Date.now() > session.expires_at) {
    await env.KV.delete(`gdevice:${userId}`);
    return { status: 'failed', reason: '设备码已过期,请重新发起' };
  }

  // 直接使用本次会话绑定的凭据(用户在弹窗内填写的),与全局配置解耦
  const creds = { clientId: session.client_id, clientSecret: session.client_secret || '' };

  const body = new URLSearchParams({
    client_id: creds.clientId,
    device_code: session.device_code,
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
  });
  if (creds.clientSecret) body.set('client_secret', creds.clientSecret);

  const resp = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await resp.json() as TokenResponse & { error?: string; error_description?: string };

  if (resp.ok && data.access_token) {
    try {
      const email = await persistGoogleAccount(env, userId, {
        ...data,
        refresh_token: data.refresh_token || '',
      });
      await env.KV.delete(`gdevice:${userId}`);
      return { status: 'success', email };
    } catch (e) {
      await env.KV.delete(`gdevice:${userId}`);
      return { status: 'failed', reason: (e as Error).message };
    }
  }

  const err = data.error;
  if (err === 'authorization_pending' || err === 'slow_down') return { status: 'pending' };
  if (err === 'access_denied' || err === 'declined') {
    await env.KV.delete(`gdevice:${userId}`);
    return { status: 'failed', reason: '用户拒绝了授权' };
  }
  if (err === 'expired_token') {
    await env.KV.delete(`gdevice:${userId}`);
    return { status: 'failed', reason: '设备码已过期,请重新发起' };
  }
  if (err === 'invalid_client') {
    await env.KV.delete(`gdevice:${userId}`);
    return { status: 'failed', reason: 'Google 返回 invalid_client: Client ID 无效或客户端类型不支持设备授权。请在「绑定 Gmail」弹窗内核对并修改 Client ID / Client Secret 后重试' };
  }
  if (err === 'invalid_grant') return { status: 'pending' };   // 用户尚未完成输入时也会短暂出现
  return { status: 'failed', reason: data.error_description || err || '未知错误' };
}
