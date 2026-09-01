// Webhook 推送服务
// 提供两种触发模式:
//   1) 主动轮询:由 Cron / 外部定时器调用 /api/webhook/poll?account_id=xxx&key=xxx 触发
//   2) 被动接收:第三方(Gmail Pub/Sub / Outlook Subscription) POST 到 /api/webhook/receive
// 推送时携带 HMAC-SHA256 签名头 X-Webhook-Signature,接收方务必校验(仅通用 JSON 格式)
//
// 推送格式(format):
//   card     卡片消息(飞书 interactive / 钉钉 actionCard),完整正文,单封一封卡片
//   markdown Markdown 富文本(飞书卡片 Markdown 版 / 钉钉 markdown)
//   text     纯文本(含完整正文)
//   json     原始 JSON 载荷(含完整 body / html / 附件列表 / 签名头)
import type { Env, Email, Webhook } from './types';
import { hmacSha256, nowISO, htmlToText } from './utils';
import { getWebhooksForAccount, logWebhookDelivery, getMailAccountById, listActiveAliasesForAccount } from './db';
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

// 单封邮件最多推送的正文字数(超出部分会明确标注,不再悄悄截断)
const MAX_BODY_CHARS = 20000;
// 一次轮询最多推送的邮件数(每封一条消息,避免刷屏与超时)
const MAX_PUSH_EMAILS = 10;

// ============ 主动轮询模式 ============
// 拉取最近邮件,逐条匹配订阅,推送给订阅者
// 使用 KV 去重:已推送过的 message_id 1小时TTL,避免重复推送
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

  for (const wh of webhooks) {
    // 过滤事件
    const events = wh.events.split(',').map(s => s.trim());
    if (!events.includes('new_mail') && !events.includes('unread')) continue;

    // 按 scope 实际行为过滤:
    //   alias_all → 仅推送收件人是该邮箱下"当前存活别名"中之一的邮件
    //   account  → 仅推送收件人就是该主邮箱本身的邮件(直发到主邮箱、不经过别名)
    // alias(指定别名)scope 已废弃,新建订阅不再支持
    const scope = wh.scope || 'alias_all';
    const toLower = (s: string) => (s || '').toLowerCase();
    let filtered: Email[];
    if (scope === 'account') {
      const accountEmail = toLower(account.email);
      filtered = emails.filter(e => toLower(e.to) === accountEmail);
    } else {
      // alias_all
      const aliases = await listActiveAliasesForAccount(env, accountId);
      if (aliases.length === 0) {
        // 没有存活别名 = 没有可匹配的别名邮件,跳过
        continue;
      }
      const aliasSet = new Set(aliases);
      filtered = emails.filter(e => aliasSet.has(toLower(e.to)));
    }

    if (filtered.length === 0) continue;

    // KV 去重:只推送未推送过的邮件
    const newEmails: Email[] = [];
    for (const e of filtered) {
      const dedupKey = `wh:pushed:${accountId}:${e.id}`;
      const already = await env.KV.get(dedupKey);
      if (!already) {
        newEmails.push(e);
        // 标记已推送,TTL 1小时
        await env.KV.put(dedupKey, '1', { expirationTtl: 3600 });
      }
    }

    if (newEmails.length === 0) continue;

    // 聚合推送一次
    const payload: WebhookPayload = {
      event: 'new_mail',
      delivered_at: nowISO(),
      mail_account_id: accountId,
      email: account.email,
      // 命中目标说明: account = 主邮箱本身;alias_all = 其中一个存活别名
      to_alias: scope === 'account' ? account.email : (filtered[0]?.to || undefined),
      count: newEmails.length,
      emails: newEmails,
    };

    const ok = await deliver(env, wh, payload);
    if (ok) pushed++;
    else errors.push(`推送 ${wh.url} 失败`);
  }
  return { pushed, errors };
}

// ============ 发起一次推送 ============
// 识别飞书/钉钉等平台 URL,按订阅选择的格式自动转换为对应消息体。
// 内容尽量完整:每封邮件一条消息,正文不再截断到 150 字。
export async function deliver(env: Env, webhook: Webhook, payload: WebhookPayload): Promise<boolean> {
  const platform = detectPlatform(webhook.url);
  const format = normalizeFormat(webhook.format);
  const messages = buildMessages(platform, format, payload);

  let allOk = messages.length > 0;
  for (let i = 0; i < messages.length; i++) {
    const { body, contentType } = messages[i];
    const headers: Record<string, string> = {
      'Content-Type': contentType,
      'User-Agent': 'MailAlias-Webhook/1.0',
    };
    // 签名: HMAC-SHA256(body) base64url (平台自有签名机制时不附加)
    if (webhook.secret && (platform === 'generic' || format === 'json')) {
      headers['X-Webhook-Signature'] = await hmacSha256(webhook.secret, body);
    }
    // 多条消息时轻微串行,降低被平台限流概率
    if (i > 0) await sleep(300);

    const ok = await sendOnce(env, webhook, body, headers);
    if (!ok) allOk = false;
  }
  return allOk;
}

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function sendOnce(
  env: Env, webhook: Webhook, body: string, headers: Record<string, string>
): Promise<boolean> {
  // 10 秒超时 (第三方平台可能稍慢)
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
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

function normalizeFormat(f?: string | null): 'card' | 'markdown' | 'text' | 'json' {
  const v = (f || 'card').toLowerCase();
  if (v === 'markdown' || v === 'text' || v === 'json') return v;
  return 'card';
}

// 识别推送平台类型 (根据 URL 域名)
function detectPlatform(url: string): 'feishu' | 'dingtalk' | 'generic' {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host === 'open.feishu.cn' || host.endsWith('.feishu.cn') || host.endsWith('.larksuite.com')) return 'feishu';
    if (host === 'oapi.dingtalk.com') return 'dingtalk';
    return 'generic';
  } catch { return 'generic'; }
}

// ============ 消息体构建 ============
interface OutMessage { body: string; contentType: string; }

function buildMessages(
  platform: 'feishu' | 'dingtalk' | 'generic',
  format: 'card' | 'markdown' | 'text' | 'json',
  p: WebhookPayload
): OutMessage[] {
  // 通用格式:无论什么平台都推原始 JSON(包含完整正文与 HTML)
  if (format === 'json' || platform === 'generic') {
    return [{ body: JSON.stringify(p), contentType: 'application/json' }];
  }
  if (platform === 'feishu') return buildFeishuMessages(format, p);
  return buildDingtalkMessages(format, p);
}

// 取邮件正文(优先纯文本,缺失时从 HTML 转文本)
function bodyOf(m: Email): string {
  let text = (m.body || '').trim();
  if (!text && m.html) text = htmlToText(m.html).trim();
  if (!text) return '(无正文)';
  if (text.length > MAX_BODY_CHARS) {
    return text.slice(0, MAX_BODY_CHARS) + `\n\n… (正文过长已截断,共 ${text.length} 字,完整内容请登录系统查看)`;
  }
  return text;
}

function subjectOf(m: Email): string {
  return (m.subject || '(无主题)').trim();
}

function attachmentLine(m: Email): string {
  const atts = (m.attachments || []).filter(Boolean);
  return atts.length ? atts.join('、') : '无';
}

// ============ 飞书 ============
function buildFeishuMessages(format: 'card' | 'markdown' | 'text', p: WebhookPayload): OutMessage[] {
  if (format === 'text') {
    return [{ body: JSON.stringify({ msg_type: 'text', content: { text: buildPlainText(p) } }), contentType: 'application/json' }];
  }
  // 无邮件(测试/汇总)时也发一张卡片
  if (!p.emails || p.emails.length === 0) {
    return [feishuCard('🔧 测试推送', 'blue', [
      { tag: 'div', text: { tag: 'lstr', content: `Webhook 配置正常,已收到测试事件。\n**主邮箱**: ${p.email || '(未指定)'}\n**时间**: ${p.delivered_at}` } },
    ])];
  }
  const list = p.emails.slice(0, MAX_PUSH_EMAILS);
  const msgs: OutMessage[] = list.map(m => {
    const content = [
      `**发件人**: ${m.from || '-'}`,
      `**收件人**: ${m.to || '-'}`,
      `**时间**: ${m.date || '-'}`,
      `**附件**: ${attachmentLine(m)}`,
      '',
      '---',
      '',
      bodyOf(m),
    ].join('\n');

    if (format === 'markdown') {
      // Markdown 版:单块 Markdown 的简洁卡片
      return feishuCard(subjectOf(m), 'turquoise', [
        { tag: 'div', text: { tag: 'lstr', content } },
      ]);
    }
    // 完整卡片:标题 + 结构化字段 + 正文
    return feishuCard(subjectOf(m), 'blue', [
      {
        tag: 'div',
        fields: [
          { is_short: true, text: { tag: 'lstr', content: `**发件人**\n${m.from || '-'}` } },
          { is_short: true, text: { tag: 'lstr', content: `**收件时间**\n${m.date || '-'}` } },
          { is_short: true, text: { tag: 'lstr', content: `**收件人(别名)**\n${m.to || '-'}` } },
          { is_short: true, text: { tag: 'lstr', content: `**附件**\n${attachmentLine(m)}` } },
        ],
      },
      { tag: 'hr' },
      { tag: 'div', text: { tag: 'lstr', content: bodyOf(m) } },
      { tag: 'note', elements: [{ tag: 'plain_text', content: `主邮箱 ${p.email || '-'}${p.to_alias ? ' · 别名 ' + p.to_alias : ''}` }] },
    ]);
  });
  // 超出单轮上限时补一条汇总
  if (p.emails.length > MAX_PUSH_EMAILS) {
    msgs.push({
      body: JSON.stringify({
        msg_type: 'text',
        content: { text: `本次共 ${p.emails.length} 封新邮件,已推送前 ${MAX_PUSH_EMAILS} 封,其余请登录系统查看。` },
      }),
      contentType: 'application/json',
    });
  }
  return msgs;
}

function feishuCard(title: string, template: string, elements: unknown[]): OutMessage {
  return {
    body: JSON.stringify({
      msg_type: 'interactive',
      card: {
        config: { wide_screen_mode: true, enable_forward: true },
        header: {
          title: { tag: 'plain_text', content: clip(title, 100) },
          template,
        },
        elements,
      },
    }),
    contentType: 'application/json',
  };
}

// ============ 钉钉 ============
function buildDingtalkMessages(format: 'card' | 'markdown' | 'text', p: WebhookPayload): OutMessage[] {
  if (format === 'text') {
    return [{ body: JSON.stringify({ msgtype: 'text', text: { content: buildPlainText(p) } }), contentType: 'application/json' }];
  }
  if (!p.emails || p.emails.length === 0) {
    return [{
      body: JSON.stringify({
        msgtype: 'markdown',
        markdown: { title: '测试推送', text: `### 🔧 测试推送\n\nWebhook 配置正常,已收到测试事件。\n\n主邮箱:${p.email || '(未指定)'}` },
      }),
      contentType: 'application/json',
    }];
  }
  const list = p.emails.slice(0, MAX_PUSH_EMAILS);
  const msgs: OutMessage[] = list.map(m => {
    const text = [
      `### ${subjectOf(m)}`,
      '',
      `- **发件人**: ${m.from || '-'}`,
      `- **收件人**: ${m.to || '-'}`,
      `- **时间**: ${m.date || '-'}`,
      `- **附件**: ${attachmentLine(m)}`,
      '',
      bodyOf(m),
    ].join('\n');
    if (format === 'card') {
      return {
        body: JSON.stringify({
          msgtype: 'actionCard',
          actionCard: {
            title: clip(subjectOf(m), 60),
            text: text,
            hideAvatar: '0',
            btnOrientation: '0',
            btns: [{ title: '登录系统查看', actionURL: 'https://jin520.eu.org/' }],
          },
        }),
        contentType: 'application/json',
      };
    }
    return {
      body: JSON.stringify({ msgtype: 'markdown', markdown: { title: clip(subjectOf(m), 60), text } }),
      contentType: 'application/json',
    };
  });
  if (p.emails.length > MAX_PUSH_EMAILS) {
    msgs.push({
      body: JSON.stringify({
        msgtype: 'text',
        text: { content: `本次共 ${p.emails.length} 封新邮件,已推送前 ${MAX_PUSH_EMAILS} 封,其余请登录系统查看。` },
      }),
      contentType: 'application/json',
    });
  }
  return msgs;
}

// 纯文本汇总(供 text 格式使用,同样保留完整正文)
function buildPlainText(p: WebhookPayload): string {
  const lines: string[] = [];
  lines.push(p.event === 'test' ? '🔧 测试推送' : `📬 新邮件通知 (${p.count} 封)`);
  lines.push(`主邮箱: ${p.email || '(未指定)'}`);
  if (p.to_alias) lines.push(`别名: ${p.to_alias}`);
  if (!p.emails || p.emails.length === 0) {
    lines.push('Webhook 配置正常,已收到测试事件。');
    return lines.join('\n');
  }
  for (const m of p.emails.slice(0, MAX_PUSH_EMAILS)) {
    lines.push('────────────────');
    lines.push(`【${subjectOf(m)}】`);
    lines.push(`发件人: ${m.from || '-'}`);
    lines.push(`收件人: ${m.to || '-'}`);
    lines.push(`时间: ${m.date || '-'}`);
    lines.push(`附件: ${attachmentLine(m)}`);
    lines.push(bodyOf(m));
  }
  if (p.emails.length > MAX_PUSH_EMAILS) {
    lines.push(`… 还有 ${p.emails.length - MAX_PUSH_EMAILS} 封,请登录系统查看`);
  }
  return lines.join('\n');
}

function clip(s: string, n: number): string {
  const t = (s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : (t || '(无主题)');
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
