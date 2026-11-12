"""训练会话生成：随机/自选选股 + 时间窗（随机或指定训练期）+ 过滤 + 前复权 + 匿名化。

双盲原则：本模块产出的 payload 绝不含代码/名称/真实日期；
身份信息只留在服务端内存（secret），由 /api/reveal 在训练结束后提供。
自选（custom）与定窗（date_from/date_to）是用户点名要的"半盲复盘"：
身份与区间对用户已知，但日期轴仍隐藏，回放体验一致。

品类：
  stock   全市场个股随机窗口
  etf     全市场 ETF 随机窗口
  limit   涨停起爆——窗口内"最后一根可见历史 bar"强制为涨停日
  custom  自选：params.codes 里随机抽一个（个股/ETF 均可）
  index   指数：params.index_key 指定或 18 个指数随机（数据来自 bz_index 缓存）

date_from/date_to 语义（训练期）：训练推进从 date_from 起的首个交易日开始，
到 date_to 止（空 = 数据末尾）；前置可见历史自动从 date_from 往前取 history 根。

history=0 表示「全部」：可见历史 = 训练起点之前的全部 bars（从上市/指数起点起）。
随机窗口下年份/上市年限/断档/涨跌停完整等过滤均锚定**训练起点**（远古历史里的
长停牌、1996-12 前无涨跌停制度不再剔除候选）。
"""
from __future__ import annotations

import random
import uuid
from datetime import date, timedelta

import numpy as np
import pandas as pd

import bz_data
import bz_index

DEFAULTS = {
    "history": 120,        # 前置可见历史根数；0 = 全部（训练前所有 bars）
    "forward": 120,        # 训练推进根数（随机窗口用；定窗时由日期区间决定）
    "min_list_years": 1.0, # 窗口起点前须上市年数（随机窗口用）
    "exclude_st": True,
    "year_from": 2016,
    "year_to": 2025,
    "capital": 100000.0,
    # ---- v1.1 新增 ----
    "codes": None,             # 自选代码列表（category=custom）
    "index_key": None,         # 指定指数 key（category=index），空则随机
    "date_from": None,         # 训练期首日 YYYY-MM-DD（含）；空 = 随机窗口
    "date_to": None,           # 训练期末日（含）；空 = 数据末尾
    "fill_mode": "close",      # close=当根收盘成交 | next_open=次日开盘成交
    "commission_rate": 0.0001, # 佣金 万1
    "commission_min": 5.0,     # 最低佣金 5 元（不免5）
    "stamp_rate": 0.0005,      # 印花税 卖出 万5（仅个股）
    "transfer_rate": 0.00001,  # 过户费 万0.1 双边（仅个股）
}

MAX_GAP_DAYS = 30          # 窗口内允许的最大停牌断档（自然日）
LIMIT_TOL = 0.999          # close >= up_limit * LIMIT_TOL 视为涨停收盘
MIN_HIST, MIN_FWD = 40, 40 # 定窗最少前置历史 / 训练根数


def _st_at(code: str, d0) -> bool:
    """时点 ST 判定：优先 baostock is_st 列，回退名称含 ST/退。"""
    v = bz_data.is_st_at(code, d0)
    if v is not None:
        return v
    nm = bz_data.name_asof(code, d0)
    return bool(nm and ("ST" in nm.upper() or "退" in nm))


def board_of(code: str, kind: str) -> str:
    if kind == "etfs":
        return "etf"
    if code.startswith("688") or code.startswith("689"):
        return "star"
    if code.startswith("30"):
        return "chinext"
    return "main"


def _clamp(v, lo, hi):
    return min(max(v, lo), hi)


def normalize_params(raw: dict) -> dict:
    p = dict(DEFAULTS)
    p.update({k: v for k, v in (raw or {}).items() if k in p and v is not None and v != ""})
    h = int(p["history"])
    p["history"] = 0 if h <= 0 else int(_clamp(h, 40, 250))   # 0=全部
    p["forward"] = int(_clamp(p["forward"], 40, 250))
    p["min_list_years"] = float(_clamp(p["min_list_years"], 0.0, 20.0))
    p["exclude_st"] = bool(p["exclude_st"])
    # 下界 1993：baostock 事件表在 1991-92（0.5%涨跌停年代）有污染，因子比例失真
    p["year_from"] = int(_clamp(p["year_from"], 1993, date.today().year))
    p["year_to"] = int(_clamp(p["year_to"], p["year_from"], date.today().year))
    p["capital"] = float(_clamp(p["capital"], 10000.0, 10000000.0))

    for k in ("date_from", "date_to"):
        v = p[k]
        if v is None:
            continue
        try:
            p[k] = date.fromisoformat(str(v)[:10]).isoformat()
        except ValueError:
            raise ValueError(f"{k} 日期格式应为 YYYY-MM-DD：{v}")
    if p["date_from"] and p["date_to"] and p["date_to"] < p["date_from"]:
        raise ValueError("结束日期早于起始日期")

    if p["fill_mode"] not in ("close", "next_open"):
        raise ValueError("fill_mode 必须是 close / next_open")
    p["commission_rate"] = float(_clamp(p["commission_rate"], 0.0, 0.01))
    p["commission_min"] = float(_clamp(p["commission_min"], 0.0, 50.0))
    p["stamp_rate"] = float(_clamp(p["stamp_rate"], 0.0, 0.01))
    p["transfer_rate"] = float(_clamp(p["transfer_rate"], 0.0, 0.001))

    if p["codes"] is not None:
        if isinstance(p["codes"], str):
            p["codes"] = [c for c in p["codes"].replace(",", " ").split() if c]
        seen, out = set(), []
        for c in p["codes"][:50]:
            nc = bz_data.normalize_code(c)
            if nc and nc not in seen:
                seen.add(nc)
                out.append(nc)
        p["codes"] = out
    if p["index_key"] is not None:
        if p["index_key"] not in bz_index.BY_KEY:
            raise ValueError(f"未知指数 {p['index_key']}")
    return p


def _feasible_ends(df: pd.DataFrame, p: dict, code: str, need_limit: bool,
                   require_limits: bool) -> list[int]:
    """枚举合法窗口终点 e（bar 下标）。窗口 = [e-W+1, e]，W = history+forward；
    history=0（全部）时窗口 = [0, e]，锚点（年份/上市年限/断档/涨跌停完整）取训练期。

    全程用 numpy 按位置索引，避免 pandas 按 index 对齐错位。
    require_limits: 个股要求涨跌停价完整（个别 bar 缺失的窗口直接剔除；
    全史模式下只要求训练期完整——1996-12 前无涨跌停制度，远古历史天然缺失）。
    """
    n = len(df)
    dates = df["date"].reset_index(drop=True)
    fwd = p["forward"]

    if p["history"] == 0:
        # 全史模式：s 恒为 0，i0 = e-fwd+1 为训练第一根
        lo = MIN_HIST + fwd - 1              # 训练前至少 MIN_HIST 根历史
        if n <= lo:
            return []
        e_idx = np.arange(lo, n)
        i0_idx = e_idx - fwd + 1
        anchor = i0_idx                       # 年份/上市年限锚定训练起点
        gap_win, lim_win = fwd - 1, fwd       # 断档/涨跌停只查训练期
    else:
        W = p["history"] + fwd
        if n < W:
            return []
        s_idx = np.arange(n - W + 1)          # 每个窗口的起点
        e_idx = s_idx + W - 1                 # 每个窗口的终点
        i0_idx = s_idx + p["history"]
        anchor = s_idx
        gap_win, lim_win = W - 1, W

    # 锚点年份 + 上市年限
    year0 = dates.dt.year.to_numpy()[anchor]
    ok = (year0 >= p["year_from"]) & (year0 <= p["year_to"])
    ld = bz_data.list_date(code)
    if ld is not None:
        ok &= (dates.to_numpy()[anchor] >= np.datetime64(ld + timedelta(days=int(p["min_list_years"] * 365.25))))

    # 停牌断档：g[i] = date[i]-date[i-1]，锚点后 span 内最大断档 ≤ MAX_GAP_DAYS
    # （全史模式只查训练期——远古长停牌不剔除候选，双盲下历史断档无害）
    g = dates.diff().dt.days.to_numpy()
    roll = pd.Series(g).rolling(gap_win).max().to_numpy()
    r = roll[e_idx]
    ok &= np.isnan(r) | (r <= MAX_GAP_DAYS)

    up = df["up_limit"].to_numpy(dtype=float)
    if require_limits:
        down = df["down_limit"].to_numpy(dtype=float)
        n_up = pd.Series(np.isnan(up)).rolling(lim_win).sum().to_numpy()   # 锚点起 span 根内 NaN 数
        n_dn = pd.Series(np.isnan(down)).rolling(lim_win).sum().to_numpy()
        ok &= (n_up[e_idx] == 0) & (n_dn[e_idx] == 0)

    if need_limit:
        h_idx = e_idx - fwd                   # 最后一根可见历史 bar = 涨停日
        close = df["close"].to_numpy(dtype=float)
        hit = (close >= up * LIMIT_TOL) & ~np.isnan(up)
        ok &= hit[h_idx]

    return [int(e) for e in e_idx[ok]]


def _fixed_window(df: pd.DataFrame, p: dict, need_limit: bool) -> tuple[int, int]:
    """定窗：date_from 起的首个 bar 为训练第一根，date_to 止（空 = 末根）；
    前置历史自动从 date_from 往前取（不足 history 根则用完为止，最少 MIN_HIST）。
    用户指名要这段行情：跳过 ST/年限/断档过滤。"""
    dates = df["date"]
    i0 = int((dates < pd.Timestamp(p["date_from"])).sum())
    if i0 >= len(df):
        raise ValueError("起始日期晚于该标的数据末尾")
    if p["date_to"]:
        i1 = int((dates <= pd.Timestamp(p["date_to"])).sum()) - 1
        if i1 < i0:
            raise ValueError("该日期区间内没有交易日")
    else:
        i1 = len(df) - 1
    if i1 - i0 + 1 < MIN_FWD:
        raise ValueError(f"训练期太短（{i1 - i0 + 1} 根，至少 {MIN_FWD}）")
    hist = i0 if p["history"] == 0 else min(p["history"], i0)   # 0=全部
    if hist < MIN_HIST:
        raise ValueError(f"起始日期前只有 {i0} 根历史，不足 {MIN_HIST} 根")
    if need_limit:
        up = df["up_limit"].iloc[i0 - 1]
        c = df["close"].iloc[i0 - 1]
        if pd.isna(up) or c < float(up) * LIMIT_TOL:
            raise ValueError("起始日前一交易日不是涨停收盘，涨停起爆无法定窗于此")
    return i0 - hist, i1


def _bars_payload(df: pd.DataFrame, s: int, e: int) -> tuple[list[dict], list[str]]:
    """切窗口 + 前复权（锚定窗口末根）→ 匿名 bars + 真实日期（仅存服务端）。"""
    w = df.iloc[s:e + 1].reset_index(drop=True)
    f_end = float(w["adj_factor"].iloc[-1]) if pd.notna(w["adj_factor"].iloc[-1]) else 1.0
    if not (f_end > 0):
        f_end = 1.0
    f = (w["adj_factor"].astype(float) / f_end).fillna(1.0)

    def px(col: str) -> np.ndarray:
        return (w[col].astype(float).to_numpy() * f.to_numpy()).round(2)

    def lim(col: str) -> list[float | None]:
        v = w[col].astype(float).to_numpy() * f.to_numpy()
        return [None if np.isnan(x) else round(float(x), 2) for x in v]

    o, h, l, c = px("open"), px("high"), px("low"), px("close")
    ups, downs = lim("up_limit"), lim("down_limit")
    vol = w["volume"].fillna(0).to_numpy()

    bars = [
        {"o": float(o[i]), "h": float(h[i]), "l": float(l[i]), "c": float(c[i]),
         "v": int(vol[i]), "up": ups[i], "down": downs[i]}
        for i in range(len(w))
    ]
    dates = [d.strftime("%Y-%m-%d") for d in w["date"]]
    return bars, dates


def _public_payload(category: str, p: dict, bars: list[dict], board: str,
                    is_etf: bool) -> dict:
    return {
        "sid": uuid.uuid4().hex[:12],
        "category": category,
        "history": p["_hist"],
        "forward": p["_fwd"],
        "total": len(bars),
        "bars": bars,
        "config": {
            "capital": p["capital"],
            "board": board,
            "is_etf": is_etf,
            "fill_mode": p["fill_mode"],
            "fees": {
                "commission_rate": p["commission_rate"],
                "commission_min": p["commission_min"],
                "stamp_rate": p["stamp_rate"],
                "transfer_rate": p["transfer_rate"],
            },
        },
    }


def _random_window_session(category: str, p: dict, df: pd.DataFrame, code: str,
                           kind: str, board: str, need_limit: bool) -> tuple[dict, dict]:
    """随机窗口（stock/etf/limit 与自选无日期时共用）。"""
    ends = _feasible_ends(df, p, code, need_limit, require_limits=(kind == "stocks"))
    rng = random.SystemRandom()
    rng.shuffle(ends)
    if not ends:
        raise RuntimeError("没有符合条件的窗口，请放宽过滤条件或调整年份区间")
    for e in ends[:20]:
        i0 = e - p["forward"] + 1                       # 训练第一根
        s = 0 if p["history"] == 0 else i0 - p["history"]
        d0 = df["date"].iloc[i0 if s == 0 else s]       # 全史模式 ST 锚定训练起点
        if p["exclude_st"] and kind == "stocks" and _st_at(code, d0):
            continue
        bars, dates = _bars_payload(df, s, e)
        if not bars or any(b["h"] < b["l"] for b in bars):
            continue
        p["_hist"], p["_fwd"] = i0 - s, p["forward"]
        public = _public_payload(category, p, bars, board, kind == "etfs")
        name = bz_data.name_asof(code, df["date"].iloc[e]) or code
        secret = {
            "code": code, "name": name, "board": board, "category": category,
            "start_date": dates[0], "end_date": dates[-1], "dates": dates,
            "params": {k: v for k, v in p.items() if not k.startswith("_")},
        }
        return public, secret
    raise RuntimeError("抽样失败（过滤后无合法窗口），请放宽条件")


def new_session(category: str, raw_params: dict) -> tuple[dict, dict]:
    """生成一局训练。返回 (public_payload, secret)。
    category: stock | etf | limit | custom | index。"""
    p = normalize_params(raw_params)

    if category == "index":
        return _new_index_session(p)

    if category == "custom":
        if not p["codes"]:
            raise ValueError("自选模式需要至少一个有效代码")
        rng = random.SystemRandom()
        code = rng.choice(p["codes"])
        kind = bz_data.kind_of(code)
        df = bz_data.daily(kind, code)
        if not len(df):
            raise RuntimeError(f"{code} 无日线数据")
        board = board_of(code, kind)
        if p["date_from"]:
            s, e = _fixed_window(df, p, need_limit=False)
            bars, dates = _bars_payload(df, s, e)
            if not bars or any(b["h"] < b["l"] for b in bars):
                raise RuntimeError("该窗口数据异常（高低价矛盾）")
            i0 = _first_train_idx(df, p)
            p["_hist"], p["_fwd"] = i0 - s, e - i0 + 1
            public = _public_payload(category, p, bars, board, kind == "etfs")
        else:
            return _random_window_session(category, p, df, code, kind, board, need_limit=False)
        name = bz_data.name_asof(code, df["date"].iloc[e]) or code
        secret = {
            "code": code, "name": name, "board": board, "category": category,
            "start_date": dates[0], "end_date": dates[-1], "dates": dates,
            "params": {k: v for k, v in p.items() if not k.startswith("_")},
        }
        return public, secret

    # ---- stock / etf / limit：全市场随机 ----
    kind = "etfs" if category == "etf" else "stocks"
    need_limit = category == "limit"
    pool = list(bz_data.codes(kind))
    # 老年份窗口：候选池限定当年已上市的标的（否则随机抽样几乎不可能命中老股）
    era = pd.Timestamp(f"{p['year_to']}-12-31") if not p["date_from"] else None
    if era is not None:
        inst = bz_data.instruments()
        ok = set(inst[(inst["code"].isin(pool)) &
                      (inst["list_date"].isna() | (inst["list_date"] <= era))]["code"])
        filtered = [c for c in pool if c in ok]
        if filtered:
            pool = filtered
    rng = random.SystemRandom()
    rng.shuffle(pool)

    last_err = "没有符合条件的标的"
    for code in pool[:400]:
        df = bz_data.daily(kind, code)
        if p["date_from"]:
            try:
                s, e = _fixed_window(df, p, need_limit)
            except ValueError as ex:
                last_err = f"{code}: {ex}"
                continue
            if p["exclude_st"] and kind == "stocks" and _st_at(code, df["date"].iloc[s]):
                last_err = f"{code}: 起点 ST"
                continue
            bars, dates = _bars_payload(df, s, e)
            if not bars or any(b["h"] < b["l"] for b in bars):
                continue
            i0 = _first_train_idx(df, p)
            p["_hist"], p["_fwd"] = i0 - s, e - i0 + 1
            board = board_of(code, kind)
            public = _public_payload(category, p, bars, board, kind == "etfs")
            name = bz_data.name_asof(code, df["date"].iloc[e]) or code
            secret = {
                "code": code, "name": name, "board": board, "category": category,
                "start_date": dates[0], "end_date": dates[-1], "dates": dates,
                "params": {k: v for k, v in p.items() if not k.startswith("_")},
            }
            return public, secret
        ends = _feasible_ends(df, p, code, need_limit, require_limits=(kind == "stocks"))
        rng.shuffle(ends)
        for e in ends[:6]:
            i0 = e - p["forward"] + 1                   # 训练第一根
            s = 0 if p["history"] == 0 else i0 - p["history"]
            d0 = df["date"].iloc[i0 if s == 0 else s]   # 全史模式 ST 锚定训练起点
            if p["exclude_st"] and kind == "stocks" and _st_at(code, d0):
                continue
            bars, dates = _bars_payload(df, s, e)
            if not bars or any(b["h"] < b["l"] for b in bars):
                continue
            board = board_of(code, kind)
            p["_hist"], p["_fwd"] = i0 - s, p["forward"]
            public = _public_payload(category, p, bars, board, kind == "etfs")
            name = bz_data.name_asof(code, df["date"].iloc[e]) or code
            secret = {
                "code": code, "name": name, "board": board, "category": category,
                "start_date": dates[0], "end_date": dates[-1], "dates": dates,
                "params": {k: v for k, v in p.items() if not k.startswith("_")},
            }
            return public, secret
        last_err = f"{code}: 无合法窗口"
    raise RuntimeError(f"抽样失败，请放宽过滤条件（{last_err}）")


def _first_train_idx(df: pd.DataFrame, p: dict) -> int:
    """定窗下训练第一根 bar 的下标（首个 date >= date_from）。"""
    return int((df["date"] < pd.Timestamp(p["date_from"])).sum())


def _index_df(key: str) -> pd.DataFrame:
    """指数缓存 → serving 同构 DataFrame（adj=1、涨跌停 NaN）。"""
    df = bz_index.load(key)
    if df is None or not len(df):
        bz_index.refresh(key)
        df = bz_index.load(key)
    if df is None or not len(df):
        raise RuntimeError(f"指数 {key} 无缓存数据，请先在看板点「同步数据」")
    out = pd.DataFrame({
        "date": pd.to_datetime(df["date"]),
        "open": df["open"].astype(float), "high": df["high"].astype(float),
        "low": df["low"].astype(float), "close": df["close"].astype(float),
        "volume": df["volume"].fillna(0.0).astype(float),
        "adj_factor": 1.0, "up_limit": float("nan"), "down_limit": float("nan"),
    }).sort_values("date").reset_index(drop=True)
    return out


def _new_index_session(p: dict) -> tuple[dict, dict]:
    """指数会话。随机模式逐个尝试：指数成立时间差很大（恒生科技 2020 才有数据），
    年份区间/全史模式下某些指数无合法窗口时跳过，换下一个。"""
    rng = random.SystemRandom()
    if p["index_key"]:
        keys = [p["index_key"]]
    else:
        keys = list(bz_index.BY_KEY)
        rng.shuffle(keys)

    last_err = "没有可用指数"
    for key in keys:
        meta = bz_index.BY_KEY[key]
        try:
            df = _index_df(key)
            if p["date_from"]:
                s, e = _fixed_window(df, p, need_limit=False)
                bars, dates = _bars_payload(df, s, e)
                if not bars or any(b["h"] < b["l"] for b in bars):
                    raise RuntimeError("该窗口数据异常")
                p["_hist"] = _first_train_idx(df, p) - s
                p["_fwd"] = len(bars) - p["_hist"]
            else:
                ends = _feasible_ends(df, p, code="", need_limit=False, require_limits=False)
                if not ends:
                    raise RuntimeError("该指数在指定年份区间没有足够长的窗口")
                rng.shuffle(ends)
                e = ends[0]
                i0 = e - p["forward"] + 1
                s = 0 if p["history"] == 0 else i0 - p["history"]
                bars, dates = _bars_payload(df, s, e)
                p["_hist"], p["_fwd"] = i0 - s, p["forward"]
        except (RuntimeError, ValueError) as ex:
            last_err = f"{meta['name']}: {ex}"
            if p["index_key"]:
                raise
            continue

        public = _public_payload("index", p, bars, board="index", is_etf=False)
        secret = {
            "code": key, "name": meta["name"], "board": "index", "category": "index",
            "start_date": dates[0], "end_date": dates[-1], "dates": dates,
            "params": {k: v for k, v in p.items() if not k.startswith("_")},
        }
        return public, secret
    raise RuntimeError(f"没有符合条件的指数（{last_err}），请调整年份区间")
