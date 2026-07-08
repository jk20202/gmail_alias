import json
import os
import uuid
import secrets
import hashlib
import threading
import string
from datetime import datetime, timedelta

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, "data")
USERS_FILE = os.path.join(DATA_DIR, "users.json")
SETTINGS_FILE = os.path.join(DATA_DIR, "settings.json")
SESSION_TTL_DAYS = 7


def _hash_password(password):
    return hashlib.sha256(password.encode("utf-8")).hexdigest()


def _gen_api_key():
    return secrets.token_hex(16)


def _gen_session_token():
    return secrets.token_urlsafe(32)


def _gen_gmail_id():
    return "g" + secrets.token_hex(4)


def _gen_alias_label():
    """生成 5-10 位随机别名标签"""
    length = secrets.choice([5, 6, 7, 8, 9, 10])
    chars = string.ascii_lowercase + string.digits
    return "".join(secrets.choice(chars) for _ in range(length))


def _build_alias_full(gmail_email, label):
    """拼接别名: prefix+label@domain"""
    if not gmail_email or "@" not in gmail_email:
        return ""
    prefix, domain = gmail_email.split("@", 1)
    return f"{prefix}+{label}@{domain}"


class UserStore:
    def __init__(self):
        self._lock = threading.Lock()
        os.makedirs(DATA_DIR, exist_ok=True)
        if not os.path.exists(USERS_FILE):
            admin = {
                "id": "admin",
                "username": "admin",
                "password": _hash_password("admin123_"),
                "api_key": _gen_api_key(),
                "is_admin": True,
                "gmail_accounts": [],
                "alias": None,
                "created_at": datetime.now().isoformat(),
            }
            self._save_users({"users": [admin]})
        if not os.path.exists(SETTINGS_FILE):
            self._save_settings({"allow_registration": True})
        self._sessions = {}
        self._migrate_legacy()

    def _migrate_legacy(self):
        """迁移旧数据: gmail_email/gmail_token/alias(string) -> 新格式"""
        with self._lock:
            data = self._load_users()
            changed = False
            for u in data["users"]:
                if "gmail_accounts" not in u:
                    u["gmail_accounts"] = []
                    if u.get("gmail_email") or u.get("gmail_token"):
                        u["gmail_accounts"].append({
                            "id": _gen_gmail_id(),
                            "email": u.get("gmail_email", ""),
                            "token": u.get("gmail_token", ""),
                            "is_public": False,
                            "created_at": datetime.now().isoformat(),
                        })
                    changed = True
                if isinstance(u.get("alias"), str):
                    old_alias = u.get("alias", "")
                    if old_alias and u["gmail_accounts"]:
                        ga = u["gmail_accounts"][0]
                        label = ""
                        if "+" in old_alias:
                            label = old_alias.split("+")[1].split("@")[0]
                        u["alias"] = {
                            "gmail_account_id": ga["id"],
                            "label": label,
                            "full": old_alias,
                        }
                    else:
                        u["alias"] = None
                    changed = True
                if "alias" not in u:
                    u["alias"] = None
                    changed = True
            if changed:
                self._save_users(data)

    def _load_users(self):
        try:
            with open(USERS_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except (FileNotFoundError, json.JSONDecodeError):
            return {"users": []}

    def _save_users(self, data):
        with open(USERS_FILE, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)

    def _load_settings(self):
        try:
            with open(SETTINGS_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except (FileNotFoundError, json.JSONDecodeError):
            return {"allow_registration": True}

    def _save_settings(self, data):
        with open(SETTINGS_FILE, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)

    def _safe_user(self, u):
        return {
            "id": u["id"],
            "username": u["username"],
            "api_key": u["api_key"],
            "is_admin": u.get("is_admin", False),
            "gmail_accounts": [
                {
                    "id": ga["id"],
                    "email": ga["email"],
                    "is_public": ga.get("is_public", False),
                    "created_at": ga.get("created_at", ""),
                    "token_masked": (ga.get("token", "")[:4] + "****" + ga.get("token", "")[-4:]) if len(ga.get("token", "")) > 8 else "****",
                }
                for ga in u.get("gmail_accounts", [])
            ],
            "alias": u.get("alias"),
            "created_at": u.get("created_at", ""),
        }

    def login(self, username, password):
        with self._lock:
            data = self._load_users()
            for u in data["users"]:
                if u["username"] == username and u["password"] == _hash_password(password):
                    token = _gen_session_token()
                    self._sessions[token] = {
                        "user_id": u["id"],
                        "expires": (datetime.now() + timedelta(days=SESSION_TTL_DAYS)).isoformat(),
                    }
                    return token, self._safe_user(u)
            return None, None

    def logout(self, session_token):
        self._sessions.pop(session_token, None)

    def get_user_by_session(self, session_token):
        sess = self._sessions.get(session_token)
        if not sess:
            return None
        if datetime.fromisoformat(sess["expires"]) < datetime.now():
            self._sessions.pop(session_token, None)
            return None
        with self._lock:
            data = self._load_users()
            for u in data["users"]:
                if u["id"] == sess["user_id"]:
                    return self._safe_user(u)
        return None

    def get_user_by_api_key(self, api_key):
        if not api_key:
            return None
        with self._lock:
            data = self._load_users()
            for u in data["users"]:
                if u["api_key"] == api_key:
                    return u
        return None

    def get_user_raw(self, user_id):
        with self._lock:
            data = self._load_users()
            for u in data["users"]:
                if u["id"] == user_id:
                    return u
        return None

    def list_users(self):
        with self._lock:
            data = self._load_users()
            return [self._safe_user(u) for u in data["users"]]

    def create_user(self, username, password, is_admin=False):
        with self._lock:
            data = self._load_users()
            for u in data["users"]:
                if u["username"] == username:
                    return None
            user = {
                "id": str(uuid.uuid4())[:8],
                "username": username,
                "password": _hash_password(password),
                "api_key": _gen_api_key(),
                "is_admin": is_admin,
                "gmail_accounts": [],
                "alias": None,
                "created_at": datetime.now().isoformat(),
            }
            data["users"].append(user)
            self._save_users(data)
            return self._safe_user(user)

    def update_user(self, user_id, password=None, is_admin=None):
        with self._lock:
            data = self._load_users()
            for u in data["users"]:
                if u["id"] == user_id:
                    if password is not None:
                        u["password"] = _hash_password(password)
                    if is_admin is not None:
                        u["is_admin"] = is_admin
                    self._save_users(data)
                    return self._safe_user(u)
        return None

    def delete_user(self, user_id):
        if user_id == "admin":
            return False
        with self._lock:
            data = self._load_users()
            before = len(data["users"])
            data["users"] = [u for u in data["users"] if u["id"] != user_id]
            self._save_users(data)
            return len(data["users"]) < before

    def regenerate_api_key(self, user_id):
        with self._lock:
            data = self._load_users()
            for u in data["users"]:
                if u["id"] == user_id:
                    u["api_key"] = _gen_api_key()
                    self._save_users(data)
                    return self._safe_user(u)
        return None

    # ==================== Gmail Accounts ====================

    def list_gmail_accounts(self, user_id):
        with self._lock:
            data = self._load_users()
            for u in data["users"]:
                if u["id"] == user_id:
                    return u.get("gmail_accounts", [])
        return []

    def add_gmail_account(self, user_id, email, token, is_public=False):
        with self._lock:
            data = self._load_users()
            for u in data["users"]:
                if u["id"] == user_id:
                    ga = {
                        "id": _gen_gmail_id(),
                        "email": email,
                        "token": token,
                        "is_public": is_public,
                        "created_at": datetime.now().isoformat(),
                    }
                    u.setdefault("gmail_accounts", []).append(ga)
                    self._save_users(data)
                    return self._safe_user(u)
        return None

    def update_gmail_account(self, user_id, ga_id, email=None, token=None, is_public=None):
        with self._lock:
            data = self._load_users()
            for u in data["users"]:
                if u["id"] != user_id:
                    continue
                for ga in u.get("gmail_accounts", []):
                    if ga["id"] == ga_id:
                        if email is not None:
                            ga["email"] = email
                        if token is not None:
                            ga["token"] = token
                        if is_public is not None:
                            ga["is_public"] = is_public
                        self._save_users(data)
                        return self._safe_user(u)
        return None

    def delete_gmail_account(self, user_id, ga_id):
        with self._lock:
            data = self._load_users()
            for u in data["users"]:
                if u["id"] != user_id:
                    continue
                before = len(u.get("gmail_accounts", []))
                u["gmail_accounts"] = [ga for ga in u.get("gmail_accounts", []) if ga["id"] != ga_id]
                # 若删除的邮箱关联了当前别名，清除别名
                if u.get("alias") and u["alias"].get("gmail_account_id") == ga_id:
                    u["alias"] = None
                if len(u["gmail_accounts"]) < before:
                    self._save_users(data)
                    return self._safe_user(u)
        return None

    def list_available_gmail_accounts(self, user_id):
        """列出可用的谷歌邮箱(自己的全部 + 别人公开的)，不返回 token"""
        with self._lock:
            data = self._load_users()
            result = []
            for u in data["users"]:
                for ga in u.get("gmail_accounts", []):
                    if u["id"] == user_id or ga.get("is_public", False):
                        result.append({
                            "id": ga["id"],
                            "email": ga["email"],
                            "is_public": ga.get("is_public", False),
                            "owner": u["username"],
                            "is_own": u["id"] == user_id,
                        })
            return result

    def admin_list_all_gmail_accounts(self):
        """管理员: 列出所有用户的主邮箱(含 owner 信息)，token 脱敏"""
        with self._lock:
            data = self._load_users()
            result = []
            for u in data["users"]:
                for ga in u.get("gmail_accounts", []):
                    result.append({
                        "id": ga["id"],
                        "email": ga["email"],
                        "is_public": ga.get("is_public", False),
                        "created_at": ga.get("created_at", ""),
                        "token_masked": (ga.get("token", "")[:4] + "****" + ga.get("token", "")[-4:]) if len(ga.get("token", "")) > 8 else "****",
                        "owner_id": u["id"],
                        "owner_username": u["username"],
                    })
            return result

    def admin_update_gmail_account(self, user_id, ga_id, email=None, token=None, is_public=None):
        """管理员: 修改任意用户的主邮箱"""
        with self._lock:
            data = self._load_users()
            for u in data["users"]:
                if u["id"] != user_id:
                    continue
                for ga in u.get("gmail_accounts", []):
                    if ga["id"] == ga_id:
                        if email is not None:
                            ga["email"] = email
                        if token is not None:
                            ga["token"] = token
                        if is_public is not None:
                            ga["is_public"] = is_public
                        self._save_users(data)
                        return self._safe_user(u)
        return None

    def admin_delete_gmail_account(self, user_id, ga_id):
        """管理员: 删除任意用户的主邮箱"""
        with self._lock:
            data = self._load_users()
            for u in data["users"]:
                if u["id"] != user_id:
                    continue
                before = len(u.get("gmail_accounts", []))
                u["gmail_accounts"] = [ga for ga in u.get("gmail_accounts", []) if ga["id"] != ga_id]
                if u.get("alias") and u["alias"].get("gmail_account_id") == ga_id:
                    u["alias"] = None
                if len(u["gmail_accounts"]) < before:
                    self._save_users(data)
                    return self._safe_user(u)
        return None

    def get_gmail_account_raw(self, user_id, ga_id):
        """获取原始邮箱账号(含 token)，用于查询时获取凭据"""
        with self._lock:
            data = self._load_users()
            for u in data["users"]:
                for ga in u.get("gmail_accounts", []):
                    if ga["id"] == ga_id:
                        # 自己的直接返回，别人公开的也返回（用于别名查询）
                        if u["id"] == user_id or ga.get("is_public", False):
                            return ga
        return None

    def find_gmail_account_by_email(self, email):
        """按邮箱地址查找原始账号(含 token)"""
        with self._lock:
            data = self._load_users()
            for u in data["users"]:
                for ga in u.get("gmail_accounts", []):
                    if ga["email"] == email:
                        return ga
        return None

    # ==================== Alias ====================

    def set_alias(self, user_id, gmail_account_id, label):
        """设置别名，关联到指定 gmail_account"""
        with self._lock:
            data = self._load_users()
            for u in data["users"]:
                if u["id"] != user_id:
                    continue
                # 找到对应的 gmail_account (自己的或别人公开的)
                ga = None
                for uu in data["users"]:
                    for g in uu.get("gmail_accounts", []):
                        if g["id"] == gmail_account_id:
                            if uu["id"] == user_id or g.get("is_public", False):
                                ga = g
                                break
                    if ga:
                        break
                if not ga:
                    return None, "未找到指定的谷歌邮箱或无权使用"
                full = _build_alias_full(ga["email"], label)
                if not full:
                    return None, "别名生成失败，邮箱格式错误"
                u["alias"] = {
                    "gmail_account_id": gmail_account_id,
                    "label": label,
                    "full": full,
                }
                self._save_users(data)
                return self._safe_user(u), None
        return None, "用户不存在"

    def gen_random_label(self):
        return _gen_alias_label()

    # ==================== Settings ====================

    def get_registration_allowed(self):
        return self._load_settings().get("allow_registration", True)

    def set_registration_allowed(self, allowed):
        with self._lock:
            self._save_settings({"allow_registration": allowed})
