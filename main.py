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
    token: str
    is_public: bool = False


class GmailAccountUpdate(BaseModel):
    email: Optional[str] = None
    token: Optional[str] = None
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
    updated = user_store.admin_update_gmail_account(user_id, ga_id, req.email, req.token, req.is_public)
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
    if len(req.token) < 8:
        raise HTTPException(status_code=400, detail="应用密码长度不足")
    updated = user_store.add_gmail_account(user["id"], req.email, req.token, req.is_public)
    if not updated:
        raise HTTPException(status_code=404, detail="用户不存在")
    usage_log.add(user["id"], user["username"], "", "add_gmail", f"绑定了邮箱 {req.email}")
    return {"code": 0, "msg": "success", "data": updated}


@app.put("/api/account/gmail_accounts/{ga_id}")
async def update_gmail_account(ga_id: str, req: GmailAccountUpdate, user=Depends(require_session)):
    updated = user_store.update_gmail_account(user["id"], ga_id, req.email, req.token, req.is_public)
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

def _resolve_gmail_creds(user, gmail_account_id=None):
    """根据用户和可选的 gmail_account_id 解析出邮箱地址和 token"""
    user_id = user["id"]
    is_admin = user.get("is_admin", False)

    # 优先使用指定的 gmail_account_id
    if gmail_account_id:
        ga = user_store.get_gmail_account_raw(user_id, gmail_account_id)
        if not ga:
            return None, None, "未找到指定的谷歌邮箱或无权使用"
        return ga["email"], ga["token"], None

    # 所有用户(含管理员)：有别名时用别名关联的 gmail_account
    alias = user.get("alias")
    if alias:
        ga_id = alias.get("gmail_account_id") if isinstance(alias, dict) else None
        ga = user_store.get_gmail_account_raw(user_id, ga_id) if ga_id else None
        if not ga:
            return None, None, "别名关联的谷歌邮箱不存在或已删除"
        return ga["email"], ga["token"], None

    # 无别名：管理员用第一个绑定的邮箱，普通用户报错
    if not is_admin:
        return None, None, "未设置别名邮箱，请先创建别名"
    accounts = user.get("gmail_accounts", [])
    if not accounts:
        return None, None, "未绑定谷歌邮箱"
    ga = user_store.get_gmail_account_raw(user_id, accounts[0]["id"])
    if not ga:
        return None, None, "谷歌邮箱配置异常"
    return ga["email"], ga["token"], None


@app.post("/api/email/fetch")
async def api_fetch_emails(req: FetchRequest, user=Depends(require_api_key)):
    email_addr, email_token, err = _resolve_gmail_creds(user)
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
    email_addr, email_token, err = _resolve_gmail_creds(user)
    if err:
        raise HTTPException(status_code=400, detail=err)

    try:
        count = await mark_emails_read(email_addr, email_token, req.sender, req.subject)
        alias_full = ""
        alias = user.get("alias")
        if alias and isinstance(alias, dict):
            alias_full = alias.get("full", "")
        usage_log.add(user["id"], user["username"], alias_full, "mark_read", f"标记{count}封已读")
        return {"code": 0, "msg": "success", "data": {"marked": count}}
    except Exception as e:
        return JSONResponse(status_code=500, content={"code": 1, "msg": f"IMAP错误: {str(e)}", "data": None})


# ==================== Web Email Query (session-based) ====================

@app.post("/api/web/email/fetch")
async def web_fetch_emails(req: WebFetchRequest, user=Depends(require_session)):
    raw_user = user_store.get_user_raw(user["id"])

    email_addr, email_token, err = _resolve_gmail_creds(raw_user, req.gmail_account_id)
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


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
