"""指数日线缓存层（腾讯 ifzq 为主，纳指100 走 Yahoo）。

- 缓存存本项目 data/index/*.parquet（A股 11 指数另有 dojo_update.py 的 baostock
  合流追加，同文件 append-only）
- 腾讯单次上限 800 根 → 按日期窗自适应翻页拿全历史（上证 1990 起、标普 1928 起）
- 纳指100 腾讯无历史 → Yahoo chart 接口 ^NDX 一次拿全量
- 指数为价格指数无除权，接口的 qfq 参数仅为格式兼容
- 腾讯返回顺序是 [日期, 开, 收, 高, 低, 量]，入库转为标准 OHLCV

为何不用 baostock/东财：baostock 无海外指数；东财 push2his 在本机网络 502。
腾讯源是每日在用的已验证通道。代理策略：腾讯等国内源强制直连（不经代理出口），
Yahoo（纳指100）国内直连不通、保留系统代理。
"""
from __future__ import annotations

import json
import time
import urllib.request
from datetime import date, timedelta
from pathlib import Path

import pandas as pd

CACHE = Path(__file__).resolve().parent / "data" / "index"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
MAX_BARS = 800          # 腾讯单次返回上限
HOST = "https://web.ifzq.gtimg.cn/appstock/app"

INSTRUMENTS = [
    # A股宽基/风格
    {"key": "sh000001", "name": "上证指数", "group": "A股", "start": "1990-12-19"},
    {"key": "sz399001", "name": "深证成指", "group": "A股", "start": "1991-04-03"},
    {"key": "sh000300", "name": "沪深300", "group": "A股", "start": "2002-01-04"},
    {"key": "sh000016", "name": "上证50", "group": "A股", "start": "2004-01-02"},
    {"key": "sh000905", "name": "中证500", "group": "A股", "start": "2007-01-15"},
    {"key": "sh000852", "name": "中证1000", "group": "A股", "start": "2014-10-17"},
    {"key": "sh000903", "name": "中证100", "group": "A股", "start": "2006-01-04"},
    {"key": "sz399006", "name": "创业板指", "group": "A股", "start": "2010-06-01"},
    {"key": "sh000688", "name": "科创50", "group": "A股", "start": "2020-01-02"},
    {"key": "sh000922", "name": "中证红利", "group": "A股", "start": "2005-01-04"},
    {"key": "sz399303", "name": "国证2000", "group": "A股", "start": "2014-03-24"},
    # 海外（src=yahoo 的走 Yahoo chart 接口）
    {"key": "usINX", "name": "标普500", "group": "海外", "start": "1928-01-03"},
    {"key": "usIXIC", "name": "纳斯达克综合", "group": "海外", "start": "1971-02-08"},
    {"key": "usNDX", "name": "纳斯达克100", "group": "海外", "start": "1985-10-01", "src": "yahoo", "symbol": "^NDX"},
    {"key": "usDJI", "name": "道琼斯", "group": "海外", "start": "1928-01-03"},
    {"key": "hkHSI", "name": "恒生指数", "group": "海外", "start": "1986-12-31"},
    {"key": "hkHSTECH", "name": "恒生科技", "group": "海外", "start": "2020-07-27"},
    {"key": "hkHSCEI", "name": "恒生国企", "group": "海外", "start": "1993-07-15"},
]
BY_KEY = {i["key"]: i for i in INSTRUMENTS}


# 腾讯等国内源强制直连（无视 http_proxy/https_proxy 环境变量——本机若挂代理，
# 行情拉取不经过代理出口，避免代理出口 IP 被限流/封禁连累）；雅虎源国内
# 直连不通，保留系统代理。
_DIRECT_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def _http_json(url: str, retries: int = 2, direct: bool = False) -> dict:
    """带重试的 GET（Yahoo 偶发 SSL 断连、腾讯偶发限流）。
    direct=True 强制直连（绕过代理环境变量）。"""
    last = None
    for i in range(retries + 1):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            if direct:
                with _DIRECT_OPENER.open(req, timeout=20) as r:
                    return json.loads(r.read().decode("utf-8"))
            with urllib.request.urlopen(req, timeout=20) as r:
                return json.loads(r.read().decode("utf-8"))
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(0.8 * (i + 1))
    raise last


def fetch_full_yahoo(symbol: str, first_trade: str) -> pd.DataFrame:
    """Yahoo chart 接口分段拿全历史日线（纳指100 用）。日期取交易所时区。

    range=max 会被降级成稀疏数据，必须用显式 period1/period2 分段拉。
    段长 1200 天（~830 交易日）单段完整。
    """
    p1 = int(date.fromisoformat(first_trade).strftime("%s")) - 86400
    now = int(time.time())
    frames = []
    while p1 < now:
        p2 = min(p1 + 1200 * 86400, now)
        url = (f"https://query1.finance.yahoo.com/v8/finance/chart/{urllib.request.quote(symbol)}"
               f"?period1={p1}&period2={p2}&interval=1d")
        d = _http_json(url)
        r = (((d.get("chart") or {}).get("result")) or [None])[0]
        if r:
            ts = r.get("timestamp") or []
            q = ((r.get("indicators") or {}).get("quote") or [{}])[0]
            tz = r.get("meta", {}).get("exchangeTimezoneName", "America/New_York")
            dates = pd.to_datetime(ts, unit="s", utc=True).tz_convert(tz).strftime("%Y-%m-%d")
            rows = []
            for i, dt in enumerate(dates):
                o, h, l, c = (q.get(k, [None] * len(ts))[i] for k in ("open", "high", "low", "close"))
                if None in (o, h, l, c):
                    continue
                rows.append({"date": dt, "open": float(o), "close": float(c),
                             "high": float(h), "low": float(l),
                             "volume": float(q.get("volume", [0] * len(ts))[i] or 0)})
            if rows:
                frames.append(pd.DataFrame(rows))
        p1 = p2
        time.sleep(0.25)
    if not frames:
        raise RuntimeError(f"yahoo {symbol} 无数据")
    df = pd.concat(frames, ignore_index=True)
    return df.drop_duplicates("date").sort_values("date").reset_index(drop=True)


def fetch_window(key: str, start: str, end: str) -> list[list]:
    """拉一个日期窗（≤800 根），统一走 kline/kline（指数无需复权；
    fqkline 端点易被限流 501，且对指数无额外价值）。键名不统一故遍历取 day。"""
    url = f"{HOST}/kline/kline?param={key},day,{start},{end},{MAX_BARS}"
    d = _http_json(url, direct=True)
    if d.get("code") != 0:
        raise RuntimeError(f"{key} 接口错误: {d.get('msg')}")
    for v in (d.get("data") or {}).values():
        if isinstance(v, dict) and v.get("day"):
            return [b for b in v["day"] if len(b) >= 6]
    return []


def _to_df(raw: list[list]) -> pd.DataFrame:
    # 腾讯顺序: [日期, 开, 收, 高, 低, 量]
    rows = [{
        "date": b[0],
        "open": float(b[1]), "close": float(b[2]),
        "high": float(b[3]), "low": float(b[4]),
        "volume": float(b[5] or 0),
    } for b in raw]
    df = pd.DataFrame(rows)
    return df.drop_duplicates("date").sort_values("date").reset_index(drop=True)


def _path(key: str) -> Path:
    return CACHE / f"{key}.parquet"


def load(key: str) -> pd.DataFrame | None:
    p = _path(key)
    if not p.exists():
        return None
    return pd.read_parquet(p)


def _save(key: str, df: pd.DataFrame) -> None:
    CACHE.mkdir(parents=True, exist_ok=True)
    df.to_parquet(_path(key), index=False)


def backfill(key: str, log=print) -> pd.DataFrame:
    """全历史回填：日期窗自适应翻页（窗口从 10 年逐级减半到 180 天，保证不截断）。"""
    meta = BY_KEY.get(key)
    if not meta:
        raise LookupError(f"未知指数 {key}")
    start = date.fromisoformat(meta["start"])
    today = date.today()
    raw: list[list] = []
    while start <= today:
        for span in (3650, 1460, 730, 365, 180):
            end = min(start + timedelta(days=span), today)
            w = fetch_window(key, start.isoformat(), end.isoformat())
            if len(w) < MAX_BARS:      # 未打满 → 窗口完整
                break
            time.sleep(0.2)
        if not w:
            start = end + timedelta(days=1)
            continue
        raw.extend(w)
        start = date.fromisoformat(w[-1][0]) + timedelta(days=1)
        time.sleep(0.2)
    df = _to_df(raw)
    _save(key, df)
    log(f"[index] {key} {meta['name']} 回填 {len(df)} 根（{df['date'].iloc[0]} ~ {df['date'].iloc[-1]}）")
    return df


def refresh(key: str, log=print) -> dict:
    """增量刷新一个指数；无缓存则全量回填。Yahoo 源每次全量（一次请求）。"""
    meta = BY_KEY[key]
    if meta.get("src") == "yahoo":
        df = fetch_full_yahoo(meta["symbol"], meta["start"])
        _save(key, df)
        time.sleep(0.3)
        return {"key": key, "name": meta["name"], "bars": len(df),
                "last": df["date"].iloc[-1] if len(df) else None}
    df = load(key)
    if df is None or df.empty:
        df = backfill(key, log=log)
    else:
        last = date.fromisoformat(df["date"].iloc[-1])
        today = date.today()
        if last >= today:
            pass
        else:
            w = fetch_window(key, (last + timedelta(days=1)).isoformat(), today.isoformat())
            if len(w) >= MAX_BARS:     # 缺口太大被截断 → 重建
                df = backfill(key, log=log)
            elif w:
                df = pd.concat([df, _to_df(w)], ignore_index=True)
                df = df.drop_duplicates("date").sort_values("date").reset_index(drop=True)
                _save(key, df)
    return {"key": key, "name": meta["name"], "bars": len(df),
            "last": df["date"].iloc[-1] if len(df) else None}


def refresh_all(log=print) -> list[dict]:
    out = []
    for i in INSTRUMENTS:
        try:
            out.append(refresh(i["key"], log=log))
        except Exception as e:  # noqa: BLE001
            log(f"[index] {i['key']} 刷新失败: {e}")
            out.append({"key": i["key"], "name": i["name"], "error": str(e)})
        time.sleep(0.2)
    return out


def list_status() -> list[dict]:
    """清单 + 本地缓存状态（供前端列表展示）。"""
    out = []
    for i in INSTRUMENTS:
        df = load(i["key"])
        out.append({
            **i,
            "cached": df is not None,
            "bars": len(df) if df is not None else 0,
            "last": df["date"].iloc[-1] if df is not None and len(df) else None,
        })
    return out


def kline_json(key: str, log=print) -> dict:
    """全量日线 JSON（前端聚合周/月/年）。无缓存时同步回填。"""
    meta = BY_KEY.get(key)
    if not meta:
        raise LookupError(f"未知指数 {key}")
    df = load(key)
    if df is None or df.empty:
        df = backfill(key, log=log)
    bars = [
        [r.date, round(r.open, 3), round(r.high, 3), round(r.low, 3),
         round(r.close, 3), int(r.volume)]
        for r in df.itertuples(index=False)
    ]
    return {"key": key, "name": meta["name"], "group": meta["group"], "bars": bars}


if __name__ == "__main__":
    # 独立刷新入口（供 systemd timer / cron 使用）：
    #   astock/.venv/bin/python dojo_index.py
    for r in refresh_all():
        print(r)
