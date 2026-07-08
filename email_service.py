import asyncio
import imaplib
import email as email_lib
import re
import logging
from email.header import decode_header
from email.utils import parsedate_to_datetime
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo
from collections import deque
from contextlib import asynccontextmanager
from typing import Optional

SHANGHAI_TZ = ZoneInfo("Asia/Shanghai")
IMAP_HOST = "imap.gmail.com"
IMAP_PORT = 993
MAX_CONCURRENT_PER_ACCOUNT = 10

logger = logging.getLogger("email_service")
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")


def _decode_str(raw):
    if not raw:
        return ""
    parts = decode_header(raw)
    out = []
    for text, enc in parts:
        if isinstance(text, bytes):
            try:
                out.append(text.decode(enc or "utf-8", errors="replace"))
            except (LookupError, TypeError):
                out.append(text.decode("utf-8", errors="replace"))
        else:
            out.append(text)
    return "".join(out)


def _html_to_text(html):
    html = re.sub(r'<style[^>]*>.*?</style>', '', html, flags=re.DOTALL | re.IGNORECASE)
    html = re.sub(r'<script[^>]*>.*?</script>', '', html, flags=re.DOTALL | re.IGNORECASE)
    html = re.sub(r'<br\s*/?>', '\n', html, flags=re.IGNORECASE)
    html = re.sub(r'<[^>]+>', '', html)
    html = re.sub(r'&nbsp;', ' ', html)
    html = re.sub(r'&amp;', '&', html)
    html = re.sub(r'&lt;', '<', html)
    html = re.sub(r'&gt;', '>', html)
    html = re.sub(r'\n{3,}', '\n\n', html)
    return html.strip()


def _parse_mail(msg):
    from_addr = _decode_str(msg.get("From", ""))
    to_addr = _decode_str(msg.get("To", ""))
    subject = _decode_str(msg.get("Subject", ""))
    date_raw = msg.get("Date", "")

    dt = None
    if date_raw:
        try:
            dt = parsedate_to_datetime(date_raw)
        except Exception:
            pass

    if dt:
        date_iso = dt.isoformat()
        date_display = dt.astimezone(SHANGHAI_TZ).strftime("%Y-%m-%d %H:%M:%S")
    else:
        date_iso = ""
        date_display = date_raw

    body_text = ""
    html_text = ""
    if msg.is_multipart():
        for part in msg.walk():
            ctype = part.get_content_type()
            cdispo = str(part.get("Content-Disposition", ""))
            if "attachment" in cdispo:
                continue
            if ctype == "text/plain" and not body_text:
                try:
                    charset = part.get_content_charset() or "utf-8"
                    body_text = part.get_payload(decode=True).decode(charset, errors="replace")
                except Exception:
                    continue
            elif ctype == "text/html" and not html_text:
                try:
                    charset = part.get_content_charset() or "utf-8"
                    html_text = part.get_payload(decode=True).decode(charset, errors="replace")
                except Exception:
                    continue
    else:
        try:
            charset = msg.get_content_charset() or "utf-8"
            payload = msg.get_payload(decode=True)
            if payload:
                body_text = payload.decode(charset, errors="replace")
        except Exception:
            body_text = msg.get_payload() or ""

    if not body_text and html_text:
        body_text = _html_to_text(html_text)

    return {
        "id": msg.get("Message-ID", ""),
        "from": from_addr,
        "to": to_addr,
        "subject": subject,
        "date": date_display,
        "date_iso": date_iso,
        "body": body_text.strip(),
        "html": html_text.strip() if html_text else "",
        "unread": "\\Seen" not in str(msg.get("Flags", "")),
    }


def _build_imap_criteria(sender=None, to=None, subject=None, body=None,
                         unseen=None, since_date=None, before_date=None):
    parts = []
    if unseen is True:
        parts.append("UNSEEN")
    elif unseen is False:
        parts.append("SEEN")
    if sender:
        parts.append(f'FROM "{sender}"')
    if to:
        parts.append(f'TO "{to}"')
    if subject:
        parts.append(f'SUBJECT "{subject}"')
    if body:
        parts.append(f'TEXT "{body}"')
    if since_date:
        parts.append(f'SINCE {since_date}')
    if before_date:
        parts.append(f'BEFORE {before_date}')
    return " ".join(parts) if parts else "ALL"


def parse_time(time_str, default):
    if not time_str:
        return default
    time_str = time_str.strip().replace(" ", "T")
    for fmt in ["%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M", "%Y-%m-%d"]:
        try:
            dt = datetime.strptime(time_str, fmt)
            return dt.replace(tzinfo=SHANGHAI_TZ)
        except ValueError:
            continue
    try:
        dt = datetime.fromisoformat(time_str)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=SHANGHAI_TZ)
        return dt
    except ValueError:
        return default


def _filter_by_time(emails, start_time, end_time):
    result = []
    for e in emails:
        date_iso = e.get("date_iso", "")
        if not date_iso:
            continue
        try:
            email_dt = datetime.fromisoformat(date_iso)
            email_dt_sh = email_dt.astimezone(SHANGHAI_TZ)
            if start_time <= email_dt_sh <= end_time:
                result.append(e)
        except (ValueError, TypeError):
            continue
    return result


def _filter_by_keyword(emails, keyword):
    if not keyword:
        return emails
    kw = keyword.lower()
    return [
        e for e in emails
        if kw in e["subject"].lower()
        or kw in e["body"].lower()
        or kw in e["from"].lower()
        or kw in e["to"].lower()
    ]


def _imap_create(email_addr, token):
    conn = imaplib.IMAP4_SSL(IMAP_HOST, IMAP_PORT)
    conn.login(email_addr, token)
    return conn


def _imap_check(conn):
    try:
        typ, _ = conn.noop()
        return typ == "OK"
    except Exception:
        return False


def _imap_close(conn):
    try:
        conn.close()
    except Exception:
        pass
    try:
        conn.logout()
    except Exception:
        pass


def _imap_fetch(conn, criteria, limit):
    conn.select("INBOX")
    typ, data = conn.search(None, criteria)
    if typ != "OK":
        return []
    ids = data[0].split()
    if limit and len(ids) > limit:
        ids = ids[-limit:]
    results = []
    for mid in ids:
        typ, msg_data = conn.fetch(mid, "(RFC822)")
        if typ != "OK":
            continue
        raw = msg_data[0][1]
        msg = email_lib.message_from_bytes(raw)
        results.append(_parse_mail(msg))
    return results


def _imap_mark_read(conn, sender=None, subject=None):
    parts = []
    if sender:
        parts.append(f'FROM "{sender}"')
    if subject:
        parts.append(f'SUBJECT "{subject}"')
    criteria = " ".join(parts) if parts else "ALL"
    conn.select("INBOX")
    typ, data = conn.search(None, criteria)
    if typ != "OK":
        return 0
    ids = data[0].split()
    for mid in ids:
        conn.store(mid, "+FLAGS", "\\Seen")
    return len(ids)


class GmailConnectionPool:
    def __init__(self, email_addr, token, max_size=MAX_CONCURRENT_PER_ACCOUNT):
        self.email_addr = email_addr
        self.token = token
        self.max_size = max_size
        self._sem = asyncio.Semaphore(max_size)
        self._idle = deque()
        self._lock = asyncio.Lock()

    async def acquire(self):
        await self._sem.acquire()
        conn = None
        async with self._lock:
            if self._idle:
                conn = self._idle.popleft()
        if conn:
            ok = await asyncio.to_thread(_imap_check, conn)
            if ok:
                return conn
            await asyncio.to_thread(_imap_close, conn)
        return await asyncio.to_thread(_imap_create, self.email_addr, self.token)

    async def release(self, conn, broken=False):
        if broken:
            await asyncio.to_thread(_imap_close, conn)
        else:
            async with self._lock:
                self._idle.append(conn)
        self._sem.release()

    @asynccontextmanager
    async def connection(self):
        conn = await self.acquire()
        broken = False
        try:
            yield conn
        except Exception:
            broken = True
            raise
        finally:
            await self.release(conn, broken)


_pools = {}
_pools_lock = asyncio.Lock()


async def get_pool(email_addr, token):
    async with _pools_lock:
        key = email_addr
        if key not in _pools:
            _pools[key] = GmailConnectionPool(email_addr, token)
            logger.info(f"Created pool for {email_addr}")
        pool = _pools[key]
        if pool.token != token:
            pool.token = token
            pool._idle.clear()
            logger.info(f"Token updated for {email_addr}")
        return pool


async def fetch_emails(
    email_addr, token,
    to=None, sender=None, subject=None, body=None, keyword=None,
    unseen=None, start_time=None, end_time=None, limit=50,
):
    now = datetime.now(SHANGHAI_TZ)
    start_dt = parse_time(start_time, now - timedelta(hours=1))
    end_dt = parse_time(end_time, now)

    since_date = (start_dt - timedelta(days=1)).strftime("%d-%b-%Y")
    before_date = (end_dt + timedelta(days=1)).strftime("%d-%b-%Y")

    criteria = _build_imap_criteria(
        sender=sender, to=to, subject=subject, body=body,
        unseen=unseen, since_date=since_date, before_date=before_date
    )

    pool = await get_pool(email_addr, token)
    try:
        async with pool.connection() as conn:
            fetch_limit = limit * 3 if limit else 500
            results = await asyncio.to_thread(_imap_fetch, conn, criteria, fetch_limit)
    except Exception:
        logger.exception(f"IMAP fetch error for {email_addr}")
        raise

    # 确保 to 过滤精确生效(IMAP TO 搜索对 Gmail +alias 可能不精确)
    if to:
        to_lower = to.lower()
        results = [e for e in results if to_lower in e.get("to", "").lower()]
    results = _filter_by_time(results, start_dt, end_dt)
    results = _filter_by_keyword(results, keyword)
    results.sort(key=lambda x: x.get("date_iso", ""), reverse=True)
    if limit:
        results = results[:limit]
    return results


async def mark_emails_read(email_addr, token, sender=None, subject=None):
    pool = await get_pool(email_addr, token)
    try:
        async with pool.connection() as conn:
            count = await asyncio.to_thread(_imap_mark_read, conn, sender, subject)
        return count
    except Exception:
        logger.exception(f"IMAP mark_read error for {email_addr}")
        raise
