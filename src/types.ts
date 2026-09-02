// 全局类型定义
//
// v2 (cloudflarev2): 收信方式改为「各邮箱设置自动转发 -> Cloudflare Email Routing -> Email Worker」。
// 因此不再需要 OAuth / IMAP 凭据,绑定邮箱只需填主邮箱地址即可。

// Cloudflare 绑定资源
export interface Env {
  DB: D1Database;
  KV: KVNamespace;
  ASSETS: Fetcher;
  EMAIL_RAW: R2Bucket;         // 原始邮件(.eml)对象存储
  // 收信域名:用于为每个邮箱拼接专属转发地址,如 recv.example.com
  // 生成结果形如 f-a1b2c3@recv.example.com,用户需在各邮箱里把邮件转发到该地址
  RECV_DOMAIN?: string;
  // 统一转发地址:全站**唯一**的收信地址(如 alle@jkf.kdns.fr)。
  // 所有邮箱都在原邮箱设置里把收到的邮件转发到这个地址,系统按收件头自动归属。
  // 一旦配置,就不再为单个邮箱生成任何 f-xxxx 形式的专属地址。
  UNIFIED_FORWARD_ADDRESS?: string;
  // 兜底账号:所有归属失败的邮件都交给这个 account_id(单人单域场景下"固定写死一个收件箱")
  // 若为空,则未匹配邮件会被拒收并记录到 email_unmatched。
  CATCHALL_ACCOUNT_ID?: string;
  // 安全密钥
  JWT_SECRET: string;
  ENCRYPT_KEY: string;        // 32字节 hex(v2 不再加密 OAuth/IMAP 凭据,保留供其它加密用途)
  BASE_URL: string;            // Worker 部署地址,用于拼接 raw 下载链接
  // 默认管理员
  ADMIN_USERNAME: string;
  ADMIN_PASSWORD: string;
  // v2 已废弃 OAuth 授权,以下变量保留仅为兼容旧部署,可留空
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  MS_CLIENT_ID?: string;
  MS_CLIENT_SECRET?: string;
}

// 用户(对外脱敏)
export interface SafeUser {
  id: string;
  username: string;
  api_key: string;
  is_admin: boolean;
  disabled: boolean;          // 是否被管理员禁用
  mail_accounts: SafeMailAccount[];
  alias: Alias | null;        // 兼容字段:当前主别名(取第一个活跃别名)
  active_alias_count: number; // 当前生效中的别名数量
  created_at: string;
  last_login: string | null;  // 上次登录时间(ISO),从未登录为 null
}

// 邮箱账号(对外脱敏)
export interface SafeMailAccount {
  id: string;
  provider: 'gmail' | 'outlook' | 'imap' | 'forward';
  email: string;
  is_public: boolean;          // 是否公开共享(公开后其他用户可使用该邮箱/其别名)
  created_at: string;
  token_masked: string;       // 仅前4后4(v2 无 token,返回空串占位)
  alias_template?: string | null;  // 别名生成规则模板({local}/{domain}/{label})
  notes?: string;                  // 用户备注
  // v2 新增:
  forward_address?: string | null; // 专属转发地址(用户在原邮箱设置转发到该地址)
  supports_alias?: boolean;        // 是否支持别名;默认 false,为 false 时只能直接选中该邮箱
  // 兼容旧字段(v2 未使用)
  imap_host?: string | null;
  imap_port?: number | null;
}

// 邮箱账号(含原始 token,内部用)
export interface MailAccountRaw {
  id: string;
  user_id: string;
  provider: 'gmail' | 'outlook' | 'imap' | 'forward';
  email: string;
  access_token: string;
  refresh_token: string;
  token_expires_at: string;
  is_public: boolean;
  created_at: string;
  // v2 新增
  forward_address?: string | null;
  supports_alias?: number | null;   // SQLite 返回 0/1
  alias_template?: string | null;
  imap_host?: string | null;
  imap_port?: number | null;
  imap_user?: string | null;
  imap_pass?: string | null;
}

// 兼容旧结构:单别名
export interface Alias {
  mail_account_id: string;
  label: string;
  full: string;
  updated_at?: string;
}

// ============ 多别名(每用户最多 5 个同时生效) ============
export type AliasStatus = 'active' | 'expired' | 'archived';

export interface UserAlias {
  id: string;
  user_id: string;
  mail_account_id: string;
  label: string;
  full: string;
  is_favorite: boolean;
  status: AliasStatus;
  expires_at: string | null;      // active 时有效
  last_used_at: string;
  created_at: string;
  // 关联查询附带(展示用)
  email?: string;                 // 主邮箱地址
  provider?: 'gmail' | 'outlook' | 'imap' | 'forward';
  remain_ms?: number;             // 剩余有效毫秒(active 才有)
}

// ============ 已接收邮件(D1 emails 表) ============
export interface EmailRow {
  id: string;
  account_id: string;
  alias_id: string | null;        // 命中的别名(直接投到主邮箱时为 NULL)
  message_id: string | null;      // Message-ID,用于去重
  subject: string | null;
  from_name: string | null;
  from_address: string | null;
  delivered_to: string | null;    // 实际命中的收件地址(原始收件人)
  recipient: string | null;       // To 原文
  cc: string | null;
  sent_at: number;                // UTC 秒级时间戳
  size: number;                   // raw 字节数
  raw_key: string | null;         // R2 对象 key
  has_attachments: number;        // 0/1(仅头部推断,精确列表由前端解析 raw 得出)
  body_text: string | null;       // v9: 解析后的 text/plain 正文(限 ~4KB),webhook push 直接读这字段
  body_status: number;            // v9: 0=未解析/跳过 1=成功 -1=失败
  read: number;                   // 0 未读 / 1 已读
  created_at: string;
}

// 邮件对象(对前端/API 输出)
export interface Email {
  id: string;
  account_id: string;          // 归属邮箱 ID(前端按邮箱查询/标记已读需要)
  from: string;
  to: string;
  subject: string;
  date: string;                // 显示用 (YYYY-MM-DD HH:MM:SS)
  date_iso: string;
  body: string;
  html: string;
  unread: boolean;
  attachments: string[];       // 附件文件名列表(用于模糊搜索/展示)
  provider?: 'gmail' | 'outlook' | 'imap' | 'forward';
  alias?: string;              // 命中的别名地址(多别名聚合时使用)
  // v2: 原始邮件下载地址(前端下载后用 postal-mime 在浏览器解析正文/附件)
  raw_url?: string;
  size?: number;
}

// 邮件查询参数
export interface FetchParams {
  to?: string;
  sender?: string;
  subject?: string;
  body?: string;
  keyword?: string;            // 兼容旧参数
  q?: string;                  // 统一模糊搜索: 发件人/收件人/主题
  unseen?: boolean;
  start_time?: string;
  end_time?: string;
  limit: number;
  offset?: number;             // 无限滚动偏移量(0-based)
  mail_account_id?: string;    // Web 调用可选指定
  alias_id?: string;           // 指定查询某个别名
  all_aliases?: boolean;       // 聚合查询当前用户全部生效别名
}

// Webhook 订阅目标: 一订阅多邮箱 (2026-09 改造,v3 重定义语义 2026-09-02)
//
//   scope = 'alias_all' → "整个邮箱" (推送该主邮箱下所有收信)
//       - 别名收的: 用别名地址身份推过来(用户能看到是哪个别名收到)
//       - 主邮箱直接收的: 用主邮箱地址身份推过来
//       - 不管别名是别人公开的、是否还存活 —— 只要收信,就推
//       - 他人公开邮箱**不允许**选此项 (你不是邮箱主,无权监听主邮箱直收)
//
//   scope = 'account' → "别名邮箱" (只推自己生成的、还活着的别名收信)
//       - 仅匹配: 收件地址 ∈ (webhook 订阅者的 user_id 在该主邮箱下生成的、状态=active 的别名集合)
//       - 不推主邮箱直接收的
//       - 他人公开邮箱**只能**选此项 (权限分离硬约束)
//
// 已废弃: alias(指定别名) —— 用户已明确不需要此功能
export interface WebhookTarget {
  mail_account_id: string;
  // 兼容列表展示用:含邮箱地址和归属(自己/他人),不返回他人 token 等敏感字段
  mail_account_email?: string;
  is_own?: boolean;
  // 注意:这是数据库里的枚举值;前端 UI 应展示为「整个邮箱 / 别名邮箱」对应别名
  //   alias_all → "整个邮箱"
  //   account   → "别名邮箱"
  scope: 'alias_all' | 'account';
}

// Webhook 订阅
// 一条 webhook 订阅 = 一个回调 URL + 一组监听的邮箱(targets)
// targets 取代旧版的单 mail_account_id / scope 字段;读取时旧 webhooks 表行做
// fallback 兼容(老数据自动生成单元素 targets)。
export interface Webhook {
  id: string;
  user_id: string;
  url: string;
  secret: string | null;
  events: string;              // 逗号分隔: new_mail,unread
  format: string;              // card | markdown | text | json
  is_active: boolean;
  created_at: string;
  targets: WebhookTarget[];    // 监听的邮箱列表(可多个)
}

// Webhook 投递记录(用于前端排查「测试/推送显示成功但飞书没收到」之类的问题)
export interface WebhookDelivery {
  id: number;
  webhook_id: string;
  payload: string;
  status: number;              // HTTP 状态码(0 表示网络异常)
  response: string;            // 平台原始响应截断
  success: boolean;            // HTTP 2xx 视为成功
  created_at: string;
}

// 统一响应
export interface ApiResponse<T = unknown> {
  code: number;
  msg: string;
  data: T | null;
}

// OAuth state (KV 存储) —— v2 已不使用 OAuth,保留类型以兼容
export interface OAuthState {
  user_id: string;
  provider: 'gmail' | 'outlook';
  created_at: number;
}
