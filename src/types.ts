// 全局类型定义

// Cloudflare 绑定资源
export interface Env {
  DB: D1Database;
  KV: KVNamespace;
  ASSETS: Fetcher;
  // OAuth 凭据 (通过 wrangler secret 设置)
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  MS_CLIENT_ID: string;
  MS_CLIENT_SECRET: string;
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
  mail_accounts: SafeMailAccount[];
  alias: Alias | null;
  created_at: string;
}

// 邮箱账号(对外脱敏,不含 token)
export interface SafeMailAccount {
  id: string;
  provider: 'gmail' | 'outlook';
  email: string;
  is_public: boolean;
  created_at: string;
  token_masked: string;       // 仅前4后4
}

// 邮箱账号(含原始 token,内部用)
export interface MailAccountRaw {
  id: string;
  user_id: string;
  provider: 'gmail' | 'outlook';
  email: string;
  access_token: string;        // 已解密
  refresh_token: string;       // 已解密
  token_expires_at: string;
  is_public: boolean;
  created_at: string;
}

export interface Alias {
  mail_account_id: string;
  label: string;
  full: string;
  updated_at?: string;
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
  provider?: 'gmail' | 'outlook';
}

// 邮件查询参数
export interface FetchParams {
  to?: string;
  sender?: string;
  subject?: string;
  body?: string;
  keyword?: string;
  unseen?: boolean;
  start_time?: string;
  end_time?: string;
  limit: number;
  mail_account_id?: string;    // Web 调用可选指定
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
