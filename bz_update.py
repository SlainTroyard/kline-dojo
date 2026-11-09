#!/usr/bin/env python3
"""行情更新器（baostock）——维护本项目自有数据副本 data/market/ 与指数缓存 data/index/。

数据来源：baostock（免费无 token，适合开源场景）。可从零建库（--bootstrap，
含已退市标的），也可在既有副本上做增量追加 + 新股/新 ETF 全量回补 + 历史回补。

schema（个股/ETF）：serving 10 列 + amount(成交额,元) + turnover_rate(换手率%)，
个股额外带 is_st（0/1）列：
  - 复权因子：baostock 除权事件表 backAdjustFactor（累计后复权因子，与 tushare
    adj_factor 同量纲，实测逐位一致）→ 日频前向填充；写入时在重叠日做锚定对齐，
    两源即使量纲漂移也不破坏比例（前复权只用比例）
  - 涨跌停价：按板块规则计算（1996-12-16 起才有涨跌停；主板10%/ST5%（2026-07-06 起
    ST 同 10%），创业板 2020-08-24 起 20%，科创板 20%，注册制新股前 5 日不设限，
    新股限价置 NaN——训练层自动剔除含 NaN 窗口）；四舍五入到分
  - 停牌日（tradestatus=0）丢弃，与 tushare 口径一致（缺口由窗口过滤处理）

指数：A股 11 个指数日线同步追加到 data/index/*.parquet（与腾讯缓存同文件、
append-only 合流：成交量按 股→手 除以 100，价格实测两源一致；海外指数仍走腾讯/Yahoo）。

用法（用本项目 venv）：
    .venv/bin/python bz_update.py --bootstrap              # 从零建库（含退市股，单进程过夜，可中断续传）
    .venv/bin/python bz_update.py --bootstrap --codes 600519,510300  # 只建指定标的（快试用）
    .venv/bin/python bz_update.py --update                 # 增量 + 新股 + 指数
    .venv/bin/python bz_update.py --update --codes 600519,300750
    .venv/bin/python bz_update.py --backfill 301999        # 单标的全量回补（可强行重拉）
    .venv/bin/python bz_update.py --extend-back            # 回补既有副本 2015 以前历史（单进程，较慢）
    .venv/bin/python bz_update.py --extend-back --codes 000001,600519
    .venv/bin/python bz_update.py --validate --sample 30   # 与既有数据抽样比对

抓取一律单进程串行 + 限速（baostock 会拉黑并发/高频 IP，绝不用多进程）。
"""
from __future__ import annotations

import argparse
import json
import os
import random
import sys
import time
from datetime import date, datetime, timedelta
from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent
MARKET = Path(os.environ.get("BZ_MARKET_ROOT") or ROOT / "data" / "market")
INDEX_DIR = ROOT / "data" / "index"
LOCK = ROOT / "data" / ".update.lock"

K_FIELDS = ("date,open,high,low,close,preclose,volume,amount,"
            "tradestatus,pctChg,isST,turn")
SERVING_COLS = ["date", "open", "high", "low", "close", "pre_close",
                "volume", "amount", "turnover_rate",
                "adj_factor", "up_limit", "down_limit"]

# A股指数（baostock 代码 → 看板缓存 key；海外指数腾讯/Yahoo 自更新，不在此列）
BAOSTOCK_INDEXES = {
    "sh.000001": "sh000001", "sz.399001": "sz399001", "sh.000300": "sh000300",
    "sh.000016": "sh000016", "sh.000905": "sh000905", "sh.000852": "sh000852",
    "sh.000903": "sh000903", "sz.399006": "sz399006", "sh.000688": "sh000688",
    "sh.000922": "sh000922", "sz.399303": "sz399303",
}

# 涨跌停规则切换日
LIMIT_START = date(1996, 12, 16)      # A股涨跌停制度起点（此前无价格限制）
CHINEXT_20PCT = date(2020, 8, 24)     # 创业板注册制改革（含 ST 一律 20%）
MAINBOARD_REG = date(2023, 2, 17)     # 主板全面注册制（新股前5日不设限）
MAIN_ST_10PCT = date(2026, 7, 6)      # 主板 ST 涨跌幅 5%→10%（据官方涨跌停价数据反推）
STAR_LAUNCH = date(2019, 7, 22)       # 科创板开市


def log(msg: str):
    print(f"[{datetime.now():%H:%M:%S}] {msg}", flush=True)


def bs_code(code: str) -> str:
    """裸 6 位 → baostock 代码。"""
    if code.startswith(("60", "68", "51", "56", "58")):
        return "sh." + code
    return "sz." + code


def board_of(code: str) -> str:
    if code.startswith(("688", "689")):
        return "star"
    if code.startswith("30"):
        return "chinext"
    return "main"


def limit_prices(code: str, d: date, pre_close: float, is_st: int,
                 seq: int) -> tuple[float, float]:
    """涨跌停价（元，四舍五入到分）。seq=该股第几根 bar（0 起，含历史）。
    无涨跌停约束的 bar 返回 (nan, nan)：1996-12-16 前无制度 / 主板旧规首日 /
    注册制新股前 5 日。规则若再变（本函数的知识有限），用 --validate 比对即可发现。"""
    if d < LIMIT_START:
        return float("nan"), float("nan")
    b = board_of(code)
    if b == "star":
        pct, no_limit_days = 0.20, 5
    elif b == "chinext":
        if d >= CHINEXT_20PCT:
            pct, no_limit_days = 0.20, 5
        else:
            pct, no_limit_days = (0.05, 1) if is_st else (0.10, 1)
    else:
        if d >= MAIN_ST_10PCT:
            pct = 0.10                       # 主板 ST 与普通股统一 10%
        else:
            pct = 0.05 if is_st else 0.10
        if d >= MAINBOARD_REG:
            no_limit_days = 5
        else:
            no_limit_days = 1
    if seq < no_limit_days or not (pre_close > 0):
        return float("nan"), float("nan")
    p = Decimal(str(pre_close))
    up = float((p * (1 + Decimal(str(pct)))).quantize(Decimal("0.01"), ROUND_HALF_UP))
    dn = float((p * (1 - Decimal(str(pct)))).quantize(Decimal("0.01"), ROUND_HALF_UP))
    return up, dn


class Updater:
    def __init__(self):
        import baostock as bs
        self.bs = bs

    # ---------------- baostock 取数 ----------------

    def _rows(self, rs) -> list[list]:
        out = []
        while rs.error_code == "0" and rs.next():
            out.append(rs.get_row_data())
        if rs.error_code != "0":
            raise RuntimeError(f"baostock 错误 {rs.error_code}: {rs.error_msg}")
        return out

    def _relogin(self):
        """网络错误后重连（baostock 长连接会被服务端掐断）。"""
        try:
            self.bs.logout()
        except Exception:  # noqa: BLE001
            pass
        time.sleep(1)
        self.bs.login()

    def _retry(self, fn, *a, attempts=3, **kw):
        """网络瞬时错误退避重试（2s/6s/12s），末次前重连。
        10001011（黑名单限流，请求过频被服务端临时封禁）退避 90s/180s；
        10001001（用户未登录，服务端掐断长连接）重连即可。"""
        for i in range(attempts):
            try:
                return fn(*a, **kw)
            except RuntimeError as e:
                msg = str(e)
                bl = "10001011" in msg
                retryable = bl or "网络" in msg or "10002" in msg or "10001001" in msg
                if not retryable or i == attempts - 1:
                    raise
                time.sleep((90 if i == 0 else 180) if bl else 2 + 4 * i)
                self._relogin()
        raise RuntimeError("unreachable")

    def fetch_k(self, code: str, start: str, end: str) -> pd.DataFrame:
        """不复权日线 → DataFrame（丢停牌/空行）。"""
        def _do():
            rs = self.bs.query_history_k_data_plus(
                bs_code(code), K_FIELDS, start_date=start, end_date=end,
                frequency="d", adjustflag="3")
            return self._rows(rs)
        rows = self._retry(_do)
        rec = []
        for r in rows:
            if r[8] != "1":            # 停牌
                continue
            try:
                rec.append({
                    "date": r[0],
                    "open": float(r[1]), "high": float(r[2]),
                    "low": float(r[3]), "close": float(r[4]),
                    "pre_close": float(r[5]),
                    "volume": float(r[6] or 0),
                    "amount": float(r[7] or 0),
                    "is_st": int(float(r[10])) if r[10] not in ("", None) else 0,
                    "turnover_rate": float(r[11]) if len(r) > 11 and r[11] not in ("", None) else float("nan"),
                })
            except (ValueError, IndexError):
                continue
        return pd.DataFrame(rec)

    def fetch_factor_events(self, code: str) -> list[tuple[date, float]]:
        """除权事件 [(operateDate, 累计复权因子)]，升序。
        注意用 backAdjustFactor（累计后复权因子，绝对值与 tushare adj_factor 同量纲）；
        adjustFactor 列是单次事件比例（如 1.3075），当作累计用会在多次分红时出错。"""
        def _do():
            rs = self.bs.query_adjust_factor(code=bs_code(code), start_date="1990-01-01",
                                             end_date=date.today().isoformat())
            return self._rows(rs), rs.fields
        rows, f = self._retry(_do)
        di = f.index("dividOperateDate")
        fi = f.index("backAdjustFactor")
        ev = []
        for r in rows:
            try:
                ev.append((date.fromisoformat(r[di]), float(r[fi])))
            except (ValueError, TypeError):
                continue
        ev.sort()
        return ev

    @staticmethod
    def factor_at(events, d: date) -> float:
        """d 日的累计复权因子（≤d 的最后一个事件，无则 1.0）。"""
        v = 1.0
        for ed, f in events:
            if ed <= d:
                v = f
            else:
                break
        return v

    # ---------------- 因子步长审计 ----------------

    def check_factors(self, codes: list[str] | None = None) -> int:
        """全库扫描：每个除权日检查 因子步长 == 昨收/除权基准。
        只审 1996-12-16 之后（更早的 preclose 语义不可靠——0.5% 涨跌停年代
        的基准重置会被误判为除权）。返回异常文件数。"""
        inst = pd.read_parquet(MARKET / "instruments.parquet").astype({"code": str})
        todo = codes or inst[inst["exchange"].isin(["SH", "SZ"])]["code"].tolist()
        cutoff = pd.Timestamp(LIMIT_START)
        bad_files = 0
        for code in todo:
            kind = "etfs" if str(inst[inst["code"] == code].iloc[0]["type"]) == "etf" else "stocks"
            d = self.load_local(kind, code)
            if not len(d):
                continue
            d = d[d["date"] >= cutoff].reset_index(drop=True)
            bad = []
            for i in range(1, len(d)):
                pc, prev_c = float(d["pre_close"].iloc[i]), float(d["close"].iloc[i - 1])
                f0, f1 = d["adj_factor"].iloc[i - 1], d["adj_factor"].iloc[i]
                if not (pc > 0 and prev_c > 0 and pd.notna(f0) and pd.notna(f1) and f0 > 0):
                    continue
                if abs(pc / prev_c - 1) > 0.0005:
                    exp_step = prev_c / pc
                    act_step = float(f1) / float(f0)
                    if abs(act_step / exp_step - 1) > 0.005:
                        bad.append((str(d['date'].iloc[i].date()), round(exp_step, 4), round(act_step, 4)))
            if bad:
                bad_files += 1
                log(f"  {code}: {len(bad)} 处步长异常 首处 {bad[0]}")
        log(f"check-factors: {bad_files} 个文件存在异常（{len(todo)} 扫描）")
        return bad_files

    # ---------------- 本地读写 ----------------

    @staticmethod
    def load_local(kind: str, code: str) -> pd.DataFrame:
        p = MARKET / "daily" / kind / f"{code}.parquet"
        if not p.exists():
            return pd.DataFrame(columns=SERVING_COLS)
        df = pd.read_parquet(p)
        if "date" in df.columns:
            df["date"] = pd.to_datetime(df["date"])
        return df

    @staticmethod
    def save_local(kind: str, code: str, df: pd.DataFrame):
        p = MARKET / "daily" / kind / f"{code}.parquet"
        p.parent.mkdir(parents=True, exist_ok=True)
        df.to_parquet(p, index=False)

    # ---------------- 核心：单标的增量 ----------------

    def latest_trade_day(self) -> date:
        """baostock 交易日历 → 最近一个已收盘的交易日（无新交易日时整轮零 API 调用）。"""
        d0 = date.today() - timedelta(days=20)

        def _do():
            rs = self.bs.query_trade_dates(start_date=d0.isoformat(),
                                           end_date=date.today().isoformat())
            return self._rows(rs)
        rows = self._retry(_do)
        days = [date.fromisoformat(r[0]) for r in rows if r[1] == "1"]
        return max(days) if days else date.today()

    def update_code(self, code: str, kind: str, today: date,
                    last_td: date | None = None,
                    full_from: str | None = None) -> str:
        """返回 'new N' / 'up-to-date' / 'skip'。
        baostock 每次调用 3-8s（纯网络往返），故：
          - 本地已到最近交易日 → 不发请求直接跳过
          - 复权因子懒加载：pre_close 与昨收一致（无除权）时因子沿用末值，不拉事件表
        full_from：本地无文件时的抓取起点（bootstrap 传 1990-01-01 从上市日抓全量；
        缺省用 instruments 的上市日，兜底 2015-01-01）。
        """
        local = self.load_local(kind, code)
        if len(local):
            last = local["date"].iloc[-1]
            if getattr(last, "tzinfo", None) is not None:
                last = last.tz_localize(None)
            last_d = last.date() if hasattr(last, "date") else last
            if last_td and last_d >= last_td:
                return "skip"
            start = (last_d + timedelta(days=1)).isoformat()
            seq0 = len(local)          # 新行从第 seq0 根起
            prev_close = float(local["close"].iloc[-1])
            prev_factor = float(local["adj_factor"].iloc[-1]) \
                if pd.notna(local["adj_factor"].iloc[-1]) else None
        else:
            start, seq0, prev_close, prev_factor = "2015-01-01", 0, None, None
            if full_from:
                start = full_from
            else:
                ld = self.list_date_of(code)
                if ld:
                    start = ld.isoformat()

        k = self.fetch_k(code, start, today.isoformat())
        if not len(k):
            return "up-to-date"

        # ---- 复权因子：除权检测 ----
        first_pre = float(k["pre_close"].iloc[0])
        if prev_close is None:
            # 全新抓取：序列内无 pre_close 跳变（从未分红/除权）→ 因子恒 1.0，
            # 免拉事件表（近半标的无分红历史，单进程限速下省一半 API 调用）
            clean = all(
                pc <= 0 or c <= 0 or abs(pc / c - 1) <= 0.0005
                for pc, c in zip(k["pre_close"].iloc[1:], k["close"].iloc[:-1]))
            exdiv = not clean
        else:
            # 增量：新首行 pre_close ≠ 本地昨收 → 有除权
            exdiv = prev_factor is None or abs(first_pre / prev_close - 1) > 0.0005
        if exdiv:
            events = self.fetch_factor_events(code)
            ref_rows = local[local["adj_factor"].notna()] if len(local) else local
            if len(ref_rows):
                ref_d = ref_rows.iloc[-1]["date"]
                ref_d = ref_d.date() if hasattr(ref_d, "date") else ref_d
                scale = float(ref_rows.iloc[-1]["adj_factor"]) / self.factor_at(events, ref_d)
            else:
                scale = 1.0
            factor_of = lambda d: self.factor_at(events, d) * scale  # noqa: E731
        else:
            factor_of = lambda d: prev_factor if prev_factor is not None else 1.0  # noqa: E731

        dates = [date.fromisoformat(x) for x in k["date"]]
        rows = []
        for i, d in enumerate(dates):
            if kind == "stocks":
                up, dn = limit_prices(code, d, float(k["pre_close"].iloc[i]),
                                      int(k["is_st"].iloc[i]), seq0 + i)
            else:
                up = dn = float("nan")
            rows.append({
                "date": pd.Timestamp(d), "open": k["open"].iloc[i],
                "high": k["high"].iloc[i], "low": k["low"].iloc[i],
                "close": k["close"].iloc[i], "pre_close": k["pre_close"].iloc[i],
                "volume": k["volume"].iloc[i], "amount": k["amount"].iloc[i],
                "turnover_rate": k["turnover_rate"].iloc[i],
                "adj_factor": factor_of(d),
                "up_limit": up, "down_limit": dn,
                **({"is_st": int(k["is_st"].iloc[i])} if kind == "stocks" else {}),
            })
        new = pd.DataFrame(rows)
        if len(local):
            for c in new.columns:
                if c not in local.columns:
                    local[c] = float("nan") if c != "is_st" else 0
            merged = pd.concat([local, new], ignore_index=True)
            merged = merged.drop_duplicates(subset="date", keep="last")
            merged = merged.sort_values("date").reset_index(drop=True)
        else:
            merged = new
        self.save_local(kind, code, merged)
        return f"new {len(new)}"

    # ---------------- 2015 以前历史回补 ----------------

    def extend_back_code(self, code: str, kind: str) -> str:
        """把本地最早日期之前的历史（baostock 可回溯到 1990s）插到头部。
        复权因子锚定本地首行对齐（与增量同一套比例机制，方向相反）。"""
        local = self.load_local(kind, code)
        if not len(local):
            return "skip: 无本地数据（先 backfill）"
        first = local["date"].iloc[0]
        first_d = first.date() if hasattr(first, "date") else first
        ld = self.list_date_of(code)
        if ld and first_d <= ld + timedelta(days=14):
            return "skip: 已到上市初"       # 幂等：重跑不发请求
        k = self.fetch_k(code, "1990-01-01", (first_d - timedelta(days=1)).isoformat())
        if not len(k):
            return "up-to-date"
        events = self.fetch_factor_events(code)
        f_rows = local[local["adj_factor"].notna()]
        if len(f_rows):
            ref = f_rows.iloc[0]["date"]
            ref_d = ref.date() if hasattr(ref, "date") else ref
            scale = float(f_rows.iloc[0]["adj_factor"]) / self.factor_at(events, ref_d)
        else:
            scale = 1.0
        rows = []
        for i, dstr in enumerate(k["date"]):
            d = date.fromisoformat(dstr)
            if kind == "stocks":
                up, dn = limit_prices(code, d, float(k["pre_close"].iloc[i]),
                                      int(k["is_st"].iloc[i]), i)   # 回补段从 0 计 seq
            else:
                up = dn = float("nan")
            rows.append({
                "date": pd.Timestamp(d), "open": k["open"].iloc[i],
                "high": k["high"].iloc[i], "low": k["low"].iloc[i],
                "close": k["close"].iloc[i], "pre_close": k["pre_close"].iloc[i],
                "volume": k["volume"].iloc[i], "amount": k["amount"].iloc[i],
                "turnover_rate": k["turnover_rate"].iloc[i],
                "adj_factor": self.factor_at(events, d) * scale,
                "up_limit": up, "down_limit": dn,
                **({"is_st": int(k["is_st"].iloc[i])} if kind == "stocks" else {}),
            })
        old_rows = pd.DataFrame(rows)
        for c in old_rows.columns:
            if c not in local.columns:
                local[c] = float("nan") if c != "is_st" else 0
        merged = pd.concat([old_rows, local], ignore_index=True)
        merged = merged.drop_duplicates(subset="date", keep="last").sort_values("date")
        merged = merged.reset_index(drop=True)
        self.save_local(kind, code, merged)
        return f"prepend {len(old_rows)}（→ {merged['date'].iloc[0].date()}）"

    # ---------------- 指数合流（data/index，与腾讯缓存同文件） ----------------

    def update_index(self, bsk: str, tk: str, today: date) -> str:
        """baostock A股指数日线 → 追加到腾讯缓存 parquet（append-only）。
        量纲：baostock 股 = 腾讯 手 × 100，写入前除以 100（价格两源实测一致）。
        查询带重试：服务端会掐长连接（10001001 未登录），重连再取。"""
        def _do():
            rs = self.bs.query_history_k_data_plus(
                bsk, "date,open,high,low,close,volume", start_date="1990-01-01",
                end_date=today.isoformat(), frequency="d", adjustflag="3")
            return self._rows(rs)
        rows = self._retry(_do)
        rec = []
        for r in rows:
            try:
                if not r[0] or "" in (r[1], r[2], r[3], r[4]):
                    continue
                rec.append({
                    "date": r[0], "open": float(r[1]), "close": float(r[4]),
                    "high": float(r[2]), "low": float(r[3]),
                    "volume": (float(r[5]) if r[5] else 0.0) / 100.0,   # 股→手（腾讯口径）
                })
            except (ValueError, IndexError) as e:
                log(f"  {tk} 跳过异常行 {r[:3]}…: {e}")
                continue
        if not rec:
            return "无数据（该源无此指数，仍走腾讯）"
        b = pd.DataFrame(rec)
        p = INDEX_DIR / f"{tk}.parquet"
        if p.exists():
            t = pd.read_parquet(p)
            last = t["date"].iloc[-1]
            b = b[b["date"] > last]
            if not len(b):
                return "up-to-date"
            merged = pd.concat([t, b], ignore_index=True)
            merged = merged.drop_duplicates(subset="date", keep="first").sort_values("date")
        else:
            merged = b
        INDEX_DIR.mkdir(parents=True, exist_ok=True)
        merged.to_parquet(p, index=False)
        return f"new {len(b)}（总 {len(merged)}）"

    def list_date_of(self, code: str) -> date | None:
        try:
            inst = pd.read_parquet(MARKET / "instruments.parquet").astype({"code": str})
            r = inst[inst["code"] == code]
            if len(r) and pd.notna(r.iloc[0]["list_date"]):
                v = r.iloc[0]["list_date"]
                return v.date() if hasattr(v, "date") else date.fromisoformat(str(v)[:10])
        except Exception:  # noqa: BLE001
            pass
        return None

    # ---------------- 新股发现 ----------------

    def discover_new(self) -> list[tuple[str, str, str, date, str]]:
        """query_all_stock 找本地 instruments 里没有的沪深个股/ETF。
        返回 [(code, name, type, list_date, kind)]。"""
        d = date.today()
        codes_today = None
        for _ in range(7):                      # 回退找最近一个有数据的交易日
            try:
                rows = self._retry(
                    lambda dd=d: self._rows(self.bs.query_all_stock(day=dd.isoformat())))
            except RuntimeError:
                rows = []
            if rows:
                codes_today = rows
                break
            d = d - timedelta(days=1)
        if not codes_today:
            return []
        inst = pd.read_parquet(MARKET / "instruments.parquet").astype({"code": str})
        known = set(inst["code"])
        out = []
        for r in codes_today:
            bs_c = r[0]
            if not ("." in bs_c):
                continue
            mkt, bare = bs_c.split(".")
            if mkt == "sh" and not bare.startswith(("60", "68", "51", "56", "58")):
                continue
            if mkt == "sz" and not bare.startswith(("00", "30", "15", "16", "18")):
                continue
            if bare in known:
                continue
            try:
                info = self._retry(
                    lambda c=bs_c: self._rows(self.bs.query_stock_basic(code=c)))
            except RuntimeError:
                continue
            if not info:
                continue
            # fields: code, codeName, ipoDate, outDate, type, status
            _, name, ipo, out, typ, status = info[0]
            if out or status != "1":
                continue
            kind = "etfs" if typ == "5" else "stocks"
            if typ not in ("1", "5"):
                continue
            try:
                ld = date.fromisoformat(ipo) if ipo else None
            except ValueError:
                ld = None
            out.append((bare, name, typ, ld, kind))
            known.add(bare)
        return out

    def register_new(self, code: str, name: str, typ: str, ld: date | None, kind: str):
        """登记到 instruments/names，再回补全量。"""
        inst = pd.read_parquet(MARKET / "instruments.parquet").astype({"code": str})
        names = pd.read_parquet(MARKET / "names.parquet").astype({"code": str})
        exch = "SH" if bs_code(code).startswith("sh.") else "SZ"
        row = {"code": code, "name": name, "exchange": exch,
               "list_date": pd.Timestamp(ld) if ld else pd.NaT,
               "delist_date": pd.NaT, "status": "L",
               "type": "etf" if kind == "etfs" else "stock"}
        if not len(inst[inst["code"] == code]):
            inst = pd.concat([inst, pd.DataFrame([row])], ignore_index=True)
            inst.to_parquet(MARKET / "instruments.parquet", index=False)
        if not len(names[names["code"] == code]):
            nrow = {"code": code, "name": name,
                    "start": pd.Timestamp(ld) if ld else pd.Timestamp("2015-01-01"),
                    "end": pd.NaT, "reason": "baostock 新增"}
            for c in ("start", "end"):
                if c not in names.columns:
                    names[c] = pd.NaT
            names = pd.concat([names, pd.DataFrame([nrow])], ignore_index=True)
            names.to_parquet(MARKET / "names.parquet", index=False)

    # ---------------- 从零建库（bootstrap） ----------------

    @staticmethod
    def _classify(mkt: str, bare: str) -> str | None:
        """baostock 代码前缀 → 'stocks'/'etfs'；其余（指数/债券等）丢弃。
        与 discover_new 同一套前缀规则；sh.58 只认 588（580 是已消亡的权证段）。"""
        if mkt == "sh":
            if bare.startswith(("60", "68")):
                return "stocks"
            if bare.startswith(("51", "56", "588")):
                return "etfs"
        elif mkt == "sz":
            if bare.startswith(("00", "30")):
                return "stocks"
            if bare.startswith(("15", "16", "18")):
                return "etfs"
        return None

    def bootstrap_scan(self, only: set[str] | None = None) -> list[tuple[str, str]]:
        """逐年（最后一个交易日）query_all_stock 快照并集发现全部标的——含已退市股，
        训练池无幸存者偏差（baostock 快照按日期过滤准确：实测 2000-12-29 无 2001 年
        上市的茅台、有 2005/2010 年退市的 600001/600002）。
        登记到 instruments/names（不动已有行，已有更丰富的名称时间线时保值），
        返回 [(code, kind)] 待抓清单。
        快照连发易触发 baostock 黑名单限流（10001011）：调用间隔 4s，进度落
        .bootstrap_scan.json，被封中断后重跑自动续扫。"""
        def _cal():
            rs = self.bs.query_trade_dates(start_date="1993-01-01",
                                           end_date=date.today().isoformat())
            return self._rows(rs)
        tds = [date.fromisoformat(r[0]) for r in self._retry(_cal) if r[1] == "1"]
        by_year: dict[int, date] = {}
        for d in tds:
            if d.year not in by_year or d > by_year[d.year]:
                by_year[d.year] = d
        snaps = [by_year[y] for y in sorted(by_year)]

        MARKET.mkdir(parents=True, exist_ok=True)   # sidecar/清单落盘依赖
        sidecar = MARKET / ".bootstrap_scan.json"
        latest_day = snaps[-1].isoformat()
        done: set[str] = set()
        found: dict[str, dict] = {}
        latest_codes: set[str] = set()              # 在市判定的唯一依据
        if only is None and sidecar.exists():       # 断点续扫
            try:
                st = json.loads(sidecar.read_text())
                done = set(st.get("done", []))
                for c, v in st.get("found", {}).items():
                    found[c] = v
                latest_codes = set(st.get("latest_codes", []))
                if latest_day in done and not latest_codes:
                    done.discard(latest_day)        # 旧版 sidecar 缺在市集合：重扫最新快照
                log(f"续扫: 已完成 {len(done)} 个快照、{len(found)} 个标的")
            except (ValueError, OSError):
                pass

        def _save_progress():
            sidecar.write_text(json.dumps(
                {"done": sorted(done),
                 "found": {c: v for c, v in found.items()},
                 "latest_codes": sorted(latest_codes)}))

        failed_snap = False
        for d in reversed(snaps):                   # 新→旧：名称取最新一次出现
            key = d.isoformat()
            if key in done:
                continue
            if done or found:                       # 限速：query_all_stock 全表很重
                time.sleep(8)                      # （8s：快照连发是实测封禁的主要嫌疑）
            try:
                rows = self._retry(
                    lambda dd=d: self._rows(self.bs.query_all_stock(day=dd.isoformat())))
            except RuntimeError as e:
                if key == latest_day:
                    # 最新快照是在市状态的唯一依据，缺失会把全部标的误标为退市
                    _save_progress()
                    raise RuntimeError(f"最新快照 {d} 拉取失败: {e}")
                failed_snap = True
                log(f"  快照 {d} 拉取失败，跳过（重跑 --bootstrap 自动续扫补齐）: {e}")
                continue
            for r in rows:
                bs_c = r[0]
                if "." not in bs_c:
                    continue
                mkt, bare = bs_c.split(".")
                if key == latest_day:
                    latest_codes.add(bare)
                kind = self._classify(mkt, bare)
                if not kind or bare in found:
                    continue
                # query_all_stock 返回 [code, tradeStatus, code_name]
                name = (r[2] if len(r) > 2 and r[2] else bare)
                found[bare] = {"name": name, "kind": kind, "exch": mkt.upper()}
            done.add(key)
            if only is None:
                _save_progress()
        if failed_snap:
            log("部分快照失败：本次入库不完整，稍后重跑 --bootstrap 续扫补齐")
        elif only is None:
            sidecar.unlink(missing_ok=True)
        for c, v in found.items():                  # 在市状态以最新快照成员为准（续扫安全）
            v["live"] = c in latest_codes
        if only is not None:
            miss = sorted(c for c in only if c not in found)
            if miss:
                log(f"  快照未发现（代码有误或从未在快照出现）: {miss}")
            found = {c: v for c, v in found.items() if c in only}

        MARKET.mkdir(parents=True, exist_ok=True)
        ip, npath = MARKET / "instruments.parquet", MARKET / "names.parquet"
        inst = pd.read_parquet(ip).astype({"code": str}) if ip.exists() else None
        names = pd.read_parquet(npath).astype({"code": str}) if npath.exists() else None
        known = set(inst["code"]) if inst is not None else set()
        add_i = [{"code": c, "name": v["name"], "exchange": v["exch"],
                  "list_date": pd.NaT, "delist_date": pd.NaT,
                  "status": "L" if v["live"] else "D",
                  "type": "etf" if v["kind"] == "etfs" else "stock"}
                 for c, v in sorted(found.items()) if c not in known]
        add_n = [{"code": c, "name": v["name"], "start": pd.NaT,
                  "end": pd.NaT, "reason": "baostock bootstrap"}
                 for c, v in sorted(found.items()) if c not in known]
        if add_i:
            inst = pd.DataFrame(add_i) if inst is None else \
                pd.concat([inst, pd.DataFrame(add_i)], ignore_index=True)
            inst.to_parquet(ip, index=False)
        if add_n:
            names = pd.DataFrame(add_n) if names is None else \
                pd.concat([names, pd.DataFrame(add_n)], ignore_index=True)
            names.to_parquet(npath, index=False)
        n_live = sum(1 for v in found.values() if v["live"])
        log(f"bootstrap 扫描: {len(found)} 个标的（在市 {n_live}，含退市 "
            f"{len(found) - n_live}），快照 {len(snaps)} 个年份，新登记 {len(add_i)}")
        return [(c, v["kind"]) for c, v in sorted(found.items())]

    def backfill_list_dates(self) -> list[str]:
        """bootstrap 抓取后：用各标的本地首根 bar 回填 instruments.list_date 与
        names.start（免掉每标的一次 query_stock_basic）；完全无数据的登记行剔除
        （快照噪音，如 baostock 里 2015 年仍挂着的 000003）。返回被剔除的代码。"""
        ip, npath = MARKET / "instruments.parquet", MARKET / "names.parquet"
        if not ip.exists():
            return []
        inst = pd.read_parquet(ip).astype({"code": str})
        if not len(inst):
            return []
        dropped_idx = []
        for i, row in inst.iterrows():
            if pd.notna(row["list_date"]):
                continue
            kind = "etfs" if str(row["type"]) == "etf" else "stocks"
            p = MARKET / "daily" / kind / f"{row['code']}.parquet"
            if not p.exists():
                dropped_idx.append(i)
                continue
            inst.at[i, "list_date"] = pd.Timestamp(
                pd.read_parquet(p, columns=["date"])["date"].iloc[0])
        dead: list[str] = []
        if dropped_idx:
            dead = sorted(str(inst.at[i, "code"]) for i in dropped_idx)
            inst = inst.drop(index=dropped_idx).reset_index(drop=True)
            log(f"  剔除无数据标的 {len(dead)} 个: {dead[:10]}{'…' if len(dead) > 10 else ''}")
        inst.to_parquet(ip, index=False)
        if npath.exists():
            names = pd.read_parquet(npath).astype({"code": str})
            if dead:
                names = names[~names["code"].isin(dead)].reset_index(drop=True)
            lookup = inst.set_index("code")["list_date"].to_dict()
            need = names["start"].isna() & names["code"].isin(lookup)
            if need.any():
                names.loc[need, "start"] = names.loc[need, "code"].map(lookup)
            names.to_parquet(npath, index=False)
        return dead

    # ---------------- 比对验证 ----------------

    def validate(self, sample: int) -> int:
        """抽样对比 baostock 新取数与既有 tushare 数据（重叠窗口 120 日）。"""
        inst = pd.read_parquet(MARKET / "instruments.parquet").astype({"code": str})
        pool = inst[(inst["type"] == "stock") & inst["exchange"].isin(["SH", "SZ"])]["code"].tolist()
        rng = random.Random(42)
        picks = rng.sample(pool, min(sample, len(pool)))
        today = date.today()
        bad = 0
        for code in picks:
            local = self.load_local("stocks", code)
            if len(local) < 150:
                continue
            last = local["date"].iloc[-1]
            last_d = last.date() if hasattr(last, "date") else last
            start = (last_d - timedelta(days=200)).isoformat()
            k = self.fetch_k(code, start, last_d.isoformat())
            if not len(k):
                log(f"  {code}: baostock 无重叠数据!")
                bad += 1
                continue
            k["date"] = pd.to_datetime(k["date"])
            m = local.merge(k, on="date", suffixes=("_t", "_b"))
            m = m.tail(120)
            if not len(m):
                continue
            dclose = (m["close_t"] - m["close_b"]).abs().max()
            dvol = (m["volume_t"] - m["volume_b"]).abs().max() / max(1.0, m["volume_t"].median())
            # 复权因子比例一致性（窗口首日为基准；两源绝对量纲可不同，比比例）
            f_t = m["adj_factor"].astype(float)
            if len(m) > 5 and f_t.notna().all():
                ev = self.fetch_factor_events(code)
                f_bs = pd.Series([self.factor_at(ev, d.date()) for d in m["date"]])
                r_t = (f_t / f_t.iloc[0]).values
                r_b = (f_bs / f_bs.iloc[0]).values
                dfac = abs(r_t - r_b).max()
            else:
                dfac = -1.0
            # 涨跌停（只对既有非 NaN 的行比对）
            chk = m[m["up_limit"].notna()]
            if len(chk) > 20:
                up_ok = dn_ok = tot = 0
                for _, r in chk.iterrows():
                    d = r["date"].date() if hasattr(r["date"], "date") else r["date"]
                    seq = int(local.index[local["date"] == r["date"]][0])
                    u, dn2 = limit_prices(code, d, float(r["pre_close_b"]),
                                          int(r["is_st"]) if "is_st" in r else 0, seq)
                    tot += 1
                    up_ok += int(abs(u - float(r["up_limit"])) < 0.011)
                    dn_ok += int(abs(dn2 - float(r["down_limit"])) < 0.011)
                lim = (up_ok + dn_ok) / (2 * tot)
            else:
                lim = -1.0
            flag = ""
            if dclose > 0.011 or dvol > 0.02 or (dfac > 0.002) or (lim >= 0 and lim < 0.98):
                flag = "  <-- 不一致!"
                bad += 1
            log(f"  {code}: close差={dclose:.3f} 量差={dvol:.4f} 因子比差={dfac:.5f} "
                f"涨跌停符合率={lim if lim < 0 else f'{lim*100:.1f}%'}{flag}")
        log(f"validate: {bad} 只不一致 / {len(picks)} 抽样")
        return bad


# ------------------------------------------------------------------ main ----

def acquire_lock() -> bool:
    if LOCK.exists():
        try:
            pid = int(LOCK.read_text().strip() or 0)
            alive = pid != 0 and Path(f"/proc/{pid}").exists()
            if alive:
                return False
            log(f"清除残留锁（pid {pid} 不存在）")
        except (OSError, ValueError):
            pass
    LOCK.parent.mkdir(parents=True, exist_ok=True)
    LOCK.write_text(str(__import__("os").getpid()))
    return True


def release_lock():
    LOCK.unlink(missing_ok=True)


# ---- 串行抓取轮次 ----

def _serial_rounds(todo: list[tuple[str, str]], mode: str,
                   up, today, label: str,
                   last_td=None) -> list[tuple[str, str]]:
    """单进程串行抓取 + 失败分 3 轮重跑。返回最终失败清单。

    baostock 对并发登录/高频请求敏感（会拉黑 IP），绝不用多进程：
    整轮一次登录、连接被掐由 _retry 自动重连；发过请求的标的之间
    小睡 0.5s 限速（本地 skip 的不发请求、不睡）。
    """
    todo = list(todo)
    for rnd in range(3):
        if not todo:
            break
        log(f"{label}第 {rnd + 1} 轮: {len(todo)} 个标的（单进程）")
        failed: list[tuple[str, str]] = []
        throttled = False
        n_new = n_same = n_skip = 0
        t0 = time.time()
        for i, (code, kind) in enumerate(todo):
            try:
                if mode == "extend_back":
                    s = up.extend_back_code(code, kind)
                elif mode == "bootstrap":
                    s = up.update_code(code, kind, today, None, full_from="1990-01-01")
                else:
                    s = up.update_code(code, kind, today, last_td)
            except Exception as e:  # noqa: BLE001
                s = f"ERROR {type(e).__name__}: {e}"
            if s.startswith("ERROR"):
                failed.append((code, kind))
                throttled = throttled or "10001011" in s
                log(f"  {code}: {s}")
            elif s.startswith(("new", "prepend")):
                n_new += 1
                log(f"  {code}: {s}")
            elif s.startswith("skip"):
                n_skip += 1
            else:                                   # up-to-date 等未变更状态
                n_same += 1
            if not s.startswith(("skip", "ERROR")):
                time.sleep(0.5)                     # 发过请求才限速
            if (i + 1) % 200 == 0:
                log(f"  进度 {i + 1}/{len(todo)}  新{n_new} 无变化{n_same} "
                    f"跳过{n_skip} 失败{len(failed)} ({time.time() - t0:.0f}s)")
        log(f"{label}第 {rnd + 1} 轮完成: 新{n_new} 无变化{n_same} 跳过{n_skip} "
            f"失败{len(failed)}，用时 {time.time() - t0:.0f}s")
        todo = failed
        if failed:
            wait = 180 if throttled else 30         # 黑名单限流：等更久再试
            log(f"休眠 {wait}s 后重试失败标的"
                f"{'（疑似 baostock 限流）' if throttled else ''}")
            time.sleep(wait)
    return todo


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bootstrap", action="store_true",
                    help="从零建库：快照发现全部标的（含退市股）→ 全量抓取（约 2-4 小时，"
                         "可中断重跑续传；--codes 可只建指定标的）")
    ap.add_argument("--update", action="store_true", help="增量更新（含新股/指数）")
    ap.add_argument("--codes", default="", help="仅更新这些代码（逗号分隔）")
    ap.add_argument("--backfill", default="", help="单标的全量回补（可强行重拉）")
    ap.add_argument("--extend-back", action="store_true",
                    help="回补既有副本 2015 以前历史（baostock 可回溯至 1990s，约 2 小时）")
    ap.add_argument("--check-factors", action="store_true",
                    help="审计全库因子步长（除权日 因子步长==昨收/除权基准）")
    ap.add_argument("--validate", action="store_true", help="抽样与既有数据比对")
    ap.add_argument("--sample", type=int, default=30)
    args = ap.parse_args()

    if not MARKET.exists() and not args.bootstrap:
        sys.exit("未找到 data/market —— 全新部署请先跑 "
                 "`.venv/bin/python bz_update.py --bootstrap`（详见 README）")
    if not acquire_lock():
        sys.exit("已有更新任务在运行（data/.update.lock）")

    import baostock as bs
    lg = bs.login()
    if lg.error_code != "0":
        release_lock()
        hint = "（baostock 黑名单限流：请求过频被临时封禁，通常几分钟到数小时自动解除，稍后重跑即可续传）" \
            if lg.error_code == "10001011" else ""
        sys.exit(f"baostock 登录失败: {lg.error_msg}{hint}")

    up = Updater()
    today = date.today()
    try:
        # ---- 从零建库 ----
        if args.bootstrap:
            want = None
            if args.codes:
                want = {c.strip().split(".")[0] for c in args.codes.split(",") if c.strip()}
            todo = up.bootstrap_scan(want)
            if not todo:
                sys.exit("bootstrap: 未发现任何标的")
            log(f"bootstrap 全量抓取 {len(todo)} 个标的（单进程限速，"
                f"baostock 每次调用 3-8s，中断可重跑续传）")
            time.sleep(60)          # 扫描（重量级快照）与抓取之间留缓冲
            failed = _serial_rounds(todo, "bootstrap", up, today, "bootstrap")
            up.backfill_list_dates()
            for bsk, tk in BAOSTOCK_INDEXES.items():
                try:
                    log(f"  指数 {tk}: {up.update_index(bsk, tk, today)}")
                except Exception as e:  # noqa: BLE001
                    log(f"  指数 {tk}: ERROR {e}")
            log(f"bootstrap 完成（最终失败 {len(failed)}，重跑 --bootstrap 可补抓）")
            return

        if args.validate:
            sys.exit(1 if up.validate(args.sample) else 0)

        if args.check_factors:
            want = None
            if args.codes:
                want = [c.strip().split(".")[0] for c in args.codes.split(",") if c.strip()]
            sys.exit(0 if up.check_factors(want) == 0 else 1)

        # ---- 2015 以前历史回补（单进程串行 + 失败分轮重跑）----
        if args.extend_back:
            inst = pd.read_parquet(MARKET / "instruments.parquet").astype({"code": str})
            live = inst[(inst["status"].isin(["L"])) | inst["delist_date"].notna()]
            live = live[live["exchange"].isin(["SH", "SZ"])]
            if args.codes:
                want = {c.strip().split(".")[0] for c in args.codes.split(",") if c.strip()}
                todo = [(r["code"], "etfs" if r["type"] == "etf" else "stocks")
                        for _, r in live.iterrows() if r["code"] in want]
            else:
                todo = [(r["code"], "etfs" if r["type"] == "etf" else "stocks")
                        for _, r in live.iterrows()]
            todo = _serial_rounds(todo, "extend_back", up, today, "历史回补")
            log(f"历史回补完成（最终失败 {len(todo)}）")
            if args.codes:
                return

        if args.backfill:
            code = args.backfill.split(".")[0]
            kind = "etfs" if code.startswith(("15", "16", "18", "51", "56", "58")) else "stocks"
            # 清空本地强制重拉：先把文件改名备份，失败可还原
            p = MARKET / "daily" / kind / f"{code}.parquet"
            bak = p.with_suffix(".parquet.bak")
            if p.exists():
                bak.write_bytes(p.read_bytes())
                p.unlink()
            log(f"backfill {code} ...")
            r = up.update_code(code, kind, today)
            log(f"backfill {code}: {r}")
            bak.unlink(missing_ok=True)
            return

        # ---- 最近已收盘交易日（整轮跳过判断的基准）----
        last_td = up.latest_trade_day()
        log(f"最近已收盘交易日: {last_td}（{today}）")

        # ---- 增量（单进程串行；无新交易日时全库本地跳过、零 API 调用）----
        inst = pd.read_parquet(MARKET / "instruments.parquet").astype({"code": str})
        live = inst[(inst["status"] == "L") & inst["exchange"].isin(["SH", "SZ"])]
        if args.codes:
            want = {c.strip().split(".")[0] for c in args.codes.split(",") if c.strip()}
            todo = [(r["code"], "etfs" if r["type"] == "etf" else "stocks")
                    for _, r in live.iterrows() if r["code"] in want]
        else:
            todo = [(r["code"], "etfs" if r["type"] == "etf" else "stocks")
                    for _, r in live.iterrows()]
        log(f"增量更新 {len(todo)} 个标的（单进程）")
        failed = _serial_rounds(todo, "update", up, today, "增量更新", last_td=last_td)
        if failed:
            log(f"增量最终失败 {len(failed)} 个，明晚会自动重试")

        # ---- A股指数（合流到 data/index，海外指数仍走腾讯/Yahoo）----
        for bsk, tk in BAOSTOCK_INDEXES.items():
            try:
                log(f"  指数 {tk}: {up.update_index(bsk, tk, today)}")
            except Exception as e:  # noqa: BLE001
                log(f"  指数 {tk}: ERROR {e}")

        # ---- 新股/新 ETF ----
        if not args.codes:
            try:
                news = up.discover_new()
            except Exception as e:  # noqa: BLE001
                news = []
                log(f"新股发现失败（不影响增量主流程）: {e}")
            log(f"发现新标的 {len(news)} 个")
            for code, name, typ, ld, kind in news:
                try:
                    up.register_new(code, name, typ, ld, kind)
                    r = up.update_code(code, kind, today)
                    log(f"  新增 {code} {name}: {r}")
                except Exception as e:  # noqa: BLE001
                    log(f"  新增 {code} 失败: {e}")
    finally:
        try:
            bs.logout()
        except Exception:  # noqa: BLE001
            pass
        release_lock()


if __name__ == "__main__":
    main()
