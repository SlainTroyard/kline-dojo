#!/usr/bin/env python3
"""K线道场 KLineDojo——本地服务（原「爆竹训练营」）。

用法：
    .venv/bin/python server.py [--port 8870]
    .venv/bin/python server.py --selftest

零第三方 Web 依赖：标准库 http.server 提供 静态页面(web/) + JSON API；
行情数据读 data/market/（由 bz_update.py 用 baostock 从零建立并维护）。
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

import bz_data  # noqa: E402
import bz_index  # noqa: E402
import bz_session  # noqa: E402

WEB = ROOT / "web"
RESULTS = ROOT / "data" / "results.jsonl"

SESSIONS: dict[str, dict] = {}
LOCK = threading.Lock()

MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
}


# ---------------------------------------------------------------- stats ----

def read_results() -> list[dict]:
    if not RESULTS.exists():
        return []
    out = []
    for line in RESULTS.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line:
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                pass
    return out


def stats() -> dict:
    rows = read_results()
    if not rows:
        return {"games": 0}
    rets = [r.get("return_pct", 0.0) for r in rows]
    wins = sum(1 for x in rets if x > 0)
    by_cat: dict[str, dict] = {}
    for r in rows:
        c = by_cat.setdefault(r.get("category", "?"), {"games": 0, "wins": 0, "ret_sum": 0.0})
        c["games"] += 1
        c["wins"] += 1 if r.get("return_pct", 0) > 0 else 0
        c["ret_sum"] += r.get("return_pct", 0.0)
    for c in by_cat.values():
        c["avg_return"] = round(c.pop("ret_sum") / c["games"], 4)
        c["win_rate"] = round(c["wins"] / c["games"], 4)
    return {
        "games": len(rows),
        "wins": wins,
        "win_rate": round(wins / len(rows), 4),
        "avg_return": round(sum(rets) / len(rets), 4),
        "best": round(max(rets), 4),
        "worst": round(min(rets), 4),
        "by_category": by_cat,
        "recent": rows[-10:][::-1],
    }


# ----------------------------------------------------------------- api ----

def api_new(body: dict) -> dict:
    category = body.get("category", "stock")
    if category not in ("stock", "etf", "limit", "custom", "index"):
        raise ValueError("category 必须是 stock / etf / limit / custom / index")
    public, secret = bz_session.new_session(category, body.get("params") or {})
    with LOCK:
        SESSIONS[public["sid"]] = secret
    return public


def api_reveal(body: dict) -> dict:
    sid = (body or {}).get("sid", "")
    with LOCK:
        secret = SESSIONS.get(sid)
    if not secret:
        raise LookupError("会话不存在或已失效")
    return {
        "code": secret["code"],
        "name": secret["name"],
        "board": secret["board"],
        "category": secret["category"],
        "start_date": secret["start_date"],
        "end_date": secret["end_date"],
        "dates": secret["dates"],
    }


def api_finish(body: dict) -> dict:
    sid = (body or {}).get("sid", "")
    result = (body or {}).get("result") or {}
    replay = (body or {}).get("replay") or {}
    with LOCK:
        secret = SESSIONS.get(sid)
    row = {
        "ts": time.strftime("%Y-%m-%d %H:%M:%S"),
        "category": result.get("category", "?"),
        "sid": sid,
    }
    if secret:
        row.update({
            "code": secret["code"],
            "name": secret["name"],
            "start_date": secret["start_date"],
            "end_date": secret["end_date"],
        })
    for k in ("capital", "final_equity", "return_pct", "benchmark_pct", "max_drawdown",
              "trades", "wins", "losses", "bars_played", "duration_sec", "ended_by", "fill_mode"):
        if k in result:
            row[k] = result[k]
    # 复盘包：前端出 bars/交易/权益曲线，服务端补揭晓身份+真实日期，一次落盘
    if secret and replay.get("bars"):
        safe_sid = re.sub(r"[^A-Za-z0-9_-]", "", sid) or "nosid"
        fn = f"{time.strftime('%Y%m%d_%H%M%S')}_{safe_sid}.json"
        pack = {
            "sid": sid, "ts": row["ts"],
            "code": secret["code"], "name": secret["name"], "board": secret["board"],
            "category": secret["category"],
            "start_date": secret["start_date"], "end_date": secret["end_date"],
            "dates": secret["dates"],
            "result": result,
        }
        pack.update(replay)
        replays = RESULTS.parent / "replays"
        replays.mkdir(parents=True, exist_ok=True)
        (replays / fn).write_text(json.dumps(pack, ensure_ascii=False), encoding="utf-8")
        row["replay"] = fn
    RESULTS.parent.mkdir(parents=True, exist_ok=True)
    with LOCK:
        with RESULTS.open("a", encoding="utf-8") as f:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
    return {"ok": True}


def api_results_delete(body: dict) -> dict:
    """删单条（按 ts）或清空全部成绩；连带删复盘文件。"""
    all_ = bool((body or {}).get("all"))
    ts = (body or {}).get("ts") or ""
    if all_:
        with LOCK:
            if RESULTS.exists():
                RESULTS.unlink()
        n = 0
        replays = RESULTS.parent / "replays"
        if replays.is_dir():
            for f in replays.glob("*.json"):
                f.unlink()
                n += 1
        return {"ok": True, "deleted": n}
    rows = read_results()
    keep, drop = [], []
    for r in rows:
        (drop if r.get("ts") == ts else keep).append(r)
    for r in drop:
        if r.get("replay"):
            f = RESULTS.parent / "replays" / r["replay"]
            if f.is_file():
                f.unlink()
    with LOCK:
        RESULTS.parent.mkdir(parents=True, exist_ok=True)
        RESULTS.write_text(
            "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in keep), encoding="utf-8")
    return {"ok": True, "deleted": len(drop)}


# ------------------------------------------------------- index 指数看板 ----

def _idx_log(msg: str):
    sys.stderr.write(msg + "\n")


def start_index_refresher() -> None:
    """启动时后台增量刷新全部指数缓存（首次会全量回填，不阻塞服务）。"""
    import threading

    def run():
        try:
            bz_index.refresh_all(log=_idx_log)
        except Exception as e:  # noqa: BLE001
            _idx_log(f"[index] 后台刷新异常: {e}")

    t = threading.Thread(target=run, daemon=True, name="index-refresh")
    t.start()


# ------------------------------------------------- market 行情更新(baostock) ----

VENV_PY = ROOT / ".venv" / "bin" / "python"
UPDATE_LOG = ROOT / "data" / "update.log"
_update_proc = None


def start_market_update() -> dict:
    """后台跑 bz_update.py --update（增量+新股）；完成后清 bz_data 缓存让新数据可见。"""
    global _update_proc
    if _update_proc and _update_proc.poll() is None:
        return {"running": True, "started": False}
    if not VENV_PY.exists():
        raise RuntimeError("未配置 .venv（baostock），见 README「数据更新」章节")
    import subprocess

    UPDATE_LOG.parent.mkdir(parents=True, exist_ok=True)
    with UPDATE_LOG.open("ab") as lf:
        lf.write(f"\n==== {time.strftime('%Y-%m-%d %H:%M:%S')} 页面触发 ====\n".encode("utf-8"))
        _update_proc = subprocess.Popen(
            [str(VENV_PY), str(ROOT / "bz_update.py"), "--update"],
            stdout=lf, stderr=subprocess.STDOUT, cwd=str(ROOT))

    def watch():
        _update_proc.wait()
        with LOCK:
            for fn in (bz_data.daily, bz_data.instruments, bz_data.names, bz_data._codes):
                fn.cache_clear()

    threading.Thread(target=watch, daemon=True, name="market-update").start()
    return {"running": True, "started": True}


def market_update_status() -> dict:
    running = bool(_update_proc and _update_proc.poll() is None)
    tail = ""
    try:
        tail = "".join(UPDATE_LOG.open(encoding="utf-8", errors="replace").readlines()[-15:])
    except OSError:
        pass
    return {"running": running, "log_tail": tail}


# -------------------------------------------------------------- handler ----

class QuietHTTPServer(ThreadingHTTPServer):
    """浏览器断开连接是常态，别打整屏 traceback。"""

    def handle_error(self, request, client_address):
        exc = sys.exception()
        if isinstance(exc, (ConnectionResetError, BrokenPipeError)):
            return
        import traceback
        sys.stderr.write("----- %s -----\n" % (client_address,))
        traceback.print_exc()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # 安静一点
        if "/api/" in (str(args[0]) if args else ""):   # args[0] 可能是 HTTPStatus 枚举
            sys.stderr.write("%s %s\n" % (self.address_string(), fmt % args))

    # ---- helpers ----
    def _send(self, code: int, ctype: str, payload: bytes):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(payload)

    def _json(self, obj, code=200):
        self._send(code, "application/json; charset=utf-8",
                   json.dumps(obj, ensure_ascii=False).encode("utf-8"))

    def _body(self) -> dict:
        n = int(self.headers.get("Content-Length") or 0)
        if not n:
            return {}
        try:
            return json.loads(self.rfile.read(n).decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            return {}

    # ---- routes ----
    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/api/stats":
            return self._json(stats())
        if path == "/api/results":
            return self._json({"rows": read_results()[::-1]})   # 新→旧
        if path == "/api/market/kline":
            from urllib.parse import parse_qs, urlparse
            q = parse_qs(urlparse(self.path).query)
            code = (q.get("code") or [""])[0].split(".")[0]
            freq = (q.get("freq") or ["D"])[0]
            adj = (q.get("adj") or ["qfq"])[0]
            code = bz_data.normalize_code(code) or ""
            if not code:
                return self._json({"error": "未知代码"}, 404)
            inst = bz_data.instruments()
            nrow = inst[inst["code"] == code]
            name = str(nrow.iloc[0]["name"]) if len(nrow) else code
            if freq in ("5min", "30min", "1min", "15min", "60min"):
                df = bz_data.mins_bars(code, freq)
                if freq not in bz_data.mins_freqs(code) or not len(df):
                    return self._json({"error": f"{code} 无 {freq} 分钟数据"}, 404)
                df = df.tail(4000)                       # 分钟限最近 4000 根（全史太重）
                fac = df["adj_factor"].to_numpy()
                base = fac[-1]
                if adj == "qfq" and base and base == base:
                    for c in ("open", "high", "low", "close"):
                        df[c] = df[c] * fac / base       # 与训练同一前复权口径：锚定末根
                bars = [
                    [str(t.trade_time), float(t.open), float(t.high), float(t.low),
                     float(t.close), float(t.volume)]
                    for t in df.itertuples()]
                asof = str(df["trade_time"].iloc[-1])
            else:
                df = bz_data.daily(bz_data.kind_of(code), code)
                if not len(df):
                    return self._json({"error": f"{code} 无日线数据"}, 404)
                fac = df["adj_factor"].to_numpy()
                base = fac[-1]
                if adj == "qfq" and base and base == base:
                    for c in ("open", "high", "low", "close"):
                        df[c] = df[c] * fac / base
                bars = [
                    [str(t.date.date()), float(t.open), float(t.high), float(t.low),
                     float(t.close), float(t.volume)]
                    for t in df.itertuples()]
                asof = str(df["date"].iloc[-1].date())
            return self._json({"code": code, "name": name, "freq": freq,
                               "adj": adj, "asof": asof, "bars": bars})
        if path == "/api/replay":
            from urllib.parse import parse_qs, urlparse
            q = parse_qs(urlparse(self.path).query)
            fn = (q.get("file") or [""])[0]
            if not re.fullmatch(r"[A-Za-z0-9_.-]+\.json", fn):
                return self._json({"error": "bad file name"}, 400)
            f = RESULTS.parent / "replays" / fn
            if not f.is_file():
                return self._json({"error": "复盘不存在"}, 404)
            try:
                return self._json(json.loads(f.read_text(encoding="utf-8")))
            except json.JSONDecodeError:
                return self._json({"error": "复盘文件损坏"}, 500)
        if path == "/api/search":
            from urllib.parse import parse_qs, urlparse
            q = (parse_qs(urlparse(self.path).query).get("q") or [""])[0]
            return self._json({"items": bz_data.search(q)})
        if path == "/api/index/list":
            return self._json({"instruments": bz_index.list_status()})
        if path == "/api/market/status":
            return self._json(market_update_status())
        if path == "/api/mins/coverage":
            from urllib.parse import parse_qs, urlparse
            q = parse_qs(urlparse(self.path).query)
            code = (q.get("code") or [""])[0].split(".")[0]
            if not bz_data.mins_available():
                return self._json({"available": False, "hint":
                    "分钟数据未挂载：需自备数据目录并设 BZ_MINS_ROOT（见 README「分钟线」小节）"})
            if not bz_data.normalize_code(code):
                return self._json({"error": f"未知代码 {code}"}, 404)
            return self._json({"available": True, "code": code,
                               "freqs": bz_data.mins_coverage(code)})
        if path == "/api/mins/kline":
            from urllib.parse import parse_qs, urlparse
            q = parse_qs(urlparse(self.path).query)
            code = (q.get("code") or [""])[0].split(".")[0]
            freq = (q.get("freq") or ["5min"])[0]
            start = (q.get("start") or [""])[0]
            end = (q.get("end") or [""])[0]
            limit = max(1, min(60000, int((q.get("limit") or ["20000"])[0])))
            if not bz_data.mins_available():
                return self._json({"error": "分钟数据未挂载（见 README「分钟线」小节）"}, 404)
            if freq not in bz_data.mins_freqs(code):
                return self._json({"error": f"{code} 无 {freq} 数据"}, 404)
            df = bz_data.mins_bars(code, freq)
            if start:
                df = df[df["trade_time"] >= start]
            if end:
                df = df[df["trade_time"] <= end + " 23:59:59"]
            df = df.tail(limit)
            # bars: [ts, o, h, l, c, v, amount, adj_factor]（raw 不复权 + 因子列，
            # 前复权锚定由调用方按与日线相同的 等比缩放 处理）
            bars = [
                [str(r.trade_time), float(r.open), float(r.high), float(r.low),
                 float(r.close), float(r.volume), float(r.amount),
                 None if r.adj_factor != r.adj_factor else float(r.adj_factor)]
                for r in df.itertuples()]
            return self._json({"code": code, "freq": freq, "bars": bars})
        if path == "/api/index/kline":
            from urllib.parse import parse_qs, urlparse
            q = parse_qs(urlparse(self.path).query)
            key = (q.get("key") or [""])[0]
            try:
                return self._json(bz_index.kline_json(key, log=_idx_log))
            except LookupError as e:
                return self._json({"error": str(e)}, 404)
            except Exception as e:  # noqa: BLE001
                return self._json({"error": str(e)}, 502)
        # 静态文件（限制在 web/ 内，防路径穿越）
        rel = "index.html" if path in ("/", "") else path.lstrip("/")
        f = (WEB / rel).resolve()
        if not str(f).startswith(str(WEB.resolve())) or not f.is_file():
            return self._json({"error": "not found"}, 404)
        ctype = MIME.get(f.suffix, "application/octet-stream")
        self._send(200, ctype, f.read_bytes())

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        body = self._body()
        try:
            if path == "/api/new":
                return self._json(api_new(body))
            if path == "/api/reveal":
                return self._json(api_reveal(body))
            if path == "/api/finish":
                return self._json(api_finish(body))
            if path == "/api/index/refresh":
                key = (body or {}).get("key")
                out = bz_index.refresh(key, log=_idx_log) if key else bz_index.refresh_all(log=_idx_log)
                return self._json({"ok": True, "result": out})
            if path == "/api/market/update":
                return self._json(start_market_update())
            if path == "/api/results/delete":
                return self._json(api_results_delete(body))
            return self._json({"error": "not found"}, 404)
        except Exception as e:  # noqa: BLE001
            sys.stderr.write(f"API error {path}: {e}\n")
            return self._json({"error": str(e)}, 400)

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()


# -------------------------------------------------------------- selftest ----

def selftest(n_each: int = 12) -> int:
    """批量生成会话，断言核心不变量。返回失败数。"""
    import datetime as dt

    fails = 0

    def check(cond: bool, msg: str):
        nonlocal fails
        if not cond:
            fails += 1
            print(f"  [FAIL] {msg}")

    def leaks(obj, *needles: str) -> bool:
        """字符串值里包含任一 needle 即泄露；数值巧合不算
        （如成交量 1508056 天然含代码 "508056" 的数字子串）。"""
        if isinstance(obj, dict):
            return any(leaks(v, *needles) for v in obj.values())
        if isinstance(obj, list):
            return any(leaks(v, *needles) for v in obj)
        if isinstance(obj, str):
            return any(n in obj for n in needles)
        return False

    for cat in ("stock", "limit", "etf"):
        for k in range(n_each):
            params = ({"year_from": 2016, "year_to": 2025, "history": 100, "forward": 80}
                      if k % 2 else None)
            try:
                pub, sec = bz_session.new_session(cat, params or {})
            except Exception as e:  # noqa: BLE001
                check(False, f"{cat}#{k} 生成失败: {e}")
                continue
            tag = f"{cat}#{k} {sec['code']}"
            bars = pub["bars"]

            check(pub["total"] == len(bars), f"{tag}: total 与 bars 长度不符")
            check(all(b["l"] <= min(b["o"], b["c"]) and b["h"] >= max(b["o"], b["c"])
                      for b in bars), f"{tag}: OHLC 关系非法")
            check(all(b["v"] >= 0 for b in bars), f"{tag}: 负成交量")

            if cat in ("etf", "index"):
                # ETF 数据里涨跌停价可有可无（文件 schema 不一致）；
                # 指数必须无涨跌停价；有的话必须与高低价自洽
                if cat == "index":
                    check(all(b["up"] is None and b["down"] is None for b in bars),
                          f"{tag}: 指数不应带涨跌停价")
                else:
                    check(all(b["up"] is None or (b["up"] >= b["h"] - 0.02 and b["down"] <= b["l"] + 0.02)
                              for b in bars), f"{tag}: ETF 涨跌停价与高低价矛盾")
            else:
                check(all(b["up"] is not None and b["down"] is not None for b in bars),
                      f"{tag}: 个股缺涨跌停价")
                check(all(b["up"] >= b["h"] - 0.02 and b["down"] <= b["l"] + 0.02
                          for b in bars), f"{tag}: 涨跌停价与高低价矛盾")

            # 窗口无 >30 自然日断档
            ds = [dt.date.fromisoformat(x) for x in sec["dates"]]
            gaps = [(b - a).days for a, b in zip(ds, ds[1:])]
            check(max(gaps) <= 30, f"{tag}: 窗口内断档 {max(gaps)} 天")

            # qfq 锚定窗口末根：末根复权 close == 原始 close
            if cat in ("stock", "limit", "etf"):
                kind = "etfs" if cat == "etf" else "stocks"
                raw = bz_data.daily(kind, sec["code"])
                raw_last = float(raw[raw["date"] == sec["end_date"]].iloc[0]["close"])
                check(abs(bars[-1]["c"] - raw_last) < 0.011,
                      f"{tag}: 末根价 {bars[-1]['c']} != 原始 {raw_last}")

            # 涨停模式：最后一根可见历史 bar 是涨停日
            if cat == "limit":
                hb = bars[pub["history"] - 1]
                check(hb["up"] is not None and hb["c"] >= hb["up"] * 0.999,
                      f"{tag}: 涨停模式历史末根未涨停 c={hb['c']} up={hb['up']}")

            # 匿名性：payload 字符串值不含代码与真实日期（数值子串巧合不算）
            check(not leaks(pub, sec["code"], sec["start_date"]),
                  f"{tag}: payload 泄露身份")
        print(f"selftest {cat}: done ({n_each} sessions)")

    # ---- v1.1：指数 / 自选定窗 / 费率与成交模式 ----
    cases = [
        ("index 随机", "index", {}),
        ("index 指定+定窗", "index", {"index_key": "sh000300", "date_from": "2020-03-02", "date_to": "2020-12-31"}),
        ("custom 定窗", "custom", {"codes": ["600519.SH"], "date_from": "2024-01-02", "date_to": "2024-06-30"}),
        ("custom 随机窗", "custom", {"codes": ["510300.SH"]}),
        ("自定义费率", "stock", {"commission_rate": 0.0002, "commission_min": 0, "fill_mode": "next_open",
                                 "year_from": 2018, "year_to": 2020}),
        # ---- history=0（全部）：可见历史 = 训练起点前所有 bars ----
        ("全史 stock 随机", "stock", {"history": 0, "year_from": 2018, "year_to": 2021}),
        ("全史 custom 定窗", "custom", {"codes": ["600519.SH"], "history": 0,
                                  "date_from": "2020-01-02", "date_to": "2020-12-31"}),
        ("全史 index 随机", "index", {"history": 0, "year_from": 2015, "year_to": 2018}),
    ]
    for name, cat, params in cases:
        try:
            pub, sec = bz_session.new_session(cat, params)
        except Exception as e:  # noqa: BLE001
            check(False, f"{name}: 生成失败: {e}")
            continue
        tag = f"{name} {sec['code']}"
        bars = pub["bars"]
        cfg = pub["config"]

        check(pub["total"] == len(bars) and pub["history"] + pub["forward"] == pub["total"],
              f"{tag}: 窗口长度不符 hist={pub['history']} fwd={pub['forward']} total={pub['total']}")
        check(cfg["fill_mode"] == params.get("fill_mode", "close"), f"{tag}: fill_mode 未透传")
        check(abs(cfg["fees"]["commission_rate"] - params.get("commission_rate", 0.0001)) < 1e-12,
              f"{tag}: 佣金费率未透传")
        check(cfg["fees"]["commission_min"] == params.get("commission_min", 5.0),
              f"{tag}: 最低佣金未透传")

        if "date_from" in params:
            ds = sec["dates"]
            check(ds[pub["history"]] >= params["date_from"] and ds[pub["history"] - 1] < params["date_from"],
                  f"{tag}: 训练首根不在 date_from 起始位置（{ds[pub['history'] - 1]} | {ds[pub['history']]}）")
            if "date_to" in params:
                check(ds[-1] <= params["date_to"], f"{tag}: 窗口末根 {ds[-1]} 晚于 date_to")
        if params.get("history") == 0:
            # 全史：窗口第 0 根 = 该标的数据第 0 根（从上市/指数起点起）；
            # 训练期外（远古历史）允许长断档与缺涨跌停价
            import bz_data as _bd, bz_index as _bi
            if cat == "index":
                v0 = _bi.load(sec["code"])["date"].iloc[0]
            else:
                v0 = _bd.daily("etfs" if cfg["is_etf"] else "stocks", sec["code"])["date"].iloc[0]
            raw0 = v0.strftime("%Y-%m-%d") if hasattr(v0, "strftime") else str(v0)[:10]
            check(sec["dates"][0] == raw0,
                  f"{tag}: 全史应从数据首根起（{sec['dates'][0]} != {raw0}）")
            i0 = pub["history"]
            dtr = [dt.date.fromisoformat(x) for x in sec["dates"][i0:]]
            check(max((b - a).days for a, b in zip(dtr, dtr[1:])) <= 30,
                  f"{tag}: 训练期内断档 > 30 天")
            if cat in ("stock", "custom") and not cfg["is_etf"]:
                check(all(b["up"] is not None for b in bars[i0:]),
                      f"{tag}: 训练期缺涨跌停价")
        if name.startswith("index"):
            check(cfg["board"] == "index" and sec["board"] == "index", f"{tag}: board 应为 index")
            check(all(b["up"] is None for b in bars), f"{tag}: 指数带涨跌停价")
        if cat == "custom":
            valid = [bz_data.normalize_code(c) for c in params["codes"]]
            check(sec["code"] in valid, f"{tag}: 自选抽了窗口外的代码")
        # 匿名性（字符串值包含判断，数值子串巧合不算）
        check(not leaks(pub, sec["code"], sec["start_date"]), f"{tag}: payload 泄露身份")
        print(f"selftest {name}: done")

    print(f"selftest {'PASS' if fails == 0 else f'{fails} FAILURES'}")
    return fails


# ------------------------------------------------------------------ main ----

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8870)
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args()

    if args.selftest:
        sys.exit(1 if selftest() else 0)

    srv = QuietHTTPServer(("0.0.0.0", args.port), Handler)
    srv.daemon_threads = True
    start_index_refresher()
    print(f"K线道场 KLineDojo  http://127.0.0.1:{args.port}  (Ctrl+C 退出)")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")


if __name__ == "__main__":
    main()
