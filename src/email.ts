// Email Worker: 接收 Cloudflare Email Routing 转发过来的邮件
//
// 设计约束(关键):
//   Cloudflare 免费套餐下,Email Worker 与 HTTP 请求共享同样的 10ms CPU 限额
//   (官方文档: "Routing to Workers on the Workers Free plan ... count toward the
//   standard Workers CPU and memory limits ... complex handlers may exceed these limits")。
//   因此这里**绝不做完整 MIME 解析**:
//     - message.headers 由 Cloudflare 预先解析好,取字段几乎零成本;
//     - 原始邮件以 ReadableStream 直接流式写入 R2,不做拼接/解码;
//     - 正文与附件交给浏览器端 postal-mime 解析(Worker 只负责把 raw 吐出去)。
//
// 归属判定顺序(决定这封邮件属于哪个邮箱/别名):
//   1) 原始收件人优先匹配「别名」(转发场景: 别人发到 jk+ui@gmail.com,Gmail 再转发给我们)
//   2) 其次匹配「主邮箱地址」
//   3) 最后用信封收件人匹配「专属转发地址」(原始收件人丢失时的兜底)
//   参考开源项目 Alle 的候选头优先级(duck-original-to / x-original-to / ... / x-forwarded-to)。

import type { Env, EmailRow } from './types';
import { insertEmail, getMailAccountById } from './db';
import { extractPlainText } from './emailParse';
import { pollAndPush } from './webhook';

// 候选收件人所在头,按优先级从高到低。
// 注意: 信封收件人 message.to 不在这里 —— 它等于我们的专属转发地址,
// 若参与候选会永远只命中主邮箱、掩盖真实别名,因此仅作为最后兜底。
const CANDIDATE_HEADERS = [
  'duck-original-to',          // DuckDuckGo 邮件保护
  'x-original-to',
  'original-recipient',
  'x-github-recipient-address',
  'destinations',
  'resent-to',
  'to',
  'delivered-to',
  'x-forwarded-to',
  'x-envelope-to',
  'cc',
];

function headerValue(headers: Headers, name: string): string | null {
  const v = headers.get(name);
  return v ? v.trim() : null;
}

// 从任意文本里抽出邮箱地址(小写去重)
function extractEmails(value: string | null | undefined): string[] {
  if (!value) return [];
  const m = value.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi);
  if (!m) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of m) {
    const s = raw.toLowerCase();
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

// 按优先级收集候选收件人(去重)
function collectCandidates(headers: Headers): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const key of CANDIDATE_HEADERS) {
    for (const addr of extractEmails(headerValue(headers, key))) {
      if (seen.has(addr)) continue;
      seen.add(addr);
      out.push(addr);
    }
  }
  return out;
}

// 解析 From 头 -> { 显示名, 邮箱地址 }
function parseFrom(value: string | null): { name: string | null; address: string | null } {
  if (!value) return { name: null, address: null };
  const addrMatch = value.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  const address = addrMatch ? addrMatch[0].toLowerCase() : null;
  let name: string | null = null;
  const angle = value.match(/^\s*"?([^"<]*?)"?\s*</);
  if (angle && angle[1] && angle[1].trim()) name = angle[1].trim();
  else if (!address) name = value.trim().slice(0, 120);
  return { name, address };
}

// RFC2047 解码(=?charset?b|q?...?=),仅处理主题这类短字符串
function decodeRfc2047(s: string): string {
  if (!s || s.indexOf('=?') < 0) return s;
  return s.replace(/=\?([^?]+)\?([bqBQ])\?([^?]*)\?=/g, (_m, _cs: string, enc: string, data: string) => {
    try {
      if (enc.toLowerCase() === 'b') {
        const bin = atob(data);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return new TextDecoder('utf-8').decode(bytes);
      }
      return data.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_x, h: string) =>
        String.fromCharCode(parseInt(h, 16)));
    } catch {
      return data;
    }
  });
}

// Date 头 -> UTC 秒
function parseSentAt(value: string | null): number {
  const t = value ? Date.parse(value) : NaN;
  return Number.isNaN(t) ? Math.floor(Date.now() / 1000) : Math.floor(t / 1000);
}

interface Resolved {
  accountId: string;
  aliasId: string | null;
}

// 归属判定:别名 > 主邮箱 > 专属转发地址 > CATCHALL
// 全程只发 3 条 SQL(批量 IN 查询),避免逐候选查询拖长收信耗时。
// 导出供离线测试(tmp/verify_resolve_owner.js)。
export async function resolveOwner(env: Env, candidates: string[], envelopeTo: string): Promise<Resolved | null> {
  // 1) 批量匹配别名
  //
  // ⚠ 判据必须是 status <> 'archived',不能是 status = 'active'!
  //   别名有 1 小时 TTL,过期由 expireStaleAliases **惰性**标记(用户打开别名页才刷)。
  //   若这里要求 active,别名一过期,发给它的邮件就匹配不上 → 掉到第 3 步的
  //   forward_address 兜底 → 被随机归到某个共享同一转发地址的邮箱(详见第 3 步注释),
  //   用户会发现"邮件莫名其妙进了别人的邮箱 / 干脆找不到"。
  //   'archived' 才是用户主动归档(明确停止收信),只有它该被排除。
  if (candidates.length) {
    const ph = candidates.map(() => '?').join(',');
    const { results } = await env.DB.prepare(
      `SELECT id, mail_account_id, full FROM user_aliases WHERE full IN (${ph}) AND status <> 'archived'`
    ).bind(...candidates).all<{ id: string; mail_account_id: string; full: string }>();
    const rows = results || [];
    for (const cand of candidates) {          // 按优先级取第一个命中的
      const hit = rows.find(r => (r.full || '').toLowerCase() === cand);
      if (hit) return { accountId: hit.mail_account_id, aliasId: hit.id };
    }
  }
  // 2) 批量匹配主邮箱
  if (candidates.length) {
    const ph = candidates.map(() => '?').join(',');
    const { results } = await env.DB.prepare(
      `SELECT id, email FROM mail_accounts WHERE email IN (${ph})`
    ).bind(...candidates).all<{ id: string; email: string }>();
    const rows = results || [];
    for (const cand of candidates) {
      const hit = rows.find(r => (r.email || '').toLowerCase() === cand);
      if (hit) return { accountId: hit.id, aliasId: null };
    }
  }
  // 3) 兜底: 信封收件人 = 该邮箱的**专属**转发地址
  //
  // ⚠ 必须先排除「统一转发地址」(UNIFIED_FORWARD_ADDRESS,如 alle@jkf.kdns.fr):
  //   它被设计成**对所有邮箱一致**,本身不携带任何归属信息。拿它去查 mail_accounts
  //   会命中**多行**,而 .first() 没有 ORDER BY —— 归到哪个邮箱完全随机。
  //   线上实证(2026-09-03): 一封匹配不到别名的邮件被归到了 vy@fei.bgr,
  //   而 CATCHALL_ACCOUNT_ID 明明配的是 jinkaifu2002@outlook.com(va6ae88e5)。
  //   统一地址应直接跳过本步,交给第 4 步的 CATCHALL 兜底,结果才是确定的。
  const env3 = extractEmails(envelopeTo);
  const unified = (env.UNIFIED_FORWARD_ADDRESS || '').trim().toLowerCase();
  if (env3.length && env3[0] !== unified) {
    const row = await env.DB.prepare('SELECT id FROM mail_accounts WHERE forward_address = ?')
      .bind(env3[0]).first<{ id: string }>();
    if (row) return { accountId: row.id, aliasId: null };
  }
  // 4) 最终兜底: 若配置了 CATCHALL_ACCOUNT_ID,所有归属失败的邮件都交给它。
  // 这是「单人/单域/所有邮箱统一转发到一个固定地址」场景下的最简单模型。
  const catchAll = (env.CATCHALL_ACCOUNT_ID || '').trim();
  if (catchAll) {
    const row = await env.DB.prepare('SELECT id FROM mail_accounts WHERE id = ?')
      .bind(catchAll).first<{ id: string }>();
    if (row) return { accountId: row.id, aliasId: null };
  }
  return null;
}

// 记录一条「未识别收件」(收信诊断用)。
// 只写头字段,单次 INSERT,CPU 开销可忽略。诊断表保留最近 100 条,超出即清理。
async function recordUnmatched(env: Env, message: ForwardableEmailMessage): Promise<void> {
  try {
    const { address } = parseFrom(headerValue(message.headers, 'from'));
    await env.DB.prepare(
      `INSERT INTO email_unmatched (id, envelope_to, header_to, from_address, subject, reason)
       VALUES(?,?,?,?,?,?)`
    ).bind(
      crypto.randomUUID(),
      (message.to || '').slice(0, 200) || null,
      (headerValue(message.headers, 'to') || '').slice(0, 300) || null,
      address,
      decodeRfc2047(headerValue(message.headers, 'subject') || '').slice(0, 200) || null,
      'no_matching_mailbox',
    ).run();
    // 控制表体积:只保留最近 100 条
    await env.DB.prepare(
      `DELETE FROM email_unmatched WHERE id NOT IN
         (SELECT id FROM email_unmatched ORDER BY created_at DESC LIMIT 100)`
    ).run();
  } catch (e) {
    console.error('recordUnmatched failed:', e);
  }
}

/**
 * Email Worker 入口。
 * 在 wrangler 里无需额外配置;需在 Cloudflare 后台
 * 「Email → Email Routing → Routing rules」把收信规则指向本 Worker。
 *
 * 返回值: 本次邮件实际入库的 mail_account_id;未归属 / 处理失败时为 null。
 * 调用方 (index.ts) 用它触发 webhook 实时推送 —— 必须与入库账户完全一致,
 * 否则会出现「邮件进了 A 邮箱, 却把通知推给 B 邮箱的订阅」。
 */
export async function emailHandler(
  message: ForwardableEmailMessage,
  env: Env,
  _ctx: ExecutionContext,
): Promise<string | null> {
  try {
    if (!message || message.rawSize <= 0) {
      message.setReject('Empty message');
      return null;
    }
    if (message.rawSize > 25 * 1024 * 1024) {
      message.setReject('Message too large (max 25 MiB)');
      return null;
    }

    const candidates = collectCandidates(message.headers);
    const owner = await resolveOwner(env, candidates, message.to || '');
    if (!owner) {
      // 没有任何已登记邮箱/别名与之对应:拒收,避免垃圾邮件入库。
      // 但先记一行诊断 —— 用户排查「自动转发是否生效」时全靠它:
      // 只要这里出现记录,就证明 Cloudflare Email Routing 与路由规则都是通的,
      // 问题只在于该收件地址没有登记到任何邮箱上。
      await recordUnmatched(env, message);
      message.setReject('No matching mailbox or alias for this message');
      return null;
    }

    const id = crypto.randomUUID();
    const month = new Date().toISOString().slice(0, 7);   // yyyy-mm
    const rawKey = `emails/${owner.accountId}/${month}/${id}.eml`;

    // 原始邮件写入 R2。Email Worker 的 message.raw 是 ReadableStream,
    // 实测直接 put(stream,...) 会在生产环境失败(raw_key=null,详情页 404)。
    // 改为先读成 ArrayBuffer 再写入;10ms CPU 限额内处理常见邮件(<25MiB)无压力。
    let storedKey: string | null = null;
    let rawBuf: ArrayBuffer | null = null;
    try {
      rawBuf = await new Response(message.raw).arrayBuffer();
      await env.EMAIL_RAW.put(rawKey, rawBuf, {
        httpMetadata: { contentType: 'message/rfc822' },
      });
      storedKey = rawKey;
    } catch (e) {
      console.error('R2 put failed:', e);
    }

    const fromRaw = headerValue(message.headers, 'from');
    const { name: fromName, address: fromAddr } = parseFrom(fromRaw);
    const ct = (headerValue(message.headers, 'content-type') || '').toLowerCase();

    // v9: 同步解析 text/plain 到 body_text,webhook 推送时直接读这字段
    // 这样:
    //   - 推送延迟从「等 cron 触发 + pull 时解析」降到「入库即解析完成, push 时零解析」
    //   - 卡片里直接显示真实正文,不再「(无正文)」
    // 失败/超大/非 text/plain 都标 status=-1,前端可显示「请在系统内查看」
    let bodyText: string | null = null;
    let bodyStatus = 0;
    if (rawBuf && rawBuf.byteLength > 0 && rawBuf.byteLength <= 200_000) {
      const r = extractPlainText(rawBuf, 4000);
      if (r.status === 1 && r.body) {
        bodyText = r.body;
        bodyStatus = 1;
      } else {
        bodyStatus = -1;
      }
    } else if (rawBuf && rawBuf.byteLength > 200_000) {
      // 太大不解析(占 D1 体积 + CPU),前端仍可从 raw_url 拉取解析
      bodyStatus = -1;
    } else {
      bodyStatus = -1;
    }

    const row: EmailRow = {
      id,
      account_id: owner.accountId,
      alias_id: owner.aliasId,
      message_id: headerValue(message.headers, 'message-id'),
      subject: decodeRfc2047(headerValue(message.headers, 'subject') || '').slice(0, 500) || null,
      from_name: fromName ? fromName.slice(0, 200) : null,
      from_address: fromAddr,
      delivered_to: candidates[0] || extractEmails(message.to)[0] || null,
      recipient: (headerValue(message.headers, 'to') || '').slice(0, 500) || null,
      cc: (headerValue(message.headers, 'cc') || '').slice(0, 500) || null,
      sent_at: parseSentAt(headerValue(message.headers, 'date')),
      size: message.rawSize,
      raw_key: storedKey,
      has_attachments: /multipart\/(mixed|related)/.test(ct) ? 1 : 0,
      body_text: bodyText,
      body_status: bodyStatus,
      read: 0,
      created_at: new Date().toISOString(),
    };

    await insertEmail(env, row);
    return owner.accountId;
  } catch (e) {
    console.error('emailHandler error:', e);
    try { message.setReject('Failed to process inbound email'); } catch { /* ignore */ }
    return null;
  }
}

// v9: Email Worker 入库完成后,异步触发 webhook 推送
//  设计原则:
//    - 必须 waitUntil 异步执行,不阻塞 Email Routing 响应
//    - accountId 由 emailHandler 返回(即邮件实际入库的那个账户),
//      **不要**在这里用 message.to / forward_address 重新反推:
//      所有邮箱共享同一个 catch-all 转发地址,LIMIT 1 会随机命中一个账户,
//      把 A 邮箱的邮件通知推给 B 邮箱的订阅;而且走 CATCHALL_ACCOUNT_ID 兜底
//      入库的邮件根本没有 forward_address 匹配,会整封漏推。
//    - 这里**不**做推送成功/失败判定,只是 fire-and-forget 触发 pollAndPush
//    - 该函数异常一律吞掉(已被 waitUntil 包裹,失败不会影响 emailHandler 主体结果)
//
//  一个新邮件 → 一次 push 触发。push 内部仍走完整的去重 + 过滤 + 平台投递流程,
//  所以同一封邮件对**同一个订阅**不会重复推送
//  (pollAndPush 的 KV 去重 key 为 `wh:pushed:<whid>:<aid>:<mid>`,带订阅 id,
//   这样 N 个订阅各自独立去重,互不吞并)。
export async function schedulePush(env: Env, accountId: string): Promise<void> {
  try {
    if (!accountId) return;
    await pollAndPush(env, accountId);
  } catch (e) {
    console.error('schedulePush failed:', e);
  }
}
