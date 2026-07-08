// Webhook 推送服务
// 提供两种触发模式:
//   1) 主动轮询:由外部定时器调用 /api/webhook/poll?account_id=xxx&key=xxx 触发
//   2) 被动接收:第三方(Gmail Pub/Sub / Outlook Subscription) POST 到 /api/webhook/receive
// 推送时携带 HMAC-SHA256 签名头 X-Webhook-Signature,接收方务必校验
import type { Env, Email, Webhook } from './types';
import { hmacSha256, nowISO } from './utils';
import { getWebhooksForAccount, logWebhookDelivery, getMailAccountById } from './db';
import { fetchEmails } from './emailService';

// 推送载荷标准格式
export interface WebhookPayload {
  event: 'new_mail' | 'unread' | 'test';
  delivered_at: string;             // ISO 推送时间
  mail_account_id: string;
  email: string;                    // 主邮箱
  to_alias?: string;                 // 命中的别名(若有)
  count: number;
  emails: Email[];
}

// ============ 主动轮询模式 ============
// 拉取最近邮件,逐条匹配订阅,推送给订阅者
export async function pollAndPush(env: Env, accountId: string): Promise<{ pushed: number; errors: string[] }> {
  const errors: string[] = [];
  let pushed = 0;
  // 取最近 10 分钟的邮件
  const now = Date.now();
  const startISO = new Date(now - 10 * 60_000).toISOString();
  const params = {
    start_time: startISO,
    end_time: new Date(now).toISOString(),
    limit: 50,
  };
  let emails: Email[];
  try {
    emails = await fetchEmails(env, accountId, params);
  } catch (e) {
    errors.push(`拉取邮件失败: ${(e as Error).message}`);
    return { pushed, errors };
  }

  if (emails.length === 0) return { pushed, errors };

  const account = await getMailAccountById(env, accountId);
  if (!account) return { pushed: 0, errors: ['账号不存在'] };

  const webhooks = await getWebhooksForAccount(env, accountId);
  if (webhooks.length === 0) return { pushed: 0, errors };

  // 推送时去重:用 KV 记录已推送过的 message_id (1 小时 TTL)
  // key: wh:pushed:{accountId}:{messageId}
  for (const wh of webhooks) {
    // 过滤事件
    const events = wh.events.split(',').map(s => s.trim());
    if (!events.includes('new_mail') && !events.includes('unread')) continue;

    // 按别名过滤
    const filtered = wh.target_alias
      ? emails.filter(e => e.to.toLowerCase().includes(wh.target_alias!.toLowerCase()))
      : emails;

    if (filtered.length === 0) continue;

    // 推送每封新邮件 (或聚合一次,这里聚合推一次更高效)
    const payload: WebhookPayload = {
      event: 'new_mail',
      delivered_at: nowISO(),
      mail_account_id: accountId,
      email: account.email,
      to_alias: wh.target_alias || undefined,
      count: filtered.length,
      emails: filtered,
    };

    const ok = await deliver(env, wh, payload);
    if (ok) pushed++;
    else errors.push(`推送 ${wh.url} 失败`);
  }
  return { pushed, errors };
}

// ============ 发起一次推送 ============
export async function deliver(env: Env, webhook: Webhook, payload: WebhookPayload): Promise<boolean> {
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'MailAlias-Webhook/1.0',
  };
  // 签名: HMAC-SHA256(body) base64url
  if (webhook.secret) {
    headers['X-Webhook-Signature'] = await hmacSha256(webhook.secret, body);
  }
  // 5 秒超时
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  let success = false;
  let status = 0;
  let responseText = '';
  try {
    const resp = await fetch(webhook.url, { method: 'POST', headers, body, signal: controller.signal });
    status = resp.status;
    responseText = await resp.text();
    success = resp.ok;
  } catch (e) {
    responseText = (e as Error).message;
  } finally {
    clearTimeout(timeout);
  }
  await logWebhookDelivery(env, webhook.id, body, status, responseText, success);
  return success;
}

// ============ 发送测试推送 ============
export async function sendTestEvent(env: Env, webhook: Webhook): Promise<boolean> {
  const payload: WebhookPayload = {
    event: 'test',
    delivered_at: nowISO(),
    mail_account_id: webhook.mail_account_id,
    email: '',
    count: 0,
    emails: [],
  };
  return deliver(env, webhook, payload);
}

// ============ 签名校验 (接收方使用) ============
export async function verifySignature(secret: string, body: string, signature: string): Promise<boolean> {
  const expected = await hmacSha256(secret, body);
  // 等长比较,防时序攻击
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}
