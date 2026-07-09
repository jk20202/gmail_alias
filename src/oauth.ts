// OAuth 流程: Google (Gmail) + Microsoft (Outlook/Hotmail/Live)
// 两者都使用 Authorization Code Flow + refresh_token
import type { Env, MailAccountRaw } from './types';
import { randomHex, encrypt, decrypt, isExpired, nowISO } from './utils';
import { addMailAccount, updateMailAccountToken, getMailAccountById, getMailAccountByUserAndEmail } from './db';

// ============ 公共配置 ============
// Gmail OAuth 端点
const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';
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

// ============ 1) 生成授权 URL ============
// state 存到 KV (5分钟过期),防 CSRF
export async function buildAuthURL(env: Env, userId: string, provider: 'gmail' | 'outlook'): Promise<string> {
  const state = randomHex(16);
  const redirectUri = `${env.BASE_URL}/oauth/callback`;
  const stateData = JSON.stringify({ user_id: userId, provider, ts: Date.now() });
  await env.KV.put(`oauth:${state}`, stateData, { expirationTtl: 300 });

  // 公共参数
  const params = new URLSearchParams({
    client_id: provider === 'gmail' ? env.GOOGLE_CLIENT_ID : msClientId(env),
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

async function exchangeGoogleCode(env: Env, code: string, redirectUri: string): Promise<TokenResponse> {
  const resp = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  const data = await resp.json() as TokenResponse & { error?: string; error_description?: string };
  if (!resp.ok) throw new Error(`Google token error: ${data.error_description || data.error}`);
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
export async function ensureValidToken(env: Env, accountId: string): Promise<{ token: string; provider: 'gmail' | 'outlook'; email: string }> {
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
    ? await refreshGoogleToken(env, refreshToken)
    : await refreshMicrosoftToken(env, refreshToken);

  // 重新加密存储
  const encAccess = await encrypt(refreshed.access_token, env);
  const encRefresh = refreshed.refresh_token ? await encrypt(refreshed.refresh_token, env) : account.refresh_token;
  const newExpiresAt = new Date(Date.now() + (refreshed.expires_in || 3600) * 1000).toISOString();
  await updateMailAccountToken(env, accountId, encAccess, encRefresh, newExpiresAt);

  return { token: refreshed.access_token, provider: account.provider, email: account.email };
}

// Google 刷新
async function refreshGoogleToken(env: Env, refreshToken: string): Promise<TokenResponse> {
  const resp = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
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
      ? await refreshGoogleToken(env, refreshToken)
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
