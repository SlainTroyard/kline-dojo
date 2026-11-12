"""盘中实时 K 线（只读，不落盘）。

日线最后一根：腾讯快照（qt.gtimg.cn）。字段与 bz_quote 同源，额外解析交易日期，
用于把「今天」这根临时 bar 接到历史日线末尾。
5/30 分钟：新浪 K 线接口（OHLCV 完整，含当天尚未收盘的 bar）。

只对「当前正在看的标的」按需拉取；进程内 TTL 缓存（交易时段 15s、其余 120s），
前端约 20s 轮询。上游失败时回退旧缓存，绝不写 astock / data/market。
"""
from __future__ import annotations

import json
import re
import threading
import time
import urllib.request
from datetime import datetime, timedelta, timezone

import bz_quote

CST = timezone(timedelta(hours=8))
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
_DIRECT = urllib.request.build_opener(urllib.request.ProxyHandler({}))  # 国内源直连

TTL_TRADING = 15
TTL_IDLE = 120

_lock = threading.Lock()
_qcache: dict[str, tuple[float, dict]] = {}
_mcache: dict[tuple[str, int], tuple[float, list]] = {}


def _ttl() -> int:
    return TTL_TRADING if bz_quote.trading_now() else TTL_IDLE


def _get_bytes(url: str, timeout: int = 8) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with _DIRECT.open(req, timeout=timeout) as r:
        return r.read()


def _get_text(url: str, timeout: int = 8) -> str:
    return _get_bytes(url, timeout).decode("utf-8", "ignore")


def _f(parts: list[str], i: int, default: float = 0.0) -> float:
    try:
        v = parts[i].strip()
        return float(v) if v else default
    except (IndexError, ValueError):
        return default


def quote(symbol: str, is_index: bool = False) -> dict | None:
    """腾讯快照。symbol 必须是完整前缀符号（sh600519 / sh000300 / sz000001）。

    is_index=True 时 volume 保持源口径（指数日线库里的 volume 本身是手），
    个股/ETF 则把「手」换算成股，与 data/market 的 volume 对齐。
    """
    key = f"{symbol}|{int(is_index)}"
    now = time.time()
    with _lock:
        hit = _qcache.get(key)
        if hit and now - hit[0] <= _ttl():
            return hit[1]
    try:
        raw = _get_bytes("http://qt.gtimg.cn/q=" + symbol).decode("gbk", "ignore")
        parts = None
        for chunk in raw.split(";"):
            chunk = chunk.strip()
            if not chunk.startswith("v_"):
                continue
            _head, body = chunk.split("=", 1)
            body = body.strip().strip('"')
            if body:
                parts = body.split("~")
                break
        if not parts or len(parts) < 38:
            raise ValueError("空快照")
        t = parts[30].strip()                       # yyyymmddhhmmss
        date = f"{t[:4]}-{t[4:6]}-{t[6:8]}" if len(t) >= 8 else ""
        clock = f"{t[8:10]}:{t[10:12]}:{t[12:14]}" if len(t) >= 14 else ""
        q = {
            "symbol": symbol,
            "name": parts[1].strip(),
            "date": date,
            "time": clock,
            "asof": f"{date} {clock}".strip(),
            "price": _f(parts, 3),
            "prev_close": _f(parts, 4),
            "open": _f(parts, 5),
            "high": _f(parts, 33),
            "low": _f(parts, 34),
            "volume": _f(parts, 6) * (1 if is_index else 100),
            "amount": _f(parts, 37) * 1e4,
            "chg": _f(parts, 31),
            "pct": _f(parts, 32),
        }
        q["trading"] = bool(bz_quote.trading_now() and
                            date == datetime.now(CST).strftime("%Y-%m-%d"))
        with _lock:
            _qcache[key] = (now, q)
        return q
    except Exception:                              # noqa: BLE001
        with _lock:
            hit = _qcache.get(key)
        return hit[1] if hit else None


def daily_bar(symbol: str, is_index: bool = False) -> dict:
    """今天（或最近交易日）的日线 bar：[date, open, high, low, close, volume]。"""
    q = quote(symbol, is_index)
    if not q:
        return {"error": "实时快照不可用", "trading": False}
    if min(q["open"], q["high"], q["low"], q["price"]) <= 0 or not q["date"]:
        return {"error": "今日无成交（停牌或未开盘）", "trading": False}
    return {
        "bar": [q["date"], q["open"], q["high"], q["low"], q["price"], q["volume"]],
        "asof": q["asof"],
        "trading": q["trading"],
        "name": q["name"],
    }


def _jsonp_array(raw: str) -> list:
    """新浪返回 `/*...*/ var _=([...]);`，取出数组部分。"""
    m = re.search(r"=\(\s*(\[.*\])\s*\);?\s*$", raw, re.S)
    if not m:
        return []
    try:
        v = json.loads(m.group(1))
        return v if isinstance(v, list) else []
    except json.JSONDecodeError:
        return []


def minute_bars(symbol: str, scale: int) -> dict:
    """当天分钟 K（新浪源，scale=5/30）。bars: [[ts, o, h, l, c, v], ...]。"""
    if scale not in (5, 30):
        return {"error": "仅支持 5/30 分钟", "trading": False}
    key = (symbol, scale)
    now = time.time()
    with _lock:
        hit = _mcache.get(key)
        if hit and now - hit[0] <= _ttl():
            return {"symbol": symbol, "scale": scale, "bars": hit[1],
                    "asof": hit[1][-1][0] if hit[1] else "",
                    "trading": bz_quote.trading_now()}
    n = 120 if scale == 5 else 48
    url = ("https://quotes.sina.cn/cn/api/jsonp_v2.php/var%20_=/"
           f"CN_MarketDataService.getKLineData?symbol={symbol}&scale={scale}&ma=no&datalen={n}")
    try:
        rows = _jsonp_array(_get_text(url))
        bars = []
        for r in rows:
            try:
                d = str(r.get("day") or "")
                o, h, l, c = (float(r["open"]), float(r["high"]),
                              float(r["low"]), float(r["close"]))
                v = float(r.get("volume") or 0)
            except (KeyError, TypeError, ValueError):
                continue
            if not d or min(o, h, l, c) <= 0:
                continue
            bars.append([d, o, h, l, c, v])
        if not bars:
            raise ValueError("空分钟数据")
        with _lock:
            _mcache[key] = (now, bars)
        last = bars[-1][0]
        return {"symbol": symbol, "scale": scale, "bars": bars, "asof": last,
                "trading": bool(bz_quote.trading_now() and
                                last[:10] == datetime.now(CST).strftime("%Y-%m-%d"))}
    except Exception:                              # noqa: BLE001
        with _lock:
            hit = _mcache.get(key)
        if hit:
            return {"symbol": symbol, "scale": scale, "bars": hit[1],
                    "asof": hit[1][-1][0] if hit[1] else "", "trading": False, "stale": True}
        return {"error": "分钟实时数据不可用", "trading": False}
