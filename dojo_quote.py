"""实时行情（腾讯 qt.gtimg.cn 低频轮询）：自选列表用，延迟 ~分钟级。

只读外部行情，**不写** astock / baostock 数据目录；进程内 TTL 缓存
（交易时段 30s、非交易时段 300s），前端每 60s 拉一次本服务即可。

接口：GET /api/market/quotes?codes=600519,000001
返回：{"asof": "14:32:05", "trading": true, "quotes": {"600519": {...}}}
"""
from __future__ import annotations

import threading
import time
import urllib.request
from datetime import datetime, timedelta, timezone

CST = timezone(timedelta(hours=8))
TTL_TRADING = 30          # 交易时段缓存秒数
TTL_IDLE = 300            # 非交易时段（收盘价不变，少打扰上游）
MAX_CODES = 80

_cache: dict[str, tuple[float, dict]] = {}
_lock = threading.Lock()


def _prefix(code: str) -> str:
    """裸 6 位代码 → 腾讯符号（sh/sz/bj）"""
    if code[:1] in ("6", "9", "5"):      # 沪市股票 / B股 / ETF
        return "sh" + code
    if code[:1] in ("4", "8"):           # 北交所
        return "bj" + code
    return "sz" + code                    # 深市 0/1/2/3


def trading_now() -> bool:
    now = datetime.now(CST)
    if now.weekday() >= 5:
        return False
    hm = now.hour * 60 + now.minute
    return (9 * 60 + 15 <= hm <= 11 * 60 + 35) or (12 * 60 + 55 <= hm <= 15 * 60 + 5)


def _f(parts: list[str], i: int, default: float = 0.0) -> float:
    try:
        v = parts[i].strip()
        return float(v) if v else default
    except (IndexError, ValueError):
        return default


def _fetch(codes: list[str]) -> dict[str, dict]:
    syms = ",".join(_prefix(c) for c in codes)
    url = "http://qt.gtimg.cn/q=" + syms
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=8) as r:
        raw = r.read().decode("gbk", "ignore")
    out: dict[str, dict] = {}
    for line in raw.split(";"):
        line = line.strip()
        if not line.startswith("v_"):
            continue
        try:
            head, body = line.split("=", 1)
            parts = body.strip().strip('"').split("~")
            if len(parts) < 35:
                continue
            code = parts[2]
            t = parts[30].strip()               # yyyymmddhhmmss（盘后/停牌可能为空）
            tstr = f"{t[8:10]}:{t[10:12]}:{t[12:14]}" if len(t) >= 14 else ""
            out[code] = {
                "code": code,
                "name": parts[1].strip(),
                "price": _f(parts, 3),
                "prev_close": _f(parts, 4),
                "open": _f(parts, 5),
                "high": _f(parts, 33),
                "low": _f(parts, 34),
                "volume": int(_f(parts, 6) * 100),        # 手 → 股
                "amount": _f(parts, 37) * 1e4,            # 万 → 元
                "chg": _f(parts, 31),
                "pct": _f(parts, 32),
                "time": tstr,
            }
        except (ValueError, IndexError):
            continue
    return out


def quotes(codes: list[str]) -> tuple[dict[str, dict], bool]:
    """批量取行情（带 TTL 缓存）。返回 ({code: quote}, 是否交易时段)。"""
    codes = [c for c in codes if c and len(c) == 6][:MAX_CODES]
    if not codes:
        return {}, trading_now()
    trading = trading_now()
    ttl = TTL_TRADING if trading else TTL_IDLE
    now = time.time()
    with _lock:
        todo = [c for c in codes if c not in _cache or now - _cache[c][0] > ttl]
    if todo:
        try:
            fresh = _fetch(todo)
        except Exception:                     # 上游挂了就用旧缓存兜底
            fresh = {}
        with _lock:
            for c in todo:
                if c in fresh:
                    _cache[c] = (now, fresh[c])
    with _lock:
        return {c: _cache[c][1] for c in codes if c in _cache}, trading
