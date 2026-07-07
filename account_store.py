import json
import os
import uuid
import threading
from datetime import datetime

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, "data")
ACCOUNTS_FILE = os.path.join(DATA_DIR, "accounts.json")


class AccountStore:
    def __init__(self):
        self._lock = threading.Lock()
        os.makedirs(DATA_DIR, exist_ok=True)
        if not os.path.exists(ACCOUNTS_FILE):
            self._save({"accounts": []})

    def _load(self):
        try:
            with open(ACCOUNTS_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except (FileNotFoundError, json.JSONDecodeError):
            return {"accounts": []}

    def _save(self, data):
        with open(ACCOUNTS_FILE, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)

    def list_accounts(self):
        with self._lock:
            data = self._load()
            return [
                {**acc, "token": acc["token"][:4] + "****" + acc["token"][-4:] if len(acc.get("token", "")) > 8 else "****"}
                for acc in data["accounts"]
            ]

    def list_accounts_full(self):
        with self._lock:
            data = self._load()
            return data["accounts"]

    def get_account(self, account_id):
        with self._lock:
            data = self._load()
            for acc in data["accounts"]:
                if acc["id"] == account_id:
                    return acc
            return None

    def add_account(self, email, token, label=""):
        with self._lock:
            data = self._load()
            account = {
                "id": str(uuid.uuid4())[:8],
                "email": email,
                "token": token,
                "label": label or email,
                "created_at": datetime.now().isoformat(),
            }
            data["accounts"].append(account)
            self._save(data)
            return account

    def update_account(self, account_id, email=None, token=None, label=None):
        with self._lock:
            data = self._load()
            for acc in data["accounts"]:
                if acc["id"] == account_id:
                    if email is not None:
                        acc["email"] = email
                    if token is not None:
                        acc["token"] = token
                    if label is not None:
                        acc["label"] = label
                    self._save(data)
                    return acc
            return None

    def delete_account(self, account_id):
        with self._lock:
            data = self._load()
            before = len(data["accounts"])
            data["accounts"] = [a for a in data["accounts"] if a["id"] != account_id]
            self._save(data)
            return len(data["accounts"]) < before
