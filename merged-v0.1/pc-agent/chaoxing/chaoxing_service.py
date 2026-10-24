# -*- coding: utf-8 -*-
"""课堂笔记 APP 的学习通只读服务。

设计边界（2026-10-24 与用户确认）：
  * 只读：作业/互评、通知、考试、章节任务点；绝不签到、答题、提交。
  * 扫码登录：电脑生成二维码并显示在本地网页，用户用手机学习通扫；
    登录态只存本机 电脑端\\data\\chaoxing\\session_cookies.json。
  * 服务只监听 127.0.0.1:8781，由 Node(8776) 代理；不给局域网/外网直接访问。

协议（2026-10-24 实测 + 社区资料）：
  1. GET passport2.chaoxing.com/login 建会话；
  2. GET createqr?uuid=... 拿二维码图片；
  3. 解码二维码得到 toauthlogin?uuid=&enc=（uuid 以二维码里的为准）；
  4. 同一会话轮询 getauthstatus?uuid=&enc=，直到 status=true；
  5. 成功后先访问返回的 url（SSO）与二维码里的 toauthlogin，再把 cookie 并入主会话；
  6. 用 i.chaoxing.com/base 不含登录页标记来复核，避免"假登录"。

二维码 JPEG 只有 270x270，OpenCV 偶发识别失败；本文件用「加白边 + 多倍率 +
重新生成」三层兜底（实测 3/3 成功）。
"""
from __future__ import annotations

import json
import os
import random
import re
import shutil
import sys
import threading
import time
import uuid
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)                       # 电脑端\
DATA = os.path.join(ROOT, "data", "chaoxing")      # 电脑端\data\chaoxing\
VENDOR = os.path.join(HERE, "vendor")
sys.path.insert(0, VENDOR)

from xuexitong_client import (  # noqa: E402
    ChaoxingClient, LOGIN_MARKERS, URL_BASE,
    is_homework_pending, nearest_datetime_for, parse_homework_detail,
)

HOST = "127.0.0.1"
PORT = int(os.environ.get("CHAOXING_PORT") or 8781)
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36")
LOGIN_PAGE = "https://passport2.chaoxing.com/login?fid=&refer=https%3A%2F%2Fi.chaoxing.com"
CREATE_QR = "https://passport2.chaoxing.com/createqr"
AUTH_STATUS = "https://passport2.chaoxing.com/getauthstatus"

# 用户本机已有的监控登录态：只在目标文件不存在时复制一次，不移动、不覆盖。
IMPORT_COOKIES = os.environ.get("CHAOXING_IMPORT_COOKIES", "")

CACHE_TTL = 300.0          # 汇总缓存 5 分钟（用户确认的默认值）
LOGIN_TTL = 60.0           # 登录态探测缓存
LOGIN_WAIT = 180.0         # 二维码最长等待 3 分钟
PROFILE_TTL = 600.0
COOKIE_FILE = os.path.join(DATA, "session_cookies.json")
LOG_FILE = os.path.join(HERE, "chaoxing.log")

LOCK = threading.RLock()
_CLIENT = None
_LOGIN = None              # 当前登录会话 dict
_LOGIN_CHECK = {"at": 0.0, "ok": False, "error": ""}
_PROFILE = {"at": 0.0, "data": None}
_SNAP = {
    "state": "idle", "data": None, "fetchedAt": "", "error": "",
    "warning": "", "loading": False, "at": 0.0, "progress": None,
}


def log(msg: str) -> None:
    line = "[%s] %s" % (datetime.now().strftime("%Y-%m-%d %H:%M:%S"), msg)
    try:
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass
    try:
        print(line, flush=True)
    except Exception:
        pass


def short(e) -> str:
    return " ".join(str(e).split())[:180]


def now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


# ---------------------------------------------------------------- 反爬保护
# 2026-10-24 实测：并发拉 21 门课的课程页，学习通立刻返回
#   https://mooc1.chaoxing.com/antispiderShowVerify.ac
#   "【9010】操作异常，请输入图片中的验证码"
# 之后连监控项目自己的会话也一起被挡（同 IP + 同账号）。所以这里：
#   ① 所有请求串行 + 最小间隔，绝不并发；
#   ② 一看到验证页立刻停手，不补请求、不刷重试；
#   ③ 让用户在本地页面亲手输入图片验证码（不自动识别），再继续。

BLOCK_MARKS = ("antispiderShowVerify", "操作异常，请输入图片中的验证码",
               "processVerifyPng", "access too frequent")
VERIFY_ORIGIN = "https://mooc1.chaoxing.com"
VERIFY_PAGE = VERIFY_ORIGIN + "/antispiderShowVerify.ac"
VERIFY_IMG = VERIFY_ORIGIN + "/processVerifyPng.ac"
VERIFY_POST = VERIFY_ORIGIN + "/html/processVerify.ac"
MIN_GAP = 0.45              # 两次请求最小间隔（秒）
BLOCK_COOLDOWN = 90.0       # 撞一次验证码后，这段时间内不再打扰学习通

_GUARD_LOCK = threading.Lock()
_LAST_REQ = [0.0]
_BLOCK_UNTIL = [0.0]


class Blocked(RuntimeError):
    """学习通要求人机验证 / 访问过于频繁。"""


def block_active() -> bool:
    return time.time() < _BLOCK_UNTIL[0]


def _looks_blocked(r) -> bool:
    try:
        ctype = (r.headers.get("Content-Type") or "").lower()
        if "html" not in ctype and "text" not in ctype:
            return False
        url = r.url or ""
    except Exception:
        return False
    if any(m in url for m in BLOCK_MARKS):
        return True
    body = (r.text or "")[:3000]
    return any(m in body for m in BLOCK_MARKS[:2] + BLOCK_MARKS[3:])


def install_guard(c: ChaoxingClient) -> None:
    """给 vendor 客户端加两道闸：全局串行限速 + 验证页识别。"""
    if getattr(c, "_guard_installed", False):
        return
    orig_get = c.get

    def guarded_get(url: str, **kw):
        if block_active():
            raise Blocked("学习通还在等验证码，请先在电脑上完成验证")
        with _GUARD_LOCK:
            gap = MIN_GAP - (time.time() - _LAST_REQ[0])
            if gap > 0:
                time.sleep(gap)
            _LAST_REQ[0] = time.time()
        r = orig_get(url, **kw)
        if _looks_blocked(r):
            _BLOCK_UNTIL[0] = time.time() + BLOCK_COOLDOWN
            log("触发学习通人机验证，暂停请求 %d 秒" % BLOCK_COOLDOWN)
            raise Blocked("学习通要求输入验证码")
        return r

    c.get = guarded_get  # type: ignore[method-assign]
    c._guard_installed = True


def verify_image() -> bytes:
    """取当前会话的验证码图片（给用户看，程序不识别）。"""
    c = client()
    with _GUARD_LOCK:
        gap = MIN_GAP - (time.time() - _LAST_REQ[0])
        if gap > 0:
            time.sleep(gap)
        _LAST_REQ[0] = time.time()
    r = c.session.get(VERIFY_IMG, params={"t": random.randint(1, 2147483647)},
                      headers={"Referer": VERIFY_PAGE, "Accept": "image/*,*/*;q=0.8"},
                      timeout=20)
    ctype = (r.headers.get("Content-Type") or "").lower()
    if not ctype.startswith("image/"):
        raise RuntimeError("取验证码失败（%s）" % r.status_code)
    return r.content


def submit_verify(code: str) -> dict:
    """把用户输入的 4 位验证码交给学习通（等价于浏览器里点提交）。"""
    code = re.sub(r"[^0-9A-Za-z]", "", code or "")[:4]
    if len(code) != 4:
        return {"ok": False, "error": "验证码是 4 位字母或数字"}
    c = client()
    try:
        r = c.session.get(VERIFY_POST, params={"app": 0, "ucode": code},
                          headers={"Referer": VERIFY_PAGE}, timeout=20)
        if _looks_blocked(r):
            return {"ok": False, "error": "验证码不对，请重试"}
    except Exception as e:
        return {"ok": False, "error": "提交失败：" + short(e)}
    # 用 mooc1 首页复核：被挡时会 302 到 antispiderShowVerify.ac
    try:
        probe = c.session.get(VERIFY_ORIGIN + "/", timeout=20)
        ok = not _looks_blocked(probe)
    except Exception:
        ok = False
    if ok:
        _BLOCK_UNTIL[0] = 0.0
        log("人机验证通过")
        return {"ok": True}
    return {"ok": False, "error": "还没通过，请再试一次"}


# ---------------------------------------------------------------- 初始化

def ensure_dirs() -> None:
    os.makedirs(DATA, exist_ok=True)
    os.makedirs(os.path.join(DATA, "备份"), exist_ok=True)


def import_cookies_once() -> None:
    """首次运行把监控项目已登录的 cookie 复制过来，方便本机免扫码联调。

    只复制、不移动；目标已存在就绝不覆盖（可能已经是用户新扫的登录态）。
    """
    marker = os.path.join(DATA, ".cookie_imported")
    if os.path.exists(COOKIE_FILE) or os.path.exists(marker):
        return
    if not os.path.exists(IMPORT_COOKIES):
        return
    try:
        shutil.copyfile(IMPORT_COOKIES, COOKIE_FILE)
        with open(marker, "w", encoding="utf-8") as f:
            f.write(now_iso())
        log("已导入本机监控登录态（仅一次，之后独立）")
    except Exception as e:
        log("导入登录态失败（不影响扫码）：" + short(e))


def client() -> ChaoxingClient:
    global _CLIENT
    with LOCK:
        if _CLIENT is None:
            ensure_dirs()
            import_cookies_once()
            _CLIENT = ChaoxingClient(config_dir=DATA)
            install_guard(_CLIENT)
            install_page_cache(_CLIENT)
            log("学习通客户端已初始化，cookie 文件=%s" % COOKIE_FILE)
        return _CLIENT


PAGE_TTL = 240.0
_PAGE_CACHE: dict[tuple, tuple[float, str]] = {}


def install_page_cache(c: ChaoxingClient) -> None:
    """课程中间页缓存：作业与章节各要拉一次同一页，缓存后每门课少一次请求。

    只缓存看起来正常的页面（含 workEnc 或 enc 隐藏域），验证页/登录页绝不入缓存。
    """
    if getattr(c, "_page_cache_installed", False):
        return
    orig = c.fetch_course_page

    def cached(co: dict) -> str:
        key = (co.get("courseid"), co.get("clazzid"))
        hit = _PAGE_CACHE.get(key)
        if hit and time.time() - hit[0] < PAGE_TTL:
            return hit[1]
        html = orig(co)
        if "workEnc" in html or 'name="enc"' in html:
            _PAGE_CACHE[key] = (time.time(), html)
        return html

    c.fetch_course_page = cached  # type: ignore[method-assign]
    c._page_cache_installed = True


def reset_client_caches() -> None:
    """换账号/重新登录后清掉进程内课程/作业缓存。"""
    c = client()
    c._courses_cache = None
    c._courses_cache_at = 0.0
    c._hw_cache = {}
    c._sched_full_cache = None
    c._sched_full_cache_at = 0.0
    c._login_checked_at = 0.0
    _PAGE_CACHE.clear()


def save_cookies() -> None:
    """扁平 cookie 落盘（与 vendor 客户端同一格式）；临时文件 + 原子替换。"""
    try:
        c = client()
        flat = {ck.name: ck.value for ck in c.session.cookies}
        tmp = COOKIE_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(flat, f, ensure_ascii=False)
        os.replace(tmp, COOKIE_FILE)
    except Exception as e:
        log("保存 cookie 失败：" + short(e))


def backup_cookies() -> None:
    if not os.path.exists(COOKIE_FILE):
        return
    try:
        tag = datetime.now().strftime("%Y%m%d-%H%M")
        dst = os.path.join(DATA, "备份", "session_cookies.备份%s.json" % tag)
        if not os.path.exists(dst):
            shutil.copyfile(COOKIE_FILE, dst)
    except Exception as e:
        log("备份 cookie 失败（继续）：" + short(e))


# ---------------------------------------------------------------- 登录态

def _session_logged_in(sess) -> bool:
    try:
        r = sess.get(URL_BASE, timeout=15, allow_redirects=True)
        return not any(m in r.url or m in r.text for m in LOGIN_MARKERS)
    except Exception:
        return False


def login_check(use_cache: bool = True, force: bool = False) -> tuple[bool, str]:
    """True=已登录；False 时第二项是原因（网络错误会明确写出来，不冒充未登录）。"""
    now = time.time()
    if use_cache and not force and now - _LOGIN_CHECK["at"] < LOGIN_TTL:
        return _LOGIN_CHECK["ok"], _LOGIN_CHECK["error"]
    try:
        r = client().session.get(URL_BASE, timeout=12, allow_redirects=True)
        ok = not any(m in r.url or m in r.text for m in LOGIN_MARKERS)
        err = "" if ok else "未登录"
    except Exception as e:
        ok, err = False, "连不上学习通（网络问题）：" + short(e)
    _LOGIN_CHECK.update(at=now, ok=ok, error=err)
    return ok, err


def profile(force: bool = False) -> dict:
    now = time.time()
    if not force and _PROFILE["data"] is not None and now - _PROFILE["at"] < PROFILE_TTL:
        return _PROFILE["data"]
    try:
        p = client().fetch_profile()
    except Exception as e:
        p = {"name": "?", "school": "?", "error": short(e)}
    _PROFILE.update(at=now, data=p)
    return p


# ---------------------------------------------------------------- 扫码登录

def _decode_qr(img_bytes: bytes) -> str:
    """二维码图片 → 解码文本。OpenCV 对 270px JPEG 偶发失败，多形态兜底。"""
    import cv2
    import numpy as np

    img = cv2.imdecode(np.frombuffer(img_bytes, np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        return ""
    pad = cv2.copyMakeBorder(img, 40, 40, 40, 40, cv2.BORDER_CONSTANT, value=(255, 255, 255))
    variants = [img, pad]
    for s in (2, 3, 4):
        variants.append(cv2.resize(img, None, fx=s, fy=s, interpolation=cv2.INTER_CUBIC))
        variants.append(cv2.resize(pad, None, fx=s, fy=s, interpolation=cv2.INTER_CUBIC))
    det = cv2.QRCodeDetector()
    for v in variants:
        try:
            text, _, _ = det.detectAndDecode(v)
        except Exception:
            continue
        if text:
            return text
    return ""


def _prepare_qr(ls: dict) -> None:
    """给登录会话生成一张可用二维码（含 4 次重生成兜底）。"""
    import requests

    s = requests.Session()
    s.headers.update({"User-Agent": UA})
    s.get(LOGIN_PAGE, timeout=20)
    last_err = ""
    for _ in range(4):
        req_uuid = uuid.uuid4().hex
        try:
            r = s.get(CREATE_QR, params={"uuid": req_uuid},
                      headers={"Referer": LOGIN_PAGE,
                               "Accept": "image/avif,image/webp,image/*,*/*;q=0.8"},
                      timeout=20)
        except Exception as e:
            last_err = short(e)
            continue
        ctype = (r.headers.get("Content-Type") or "").lower()
        if not ctype.startswith("image/"):
            last_err = "学习通返回 %s（不是图片）" % r.status_code
            time.sleep(0.8)
            continue
        qr_url = _decode_qr(r.content)
        if not qr_url:
            last_err = "二维码识别失败"
            time.sleep(0.5)
            continue
        q = parse_qs(urlparse(qr_url).query)
        enc = (q.get("enc") or [""])[0]
        auth_uuid = (q.get("uuid") or [req_uuid])[0]
        if not enc:
            last_err = "二维码里没有 enc"
            continue
        ls.update(session=s, qr=r.content, uuid=auth_uuid, enc=enc,
                  auth_url=qr_url, state="waiting", message="等待扫码",
                  created=time.time(), error="")
        return
    raise RuntimeError(last_err or "二维码生成失败")


def _adopt_login(ls: dict, status_json: dict) -> None:
    """扫码确认后：访问 SSO / toauthlogin，把 cookie 并入主会话并复核。"""
    s = ls.get("session")
    if s is None:
        ls.update(state="failed", message="登录会话丢失，请重新扫码")
        return
    sso = str(status_json.get("url") or "")
    if sso:
        try:
            s.get(sso, timeout=20, allow_redirects=True)
        except Exception as e:
            log("访问 SSO 失败（继续）：" + short(e))
    if not _session_logged_in(s):
        try:
            s.get(ls.get("auth_url") or "", timeout=20, allow_redirects=True)
        except Exception:
            pass
    c = client()
    c.session.cookies.update(s.cookies)
    save_cookies()
    reset_client_caches()
    _LOGIN_CHECK.update(at=0.0, ok=False, error="")
    if _session_logged_in(c.session):
        _LOGIN_CHECK.update(at=time.time(), ok=True, error="")
        _PROFILE["at"] = 0.0
        ls.update(state="success", message="登录成功")
        log("扫码登录成功")
        threading.Thread(target=lambda: profile(force=True), daemon=True).start()
    else:
        ls.update(state="failed", message="登录未完成（没拿到有效 Cookie），请重试")
        log("扫码后复核仍未登录")


def _poll_login(ls: dict) -> None:
    s = ls.get("session")
    deadline = ls["created"] + LOGIN_WAIT
    while time.time() < deadline:
        if _LOGIN is not ls:
            return
        try:
            r = s.get(AUTH_STATUS, params={"uuid": ls["uuid"], "enc": ls["enc"]},
                      headers={"Referer": LOGIN_PAGE, "X-Requested-With": "XMLHttpRequest"},
                      timeout=15)
            j = r.json()
        except Exception as e:
            ls["message"] = "状态查询失败，重试中：" + short(e)
            time.sleep(2)
            continue
        mes = str(j.get("mes") or "")
        if j.get("status") is True:
            _adopt_login(ls, j)
            return
        if "已扫描" in mes or ("扫描" in mes and "未" not in mes):
            ls.update(state="scanned", message="已扫描，请在手机上点确认")
        elif "取消" in mes:
            ls.update(state="failed", message="手机上取消了登录")
            return
        elif "过期" in mes or "失效" in mes or str(j.get("type")) == "2":
            ls.update(state="expired", message="二维码已过期，请刷新")
            return
        elif str(j.get("type")) == "1":
            ls.update(state="expired", message="登录参数失效，请刷新")
            return
        else:
            ls["message"] = mes or "等待扫码"
        time.sleep(1.5)
    if _LOGIN is ls and ls.get("state") in ("waiting", "scanned"):
        ls.update(state="expired", message="等待超时（3 分钟），请刷新二维码")


def login_url(ls: dict) -> str:
    return "http://%s:%d/login/%s" % (HOST, PORT, ls["id"])


def start_login(open_browser: bool = True) -> dict:
    global _LOGIN
    with LOCK:
        if _LOGIN and _LOGIN.get("state") in ("waiting", "scanned"):
            url = login_url(_LOGIN)
            if open_browser:
                _open_browser(url)
            return {"ok": True, "state": _LOGIN.get("state"),
                    "message": _LOGIN.get("message", ""), "loginUrl": url}
        ls = {"id": uuid.uuid4().hex[:12], "state": "waiting", "message": "正在生成二维码…",
              "created": time.time(), "error": "", "qr": b"", "session": None,
              "uuid": "", "enc": "", "auth_url": ""}
        _prepare_qr(ls)
        _LOGIN = ls
        url = login_url(ls)
        threading.Thread(target=_poll_login, args=(ls,), daemon=True).start()
        log("已生成二维码，登录页=%s" % url)
    if open_browser:
        _open_browser(url)
    return {"ok": True, "state": "waiting", "message": "请用手机学习通扫码", "loginUrl": url}


def _open_browser(url: str) -> None:
    try:
        os.startfile(url)  # noqa: S606 - Windows 本地浏览器
    except Exception as e:
        log("自动打开浏览器失败（可手动打开 %s）：%s" % (url, short(e)))


def logout() -> dict:
    global _LOGIN
    backup_cookies()
    with LOCK:
        c = client()
        c.session.cookies.clear()
        try:
            tmp = COOKIE_FILE + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                f.write("{}")
            os.replace(tmp, COOKIE_FILE)
        except Exception as e:
            log("清空 cookie 失败：" + short(e))
        reset_client_caches()
        _LOGIN = None
        _LOGIN_CHECK.update(at=0.0, ok=False, error="未登录")
        _PROFILE.update(at=0.0, data=None)
        _SNAP.update(state="idle", data=None, fetchedAt="", error="",
                     warning="", loading=False, at=0.0, progress=None)
        _PAGE_CACHE.clear()
    log("已退出学习通登录（cookie 已备份后清空）")
    return {"ok": True}


# ---------------------------------------------------------------- 数据汇总

def _work_id(url: str) -> str:
    m = re.search(r"[?&](?:workId|workid|id)=(\d+)", url or "")
    return m.group(1) if m else ""


def _clean_text(s, limit: int = 800) -> str:
    t = str(s or "").replace("\r\n", "\n").replace("\r", "\n")
    t = re.sub(r"\n{3,}", "\n\n", t).strip()
    return t[:limit]


def _build_notices(c: ChaoxingClient) -> list[dict]:
    out = []
    for n in c.fetch_notices(limit=20):
        raw = n.get("isread")
        unread = str(raw).strip().lower() in ("0", "false", "")
        out.append({
            "time": str(n.get("completeTime") or n.get("sendTime") or ""),
            "sender": str(n.get("createrName") or ""),
            "title": str(n.get("title") or "（无标题）")[:120],
            "content": _clean_text(n.get("content")),
            "unread": unread,
        })
    return out


def _build_exams(c: ChaoxingClient) -> list[dict]:
    rows = []
    for r in c.fetch_exams():
        if len(r) < 8:
            continue
        rows.append({
            "index": r[0], "name": r[1], "time": r[2], "duration": r[3],
            "status": r[4], "answer": r[5], "score": r[6], "mode": r[7],
        })
    return rows[:30]


def _build_summary(force: bool) -> dict:
    c = client()
    ok, err = login_check(use_cache=not force)
    if not ok:
        return {"state": "need_login", "error": err}
    if block_active():
        return {"state": "blocked", "error": "学习通还在等验证码"}

    today = datetime.now().date()
    prof = profile(force=force)
    courses = c.fetch_courses(refresh=force)
    errors: list[str] = []
    skipped: list[str] = []
    total_steps = len(courses) * 2 + 2
    step = 0

    def bump() -> None:
        nonlocal step
        step += 1
        _SNAP["progress"] = {"done": step, "total": total_steps}

    homework: list[dict] = []
    done_count = 0
    try:
        for co in courses:
            bump()
            try:
                hw = c.fetch_homework(co, refresh=force)
            except Blocked:
                raise
            except Exception as e:
                msg = short(e)
                if "workEnc" in msg:
                    skipped.append(co["name"])   # 没开作业功能的课，不算失败
                else:
                    errors.append("%s：%s" % (co["name"], msg))
                continue
            for it in hw.get("items", []):
                kind = "互评" if "eval-list" in (it.get("url") or "") else "作业"
                status = it.get("status") or ""
                # 互评只认「待互评」；作业列表的 is_homework_pending 会把"已互评"当已完成
                pending = ("待互评" in status) if kind == "互评" else is_homework_pending(status)
                row = {
                    "course": co["name"], "title": it.get("title") or "",
                    "kind": kind, "status": status, "pending": pending,
                    "deadline": None, "workId": _work_id(it.get("url") or ""),
                }
                if pending and kind == "作业" and (it.get("url") or "").startswith("http"):
                    try:
                        d = parse_homework_detail(c.get(it["url"]).text)
                        dt = nearest_datetime_for(d["deadline"], today) if d.get("deadline") else None
                        row["deadline"] = dt.strftime("%Y-%m-%d %H:%M") if dt else None
                    except Blocked:
                        raise
                    except Exception:
                        pass
                if pending:
                    homework.append(row)
                else:
                    done_count += 1

        progress: list[dict] = []
        for co in courses:
            bump()
            row = {"course": co["name"], "done": 0, "total": 0, "pct": 0, "error": ""}
            try:
                data = c.fetch_chapters(co, with_nodes=False)
                p = data.get("progress")
                if p:
                    row["done"], row["total"] = int(p[0]), int(p[1])
                    row["pct"] = round(row["done"] * 100.0 / row["total"]) if row["total"] else 0
                else:
                    row["error"] = "暂无任务点数据"
            except Blocked:
                raise
            except Exception as e:
                row["error"] = short(e)
            progress.append(row)

        bump()
        try:
            notices = _build_notices(c)
        except Blocked:
            raise
        except Exception as e:
            notices = []
            errors.append("通知：" + short(e))

        bump()
        try:
            exams = _build_exams(c)
        except Blocked:
            raise
        except Exception as e:
            exams = []
            errors.append("考试：" + short(e))
    except Blocked as e:
        return {"state": "blocked", "error": str(e) or "学习通要求人机验证"}

    homework.sort(key=lambda x: (x.get("deadline") is None, x.get("deadline") or "9999"))

    ok2, err2 = login_check(use_cache=False, force=True)
    if not ok2:
        return {"state": "need_login", "error": err2}

    uniq: list[str] = []
    for e in errors:
        if e not in uniq:
            uniq.append(e)

    return {
        "state": "ready",
        "data": {
            "profile": prof,
            "courses": [{"name": x.get("name"), "teacher": x.get("teacher")} for x in courses],
            "homework": homework,
            "doneCount": done_count,
            "notices": notices,
            "exams": exams,
            "progress": progress,
            "errors": uniq[:12],
            "skippedCourses": sorted(set(skipped)),
            "summary": {
                "courses": len(courses),
                "pending": len(homework),
                "peer": sum(1 for x in homework if x["kind"] == "互评"),
                "unread": sum(1 for x in notices if x["unread"]),
                "exams": len(exams),
            },
        },
        "fetchedAt": now_iso(),
    }


def summary_response(force: bool = False) -> dict:
    with LOCK:
        if _SNAP["loading"]:
            return {"ok": True, "state": "loading", "data": _SNAP["data"],
                    "fetchedAt": _SNAP["fetchedAt"], "warning": _SNAP["warning"],
                    "progress": _SNAP["progress"]}
        if (not force and _SNAP["state"] in ("ready", "need_login", "blocked")
                and time.time() - _SNAP["at"] < CACHE_TTL):
            return {"ok": True, "state": _SNAP["state"], "data": _SNAP["data"],
                    "fetchedAt": _SNAP["fetchedAt"], "warning": _SNAP["warning"],
                    "error": _SNAP["error"], "cached": True, "progress": None}
        _SNAP["loading"] = True
        _SNAP["progress"] = {"done": 0, "total": 0}
        old = dict(_SNAP)

    def run() -> None:
        try:
            r = _build_summary(force)
        except Exception as e:
            log("汇总失败：" + short(e))
            r = {"state": "error", "error": short(e)}
        with LOCK:
            _SNAP["loading"] = False
            _SNAP["progress"] = None
            if r.get("state") == "ready":
                _SNAP.update(state="ready", data=r["data"], fetchedAt=r.get("fetchedAt", ""),
                             warning="", error="", at=time.time())
            elif r.get("state") == "need_login":
                # 即使有旧数据也必须保持 need_login 状态：APP 要据此显示「重新扫码」按钮。
                # 旧数据一起带回去，页面可以「登录卡 + 上次数据」同时显示。
                _SNAP.update(state="need_login", data=old.get("data"),
                             fetchedAt=old.get("fetchedAt", ""),
                             warning="登录已过期，下面是上次的数据" if old.get("data") else "",
                             error=r.get("error", ""), at=time.time())
            elif r.get("state") == "blocked":
                # 验证码期间保留上次数据，同时把"要验证"明确传下去
                _SNAP.update(state="blocked", data=old.get("data"),
                             fetchedAt=old.get("fetchedAt", ""),
                             warning="学习通要求输入验证码", error=r.get("error", ""),
                             at=time.time())
                log("汇总暂停：学习通要求人机验证")
            else:
                if old.get("data"):
                    _SNAP.update(state="ready", warning="这次更新失败：" + r.get("error", ""),
                                 at=time.time())
                else:
                    _SNAP.update(state="error", data=None, warning="",
                                 error=r.get("error", ""), at=time.time())

    threading.Thread(target=run, daemon=True).start()
    return {"ok": True, "state": "loading", "data": old.get("data"),
            "fetchedAt": old.get("fetchedAt", ""), "warning": old.get("warning", ""),
            "progress": {"done": 0, "total": 0}}


# ---------------------------------------------------------------- HTTP

LOGIN_HTML = """<!doctype html>
<html lang="zh-CN"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>学习通扫码登录</title>
<style>
 body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
      font-family:-apple-system,"Microsoft YaHei",sans-serif;background:#f5f6f8;color:#1f2430}
 .box{background:#fff;border-radius:18px;padding:28px 32px;box-shadow:0 12px 36px rgba(20,30,50,.12);
      text-align:center;max-width:420px}
 h1{font-size:20px;margin:0 0 6px}
 .tip{color:#8a93a0;font-size:13px;margin:0 0 18px}
 img{width:270px;height:270px;border-radius:8px;border:1px solid #e8ebef}
 #s{margin:16px 0 6px;font-size:15px;color:#2563eb;min-height:22px}
 #u{font-size:12px;color:#8a93a0;word-break:break-all}
 button{margin-top:14px;border:0;border-radius:12px;padding:10px 22px;font-size:15px;
        background:#2563eb;color:#fff;cursor:pointer}
 button:disabled{background:#c7d2fe;cursor:default}
</style>
<div class="box">
 <h1>学习通扫码登录</h1>
 <p class="tip">请用手机上的「学习通」扫一扫</p>
 <img src="/login/__ID__/qr" alt="二维码">
 <div id="s">等待扫码…</div>
 <div id="u"></div>
 <button id="b" onclick="refresh()">刷新二维码</button>
</div>
<script>
let done=false;
async function tick(){
  if(done) return;
  try{
    const r=await fetch('/login/__ID__/status',{cache:'no-store'});
    const j=await r.json();
    const s=document.getElementById('s');
    if(j.state==='success'){done=true;s.style.color='#059669';s.textContent='✅ 已登录，可以回到手机 APP 了';document.getElementById('b').style.display='none';}
    else if(j.state==='scanned'){s.textContent='已扫描，请在手机上点确认';}
    else if(j.state==='expired'){s.textContent='二维码已过期，点下面刷新';}
    else if(j.state==='failed'){s.textContent='登录失败：'+(j.message||'请重试');}
    else {s.textContent=j.message||'等待扫码…';}
  }catch(e){}
}
async function refresh(){
  const b=document.getElementById('b'); b.disabled=true;
  try{
    const r=await fetch('/login/__ID__/refresh',{method:'POST'});
    const j=await r.json();
    if(j.loginUrl){location.replace(j.loginUrl);return;}
  }catch(e){}
  b.disabled=false; location.reload();
}
tick(); setInterval(tick,1500);
</script>
</html>"""


VERIFY_HTML = """<!doctype html>
<html lang="zh-CN"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>学习通安全验证</title>
<style>
 body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
      font-family:-apple-system,"Microsoft YaHei",sans-serif;background:#f5f6f8;color:#1f2430}
 .box{background:#fff;border-radius:18px;padding:28px 32px;box-shadow:0 12px 36px rgba(20,30,50,.12);
      text-align:center;max-width:420px}
 h1{font-size:20px;margin:0 0 6px}
 .tip{color:#8a93a0;font-size:13px;line-height:1.6;margin:0 0 16px}
 img{width:208px;height:88px;border-radius:8px;border:1px solid #e8ebef;cursor:pointer}
 input{width:150px;margin-top:14px;padding:10px 12px;font-size:18px;letter-spacing:6px;
       text-align:center;border:1px solid #d5dae2;border-radius:10px;outline:none}
 button{margin-left:8px;border:0;border-radius:10px;padding:11px 18px;font-size:15px;
        background:#2563eb;color:#fff;cursor:pointer}
 button:disabled{background:#c7d2fe;cursor:default}
 #s{margin-top:14px;font-size:14px;color:#dc2626;min-height:20px}
</style>
<div class="box">
 <h1>学习通安全验证</h1>
 <p class="tip">学习通检测到访问异常，需要你亲自输入图片里的 4 位验证码。<br>
  程序不会自动识别验证码——这一步必须由你完成。</p>
 <img id="c" src="/verify/captcha" onclick="reloadImg()" title="看不清点我换一张">
 <div><input id="u" maxlength="4" autocomplete="off" placeholder="验证码">
      <button id="b" onclick="send()">提交</button></div>
 <div id="s"></div>
</div>
<script>
function reloadImg(){document.getElementById('c').src='/verify/captcha?t='+Date.now();}
async function send(){
  const u=document.getElementById('u'), s=document.getElementById('s'), b=document.getElementById('b');
  const code=(u.value||'').trim(); if(code.length!==4){s.textContent='请输入 4 位验证码';return;}
  b.disabled=true; s.style.color='#8a93a0'; s.textContent='提交中…';
  try{
    const r=await fetch('/verify/submit',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({code:code})});
    const j=await r.json();
    if(j.ok){s.style.color='#059669';s.textContent='✅ 验证通过，回手机 APP 点刷新即可';b.style.display='none';}
    else{s.style.color='#dc2626';s.textContent=j.error||'验证失败';b.disabled=false;reloadImg();u.value='';}
  }catch(e){s.style.color='#dc2626';s.textContent='连不上本机服务';b.disabled=false;}
}
document.getElementById('u').addEventListener('keydown',e=>{if(e.key==='Enter')send();});
</script>
</html>"""


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # 静音默认访问日志
        return

    def _json(self, obj, code: int = 200) -> None:
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            self.wfile.write(body)
        except Exception:
            pass

    def _bytes(self, data: bytes, ctype: str) -> None:
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            self.wfile.write(data)
        except Exception:
            pass

    def _html(self, text: str) -> None:
        body = text.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            self.wfile.write(body)
        except Exception:
            pass

    def do_GET(self) -> None:
        u = urlparse(self.path)
        p, q = u.path, parse_qs(u.query)
        if p == "/health":
            return self._json({"ok": True, "ts": int(time.time())})
        if p == "/status":
            ok, err = login_check()
            lg = _LOGIN or {}
            return self._json({
                "ok": True, "loggedIn": ok, "error": err,
                "profile": _PROFILE["data"] if ok else None,
                "login": {"state": lg.get("state", "idle"),
                          "message": lg.get("message", ""),
                          "loginUrl": login_url(lg) if lg else ""},
            })
        if p == "/login/status":
            lg = _LOGIN or {}
            return self._json({"ok": True, "state": lg.get("state", "idle"),
                               "message": lg.get("message", ""),
                               "loginUrl": login_url(lg) if lg else "",
                               "loggedIn": _LOGIN_CHECK["ok"]})
        if p == "/summary":
            return self._json(summary_response(force=(q.get("force") or ["0"])[0] == "1"))
        if p == "/verify":
            return self._html(VERIFY_HTML)
        if p == "/verify/captcha":
            try:
                return self._bytes(verify_image(), "image/png")
            except Exception as e:
                return self._json({"ok": False, "error": short(e)}, 500)
        m = re.match(r"^/login/([0-9a-f]{12})(?:/(qr|status))?$", p)
        if m:
            lid, sub = m.group(1), m.group(2)
            if not _LOGIN or _LOGIN.get("id") != lid:
                return self._json({"ok": False, "error": "登录会话不存在或已刷新"}, 404)
            if sub == "qr":
                return self._bytes(_LOGIN.get("qr") or b"", "image/jpeg")
            if sub == "status":
                return self._json({"state": _LOGIN.get("state", "waiting"),
                                   "message": _LOGIN.get("message", "")})
            return self._html(LOGIN_HTML.replace("__ID__", lid))
        return self._json({"ok": False, "error": "没有这个接口"}, 404)

    def do_POST(self) -> None:
        u = urlparse(self.path)
        p, q = u.path, parse_qs(u.query)
        # 读掉请求体，避免 keep-alive 残留；验证码接口要用
        raw = b""
        try:
            n = int(self.headers.get("Content-Length") or 0)
            if n > 0:
                raw = self.rfile.read(n)
        except Exception:
            pass
        if p == "/login/start":
            try:
                return self._json(start_login(open_browser=(q.get("open") or ["1"])[0] != "0"))
            except Exception as e:
                log("生成二维码失败：" + short(e))
                return self._json({"ok": False, "state": "failed",
                                   "error": "生成二维码失败：" + short(e)}, 500)
        if p == "/logout":
            return self._json(logout())
        if p == "/verify/open":
            _open_browser("http://%s:%d/verify" % (HOST, PORT))
            return self._json({"ok": True})
        if p == "/verify/submit":
            code = ""
            try:
                code = str(json.loads(raw.decode("utf-8") or "{}").get("code") or "")
            except Exception:
                try:
                    code = (parse_qs(raw.decode("utf-8")).get("code") or [""])[0]
                except Exception:
                    code = ""
            return self._json(submit_verify(code))
        m = re.match(r"^/login/([0-9a-f]{12})/refresh$", p)
        if m:
            if not _LOGIN or _LOGIN.get("id") != m.group(1):
                return self._json({"ok": False, "error": "登录会话不存在"}, 404)
            try:
                r = start_login(open_browser=False)
                return self._json(r)
            except Exception as e:
                return self._json({"ok": False, "error": short(e)}, 500)
        return self._json({"ok": False, "error": "没有这个接口"}, 404)


def main() -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    ensure_dirs()
    log("学习通服务启动 http://%s:%d" % (HOST, PORT))
    srv = ThreadingHTTPServer((HOST, PORT), Handler)
    srv.daemon_threads = True
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
