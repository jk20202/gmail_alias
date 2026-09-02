// Minimal RFC822 + MIME parser —— 专门为 webhook 推送做的极简实现
//
// 设计目标(明确取舍):
//   1) 在 Worker 里能跑: 不依赖 npm 包,只使用 Web 标准 API (TextDecoder/atob)
//   2) 单封 <50KB 邮件能在 5ms 内解析完,免费套餐 10ms CPU 内有余量
//   3) 失败安全: 任何步骤异常都返回 status=-1,绝不抛出阻塞入库流程
//
// 不做的事(由前端 postal-mime 接管):
//   - 完整 RFC2231 参数编码
//   - nested multipart (multipart/related 里的 multipart/alternative)
//   - message/rfc822 附件递归
//   - HTML 渲染 / 转义
//
// 已知限制(主动放弃):
//   - multipart 嵌套深度 > 2 层时只解析到第二层
//   - 非 UTF-8 charset 尽力猜测,不保证正确解码
//   - 单 part 大小 > maxChars 直接截断,不解析剩余内容

// ===== 解码器 =====

// Quoted-Printable 解码(=XX 转字节,= 后跟 \r\n 表示软换行)
function decodeQuotedPrintable(input: string): string {
  // 移除软换行 =\r\n
  const cleaned = input.replace(/=\r\n/g, '').replace(/=\n/g, '');
  // =XX -> char
  const bytes: number[] = [];
  for (let i = 0; i < cleaned.length; i++) {
    const c = cleaned[i];
    if (c === '=' && i + 2 < cleaned.length) {
      const hex = cleaned.slice(i + 1, i + 3);
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        bytes.push(parseInt(hex, 16));
        i += 2;
        continue;
      }
    }
    bytes.push(cleaned.charCodeAt(i) & 0xff);
  }
  return decodeBytes(bytes);
}

// base64 解码(忽略空白与 pad)
function decodeBase64(input: string): string {
  const clean = input.replace(/[\s\r\n]+/g, '');
  try {
    const bin = atob(clean);
    const bytes: number[] = [];
    for (let i = 0; i < bin.length; i++) bytes.push(bin.charCodeAt(i));
    return decodeBytes(bytes);
  } catch {
    return '';
  }
}

function decodeBytes(bytes: number[]): string {
  // 优先 UTF-8 (TextDecoder 自动处理 BOM),失败回退 latin1
  try {
    const td = new TextDecoder('utf-8', { ignoreBOM: false, fatal: false });
    return td.decode(new Uint8Array(bytes));
  } catch {
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return s;
  }
}

// ===== 头解析 =====

// 把 Content-Type 字符串拆成 (主类型/子类型, params)
// 例: multipart/alternative; boundary="abc"; charset=utf-8
function parseContentType(header: string | null): { mime: string; params: Record<string, string> } {
  const fallback = { mime: '', params: {} as Record<string, string> };
  if (!header) return fallback;
  const parts = header.split(';').map(s => s.trim());
  const mime = (parts.shift() || '').toLowerCase();
  const params: Record<string, string> = {};
  for (const p of parts) {
    const eq = p.indexOf('=');
    if (eq < 0) continue;
    const k = p.slice(0, eq).trim().toLowerCase();
    let v = p.slice(eq + 1).trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    params[k] = v;
  }
  return { mime, params };
}

// RFC2045/RFC2046 里 boundary 的真实 key 就是 "boundary",这里取个简短别名避免上层重复写
function boundaryOf(p: { params: Record<string, string> }): string | undefined {
  return p.params.boundary;
}

// 把多行头合并为单行(处理 RFC822 续行: 行首空格或制表符属于上一行的延续)
function unfoldHeaders(raw: string): string {
  return raw.replace(/\r?\n[ \t]+/g, ' ');
}

// ===== 主体解析 =====

interface ParseResult { body: string; status: 1 | -1 }

// 从 raw 字节里提取 text/plain 内容;成功返回 status=1,失败 status=-1
//
// 输入限制: 不要把过大的 raw 传进来 —— > 200KB 应在调用方截断,免得 Worker 超时
export function extractPlainText(raw: ArrayBuffer, maxChars = 4000): ParseResult {
  try {
    // 先把整个 raw 当成 UTF-8 文本解出来(头解码只需要 ASCII, body 部分会再二次解码)
    const td = new TextDecoder('utf-8', { ignoreBOM: false, fatal: false });
    const text = td.decode(new Uint8Array(raw));
    // 分离头和体:第一个空行(\r\n\r\n 或 \n\n)之后即为体
    const split = text.match(/\r?\n\r?\n/);
    if (!split || split.index === undefined) return { body: '', status: -1 };
    const headerPart = text.slice(0, split.index);
    const bodyPart = text.slice(split.index + split[0].length);
    const headers = unfoldHeaders(headerPart);
    // 找 Content-Type
    const ctMatch = headers.match(/^content-type\s*:\s*(.*)$/im);
    const ct = ctMatch ? ctMatch[1].trim() : '';
    const { mime, params } = parseContentType(ct);
    // multipart: 按 boundary 切分再递归
    // boundaryOf 返回 undefined 时(损坏的 Content-Type)直接走单 part 路径,避免上层崩
    const bnd = boundaryOf({params});
    if (mime.startsWith('multipart/') && bnd) {
      return extractFromMultipart(bodyPart, bnd, maxChars);
    }
    // 单 part: 找 Content-Transfer-Encoding
    const cteMatch = headers.match(/^content-transfer-encoding\s*:\s*(.*)$/im);
    const cte = cteMatch ? cteMatch[1].trim().toLowerCase() : '7bit';
    if (mime === 'text/plain') {
      const decoded = decodePartBody(bodyPart, cte);
      return { body: clip(decoded, maxChars), status: 1 };
    }
    // text/html: 推到下一层(htmlToText 由 webhook 处理)
    if (mime === 'text/html') {
      const decoded = decodePartBody(bodyPart, cte);
      return { body: clip(decoded, maxChars), status: 1 };
    }
    // 其他类型(message/*, application/*): 视为无 text/plain
    return { body: '', status: -1 };
  } catch {
    return { body: '', status: -1 };
  }
}

function extractFromMultipart(body: string, boundary: string, maxChars: number): ParseResult {
  // --boundary 切分 part,边界行必须出现在行首
  // 注意 boundary 在 raw 头里通常带引号,这里已 strip 过
  const delim = '--' + boundary;
  // 用 split 切分 part 块
  const parts = body.split(delim).slice(1); // 丢弃首段(空/前置内容)
  for (const part of parts) {
    // part 以 \r\n 开头
    const trimmed = part.replace(/^\r?\n/, '');
    // 终止 boundary: "--"
    if (trimmed.startsWith('--')) break;
    // 找 part 内的头体分隔
    const split = trimmed.match(/\r?\n\r?\n/);
    if (!split || split.index === undefined) continue;
    const partHeader = trimmed.slice(0, split.index);
    const partBody = trimmed.slice(split.index + split[0].length);
    const ctMatch = partHeader.match(/^content-type\s*:\s*(.*)$/im);
    const ct = ctMatch ? ctMatch[1].trim() : '';
    const { mime, params } = parseContentType(ct);
    const cteMatch = partHeader.match(/^content-transfer-encoding\s*:\s*(.*)$/im);
    const cte = cteMatch ? cteMatch[1].trim().toLowerCase() : '7bit';
    // 优先 text/plain,跳过 text/html(在 multipart/alternative 里两个都有,先取纯文本)
    if (mime === 'text/plain') {
      const decoded = decodePartBody(partBody, cte);
      return { body: clip(decoded, maxChars), status: 1 };
    }
    if (mime.startsWith('multipart/') && boundaryOf({params})) {
      // 嵌套(常见 multipart/mixed -> multipart/alternative -> text/plain)
      const nested = extractFromMultipart(partBody, boundaryOf({params}) as string, maxChars);
      if (nested.status === 1) return nested;
      continue;
    }
  }
  // 没找到 text/plain,降级: 第一个 text/html 也行(webhook 那边会 htmlToText)
  for (const part of parts) {
    const trimmed = part.replace(/^\r?\n/, '');
    if (trimmed.startsWith('--')) break;
    const split = trimmed.match(/\r?\n\r?\n/);
    if (!split || split.index === undefined) continue;
    const partHeader = trimmed.slice(0, split.index);
    const partBody = trimmed.slice(split.index + split[0].length);
    const ctMatch = partHeader.match(/^content-type\s*:\s*(.*)$/im);
    const ct = ctMatch ? ctMatch[1].trim() : '';
    const { mime } = parseContentType(ct);
    const cteMatch = partHeader.match(/^content-transfer-encoding\s*:\s*(.*)$/im);
    const cte = cteMatch ? cteMatch[1].trim().toLowerCase() : '7bit';
    if (mime === 'text/html') {
      const decoded = decodePartBody(partBody, cte);
      return { body: clip(decoded, maxChars), status: 1 };
    }
  }
  return { body: '', status: -1 };
}

function decodePartBody(body: string, cte: string): string {
  if (cte === 'quoted-printable') return decodeQuotedPrintable(body);
  if (cte === 'base64') return decodeBase64(body);
  // 7bit / 8bit / 二进制 都直接当作 UTF-8/latin1 文本
  return body;
}

function clip(s: string, maxChars: number): string {
  if (!s) return '';
  const t = s.replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').trim();
  if (t.length <= maxChars) return t;
  return t.slice(0, maxChars) + `\n\n… (正文过长已截断,共 ${t.length} 字)`;
}