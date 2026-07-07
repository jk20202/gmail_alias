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

app = FastAPI(title="Gmail Alias Email API", version="3.0")
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
    gmail_email: str = ""
    gmail_token: str = ""


class AdminUserUpdate(BaseModel):
    password: Optional[str] = None
    is_admin: Optional[bool] = None
    gmail_email: Optional[str] = None
    gmail_token: Optional[str] = None


class AccountUpdate(BaseModel):
    gmail_email: Optional[str] = None
    gmail_token: Optional[str] = None


class AliasRequest(BaseModel):
    alias: str


class SettingsUpdate(BaseModel):
    allow_registration: bool


class FetchRequest(BaseModel):
    key: str
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
    key: str
    sender: Optional[str] = None
    subject: Optional[str] = None


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
    if req.gmail_email or req.gmail_token:
        user = user_store.update_user(user["id"], gmail_email=req.gmail_email, gmail_token=req.gmail_token)
    usage_log.add(admin["id"], admin["username"], "", "create_user", f"创建了用户 {req.username}")
    return {"code": 0, "msg": "success", "data": user}


@app.put("/api/admin/users/{user_id}")
async def admin_update_user(user_id: str, req: AdminUserUpdate, admin=Depends(require_admin)):
    user = user_store.update_user(user_id, req.password, req.is_admin, req.gmail_email, req.gmail_token)
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
            "summary": usage_log.stats_summary(),
            "logs": usage_log.list(limit=500),
        }
    }


@app.put("/api/admin/settings")
async def admin_update_settings(req: SettingsUpdate, admin=Depends(require_admin)):
    user_store.set_registration_allowed(req.allow_registration)
    usage_log.add(admin["id"], admin["username"], "", "update_settings", f"注册开关: {req.allow_registration}")
    return {"code": 0, "msg": "success", "data": {"allow_registration": req.allow_registration}}


@app.get("/api/admin/settings")
async def admin_get_settings(admin=Depends(require_admin)):
    return {"code": 0, "msg": "success", "data": {"allow_registration": user_store.get_registration_allowed()}}


# ==================== Account Self-Service ====================

@app.get("/api/account")
async def get_account(user=Depends(require_session)):
    return {"code": 0, "msg": "success", "data": user}


@app.put("/api/account")
async def update_account(req: AccountUpdate, user=Depends(require_session)):
    updated = user_store.update_user(user["id"], gmail_email=req.gmail_email, gmail_token=req.gmail_token)
    if not updated:
        raise HTTPException(status_code=404, detail="用户不存在")
    return {"code": 0, "msg": "success", "data": updated}


@app.post("/api/account/alias")
async def set_alias(req: AliasRequest, user=Depends(require_session)):
    alias = req.alias.strip()
    if not alias:
        raise HTTPException(status_code=400, detail="别名不能为空")
    if "@" not in alias:
        raise HTTPException(status_code=400, detail="别名格式错误，需包含@")
    updated = user_store.set_alias(user["id"], alias)
    if not updated:
        raise HTTPException(status_code=404, detail="用户不存在")
    usage_log.add(user["id"], user["username"], alias, "set_alias", f"设置了别名 {alias}")
    return {"code": 0, "msg": "success", "data": updated}


@app.post("/api/account/api_key")
async def regenerate_api_key(user=Depends(require_session)):
    updated = user_store.regenerate_api_key(user["id"])
    if not updated:
        raise HTTPException(status_code=404, detail="用户不存在")
    usage_log.add(user["id"], user["username"], "", "regen_api_key", "重新生成了API Key")
    return {"code": 0, "msg": "success", "data": updated}


# ==================== Email API (key-based) ====================

@app.post("/api/email/fetch")
async def api_fetch_emails(req: FetchRequest, user=Depends(require_api_key)):
    email_addr = user.get("gmail_email", "")
    email_token = user.get("gmail_token", "")
    if not email_addr or not email_token:
        raise HTTPException(status_code=400, detail="未配置Gmail邮箱，请先在后台设置")

    # 普通用户强制使用别名过滤，管理员不过滤
    to_filter = req.to
    if not user.get("is_admin"):
        alias = user.get("alias", "")
        if alias:
            to_filter = alias
        elif not to_filter:
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
    email_addr = user.get("gmail_email", "")
    email_token = user.get("gmail_token", "")
    if not email_addr or not email_token:
        raise HTTPException(status_code=400, detail="未配置Gmail邮箱")

    try:
        count = await mark_emails_read(email_addr, email_token, req.sender, req.subject)
        usage_log.add(user["id"], user["username"], user.get("alias", ""), "mark_read", f"标记{count}封已读")
        return {"code": 0, "msg": "success", "data": {"marked": count}}
    except Exception as e:
        return JSONResponse(status_code=500, content={"code": 1, "msg": f"IMAP错误: {str(e)}", "data": None})


# ==================== Web Email Query (session-based) ====================

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


@app.post("/api/web/email/fetch")
async def web_fetch_emails(req: WebFetchRequest, user=Depends(require_session)):
    email_addr = user.get("gmail_email", "")
    email_token = user.get("gmail_token", "")
    if not email_addr or not email_token:
        raise HTTPException(status_code=400, detail="未配置Gmail邮箱，请先在账户设置中配置")

    raw_user = user_store.get_user_raw(user["id"])
    email_token = raw_user.get("gmail_token", "")

    to_filter = req.to
    if not user.get("is_admin"):
        alias = user.get("alias", "")
        if alias:
            to_filter = alias
        elif not to_filter:
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
