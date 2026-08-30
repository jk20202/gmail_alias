// 邮件查询服务 (v2: 转发聚合版)
//
// v2 不再实时连 IMAP / 调 Gmail API —— 邮件已由 Email Worker 接收并落库(src/email.ts),
// 这里只做本地 D1 查询,单次请求 CPU 远低于免费套餐 10ms 限额,彻底告别 error 1102。
//
// 正文与附件不在此解析:D1 只存元数据,原始 .eml 存 R2,
// 由前端下载 raw 后用 postal-mime 在**浏览器**解析(Worker 保持零解析成本)。

import type { Env, Email, EmailRow, FetchParams } from './types';
import { listEmails, markEmailRead } from './db';
import { formatShanghaiTime } from './utils';

// 数据库行 -> API 输出对象
export function toEmail(row: EmailRow): Email {
  const dateIso = new Date(row.sent_at * 1000).toISOString();
  return {
    id: row.id,
    from: row.from_name
      ? `${row.from_name} <${row.from_address || ''}>`
      : (row.from_address || ''),
    to: row.delivered_to || row.recipient || '',
    subject: row.subject || '(无主题)',
    date: formatShanghaiTime(dateIso),
    date_iso: dateIso,
    // 正文不在库里:由前端按 raw_url 下载后解析;这里留空避免误导
    body: '',
    html: '',
    unread: row.read !== 1,
    attachments: row.has_attachments === 1 ? ['(含附件)'] : [],
    provider: 'forward',
    alias: row.delivered_to || undefined,
    raw_url: `/api/web/email/raw?id=${encodeURIComponent(row.id)}`,
    size: row.size,
  };
}

// 查询某邮箱的邮件(已由调用方做过权限校验)
export async function fetchEmails(env: Env, accountId: string, params: FetchParams): Promise<Email[]> {
  const { rows } = await listEmails(env, {
    accountIds: [accountId],
    aliasId: params.alias_id,
    q: params.q,
    startTime: params.start_time,
    endTime: params.end_time,
    unreadOnly: params.unseen === true,
    limit: params.limit,
    offset: params.offset || 0,
  });
  return rows.map(toEmail);
}

// 标记已读(按邮件 id 批量)。返回受影响行数。
export async function markEmailsRead(env: Env, accountId: string, ids: string[]): Promise<number> {
  if (!ids.length) return 0;
  // 越权防护:只允许标记属于该邮箱的邮件
  const ph = ids.map(() => '?').join(',');
  const { results } = await env.DB.prepare(
    `SELECT id FROM emails WHERE account_id = ? AND id IN (${ph})`
  ).bind(accountId, ...ids).all<{ id: string }>();
  const owned = (results || []).map(r => r.id);
  return await markEmailRead(env, owned);
}

// 兼容旧签名:按发件人 + 主题批量标记已读(仍限定在该邮箱内)
export async function markEmailsReadBySender(
  env: Env, accountId: string, sender?: string, subject?: string,
): Promise<number> {
  if (!sender && !subject) return 0;
  const where: string[] = ['account_id = ?'];
  const binds: any[] = [accountId];
  if (sender) { where.push('from_address LIKE ?'); binds.push(`%${sender}%`); }
  if (subject) { where.push('subject LIKE ?'); binds.push(`%${subject}%`); }
  const { results } = await env.DB.prepare(
    `SELECT id FROM emails WHERE ${where.join(' AND ')}`
  ).bind(...binds).all<{ id: string }>();
  const ids = (results || []).map(r => r.id);
  return await markEmailRead(env, ids);
}
