import json
import os
import uuid
import secrets
import hashlib
import threading
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
                "gmail_email": "",
                "gmail_token": "",
                "alias": "",
                "created_at": datetime.now().isoformat(),
            }
            self._save_users({"users": [admin]})
        if not os.path.exists(SETTINGS_FILE):
            self._save_settings({"allow_registration": True})
        self._sessions = {}

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

    def _safe_user(self, u):
        return {
            "id": u["id"],
            "username": u["username"],
            "api_key": u["api_key"],
            "is_admin": u.get("is_admin", False),
            "gmail_email": u.get("gmail_email", ""),
            "gmail_token_masked": (u.get("gmail_token", "")[:4] + "****" + u.get("gmail_token", "")[-4:]) if len(u.get("gmail_token", "")) > 8 else "****",
            "alias": u.get("alias", ""),
            "created_at": u.get("created_at", ""),
        }

    def list_users(self):
        with self._lock:
            data = self._load_users()
            return [self._safe_user(u) for u in data["users"]]

    def get_user_raw(self, user_id):
        with self._lock:
            data = self._load_users()
            for u in data["users"]:
                if u["id"] == user_id:
                    return u
        return None

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
                "gmail_email": "",
                "gmail_token": "",
                "alias": "",
                "created_at": datetime.now().isoformat(),
            }
            data["users"].append(user)
            self._save_users(data)
            return self._safe_user(user)

    def update_user(self, user_id, password=None, is_admin=None, gmail_email=None, gmail_token=None):
        with self._lock:
            data = self._load_users()
            for u in data["users"]:
                if u["id"] == user_id:
                    if password is not None:
                        u["password"] = _hash_password(password)
                    if is_admin is not None:
                        u["is_admin"] = is_admin
                    if gmail_email is not None:
                        u["gmail_email"] = gmail_email
                    if gmail_token is not None:
                        u["gmail_token"] = gmail_token
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

    def set_alias(self, user_id, alias):
        with self._lock:
            data = self._load_users()
            for u in data["users"]:
                if u["id"] == user_id:
                    u["alias"] = alias
                    self._save_users(data)
                    return self._safe_user(u)
        return None

    def regenerate_api_key(self, user_id):
        with self._lock:
            data = self._load_users()
            for u in data["users"]:
                if u["id"] == user_id:
                    u["api_key"] = _gen_api_key()
                    self._save_users(data)
                    return self._safe_user(u)
        return None

    def get_registration_allowed(self):
        return self._load_settings().get("allow_registration", True)

    def set_registration_allowed(self, allowed):
        with self._lock:
            self._save_settings({"allow_registration": allowed})
