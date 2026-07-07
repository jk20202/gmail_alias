import os
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo
from typing import Optional

from fastapi import FastAPI, HTTPException, Depends, Request
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from email_service import fetch_emails, mark_emails_read
from account_store import AccountStore

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
ADMIN_TOKEN = os.environ.get("ADMIN_TOKEN", "admin123_")
SHANGHAI_TZ = ZoneInfo("Asia/Shanghai")

app = FastAPI(title="Gmail Alias Email API", version="2.0")
account_store = AccountStore()

app.mount("/static", StaticFiles(directory=os.path.join(BASE_DIR, "static")), name="static")


async def require_auth(request: Request):
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing or invalid Authorization header")
    token = auth[7:]
    if token != ADMIN_TOKEN:
        raise HTTPException(status_code=401, detail="Invalid token")
    return token


class LoginRequest(BaseModel):
    token: str


class AccountCreate(BaseModel):
    email: str
    token: str
    label: str = ""


class AccountUpdate(BaseModel):
    email: Optional[str] = None
    token: Optional[str] = None
    label: Optional[str] = None


class FetchRequest(BaseModel):
    account_id: Optional[str] = None
    email: Optional[str] = None
    token: Optional[str] = None
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
    account_id: Optional[str] = None
    email: Optional[str] = None
    token: Optional[str] = None
    sender: Optional[str] = None
    subject: Optional[str] = None


@app.get("/", response_class=HTMLResponse)
async def index():
    with open(os.path.join(BASE_DIR, "static", "index.html"), "r", encoding="utf-8") as f:
        return f.read()


@app.get("/health")
async def health():
    return {"status": "ok", "accounts": len(account_store.list_accounts())}


@app.post("/api/login")
async def login(req: LoginRequest):
    if req.token != ADMIN_TOKEN:
        raise HTTPException(status_code=401, detail="Invalid token")
    return {"code": 0, "msg": "success"}


@app.get("/api/accounts")
async def list_accounts(token: str = Depends(require_auth)):
    return {"code": 0, "msg": "success", "data": account_store.list_accounts()}


@app.post("/api/accounts")
async def create_account(req: AccountCreate, token: str = Depends(require_auth)):
    acc = account_store.add_account(req.email, req.token, req.label)
    return {"code": 0, "msg": "success", "data": {**acc, "token": acc["token"][:4] + "****" + acc["token"][-4:] if len(acc.get("token", "")) > 8 else "****"}}


@app.put("/api/accounts/{account_id}")
async def update_account(account_id: str, req: AccountUpdate, token: str = Depends(require_auth)):
    acc = account_store.update_account(account_id, req.email, req.token, req.label)
    if not acc:
        raise HTTPException(status_code=404, detail="Account not found")
    return {"code": 0, "msg": "success", "data": {**acc, "token": acc["token"][:4] + "****" + acc["token"][-4:] if len(acc.get("token", "")) > 8 else "****"}}


@app.delete("/api/accounts/{account_id}")
async def delete_account(account_id: str, token: str = Depends(require_auth)):
    ok = account_store.delete_account(account_id)
    if not ok:
        raise HTTPException(status_code=404, detail="Account not found")
    return {"code": 0, "msg": "success"}


@app.post("/api/email/fetch")
async def api_fetch_emails(req: FetchRequest, token: str = Depends(require_auth)):
    email_addr = None
    email_token = None

    if req.account_id:
        acc = account_store.get_account(req.account_id)
        if not acc:
            raise HTTPException(status_code=404, detail="Account not found")
        email_addr = acc["email"]
        email_token = acc["token"]
    else:
        email_addr = req.email
        email_token = req.token

    if not email_addr or not email_token:
        raise HTTPException(status_code=400, detail="email and token are required (or account_id)")

    now = datetime.now(SHANGHAI_TZ)
    default_start = (now - timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%S")
    default_end = now.strftime("%Y-%m-%dT%H:%M:%S")

    try:
        emails = await fetch_emails(
            email_addr=email_addr,
            token=email_token,
            to=req.to,
            sender=req.sender,
            subject=req.subject,
            body=req.body,
            keyword=req.keyword,
            unseen=req.unseen,
            start_time=req.start_time,
            end_time=req.end_time,
            limit=req.limit,
        )
        return {
            "code": 0,
            "msg": "success",
            "data": {
                "total": len(emails),
                "emails": emails,
                "query": {
                    "email": email_addr,
                    "to": req.to,
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
        return JSONResponse(
            status_code=500,
            content={"code": 1, "msg": f"IMAP error: {str(e)}", "data": None},
        )


@app.post("/api/email/mark_read")
async def api_mark_read(req: MarkReadRequest, token: str = Depends(require_auth)):
    email_addr = None
    email_token = None

    if req.account_id:
        acc = account_store.get_account(req.account_id)
        if not acc:
            raise HTTPException(status_code=404, detail="Account not found")
        email_addr = acc["email"]
        email_token = acc["token"]
    else:
        email_addr = req.email
        email_token = req.token

    if not email_addr or not email_token:
        raise HTTPException(status_code=400, detail="email and token are required (or account_id)")

    try:
        count = await mark_emails_read(email_addr, email_token, req.sender, req.subject)
        return {"code": 0, "msg": "success", "data": {"marked": count}}
    except Exception as e:
        return JSONResponse(
            status_code=500,
            content={"code": 1, "msg": f"IMAP error: {str(e)}", "data": None},
        )


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
