// IMAP(应用密码)收信客户端 + 轻量 MIME 解析
// 仅在 Worker 运行时(cloudflare:sockets 的 connect)可用;需 compatibility_date >= 2024-09-23(已在 wrangler.toml 配置)。
// 设计要点:
//   1) 全程以 Uint8Array 字节缓冲工作,IMAP 字面量 {N} 的 N 是字节数,避免 UTF-8 解码导致偏移错位。
//   2) 解析 FETCH 响应时遇到 {N} 直接跳过 N 字节,括号配平不受信件正文里的 '(' ')' 影响。
//   3) 邮件正文用轻量 MIME 解析(支持 multipart/alternative、multipart/mixed、嵌套、附件名、RFC2047、QP/Base64)。
import type { Env, Email, FetchParams } from './types';
import { getImapAccountById } from './db';
import { htmlToText, formatShanghaiTime } from './utils';

/* connect() from Cloudflare Sockets Runtime API (需 compatibility_date >= 2024-09-23) */
import { connect } from 'cloudflare:sockets';

export interface ImapConnConfig {
  host: string;
  port: number;
  username: string;
  password: string;
}

// ============ 底层 IMAP 连接 ============
class ImapConnection {
  private socket: any;
  private reader: any;
  private writer: any;
  private dec = new TextDecoder('utf-8');
  private enc = new TextEncoder();
  private buf = new Uint8Array(0);
  private tagCounter = 0;
  private deadline = 0;          // 整体操作截止时间戳(ms),超时即抛错,避免 Worker 被平台 503 杀
  private readTimeoutMs = 12000; // 单次 socket 读取超时,卡死时快速失败
  private len = 0;               // 缓冲中已写入的有效字节数(cap 为容量,二者分离以避免 O(n^2) 重分配)
  private cap = 0;

  static async connect(cfg: ImapConnConfig): Promise<ImapConnection> {
    if (typeof connect !== 'function') {
      throw new Error('当前运行环境不支持 TCP 连接(connect),无法使用 IMAP');
    }
    const socket = connect({ hostname: cfg.host, port: cfg.port }, { secureTransport: 'on', allowHalfOpen: false });
    const conn = new ImapConnection();
    conn.socket = socket;
    conn.reader = socket.readable.getReader();
    conn.writer = socket.writable.getWriter();
    conn.deadline = Date.now() + 25000;
    await conn.drainGreeting();
    return conn;
  }

  private async pushChunk(u: Uint8Array): Promise<void> {
    // 几何增长缓冲:只在容量不足时翻倍分配,避免每收到一个分片就整段重拷贝(O(n^2) 在几百 KB 响应下吃掉数 ms CPU)
    const need = this.len + u.length;
    if (need > this.cap) {
      let nc = this.cap || 1024;
      while (nc < need) nc *= 2;
      const nb = new Uint8Array(nc);
      if (this.len) nb.set(this.buf.subarray(0, this.len), 0);
      this.buf = nb;
      this.cap = nc;
    }
    this.buf.set(u, this.len);
    this.len += u.length;
  }

  private async readChunk(): Promise<boolean> {
    let timer: any;
    const timeoutP = new Promise<never>((_, rej) => {
      timer = setTimeout(() => rej(new Error('IMAP 读取超时(连接无响应)')), this.readTimeoutMs);
    });
    try {
      const r: any = await Promise.race([this.reader.read(), timeoutP]);
      clearTimeout(timer);
      const { value, done } = r;
      if (done) return false;
      if (value && value.length) await this.pushChunk(value);
      return true;
    } catch (e) {
      clearTimeout(timer);
      throw e;
    }
  }

  // 读取服务器问候语(以 "* OK" 或 "* PREAUTH" 开头的一行)
  private async drainGreeting(timeoutMs = 6000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (this.deadline && Date.now() > this.deadline) throw new Error('IMAP 连接超时(超过 25s)');
      if (this.len > 0 && this.buf.subarray(0, this.len).indexOf(0x0a) >= 0) {
        const text = this.dec.decode(this.buf.subarray(0, this.len));
        if (/\* (OK|PREAUTH)/i.test(text)) return;
      }
      const more = await this.readChunk();
      if (!more) return;
    }
  }

  // 在字节缓冲中查找子串(用于定位带标签的响应行)
  private indexOf(hay: Uint8Array, needle: Uint8Array, from: number): number {
    outer: for (let i = from; i + needle.length <= hay.length; i++) {
      for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
      return i;
    }
    return -1;
  }

  // 读取直到出现标签为 tag 的响应行(OK/NO/BAD)
  private async readUntil(tag: string, timeoutMs = 15000): Promise<Uint8Array> {
    const tagBytes = this.enc.encode('\n' + tag + ' ');
    const start = Date.now();
    while (true) {
      const data = this.buf.subarray(0, this.len);
      // 只扫描缓冲尾部(标签响应总是在响应末尾),避免大响应下每次从 0 全量重扫(O(n^2) 吃掉 CPU 限额)
      const from = Math.max(0, data.length - 512);
      const idx = this.indexOf(data, tagBytes, from);
      if (idx >= 0) {
        const rest = data.subarray(idx + tagBytes.length, idx + tagBytes.length + 8);
        const word = this.dec.decode(rest).toUpperCase();
        if (word.startsWith('OK') || word.startsWith('NO') || word.startsWith('BAD')) {
          return data;
        }
      }
      if (Date.now() - start > timeoutMs) throw new Error('IMAP 读取超时');
      if (this.deadline && Date.now() > this.deadline) throw new Error('IMAP 操作超时(超过 25s)');
      const more = await this.readChunk();
      if (!more) return this.buf.subarray(0, this.len);
    }
  }

  // 发送命令并读取完整响应,返回原始缓冲与标签状态
  async command(tag: string, cmd: string, timeoutMs = 20000): Promise<{ raw: Uint8Array; tagged: 'OK' | 'NO' | 'BAD' | 'UNKNOWN'; text: string }> {
    await this.writer.write(this.enc.encode(cmd + '\r\n'));
    const raw = await this.readUntil(tag, timeoutMs);
    const tagBytes = this.enc.encode('\n' + tag + ' ');
    const idx = this.indexOf(raw, tagBytes, 0);
    let tagged: 'OK' | 'NO' | 'BAD' | 'UNKNOWN' = 'UNKNOWN';
    let text = '';
    if (idx >= 0) {
      let end = idx + tagBytes.length;
      while (end < raw.length && raw[end] !== 0x0a) end++;
      text = this.dec.decode(raw.subarray(idx + tagBytes.length, end)).trim();
      const m = /^(OK|NO|BAD)\s?(.*)$/i.exec(text);
      if (m) { tagged = m[1].toUpperCase() as any; text = (m[2] || '').trim(); }
    }
    return { raw, tagged, text };
  }

  nextTag(): string { return 'a' + (++this.tagCounter); }

  async login(username: string, password: string): Promise<void> {
    const tag = this.nextTag();
    const res = await this.command(tag, `${tag} LOGIN ${imapQuote(username)} ${imapQuote(password)}`);
    if (res.tagged !== 'OK') throw new Error('IMAP 登录失败: ' + (res.text || '账号或应用密码错误'));
  }

  async selectInbox(): Promise<void> {
    const tag = this.nextTag();
    const res = await this.command(tag, `${tag} SELECT INBOX`);
    if (res.tagged !== 'OK') throw new Error('IMAP 选择收件箱失败: ' + (res.text || ''));
  }

  // 返回匹配的 UID 列表(升序;取末尾即为最新)
  async searchUids(criteria: string): Promise<number[]> {
    const tag = this.nextTag();
    const res = await this.command(tag, `${tag} UID SEARCH ${criteria}`);
    if (res.tagged !== 'OK') throw new Error('IMAP 搜索失败: ' + (res.text || ''));
    const text = this.dec.decode(res.raw);
    const uids: number[] = [];
    const re = /\* SEARCH\s+([0-9\s]+)/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      m[1].trim().split(/\s+/).forEach(s => { const n = parseInt(s, 10); if (!isNaN(n)) uids.push(n); });
    }
    return uids;
  }

  // 按 UID 批量拉取(默认整封 BODY.PEEK[];列表场景传 'UID FLAGS BODY.PEEK[HEADER]' 只拉头部,极大降低负载)
  async fetchUids(uids: number[], spec = 'UID FLAGS BODY.PEEK[]'): Promise<Map<number, { raw: Uint8Array; flags: string[] }>> {
    const map = new Map<number, { raw: Uint8Array; flags: string[] }>();
    if (!uids.length) return map;
    const tag = this.nextTag();
    const list = uids.join(',');
    const res = await this.command(tag, `${tag} UID FETCH ${list} (${spec})`, 15000);
    if (res.tagged !== 'OK') throw new Error('IMAP 拉取失败: ' + (res.text || ''));
    for (const item of parseFetchBlocks(res.raw)) {
      if (item.uid != null && item.raw) map.set(item.uid, { raw: item.raw, flags: item.flags });
    }
    return map;
  }

  // 取收件箱邮件总数(用于按序列号拉取最近若干封,避免全量 UID 枚举撑爆 CPU)
  async statusMessages(): Promise<number> {
    const tag = this.nextTag();
    const res = await this.command(tag, `${tag} STATUS INBOX (MESSAGES)`, 15000);
    if (res.tagged !== 'OK') return 0;
    const text = this.dec.decode(res.raw);
    const m = /MESSAGES\s+(\d+)/i.exec(text);
    return m ? parseInt(m[1], 10) : 0;
  }

  // 按序列号区间拉取(默认只拉头部):用于「最近 N 封」场景,响应体积与封数成正比,CPU 占用恒定极小
  async fetchBySequence(range: string, spec = 'UID FLAGS BODY.PEEK[HEADER]'): Promise<Map<number, { raw: Uint8Array; flags: string[] }>> {
    const map = new Map<number, { raw: Uint8Array; flags: string[] }>();
    const tag = this.nextTag();
    const res = await this.command(tag, `${tag} FETCH ${range} (${spec})`, 15000);
    if (res.tagged !== 'OK') throw new Error('IMAP 拉取失败: ' + (res.text || ''));
    for (const item of parseFetchBlocks(res.raw)) {
      if (item.uid != null && item.raw) map.set(item.uid, { raw: item.raw, flags: item.flags });
    }
    return map;
  }

  async storeSeen(uids: number[]): Promise<void> {
    if (!uids.length) return;
    const tag = this.nextTag();
    try {
      await this.command(tag, `${tag} UID STORE ${uids.join(',')} +FLAGS (\\Seen)`, 20000);
    } catch { /* 标记已读失败不影响主流程 */ }
  }

  async logout(): Promise<void> {
    try {
      const tag = this.nextTag();
      await this.command(tag, `${tag} LOGOUT`, 5000);
    } catch { /* ignore */ }
  }

  async close(): Promise<void> {
    try { await this.writer.close(); } catch { /* ignore */ }
    try { await this.reader.cancel(); } catch { /* ignore */ }
  }
}

// IMAP 引号(双引号包裹,转义内部 " 与 \)
function imapQuote(s: string): string {
  return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

// ============ FETCH 响应字节级解析 ============
interface FetchItem { uid?: number; flags: string[]; raw?: Uint8Array; }

// 在字节缓冲中找出所有 "* n FETCH (...)" 块,正确处理 {N} 字面量
function parseFetchBlocks(buf: Uint8Array): FetchItem[] {
  const items: FetchItem[] = [];
  const dec = new TextDecoder('utf-8');
  let i = 0;
  while (i < buf.length) {
    while (i < buf.length && buf[i] !== 0x2a) i++; // 0x2a = '*'
    if (i >= buf.length) break;
    const head = dec.decode(buf.subarray(i, Math.min(i + 48, buf.length)));
    if (!/^\* \d+ FETCH \(/.test(head)) { i++; continue; }
    // 定位第一个 '('
    let j = i; while (j < buf.length && buf[j] !== 0x28) j++; // 0x28 = '('
    if (j >= buf.length) break;
    j++;
    let depth = 1;
    const item: FetchItem = { flags: [] };
    while (j < buf.length && depth > 0) {
      const c = buf[j];
      if (c === 0x28) { depth++; j++; continue; }            // '('
      if (c === 0x29) { depth--; j++; if (depth === 0) items.push(item); continue; } // ')'
      if (c === 0x7b) {                                       // '{' 字面量
        let k = j + 1; while (k < buf.length && buf[k] !== 0x7d) k++; // '}'
        const n = parseInt(dec.decode(buf.subarray(j + 1, k)), 10) || 0;
        let litStart = k + 1;
        if (buf[litStart] === 0x0d) litStart++;              // \r
        if (buf[litStart] === 0x0a) litStart++;              // \n
        if (buf[litStart] === 0x2b) litStart++;              // '+' (非同步字面量)
        item.raw = buf.subarray(litStart, litStart + n);
        j = litStart + n;
        if (buf[j] === 0x0d) j++; if (buf[j] === 0x0a) j++;
        continue;
      }
      // 读取一个 token(遇空白/括号/字面量起始结束)
      let k = j;
      while (k < buf.length && buf[k] !== 0x20 && buf[k] !== 0x09 && buf[k] !== 0x0d && buf[k] !== 0x0a
        && buf[k] !== 0x28 && buf[k] !== 0x29 && buf[k] !== 0x7b) k++;
      const tok = dec.decode(buf.subarray(j, k));
      if (tok === 'UID') {
        let s = k; while (s < buf.length && (buf[s] === 0x20 || buf[s] === 0x09 || buf[s] === 0x0d || buf[s] === 0x0a)) s++;
        let e = s; while (e < buf.length && buf[e] !== 0x20 && buf[e] !== 0x09 && buf[e] !== 0x0d && buf[e] !== 0x0a && buf[e] !== 0x28 && buf[e] !== 0x29 && buf[e] !== 0x7b) e++;
        item.uid = parseInt(dec.decode(buf.subarray(s, e)), 10);
        k = e;
      } else if (tok === 'FLAGS') {
        let s = k; while (s < buf.length && buf[s] !== 0x28) s++; // '('
        let d = 1, e = s + 1; while (e < buf.length && d > 0) { if (buf[e] === 0x28) d++; else if (buf[e] === 0x29) d--; e++; }
        item.flags = dec.decode(buf.subarray(s + 1, e - 1)).trim().split(/\s+/).filter(Boolean);
        k = e;
      }
      j = k;
    }
    i = j;
  }
  return items;
}

// ============ 轻量 MIME 解析 ============
interface ParsedMail { from: string; to: string; subject: string; date: string; dateIso: string; body: string; html: string; attachments: string[]; }

function parseMime(raw: Uint8Array): ParsedMail {
  const dec = new TextDecoder('utf-8');
  const text = dec.decode(raw);
  const sep = text.indexOf('\r\n\r\n');
  const sep2 = text.indexOf('\n\n');
  const headerEnd = sep !== -1 ? sep + 4 : (sep2 !== -1 ? sep2 + 2 : text.length);
  const headerText = text.slice(0, headerEnd);
  let bodyText = text.slice(headerEnd);

  // 展开被折行的头(后继行以空格/Tab 开头)
  const unfolded = headerText.replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '');
  const headers = parseHeaders(unfolded);
  const from = decodeRfc2047(headers['from'] || '');
  const to = decodeRfc2047(headers['to'] || '');
  const subject = decodeRfc2047(headers['subject'] || '');
  const dateRaw = headers['date'] || '';
  let dateIso = ''; let date = '';
  if (dateRaw) {
    const dt = new Date(dateRaw);
    if (!isNaN(dt.getTime())) { dateIso = dt.toISOString(); date = formatShanghaiTime(dateIso); }
    else date = dateRaw;
  }

  const ct = headers['content-type'] || 'text/plain';
  const mainCt = ct.split(';')[0].trim().toLowerCase();
  const boundaryM = /boundary="?([^"\n;]+)"?/i.exec(ct);
  let body = ''; let html = ''; const attachments: string[] = [];

  const collect = (partStr: string): void => {
    const psep = partStr.indexOf('\r\n\r\n');
    const psep2 = partStr.indexOf('\n\n');
    const pEnd = psep !== -1 ? psep + 4 : (psep2 !== -1 ? psep2 + 2 : partStr.length);
    const pHeader = partStr.slice(0, pEnd).replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '');
    const pBody = partStr.slice(pEnd);
    const ph = parseHeaders(pHeader);
    const pct = (ph['content-type'] || 'text/plain').split(';')[0].trim().toLowerCase();
    const pBoundary = /boundary="?([^"\n;]+)"?/i.exec(ph['content-type'] || '');
    const disp = (ph['content-disposition'] || '').toLowerCase();
    const fname = extractFilename(ph['content-type'] || '') || extractFilename(disp);
    const cte = (ph['content-transfer-encoding'] || '').trim().toLowerCase();
    const isAttachment = disp.includes('attachment') || !!fname;

    if (pBoundary && /^multipart\//.test(pct)) {
      // 嵌套多部分:递归收集
      for (const sub of splitMimeParts(pBody, pBoundary[1].trim())) collect(sub);
      return;
    }
    const content = decodeBody(pBody, cte, pct);
    if (isAttachment) {
      if (fname) attachments.push(fname);
      else attachments.push('(未命名附件)');
      return;
    }
    if (pct === 'text/plain' && !body) body = content;
    else if (pct === 'text/html' && !html) html = content;
    else if (pct === 'text/plain' && !body) body = content;
  };

  if (/^multipart\//.test(mainCt) && boundaryM) {
    for (const part of splitMimeParts(bodyText, boundaryM[1].trim())) collect(part);
  } else {
    const cte = /content-transfer-encoding:\s*([^\n;]+)/i.exec(unfolded);
    const enc = (cte ? cte[1].trim().toLowerCase() : '');
    body = decodeBody(bodyText, enc, mainCt);
    if (mainCt === 'text/html') html = body;
  }

  if (!body && html) body = htmlToText(html);
  return { from, to, subject, date, dateIso, body, html, attachments };
}

function parseHeaders(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = block.split(/\r?\n/);
  for (const line of lines) {
    const m = /^([A-Za-z0-9-]+)\s*:\s*(.*)$/.exec(line);
    if (m) out[m[1].toLowerCase()] = (out[m[1].toLowerCase()] ? out[m[1].toLowerCase()] + ' ' : '') + m[2].trim();
  }
  return out;
}

function splitMimeParts(body: string, boundary: string): string[] {
  const delim = '--' + boundary;
  const idx = body.indexOf(delim);
  if (idx === -1) return [];
  const after = body.slice(idx + delim.length);
  const closeIdx = after.indexOf('--' + boundary + '--');
  const segments = (closeIdx >= 0 ? after.slice(0, closeIdx) : after).split('--' + boundary);
  return segments
    .map(s => s.replace(/^\r?\n/, ''))            // 去掉段首换行
    .filter(s => s.trim().length > 0);
}

function extractFilename(s: string): string {
  const m = /filename\*?=(?:UTF-8''|")?([^";\r\n]+)"?/i.exec(s);
  if (!m) return '';
  let name = m[1].trim();
  if (/%[0-9A-Fa-f]{2}/.test(name)) {
    try { name = decodeURIComponent(name); } catch { /* ignore */ }
  }
  return name.replace(/^["']|["']$/g, '');
}

function decodeBody(body: string, cte: string, mainCt: string): string {
  try {
    if (cte === 'base64') {
      const clean = body.replace(/[^\nA-Za-z0-9+/=]/g, '');
      const bin = atob(clean);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new TextDecoder('utf-8').decode(bytes);
    }
    if (cte === 'quoted-printable') return decodeQuotedPrintable(body);
    return body;
  } catch {
    return body;
  }
}

function decodeQuotedPrintable(s: string): string {
  const cleaned = s.replace(/=\r?\n/g, '');          // 软换行
  const bytes: number[] = [];
  for (let i = 0; i < cleaned.length; i++) {
    if (cleaned[i] === '=' && i + 2 < cleaned.length) {
      const hex = cleaned.substr(i + 1, 2);
      const code = parseInt(hex, 16);
      if (!isNaN(code)) { bytes.push(code); i += 2; continue; }
    }
    bytes.push(cleaned.charCodeAt(i));
  }
  return new TextDecoder('utf-8').decode(new Uint8Array(bytes));
}

// RFC 2047 解码: =?charset?b?base64?= / =?charset?q?quoted?=
function decodeRfc2047(s: string): string {
  if (!s) return '';
  return s.replace(/\=\?([^?]+)\?([bqBQ])\?([^?]*)\?\=/g, (_m, charset: string, enc: string, data: string) => {
    try {
      if (enc.toLowerCase() === 'b') {
        const bin = atob(data);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return new TextDecoder((charset || 'utf-8').toLowerCase() === 'utf-8' ? 'utf-8' : 'utf-8').decode(bytes);
      }
      // Q 编码
      const txt = data.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_x, h: string) => String.fromCharCode(parseInt(h, 16)));
      return txt;
    } catch {
      return data;
    }
  });
}

// ============ 对外接口 ============

// 列表场景:只拉邮件头(From/To/Subject/Date/已读),不拉正文,避免大批量完整邮件撑爆 Worker 的 CPU/时长上限。
// 完整正文在「邮件详情」打开时由 fetchImapEmailDetail 按需拉取。
export async function fetchImapEmails(env: Env, accountId: string, params: FetchParams): Promise<Email[]> {
  const cfg = await getImapAccountById(env, accountId);
  if (!cfg) throw new Error('该邮箱未配置 IMAP(应用密码)信息');

  const conn = await ImapConnection.connect(cfg);
  try {
    await conn.login(cfg.username, cfg.password);
    await conn.selectInbox();

    // 关键优化: 绝不调用 UID SEARCH ALL / SINCE —— Gmail 会返回收件箱全量 UID 列表(大邮箱下可达数百 KB),
    // 解析的 O(n^2) 直接冲破 Worker 的 CPU 限额(Cloudflare error 1102)。
    // 改为先 STATUS 取邮件总数,再按序列号拉取收件箱「最近若干封」的头部(响应体积只与封数成正比,CPU 恒定且极小),
    // 真正的 to/时间/关键字过滤交给 emailService 在 JS 端完成。
    const total = await conn.statusMessages();
    if (total <= 0) return [];
    const window = Math.min(Math.max((params.limit || 10) * 3, 30), 50);
    const seqStart = Math.max(1, total - window + 1);
    const map = await conn.fetchBySequence(`${seqStart}:*`, 'UID FLAGS BODY.PEEK[HEADER]');
    const emails: Email[] = [];
    for (const [uid, val] of map) {
      const parsed = parseImapHeaders(val.raw);
      emails.push({
        id: `imap:${cfg.id}:${uid}`,
        from: parsed.from,
        to: parsed.to,
        subject: parsed.subject,
        date: parsed.date,
        date_iso: parsed.dateIso,
        body: '',
        html: '',
        unread: !val.flags.includes('\\Seen'),
        attachments: parsed.attachments,
        provider: 'imap',
      });
    }
    return emails;
  } finally {
    try { await conn.logout(); } catch { /* ignore */ }
    try { await conn.close(); } catch { /* ignore */ }
  }
}

// 详情场景:按需拉取单封完整邮件(含正文/HTML/附件),供前端「邮件详情」打开时调用
export async function fetchImapEmailDetail(env: Env, accountId: string, uid: number): Promise<Email> {
  const cfg = await getImapAccountById(env, accountId);
  if (!cfg) throw new Error('该邮箱未配置 IMAP(应用密码)信息');
  const conn = await ImapConnection.connect(cfg);
  try {
    await conn.login(cfg.username, cfg.password);
    await conn.selectInbox();
    const map = await conn.fetchUids([uid], 'UID FLAGS BODY.PEEK[]');
    const val = map.get(uid);
    if (!val) throw new Error('未找到该邮件或已删除');
    const parsed = parseMime(val.raw);
    return {
      id: `imap:${cfg.id}:${uid}`,
      from: parsed.from,
      to: parsed.to,
      subject: parsed.subject,
      date: parsed.date,
      date_iso: parsed.dateIso,
      body: parsed.body,
      html: parsed.html,
      unread: !val.flags.includes('\\Seen'),
      attachments: parsed.attachments,
      provider: 'imap',
    };
  } finally {
    try { await conn.logout(); } catch { /* ignore */ }
    try { await conn.close(); } catch { /* ignore */ }
  }
}

// 仅解析邮件头(用于列表,避免加载正文)
function parseImapHeaders(raw: Uint8Array): { from: string; to: string; subject: string; date: string; dateIso: string; attachments: string[] } {
  const headerText = new TextDecoder('utf-8').decode(raw);
  const h = parseHeaders(headerText.replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, ''));
  const from = decodeRfc2047(h['from'] || '');
  const to = decodeRfc2047(h['to'] || '');
  const subject = decodeRfc2047(h['subject'] || '');
  const dateRaw = h['date'] || '';
  let dateIso = ''; let date = '';
  if (dateRaw) {
    const dt = new Date(dateRaw);
    if (!isNaN(dt.getTime())) { dateIso = dt.toISOString(); date = formatShanghaiTime(dateIso); }
    else date = dateRaw;
  }
  // 头部无法可靠列出附件名,仅在 Content-Type 显式带附件时给一个提示
  const ct = (h['content-type'] || '').toLowerCase();
  const attachments = /multipart\/mixed|multipart\/related/i.test(ct) ? ['(含附件)'] : [];
  return { from, to, subject, date, dateIso, attachments };
}

// 标记已读(按发件人 + 主题匹配)
export async function markImapRead(env: Env, accountId: string, sender?: string, subject?: string): Promise<number> {
  const cfg = await getImapAccountById(env, accountId);
  if (!cfg) return 0;
  const conn = await ImapConnection.connect(cfg);
  try {
    await conn.login(cfg.username, cfg.password);
    await conn.selectInbox();
    const parts: string[] = [];
    if (sender) {
      const m = /<([^>]+)>/.exec(sender);
      const addr = m ? m[1] : sender;
      parts.push(`FROM ${imapQuote(addr)}`);
    }
    if (subject) parts.push(`SUBJECT ${imapQuote(subject.replace(/"/g, ''))}`);
    const criteria = parts.length ? parts.join(' ') : 'ALL';
    const uids = await conn.searchUids(criteria);
    if (!uids.length) return 0;
    await conn.storeSeen(uids);
    return uids.length;
  } finally {
    try { await conn.logout(); } catch { /* ignore */ }
    try { await conn.close(); } catch { /* ignore */ }
  }
}

// 仅测试连接是否可用(绑定前校验 / 授权状态探测)
export async function testImapConnection(cfg: ImapConnConfig): Promise<true> {
  const conn = await ImapConnection.connect(cfg);
  try {
    await conn.login(cfg.username, cfg.password);
    await conn.selectInbox();
    return true;
  } finally {
    try { await conn.logout(); } catch { /* ignore */ }
    try { await conn.close(); } catch { /* ignore */ }
  }
}

// 授权状态探测:能连上并登录即视为有效
export async function checkImapAuth(env: Env, accountId: string): Promise<{ ok: boolean; reason?: string }> {
  const cfg = await getImapAccountById(env, accountId);
  if (!cfg) return { ok: false, reason: '未配置 IMAP 信息' };
  try {
    await testImapConnection(cfg);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: (e as Error).message || '连接失败' };
  }
}
