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

    // 一订阅多邮箱: 只处理当前 accountId 对应的 target。其余邮箱的 target 等其他轮询时再处理。
    const myTargets = (wh.targets || []).filter(t => t.mail_account_id === accountId);
    if (!myTargets.length) continue;

    // 按 target 的 scope 决定过滤逻辑(可能同一邮箱的多个 target scope 不同,取并集)
    //   alias_all (用户语义: 整个邮箱)
    //     → 推送该主邮箱下所有收信: 主邮箱直接收 + 任意用户生成的活跃别名收信
    //     → 不区分别名归属,只要该主邮箱下收件人就推 (用 e.to 作为推送时的收件人身份)
    //
    //   account (用户语义: 别名邮箱)
    //     → 只推订阅者 (wh.user_id) 自己生成的、status=active 的别名收信
    //     → 不推主邮箱直接收的、不推别人公开邮箱下别人生成的别名
    //
    // 历史兼容: 旧的 alias_all 行为是「只别名不含主邮箱直收」(真子集),
    //          旧 account 行为是「只主邮箱直收」(已被废除) —— 升级到 v8 后按新语义重新解释。
    const wantsAccount  = myTargets.some(t => t.scope === 'account');
    const wantsAliasAll = myTargets.some(t => t.scope !== 'account');
    const toLower = (s: string) => (s || '').toLowerCase();
    const accountEmailLower = toLower(account.email);

    let filtered: Email[];
    let pickedAliasAll = false;
    let pickedAccount = false;
    if (wantsAliasAll && !wantsAccount) {
      // 「整个邮箱」: 主邮箱直接收 + 该邮箱下所有用户的活跃别名收信
      const aliases = await listActiveAliasesForAccount(env, accountId);
      const set = new Set(aliases);
      filtered = emails.filter(e => {
        const t = toLower(e.to);
        return t === accountEmailLower || set.has(t);
      });
      pickedAliasAll = filtered.length > 0;
    } else if (wantsAccount && !wantsAliasAll) {
      // 「别名邮箱」: 仅订阅者 (wh.user_id) 自己生成的、活跃别名收信
      const aliases = await listActiveAliasesForAccount(env, accountId, wh.user_id);
      if (!aliases.length) continue;          // 没有任何自己生成的活跃别名 = 无可推送
      const set = new Set(aliases);
      filtered = emails.filter(e => set.has(toLower(e.to)));
      pickedAccount = filtered.length > 0;
    } else {
      // 两种 scope 同时存在(per-target 混合): 合并别名集 + 主邮箱,任一命中即推送
      //   alias_all 取「所有用户活跃别名 + 主邮箱」
      //   account 取「wh.user_id 自己生成的活跃别名」 —— 已是子集,合并不丢东西
      const [allAliases, ownAliases] = await Promise.all([
        listActiveAliasesForAccount(env, accountId),
        listActiveAliasesForAccount(env, accountId, wh.user_id),
      ]);
      const set = new Set([...allAliases, ...ownAliases]);
      filtered = emails.filter(e => {
        const t = toLower(e.to);
        return t === accountEmailLower || set.has(t);
      });
      pickedAliasAll = filtered.length > 0;
      pickedAccount  = filtered.length > 0;
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

    // 聚合推送一次。
    // to_alias 仅用作「命中说明」——非账号直接收信时,采用第一封的实际收件人地址。
    const payload: WebhookPayload = {
      event: 'new_mail',
      delivered_at: nowISO(),
      mail_account_id: accountId,
      email: account.email,
      to_alias: pickedAccount ? account.email : (newEmails[0]?.to || undefined),
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
    // 平台级成功判定:飞书 / 钉钉等业务失败时依然返回 HTTP 200,
    // 只靠 resp.ok 会把「卡片标签写错导致整条消息被拒」误报成「推送成功」。
    // 这里解析常见业务码(code / StatusCode / errcode),非 0 一律判失败。
    if (success) {
      try {
        const j = JSON.parse(responseText) as Record<string, unknown>;
        const raw = j.code ?? j.StatusCode ?? j.errcode ?? j.errCode;
        const bizCode = typeof raw === 'number'
          ? raw
          : (typeof raw === 'string' && raw.trim() !== '' && Number.isFinite(Number(raw)) ? Number(raw) : null);
        if (bizCode !== null && bizCode !== 0) {
          success = false;
          const bizMsg = String(j.msg ?? j.StatusMessage ?? j.errmsg ?? j.error ?? '');
          responseText = `[平台返回失败] code=${bizCode} ${bizMsg} | 原始响应: ${responseText}`;
        }
      } catch { /* 非 JSON 响应,维持按 HTTP 状态码判定 */ }
    }
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

// 取邮件正文:从 m.body_text 读取(入库时已解析,限 4KB)
// 完全为空时给出明确引导,而不是含糊的「(无正文)」让用户摸不着头脑
function bodyOf(m: Email): string {
  let text = (m.body || '').trim();
  if (!text && m.html) text = htmlToText(m.html).trim();
  if (!text) {
    // 可能是 html-only / multipart 嵌套深 / 超大被跳过 —— 都引导去系统查看
    return '(未能自动解析正文,可能是 HTML 格式或含复杂附件,请登录邮件系统查看完整内容)';
  }
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

// 飞书 lark_md 把 `<xxx>` 当作 HTML 标签解析,导致 `jkf6886 <jkf6886@proton.me>`
// 中的地址部分被静默丢弃(用户反馈:推送卡片里只剩 `jkf6886` 前缀)。
// 这里把 `<>` 转成 `「」`,既保留姓名与地址的可读性,又不会被 lark_md 当标签删掉。
// 钉钉 markdown / plain_text 也一并用此格式,保持一致。
function fromLine(m: Email): string {
  const name = (m.from || '').trim();
  if (!name) return '-';
  // 已经是 "Name <addr@x>" 的,换成「addr@x」形式保留完整地址
  const angleMatch = name.match(/^\s*"?([^"<]*)"?\s*<([^>]+)>\s*$/);
  if (angleMatch) {
    const [, dispName, addr] = angleMatch;
    if (dispName.trim()) return `${dispName.trim()} 「${addr.trim()}」`;
    return `「${addr.trim()}」`;
  }
  // 已经是单地址,直接返回
  return name;
}

// ============ 飞书 ============
function buildFeishuMessages(format: 'card' | 'markdown' | 'text', p: WebhookPayload): OutMessage[] {
  if (format === 'text') {
    return [{ body: JSON.stringify({ msg_type: 'text', content: { text: buildPlainText(p) } }), contentType: 'application/json' }];
  }
  // 无邮件(测试/汇总)时也发一张卡片
  if (!p.emails || p.emails.length === 0) {
    return [feishuCard('🔧 测试推送', 'blue', [
      { tag: 'div', text: { tag: 'lark_md', content: `Webhook 配置正常,已收到测试事件。\n**主邮箱**: ${p.email || '(未指定)'}\n**时间**: ${p.delivered_at}` } },
    ])];
  }
  const list = p.emails.slice(0, MAX_PUSH_EMAILS);
  const msgs: OutMessage[] = list.map(m => {
    const content = [
      `**发件人**: ${fromLine(m)}`,
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
        { tag: 'div', text: { tag: 'lark_md', content } },
      ]);
    }
    // 完整卡片:标题 + 结构化字段 + 正文
    return feishuCard(subjectOf(m), 'blue', [
      {
        tag: 'div',
        fields: [
          { is_short: true, text: { tag: 'lark_md', content: `**发件人**\n${fromLine(m)}` } },
          { is_short: true, text: { tag: 'lark_md', content: `**收件时间**\n${m.date || '-'}` } },
          { is_short: true, text: { tag: 'lark_md', content: `**收件人(别名)**\n${m.to || '-'}` } },
          { is_short: true, text: { tag: 'lark_md', content: `**附件**\n${attachmentLine(m)}` } },
        ],
      },
      { tag: 'hr' },
      { tag: 'div', text: { tag: 'lark_md', content: bodyOf(m) } },
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
      `- **发件人**: ${fromLine(m)}`,
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
    lines.push(`发件人: ${fromLine(m)}`);
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
// 取该 webhook 上第一个 target 的 mail_account_id 作为示例,展示订阅走通。
// 没有 target 的 webhook 也允许发送(空主题, 只展示 webhook 本身)。
export async function sendTestEvent(env: Env, webhook: Webhook): Promise<boolean> {
  const sampleAccountId = webhook.targets?.[0]?.mail_account_id || webhook.user_id;
  let sampleEmail = '';
  if (sampleAccountId) {
    try {
      const acc = await getMailAccountById(env, sampleAccountId);
      sampleEmail = acc?.email || '';
    } catch {}
  }
  const payload: WebhookPayload = {
    event: 'test',
    delivered_at: nowISO(),
    mail_account_id: sampleAccountId,
    email: sampleEmail,
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
