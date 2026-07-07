# Gmail Alias Email API

基于 FastAPI + IMAP 的 Gmail 邮件获取服务,支持多账户管理、别名筛选、时间过滤、Web 界面和 API 鉴权。

## 功能特性

- Web 界面管理 Gmail 账户(增删改查)
- Web 界面查询邮件,支持多维度过滤
- REST API 接口,支持程序化调用
- Bearer Token 鉴权,防止未授权访问
- 单账户 10 并发限制,FIFO 队列排队
- IMAP 连接池复用,自动断线重连
- Gmail `+`号别名精确筛选
- 时间过滤精确到秒(上海时区)
- 关键词全文搜索(主题/正文/发件人/收件人)

## 目录结构

```
gmail_alias/
├── main.py                    # FastAPI 主程序
├── email_service.py           # IMAP 服务(连接池+邮件解析)
├── account_store.py           # 账户存储(JSON文件)
├── static/
│   └── index.html             # Web 界面(单页应用)
├── data/
│   └── accounts.json          # 账户数据(运行时生成)
├── requirements.txt           # Python 依赖
├── supervisor_gmail_alias.ini # Supervisor 配置
└── README.md
```

## 快速开始

### 1. 安装依赖

```bash
cd D:\Program\pycharm\projects\gmail_alias
pip install -r requirements.txt
```

### 2. 启动服务

```bash
python main.py
# 或
uvicorn main:app --host 0.0.0.0 --port 8000
```

### 3. 访问 Web 界面

浏览器打开 http://localhost:8000

- 默认令牌: 通过环境变量 `ADMIN_TOKEN` 配置(必改)
- 建议修改: 设置环境变量 `ADMIN_TOKEN=your_password`

## Gmail 应用专用密码创建

### 前置条件

1. 开启两步验证: https://myaccount.google.com/security → 两步验证
2. 生成应用密码: https://myaccount.google.com/apppasswords
3. 启用 IMAP: Gmail设置 → 转发和POP/IMAP → 启用IMAP

### 获取 Token

在应用密码页面创建后,获得16位密码(格式: `xxxx xxxx xxxx xxxx`),这就是 API 调用时的 `token`。

## API 接口

所有接口(除 /health 和 /api/login)需要在 Header 中携带:
```
Authorization: Bearer <your_token>
```

### 1. 登录验证 `POST /api/login`

```json
{"token": "<your_token>"}
```

### 2. 账户管理

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/accounts | 列出所有账户 |
| POST | /api/accounts | 添加账户 |
| PUT | /api/accounts/{id} | 更新账户 |
| DELETE | /api/accounts/{id} | 删除账户 |

**添加账户请求体**:
```json
{
  "email": "you@gmail.com",
  "token": "xxxx xxxx xxxx xxxx",
  "label": "我的Gmail"
}
```

### 3. 获取邮件 `POST /api/email/fetch`

**请求参数**:

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| account_id | string | - | 已配置的账户ID(与email/token二选一) |
| email | string | - | Gmail邮箱地址 |
| token | string | - | 应用专用密码 |
| to | string | - | 收件人筛选(Gmail别名) |
| sender | string | - | 发件人筛选 |
| subject | string | - | 主题关键字 |
| body | string | - | 正文关键字 |
| keyword | string | - | 全文关键字(搜索主题/正文/发件人/收件人) |
| unseen | bool | - | true=未读 / false=已读 / 不传=全部 |
| start_time | string | 近1小时 | 开始时间(上海时区) |
| end_time | string | 当前时间 | 结束时间(上海时区) |
| limit | int | 50 | 返回数量上限 |

**时间格式**: `2026-07-07T15:30:00` 或 `2026-07-07 15:30:00`(无时区时默认上海时区)

**请求示例**:

```bash
curl -X POST http://localhost:8000/api/email/fetch \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <your_token>" \
  -d '{
    "email": "you@gmail.com",
    "token": "xxxx xxxx xxxx xxxx",
    "to": "you+site1@gmail.com",
    "unseen": true,
    "start_time": "2026-07-07T00:00:00",
    "end_time": "2026-07-07T23:59:59",
    "limit": 10
  }'
```

**响应示例**:

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "total": 2,
    "emails": [
      {
        "id": "<msg123@gmail.com>",
        "from": "noreply@site.com",
        "to": "you+site1@gmail.com",
        "subject": "验证码",
        "date": "2026-07-07 15:30:22",
        "date_iso": "2026-07-07T15:30:22+08:00",
        "body": "验证码:123456",
        "html": "...",
        "unread": true
      }
    ],
    "query": {
      "email": "you@gmail.com",
      "to": "you+site1@gmail.com",
      "start_time": "2026-07-07T00:00:00",
      "end_time": "2026-07-07T23:59:59",
      "limit": 10
    }
  }
}
```

### 4. 标记已读 `POST /api/email/mark_read`

```json
{
  "email": "you@gmail.com",
  "token": "xxxx xxxx xxxx xxxx",
  "sender": "noreply@site.com"
}
```

### 5. 健康检查 `GET /health`

无需鉴权,返回服务状态。

## Gmail 别名使用

Gmail 支持 `+`号别名,一个主邮箱可衍生无限邮箱地址:

| 注册网站用 | 实际收到 | 查询时传 `to` 参数 |
|-----------|---------|------------------|
| `you+site1@gmail.com` | `you@gmail.com` | `you+site1@gmail.com` |
| `you+site2@gmail.com` | `you@gmail.com` | `you+site2@gmail.com` |

## 并发控制

- 单账户最多 10 个并发请求(Gmail限制15个,留缓冲)
- 超过10个自动FIFO排队
- 总并发无限制(多账户各自独立)

## 部署到 Linux 服务器(Supervisor)

### 1. 上传项目

```bash
sudo mkdir -p /opt/gmail_alias /var/log/gmail_alias
sudo chown www-data:www-data /opt/gmail_alias /var/log/gmail_alias
# 上传项目到 /opt/gmail_alias
```

### 2. 安装依赖

```bash
cd /opt/gmail_alias
python3 -m venv venv
/opt/gmail_alias/venv/bin/pip install -r requirements.txt
```

### 3. 配置 Supervisor

```bash
sudo cp supervisor_gmail_alias.ini /etc/supervisor/conf.d/
sudo supervisorctl reread
sudo supervisorctl update
sudo supervisorctl status gmail_alias
```

### 4. 修改密码(推荐)

编辑 supervisor 配置中的 `ADMIN_TOKEN` 环境变量:

```ini
environment=ADMIN_TOKEN="your_secure_password",PYTHONUNBUFFERED="1"
```

### 5. 防火墙

```bash
sudo ufw allow 8000/tcp
# 或限制IP
sudo ufw allow from YOUR_IP to any port 8000
```

### 常用命令

```bash
sudo supervisorctl restart gmail_alias
sudo supervisorctl tail -f gmail_alias
```

## 安全建议

1. 必须修改令牌(设置 ADMIN_TOKEN 环境变量为强密码)
2. 防火墙限制访问IP
3. 生产环境使用 HTTPS(Nginx反代+SSL证书)
4. 定期检查日志 `/var/log/gmail_alias/`
5. 不要在公开仓库提交 `data/accounts.json`

## Python 调用示例

```python
import requests

API = "http://your-server:8000"
TOKEN = "<your_token>"
headers = {"Authorization": f"Bearer {TOKEN}"}

# 获取验证码
r = requests.post(f"{API}/api/email/fetch", headers=headers, json={
    "email": "you@gmail.com",
    "token": "xxxx xxxx xxxx xxxx",
    "to": "you+site1@gmail.com",
    "unseen": True,
    "limit": 1
}, timeout=30)
data = r.json()
if data["data"]["emails"]:
    print(data["data"]["emails"][0]["body"])
```
