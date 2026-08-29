// 全局类型定义

// Cloudflare 绑定资源
export interface Env {
  DB: D1Database;
  KV: KVNamespace;
  ASSETS: Fetcher;
  // OAuth 凭据 (通过 wrangler secret 设置,也可在管理后台写入 D1 settings,后者优先)
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  // 微软:默认走 Thunderbird 公共客户端(无需 secret),MS_CLIENT_ID 可覆盖,MS_CLIENT_SECRET 已废弃保留兼容
  MS_CLIENT_ID?: string;
  MS_CLIENT_SECRET?: string;
  // 安全密钥
  JWT_SECRET: string;
  ENCRYPT_KEY: string;        // 32字节 hex,用于 AES-GCM 加密 refresh_token
  BASE_URL: string;            // Worker 部署地址,用于 OAuth 回调
  // 默认管理员
  ADMIN_USERNAME: string;
  ADMIN_PASSWORD: string;
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
}

// 邮箱账号(对外脱敏,不含 token)
export interface SafeMailAccount {
  id: string;
  provider: 'gmail' | 'outlook' | 'imap';
  email: string;
  is_public: boolean;
  created_at: string;
  token_masked: string;       // 仅前4后4
  alias_template?: string | null;  // 别名生成规则模板({local}/{domain}/{label})
  notes?: string;                  // 用户备注
  imap_host?: string | null;       // IMAP 连接信息(仅 IMAP 账号有,供编辑预填,不含密码)
  imap_port?: number | null;
}

// 邮箱账号(含原始 token,内部用)
export interface MailAccountRaw {
  id: string;
  user_id: string;
  provider: 'gmail' | 'outlook' | 'imap';
  email: string;
  access_token: string;        // 已解密
  refresh_token: string;       // 已解密
  token_expires_at: string;
  is_public: boolean;
  created_at: string;
  // IMAP(应用密码)绑定专用字段
  imap_host?: string | null;
  imap_port?: number | null;
  imap_user?: string | null;
  imap_pass?: string | null;   // 已加密
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
  provider?: 'gmail' | 'outlook' | 'imap';
  remain_ms?: number;             // 剩余有效毫秒(active 才有)
}

// 邮件对象
export interface Email {
  id: string;
  from: string;
  to: string;
  subject: string;
  date: string;                // 显示用 (YYYY-MM-DD HH:MM:SS)
  date_iso: string;
  body: string;
  html: string;
  unread: boolean;
  attachments: string[];       // 附件文件名列表(用于模糊搜索/展示)
  provider?: 'gmail' | 'outlook' | 'imap';
  alias?: string;              // 命中的别名地址(多别名聚合时使用)
}

// 邮件查询参数
export interface FetchParams {
  to?: string;
  sender?: string;
  subject?: string;
  body?: string;
  keyword?: string;            // 兼容旧参数
  q?: string;                  // 统一模糊搜索: 发件人/收件人/主题/正文/HTML/附件
  unseen?: boolean;
  start_time?: string;
  end_time?: string;
  limit: number;
  offset?: number;             // 无限滚动偏移量(0-based)
  mail_account_id?: string;    // Web 调用可选指定
  alias_id?: string;           // 指定查询某个别名
  all_aliases?: boolean;       // 聚合查询当前用户全部生效别名
}

// Webhook 订阅
export interface Webhook {
  id: string;
  user_id: string;
  mail_account_id: string;
  target_alias: string | null;
  url: string;
  secret: string | null;
  events: string;              // 逗号分隔: new_mail,unread
  format: string;              // card | markdown | text | json
  is_active: boolean;
  created_at: string;
}

// 统一响应
export interface ApiResponse<T = unknown> {
  code: number;
  msg: string;
  data: T | null;
}

// OAuth state (KV 存储)
export interface OAuthState {
  user_id: string;              // 绑定到哪个用户
  provider: 'gmail' | 'outlook';
  created_at: number;
}
