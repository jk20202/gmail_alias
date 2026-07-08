# Gmail Alias 邮件管理系统

基于 FastAPI + IMAP 的多邮箱别名邮件管理系统，支持 Gmail / 2925 / 微软(Outlook/Hotmail/Live) 三种邮箱服务，支持多用户、别名邮箱管理、API 调用、使用统计。

## 功能特性

- **多邮箱服务商**: Gmail(`+`别名) / 2925(`_`别名) / 微软(`+`别名，OAuth2+Graph API)
- **账户登录系统**: 管理员 + 普通用户，支持注册开关
- **别名邮箱管理**: 每用户一个别名(可替换)，普通用户只能查看别名邮件
- **API Key 认证**: 32位密钥，不过期可更新，通过参数传递
- **邮件查询**: 支持发件人/主题/关键词/时间范围/未读状态筛选
- **使用统计**: 30天保留期，按用户/别名统计调用记录
- **连接池复用**: 单账户最多10并发，超出FIFO排队
- **Web 界面**: 简约美观，响应式设计

## 默认管理员

- 用户名: `admin`
- 密码: `admin123_`

**请登录后立即修改密码(通过管理员编辑用户功能)**

## 快速部署

### 1. 环境准备

```bash
cd /data/gmail_alias
python3 -m venv venv
/data/gmail_alias/venv/bin/pip install -r requirements.txt
mkdir -p logs data
```

### 2. Supervisor 配置

```bash
cp supervisor_gmail_alias.ini /etc/supervisor/conf.d/
supervisorctl reread && supervisorctl update
supervisorctl status gmail_alias
```

### 3. 访问

浏览器打开 `http://your-server:8000`，使用管理员账户登录。

### 4. 微软邮箱回调地址(可选)

若需要使用微软邮箱(Outlook/Hotmail/Live)，部署时需设置 OAuth 回调环境变量，并在 Supervisor 配置或启动脚本中导出:

```bash
export OAUTH_REDIRECT_URI="http://your-server:8000/api/ms_auth/callback"
```

该地址需在浏览器中可公网访问，且与微软授权应用配置一致(本地调试可用 `http://localhost:8000/api/ms_auth/callback`)。

## Gmail 应用专用密码

1. 登录 https://myaccount.google.com/security
2. 开启「两步验证」
3. 访问 https://myaccount.google.com/apppasswords
4. 生成应用专用密码(16位)
5. 在 Gmail 设置中启用 IMAP
6. 在系统「我的账户」页面填入邮箱和密码

## 支持的邮箱服务商

系统通过 `provider` 字段区分邮箱类型，不同服务商有不同的接入方式与别名规则。

### Gmail

- 别名分隔符: `+`，例: `user+tag@gmail.com`
- 接入方式: IMAP(应用专用密码)
- 服务器: `imap.gmail.com:993`(SSL)
- 文档: 见上方「Gmail 应用专用密码」

### 2925 邮箱

- 别名分隔符: `_`，例: `user_tag@2925.com`
- 接入方式: IMAP(主邮箱登录密码)
- 服务器: `imap.2925.com:143`(明文连接，不支持 SSL/TLS 和 STARTTLS)
- 注意:
  - 2925 不支持 IMAP `SEARCH` 命令，系统通过 `SELECT` 获取总数后按序列号 `FETCH`，再在本地过滤
  - 必须使用主邮箱完整地址登录，子邮箱无法登录客户端
  - 子邮箱/别名邮件会进入主邮箱收件箱

### 微软邮箱 (Outlook/Hotmail/Live)

- 别名分隔符: `+`，例: `user+tag@outlook.com`
- 接入方式: **OAuth2 网页授权 + Microsoft Graph API**(不再使用 IMAP)
- 原因: 微软自 2024-09 起对个人账户禁用 IMAP 基本认证
- 授权流程:
  1. 在系统「我的账户」中添加邮箱，选择「微软邮箱」，无需填密码
  2. 账户创建后页面会显示「去授权」按钮，点击跳转到微软登录页
  3. 用户登录并同意权限后，微软回调 `/api/ms_auth/callback` 完成令牌交换
  4. 系统保存 `access_token` + `refresh_token`，后续访问自动刷新
- 邮件正文: 通过 Graph API 的 `bodyPreview` 字段获取(预览长度限制)
- 重新授权: 账户列表中点击「重新授权」可清空旧令牌并生成新授权链接
- 环境变量:
  - `OAUTH_REDIRECT_URI`: OAuth 回调地址，本地默认 `http://localhost:8000/api/ms_auth/callback`，部署时必须改为公网可达地址

## 别名邮箱规则

不同服务商使用各自的别名分隔符(Gmail/微软用 `+`，2925 用 `_`)，例如:
- Gmail 主邮箱 `user@gmail.com` → 别名 `user+site1@gmail.com`
- 2925 主邮箱 `user@2925.com` → 别名 `user_site1@2925.com`
- 微软主邮箱 `user@outlook.com` → 别名 `user+site1@outlook.com`
- 所有别名邮件都会进入主邮箱收件箱

**本系统限制**:
- 每用户同时只能有一个别名(设置新的会替换旧的)
- 普通用户查询邮件时自动按别名过滤
- 管理员可查看所有邮件(也可按别名筛选)

## API 接口

### 认证方式

API 调用通过 `key` 参数传递 32 位 API Key 进行认证:

```
POST /api/email/fetch
Content-Type: application/json

{
    "key": "你的32位API密钥",
    ...
}
```

### 获取邮件

```bash
curl -X POST "http://your-server:8000/api/email/fetch" \
  -H "Content-Type: application/json" \
  -d '{
    "key": "your_api_key",
    "sender": "noreply@example.com",
    "subject": "验证码",
    "unseen": true,
    "start_time": "2026-07-06T00:00:00",
    "end_time": "2026-07-06T23:59:59",
    "limit": 10
  }'
```

### 标记已读

```bash
curl -X POST "http://your-server:8000/api/email/mark_read" \
  -H "Content-Type: application/json" \
  -d '{
    "key": "your_api_key",
    "sender": "noreply@example.com"
  }'
```

### Python 调用示例

```python
import requests

resp = requests.post("http://your-server:8000/api/email/fetch", json={
    "key": "your_api_key",
    "unseen": True,
    "limit": 5
})
data = resp.json()
for email in data["data"]["emails"]:
    print(email["subject"], email["body"])
```

### 参数说明

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `key` | string | 是 | 32位API密钥 |
| `sender` | string | 否 | 发件人邮箱 |
| `to` | string | 否 | 收件人(普通用户自动用别名) |
| `subject` | string | 否 | 主题关键字 |
| `body` | string | 否 | 正文关键字 |
| `keyword` | string | 否 | 全文搜索 |
| `unseen` | bool | 否 | true=仅未读 |
| `start_time` | string | 否 | 开始时间(默认近1小时) |
| `end_time` | string | 否 | 结束时间(默认当前) |
| `limit` | int | 否 | 返回数量(默认50) |

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
        "date": "2026-07-06 10:23:11",
        "body": "您的验证码是 123456",
        "unread": true
      }
    ]
  }
}
```

### 微软邮箱 OAuth 接口

以下接口用于微软邮箱授权流程，普通用户一般通过 Web 界面操作，无需直接调用:

- `GET /api/ms_auth/start?ga_id=xxx` — 生成微软授权 URL，需要登录会话(Bearer Token)
- `GET /api/ms_auth/callback?code=xxx&state=xxx` — 微软授权后回调，自动交换令牌并保存(由微软服务器跳转触发)
- `POST /api/ms_auth/reauth/{ga_id}` — 清空旧令牌并生成重新授权 URL，需要登录会话

## 文件结构

```
gmail_alias/
├── main.py                    # FastAPI 主程序(路由 + OAuth 回调)
├── email_service.py           # 邮件服务(按 provider 路由: Gmail/2925 IMAP, 微软 Graph API)
├── graph_mail.py              # Microsoft Graph API 邮件客户端
├── ms_oauth.py                # 微软 OAuth2 工具(授权URL/换token/刷新)
├── user_store.py              # 用户管理(认证/会话/API Key/多邮箱账户)
├── usage_log.py               # 使用统计(30天保留)
├── static/
│   └── index.html             # Web 界面
├── data/                      # 运行时数据(JSON存储)
│   ├── users.json             # 用户数据(含 outlook token JSON)
│   ├── settings.json          # 系统设置
│   └── usage_log.json         # 使用日志
├── logs/                      # 日志目录
├── requirements.txt           # 依赖
├── supervisor_gmail_alias.ini # Supervisor 配置
└── README.md
```

## 数据存储

所有数据采用本地 JSON 文件存储，无需数据库:
- `data/users.json` - 用户账户、多邮箱配置(provider/token/别名)、API Key；微软邮箱的 `token` 字段存储 OAuth2 令牌 JSON 字符串
- `data/settings.json` - 系统设置(注册开关)
- `data/usage_log.json` - 使用日志(30天自动清理)

## 并发控制

- 每个 IMAP 邮箱账户最多 10 个并发连接(Gmail 限制 15，留缓冲)
- 超出自动 FIFO 排队
- 连接池复用，断开自动重建
- 多账户之间互不影响
- 微软邮箱走 Graph API(HTTP 短连接)，无连接池限制

## 安全说明

- 密码 SHA256 加密存储
- Session 7天有效期
- API Key 32位随机hex
- Web 界面需登录
- API 调用需 Key 参数
- 管理员操作有日志记录

## Gmail 速率限制

| 限制项 | 阈值 |
|--------|------|
| 每日下载 | 15 GB |
| 并发连接 | 15 个 |
| 登录失败 | 短时间多次会锁定 |

正常使用(30秒+轮询间隔)完全安全，不会封号。

## 微软 Graph API 说明

- 个人账户通过 `https://login.live.com/oauth20_authorize.srf` 授权，`https://graph.microsoft.com/v1.0/me/messages` 拉取邮件
- 客户端使用 Thunderbird 公共 client_id，无需单独注册应用
- 令牌有效期约 1 小时，过期后自动用 `refresh_token` 刷新并回写存储
- `bodyPreview` 字段长度有限，超长正文会被截断(已知限制)
- 2925 邮箱因官方服务器不支持 `SEARCH`，邮件过滤全部在本地完成，大收件箱下查询较慢，建议配合 `start_time` 缩小范围
