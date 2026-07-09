# Mail Alias Cloudflare Edition

部署在 **Cloudflare Workers** 上的别名邮箱管理系统。基于 TypeScript + D1 + KV，支持 **Gmail / Outlook / Hotmail** OAuth 绑定、API 调用查询邮件、**Webhook 推送**。

> 这是 Python + IMAP 版本（main 分支）的姊妹项目，专为 Cloudflare 免费托管重写。
> **不再依赖 IMAP / SMTP**，全部走官方 REST API（Gmail API + Microsoft Graph API）。

## 功能特性

- ✅ **多邮箱平台 OAuth 绑定**：Gmail + Outlook/Hotmail/Live（统一走 Microsoft Graph）
- ✅ **微软 Device Code 授权**：采用 Device Code Flow，**无需 redirect_uri、无需自建 Azure 应用、无需 client_secret**，用户在新页面输入 user_code 完成授权，完美绕过公共客户端回调地址不匹配问题
- ✅ **授权状态探测**：邮箱列表实时显示每个邮箱的授权状态（已授权/未授权），支持一键重新授权（upsert 更新 token，不产生重复记录）
- ✅ **别名邮箱管理**：基于 `+` 号别名规则，每用户一个别名，别名地址一键复制
- ✅ **API Key 调用**：32 位密钥，无过期，外部程序直接调用
- ✅ **Webhook 推送**：支持**直接推送到飞书/钉钉群机器人**（自动转换消息格式），也支持原始 JSON 推送到自建服务；HMAC-SHA256 签名验真
- ✅ **多用户**：管理员 + 普通用户，注册开关，管理员可编辑/禁用用户
- ✅ **邮箱共享**：用户可将自有邮箱设为公开，其他用户可通过公开邮箱创建自己的别名
- ✅ **使用统计**：30 天保留，按用户/邮箱统计
- ✅ **Web 界面**：响应式中文界面，API 文档左右分栏布局
- ✅ **零服务器**：全 Cloudflare 免费层（Workers 10 万请求/天 + D1 5GB + KV）

## 与 Python 版本的对比

| 维度 | Python 版本 (main 分支) | Cloudflare 版本 (本分支) |
|------|------------------------|------------------------|
| 运行时 | VPS / 服务器 | Cloudflare Workers |
| 语言 | Python + FastAPI | TypeScript |
| 邮件协议 | IMAP（TCP 993） | REST API (HTTPS) |
| 凭据模型 | 应用专用密码 | OAuth 2.0 + refresh_token |
| 数据存储 | 本地 JSON 文件 | D1 (SQLite) + KV |
| 支持邮箱 | 仅 Gmail | Gmail + Outlook/Hotmail |
| Webhook | ❌ | ✅ |
| 部署成本 | 需 VPS（约 5$/月起） | 免费 |

## 架构

```
┌─────────────────────────── Cloudflare ───────────────────────────┐
│                                                                  │
│  Browser ── HTTPS ──> Worker (TS)  ──┬──> D1 (SQLite)            │
│       │                              │     (用户/邮箱/日志/Webhook)│
│       │                              │                            │
│   [Web UI]                           ├──> KV (Session 缓存)       │
│   (static/index.html)                │                            │
│                                      ├──> Gmail API (HTTPS)      │
│   OAuth 授权 ─────────────────────────┴──> Microsoft Graph API    │
│                                                                  │
│   外部程序 (Python/curl) ──> /api/email/fetch?key=xxx            │
│                                                                  │
│   Webhook 推送 <── Worker 主动拉取邮件后 POST 到你的服务          │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

## 文件结构

```
.
├── README.md
├── package.json
├── wrangler.toml              # Cloudflare Workers 配置
├── tsconfig.json
├── schema.sql                 # D1 数据库 schema
├── .gitignore
├── src/
│   ├── index.ts              # Worker 入口 + 路由分发 + CORS
│   ├── types.ts              # 全局类型定义
│   ├── utils.ts             # 加密/哈希/时间/Web Crypto 工具
│   ├── db.ts                # D1 数据访问层 (CRUD)
│   ├── oauth.ts             # OAuth 流程 (Google + Microsoft)
│   ├── emailService.ts      # 邮件查询统一封装 (Gmail API + Graph API)
│   ├── webhook.ts           # Webhook 推送服务
│   └── routes.ts            # 所有 HTTP 路由处理
└── static/
    └── index.html           # Web 界面 (单文件 HTML+CSS+JS)
```

## 快速部署

### 1. 前置准备

**注册 Google Cloud 项目**（用于 Gmail）：
1. 访问 https://console.cloud.google.com/
2. 新建项目 → 启用 **Gmail API**
3. 配置 OAuth 同意屏幕 → 类型选「外部」→ 添加范围 `gmail.readonly` 和 `userinfo.email`
4. 凭据 → 创建 OAuth 客户端 ID → 类型 Web → 添加重定向 URI：`https://你的-worker.workers.dev/oauth/callback`
5. 拿到 `Client ID` 和 `Client Secret`

**微软邮箱授权**（用于 Outlook/Hotmail，**无需任何配置**）：

> 系统采用 **Device Code Flow** 授权微软邮箱，**无需注册 Azure 应用、无需 redirect_uri、无需 client_secret**。
> 用户在「我的账户」点击「绑定 Outlook/Hotmail」后，弹窗显示 `user_code`，用户在新页面登录微软账号并输入代码即可完成授权。
> 此方案完美绕过 Thunderbird 公共客户端 redirect_uri 不匹配的问题。
>
> 仅当需要改用自注册应用时，才用 `wrangler secret put MS_CLIENT_ID` 覆盖默认的 client_id。

### 2. 创建 Cloudflare 账号与 API Token

1. 访问 https://dash.cloudflare.com/ 注册账号（免费）
2. 进入「Workers 和 Pages」→ 首次使用会要求设置子域名（如 `your-name.workers.dev`）
3. 创建 API Token（用于命令行部署）：
   - 访问 https://dash.cloudflare.com/profile/api-tokens
   - 点击「创建令牌」→ 选择模板「编辑 Cloudflare Workers」
   - 复制生成的 Token（只显示一次，妥善保存）

### 3. 创建 Cloudflare 资源

```bash
# 安装 Wrangler CLI
npm install -g wrangler

# 方式一: 浏览器授权登录
wrangler login
# 方式二: 用 API Token (CI/非交互环境推荐)
# export CLOUDFLARE_API_TOKEN="你的token"

# 克隆 cloudflare 分支
git checkout cloudflare
npm install

# 创建 D1 数据库
wrangler d1 create mail_alias
# 命令会输出 database_id,复制它

# 创建 KV 命名空间
wrangler kv namespace create KV
# 命令会输出 namespace id,复制它

# 初始化数据库 schema (远程生产库)
wrangler d1 execute mail_alias --remote --file=./schema.sql
# 本地开发也初始化一份(可选):
wrangler d1 execute mail_alias --local --file=./schema.sql
```

### 4. 配置 wrangler.toml

编辑 `wrangler.toml`，替换以下内容：

```toml
# D1 数据库 ID (第3步创建时输出)
database_id = "上一步复制的 database_id"

# KV 命名空间 ID (第3步创建时输出)
[[kv_namespaces]]
binding = "KV"
id = "上一步复制的 KV namespace id"

# 静态资源配置: run_worker_first=true 确保所有请求先经过 Worker
# 由 Worker 控制 HTML 缓存头(no-cache),防止 CDN 缓存旧版前端导致登录失效
[assets]
directory = "./static"
binding = "ASSETS"
run_worker_first = true

# 管理员账号 (首次部署时初始化用,务必改成自己的强密码!)
# 部署成功后立即登录并在「我的账户」修改密码
ADMIN_USERNAME = "admin"
ADMIN_PASSWORD = "你的强密码"   # ← 务必修改,切勿保留默认值
```

> ⚠️ **安全提示**：`ADMIN_PASSWORD` 是首次部署时初始化管理员账号用的，部署后请立即登录系统在「我的账户」修改密码。如果后续要重置密码，可直接在 D1 数据库更新 users 表的 password 字段（SHA256 哈希值）。

> 💡 **缓存策略**：`run_worker_first = true` 让所有请求先经过 Worker 脚本，由 Worker 对 HTML 响应设置 `Cache-Control: no-cache` 头。这样每次部署后用户都能立即加载最新前端代码，不会出现「点击登录无反应」「页面不更新」等缓存问题。请勿删除此配置项。

### 5. 注入 Secrets（敏感配置）

Secrets 不会写入代码或 wrangler.toml，单独加密存储，更安全：

```bash
# Gmail OAuth (必填,用于 Gmail 授权)
wrangler secret put GOOGLE_CLIENT_ID
wrangler secret put GOOGLE_CLIENT_SECRET

# 微软授权无需任何配置 (Device Code Flow,内置公共客户端)

# 系统密钥
wrangler secret put JWT_SECRET              # 随便输个长字符串(用于Session签名)
wrangler secret put ENCRYPT_KEY             # 32字节hex,用于加密refresh_token
                                            # 生成命令: openssl rand -hex 32
wrangler secret put BASE_URL                # 你的 Worker 地址,如 https://mail-alias.your-name.workers.dev
```

### 6. 部署到 Cloudflare

```bash
# 部署到生产环境
wrangler deploy

# 部署成功后会输出:
#   https://mail-alias.your-name.workers.dev
```

### 7. 验证与首次配置

1. 访问部署输出的 URL
2. 用第4步设置的管理员账号密码登录
3. **立即进入「我的账户」修改密码**（不要长期使用初始密码）
4. 进入「我的账户」→「OAuth 邮箱绑定」绑定 Gmail / Outlook
5. 在「系统设置」（管理员可见）关闭注册功能（默认关闭）

### 通过 GitHub Actions 自动部署（可选）

如果想 push 代码自动部署，在仓库 Settings → Secrets → Actions 添加：
- `CLOUDFLARE_API_TOKEN`：第2步生成的 API Token

push 到 `cloudflare` 分支后会自动触发部署。

## 别名邮箱规则

Gmail / Outlook 都支持 `+` 号别名：
- 主邮箱：`user@gmail.com`
- 别名：`user+site1@gmail.com` / `user+site1@outlook.com`
- 所有别名邮件都会进入主邮箱收件箱

**本系统限制**：
- 每用户同时只能有一个别名（设置新的会替换旧的）
- 普通用户查询邮件时自动按别名过滤
- 管理员可查看所有邮件（也可按别名筛选）

## API 接口

### 认证方式

外部 API 调用通过 `key` 查询参数传递 32 位 API Key：

```
POST /api/email/fetch?key=你的32位API密钥
Content-Type: application/json
```

### 获取邮件

```bash
curl -X POST "https://your-worker.workers.dev/api/email/fetch?key=YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "to": "user+site1@gmail.com",
    "sender": "noreply@example.com",
    "subject": "验证码",
    "unseen": true,
    "start_time": "2026-07-08T00:00:00",
    "end_time": "2026-07-08T23:59:59",
    "limit": 10
  }'
```

### 标记已读

```bash
curl -X POST "https://your-worker.workers.dev/api/email/mark_read?key=YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "to": "user+site1@gmail.com",
    "sender": "noreply@example.com"
  }'
```

### 参数说明

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `to` | string | 是 | 查询邮箱（含别名） |
| `sender` | string | 否 | 发件人邮箱 |
| `subject` | string | 否 | 主题关键字 |
| `body` | string | 否 | 正文关键字 |
| `keyword` | string | 否 | 全文搜索（自动匹配 from/to/subject/body） |
| `unseen` | bool | 否 | `true`=仅未读 |
| `start_time` | string | 否 | 开始时间 ISO 8601（默认近 1 小时） |
| `end_time` | string | 否 | 结束时间（默认当前） |
| `limit` | int | 否 | 返回数量（默认 50，上限 100） |

### 返回格式

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "total": 2,
    "emails": [
      {
        "id": "<message-id>",
        "from": "sender@example.com",
        "to": "you+alias@gmail.com",
        "subject": "验证码",
        "date": "2026-07-08 10:23:11",
        "date_iso": "2026-07-08T02:23:11.000Z",
        "body": "您的验证码是 123456",
        "html": "<p>您的验证码是 123456</p>",
        "unread": true,
        "provider": "gmail"
      }
    ]
  }
}
```

## Python 调用示例

### 查询邮件

```python
import requests

WORKER_URL = "https://your-worker.workers.dev"
API_KEY = "你的32位API密钥"

resp = requests.post(
    f"{WORKER_URL}/api/email/fetch?key={API_KEY}",
    json={
        "to": "user+site1@gmail.com",
        "unseen": True,
        "limit": 5
    },
    timeout=15
)
data = resp.json()
if data["code"] != 0:
    raise RuntimeError(data["msg"])

for email in data["data"]["emails"]:
    print(email["subject"], email["date"])
    print(email["body"])
```

### 一次性连接 + 多次查询（推荐封装）

```python
class MailAliasClient:
    """别名邮箱 API 客户端：建立一次配置，可重复调用查询/标记接口"""
    def __init__(self, worker_url: str, api_key: str):
        self.base = worker_url.rstrip("/")
        self.session = requests.Session()
        # 把 key 拼到每个请求的 query 里
        self.session.params = {"key": api_key}

    def fetch(self, to: str, **kwargs) -> list:
        """查询邮件，kwargs 支持 sender/subject/unseen/limit/start_time/end_time"""
        payload = {"to": to, "limit": kwargs.pop("limit", 50), **kwargs}
        r = self.session.post(f"{self.base}/api/email/fetch", json=payload, timeout=15)
        data = r.json()
        if data["code"] != 0:
            raise RuntimeError(data["msg"])
        return data["data"]["emails"]

    def mark_read(self, to: str, sender: str = None, subject: str = None) -> int:
        payload = {"to": to}
        if sender:  payload["sender"] = sender
        if subject: payload["subject"] = subject
        r = self.session.post(f"{self.base}/api/email/mark_read", json=payload, timeout=15)
        return r.json()["data"]["marked"]


# 使用：建立一次连接，多次调用
client = MailAliasClient("https://your-worker.workers.dev", "YOUR_KEY")
emails = client.fetch("user+site1@gmail.com", unseen=True, limit=3)
for e in emails:
    print(e["subject"], e["body"][:50])
client.mark_read("user+site1@gmail.com", sender="noreply@example.com")
```

## Webhook 推送

### 两种推送模式

系统根据回调 URL 的域名自动识别推送模式：

| 模式 | 回调 URL 示例 | 行为 |
|------|--------------|------|
| **飞书直推** | `https://open.feishu.cn/open-apis/bot/v2/hook/xxx` | 自动转换为飞书 `msg_type=text` 消息格式，直接推送到飞书群 |
| **钉钉直推** | `https://oapi.dingtalk.com/robot/send?access_token=xxx` | 自动转换为钉钉消息格式 |
| **原始 JSON** | 其他任意 HTTPS 地址 | POST 完整 JSON 载荷，Content-Type: application/json |

> **推荐使用飞书直推**：无需自建中转服务，回调 URL 直接填飞书群机器人地址即可。
> SSRF 防护已白名单放行飞书/钉钉/企业微信/Slack/Discord 域名。

### 工作流程

1. 在「Webhook 订阅」页填写：监听的邮箱账号、回调 URL（飞书机器人地址或其他）、订阅事件（`new_mail`）
2. 系统**主动轮询**该邮箱最近 10 分钟的邮件，匹配后聚合推送到你的 URL
3. **每用户仅保留一个 Webhook 订阅**（创建新的会自动清除旧的；更换别名也会自动清除）
4. 如果填了 secret（仅原始 JSON 模式有效），会带 `X-Webhook-Signature` 头用于验真

### 权限规则

- **自己拥有的邮箱**：可订阅整个邮箱（监听全部邮件），target_alias 可选
- **别人公开的邮箱**：不能订阅整箱；只能订阅自己的别名（target_alias 自动锁定为你的别名）

### 触发推送

Webhook 推送由外部触发（你可以用 cron-job.org / Cloudflare Cron Triggers / 自己的服务器定时调用）：

```bash
curl "https://your-worker.workers.dev/api/webhook/poll?key=YOUR_KEY&account_id=g1234abcd"
```

返回示例：
```json
{
  "code": 0,
  "msg": "success",
  "data": { "pushed": 1, "errors": [] }
}
```

### 推送载荷格式

| 字段 | 类型 | 说明 |
|------|------|------|
| `event` | string | 事件类型：`new_mail` / `unread` / `test` |
| `delivered_at` | string | 推送时间 ISO 8601 |
| `mail_account_id` | string | 邮箱账号 ID |
| `email` | string | 主邮箱地址 |
| `to_alias` | string? | 命中的别名（若订阅时设置了 `target_alias`） |
| `count` | int | 本次推送邮件数 |
| `emails` | Email[] | 邮件数组，字段同查询接口 |

> Webhook 签名验签属于可选的高级安全配置，详见 [附录：Webhook 签名验签](#附录webhook-签名验签)。

## 路由列表

| 方法 | 路径 | 认证 | 说明 |
|------|------|------|------|
| GET | `/` | - | Web 界面 |
| GET | `/health` | - | 健康检查 |
| POST | `/api/auth/login` | - | 登录 |
| POST | `/api/auth/register` | - | 注册（受开关控制） |
| POST | `/api/auth/logout` | Session | 登出 |
| GET | `/api/auth/me` | Session | 当前用户 |
| GET | `/api/account` | Session | 账户信息 |
| POST | `/api/account/api_key` | Session | 重新生成 API Key |
| GET | `/api/account/mail_accounts` | Session | 我的邮箱 |
| GET | `/api/account/mail_accounts/available` | Session | 可用邮箱（含公开） |
| DELETE | `/api/account/mail_accounts/:id` | Session | 删除邮箱 |
| GET | `/api/account/mail_accounts/:id/status` | Session | 授权状态探测 |
| PUT | `/api/account/mail_accounts/:id/public` | Session | 切换邮箱公开状态 |
| GET | `/api/account/oauth/start?provider=gmail` | Session | 启动 Gmail OAuth |
| POST | `/api/account/oauth/device` | Session | 启动微软 Device Code 授权 |
| GET | `/api/account/oauth/device/status` | Session | 轮询微软授权状态 |
| GET | `/oauth/callback` | - | Gmail OAuth 回调 |
| POST | `/api/account/alias` | Session | 设置别名（会自动清除旧 Webhook） |
| GET | `/api/account/alias/random_label` | Session | 随机别名 |
| POST | `/api/email/fetch?key=` | API Key | 查询邮件 |
| POST | `/api/email/mark_read?key=` | API Key | 标记已读 |
| POST | `/api/web/email/fetch` | Session | Web 查询邮件 |
| GET | `/api/webhooks` | Session | 我的 Webhook |
| POST | `/api/webhooks` | Session | 创建 Webhook（每用户仅一个，自动清除旧的） |
| DELETE | `/api/webhooks/:id` | Session | 删除 Webhook |
| POST | `/api/webhooks/:id/test` | Session | 测试推送 |
| GET | `/api/webhook/poll?key=&account_id=` | API Key | 触发轮询推送 |
| GET | `/api/admin/users` | Admin | 用户列表 |
| POST | `/api/admin/users` | Admin | 创建用户 |
| PUT | `/api/admin/users/:id` | Admin | 编辑用户（用户名/密码/角色/禁用） |
| POST | `/api/admin/users/:id/alias` | Admin | 为用户设置别名 |
| DELETE | `/api/admin/users/:id` | Admin | 删除用户 |
| GET | `/api/admin/stats` | Admin | 系统统计 |
| GET | `/api/admin/settings` | - | 注册开关 |
| PUT | `/api/admin/settings` | Admin | 修改设置 |
| GET | `/api/admin/mail_accounts` | Admin | 所有邮箱 |
| PUT | `/api/admin/mail_accounts/:id` | Admin | 修改邮箱（含公开状态） |
| DELETE | `/api/admin/mail_accounts/:id` | Admin | 删除邮箱 |

## 数据存储

| 数据 | 位置 | 说明 |
|------|------|------|
| 用户/邮箱/别名/Webhook/日志 | D1 (`mail_alias` 库) | 持久化，参见 `schema.sql` |
| Session | D1 + KV 双写 | KV 加速校验，TTL 7 天 |
| OAuth state | KV | 5 分钟过期，防 CSRF |
| OAuth refresh_token | D1 (AES-GCM 加密) | 用 `ENCRYPT_KEY` 加密 |

## 安全说明

- 密码 SHA256 加盐存储（Cloudflare Web Crypto API）
- OAuth `refresh_token` 用 AES-GCM 加密存储
- Session 7 天有效期，KV 缓存
- API Key 32 位随机 hex
- Webhook 推送 HMAC-SHA256 签名
- Web 界面需登录，API 调用需 Key
- 管理员操作全部有日志
- 越权防护：所有用户操作均校验资源归属
- SSRF 防护：Webhook URL 拒绝内网/元数据地址
- XSS 防护：OAuth 回调 HTML 转义
- 信息泄露防护：错误信息不暴露内部细节

## 速率限制（第三方 API）

| 平台 | 限制 |
|------|------|
| Gmail API | 250 quota/秒，每日 10 亿 quota |
| Microsoft Graph | 10000 请求/10 分钟 |
| Cloudflare Workers | 100,000 请求/天（免费层） |

正常使用完全够。

## 本地开发

```bash
# 启动本地 Worker (含本地 D1 + KV 模拟)
wrangler dev

# 访问 http://localhost:8787
# OAuth 回调需配置 BASE_URL=http://localhost:8787
```

## 故障排查

| 现象 | 原因 | 解决 |
|------|------|------|
| Gmail OAuth 回调报 `redirect_uri_mismatch` | Google 配置的回调 URI 和实际不一致 | 在 Google 控制台把回调 URI 改成 `https://你的-worker.workers.dev/oauth/callback` |
| 微软授权弹窗显示 user_code 后无反应 | 用户未在有效期内完成授权 / 网络问题 | 重新点击「绑定 Outlook/Hotmail」获取新 user_code，5 分钟内在新页面完成登录 |
| 微软授权报 `expired_token` | device code 已过期（默认 15 分钟） | 重新发起授权流程 |
| OAuth 报 `invalid_grant` | 用户之前已授权过，Google 不再返回 refresh_token | 在 Google 账户权限页面撤销本应用授权后重试 |
| `refresh error: invalid_grant` | refresh_token 失效（用户改密码/撤销授权） | 删除邮箱重新绑定 |
| 邮件查询返回空但邮箱里有邮件 | 时间范围不对 / 别名过滤太严 | 检查 `to` 参数和 `start_time` |
| Webhook 测试推送飞书未收到 | 回调 URL 填了内网地址 / 非飞书域名被 SSRF 拦截 | 回调 URL 直接填飞书机器人地址 `https://open.feishu.cn/open-apis/bot/v2/hook/xxx` |
| 登录点击无反应/抓包看不到请求 | 浏览器或 CDN 缓存了旧版前端 HTML | 硬刷新 `Ctrl+Shift+R`；系统已对 HTML 设置 `no-cache` 头并启用 `run_worker_first`，正常情况下不会复现 |
| 登录提示「账户不存在,或是密码不匹配」 | 用户名/密码错误，或账户被禁用 | 检查账号密码；若确认正确仍无法登录，联系管理员核对账户是否被禁用（统一提示不暴露账户存在性） |
| 修改代码部署后页面没变化 | CDN 边缘缓存了旧 HTML | 硬刷新浏览器；或等待 CDN 缓存自然过期（已设 no-cache，通常无需等待） |

## 附录：Webhook 签名验签

> 此为可选的高级安全配置。Webhook 用于飞书等场景的简单推送可跳过本节。

如订阅时填了 `secret`，每次推送会带：
```
X-Webhook-Signature: <HMAC-SHA256(secret, body) base64url>
```

**Python 验签示例（Flask 接收 Webhook）**：

```python
import hmac
import hashlib
import base64
from flask import Flask, request, jsonify

app = Flask(__name__)
WEBHOOK_SECRET = "你在订阅时填的 secret"

def verify_signature(body: bytes, signature: str) -> bool:
    """验证 HMAC-SHA256 签名 (base64url 编码)"""
    expected = hmac.new(
        WEBHOOK_SECRET.encode("utf-8"),
        body,
        hashlib.sha256
    ).digest()
    expected_b64 = base64.urlsafe_b64encode(expected).rstrip(b"=").decode("ascii")
    # 等长比较防时序攻击
    return hmac.compare_digest(expected_b64, signature)


@app.route("/webhook", methods=["POST"])
def receive_webhook():
    body = request.get_data()
    signature = request.headers.get("X-Webhook-Signature", "")
    if not verify_signature(body, signature):
        return jsonify({"error": "invalid signature"}), 401

    payload = request.get_json()
    print(f"收到 {payload['count']} 封新邮件，主邮箱: {payload['email']}")
    for email in payload["emails"]:
        print(f"  - {email['subject']} (from: {email['from']})")
    return jsonify({"ok": True}), 200


if __name__ == "__main__":
    app.run(port=5000)
```

**Node.js 验签**：

```js
const crypto = require('crypto');
function verify(body, signature, secret) {
  const expected = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}
```

## License

MIT
