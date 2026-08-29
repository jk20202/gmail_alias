// 邮件查询服务 - 统一封装 Gmail API 和 Microsoft Graph API
// 对外暴露 fetchEmails / markEmailsRead,内部按 provider 分发
import type { Env, Email, FetchParams } from './types';
import { ensureValidToken } from './oauth';
import { htmlToText, formatShanghaiTime, parseTime } from './utils';
import { getMailAccountById } from './db';
import { fetchImapEmails, markImapRead } from './imap';

// ============ 统一入口 ============
export async function fetchEmails(env: Env, accountId: string, params: FetchParams): Promise<Email[]> {
  // 先取账号判定 provider;IMAP 走独立的 TCP 收信通道,绕过 OAuth token 刷新
  const account = await getMailAccountById(env, accountId);
  if (!account) throw new Error('邮箱账号不存在');

  const provider = account.provider;
  let emails: Email[];
  if (provider === 'imap') {
    emails = await fetchImapEmails(env, accountId, params);
  } else {
    const { token } = await ensureValidToken(env, accountId);
    emails = provider === 'gmail'
      ? await fetchGmailEmails(token, params)
      : await fetchOutlookEmails(token, params);
  }

  let result = emails.map(e => ({
    ...e,
    // 正文与 HTML 兜底互补,保证模糊搜索不会漏
    body: e.body || (e.html ? htmlToText(e.html) : ''),
    attachments: Array.isArray(e.attachments) ? e.attachments : [],
  }));

  // 统一过滤(两种 API 都可能返回多余数据,本地二次过滤保证准确)
  if (params.to) {
    const toLower = params.to.toLowerCase();
    result = result.filter(e => e.to.toLowerCase().includes(toLower));
  }
  // 时间过滤
  const now = new Date();
  const startDt = parseTime(params.start_time, new Date(now.getTime() - 3600_000));
  const endDt = parseTime(params.end_time, now);
  result = result.filter(e => {
    if (!e.date_iso) return true;
    try {
      const dt = new Date(e.date_iso);
      return dt >= startDt && dt <= endDt;
    } catch {
      return true;
    }
  });
  // 关键字(兼容旧参数) + 统一模糊搜索 q
  const kw = (params.q || params.keyword || '').trim().toLowerCase();
  if (kw) {
    result = result.filter(e => matchFuzzy(e, kw));
  }
  // 排序:时间倒序
  result.sort((a, b) => (b.date_iso || '').localeCompare(a.date_iso || ''));
  if (params.limit) result = result.slice(0, params.limit);
  // 标记 provider
  return result.map(e => ({ ...e, provider }));
}

export async function markEmailsRead(env: Env, accountId: string, sender?: string, subject?: string): Promise<number> {
  const account = await getMailAccountById(env, accountId);
  if (!account) throw new Error('邮箱账号不存在');
  // IMAP 走独立的标记已读通道(按发件人 + 主题匹配)
  if (account.provider === 'imap') {
    return await markImapRead(env, accountId, sender, subject);
  }
  const { token, provider } = await ensureValidToken(env, accountId);
  return provider === 'gmail'
    ? markGmailRead(token, sender, subject)
    : markOutlookRead(token, sender, subject);
}

// 全文模糊匹配: 发件人 / 收件人 / 主题 / 正文 / HTML / 附件名
function matchFuzzy(e: Email, kw: string): boolean {
  if (
    e.subject.toLowerCase().includes(kw)
    || e.body.toLowerCase().includes(kw)
    || e.from.toLowerCase().includes(kw)
    || e.to.toLowerCase().includes(kw)
  ) return true;
  if (e.html && e.html.toLowerCase().includes(kw)) return true;
  const atts = e.attachments || [];
  for (const a of atts) {
    if (a && a.toLowerCase().includes(kw)) return true;
  }
  return false;
}

// ============ Gmail API 实现 ============
// Gmail API 文档: https://developers.google.com/gmail/api/reference/rest/v1/users.messages
interface GmailMessage {
  id: string;
  payload?: {
    headers?: Array<{ name: string; value: string }>;
    parts?: Array<GmailMessagePart>;
    body?: { data?: string; text?: string; attachmentId?: string };
    mimeType?: string;
    filename?: string;
  };
  snippet?: string;
}
interface GmailMessagePart {
  headers?: Array<{ name: string; value: string }>;
  parts?: Array<GmailMessagePart>;
  body?: { data?: string; text?: string; attachmentId?: string };
  mimeType?: string;
  filename?: string;
}

// Gmail 搜索语法 (q 参数): from:xxx to:xxx subject:xxx is:unread after:1234567890
function buildGmailQuery(params: FetchParams): string {
  const parts: string[] = [];
  if (params.sender) parts.push(`from:${params.sender}`);
  if (params.to) parts.push(`to:${params.to}`);
  if (params.subject) parts.push(`subject:${params.subject}`);
  if (params.unseen === true) parts.push('is:unread');
  else if (params.unseen === false) parts.push('is:read');
  if (params.body) parts.push(`"${params.body}"`);
  if (params.start_time) {
    const dt = parseTime(params.start_time, new Date(0));
    parts.push(`after:${Math.floor(dt.getTime() / 1000)}`);
  }
  if (params.end_time) {
    const dt = parseTime(params.end_time, new Date());
    parts.push(`before:${Math.floor(dt.getTime() / 1000)}`);
  }
  return parts.join(' ');
}

async function fetchGmailEmails(token: string, params: FetchParams): Promise<Email[]> {
  // 1. 搜索消息 ID 列表
  //    有模糊搜索词时多拉一些候选,避免结果被 limit 截断导致搜不到
  const wideFactor = (params.q || params.keyword) ? 5 : 3;
  const q = buildGmailQuery(params);
  const listUrl = new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages');
  listUrl.searchParams.set('q', q);
  listUrl.searchParams.set('maxResults', String(Math.min((params.limit || 50) * wideFactor, 500)));
  const listResp = await fetch(listUrl, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!listResp.ok) {
    const err = await listResp.json() as { error?: { message?: string } };
    throw new Error(`Gmail list error: ${err.error?.message || listResp.status}`);
  }
  const listData = await listResp.json() as { messages?: Array<{ id: string }>; resultSizeEstimate?: number };
  const messages = listData.messages || [];
  if (messages.length === 0) return [];

  // 2. 批量拉取消息详情(并发,控制 5 个一批)
  const ids = messages.map(m => m.id).slice(0, Math.min((params.limit || 50) * wideFactor, 500));
  const batches: string[][] = [];
  for (let i = 0; i < ids.length; i += 5) batches.push(ids.slice(i, i + 5));

  const results: Email[] = [];
  for (const batch of batches) {
    const detailPromises = batch.map(id => fetchGmailMessage(token, id));
    const batchResults = await Promise.all(detailPromises);
    for (const e of batchResults) if (e) results.push(e);
  }
  return results;
}

// 单条消息详情
async function fetchGmailMessage(token: string, msgId: string): Promise<Email | null> {
  const url = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${msgId}`);
  url.searchParams.set('format', 'full');
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!resp.ok) return null;
  const msg = await resp.json() as GmailMessage;
  return parseGmailMessage(msg);
}

function parseGmailMessage(msg: GmailMessage): Email {
  const headers = msg.payload?.headers || [];
  const getHeader = (name: string) => headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';
  const from = getHeader('From');
  const to = getHeader('To');
  const subject = getHeader('Subject');
  const dateRaw = getHeader('Date');
  const msgId = getHeader('Message-ID') || msg.id;

  let dateIso = '';
  let dateDisplay = '';
  if (dateRaw) {
    try {
      const dt = new Date(dateRaw);
      dateIso = dt.toISOString();
      dateDisplay = formatShanghaiTime(dateIso);
    } catch { dateDisplay = dateRaw; }
  }

  // 解析 body (递归查找 text/plain 和 text/html) + 收集附件名
  let bodyText = '';
  let htmlText = '';
  const attachments: string[] = [];
  const pushAttachment = (name?: string): void => {
    if (name && attachments.indexOf(name) === -1) attachments.push(name);
  };
  // 从 Content-Disposition / Content-Type 头里兜底取附件名
  const nameFromHeaders = (part: GmailMessagePart): string => {
    for (const h of part.headers || []) {
      const hn = (h.name || '').toLowerCase();
      if (hn !== 'content-disposition' && hn !== 'content-type') continue;
      const m = /filename\*?\s*=\s*(?:UTF-8''|"?)([^";]+)"?/i.exec(h.value || '');
      if (m && m[1]) {
        try { return decodeURIComponent(m[1].trim()); } catch { return m[1].trim(); }
      }
    }
    return '';
  };
  const walk = (part?: GmailMessagePart): void => {
    if (!part) return;
    const mime = part.mimeType || '';
    const fname = part.filename || nameFromHeaders(part);
    if (fname) pushAttachment(fname);
    else if (/^multipart\//.test(mime) === false && mime && mime !== 'text/plain' && mime !== 'text/html'
      && (part.body?.attachmentId || /^application\//.test(mime) || /^image\//.test(mime))) {
      pushAttachment('(未命名附件)');
    }
    if (mime === 'text/plain' && part.body?.data && !bodyText) {
      bodyText = decodeBase64Url(part.body.data);
    } else if (mime === 'text/html' && part.body?.data && !htmlText) {
      htmlText = decodeBase64Url(part.body.data);
    }
    if (part.parts) for (const p of part.parts) walk(p);
  };
  walk(msg.payload as GmailMessagePart | undefined);
  if (!bodyText && htmlText) bodyText = htmlToText(htmlText);
  if (!bodyText && msg.snippet) bodyText = msg.snippet;

  return {
    id: msgId,
    from, to, subject,
    date: dateDisplay,
    date_iso: dateIso,
    body: bodyText,
    html: htmlText,
    unread: false, // Gmail API 不在消息体里返回未读,需用 labels 字段;此处先用 false
    attachments,
  };
}

// Gmail base64url 解码
function decodeBase64Url(s: string): string {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + pad;
  try {
    // Workers 支持 atob
    const bin = atob(b64);
    // 处理 UTF-8
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8').decode(bytes);
  } catch {
    return '';
  }
}

// Gmail 标记已读 (用 modify 接口移除 UNREAD 标签)
// sender 可能是 "Name <email@example.com>" 格式,需提取纯邮箱地址
async function markGmailRead(token: string, sender?: string, subject?: string): Promise<number> {
  const parts: string[] = ['is:unread'];
  if (sender) {
    // 从 "Name <email@example.com>" 中提取邮箱地址
    const emailMatch = sender.match(/<([^>]+)>/);
    const emailAddr = emailMatch ? emailMatch[1] : sender;
    parts.push(`from:${emailAddr}`);
  }
  if (subject) {
    // subject 中的特殊字符需要处理,Gmail 搜索不支持复杂转义,去掉冒号
    const cleanSubject = subject.replace(/[:"\\]/g, ' ').trim();
    if (cleanSubject) parts.push(`subject:${cleanSubject}`);
  }
  const q = parts.join(' ');
  const listUrl = new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages');
  listUrl.searchParams.set('q', q);
  listUrl.searchParams.set('maxResults', '100');
  const listResp = await fetch(listUrl, { headers: { Authorization: `Bearer ${token}` } });
  if (!listResp.ok) return 0;
  const listData = await listResp.json() as { messages?: Array<{ id: string }> };
  const messages = listData.messages || [];
  if (messages.length === 0) return 0;
  // 逐条移除 UNREAD 标签 (并发 5 一批)
  const batches: string[][] = [];
  for (let i = 0; i < messages.length; i += 5) batches.push(messages.slice(i, i + 5).map(m => m.id));
  let count = 0;
  for (const batch of batches) {
    await Promise.all(batch.map(id =>
      fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}/modify`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ removeLabelIds: ['UNREAD'] }),
      })
    ));
    count += batch.length;
  }
  return count;
}

// ============ Microsoft Graph API 实现 ============
// 文档: https://learn.microsoft.com/en-us/graph/api/message-list
interface GraphMessage {
  id: string;
  from?: { emailAddress?: { address: string; name?: string } };
  toRecipients?: Array<{ emailAddress?: { address: string; name?: string } }>;
  subject?: string;
  receivedDateTime?: string;
  body?: { contentType: string; content: string };
  bodyPreview?: string;
  isRead?: boolean;
  internetMessageId?: string;
  hasAttachments?: boolean;
  attachments?: Array<{ name?: string }>;
}

// OData $filter 语法
function buildGraphFilter(params: FetchParams): string | undefined {
  const filters: string[] = [];
  if (params.sender) filters.push(`from/emailAddress/address eq '${params.sender.replace(/'/g, "''")}'`);
  if (params.unseen === true) filters.push('isRead eq false');
  else if (params.unseen === false) filters.push('isRead eq true');
  if (params.start_time) {
    const dt = parseTime(params.start_time, new Date(0));
    filters.push(`receivedDateTime ge ${dt.toISOString()}`);
  }
  if (params.end_time) {
    const dt = parseTime(params.end_time, new Date());
    filters.push(`receivedDateTime le ${dt.toISOString()}`);
  }
  return filters.length ? filters.join(' and ') : undefined;
}

// $search 语法 (用于主题/正文匹配)
function buildGraphSearch(params: FetchParams): string | undefined {
  const parts: string[] = [];
  if (params.subject) parts.push(`"${params.subject}"`);
  if (params.body) parts.push(`"${params.body}"`);
  return parts.length ? parts.join(' ') : undefined;
}

async function fetchOutlookEmails(token: string, params: FetchParams): Promise<Email[]> {
  // 有模糊搜索词时多拉候选,避免结果被 limit 截断
  const wideFactor = (params.q || params.keyword) ? 3 : 1;
  const top = Math.min(Math.max(params.limit || 50, 25) * wideFactor, 100);
  // $expand 展开附件名(Graph 支持);失败时自动降级为不带 expand 的请求
  const useExpand = true;
  const build = (withExpand: boolean): URL => {
    const u = new URL('https://graph.microsoft.com/v1.0/me/messages');
    // 选字段减少流量
    u.searchParams.set('$select', 'id,internetMessageId,from,toRecipients,subject,receivedDateTime,body,bodyPreview,isRead,hasAttachments');
    if (withExpand) u.searchParams.set('$expand', 'attachments($select=id,name,size)');
    u.searchParams.set('$top', String(top));
    u.searchParams.set('$orderby', 'receivedDateTime desc');
    const f = buildGraphFilter(params);
    if (f) u.searchParams.set('$filter', f);
    // 注意: $search 和 $filter 不能同时用
    const s = !f ? buildGraphSearch(params) : undefined;
    if (s) u.searchParams.set('$search', s);
    return u;
  };

  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  let resp = await fetch(build(useExpand), { headers });
  if (!resp.ok && useExpand) {
    // 降级重试
    const retry = build(false);
    if (retry.searchParams.get('$search')) headers['ConsistencyLevel'] = 'eventual';
    resp = await fetch(retry, { headers });
  }
  if (!resp.ok) {
    const err = await resp.json() as { error?: { message?: string } };
    throw new Error(`Graph API error: ${err.error?.message || resp.status}`);
  }
  const data = await resp.json() as { value?: GraphMessage[] };
  return (data.value || []).map(parseGraphMessage);
}

// 附件名兜底:Graph 未返回 attachments 但标记了 hasAttachments
function graphAttachments(msg: GraphMessage): string[] {
  const names = (msg.attachments || []).map(a => a && a.name ? a.name : '').filter(Boolean);
  if (!names.length && msg.hasAttachments) return ['(含附件)'];
  return names;
}

function parseGraphMessage(msg: GraphMessage): Email {
  const fromName = msg.from?.emailAddress?.name || '';
  const fromAddr = msg.from?.emailAddress?.address || '';
  const from = fromName ? `${fromName} <${fromAddr}>` : fromAddr;
  const to = (msg.toRecipients || [])
    .map(r => r.emailAddress?.address || '')
    .filter(Boolean)
    .join(', ');
  const dateIso = msg.receivedDateTime || '';
  return {
    id: msg.internetMessageId || msg.id,
    from,
    to,
    subject: msg.subject || '',
    date: formatShanghaiTime(dateIso),
    date_iso: dateIso,
    body: msg.body?.contentType === 'text'
      ? msg.body.content
      : htmlToText(msg.body?.content || ''),
    html: msg.body?.contentType === 'html' ? (msg.body.content || '') : '',
    unread: msg.isRead === false,
    attachments: graphAttachments(msg),
  };
}

async function markOutlookRead(token: string, sender?: string, subject?: string): Promise<number> {
  // 查找匹配的未读邮件,然后批量更新 isRead = true
  // sender 可能是 "Name <email@example.com>" 格式,需提取纯邮箱地址
  let senderAddr = sender || '';
  const emailMatch = senderAddr.match(/<([^>]+)>/);
  if (emailMatch) senderAddr = emailMatch[1];

  const url = new URL('https://graph.microsoft.com/v1.0/me/messages');
  url.searchParams.set('$select', 'id');
  url.searchParams.set('$top', '100');
  const filters = ['isRead eq false'];
  if (senderAddr) filters.push(`from/emailAddress/address eq '${senderAddr.replace(/'/g, "''")}'`);
  if (subject) filters.push(`subject eq '${subject.replace(/'/g, "''")}'`);
  url.searchParams.set('$filter', filters.join(' and '));

  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!resp.ok) return 0;
  const data = await resp.json() as { value?: Array<{ id: string }> };
  const messages = data.value || [];
  if (messages.length === 0) return 0;

  // 逐条 PATCH (Graph 没有批量更新 isRead 的接口)
  const batches: Array<Array<{ id: string }>> = [];
  for (let i = 0; i < messages.length; i += 5) batches.push(messages.slice(i, i + 5));
  let count = 0;
  for (const batch of batches) {
    await Promise.all(batch.map(m =>
      fetch(`https://graph.microsoft.com/v1.0/me/messages/${m.id}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ isRead: true }),
      })
    ));
    count += batch.length;
  }
  return count;
}
