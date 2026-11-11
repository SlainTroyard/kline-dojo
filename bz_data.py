"""行情 parquet 只读层（K线道场）。

数据根自动探测（优先级）：
  1. 环境变量 BZ_MARKET_ROOT
  2. 本项目 data/market/（bz_update.py 用 baostock 从零建立并维护的自有副本：
     `bz_update.py --bootstrap` 建库，`--update` 日常增量）

目录布局（serving 层）：
  daily/stocks/{code}.parquet   个股日线（含 adj_factor / 官方涨跌停价，或含 is_st）
  daily/etfs/{code}.parquet     ETF 日线（涨跌停价为 NaN）
  instruments.parquet           代码清单（exchange / list_date / type）
  names.parquet                 名称变更时间线（时点 ST 判定与揭晓用）
"""
from __future__ import annotations

import functools
import os
from pathlib import Path

import pandas as pd

_ROOT = Path(__file__).resolve().parent
_PQ_CANDIDATES = [
    os.environ.get("BZ_MARKET_ROOT"),
    _ROOT / "data" / "market",
]
PQ = Path(next(str(p) for p in _PQ_CANDIDATES if p and Path(p).exists()))

DAILY_COLS = [
    "date", "open", "high", "low", "close", "pre_close",
    "volume", "adj_factor", "up_limit", "down_limit",
]


def _read(path: Path, columns: list[str] | None = None) -> pd.DataFrame:
    df = pd.read_parquet(path, columns=columns)
    if "date" in df.columns:
        df["date"] = pd.to_datetime(df["date"])
    return df


@functools.lru_cache(maxsize=1)
def instruments() -> pd.DataFrame:
    return _read(PQ / "instruments.parquet").astype({"code": str})


@functools.lru_cache(maxsize=1)
def names() -> pd.DataFrame:
    return _read(PQ / "names.parquet").astype({"code": str})


@functools.lru_cache(maxsize=8192)
def daily(kind: str, code: str) -> pd.DataFrame:
    """kind: 'stocks' | 'etfs'。按日期升序，serving 所需列（baostock 增补的行可能带
    is_st，一并保留）；文件缺失返回空表。"""
    path = PQ / "daily" / kind / f"{code}.parquet"
    if not path.exists():
        return pd.DataFrame(columns=DAILY_COLS)
    df = _read(path)
    for c in DAILY_COLS:
        if c not in df.columns:
            df[c] = float("nan")
    cols = DAILY_COLS + (["is_st"] if "is_st" in df.columns else [])
    return df[cols].sort_values("date").reset_index(drop=True)


def is_st_at(code: str, t: pd.Timestamp) -> bool | None:
    """t 日该股是否 ST：优先读 baostock 增补的 is_st 列，无该列返回 None
    （调用方回退到名称判定）。"""
    df = daily("stocks", code)
    if "is_st" not in df.columns or not len(df):
        return None
    rows = df[df["date"] <= t]
    if not len(rows):
        return None
    v = rows.iloc[-1]["is_st"]
    return bool(v) if pd.notna(v) else None


@functools.lru_cache(maxsize=1)
def _codes(kind: str) -> tuple[str, ...]:
    """可训练代码池：沪深两市（剔除北交所）。kind: 'stocks' | 'etfs'。"""
    t = "stock" if kind == "stocks" else "etf"
    inst = instruments()
    m = (inst["type"] == t) & inst["exchange"].isin(["SH", "SZ"])
    return tuple(sorted(inst.loc[m, "code"].tolist()))


def codes(kind: str) -> tuple[str, ...]:
    return _codes(kind)


def list_date(code: str) -> pd.Timestamp | None:
    row = instruments()[instruments()["code"] == code]
    if not len(row):
        return None
    v = row.iloc[0]["list_date"]
    return pd.Timestamp(v) if pd.notna(v) else None


def name_asof(code: str, t: pd.Timestamp) -> str | None:
    """code 在 t 日的时点名称（ST 判定与揭晓用）；查不到回退清单名。"""
    n = names()
    n = n[n["code"] == code]
    n = n[(n["start"] <= t) & (n["end"].isna() | (n["end"] >= t))]
    if len(n):
        return str(n.sort_values("start").iloc[-1]["name"])
    row = instruments()[instruments()["code"] == code]
    return str(row.iloc[0]["name"]) if len(row) else None


# ------------------------------------------------------------- 自选支持 ----

def normalize_code(c: str) -> str | None:
    """代码归一：本地库的 code 全库为裸 6 位（无 .SH/.SZ 后缀）。
    接受裸码或带后缀码，返回 instruments 里存在的裸码，否则 None。"""
    c = (c or "").strip()
    if not c:
        return None
    c = c.split(".")[0]           # 600519.SH → 600519
    if not (len(c) == 6 and c.isdigit()):
        return None
    inst = instruments()
    return c if len(inst[inst["code"] == c]) else None


def kind_of(code: str) -> str:
    """code 属于 'stocks' 还是 'etfs'（自选模式下判定数据目录）。默认 stocks。"""
    row = instruments()[instruments()["code"] == code]
    if len(row) and str(row.iloc[0]["type"]) == "etf":
        return "etfs"
    return "stocks"


def search(q: str, limit: int = 20) -> list[dict]:
    """代码前缀 / 名称包含 模糊搜索（个股 + ETF），自选选股用。"""
    q = (q or "").strip()
    if not q:
        return []
    inst = instruments()
    on_code = inst["code"].str.startswith(q)
    on_name = inst["name"].astype(str).str.contains(q, regex=False)
    m = inst[on_code | on_name]
    # 代码前缀命中的排前面（输 600519 优先出代码而非名称含 600519 的怪结果）
    m = m.assign(_c=~on_code[m.index]).sort_values(["_c", "code"])
    return [
        {"code": str(r["code"]), "name": str(r["name"]),
         "type": str(r["type"]), "exchange": str(r["exchange"])}
        for _, r in m.head(limit).iterrows()
    ]


# ------------------------------------------------------------- 分钟线 ----
# 姊妹项目 astock 的 tushare stk_mins 副本，只读挂接、不随仓库分发（GitHub 用户
# 默认无分钟数据，其余功能不受影响；想用分钟线见 README「分钟线」小节自行抓取）。
# 探测顺序：BZ_MINS_ROOT → ../astock/data/parquet/mins → 无
_MINS_CANDIDATES = [
    os.environ.get("BZ_MINS_ROOT"),
    _ROOT.parent / "astock" / "data" / "parquet" / "mins",
]
MINS = next((Path(p) for p in _MINS_CANDIDATES if p and Path(p).exists()), None)


def mins_available() -> bool:
    """分钟数据根是否挂载（页面/API 据此决定是否展示分钟入口）。"""
    return MINS is not None


def mins_freqs(code: str) -> list[str]:
    """该标的可用的分钟周期（如 ['5min', '30min']）；未挂载/无该标的返回 []。"""
    if MINS is None:
        return []
    d = MINS / code
    if not d.is_dir():
        return []
    return sorted(p.stem for p in d.glob("*.parquet"))


@functools.lru_cache(maxsize=4096)
def mins_bars(code: str, freq: str) -> pd.DataFrame:
    """分钟线（tushare 原始不复权口径，与本项目日线同量纲）。

    返回列：trade_time / open / high / low / close / volume / amount / adj_factor。
    adj_factor 按交易日从本项目日线的累计后复权因子映射（缺日向前填充）——
    分钟 bar 与同日日线共用一个因子，训练前复权锚定算法（因子等比缩放）可
    直接套用，跨源一致。

    数据质量边界（实证 000001/600519 全量比对，见 README）：open/收盘与日线
    逐位一致；tushare 分钟 high/low 丢失盘中瞬间极值（日线 high/low 为准）；
    约 10% 交易日分钟量能略缺。
    """
    empty = pd.DataFrame(columns=[
        "trade_time", "open", "high", "low", "close", "volume", "amount", "adj_factor"])
    if MINS is None:
        return empty
    path = MINS / code / f"{freq}.parquet"
    if not path.exists():
        return empty
    df = pd.read_parquet(path)
    if not len(df):
        return empty
    df = df.sort_values("trade_time").reset_index(drop=True)
    # 交易日 → adj_factor（分钟 bar 的日期取自 trade_time.date()）
    d = daily(kind_of(code), code)[["date", "adj_factor"]].dropna(subset=["adj_factor"])
    if len(d):
        day = pd.to_datetime(df["trade_time"]).dt.normalize()
        fac = pd.merge(day.rename("date").to_frame(), d, on="date", how="left")["adj_factor"]
        fac = fac.ffill().bfill()          # 日线未覆盖的早期分钟沿用最近因子
        df["adj_factor"] = fac.to_numpy()
    else:
        df["adj_factor"] = float("nan")
    return df


def mins_coverage(code: str) -> list[dict]:
    """分钟数据概览：[{freq, start, end, bars}]，供 API/前端展示。"""
    out = []
    for freq in mins_freqs(code):
        df = mins_bars(code, freq)
        if len(df):
            out.append({
                "freq": freq,
                "start": str(df["trade_time"].iloc[0]),
                "end": str(df["trade_time"].iloc[-1]),
                "bars": int(len(df)),
            })
    return out
