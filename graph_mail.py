"""
Microsoft Graph API 邮件客户端

替代 IMAP 方式拉取 Hotmail/Outlook 个人账号邮件。
Graph API 是 Microsoft 官方推荐的现代 REST API。

返回格式与 email_service._parse_mail 保持一致:
    {id, from, to, subject, date, date_iso, body, html, unread}
"""
import json
import urllib.request
import urllib.parse
import urllib.error
from datetime import datetime, timezone
from typing import Optional
from email.utils import parsedate_to_datetime

BASE_URL = "https://graph.microsoft.com/v1.0"


def _normalize_datetime(dt_str, is_end=False):
    """把时间字符串规范化成 Graph API 接受的 ISO 8601 UTC 格式"""
    if not dt_str:
        return None
    s = dt_str.strip()
    if "T" not in s:
        s = s + ("T23:59:59Z" if is_end else "T00:00:00Z")
    if s.endswith("Z") or "+" in s[10:]:
        return s
    return s + "Z"


def _get(path, access_token, params=None):
    """GET 请求 Graph API"""
    url = BASE_URL + path
    if params:
        url += "?" + urllib.parse.urlencode(params, doseq=True)
    req = urllib.request.Request(url, headers={
        "Authorization": f"Bearer {access_token}",
        "Accept": "application/json",
    })
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Graph API HTTP {e.code}: {body}")
    except urllib.error.URLError as e:
        raise RuntimeError(f"Graph API 网络错误: {e}")


def _patch(path, access_token, body):
    """PATCH 请求 Graph API(标记已读等)"""
    url = BASE_URL + path
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, method="PATCH", headers={
        "Authorization": f"Bearer {access_token}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    })
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Graph API HTTP {e.code}: {body}")


def _parse_message(msg):
    """把 Graph API 的消息格式转成与 email_service._parse_mail 一致的格式"""
    from_obj = msg.get("from", {}).get("emailAddress", {})
    from_addr = from_obj.get("address", "")
    from_name = from_obj.get("name", "")
    from_str = f"{from_name} <{from_addr}>" if from_name else from_addr

    to_list = []
    for r in msg.get("toRecipients", []):
        ea = r.get("emailAddress", {})
        addr = ea.get("address", "")
        name = ea.get("name", "")
        to_list.append(f"{name} <{addr}>" if name else addr)
    to_str = ", ".join(to_list)

    received = msg.get("receivedDateTime", "")
    # Graph 返回 2026-07-08T04:49:38Z -> 转成 Asia/Shanghai 显示 + ISO
    date_display = received.replace("T", " ").replace("Z", "")
    date_iso = received

    return {
        "id": msg.get("id", ""),
        "from": from_str,
        "to": to_str,
        "subject": msg.get("subject", ""),
        "date": date_display,
        "date_iso": date_iso,
        "body": msg.get("bodyPreview", ""),
        "html": "",
        "unread": msg.get("isRead") is False,
    }


def fetch_emails(
    access_token,
    to=None, sender=None, subject=None, body=None, keyword=None,
    unseen=None, start_time=None, end_time=None, limit=50,
):
    """
    通过 Graph API 拉取邮件,返回 list[dict](格式与 email_service 一致)

    过滤策略:
    - 时间范围、unseen、sender: 走 Graph $filter(服务端过滤)
    - to、subject、keyword: 客户端过滤(Graph 的 $filter 对这些不够灵活)
    """
    filters = []
    if sender:
        filters.append(f"from/emailAddress/address eq '{sender}'")
    if unseen is True:
        filters.append("isRead eq false")
    elif unseen is False:
        filters.append("isRead eq true")
    since = _normalize_datetime(start_time)
    before = _normalize_datetime(end_time, is_end=True)
    if since:
        filters.append(f"receivedDateTime ge {since}")
    if before:
        filters.append(f"receivedDateTime lt {before}")

    # 拉取数量: 有客户端过滤时多拉一些
    fetch_top = max(limit * 3, 50) if (to or keyword or subject) else limit
    fetch_top = min(fetch_top, 200)  # 上限

    params = {
        "$top": fetch_top,
        "$orderby": "receivedDateTime desc",
        "$select": "id,subject,from,toRecipients,receivedDateTime,bodyPreview,isRead",
    }
    if filters:
        params["$filter"] = " and ".join(filters)

    resp = _get("/me/mailFolders/inbox/messages", access_token, params)
    messages = resp.get("value", [])
    results = [_parse_message(m) for m in messages]

    # 客户端过滤
    if to:
        to_lower = to.lower()
        results = [e for e in results if to_lower in e.get("to", "").lower()]
    if subject:
        subject_lower = subject.lower()
        results = [e for e in results if subject_lower in e.get("subject", "").lower()]
    if keyword:
        kw_lower = keyword.lower()
        results = [e for e in results if kw_lower in (
            e.get("from", "") + " " + e.get("to", "") + " " +
            e.get("subject", "") + " " + e.get("body", "")
        ).lower()]

    # 按时间倒序
    results.sort(key=lambda x: x.get("date_iso", ""), reverse=True)
    if limit:
        results = results[:limit]
    return results


def mark_emails_read(access_token, sender=None, subject=None):
    """标记邮件为已读,返回标记数量"""
    # 先查询匹配的未读邮件
    filters = ["isRead eq false"]
    if sender:
        filters.append(f"from/emailAddress/address eq '{sender}'")

    params = {
        "$top": 50,
        "$orderby": "receivedDateTime desc",
        "$select": "id,subject,from,toRecipients,receivedDateTime,isRead",
        "$filter": " and ".join(filters),
    }
    resp = _get("/me/mailFolders/inbox/messages", access_token, params)
    messages = resp.get("value", [])

    count = 0
    for m in messages:
        # subject 客户端过滤
        if subject and subject.lower() not in m.get("subject", "").lower():
            continue
        try:
            _patch(f"/me/messages/{m['id']}", access_token, {"isRead": True})
            count += 1
        except RuntimeError:
            continue
    return count
