// OAuth 流程: Google (Gmail) + Microsoft (Outlook/Hotmail/Live)
// 两者都使用 Authorization Code Flow + refresh_token
import type { Env } from './types';
import { randomHex, encrypt, decrypt, isExpired, nowISO } from './utils';
import { addMailAccount, updateMailAccountToken, getMailAccountById } from './db';

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

// Microsoft OAuth 端点 (common 支持个人+组织账户)
const MS_AUTH_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize';
const MS_TOKEN_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
const MS_USERINFO_URL = 'https://graph.microsoft.com/v1.0/me';
// Mail.Read 读邮件 + offline_access 拿 refresh_token
const MS_SCOPES = ['Mail.Read', 'offline_access'].join(' ');

// ============ 1) 生成授权 URL ============
// state 存到 KV (5分钟过期),防 CSRF
export async function buildAuthURL(env: Env, userId: string, provider: 'gmail' | 'outlook'): Promise<string> {
  const state = randomHex(16);
  const redirectUri = `${env.BASE_URL}/oauth/callback`;
  const stateData = JSON.stringify({ user_id: userId, provider, ts: Date.now() });
  await env.KV.put(`oauth:${state}`, stateData, { expirationTtl: 300 });

  const params = new URLSearchParams({
    client_id: provider === 'gmail' ? env.GOOGLE_CLIENT_ID : env.MS_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: provider === 'gmail' ? GOOGLE_SCOPES : MS_SCOPES,
    state,
    access_type: 'offline',         // 要求返回 refresh_token
    prompt: 'consent',             // 强制重新同意,保证拿到 refresh_token
  });

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

  // 4. 加密存储
  const encAccess = await encrypt(tokenResp.access_token, env);
  const encRefresh = await encrypt(tokenResp.refresh_token, env);
  const expiresAt = new Date(Date.now() + (tokenResp.expires_in || 3600) * 1000).toISOString();

  await addMailAccount(env, stateData.user_id, stateData.provider, email, encAccess, encRefresh, expiresAt, false);

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
async function exchangeMicrosoftCode(env: Env, code: string, redirectUri: string): Promise<TokenResponse> {
  const params = new URLSearchParams({
    code,
    client_id: env.MS_CLIENT_ID,
    client_secret: env.MS_CLIENT_SECRET,
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

// Microsoft 刷新
async function refreshMicrosoftToken(env: Env, refreshToken: string): Promise<TokenResponse> {
  const resp = await fetch(MS_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.MS_CLIENT_ID,
      client_secret: env.MS_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
      scope: MS_SCOPES,
    }),
  });
  const data = await resp.json() as TokenResponse & { error?: string };
  if (!resp.ok) throw new Error(`Microsoft refresh error: ${data.error}`);
  return { ...data, refresh_token: data.refresh_token || refreshToken };
}
