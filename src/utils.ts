import type { Env } from './types';

// 上海时区(Workers 用 UTC 存储,显示时转)
export const SHANGHAI_TZ = 'Asia/Shanghai';

// ============ 统一响应 ============
export function ok<T>(data: T, msg = 'success'): Response {
  return json({ code: 0, msg, data });
}

export function fail(msg: string, status = 400, code = 1): Response {
  return json({ code, msg, data: null }, status);
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

// ============ 加密/哈希 (Web Crypto API) ============
// SHA256 哈希(用户密码)
export async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// 生成随机 hex 字符串
export function randomHex(bytes: number): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return [...arr].map(b => b.toString(16).padStart(2, '0')).join('');
}

// 生成随机 URL-safe token
export function randomToken(bytes = 32): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return base64url(arr);
}

// base64url 编码
export function base64url(input: ArrayBuffer | Uint8Array): string {
  const arr = input instanceof Uint8Array ? input : new Uint8Array(input);
  let s = '';
  for (const b of arr) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// base64url 解码
export function fromBase64url(s: string): ArrayBuffer {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + pad;
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr.buffer;
}

// ============ AES-GCM 加密 (加密 refresh_token) ============
// 派生密钥: ENCRYPT_KEY (hex) -> CryptoKey
async function deriveKey(env: Env): Promise<CryptoKey> {
  const raw = fromBase64url(env.ENCRYPT_KEY || randomHex(32));
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

// 加密明文 -> base64(iv + cipher)
export async function encrypt(plain: string, env: Env): Promise<string> {
  const key = await deriveKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(plain)
  );
  // 拼接 iv + cipher
  const combined = new Uint8Array(iv.length + cipher.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(cipher), iv.length);
  return base64url(combined.buffer);
}

// 解密
export async function decrypt(payload: string, env: Env): Promise<string> {
  const key = await deriveKey(env);
  const buf = new Uint8Array(fromBase64url(payload));
  const iv = buf.slice(0, 12);
  const cipher = buf.slice(12);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipher);
  return new TextDecoder().decode(plain);
}

// HMAC-SHA256 签名 (Webhook)
export async function hmacSha256(key: string, message: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(message));
  return base64url(sig);
}

// ============ 时间处理 ============
// 当前 ISO 时间 (UTC)
export function nowISO(): string {
  return new Date().toISOString();
}

// 检查是否过期
export function isExpired(iso: string): boolean {
  return new Date(iso).getTime() < Date.now();
}

// 上海时间显示格式
export function formatShanghaiTime(iso: string): string {
  if (!iso) return '';
  try {
    const dt = new Date(iso);
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: SHANGHAI_TZ,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    }).format(dt).replace(/\//g, '-');
  } catch {
    return iso;
  }
}

// 解析多种格式时间,默认 fallback
export function parseTime(timeStr: string | undefined, fallback: Date): Date {
  if (!timeStr) return fallback;
  const trimmed = timeStr.trim().replace(' ', 'T');
  const dt = new Date(trimmed);
  if (!isNaN(dt.getTime())) return dt;
  return fallback;
}

// ============ 字符串工具 ============
export function maskToken(token: string): string {
  if (!token || token.length < 8) return '****';
  return token.slice(0, 4) + '****' + token.slice(-4);
}

// 邮箱拆分: user+label@gmail.com -> { prefix: user, label, domain: gmail.com }
export function splitEmail(email: string): { prefix: string; label: string | null; domain: string } {
  const [local, domain] = email.split('@');
  if (!domain) return { prefix: '', label: null, domain: '' };
  const [prefix, label] = local.split('+', 2);
  return { prefix, label: label || null, domain };
}

// 构建别名全地址
export function buildAliasFull(email: string, label: string): string {
  const { prefix, domain } = splitEmail(email);
  if (!prefix || !domain) return '';
  return `${prefix}+${label}@${domain}`;
}

// HTML 转纯文本
export function htmlToText(html: string): string {
  if (!html) return '';
  return html
    .replace(/<style[^>]*>.*?<\/style>/gis, '')
    .replace(/<script[^>]*>.*?<\/script>/gis, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// 生成 5-10 位随机标签
export function randomLabel(): string {
  const len = 5 + Math.floor(Math.random() * 6);
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let label = '';
  const arr = new Uint32Array(len);
  crypto.getRandomValues(arr);
  for (let i = 0; i < len; i++) label += chars[arr[i] % chars.length];
  return label;
}

// 简单 JWT 生成 (header.payload.signature)
export async function signJWT(payload: object, secret: string): Promise<string> {
  const header = base64url(new TextEncoder().encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const body = base64url(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = await hmacSha256(secret, `${header}.${body}`);
  return `${header}.${body}.${sig}`;
}
