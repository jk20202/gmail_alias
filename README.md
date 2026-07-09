# Mail Alias Cloudflare Edition

部署在 **Cloudflare Workers** 上的别名邮箱管理系统。基于 TypeScript + D1 + KV，支持 **Gmail / Outlook / Hotmail** OAuth 绑定、API 调用查询邮件、**Webhook 推送**。

> 这是 Python + IMAP 版本（main 分支）的姊妹项目，专为 Cloudflare 免费托管重写。
> **不再依赖 IMAP / SMTP**，全部走官方 REST API（Gmail API + Microsoft Graph API）。

## 功能特性

- ✅ **多邮箱平台 OAuth 绑定**：Gmail + Outlook/Hotmail/Live（统一走 Microsoft Graph）
- ✅ **微软公共客户端授权**：内置 Thunderbird 公共 client_id + `consumers` 租户，**无需自建 Azure 应用、无需 client_secret**，开箱即用授权个人微软邮箱
- ✅ **授权状态探测**：邮箱列表实时显示每个邮箱的授权状态（已授权/未授权），支持一键重新授权（upsert 更新 token，不产生重复记录）
- ✅ **别名邮箱管理**：基于 `+` 号别名规则，每用户一个别名
- ✅ **API Key 调用**：32 位密钥，无过期，外部程序直接调用
- ✅ **Webhook 推送**：新邮件到达自动推送到你的服务，HMAC-SHA256 签名验真
- ✅ **多用户**：管理员 + 普通用户，注册开关
- ✅ **使用统计**：30 天保留，按用户/邮箱统计
- ✅ **Web 界面**：响应式中文界面
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

**注册 Microsoft Azure AD 应用**（用于 Outlook/Hotmail，**可选**）：

> 默认无需注册：系统内置 Thunderbird 公共客户端（`consumers` 租户 + 公共 client_id），开箱即可授权个人微软邮箱（outlook/hotmail/live），**不需要 client_secret**。仅当需要改用自注册应用时才执行以下步骤。

1. 访问 https://portal.azure.com/ → Azure Active Directory → 应用注册 → 新注册
2. 账户类型选「个人 Microsoft 账户」（与默认 `consumers` 租户一致）
3. 重定向 URI：Web → `https://你的-worker.workers.dev/oauth/callback`
4. API 权限 → 添加 `Mail.Read`、`Mail.ReadWrite`、`User.Read` 和 `offline_access`（委托权限）
5. 应用类型设为「公共客户端」（不要创建 client_secret），拿到 `Client ID`（应用 ID）
6. 用 `wrangler secret put MS_CLIENT_ID` 覆盖默认的 Thunderbird client_id

### 2. 创建 Cloudflare 资源

```bash
# 安装 Wrangler CLI
npm install -g wrangler
wrangler login

# 克隆 cloudflare 分支
git checkout cloudflare
npm install

# 创建 D1 数据库
wrangler d1 create mail_alias
# 复制返回的 database_id 到 wrangler.toml

# 创建 KV 命名空间
wrangler kv:namespace create KV
# 复制返回的 id 到 wrangler.toml

# 初始化数据库 schema
wrangler d1 execute mail_alias --remote --file=./schema.sql
# 本地开发也初始化一份:
wrangler d1 execute mail_alias --local --file=./schema.sql
```

### 3. 配置 wrangler.toml

编辑 `wrangler.toml`，替换：
- `database_id` 为 D1 返回的 ID
- KV 的 `id` 为 KV 命名空间 ID

### 4. 注入 Secrets

```bash
wrangler secret put GOOGLE_CLIENT_ID
wrangler secret put GOOGLE_CLIENT_SECRET
# 微软默认走 Thunderbird 公共客户端,以下两项可选(仅自注册应用时需要):
# wrangler secret put MS_CLIENT_ID
# wrangler secret put MS_CLIENT_SECRET   # 已废弃,公共客户端不使用
wrangler secret put JWT_SECRET              # 随便输个长字符串
wrangler secret put ENCRYPT_KEY             # 32 字节 hex:openssl rand -hex 32
wrangler secret put BASE_URL                # https://你的-worker.workers.dev
```

### 5. 部署

```bash
wrangler deploy
```

部署后访问 `https://你的-worker.workers.dev`，使用 [wrangler.toml](wrangler.toml) 中 `ADMIN_USERNAME` / `ADMIN_PASSWORD` 配置的账户登录。**首次登录后立即在「我的账户」修改密码。**

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

### 工作流程

1. 在「Webhook 订阅」页填写：监听的邮箱账号、回调 URL、订阅事件（`new_mail`）、可选 secret
2. 系统**主动轮询**该邮箱最近 10 分钟的邮件，匹配后聚合推送到你的 URL
3. 推送是 HTTP POST，Content-Type: application/json
4. 如果填了 secret，会带 `X-Webhook-Signature` 头用于验真

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
| GET | `/api/account/oauth/start?provider=gmail\|outlook` | Session | 启动 OAuth |
| GET | `/oauth/callback` | - | OAuth 回调 |
| POST | `/api/account/alias` | Session | 设置别名 |
| GET | `/api/account/alias/random_label` | Session | 随机别名 |
| POST | `/api/email/fetch?key=` | API Key | 查询邮件 |
| POST | `/api/email/mark_read?key=` | API Key | 标记已读 |
| POST | `/api/web/email/fetch` | Session | Web 查询邮件 |
| GET | `/api/webhooks` | Session | 我的 Webhook |
| POST | `/api/webhooks` | Session | 创建 Webhook |
| DELETE | `/api/webhooks/:id` | Session | 删除 Webhook |
| POST | `/api/webhooks/:id/test` | Session | 测试推送 |
| GET | `/api/webhook/poll?key=&account_id=` | API Key | 触发轮询推送 |
| GET | `/api/admin/users` | Admin | 用户列表 |
| POST | `/api/admin/users` | Admin | 创建用户 |
| PUT | `/api/admin/users/:id` | Admin | 修改用户 |
| DELETE | `/api/admin/users/:id` | Admin | 删除用户 |
| GET | `/api/admin/stats` | Admin | 系统统计 |
| GET | `/api/admin/settings` | - | 注册开关 |
| PUT | `/api/admin/settings` | Admin | 修改设置 |
| GET | `/api/admin/mail_accounts` | Admin | 所有邮箱 |
| PUT | `/api/admin/mail_accounts/:id` | Admin | 修改邮箱 |
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
| OAuth 回调报 `redirect_uri_mismatch` | Google/Azure 配置的回调 URI 和实际不一致 | 在 Google/Azure 控制台把回调 URI 改成 `https://你的-worker.workers.dev/oauth/callback` |
| OAuth 报 `invalid_grant` | 用户之前已授权过，Google 不再返回 refresh_token | 在 Google 账户权限页面撤销本应用授权后重试 |
| `refresh error: invalid_grant` | refresh_token 失效（用户改密码/撤销授权） | 删除邮箱重新绑定 |
| 邮件查询返回空但邮箱里有邮件 | 时间范围不对 / 别名过滤太严 | 检查 `to` 参数和 `start_time` |
| `Mail.Read 权限不足` | Azure 应用没加权限或没管理员同意 | 默认 Thunderbird 公共客户端已含所需权限;自注册应用需在 Azure AD → API 权限 → 添加 `Mail.Read` → 点「为 xxx 授予管理员同意」 |
| 微软授权报 `invalid_client` / 需要 client_secret | 误用了机密客户端流程 | 本项目已改为公共客户端(consumers 端点),无需 client_secret;若自设了 `MS_CLIENT_SECRET` 请删除 |
| 微软授权只能用个人账号 | `consumers` 租户仅支持个人微软账号 | 如需企业账号,需自注册应用并改用 `common`/`organizations` 端点(需自行改代码) |

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
