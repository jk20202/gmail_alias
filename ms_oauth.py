"""
Microsoft 个人账号 OAuth2

Microsoft 自 2024-09 起对 hotmail/outlook/live 个人账号禁用 IMAP 基本认证,
必须用 OAuth2 获取 access_token,通过 Graph API 拉取邮件。

授权流程: Authorization Code Flow(网页认证)
1. 用户点击添加微软邮箱 -> 后端生成授权 URL -> 用户跳转微软登录
2. 微软重定向回 /api/ms_auth/callback?code=xxx&state=xxx
3. 后端用 code 换取 token(access_token + refresh_token),存入 user_store
4. 后续拉取邮件时,用 access_token 调 Graph API;过期则用 refresh_token 自动刷新

token 存储格式(user_store 的 gmail_accounts[].token 字段):
    JSON 字符串 {"access_token":"...","refresh_token":"...","expires_at":1234567890}
"""
import json
import time
import urllib.request
import urllib.parse
import urllib.error
import secrets
import base64
import logging

logger = logging.getLogger("ms_oauth")

# Thunderbird 注册的 Azure 应用 client_id(公开可用)
CLIENT_ID = "9e5f94bc-e8a4-4e73-b8be-63364c29d753"

# 个人账号(consumers)租户端点
AUTHORIZE_URL = "https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize"
TOKEN_URL = "https://login.microsoftonline.com/consumers/oauth2/v2.0/token"

# Graph API 所需 scope;offline_access 用于拿 refresh_token
SCOPES = [
    "https://graph.microsoft.com/Mail.Read",
    "https://graph.microsoft.com/Mail.ReadWrite",
    "https://graph.microsoft.com/User.Read",
    "offline_access",
]

# access_token 提前刷新余量(秒)
REFRESH_LEEWAY = 60

# OAuth 回调地址(默认本地,可通过环境变量覆盖)
import os
OAUTH_REDIRECT_URI = os.getenv("OAUTH_REDIRECT_URI", "http://localhost:8000/api/ms_auth/callback")


class AuthRequiredError(Exception):
    """需要用户完成 OAuth 授权时抛出"""

    def __init__(self, message, email=""):
        super().__init__(message)
        self.email = email


def _post_json(url, params):
    """POST 表单并解析 JSON 响应"""
    data = urllib.parse.urlencode(params).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        try:
            err_body = json.loads(e.read().decode("utf-8"))
        except Exception:
            err_body = {"error": str(e)}
        raise RuntimeError(f"OAuth HTTP {e.code}: {err_body}")
    except urllib.error.URLError as e:
        raise RuntimeError(f"OAuth 网络错误: {e}")


def _encode_state(user_id, ga_id):
    """把 user_id + ga_id 编码到 state 参数中(同时含随机 nonce 防 CSRF)"""
    payload = json.dumps({"u": user_id, "g": ga_id, "n": secrets.token_urlsafe(8)})
    return base64.urlsafe_b64encode(payload.encode()).decode().rstrip("=")


def _decode_state(state):
    """解码 state 参数,返回 dict 或 None"""
    try:
        padding = "=" * (4 - len(state) % 4)
        payload = base64.urlsafe_b64decode(state + padding).decode()
        return json.loads(payload)
    except Exception:
        return None


def get_auth_url(user_id, ga_id):
    """生成授权 URL,返回 (auth_url, state)"""
    state = _encode_state(user_id, ga_id)
    params = {
        "client_id": CLIENT_ID,
        "response_type": "code",
        "redirect_uri": OAUTH_REDIRECT_URI,
        "scope": " ".join(SCOPES),
        "state": state,
        "response_mode": "query",
    }
    auth_url = AUTHORIZE_URL + "?" + urllib.parse.urlencode(params)
    return auth_url, state


def exchange_code_for_token(code):
    """用 authorization_code 换取 token,返回 token_data dict"""
    params = {
        "client_id": CLIENT_ID,
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": OAUTH_REDIRECT_URI,
        "scope": " ".join(SCOPES),
    }
    token_data = _post_json(TOKEN_URL, params)
    if "access_token" not in token_data:
        raise RuntimeError(f"OAuth 回调失败,未拿到 access_token: {token_data}")
    return token_data


def _refresh_token(refresh_token):
    """用 refresh_token 换取新的 access_token"""
    params = {
        "client_id": CLIENT_ID,
        "grant_type": "refresh_token",
        "refresh_token": refresh_token,
        "scope": " ".join(SCOPES),
    }
    return _post_json(TOKEN_URL, params)


def save_token_str(token_data):
    """把 OAuth token 响应序列化成可存储的 JSON 字符串"""
    data = {
        "access_token": token_data.get("access_token", ""),
        "refresh_token": token_data.get("refresh_token", ""),
        "expires_at": int(time.time()) + int(token_data.get("expires_in", 3600)),
    }
    return json.dumps(data, ensure_ascii=False)


def load_token_str(token_json):
    """从存储的 JSON 字符串解析 token"""
    if not token_json:
        return None
    try:
        return json.loads(token_json)
    except (json.JSONDecodeError, TypeError):
        return None


def get_access_token(token_json):
    """
    从存储的 token JSON 获取可用 access_token,过期则用 refresh_token 刷新。
    返回: (access_token, new_token_json_or_None)  new_token_json 不为 None 表示已刷新需回存
    异常: AuthRequiredError(需要重新授权)
    """
    cache = load_token_str(token_json)
    if not cache:
        raise AuthRequiredError("未找到 OAuth token,需要重新授权")

    # 1) access_token 未过期 -> 直接用
    if cache.get("access_token"):
        if int(cache.get("expires_at", 0)) - time.time() > REFRESH_LEEWAY:
            return cache["access_token"], None

    # 2) 有 refresh_token -> 尝试刷新
    if cache.get("refresh_token"):
        try:
            token_data = _refresh_token(cache["refresh_token"])
            new_token_json = save_token_str(token_data)
            logger.info("OAuth token 已自动刷新")
            return token_data["access_token"], new_token_json
        except RuntimeError as e:
            logger.warning(f"refresh_token 刷新失败: {e}")

    # 3) 都不可用 -> 需要重新授权
    raise AuthRequiredError("OAuth token 已失效,需要重新授权")
