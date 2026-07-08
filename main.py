import os
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo
from typing import Optional

from fastapi import FastAPI, HTTPException, Depends, Request, Query
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from email_service import fetch_emails, mark_emails_read
from user_store import UserStore
from usage_log import UsageLog

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
SHANGHAI_TZ = ZoneInfo("Asia/Shanghai")

app = FastAPI(title="Gmail Alias Email API", version="3.1")
user_store = UserStore()
usage_log = UsageLog()

app.mount("/static", StaticFiles(directory=os.path.join(BASE_DIR, "static")), name="static")


# ==================== Auth ====================

def require_session(request: Request):
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="未登录或会话过期")
    token = auth[7:]
    user = user_store.get_user_by_session(token)
    if not user:
        raise HTTPException(status_code=401, detail="未登录或会话过期")
    return user


def require_admin(user=Depends(require_session)):
    if not user.get("is_admin"):
        raise HTTPException(status_code=403, detail="需要管理员权限")
    return user


def require_api_key(key: str = Query(..., description="32位API密钥")):
    user = user_store.get_user_by_api_key(key)
    if not user:
        raise HTTPException(status_code=401, detail="无效的API Key")
    return user


# ==================== Models ====================

class LoginRequest(BaseModel):
    username: str
    password: str


class RegisterRequest(BaseModel):
    username: str
    password: str


class AdminUserCreate(BaseModel):
    username: str
    password: str
    is_admin: bool = False


class AdminUserUpdate(BaseModel):
    password: Optional[str] = None
    is_admin: Optional[bool] = None


class GmailAccountCreate(BaseModel):
    email: str
    token: str = ""
    provider: str = "gmail"
    is_public: bool = False


class GmailAccountUpdate(BaseModel):
    email: Optional[str] = None
    token: Optional[str] = None
    provider: Optional[str] = None
    is_public: Optional[bool] = None


class AliasRequest(BaseModel):
    gmail_account_id: str
    label: str


class SettingsUpdate(BaseModel):
    allow_registration: bool


class FetchRequest(BaseModel):
    to: Optional[str] = None
    sender: Optional[str] = None
    subject: Optional[str] = None
    body: Optional[str] = None
    keyword: Optional[str] = None
    unseen: Optional[bool] = None
    start_time: Optional[str] = None
    end_time: Optional[str] = None
    limit: int = 50


class MarkReadRequest(BaseModel):
    to: str
    sender: Optional[str] = None
    subject: Optional[str] = None


class WebFetchRequest(BaseModel):
    to: Optional[str] = None
    sender: Optional[str] = None
    subject: Optional[str] = None
    body: Optional[str] = None
    keyword: Optional[str] = None
    unseen: Optional[bool] = None
    start_time: Optional[str] = None
    end_time: Optional[str] = None
    limit: int = 50
    gmail_account_id: Optional[str] = None


# ==================== Pages ====================

@app.get("/", response_class=HTMLResponse)
async def index():
    with open(os.path.join(BASE_DIR, "static", "index.html"), "r", encoding="utf-8") as f:
        return f.read()


@app.get("/health")
async def health():
    return {"status": "ok", "users": len(user_store.list_users())}


# ==================== Auth API ====================

@app.post("/api/auth/login")
async def login(req: LoginRequest):
    token, user = user_store.login(req.username, req.password)
    if not token:
        raise HTTPException(status_code=401, detail="用户名或密码错误")
    return {"code": 0, "msg": "success", "data": {"session_token": token, "user": user}}


@app.post("/api/auth/register")
async def register(req: RegisterRequest):
    if not user_store.get_registration_allowed():
        raise HTTPException(status_code=403, detail="管理员已关闭注册功能")
    if len(req.username) < 3:
        raise HTTPException(status_code=400, detail="用户名至少3个字符")
    if len(req.password) < 6:
        raise HTTPException(status_code=400, detail="密码至少6个字符")
    user = user_store.create_user(req.username, req.password, is_admin=False)
    if not user:
        raise HTTPException(status_code=409, detail="用户名已存在")
    return {"code": 0, "msg": "success", "data": user}


@app.post("/api/auth/logout")
async def logout(request: Request):
    auth = request.headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        user_store.logout(auth[7:])
    return {"code": 0, "msg": "success"}


@app.get("/api/auth/me")
async def me(user=Depends(require_session)):
    return {"code": 0, "msg": "success", "data": user}


# ==================== Admin API ====================

@app.get("/api/admin/users")
async def admin_list_users(admin=Depends(require_admin)):
    return {"code": 0, "msg": "success", "data": user_store.list_users()}


@app.post("/api/admin/users")
async def admin_create_user(req: AdminUserCreate, admin=Depends(require_admin)):
    user = user_store.create_user(req.username, req.password, req.is_admin)
    if not user:
        raise HTTPException(status_code=409, detail="用户名已存在")
    usage_log.add(admin["id"], admin["username"], "", "create_user", f"创建了用户 {req.username}")
    return {"code": 0, "msg": "success", "data": user}


@app.put("/api/admin/users/{user_id}")
async def admin_update_user(user_id: str, req: AdminUserUpdate, admin=Depends(require_admin)):
    user = user_store.update_user(user_id, req.password, req.is_admin)
    if not user:
        raise HTTPException(status_code=404, detail="用户不存在")
    usage_log.add(admin["id"], admin["username"], "", "update_user", f"更新了用户 {user['username']}")
    return {"code": 0, "msg": "success", "data": user}


@app.delete("/api/admin/users/{user_id}")
async def admin_delete_user(user_id: str, admin=Depends(require_admin)):
    if user_id == "admin":
        raise HTTPException(status_code=400, detail="不能删除管理员账户")
    ok = user_store.delete_user(user_id)
    if not ok:
        raise HTTPException(status_code=404, detail="用户不存在")
    usage_log.add(admin["id"], admin["username"], "", "delete_user", f"删除了用户 {user_id}")
    return {"code": 0, "msg": "success"}


@app.get("/api/admin/stats")
async def admin_stats(admin=Depends(require_admin)):
    return {
        "code": 0, "msg": "success",
        "data": {
            "summary": {**usage_log.stats_summary(), "gmail_account_count": sum(len(u.get("gmail_accounts", [])) for u in user_store.list_users())},
            "logs": usage_log.list(limit=500),
        }
    }


@app.put("/api/admin/settings")
async def admin_update_settings(req: SettingsUpdate, admin=Depends(require_admin)):
    user_store.set_registration_allowed(req.allow_registration)
    usage_log.add(admin["id"], admin["username"], "", "update_settings", f"注册开关: {req.allow_registration}")
    return {"code": 0, "msg": "success", "data": {"allow_registration": req.allow_registration}}


@app.get("/api/admin/settings")
async def get_settings():
    # 公开接口：仅返回注册开关布尔值，供登录页判断是否展示注册入口
    return {"code": 0, "msg": "success", "data": {"allow_registration": user_store.get_registration_allowed()}}


@app.get("/api/admin/gmail_accounts")
async def admin_list_all_gmail_accounts(admin=Depends(require_admin)):
    """管理员: 列出所有用户绑定的主邮箱"""
    return {"code": 0, "msg": "success", "data": user_store.admin_list_all_gmail_accounts()}


@app.put("/api/admin/users/{user_id}/gmail_accounts/{ga_id}")
async def admin_update_gmail_account(user_id: str, ga_id: str, req: GmailAccountUpdate, admin=Depends(require_admin)):
    """管理员: 修改任意用户的主邮箱"""
    if req.email is not None and "@" not in req.email:
        raise HTTPException(status_code=400, detail="邮箱格式错误")
    if req.token is not None and len(req.token) < 8:
        raise HTTPException(status_code=400, detail="应用密码长度不足")
    updated = user_store.admin_update_gmail_account(user_id, ga_id, req.email, req.token, req.is_public, req.provider)
    if not updated:
        raise HTTPException(status_code=404, detail="邮箱账号不存在")
    usage_log.add(admin["id"], admin["username"], "", "admin_update_gmail", f"管理员修改了用户 {user_id} 的邮箱 {ga_id}")
    return {"code": 0, "msg": "success", "data": updated}


@app.delete("/api/admin/users/{user_id}/gmail_accounts/{ga_id}")
async def admin_delete_gmail_account(user_id: str, ga_id: str, admin=Depends(require_admin)):
    """管理员: 删除任意用户的主邮箱"""
    updated = user_store.admin_delete_gmail_account(user_id, ga_id)
    if not updated:
        raise HTTPException(status_code=404, detail="邮箱账号不存在")
    usage_log.add(admin["id"], admin["username"], "", "admin_delete_gmail", f"管理员删除了用户 {user_id} 的邮箱 {ga_id}")
    return {"code": 0, "msg": "success", "data": updated}


# ==================== Account Self-Service ====================

@app.get("/api/account")
async def get_account(user=Depends(require_session)):
    return {"code": 0, "msg": "success", "data": user}


@app.post("/api/account/api_key")
async def regenerate_api_key(user=Depends(require_session)):
    updated = user_store.regenerate_api_key(user["id"])
    if not updated:
        raise HTTPException(status_code=404, detail="用户不存在")
    usage_log.add(user["id"], user["username"], "", "regen_api_key", "重新生成了API Key")
    return {"code": 0, "msg": "success", "data": updated}


# ==================== Gmail Accounts ====================

@app.get("/api/account/gmail_accounts")
async def list_gmail_accounts(user=Depends(require_session)):
    return {"code": 0, "msg": "success", "data": user_store.list_gmail_accounts(user["id"])}


@app.post("/api/account/gmail_accounts")
async def add_gmail_account(req: GmailAccountCreate, user=Depends(require_session)):
    if "@" not in req.email:
        raise HTTPException(status_code=400, detail="邮箱格式错误")
    if req.provider != "outlook" and len(req.token) < 8:
        raise HTTPException(status_code=400, detail="应用密码长度不足")
    # outlook 走 OAuth,创建时 token 留空,创建后引导用户完成授权
    token = req.token if req.provider != "outlook" else ""
    updated = user_store.add_gmail_account(user["id"], req.email, token, req.is_public, req.provider)
    if not updated:
        raise HTTPException(status_code=404, detail="用户不存在")
    usage_log.add(user["id"], user["username"], "", "add_gmail", f"绑定了邮箱 {req.email} ({req.provider})")
    return {"code": 0, "msg": "success", "data": updated}


@app.put("/api/account/gmail_accounts/{ga_id}")
async def update_gmail_account(ga_id: str, req: GmailAccountUpdate, user=Depends(require_session)):
    updated = user_store.update_gmail_account(user["id"], ga_id, req.email, req.token, req.is_public, req.provider)
    if not updated:
        raise HTTPException(status_code=404, detail="邮箱账号不存在")
    usage_log.add(user["id"], user["username"], "", "update_gmail", f"更新了邮箱配置 {ga_id}")
    return {"code": 0, "msg": "success", "data": updated}


@app.delete("/api/account/gmail_accounts/{ga_id}")
async def delete_gmail_account(ga_id: str, user=Depends(require_session)):
    updated = user_store.delete_gmail_account(user["id"], ga_id)
    if not updated:
        raise HTTPException(status_code=404, detail="邮箱账号不存在")
    usage_log.add(user["id"], user["username"], "", "delete_gmail", f"删除了邮箱配置 {ga_id}")
    return {"code": 0, "msg": "success", "data": updated}


@app.get("/api/gmail_accounts/available")
async def list_available_gmail_accounts(user=Depends(require_session)):
    """获取可用谷歌邮箱列表(自己的全部+别人公开的)，不含 token"""
    return {"code": 0, "msg": "success", "data": user_store.list_available_gmail_accounts(user["id"])}


# ==================== Alias ====================

@app.post("/api/account/alias")
async def set_alias(req: AliasRequest, user=Depends(require_session)):
    label = req.label.strip()
    if not label:
        raise HTTPException(status_code=400, detail="别名标签不能为空")
    updated, err = user_store.set_alias(user["id"], req.gmail_account_id, label)
    if err:
        raise HTTPException(status_code=400, detail=err)
    if not updated:
        raise HTTPException(status_code=404, detail="用户不存在")
    usage_log.add(user["id"], user["username"], updated.get("alias", {}).get("full", "") if updated.get("alias") else "", "set_alias", f"设置了别名")
    return {"code": 0, "msg": "success", "data": updated}


@app.get("/api/account/alias/random_label")
async def random_label(user=Depends(require_session)):
    return {"code": 0, "msg": "success", "data": {"label": user_store.gen_random_label()}}


# ==================== Email API (key-based) ====================

def _resolve_gmail_creds(user, gmail_account_id=None, to_email=None):
    """根据用户和可选的 gmail_account_id 或 to_email 解析出邮箱地址、token 和 provider"""
    user_id = user["id"]

    # 优先使用指定的 gmail_account_id (web 页面用)
    if gmail_account_id:
        ga = user_store.get_gmail_account_raw(user_id, gmail_account_id)
        if not ga:
            return None, None, None, "未找到指定的谷歌邮箱或无权使用"
        return ga["email"], ga["token"], ga.get("provider", "gmail"), None

    # API 调用: 根据 to_email 反查主邮箱凭据
    if to_email:
        if "@" not in to_email:
            return None, None, None, "to 邮箱格式错误"
        to_prefix, to_domain = to_email.split("@", 1)
        # 遍历可用邮箱，按 domain + 前缀匹配(兼容 gmail +别名 / 2925 _别名或直接追加)
        candidates = []
        for ga in user_store.list_available_gmail_accounts(user_id):
            ga_email = ga["email"]
            if "@" not in ga_email:
                continue
            ga_prefix, ga_domain = ga_email.split("@", 1)
            if ga_domain.lower() != to_domain.lower():
                continue
            gp = ga_prefix.lower()
            tp = to_prefix.lower()
            if tp == gp:
                candidates.append((len(gp), ga))
            elif ga.get("provider") == "2925":
                # 2925 子邮箱 = 主前缀 + 任意后缀(可带 _ 或直接追加)
                if tp.startswith(gp):
                    candidates.append((len(gp), ga))
            else:
                # gmail 子邮箱必须用 + 分隔
                if tp.startswith(gp + "+"):
                    candidates.append((len(gp), ga))
        # 取最长前缀匹配，避免 jin@ 误匹配 jinkaifu999@
        if candidates:
            candidates.sort(key=lambda x: x[0], reverse=True)
            raw = user_store.get_gmail_account_raw(user_id, candidates[0][1]["id"])
            if raw:
                return raw["email"], raw["token"], raw.get("provider", "gmail"), None
        return None, None, None, f"未找到 {to_email} 对应的主邮箱或无权使用"

    # 无 to_email 且无 gmail_account_id: 用别名关联的邮箱(web 默认场景)
    alias = user.get("alias")
    if alias:
        ga_id = alias.get("gmail_account_id") if isinstance(alias, dict) else None
        ga = user_store.get_gmail_account_raw(user_id, ga_id) if ga_id else None
        if not ga:
            return None, None, None, "别名关联的谷歌邮箱不存在或已删除"
        return ga["email"], ga["token"], ga.get("provider", "gmail"), None

    return None, None, None, "未指定查询邮箱"


@app.post("/api/email/fetch")
async def api_fetch_emails(req: FetchRequest, user=Depends(require_api_key)):
    # API 调用必须指定 to 查询邮箱，与页面别名查询互不干扰
    if not req.to:
        raise HTTPException(status_code=400, detail="API调用必须指定to查询邮箱")

    email_addr, email_token, provider, err = _resolve_gmail_creds(user, to_email=req.to)
    if err:
        raise HTTPException(status_code=400, detail=err)

    to_filter = req.to  # 用 to 参数过滤，不再用 alias

    now = datetime.now(SHANGHAI_TZ)
    default_start = (now - timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%S")
    default_end = now.strftime("%Y-%m-%dT%H:%M:%S")

    try:
        emails = await fetch_emails(
            email_addr=email_addr,
            token=email_token,
            to=to_filter,
            sender=req.sender,
            subject=req.subject,
            body=req.body,
            keyword=req.keyword,
            unseen=req.unseen,
            start_time=req.start_time,
            end_time=req.end_time,
            limit=req.limit,
            provider=provider,
        )
        usage_log.add(
            user["id"], user["username"], to_filter or "(全部)",
            "fetch_emails", f"获取了{len(emails)}封邮件"
        )
        return {
            "code": 0, "msg": "success",
            "data": {
                "total": len(emails),
                "emails": emails,
                "query": {
                    "email": email_addr,
                    "to": to_filter,
                    "sender": req.sender,
                    "subject": req.subject,
                    "body": req.body,
                    "keyword": req.keyword,
                    "unseen": req.unseen,
                    "start_time": req.start_time or default_start,
                    "end_time": req.end_time or default_end,
                    "limit": req.limit,
                },
            },
        }
    except HTTPException:
        raise
    except Exception as e:
        return JSONResponse(status_code=500, content={"code": 1, "msg": f"IMAP错误: {str(e)}", "data": None})


@app.post("/api/email/mark_read")
async def api_mark_read(req: MarkReadRequest, user=Depends(require_api_key)):
    email_addr, email_token, provider, err = _resolve_gmail_creds(user, to_email=req.to)
    if err:
        raise HTTPException(status_code=400, detail=err)

    try:
        count = await mark_emails_read(email_addr, email_token, req.sender, req.subject, provider)
        usage_log.add(user["id"], user["username"], req.to, "mark_read", f"标记{count}封已读")
        return {"code": 0, "msg": "success", "data": {"marked": count}}
    except Exception as e:
        return JSONResponse(status_code=500, content={"code": 1, "msg": f"IMAP错误: {str(e)}", "data": None})


# ==================== Web Email Query (session-based) ====================

@app.post("/api/web/email/fetch")
async def web_fetch_emails(req: WebFetchRequest, user=Depends(require_session)):
    raw_user = user_store.get_user_raw(user["id"])

    email_addr, email_token, provider, err = _resolve_gmail_creds(raw_user, req.gmail_account_id)
    if err:
        raise HTTPException(status_code=400, detail=err)

    to_filter = req.to
    alias = user.get("alias")
    if alias:
        # 所有用户(含管理员)有别名时强制按别名过滤，防止越权
        to_filter = alias.get("full", "") if isinstance(alias, dict) else ""
    elif not user.get("is_admin") and not to_filter:
        raise HTTPException(status_code=400, detail="未设置别名邮箱，请先创建别名")

    now = datetime.now(SHANGHAI_TZ)
    default_start = (now - timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%S")
    default_end = now.strftime("%Y-%m-%dT%H:%M:%S")

    try:
        emails = await fetch_emails(
            email_addr=email_addr,
            token=email_token,
            to=to_filter,
            sender=req.sender,
            subject=req.subject,
            body=req.body,
            keyword=req.keyword,
            unseen=req.unseen,
            start_time=req.start_time,
            end_time=req.end_time,
            limit=req.limit,
            provider=provider,
        )
        usage_log.add(user["id"], user["username"], to_filter or "(全部)", "web_fetch", f"获取了{len(emails)}封邮件")
        return {
            "code": 0, "msg": "success",
            "data": {
                "total": len(emails),
                "emails": emails,
                "query": {
                    "email": email_addr,
                    "to": to_filter,
                    "sender": req.sender,
                    "subject": req.subject,
                    "keyword": req.keyword,
                    "unseen": req.unseen,
                    "start_time": req.start_time or default_start,
                    "end_time": req.end_time or default_end,
                    "limit": req.limit,
                },
            },
        }
    except HTTPException:
        raise
    except Exception as e:
        return JSONResponse(status_code=500, content={"code": 1, "msg": f"IMAP错误: {str(e)}", "data": None})


# ==================== Microsoft OAuth 授权 ====================

@app.get("/api/ms_auth/start")
async def ms_auth_start(ga_id: str, user=Depends(require_session)):
    """生成微软 OAuth 授权 URL,前端跳转过去让用户登录"""
    import ms_oauth
    # 校验该 ga_id 属于当前用户
    ga = user_store.get_gmail_account_raw(user["id"], ga_id)
    if not ga:
        raise HTTPException(status_code=404, detail="邮箱账号不存在或无权操作")
    if ga.get("provider") != "outlook":
        raise HTTPException(status_code=400, detail="仅微软邮箱需要 OAuth 授权")
    auth_url, state = ms_oauth.get_auth_url(user["id"], ga_id)
    return {"code": 0, "msg": "success", "data": {"auth_url": auth_url, "state": state}}


@app.get("/api/ms_auth/callback")
async def ms_auth_callback(code: str, state: str):
    """微软 OAuth 回调:用 code 换 token 并回写到对应邮箱账户"""
    import ms_oauth
    payload = ms_oauth._decode_state(state)
    if not payload:
        return HTMLResponse("<h3>授权失败: state 参数无效</h3>", status_code=400)
    user_id = payload.get("u")
    ga_id = payload.get("g")
    if not user_id or not ga_id:
        return HTMLResponse("<h3>授权失败: state 信息缺失</h3>", status_code=400)
    ga = user_store.get_gmail_account_raw(user_id, ga_id)
    if not ga:
        return HTMLResponse("<h3>授权失败: 邮箱账号不存在</h3>", status_code=404)
    try:
        token_data = ms_oauth.exchange_code_for_token(code)
        token_json = ms_oauth.save_token_str(token_data)
        ok = user_store.update_outlook_token_by_email(ga["email"], token_json)
        if not ok:
            return HTMLResponse("<h3>授权失败: token 回写失败</h3>", status_code=500)
    except Exception as e:
        return HTMLResponse(f"<h3>授权失败: {e}</h3>", status_code=500)
    usage_log.add(user_id, "", ga["email"], "ms_oauth", f"微软邮箱 {ga['email']} 授权成功")
    return HTMLResponse(
        "<h3>授权成功!</h3><p>微软邮箱已绑定,可关闭此页面返回管理系统。</p>"
        "<script>setTimeout(()=>window.close(),3000);</script>"
    )


@app.post("/api/ms_auth/reauth/{ga_id}")
async def ms_auth_reauth(ga_id: str, user=Depends(require_session)):
    """清除 OAuth token 并重新发起授权(用于 token 失效后重新授权)"""
    ga = user_store.get_gmail_account_raw(user["id"], ga_id)
    if not ga:
        raise HTTPException(status_code=404, detail="邮箱账号不存在或无权操作")
    if ga.get("provider") != "outlook":
        raise HTTPException(status_code=400, detail="仅微软邮箱需要 OAuth 授权")
    user_store.update_outlook_token_by_email(ga["email"], "")
    import ms_oauth
    auth_url, state = ms_oauth.get_auth_url(user["id"], ga_id)
    return {"code": 0, "msg": "success", "data": {"auth_url": auth_url, "state": state}}


# 注册 OAuth token 自动刷新后的回写回调
def _on_outlook_token_refreshed(email_addr, new_token_json):
    user_store.update_outlook_token_by_email(email_addr, new_token_json)

import email_service
email_service.set_outlook_token_refresh_callback(_on_outlook_token_refreshed)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
