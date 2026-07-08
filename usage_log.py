import json
import os
import threading
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo
SHANGHAI_TZ = ZoneInfo("Asia/Shanghai")

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, "data")
LOG_FILE = os.path.join(DATA_DIR, "usage_log.json")
RETENTION_DAYS = 30


class UsageLog:
    def __init__(self):
        self._lock = threading.Lock()
        os.makedirs(DATA_DIR, exist_ok=True)
        if not os.path.exists(LOG_FILE):
            self._save({"logs": []})

    def _load(self):
        try:
            with open(LOG_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except (FileNotFoundError, json.JSONDecodeError):
            return {"logs": []}

    def _save(self, data):
        with open(LOG_FILE, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)

    def add(self, user_id, username, alias, action="fetch_emails", detail=""):
        with self._lock:
            data = self._load()
            entry = {
                "id": len(data["logs"]) + 1,
                "user_id": user_id,
                "username": username,
                "alias": alias,
                "action": action,
                "detail": detail,
                "timestamp": datetime.now(SHANGHAI_TZ).isoformat(),
            }
            data["logs"].append(entry)
            cutoff = datetime.now(SHANGHAI_TZ) - timedelta(days=RETENTION_DAYS)
            def _parse_ts(ts):
                try:
                    dt = datetime.fromisoformat(ts)
                    if dt.tzinfo is None:
                        dt = dt.replace(tzinfo=SHANGHAI_TZ)
                    return dt
                except Exception:
                    return cutoff
            data["logs"] = [l for l in data["logs"] if _parse_ts(l["timestamp"]) > cutoff]
            self._save(data)
            return entry

    def list(self, username=None, action=None, limit=500):
        with self._lock:
            data = self._load()
            logs = data["logs"]
            if username:
                logs = [l for l in logs if l["username"] == username]
            if action:
                logs = [l for l in logs if l["action"] == action]
            logs = sorted(logs, key=lambda x: x["timestamp"], reverse=True)
            logs = logs[:limit]
            for l in logs:
                ts = l.get("timestamp", "")
                try:
                    dt = datetime.fromisoformat(ts)
                    l["time_display"] = dt.strftime("%Y-%m-%d %H:%M:%S")
                except Exception:
                    l["time_display"] = ts
            return logs

    def stats_summary(self):
        with self._lock:
            data = self._load()
            logs = data["logs"]
            by_user = {}
            by_alias = {}
            for l in logs:
                u = l["username"]
                by_user[u] = by_user.get(u, 0) + 1
                a = l["alias"] or "(无别名)"
                by_alias[a] = by_alias.get(a, 0) + 1
            for l in logs:
                ts = l.get("timestamp", "")
                try:
                    dt = datetime.fromisoformat(ts)
                    l["time_display"] = dt.strftime("%Y-%m-%d %H:%M:%S")
                except Exception:
                    l["time_display"] = ts
            return {
                "total_calls": len(logs),
                "by_user": by_user,
                "by_alias": by_alias,
            }
