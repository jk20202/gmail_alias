# Mail Alias v2 —— 邮件转发聚合版

基于 **Cloudflare Workers + D1 + R2 + Email Routing** 的多用户邮件聚合与别名收信系统。

> 本仓库包含两套并存的实现：
> - **v1（`cloudflare` 分支）**：OAuth / IMAP 实时拉信（已停止维护，见文末「与 v1 的差异」）
> - **v2（`cloudflarev2` 分支，本文档）**：**邮件转发聚合** —— 各邮箱把邮件自动转发到本系统，彻底不需要授权

---

## 一、为什么改成「转发」方式

v1 在 Worker 里用 `cloudflare:sockets` 直连 IMAP 收信，实测会稳定触发 Cloudflare 的 **error 1102（CPU 超限）**。根因经 A/B 实测确认：

| 状态 | `POST /api/web/email/fetch` | 说明 |
| --- | --- | --- |
| 正常 IMAP 代码 | `HTTP 503` + `error code: 1102` | CPU 超限 |
| 跳过 IMAP 路径后 | `HTTP 200` + 正常 JSON | 其余逻辑远低于限额 |

**Cloudflare 免费套餐的 CPU 上限是 10ms/请求**（硬上限，无法调高），而一次 IMAP（TLS 握手 + 协议往返 + 解析）必然超过它。更关键的是：

- **Email Worker 在免费套餐同样只有 10ms CPU**（官方限额文档明确说明）
- **Cron Trigger 在免费套餐同样只有 10ms CPU** —— 所以「后台定时拉取」也救不了
- `limits.cpu_ms` 只有**付费套餐**才被接受（免费套餐 deploy 会被拒收）

**结论：在免费套餐上，只要"在 Worker 里做 MIME 解析/IMAP 收信"就必然失败。**

v2 的解法是把重活全部挪出 Worker：

1. **收信**：由 Email Worker 接收，只提取头字段（`message.headers` 由 Cloudflare 预先解析，取字段几乎零成本），原始邮件**流式**写入 R2
2. **列表**：只读 D1 元数据（毫秒级）
3. **详情/附件**：Worker 把原始 `.eml` 从 R2 **流式吐给浏览器**，由前端 `postal-mime` 在浏览器里解析

三条路径的 CPU 占用都压在 10ms 以内，且**完全不需要 OAuth 授权、不需要应用密码**。

---

## 二、架构与收信流程

```
你的邮箱 (Gmail / Outlook / QQ / 163 …)
   │  在邮箱设置里开启「自动转发」
   ▼
专属转发地址 f-a1b2c3@你的收信域名
   │  (每个绑定的邮箱都有一个唯一地址)
   ▼
Cloudflare Email Routing
   │  Routing rules → Send to Worker
   ▼
Email Worker (src/email.ts)
   ├─ 判定归属: 别名 > 主邮箱 > 专属转发地址
   ├─ 原始邮件 ──────────────► R2 (EMAIL_RAW)
   └─ 元数据 ────────────────► D1 (emails 表)
                                   │
   浏览器 ◄── 列表/详情 API ◄───────┘
     │
     └─ 下载 raw (.eml) → postal-mime 浏览器端解析正文与附件
```

**归属判定**（决定这封邮件属于哪个邮箱 / 别名）参考了开源项目 [Alle](https://github.com/bestruirui/Alle) 的候选头优先级，按序尝试：

```
duck-original-to → x-original-to → original-recipient → x-github-recipient-address
→ destinations → resent-to → to → delivered-to → x-forwarded-to → x-envelope-to → cc
```

匹配顺序为：**先匹配别名 → 再匹配主邮箱 → 最后用信封收件人匹配专属转发地址**（后者作为原始收件人丢失时的兜底）。

---

## 三、部署步骤

### 1. 开通 Cloudflare 资源

```bash
# 先登录（或设置 CLOUDFLARE_API_TOKEN 环境变量）
npx wrangler login

# 一键开通 D1 / KV / R2 并自动回填 wrangler.toml
bash scripts/provision.sh
```

脚本会创建：

| 资源 | 名称 | 用途 |
| --- | --- | --- |
| D1 | `mail_alias_v2` | 用户 / 邮箱 / 邮件元数据 / Webhook |
| KV | `MAIL_ALIAS_V2_KV` | 会话缓存、Webhook 推送去重 |
| R2 | `mail-alias-v2-raw` | 原始邮件 `.eml` |

### 2. 修改 `wrangler.toml`

至少改这两处（**必填**）：

```toml
[vars]
# 收信域名：必须是已接入 Cloudflare 并开启 Email Routing 的域名
RECV_DOMAIN = "你的收信域名.com"

# 兜底账号 ID（可选但强烈推荐）：所有归属失败的邮件直接交给这个账号。
# 适合「所有外部邮箱统一转发到一个固定地址，最终全部进一个收件箱」的用法。
# 先绑定一个邮箱，拿到它的 id（在「我的账户」里能看到），再填到这里。
CATCHALL_ACCOUNT_ID = "va3d4d01a"

ADMIN_USERNAME = "admin"
ADMIN_PASSWORD = "请修改为你的强密码"
```

建议再用 `wrangler secret` 写入安全密钥（不要明文提交）：

```bash
npx wrangler secret put JWT_SECRET
npx wrangler secret put ENCRYPT_KEY
```

### 3. 推送部署

```bash
git add -A && git commit -m "..." && git push origin cloudflarev2
```

`.github/workflows/deploy-v2.yml` 会自动执行：类型检查 → 应用 D1 schema → `wrangler deploy`。
（复用仓库已有的 `CLOUDFLARE_API_TOKEN` secret）

### 4. 配置 Email Routing（**关键，只能在 Cloudflare 后台做**）

1. 域名接入 Cloudflare
2. 进入 **Email → Email Routing**
3. 开启 Email Routing（Cloudflare 会自动写入 MX 记录）
4. **Routing rules → Create address**（或 Catch-all）→ 动作选 **Send to Worker** → 选择 `mail-alias-v2`
5. **Destination addresses** 里不需要额外验证（邮件交给 Worker 处理，不再转发到别的邮箱）

> 邮箱只能收到"投递到你域名下地址"的邮件。用户是在**自己的邮箱**（Gmail 等）里设置转发到我们分配的专属转发地址，所以这里只要能收到那个地址的信即可。

### 5. 验证 MX 是否生效

```bash
dig MX 你的域名 +short
# 应看到 route1/route2/route3.mx.cloudflare.net
```

若 MX 不是 Cloudflare 的，说明 Email Routing 没真正开起来，收不到任何邮件。

---

## 三·补、收信排查：转发到底通没通

「收信状态」长期显示 **待配置转发**，说明邮件还没进库。按下面顺序定位：

**① 先看邮件有没有到达 Worker**

我的账户 → **收信诊断** → 「最近到达但未识别的收件」：

- **有记录** → Cloudflare Email Routing 与路由规则都是通的，只是这个收件地址没登记到任何邮箱。
  把该行的「投递到」地址填进对应邮箱的「专属转发地址」即可（编辑邮箱里可改）。
- **没有记录** → 邮件根本没到 Worker，继续看 ②。

**② 用转发自检验证归属**

收信诊断 → 「转发自检」，把你在原邮箱（Outlook / Gmail）里填的转发目标地址粘进去：

- `✓ 可正常收信（归属 xxx）` → 地址没问题，是原邮箱的转发还没生效。
- `✗ 无法归属` → 该地址没登记；到「编辑邮箱」把它设为专属转发地址。

**③ 原邮箱侧的转发需要确认**

大多数邮箱（尤其 **Outlook / Hotmail**）设置自动转发后，会往转发目标发一封**确认邮件**，
必须点开里面的链接，转发才会真正启用。

现在目标地址已经指向本 Worker，所以这封确认邮件会**直接出现在系统收件箱里**（前提是地址已登记）。
登录后在对应邮箱的邮件列表里找到它、点链接确认即可。

**④ 常见坑**

| 现象 | 原因 |
|---|---|
| MX 不是 `*.mx.cloudflare.net` | Email Routing 未真正开启 |
| 路由规则动作选成了 "Send to email" | 必须选 **Send to Worker** |
| Outlook 转发一直不生效 | 没点确认邮件里的链接 |
| 地址已登记但状态仍为 0 | 发一封普通邮件到该地址自测；若仍无记录，检查路由规则是否对该地址生效 |
| 出现 `error code: 1102` | CPU 超限；检查是否在收信路径里加了 MIME 解析（本项目刻意不解析） |

**⑤ 自定义转发地址**

专属转发地址可以在「编辑邮箱」里直接改成你已经在原邮箱配好的地址（例如 `alle@你的域名`），
这样**不用去改原邮箱的设置**。系统内该地址必须唯一，重复时会提示「已被其它邮箱占用」。
若希望每个邮箱严格隔离，建议保留自动生成的 `f-xxxxx@域名` 形式。

---

## 四、使用说明

### 添加邮箱（免授权）

1. 进入 **我的账户 → 邮箱绑定 → 添加邮箱**
2. 只填**主邮箱地址**，可选填备注
3. 两个开关：
   - **支持别名**（默认**关闭**）：关闭时该邮箱只能被直接选中收信，不能生成别名；开启后才能按别名规则派生别名地址
   - **公开共享**：开启后其他用户也能使用这个邮箱（及其别名）
4. 提交后会弹出**专属转发地址**，去原邮箱设置里把收到的邮件**自动转发**到该地址

各邮箱设置转发的位置：

| 邮箱 | 路径 |
| --- | --- |
| Gmail | 设置 → 查看所有设置 → 转发和 POP/IMAP → 添加转发地址 |
| Outlook | 设置 → 邮件 → 转发 → 启用转发 |
| QQ / 163 | 设置 → 收信规则 / 自动转发 |

邮箱列表的**收信状态**列会显示「已收 N 封」或「待配置转发」，用来确认转发是否生效。

### 别名

只有开启了**支持别名**的邮箱才能创建别名。别名规则模板支持占位符：

| 占位符 | 含义 |
| --- | --- |
| `{local}` | 邮箱前缀（如 `jkjk857857`） |
| `{domain}` | 域名（如 `gmail.com`） |
| `{label}` | 别名标签（如 `shop`） |

- 加号别名（Gmail 等）：`{local}+{label}@{domain}` → `jkjk857857+shop@gmail.com`
- 独立域名通配（catch-all）：`{label}@{domain}` → `shop@example.com`

别名沿用 v1 规则：每人最多 5 个同时生效、1 小时有效期（可续期/恢复）、支持收藏置顶。

---

## 五、权限模型（账户分离）

| 维度 | 说明 |
| --- | --- |
| 普通用户 | 只能看到/查询**自己绑定的邮箱**的邮件 |
| 公开共享 | 邮箱开启 `公开共享` 后，其他用户可在「可用邮箱」里选中并使用（含其别名） |
| 管理员 | 可管理所有用户、所有邮箱；可整箱查询 |
| 越权防护 | 列表/详情/标记已读等接口都会校验 `account_id` 归属（自己的 或 `is_public=1`），不信任任何前端传入的身份 |

---

## 六、API

统一响应格式：`{ "code": 0, "msg": "success", "data": ... }`，`code != 0` 表示出错。
鉴权：`Authorization: Bearer <token>`（Web）或 `X-API-Key`（程序调用）。

### 邮箱绑定

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/account/mail_accounts` | 我绑定的邮箱 |
| `GET` | `/api/account/mail_accounts/available` | 可用邮箱（自己的 + 公开的） |
| `POST` | `/api/account/mail_accounts/imap` | **添加邮箱（免授权）** |
| `PATCH` | `/api/account/mail_accounts/:id` | 改别名规则 / 备注 / 别名开关 / 公开开关 |
| `PUT` | `/api/account/mail_accounts/:id/public` | 切换公开共享 |
| `GET` | `/api/account/mail_accounts/:id/status` | 收信状态（含转发地址、已收件数） |
| `DELETE` | `/api/account/mail_accounts/:id` | 删除邮箱 |

添加邮箱请求体：

```jsonc
{
  "email": "you@gmail.com",
  "is_public": false,        // 是否公开共享
  "supports_alias": false,   // 是否支持别名(默认 false)
  "alias_template": "{local}+{label}@{domain}",  // 可选,仅 supports_alias 为 true 时有意义
  "notes": "主收信箱"         // 可选备注
}
```

响应会带回 `forward_address`（专属转发地址）。

### 邮件查询

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/web/email/fetch` | 邮件列表（按别名 / 邮箱 / 关键字 / 时间 / 未读 / 分页） |
| `POST` | `/api/web/email/detail` | 邮件详情（元数据，含 `raw_url`） |
| `GET` | `/api/web/email/raw?id=xxx` | 下载原始 `.eml`（前端解析正文附件） |
| `POST` | `/api/web/email/mark_read` | 标记已读（优先按 `ids`） |
| `POST` | `/api/email/fetch` | API Key 版列表 |
| `POST` | `/api/email/mark_read` | API Key 版标记已读 |

列表请求体：

```jsonc
{
  "alias_id": "a0dc4aa2520e9",   // 可选: 只查某个别名
  "mail_account_id": "v1a2b3c4", // 可选: 只查某个邮箱
  "q": "验证码",                  // 可选: 主题/发件人/收件人 模糊搜索
  "unseen": false,               // 可选: 只看未读
  "start_time": "2026-08-01T00:00:00.000Z",  // 可选
  "end_time":   "2026-08-30T00:00:00.000Z",  // 可选
  "offset": 0,
  "limit": 10
}
```

列表返回的每封邮件都带 `raw_url`，前端按需下载解析即可得到正文与附件。

### 别名

| 方法 | 路径 |
| --- | --- |
| `GET` | `/api/account/aliases`（生效中） |
| `POST` | `/api/account/aliases`（创建，**要求邮箱 supports_alias=true**） |
| `GET` | `/api/account/aliases/history` |
| `POST` | `/api/account/aliases/:id/renew` / `restore` / `deactivate` / `favorite` |
| `DELETE` | `/api/account/aliases/:id` |

其余（登录、用户管理、Webhook、日志、设置）与 v1 保持一致。

---

## 七、目录结构

```
src/
  index.ts         Worker 入口:路由分发 + 静态资源 + Cron + email() 收信入口
  email.ts         【v2 核心】Email Worker 收信:归属判定 → R2 存原始邮件 → D1 存元数据
  emailService.ts  邮件查询服务(纯 D1 查询,不解析 MIME)
  db.ts            D1 数据访问:schema 迁移、邮箱绑定、邮件存储与查询
  routes.ts        HTTP 路由处理
  webhook.ts       Webhook 推送
  types.ts         类型定义
static/            前端 SPA(原生 JS,无构建步骤)
schema.sql         D1 初始 schema
scripts/provision.sh  一键开通 D1/KV/R2 并回填 wrangler.toml
```

---

## 八、与 v1 的差异

| 项目 | v1（`cloudflare`） | v2（`cloudflarev2`） |
| --- | --- | --- |
| 收信方式 | Worker 内 IMAP / Gmail API 实时拉 | **各邮箱自动转发 → Email Worker** |
| 绑定邮箱 | OAuth 授权 / 应用密码，需校验 | **只填主邮箱地址，零授权** |
| CPU 超限 | 稳定 1102（免费套餐） | 不会（收信/列表/详情均 <10ms） |
| 正文解析位置 | Worker 内解析 | **浏览器端 postal-mime 解析** |
| 原始邮件存储 | 无 | **R2**（`.eml`） |
| 别名开关 | 依赖邮箱域名判断 | **每个邮箱独立开关，默认关闭** |
| 死代码 | 含 OAuth / IMAP 模块 | 已移除 `imap.ts`（IMAP 相关） |

v1 的 OAuth 接口在 v2 中已不再被前端使用（保留仅为兼容）。

---

## 九、常见问题

**Q：邮件一直显示「待配置转发」？**
A：说明 Email Worker 还没收到该邮箱转发来的邮件。依次检查：① 域名 MX 记录是否由 Cloudflare 托管；② Email Routing 规则是否指向 `mail-alias-v2`；③ 原邮箱的自动转发是否已确认生效（Gmail 需要点确认邮件）。

**Q：支持发信吗？**
A：不支持。本系统只做收信聚合。

**Q：附件能下载吗？**
A：可以。详情弹窗里会列出附件并可直接下载 —— 附件是在浏览器里从 `.eml` 解析出来的，不占用 Worker 资源。

**Q：还能用 v1 吗？**
A：可以，两个 Worker 完全独立（v1 在 `cloudflare` 分支，v2 在 `cloudflarev2` 分支）。
