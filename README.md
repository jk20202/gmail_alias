# Gmail Alias 邮件管理系统

基于 FastAPI + IMAP 的 Gmail 别名邮箱管理系统，支持多用户、别名邮箱管理、API 调用、使用统计。

## 功能特性

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

## Gmail 应用专用密码

1. 登录 https://myaccount.google.com/security
2. 开启「两步验证」
3. 访问 https://myaccount.google.com/apppasswords
4. 生成应用专用密码(16位)
5. 在 Gmail 设置中启用 IMAP
6. 在系统「我的账户」页面填入邮箱和密码

## 别名邮箱规则

Gmail 支持 `+` 号别名，例如:
- 主邮箱: `user@gmail.com`
- 别名: `user+site1@gmail.com`
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

## 文件结构

```
gmail_alias/
├── main.py                    # FastAPI 主程序
├── email_service.py           # IMAP 服务(连接池+邮件解析)
├── user_store.py              # 用户管理(认证/会话/API Key)
├── usage_log.py               # 使用统计(30天保留)
├── static/
│   └── index.html             # Web 界面
├── data/                      # 运行时数据(JSON存储)
│   ├── users.json             # 用户数据
│   ├── settings.json          # 系统设置
│   └── usage_log.json         # 使用日志
├── logs/                      # 日志目录
├── requirements.txt           # 依赖
├── supervisor_gmail_alias.ini # Supervisor 配置
└── README.md
```

## 数据存储

所有数据采用本地 JSON 文件存储，无需数据库:
- `data/users.json` - 用户账户、Gmail配置、别名、API Key
- `data/settings.json` - 系统设置(注册开关)
- `data/usage_log.json` - 使用日志(30天自动清理)

## 并发控制

- 每个Gmail账户最多 10 个并发连接(Gmail限制15，留缓冲)
- 超出自动 FIFO 排队
- 连接池复用，断开自动重建
- 多账户之间互不影响

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
