/* K线道场 KLineDojo · 前端（v1.1）
 * 回放控制 + 模拟撮合引擎（T+1 / 涨跌停拒单 / 整手 / 可配费率 / 当根收盘或次日开盘成交）
 * + 训练图表周期(日周月年)与指标(MA/BOLL/MACD/KDJ/VOL/缠论) + 会话内画线 + 多主题
 * 双盲：训练期只见匿名 bars（时间轴隐藏），身份由 /api/reveal 在结束后揭晓。
 */
'use strict';

/* ---------------- 工具 ---------------- */
const $ = (id) => document.getElementById(id);
const fmtMoney = (x) => Number(x).toLocaleString('zh-CN', { maximumFractionDigits: 0 });
const fmtPct = (x) => (x >= 0 ? '+' : '') + (x * 100).toFixed(2) + '%';
const UP = '#e0483e';    // A股红涨（四主题下均可读，保持恒定）
const DOWN = '#1fa06b';  // 绿跌
const MA_DEFS = [                       // 可选均线（勾选开关，默认 5/10/20/60）
  { p: 5, color: '#f0b90b' }, { p: 10, color: '#4a90e2' },
  { p: 13, color: '#22c1c3' }, { p: 20, color: '#c77dff' },
  { p: 21, color: '#ff6b9d' }, { p: 40, color: '#9ccc65' },
  { p: 60, color: '#ff8c42' }, { p: 120, color: '#8892a6' },
];
const MA_DEFAULT = [5, 10, 20, 60];
let maSel = null;                       // 勾选的均线周期（懒加载，见 loadToggles 后）

let toastTimer = null;
function toast(msg, ok = false) {
  const t = $('toast');
  t.textContent = msg;
  t.className = ok ? 'ok' : '';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 2600);
}

async function api(path, body) {
  const res = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

/* ---------------- 全局状态 ---------------- */
let S = null;            // 会话 {sid, category, bars, history, forward, total, config}
let idx = -1;            // 当前已揭示到的 bar 下标
let cash = 0;
let pos = null;          // {shares, free, frozen, costBasis}
let trades = [];         // {i, side, shares, price, amount, fee, realized?, fill?}
let markers = [];
let equityCurve = [];
let roundPnl = 0, roundTrips = [];
let startedAt = 0;
let playing = null;
let modalMode = null;
let finished = false;
let lastCategory = 'stock', lastParams = {};

let chart = null, candle = null, volS = null, maS = {}, bollS = {}, bollBar = null, macdS = {}, kdjS = {};
let volChart = null, bollChart = null, macdChart = null, kdjChart = null;   // 独立小面板
let trainChip = null;                      // 筹码峰（右侧价格分布）
let trainThemeDirty = false;             // 看板页切主题后回训练页签需补重建
let overlay = null;             // 训练会话内画线（不持久化）
let pendingOrders = [];         // next_open 模式挂单 [{side:'buy'|'sell', shares}]
let lastAgg = [];               // 当前周期的聚合 bars（marker 吸附用）
let revealChart = null, revealInfo = null;

let trainPeriod = localStorage.getItem('bz_train_period') || 'D';
function loadToggles(key, defaults) {      // localStorage 坏值不炸全局（顶层执行无 catch 会挂死整页）
  try { return Object.assign(defaults, JSON.parse(localStorage.getItem(key) || '{}')); }
  catch { return defaults; }
}
const tToggles = loadToggles('bz_train_toggles',
  { boll: false, macd: true, kdj: false, vol: true, chip: false, chan: false, duan: false, bei: false });
if (!Array.isArray(tToggles.maSel)) {          // 旧版只有 ma:true/false
  tToggles.maSel = tToggles.ma === false ? [] : MA_DEFAULT.slice();
}
delete tToggles.ma;
maSel = tToggles.maSel;
const maOn = () => new Set(maSel);

let selectedCodes = new Map();  // 本局自选标的 code → name
let watchlist = [];             // 我的自选 [{code,name}]（localStorage）

const CAT_NAMES = { stock: '个股', limit: '涨停起爆', etf: 'ETF', index: '指数', custom: '自选' };

/* 训练期伪时间轴（隐藏不显示）。FAKE_T0 是周一 → 伪周K恰好每 5 根一根 */
const FAKE_T0 = Math.floor(Date.UTC(2000, 0, 3) / 1000);
const fakeTime = (i) => FAKE_T0 + i * 86400;
const fakeDate = (i) => new Date(fakeTime(i) * 1000).toISOString().slice(0, 10);
const tsOf = (d) => Math.floor(Date.parse(d + 'T00:00:00Z') / 1000);

/* ---------------- 撮合引擎 ---------------- */
function fees() { return S.config.fees; }
function fillMode() { return S.config.fill_mode || 'close'; }
/** ETF 与指数：免印花税/过户费，按 100 份整手 */
function feeExempt() { return S.config.is_etf || S.config.board === 'index'; }

function lotRule() {
  if (feeExempt()) return { min: 100, step: 100, label: '100 份整数倍' };
  if (S.config.board === 'star') return { min: 200, step: 1, label: '≥200 股，可 1 股递增' };
  return { min: 100, step: 100, label: '100 股整数倍' };
}

function lotOk(n) {
  const r = lotRule();
  if (n < r.min) return false;
  return r.step === 1 ? true : n % r.step === 0;
}

function maxBuyShares(price) {
  const r = lotRule();
  const f = fees();
  const unit = price * (1 + f.commission_rate + (feeExempt() ? 0 : f.transfer_rate));
  let n = Math.floor(cash / unit);
  if (r.step !== 1) n = Math.floor(n / r.step) * r.step;
  if (n < r.min) return 0;
  while (n >= r.min && n * price + buyFee(n * price) > cash + 1e-9) {
    n -= r.step;
  }
  return Math.max(0, n);
}

function buyFee(amount) {
  const f = fees();
  return Math.max(amount * f.commission_rate, f.commission_min) + (feeExempt() ? 0 : amount * f.transfer_rate);
}
function sellFee(amount) {
  const f = fees();
  return Math.max(amount * f.commission_rate, f.commission_min)
    + (feeExempt() ? 0 : amount * (f.stamp_rate + f.transfer_rate));
}

function atLimitUp(b) { return b.up != null && b.c >= b.up - 0.001; }
function atLimitDown(b) { return b.down != null && b.c <= b.down + 0.001; }

function execBuy(n, price, fill) {
  const amount = n * price;
  const fee = buyFee(amount);
  cash -= amount + fee;
  pos.frozen += n;
  pos.shares += n;
  pos.costBasis += amount + fee;
  trades.push({ i: idx, side: 'buy', shares: n, price, amount, fee, fill });
  markers.push({
    time: fakeTime(idx), position: 'belowBar', color: UP, shape: 'arrowUp',
    text: `B ${n}@${price.toFixed(2)}${fill === 'open' ? '开' : ''}`,
  });
  toast(`买入 ${n} @ ${price.toFixed(2)}${fill === 'open' ? '（开盘）' : ''}，费用 ${fee.toFixed(2)} 元`, true);
  updateHUD();
}

function execSell(n, price, fill) {
  const amount = n * price;
  const fee = sellFee(amount);
  const avg = pos.costBasis / pos.shares;
  const realized = amount - fee - n * avg;
  cash += amount - fee;
  pos.shares -= n;
  pos.free -= n;
  pos.costBasis -= n * avg;
  roundPnl += realized;
  if (pos.shares === 0) {
    roundTrips.push(roundPnl);
    roundPnl = 0;
    pos.free = 0; pos.frozen = 0;
  }
  trades.push({ i: idx, side: 'sell', shares: n, price, amount, fee, realized, fill });
  markers.push({
    time: fakeTime(idx), position: 'aboveBar', color: DOWN, shape: 'arrowDown',
    text: `S ${n}@${price.toFixed(2)}${fill === 'open' ? '开' : ''}`,
  });
  toast(`卖出 ${n} @ ${price.toFixed(2)}${fill === 'open' ? '（开盘）' : ''}，${realized >= 0 ? '盈利' : '亏损'} ${Math.abs(realized).toFixed(2)} 元`, true);
  updateHUD();
}

function engineBuy(n) {
  const b = S.bars[idx];
  if (!lotOk(n)) return toast(`数量不合规（${lotRule().label}）`);
  if (fillMode() === 'close') {
    if (atLimitUp(b)) return toast(`涨停价 ${b.up}，无法买入`);
    const amount = n * b.c;
    if (amount + buyFee(amount) > cash + 1e-9) return toast('资金不足');
    execBuy(n, b.c, 'close');
  } else {
    const est = n * b.c;
    if (est + buyFee(est) > cash + 1e-9) return toast('资金不足（按当前收盘估算，开盘价成交）');
    pendingOrders.push({ side: 'buy', shares: n });
    toast(`挂单：次日开盘买入 ${n}（开盘价成交；一字涨停废单）`, true);
    updateHUD();
  }
}

function engineSell(n) {
  const b = S.bars[idx];
  if (pos.shares <= 0) return toast('没有持仓');
  if (n > pos.free) {
    return toast(pos.frozen > 0 ? '今日买入的仓位 T+1 才能卖出' : '可卖数量不足');
  }
  const isClearAll = n === pos.shares;
  if (!isClearAll && !lotOk(n)) return toast(`数量不合规（${lotRule().label}；清仓可零股）`);
  if (fillMode() === 'close') {
    if (atLimitDown(b)) return toast(`跌停价 ${b.down}，无法卖出`);
    execSell(n, b.c, 'close');
  } else {
    pendingOrders.push({ side: 'sell', shares: n });
    toast(`挂单：次日开盘卖出 ${n}（开盘价成交；一字跌停废单）`, true);
    updateHUD();
  }
}

/** next_open 模式：新 bar 开盘价结算挂单（一字板废单、资金不足废单） */
function settlePending() {
  if (!pendingOrders.length) return;
  const b = S.bars[idx];
  for (const o of pendingOrders) {
    if (o.side === 'buy') {
      if (b.up != null && b.o >= b.up - 0.001) {
        toast(`开盘涨停 ${b.o.toFixed(2)}，买单未成交`);
        continue;
      }
      const amount = o.shares * b.o;
      if (amount + buyFee(amount) > cash + 1e-9) {
        toast(`开盘价 ${b.o.toFixed(2)} 高于预估，资金不足，买单未成交`);
        continue;
      }
      execBuy(o.shares, b.o, 'open');
    } else {
      if (pos.shares <= 0 || o.shares > pos.free) {
        toast('可卖数量不足（T+1），卖单未成交');
        continue;
      }
      if (b.down != null && b.o <= b.down + 0.001) {
        toast(`开盘跌停 ${b.o.toFixed(2)}，卖单未成交`);
        continue;
      }
      execSell(o.shares, b.o, 'open');
    }
  }
  pendingOrders = [];
}

/* ---------------- 图表 ---------------- */
const TRAIN_AXIS_W = 62;                 // 各面板右轴定宽 → 时间轴垂直对齐

function mkTrainPane(elId) {
  const T = window.BzTheme.colors();
  return LightweightCharts.createChart($(elId), {
    layout: { background: { color: T.panel }, textColor: T.dim, fontSize: 10 },
    grid: { vertLines: { color: T.grid }, horzLines: { color: T.grid } },
    rightPriceScale: {
      borderColor: T.line, minimumWidth: TRAIN_AXIS_W, maximumWidth: TRAIN_AXIS_W,
      scaleMargins: { top: 0.12, bottom: 0.08 },
    },
    timeScale: { visible: false, borderColor: T.line, rightOffset: 8 },
    crosshair: { mode: 0 },
    autoSize: true,
    handleScroll: false, handleScale: false,   // 小面板不响应交互，主面板单向同步
  });
}

/** 时间轴只挂最底部的可见小面板（训练时间轴默认隐藏，保持双盲） */
function refreshTrainAxisOwner() {
  const order = [
    [bollChart, tToggles.boll], [volChart, tToggles.vol],
    [macdChart, tToggles.macd], [kdjChart, tToggles.kdj],
  ];
  let owner = null;
  for (const [c, on] of order) if (on) owner = c;
  for (const [c] of order) {
    c.timeScale().applyOptions({ visible: c === owner });
  }
}

function buildTrainChart() {
  for (const c of [chart, volChart, bollChart, macdChart, kdjChart]) {
    if (c) { c.remove(); }
  }
  chart = bollChart = macdChart = kdjChart = volChart = null;
  const T = window.BzTheme.colors();
  // 主面板：K线 + MA + 画线 + 买卖标记
  chart = LightweightCharts.createChart($('chart'), {
    layout: { background: { color: T.panel }, textColor: T.dim, fontSize: 12 },
    grid: { vertLines: { color: T.grid }, horzLines: { color: T.grid } },
    rightPriceScale: {
      borderColor: T.line, minimumWidth: TRAIN_AXIS_W, maximumWidth: TRAIN_AXIS_W,
      scaleMargins: { top: 0.05, bottom: 0.05 },
    },
    timeScale: { visible: false, borderColor: T.line, rightOffset: 8 },
    crosshair: { mode: 0 },
    autoSize: true,
  });
  candle = chart.addCandlestickSeries({
    upColor: UP, downColor: DOWN, borderUpColor: UP, borderDownColor: DOWN,
    wickUpColor: UP, wickDownColor: DOWN,
  });
  maS = {};
  for (const m of MA_DEFS) {
    maS[m.p] = chart.addLineSeries({
      color: m.color, lineWidth: 1, title: `MA${m.p}`,
      priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
    });
  }
  // 小面板：BOLL / VOL / MACD / KDJ
  bollChart = mkTrainPane('train-bollchart');
  bollBar = bollChart.addBarSeries({
    upColor: UP, downColor: DOWN, thinBars: true,
    priceLineVisible: false, lastValueVisible: false,
  });
  bollS = {
    mid: bollChart.addLineSeries({ color: '#f0b90b', lineWidth: 1, lineStyle: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }),
    up: bollChart.addLineSeries({ color: '#8892a6', lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }),
    low: bollChart.addLineSeries({ color: '#8892a6', lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }),
  };
  volChart = mkTrainPane('train-volchart');
  volS = volChart.addHistogramSeries({
    priceFormat: { type: 'volume' }, color: T.volDown,
    priceLineVisible: false, lastValueVisible: false,
  });
  macdChart = mkTrainPane('train-macdchart');
  macdS = {
    hist: macdChart.addHistogramSeries({ priceLineVisible: false, lastValueVisible: false }),
    dif: macdChart.addLineSeries({ color: '#e0483e', lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }),
    dea: macdChart.addLineSeries({ color: '#4a90e2', lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }),
  };
  kdjChart = mkTrainPane('train-kdjchart');
  kdjS = {
    k: kdjChart.addLineSeries({ color: '#f0b90b', lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }),
    d: kdjChart.addLineSeries({ color: '#4a90e2', lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }),
    j: kdjChart.addLineSeries({ color: '#c77dff', lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }),
  };

  overlay = new window.Overlay(chart, candle, $('train-pane-main'), {
    onModeChange: syncTrainDrawBtns,
  });
  if (!trainChip && window.ChipProfile) trainChip = new window.ChipProfile(document.getElementById('train-chip'));
  if (trainChip) trainChip.attach(chart, candle);
  // 主面板 → 小面板：可视范围单向同步（小面板 handleScale 已关，无回环）
  let syncing = false;
  chart.timeScale().subscribeVisibleLogicalRangeChange((r) => {
    if (r && !syncing) {
      syncing = true;
      for (const c of [bollChart, volChart, macdChart, kdjChart]) {
        try { c.timeScale().setVisibleLogicalRange(r); } catch { /* 空数据面板 */ }
      }
      syncing = false;
    }
  });
  chart.subscribeClick((param) => { overlay.handleClick(param); });   // 训练画线本局有效，不持久化
  chart.subscribeCrosshairMove((param) => updateTrainLegend(param));
  window.__bzTrain = { chart, overlay };   // 调试/自动化测试用

  applyTrainToggles(true);
}

function syncTrainDrawBtns() {
  if (!overlay) return;
  document.querySelectorAll('[data-tdraw]').forEach((x) => {
    x.classList.toggle('on', x.dataset.tdraw === overlay.mode);
  });
}

/** 日期 → 当前周期聚合 bar 的下标（最近 ≤） */
function aggIndexOf(d) {
  const bs = lastAgg;
  let lo = 0, hi = bs.length - 1, ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bs[mid].d <= d) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

/** 训练页图例：OHLC（无日期，双盲）+ 各开启指标的当前值（十字光标跟随） */
function updateTrainLegend(param) {
  const el = $('train-legend');
  if (!lastAgg.length || !S || idx < 0) { el.textContent = ''; return; }
  const T = window.BzTheme.colors();
  const bars = lastAgg;
  let k = bars.length - 1;
  if (param && param.time) {
    const i = bars.findIndex((b) => tsOf(b.d) === param.time);
    if (i >= 0) k = i;
  }
  const b = bars[k];
  const chg = k > 0 ? (b.c / bars[k - 1].c - 1) * 100 : 0;
  const closes = bars.map((x) => x.c);
  const fmtVol = (v) => v >= 1e8 ? (v / 1e8).toFixed(2) + '亿' : v >= 1e4 ? (v / 1e4).toFixed(2) + '万' : String(Math.round(v));
  const sec = (txt, color) => txt ? `<span style="color:${color};margin-left:12px">${txt}</span>` : '';
  const xv = {};                       // 小面板十字光标定位值
  xv.vol = b.v;
  let html =
    `开${b.o.toFixed(2)} 高${b.h.toFixed(2)} 低${b.l.toFixed(2)} 收${b.c.toFixed(2)} ` +
    `<span style="color:${chg >= 0 ? T.up : T.down}">${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%</span>`;
  if (maSel.length) {
    const on = maOn();
    html += sec(MA_DEFS.filter((m) => on.has(m.p)).map((m) => {
      const v = window.Ind.sma(closes, m.p)[k];
      return v == null ? '' : `MA${m.p} <b>${v.toFixed(1)}</b>`;
    }).filter(Boolean).join(' '), T.dim);
  }
  if (tToggles.vol) html += sec(`VOL <b>${fmtVol(b.v)}</b>`, b.c >= b.o ? T.up : T.down);
  if (tToggles.macd) {
    const mc = window.Ind.macd(closes);
    const d = mc.dif[k], e = mc.dea[k], h = mc.hist[k];
    xv.dif = d;
    if (d != null && e != null) {
      html += sec(`MACD <b style="color:${T.up}">${d.toFixed(2)}</b> ` +
        `<b style="color:${T.blue}">${e.toFixed(2)}</b> ` +
        `<b style="color:${h >= 0 ? T.up : T.down}">${h.toFixed(2)}</b>`, T.dim);
    }
  }
  if (tToggles.kdj) {
    const kj = window.Ind.kdj(bars);
    xv.k = kj.k[k];
    html += sec(`K <b style="color:#f0b90b">${kj.k[k].toFixed(1)}</b> ` +
      `D <b style="color:${T.blue}">${kj.d[k].toFixed(1)}</b> ` +
      `J <b style="color:#c77dff">${kj.j[k].toFixed(1)}</b>`, T.dim);
  }
  if (tToggles.boll) {
    const bo = window.Ind.boll(closes);
    xv.bollMid = bo.mid[k];
    if (bo.mid[k] != null) {
      html += sec(`BOLL <b style="color:#f0b90b">${bo.mid[k].toFixed(2)}</b> ` +
        `<b style="color:${T.dim}">${bo.up[k].toFixed(2)}</b> ` +
        `<b style="color:${T.dim}">${bo.low[k].toFixed(2)}</b>`, T.dim);
    }
  }
  el.innerHTML = html;
  // 主面板十字光标 → 各小面板
  const tk = tsOf(b.d);
  const setX = (c, series, v) => {
    if (!c || !series) return;
    if (param && param.time != null && v != null) c.setCrosshairPosition(v, tk, series);
    else c.clearCrosshairPosition();
  };
  setX(bollChart, bollBar, xv.bollMid != null ? b.c : null);
  setX(volChart, volS, tToggles.vol ? xv.vol : null);
  setX(macdChart, macdS.dif, xv.dif);
  setX(kdjChart, kdjS.k, xv.k);
}

function refillTrainIndicators(bars) {
  const closes = bars.map((b) => b.c);
  const line = (arr) => arr.map((v, i) => (v == null ? null : { time: tsOf(bars[i].d), value: v })).filter(Boolean);

  const on = maOn();
  for (const m of MA_DEFS) {
    maS[m.p].setData(on.has(m.p) ? line(window.Ind.sma(closes, m.p)) : []);
  }
  if (tToggles.boll) {
    const bo = window.Ind.boll(closes);
    bollBar.setData(bars.map((b) => ({ time: tsOf(b.d), open: b.o, high: b.h, low: b.l, close: b.c })));
    bollS.mid.setData(line(bo.mid));
    bollS.up.setData(line(bo.up));
    bollS.low.setData(line(bo.low));
  } else {
    bollBar.setData([]);
    bollS.mid.setData([]); bollS.up.setData([]); bollS.low.setData([]);
  }
  if (tToggles.macd) {
    const T = window.BzTheme.colors();
    const mc = window.Ind.macd(closes);
    macdS.hist.setData(mc.hist.map((v, i) => ({
      time: tsOf(bars[i].d), value: v, color: v >= 0 ? T.macdUp : T.macdDown,
    })));
    macdS.dif.setData(mc.dif.map((v, i) => ({ time: tsOf(bars[i].d), value: v })));
    macdS.dea.setData(mc.dea.map((v, i) => ({ time: tsOf(bars[i].d), value: v })));
  } else {
    macdS.hist.setData([]); macdS.dif.setData([]); macdS.dea.setData([]);
  }
  if (tToggles.kdj) {
    const kj = window.Ind.kdj(bars);
    kdjS.k.setData(kj.k.map((v, i) => ({ time: tsOf(bars[i].d), value: v })));
    kdjS.d.setData(kj.d.map((v, i) => ({ time: tsOf(bars[i].d), value: v })));
    kdjS.j.setData(kj.j.map((v, i) => ({ time: tsOf(bars[i].d), value: v })));
  } else {
    kdjS.k.setData([]); kdjS.d.setData([]); kdjS.j.setData([]);
  }
}

/** 训练图全量渲染：已揭示日bar → 聚合周期 → 蜡烛/量/指标/缠论/画线/买卖标记。
 * 数据量 ≤ 500 根，逐根推进时整体重灌（保留可见区间）。
 * refit=true 时重新铺满视图（开局 / 切周期——否则沿用旧周期的可视区间会把
 * 新周期的少量 bar 挤在左侧，右侧大片空白点击无 bar 可吸附）。 */
function renderTrainChart(refit = false) {
  if (!chart || !S || idx < 0) return;
  const T = window.BzTheme.colors();
  const daily = [];
  for (let i = 0; i <= idx; i++) {
    const b = S.bars[i];
    daily.push({ d: fakeDate(i), o: b.o, h: b.h, l: b.l, c: b.c, v: b.v });
  }
  const bars = window.Ind.aggregate(daily, trainPeriod);
  lastAgg = bars;

  const vr = refit ? null : chart.timeScale().getVisibleLogicalRange();
  candle.setData(bars.map((b) => ({ time: tsOf(b.d), open: b.o, high: b.h, low: b.l, close: b.c })));
  volS.setData(tToggles.vol ? bars.map((b) => ({
    time: tsOf(b.d), value: b.v,
    color: b.c >= b.o ? T.volUp : T.volDown,
  })) : []);
  refillTrainIndicators(bars);
  overlay.setBars(bars);
  overlay.setChan(window.Ind.chanView(bars, tToggles));

  // 买卖标记吸附到所属周期 bar
  const mk = markers.map((m) => {
    const i = Math.round((m.time - FAKE_T0) / 86400);
    const k = aggIndexOf(fakeDate(i));
    return { ...m, time: tsOf(bars[k].d) };
  }).sort((a, b) => a.time - b.time);
  candle.setMarkers(mk);

  if (vr) chart.timeScale().setVisibleLogicalRange(vr);
  else chart.timeScale().fitContent();
  trainChip && trainChip.setBars(bars);
  updateTrainLegend(null);
}

/** MA 周期勾选浮层（训练页） */
function buildTrainMaMenu() {
  const menu = $('train-ma-menu');
  const btn = $('train-ma-btn');
  if (!menu || !btn) return;
  menu.textContent = '';
  for (const m of MA_DEFS) {
    const lab = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.dataset.ma = String(m.p);
    cb.checked = maSel.includes(m.p);
    cb.onchange = () => {
      maSel = cb.checked
        ? [...new Set([...maSel, m.p])].sort((a, b) => a - b)
        : maSel.filter((p) => p !== m.p);
      tToggles.maSel = maSel;
      applyTrainToggles();
    };
    const dot = document.createElement('i');
    dot.style.background = m.color;
    lab.append(cb, dot, document.createTextNode(`MA${m.p}`));
    menu.appendChild(lab);
  }
  btn.onclick = (e) => { e.stopPropagation(); menu.classList.toggle('hidden'); };
  document.addEventListener('click', (e) => {
    if (!menu.classList.contains('hidden') && !menu.contains(e.target) && e.target !== btn) {
      menu.classList.add('hidden');
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') menu.classList.add('hidden');
  });
}

function applyTrainToggles(skipRender = false) {
  const on = maOn();
  for (const m of MA_DEFS) maS[m.p].applyOptions({ visible: on.has(m.p) });
  const maBtn = $('train-ma-btn');
  if (maBtn) maBtn.classList.toggle('on', on.size > 0);
  const menu = $('train-ma-menu');
  if (menu) menu.querySelectorAll('input[data-ma]').forEach((cb) => { cb.checked = on.has(Number(cb.dataset.ma)); });
  // 各指标独立小面板：显隐即面板显隐
  const visPane = (id, on) => { const el = $(id); if (el) el.classList.toggle('hidden', !on); };
  visPane('train-pane-boll', tToggles.boll);
  visPane('train-pane-vol', tToggles.vol);
  visPane('train-pane-macd', tToggles.macd);
  visPane('train-pane-kdj', tToggles.kdj);
  refreshTrainAxisOwner();
  trainChip && trainChip.setVisible(!!tToggles.chip);
  document.querySelectorAll('[data-tt]').forEach((b) => {
    b.classList.toggle('on', !!tToggles[b.dataset.tt]);
  });
  localStorage.setItem('bz_train_toggles', JSON.stringify(tToggles));
  if (!skipRender) renderTrainChart();
}

/* ---------------- 回放 ---------------- */
function advance() {
  if (!S || finished) return;
  if (idx >= S.total - 1) return;
  idx++;
  pos.free += pos.frozen;  // 新交易日：解冻 T+1
  pos.frozen = 0;
  settlePending();         // next_open 挂单按本根开盘价结算
  renderTrainChart();
  equityCurve.push({ i: idx, equity: markEquity() });
  updateHUD();
  if (idx >= S.total - 1) {
    stopPlay();
    $('btn-next').disabled = true;
    toast('已到最后一根，按 F 结算');
  }
}

function startPlay() {
  if (playing || finished) return;
  if (idx >= S.total - 1) return;
  playing = setInterval(() => {
    advance();
    if (idx >= S.total - 1) stopPlay();
  }, Number($('speed').value));
  $('btn-play').textContent = '暂停 ⏸';
}

function stopPlay() {
  clearInterval(playing);
  playing = null;
  $('btn-play').textContent = '自动 ▶';
}

/* ---------------- HUD ---------------- */
function markEquity() {
  return cash + pos.shares * S.bars[idx].c;
}

function updateHUD() {
  const b = S.bars[idx];
  const eq = markEquity();
  const pnl = pos.shares * (b.c - (pos.shares ? pos.costBasis / pos.shares : 0));
  $('h-equity').textContent = fmtMoney(eq);
  $('h-cash').textContent = fmtMoney(cash);
  $('h-pos').textContent = pos.shares
    ? `${pos.shares} 股${pos.frozen ? `（冻${pos.frozen}）` : ''} @ ${(pos.costBasis / pos.shares).toFixed(2)}`
    : '空仓';
  const pnlEl = $('h-pnl');
  pnlEl.textContent = pos.shares ? `${pnl >= 0 ? '+' : ''}${pnl.toFixed(0)}` : '--';
  pnlEl.className = pnl > 0 ? 'up' : pnl < 0 ? 'down' : '';
  const prev = idx > 0 ? S.bars[idx - 1].c : null;
  const chgEl = $('h-chg');
  if (prev != null) {
    const chg = b.c / prev - 1;
    chgEl.textContent = fmtPct(chg);
    chgEl.className = chg > 0 ? 'up' : chg < 0 ? 'down' : '';
  } else {
    chgEl.textContent = '--';
  }
  $('h-limit-wrap').style.display = b.up != null ? '' : 'none';
  if (b.up != null) { $('h-up').textContent = b.up.toFixed(2); $('h-down').textContent = b.down.toFixed(2); }
  $('h-pending-wrap').classList.toggle('hidden', !pendingOrders.length);
  if (pendingOrders.length) {
    $('h-pending').textContent = pendingOrders
      .map((o) => `${o.side === 'buy' ? '买' : '卖'}${o.shares}`).join(' ');
  }
  const played = Math.max(0, idx - S.history + 1);
  $('prog-now').textContent = played > 0 ? played : '—';
  $('prog-total').textContent = S.forward;
}

/* ---------------- 会话 ---------------- */
async function newSession(category, params) {
  toast('抽取标的中…');
  const data = await api('/api/new', { category, params });
  S = data;
  idx = S.history - 1;
  cash = S.config.capital;
  pos = { shares: 0, free: 0, frozen: 0, costBasis: 0 };
  trades = []; markers = []; equityCurve = []; roundPnl = 0; roundTrips = [];
  pendingOrders = [];
  revealInfo = null;                       // 上一局的揭晓图不带入新局（切主题会按 bars×dates 重画）
  if (revealChart) { revealChart.remove(); revealChart = null; }
  equityCurve.push({ i: idx, equity: cash });
  startedAt = Date.now();
  finished = false;
  stopPlay();
  overlay && overlay.setMode('none');
  $('btn-next').disabled = false;
  $('cat-badge').textContent = CAT_NAMES[S.category] || S.category;
  showScreen('train');        // 先切屏让容器有真实尺寸，再建图
  buildTrainChart();
  renderTrainChart(true);
  updateHUD();
  toast(`${CAT_NAMES[S.category]} · 双盲回放开始（前 ${S.history} 根为可见历史，${fillMode() === 'next_open' ? '次日开盘' : '当根收盘'}成交）`, true);
}

function showScreen(name) {
  for (const s of ['start', 'train', 'result']) $('screen-' + s).classList.add('hidden');
  $('screen-' + name).classList.remove('hidden');
  window.scrollTo(0, 0);
}

/* ---------------- 买卖弹窗 ---------------- */
function openModal(mode) {
  if (!S || finished) return;
  if (idx < S.history) return toast('先推进到训练阶段再交易');
  if (fillMode() === 'next_open' && idx >= S.total - 1) {
    return toast('已到最后一根，次日无开盘价，无法挂单');
  }
  modalMode = mode;
  const b = S.bars[idx];
  $('modal-title').textContent = mode === 'buy' ? '买入' : '卖出';
  const r = lotRule();
  const blocked = mode === 'buy' ? atLimitUp(b) : atLimitDown(b);
  const closeMode = fillMode() === 'close';
  $('modal-info').innerHTML = `
    <span>现价 <b>${b.c.toFixed(2)}</b>${b.up != null ? `　涨停 <b>${b.up.toFixed(2)}</b>　跌停 <b>${b.down.toFixed(2)}</b>` : ''}</span>
    <span>${mode === 'buy' ? `可用现金 <b>${fmtMoney(cash)}</b> 元` : `可卖 <b>${pos.free}</b> 股（冻结 ${pos.frozen}）`}</span>
    <span>数量规则：${r.label}${mode === 'sell' ? '；清仓可一次性卖出零股' : ''}</span>
    <span>成交：<b>${closeMode ? '当根收盘价' : `次日开盘价（挂单，当前收盘 ${b.c.toFixed(2)} 仅为估算）`}</b></span>
    ${closeMode && blocked ? `<span style="color:var(--up)">${mode === 'buy' ? '当前收盘涨停，下单将被拒绝' : '当前收盘跌停，下单将被拒绝'}</span>` : ''}`;
  const pctBox = $('pct-btns');
  pctBox.innerHTML = '';
  const fracs = mode === 'buy' ? [0.25, 0.5, 0.75, 1] : [0.25, 0.5, 1];
  for (const f of fracs) {
    const btn = document.createElement('button');
    btn.textContent = mode === 'buy' ? `${f * 100}%仓` : `卖${f === 1 ? '全部' : f * 100 + '%'}`;
    btn.onclick = () => {
      let n;
      if (mode === 'buy') {
        const rr = lotRule();
        n = Math.floor(maxBuyShares(b.c) * f);
        if (rr.step !== 1) n = Math.floor(n / rr.step) * rr.step;
        if (n < rr.min) n = 0;
      } else {
        n = f === 1 ? pos.shares : Math.floor(pos.free * f);
        if (f !== 1 && !lotOk(n)) n = Math.floor(n / 100) * 100;
      }
      $('modal-shares').value = Math.max(0, n);
      updateEst();
    };
    pctBox.appendChild(btn);
  }
  if (mode === 'buy') {
    const rr = lotRule();
    const m = maxBuyShares(b.c);
    $('modal-shares').value = rr.step === 1 ? m : Math.floor(m / rr.step) * rr.step;
  } else {
    $('modal-shares').value = pos.free;
  }
  updateEst();
  $('modal').classList.remove('hidden');
  setTimeout(() => $('modal-shares').select(), 30);
}

function updateEst() {
  const n = Math.floor(Number($('modal-shares').value) || 0);
  const b = S.bars[idx];
  const est = $('modal-est');
  if (n <= 0) { est.textContent = ''; return; }
  const amount = n * b.c;
  if (modalMode === 'buy') {
    const fee = buyFee(amount);
    est.innerHTML = `预估金额 <b>${fmtMoney(amount)}</b> + 费用 <b>${fee.toFixed(2)}</b> = <b>${fmtMoney(amount + fee)}</b> 元` +
      (fillMode() === 'next_open' ? `<br>次日按开盘价成交，金额以开盘价为准` : '');
  } else {
    const fee = sellFee(amount);
    const avg = pos.shares ? pos.costBasis / pos.shares : 0;
    const realized = amount - fee - n * avg;
    est.innerHTML = `预估金额 <b>${fmtMoney(amount)}</b> − 费用 <b>${fee.toFixed(2)}</b>，盈亏 <b style="color:${realized >= 0 ? 'var(--up)' : 'var(--down)'}">${realized.toFixed(2)}</b> 元` +
      (fillMode() === 'next_open' ? `<br>次日按开盘价成交，金额以开盘价为准` : '');
  }
}

function closeModal() {
  $('modal').classList.add('hidden');
  modalMode = null;
}

/* ---------------- 结算 ---------------- */
function finish(endedBy) {
  if (!S || finished) return;
  finished = true;
  stopPlay();
  closeModal();
  if (pendingOrders.length) {
    toast(`已撤销 ${pendingOrders.length} 笔未成交挂单`);
    pendingOrders = [];
  }
  const lastClose = S.bars[idx].c;
  const finalEquity = markEquity();
  const capital = S.config.capital;
  const returnPct = finalEquity / capital - 1;
  const base = S.bars[S.history - 1].c;                    // 训练起点前收盘
  const benchmarkPct = lastClose / base - 1;               // 同期持有不动
  let peak = -Infinity, maxDD = 0;
  for (const p of equityCurve) {
    if (p.equity > peak) peak = p.equity;
    maxDD = Math.max(maxDD, 1 - p.equity / peak);
  }
  const wins = roundTrips.filter((x) => x > 0).length;
  const result = {
    category: S.category,
    capital,
    final_equity: Math.round(finalEquity * 100) / 100,
    return_pct: Math.round(returnPct * 10000) / 10000,
    benchmark_pct: Math.round(benchmarkPct * 10000) / 10000,
    max_drawdown: Math.round(maxDD * 10000) / 10000,
    trades: trades.length,
    wins,
    losses: roundTrips.length - wins,
    bars_played: idx - S.history + 1,
    duration_sec: Math.round((Date.now() - startedAt) / 1000),
    ended_by: endedBy,
    fill_mode: fillMode(),
  };

  renderResult(result, finalEquity);
  showScreen('result');
  // 复盘包：bars/交易/权益曲线随结算一次落盘（服务端补揭晓身份+真实日期）
  const replay = {
    bars: S.bars.map((b) => [b.o, b.h, b.l, b.c, b.v]),
    history: S.history, forward: S.forward,
    trades, markers,
    equity_curve: equityCurve.map((p) => [p.i, Math.round(p.equity * 100) / 100]),
    params: {
      capital: S.config.capital, fill_mode: fillMode(),
      commission_rate: S.config.commission_rate, commission_min: S.config.commission_min,
      stamp_rate: S.config.stamp_rate, transfer_rate: S.config.transfer_rate,
    },
  };
  api('/api/finish', { sid: S.sid, result, replay }).catch(() => {});
}

function renderResult(r, finalEquity) {
  const beat = r.return_pct - r.benchmark_pct;
  const cls = (x) => (x > 0 ? 'v up' : x < 0 ? 'v down' : 'v');
  $('result-stats').innerHTML = `
    <div class="rstat big"><span class="k">总收益</span><span class="${cls(r.return_pct)}">${fmtPct(r.return_pct)}</span></div>
    <div class="rstat"><span class="k">期末权益</span><span class="v">${fmtMoney(finalEquity)} 元</span></div>
    <div class="rstat"><span class="k">持有不动基准</span><span class="${cls(r.benchmark_pct)}">${fmtPct(r.benchmark_pct)}</span></div>
    <div class="rstat"><span class="k">超额收益</span><span class="${cls(beat)}">${fmtPct(beat)}</span></div>
    <div class="rstat"><span class="k">最大回撤</span><span class="v down">${(r.max_drawdown * 100).toFixed(2)}%</span></div>
    <div class="rstat"><span class="k">交易次数</span><span class="v">${r.trades}（回合胜 ${r.wins} / 负 ${r.losses}）</span></div>
    <div class="rstat"><span class="k">成交模式</span><span class="v">${r.fill_mode === 'open' ? '次日开盘' : '当根收盘'}</span></div>
    <div class="rstat"><span class="k">推进根数</span><span class="v">${r.bars_played} / ${S.forward}</span></div>
    <div class="rstat"><span class="k">用时</span><span class="v">${r.duration_sec} 秒</span></div>`;

  let rows = '<tr><th>#</th><th>方向</th><th>股数</th><th>价格</th><th>金额</th><th>费用</th><th>盈亏</th></tr>';
  trades.forEach((t, k) => {
    rows += `<tr>
      <td>${k + 1}（第${t.i - S.history + 1}根）</td>
      <td class="side-${t.side}">${t.side === 'buy' ? '买入' : '卖出'}</td>
      <td>${t.shares}</td><td>${t.price.toFixed(2)}${t.fill === 'open' ? '<span style="color:var(--dim)"> 开</span>' : ''}</td>
      <td>${fmtMoney(t.amount)}</td><td>${t.fee.toFixed(2)}</td>
      <td>${t.realized != null ? `<span style="color:${t.realized >= 0 ? 'var(--up)' : 'var(--down)'}">${t.realized.toFixed(2)}</span>` : ''}</td>
    </tr>`;
  });
  if (!trades.length) rows += '<tr><td colspan="7" style="text-align:center;color:var(--dim)">本局没有交易</td></tr>';
  $('trades-table').innerHTML = rows;

  $('reveal-block').classList.add('hidden');
  $('btn-reveal').classList.remove('hidden');
  $('btn-reveal').disabled = false;
}

async function reveal() {
  if (!S) return;
  $('btn-reveal').disabled = true;
  try {
    revealInfo = await api('/api/reveal', { sid: S.sid });
  } catch (e) {
    toast('揭晓失败：' + e.message);
    $('btn-reveal').disabled = false;
    return;
  }
  renderRevealIdentity();
  renderRevealChart();
  toast('答案已揭晓', true);
}

function renderRevealIdentity() {
  if (!revealInfo) return;
  const info = revealInfo;
  const boardName = { main: '主板', chinext: '创业板', star: '科创板', etf: 'ETF', index: '指数' }[info.board] || info.board;
  $('identity').innerHTML = `
    <span class="name">${info.name}</span>
    <span class="code">${info.code} · ${boardName} · ${CAT_NAMES[info.category] || info.category}</span>
    <span class="range">${info.start_date} ~ ${info.end_date}</span>`;
  $('reveal-block').classList.remove('hidden');
}

function renderRevealChart() {
  if (!revealInfo) return;
  const info = revealInfo;
  const T = window.BzTheme.colors();
  if (revealChart) { revealChart.remove(); revealChart = null; }
  revealChart = LightweightCharts.createChart($('reveal-chart'), {
    layout: { background: { color: T.panel }, textColor: T.dim, fontSize: 12 },
    grid: { vertLines: { color: T.grid }, horzLines: { color: T.grid } },
    rightPriceScale: { borderColor: T.line },
    timeScale: { borderColor: T.line, timeVisible: false },
    autoSize: true,
  });
  const rc = revealChart.addCandlestickSeries({
    upColor: UP, downColor: DOWN, borderUpColor: UP, borderDownColor: DOWN,
    wickUpColor: UP, wickDownColor: DOWN,
  });
  rc.setData(S.bars.map((b, i) => ({
    time: info.dates[i], open: b.o, high: b.h, low: b.l, close: b.c,
  })));
  rc.createPriceLine({ price: S.bars[S.history - 1].c, color: '#f0b90b', lineWidth: 1, lineStyle: 2, title: '训练起点' });
  rc.setMarkers(markers.map((m) => ({
    ...m,
    time: info.dates[Math.round((m.time - FAKE_T0) / 86400)],
  })));
  revealChart.timeScale().fitContent();
}

/* ---------------- 开始页 ---------------- */
function collectParams() {
  const fill = (document.querySelector('input[name="p-fill"]:checked') || {}).value || 'close';
  return {
    capital: Number($('p-capital').value) || 100000,
    history: (() => { const raw = $('p-history').value; const v = Number(raw); return raw === '' || !Number.isFinite(v) ? 120 : Math.max(0, Math.floor(v)); })(),   // 0=全部（训练前所有 bars）
    forward: Number($('p-forward').value) || 120,
    year_from: Number($('p-year-from').value) || 2016,
    year_to: Number($('p-year-to').value) || 2025,
    min_list_years: Number($('p-list-years').value) || 0,
    exclude_st: $('p-exclude-st').checked,
    date_from: $('p-date-from').value || null,
    date_to: $('p-date-to').value || null,
    fill_mode: fill,
    commission_rate: (Number($('p-comm').value) || 0) / 10000,
    commission_min: Number($('p-comm-min').value) || 0,
    stamp_rate: (Number($('p-stamp').value) || 0) / 10000,
    transfer_rate: (Number($('p-transfer').value) || 0) / 10000,
    index_key: ($('p-index').value || '') || null,
    codes: lastCategory === 'custom' ? [...selectedCodes.keys()] : null,
  };
}

function curCategory() {
  const card = document.querySelector('.card.selected');
  return card ? card.dataset.cat : 'stock';
}

function updateRulesTip() {
  const fill = (document.querySelector('input[name="p-fill"]:checked') || {}).value || 'close';
  const comm = Number($('p-comm').value) || 0;
  const commMin = Number($('p-comm-min').value) || 0;
  const stamp = Number($('p-stamp').value) || 0;
  $('rules-tip').textContent =
    `规则：T+1 · 涨跌停拒单 · 佣金万${comm}${commMin ? `(最低${commMin}元)` : '(免最低)'} · 印花税卖出万${stamp}（仅个股） · ` +
    (fill === 'close' ? '以当根收盘价撮合' : '挂单次日开盘价撮合（一字板废单）');
}

async function loadStats() {
  try {
    const st = await api('/api/stats');
    const el = $('stats-bar');
    if (!st.games) {
      el.innerHTML = '还没有战绩，开始第一局吧 🧨';
      return;
    }
    el.innerHTML = `累计 <b>${st.games}</b> 局 · 胜率 <b>${(st.win_rate * 100).toFixed(0)}%</b>` +
      ` · 平均收益 <b style="color:${st.avg_return >= 0 ? 'var(--up)' : 'var(--down)'}">${fmtPct(st.avg_return)}</b>` +
      ` · 最好 <b style="color:var(--up)">${fmtPct(st.best)}</b> / 最差 <b style="color:var(--down)">${fmtPct(st.worst)}</b>`;
  } catch { $('stats-bar').textContent = ' '; }
}

/* ---- 复盘历史 / 复盘视图 ---- */
let replayViewChart = null;

async function openHistory() {
  $('hist-modal').classList.remove('hidden');
  $('hist-body').textContent = '加载中…';
  let rows;
  try { rows = (await api('/api/results')).rows || []; }
  catch (e) { $('hist-body').textContent = '加载失败：' + e.message; return; }
  if (!rows.length) { $('hist-body').textContent = '还没有对局记录'; return; }
  let html = '<table><tr><th>时间</th><th>品类</th><th>标的</th><th>收益</th><th>回合</th><th>操作</th></tr>';
  rows.forEach((r) => {
    const ret = r.return_pct != null ? r.return_pct : 0;
    const retCls = ret > 0 ? 'var(--up)' : ret < 0 ? 'var(--down)' : 'var(--dim)';
    const name = r.name ? `${r.name}` : '—';
    html += `<tr data-ts="${r.ts}">
      <td>${(r.ts || '').slice(5, 16)}</td>
      <td>${CAT_NAMES[r.category] || r.category || '?'}</td>
      <td>${name}${r.ended_by === 'manual' ? '<span style="color:var(--dim)" title="中途手动结算"> ⏹</span>' : ''}</td>
      <td style="color:${retCls}">${r.return_pct != null ? fmtPct(ret) : '—'}</td>
      <td>${r.wins || 0}胜${r.losses || 0}负</td>
      <td>${r.replay
        ? `<button class="mini" data-replay="${r.replay}">复盘</button>`
        : '<span style="color:var(--dim)">无</span>'}
         <button class="mini danger" data-del="${r.ts}">删</button></td></tr>`;
  });
  html += '</table>';
  $('hist-body').innerHTML = html;
  $('hist-body').querySelectorAll('[data-replay]').forEach((b) => {
    b.onclick = () => openReplay(b.dataset.replay);
  });
  $('hist-body').querySelectorAll('[data-del]').forEach((b) => {
    b.onclick = async () => {
      try {
        await api('/api/results/delete', { ts: b.dataset.del });
        toast('已删除', true);
        loadStats();
        openHistory();
      } catch (e) { toast('删除失败：' + e.message); }
    };
  });
}

async function openReplay(fn) {
  let d;
  try { d = await api('/api/replay?file=' + encodeURIComponent(fn)); }
  catch (e) { toast('复盘加载失败：' + e.message); return; }
  const T = window.BzTheme.colors();
  // 身份行
  const boardName = { main: '主板', chinext: '创业板', star: '科创板', etf: 'ETF', index: '指数' }[d.board] || d.board;
  $('replay-identity').innerHTML =
    `<b>${d.name}</b> <span style="color:var(--dim)">${d.code} · ${boardName} · ${CAT_NAMES[d.category] || d.category}` +
    ` · ${d.start_date} ~ ${d.end_date} · ${d.ts}</span>`;
  // 全窗口真实日期 K 线 + 买卖标记 + 起点线
  if (replayViewChart) { replayViewChart.remove(); replayViewChart = null; }
  replayViewChart = LightweightCharts.createChart($('replay-chart2'), {
    layout: { background: { color: T.panel }, textColor: T.dim, fontSize: 12 },
    grid: { vertLines: { color: T.grid }, horzLines: { color: T.grid } },
    rightPriceScale: { borderColor: T.line },
    timeScale: { borderColor: T.line, timeVisible: false },
    autoSize: true,
  });
  const rc = replayViewChart.addCandlestickSeries({
    upColor: UP, downColor: DOWN, borderUpColor: UP, borderDownColor: DOWN,
    wickUpColor: UP, wickDownColor: DOWN,
  });
  rc.setData(d.bars.map((b, i) => ({
    time: d.dates[i], open: b[0], high: b[1], low: b[2], close: b[3],
  })));
  rc.createPriceLine({ price: d.bars[d.history - 1][3], color: '#f0b90b', lineWidth: 1, lineStyle: 2, title: '训练起点' });
  // markers 存的是双盲伪时间轴：FAKE_T0 + i*86400 → 换算回真实日期
  rc.setMarkers((d.markers || []).map((m) => ({
    ...m, time: d.dates[Math.round((m.time - FAKE_T0) / 86400)],
  })));
  replayViewChart.timeScale().fitContent();
  // 汇总指标
  const r = d.result || {};
  const cls = (x) => `color:${x > 0 ? 'var(--up)' : x < 0 ? 'var(--down)' : 'var(--text)'}`;
  $('replay-summary').innerHTML = [
    `总收益 <b style="${cls(r.return_pct)}">${fmtPct(r.return_pct || 0)}</b>`,
    `持有不动 <b style="${cls(r.benchmark_pct)}">${fmtPct(r.benchmark_pct || 0)}</b>`,
    `最大回撤 <b>${((r.max_drawdown || 0) * 100).toFixed(2)}%</b>`,
    `回合 <b>${r.wins || 0}胜${r.losses || 0}负</b>`,
    `推进 <b>${r.bars_played || 0}/${d.forward}</b>根`,
    `成交 <b>${r.fill_mode === 'open' ? '次日开盘' : '当根收盘'}</b>`,
    `用时 <b>${r.duration_sec || 0}s</b>`,
    r.ended_by === 'manual' ? '<b style="color:var(--dim)">中途结算</b>' : '',
  ].filter(Boolean).join(' · ');
  // 交易明细
  let rows = '<table><tr><th>#</th><th>方向</th><th>股数</th><th>价格</th><th>费用</th><th>盈亏</th><th>日期</th></tr>';
  (d.trades || []).forEach((t, k) => {
    rows += `<tr><td>${k + 1}</td>
      <td class="side-${t.side}">${t.side === 'buy' ? '买入' : '卖出'}${t.fill === 'open' ? ' 开' : ''}</td>
      <td>${t.shares}</td><td>${t.price.toFixed(2)}</td><td>${t.fee.toFixed(2)}</td>
      <td>${t.realized != null ? `<span style="color:${t.realized >= 0 ? 'var(--up)' : 'var(--down)'}">${t.realized.toFixed(2)}</span>` : ''}</td>
      <td style="color:var(--dim)">${d.dates[t.i] || ''}</td></tr>`;
  });
  if (!(d.trades || []).length) rows += '<tr><td colspan="7" style="text-align:center;color:var(--dim)">本局没有交易</td></tr>';
  rows += '</table>';
  $('replay-trades').innerHTML = rows;
  $('replay-modal').classList.remove('hidden');
}

/* ---- 自选：搜索 / chips / 自选清单 ---- */
function loadWatchlist() {
  try { watchlist = JSON.parse(localStorage.getItem('bz_watchlist') || '[]'); } catch { watchlist = []; }
}
function saveWatchlist() {
  localStorage.setItem('bz_watchlist', JSON.stringify(watchlist));
}
function addToWatch(code, name) {
  if (!watchlist.some((w) => w.code === code)) {
    watchlist.unshift({ code, name });
    watchlist = watchlist.slice(0, 30);
    saveWatchlist();
    renderWatchlist();
  }
}
function selectCode(code, name) {
  if (selectedCodes.size >= 10 && !selectedCodes.has(code)) return toast('本局最多选 10 个');
  selectedCodes.set(code, name);
  renderChips();
  renderWatchlist();
}

function renderChips() {
  const box = $('sel-chips');
  box.innerHTML = '';
  if (!selectedCodes.size) {
    box.innerHTML = '<span class="empty">搜索点选或从下方自选加入</span>';
    return;
  }
  for (const [code, name] of selectedCodes) {
    const el = document.createElement('span');
    el.className = 'chip sel';
    el.innerHTML = `<span class="nm">${name}</span><span class="cd">${code}</span><span class="rm" title="移出本局">✕</span>`;
    el.querySelector('.rm').onclick = (e) => {
      e.stopPropagation();
      selectedCodes.delete(code);
      renderChips(); renderWatchlist();
    };
    el.onclick = () => { selectedCodes.delete(code); renderChips(); renderWatchlist(); };
    box.appendChild(el);
  }
}

function renderWatchlist() {
  const box = $('watch-list');
  box.innerHTML = '';
  if (!watchlist.length) {
    box.innerHTML = '<span class="empty">还没有自选，搜索后会自动记住</span>';
    return;
  }
  for (const w of watchlist) {
    const el = document.createElement('span');
    const sel = selectedCodes.has(w.code);
    el.className = 'chip' + (sel ? ' sel' : '');
    el.innerHTML = `<span class="nm">${w.name}</span><span class="cd">${w.code}</span>` +
      `<span class="add" title="${sel ? '点击移出本局' : '点击加入本局'}">${sel ? '✓' : '+'}</span>` +
      `<span class="rm" title="从自选删除">✕</span>`;
    el.onclick = () => {
      if (selectedCodes.has(w.code)) selectedCodes.delete(w.code);
      else selectCode(w.code, w.name);
    };
    el.querySelector('.rm').onclick = (e) => {
      e.stopPropagation();
      watchlist = watchlist.filter((x) => x.code !== w.code);
      saveWatchlist();
      selectedCodes.delete(w.code);
      renderWatchlist(); renderChips();
    };
    box.appendChild(el);
  }
}

let searchTimer = null;
function bindSearch() {
  $('p-search').oninput = () => {
    clearTimeout(searchTimer);
    const q = $('p-search').value.trim();
    if (!q) { $('search-drop').classList.add('hidden'); return; }
    searchTimer = setTimeout(async () => {
      try {
        const d = await api('/api/search?q=' + encodeURIComponent(q));
        renderSearchDrop(d.items || []);
      } catch { /* 忽略 */ }
    }, 250);
  };
}

function renderSearchDrop(items) {
  const box = $('search-drop');
  if (!items.length) {
    box.innerHTML = '<div class="search-item"><span class="cd">无匹配标的</span></div>';
    box.classList.remove('hidden');
    return;
  }
  box.innerHTML = '';
  for (const it of items) {
    const el = document.createElement('div');
    el.className = 'search-item';
    const inWatch = watchlist.some((w) => w.code === it.code);
    el.innerHTML = `<span>${it.name} <span class="cd">${it.code} · ${it.type === 'etf' ? 'ETF' : '个股'}</span></span>` +
      (inWatch ? '<span class="in-watch">已在自选</span>' : '');
    el.onclick = () => {
      addToWatch(it.code, it.name);
      selectCode(it.code, it.name);
      $('p-search').value = '';
      box.classList.add('hidden');
    };
    box.appendChild(el);
  }
  box.classList.remove('hidden');
}

async function loadIndexOptions() {
  try {
    const d = await api('/api/index/list');
    const sel = $('p-index');
    for (const it of d.instruments || []) {
      const o = document.createElement('option');
      o.value = it.key;
      o.textContent = `${it.name}（${it.group}）`;
      sel.appendChild(o);
    }
  } catch { /* 列表加载失败不影响随机 */ }
}

/* ---------------- 主题 ---------------- */
function initTheme() {
  const sel = $('theme-sel');
  for (const t of window.BzTheme.list()) {
    const o = document.createElement('option');
    o.value = t.key;
    o.textContent = t.label;
    sel.appendChild(o);
  }
  sel.value = window.BzTheme.get();
  sel.onchange = () => window.BzTheme.apply(sel.value);
  window.BzTheme.onChange(() => {
    if (chart && S && !$('app-train').classList.contains('hidden') &&
        !$('screen-train').classList.contains('hidden')) {
      rebuildTrainTheme();
    } else {
      trainThemeDirty = true;             // 看板页切的：回训练页签时补重建
    }
    if (revealChart && revealInfo) renderRevealChart();
  });
  // 从看板切回训练页签时，补上主题变更期间欠下的重建
  window.addEventListener('bz-tab-train', () => {
    if (trainThemeDirty && chart && S && !$('screen-train').classList.contains('hidden')) {
      trainThemeDirty = false;
      rebuildTrainTheme();
    }
  });
}

/** 主题重建训练图：画线/撤销栈快照恢复（训练画线本局有效不持久化，丢了无法找回） */
function rebuildTrainTheme() {
  const saved = overlay ? {
    lines: overlay.lines.slice(),
    undo: overlay.undoStack.slice(),
    redo: overlay.redoStack.slice(),
  } : null;
  buildTrainChart();
  if (overlay && saved) {
    overlay.lines = saved.lines;
    overlay.undoStack = saved.undo;
    overlay.redoStack = saved.redo;
    overlay.redraw();
  }
  renderTrainChart();
}

/* ---------------- 事件绑定 ---------------- */
function bind() {
  document.querySelectorAll('.card').forEach((c) => {
    c.onclick = () => {
      document.querySelectorAll('.card').forEach((x) => x.classList.remove('selected'));
      c.classList.add('selected');
      $('panel-index').classList.toggle('hidden', c.dataset.cat !== 'index');
      $('panel-custom').classList.toggle('hidden', c.dataset.cat !== 'custom');
    };
  });

  document.querySelectorAll('input[name="p-fill"]').forEach((r) => {
    r.onchange = updateRulesTip;
  });
  ['p-comm', 'p-comm-min', 'p-stamp'].forEach((id) => {
    $(id).oninput = updateRulesTip;
  });

  $('btn-start').onclick = async () => {
    lastCategory = curCategory();
    if (lastCategory === 'custom' && !selectedCodes.size) {
      return toast('自选模式：请先搜索并选择至少一个标的');
    }
    lastParams = collectParams();
    localStorage.setItem('bz_params', JSON.stringify({
      ...lastParams, category: lastCategory,
      codes: lastCategory === 'custom' ? [...selectedCodes.entries()].map(([c, n]) => ({ code: c, name: n })) : null,
    }));
    try {
      await newSession(lastCategory, lastParams);
    } catch (e) {
      toast('开局失败：' + e.message);
    }
  };

  $('btn-next').onclick = advance;
  $('btn-play').onclick = () => (playing ? stopPlay() : startPlay());
  $('btn-finish').onclick = () => finish('manual');
  $('btn-buy').onclick = () => openModal('buy');
  $('btn-sell').onclick = () => openModal('sell');

  // 训练图周期 / 指标 / 画线
  document.querySelectorAll('[data-tp]').forEach((b) => {
    b.classList.toggle('on', b.dataset.tp === trainPeriod);
    b.onclick = () => {
      trainPeriod = b.dataset.tp;
      localStorage.setItem('bz_train_period', trainPeriod);
      document.querySelectorAll('[data-tp]').forEach((x) => x.classList.toggle('on', x === b));
      renderTrainChart(true);   // 切周期重铺视图
    };
  });
  document.querySelectorAll('[data-tt]').forEach((b) => {
    b.onclick = () => { tToggles[b.dataset.tt] = !tToggles[b.dataset.tt]; applyTrainToggles(); };
  });
  buildTrainMaMenu();
  document.querySelectorAll('[data-tdraw]').forEach((b) => {
    b.onclick = () => {
      if (!overlay) return;
      overlay.setMode(overlay.mode === b.dataset.tdraw ? 'none' : b.dataset.tdraw);
    };
  });
  $('train-undo').onclick = () => { overlay && overlay.undo(); };
  $('train-redo').onclick = () => { overlay && overlay.redo(); };
  $('train-clear-draw').onclick = () => { overlay && overlay.clearAll(); };

  // 图表模板（周期+指标开关组合，localStorage）
  const TPL_KEY = 'bz_tpl_train';
  const tpls = () => { try { return JSON.parse(localStorage.getItem(TPL_KEY) || '{}'); } catch { return {}; } };
  const refreshTplSel = () => {
    const sel = $('train-tpl-sel');
    sel.textContent = '';                  // DOM 构建：模板名自由输入不拼 HTML
    for (const k of ['', ...Object.keys(tpls())]) {
      const o = document.createElement('option');
      o.value = k;
      o.textContent = k || '模板…';
      sel.appendChild(o);
    }
  };
  refreshTplSel();
  $('train-tpl-save').onclick = () => {
    window.bzPrompt('模板名称：', '', (name) => {
      name = name.slice(0, 40);
      if (!name) return;
      const m = tpls();
      m[name] = { period: trainPeriod, toggles: { ...tToggles } };
      localStorage.setItem(TPL_KEY, JSON.stringify(m));
      refreshTplSel();
      $('train-tpl-sel').value = name;
    });
  };
  $('train-tpl-del').onclick = () => {
    const name = $('train-tpl-sel').value;
    if (!name) return;
    const m = tpls();
    delete m[name];
    localStorage.setItem(TPL_KEY, JSON.stringify(m));
    refreshTplSel();
  };
  $('train-tpl-sel').onchange = () => {
    const t = tpls()[$('train-tpl-sel').value];
    if (!t) return;
    if (t.period) {
      trainPeriod = t.period;
      localStorage.setItem('bz_train_period', trainPeriod);
      document.querySelectorAll('[data-tp]').forEach((x) => x.classList.toggle('on', x.dataset.tp === trainPeriod));
    }
    Object.assign(tToggles, t.toggles || {});
    applyTrainToggles(true);      // skipRender：下面统一 refit 渲染
    renderTrainChart(true);
  };

  $('modal-cancel').onclick = closeModal;
  $('modal').onclick = (e) => { if (e.target === $('modal')) closeModal(); };
  $('modal-shares').oninput = updateEst;
  $('modal-ok').onclick = () => {
    const n = Math.floor(Number($('modal-shares').value) || 0);
    const mode = modalMode;
    closeModal();
    if (mode === 'buy') engineBuy(n);
    else if (mode === 'sell') engineSell(n);
  };

  $('btn-reveal').onclick = reveal;
  $('btn-again').onclick = async () => {
    try { await newSession(lastCategory, lastParams); }
    catch (e) { toast('开局失败：' + e.message); }
  };
  $('btn-home').onclick = () => { showScreen('start'); loadStats(); };

  // 复盘历史 / 复盘视图弹层
  $('btn-history').onclick = openHistory;
  $('hist-close').onclick = () => $('hist-modal').classList.add('hidden');
  $('hist-modal').onclick = (e) => { if (e.target === $('hist-modal')) $('hist-modal').classList.add('hidden'); };
  $('hist-clear').onclick = () => {
    window.bzPrompt('清空全部成绩与复盘不可恢复。输入「清空」确认：', '', (txt) => {
      if (txt !== '清空') return;
      api('/api/results/delete', { all: true })
        .then(() => { toast('已清空', true); loadStats(); $('hist-modal').classList.add('hidden'); })
        .catch((e) => toast('清空失败：' + e.message));
    });
  };
  $('replay-close').onclick = () => {
    $('replay-modal').classList.add('hidden');
    if (replayViewChart) { replayViewChart.remove(); replayViewChart = null; }
  };

  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') {
      if (e.key === 'Escape') e.target.blur();
      return;
    }
    if (!$('modal').classList.contains('hidden')) {
      if (e.key === 'Escape') closeModal();
      if (e.key === 'Enter') $('modal-ok').click();
      return;
    }
    // 双重守卫：在看板页签（app-train 隐藏）或训练模块的非对局屏（开始/结算）都不响应
    if ($('app-train').classList.contains('hidden') ||
        $('screen-train').classList.contains('hidden')) return;
    // Ctrl 组合键只走撤销/重做（训练热键单键触发，避免 Ctrl+B/S 误开交易弹窗）
    if (e.ctrlKey || e.metaKey) {
      if (e.code === 'KeyZ' && !e.shiftKey) { overlay && overlay.undo(); }
      else if (e.code === 'KeyY' || (e.code === 'KeyZ' && e.shiftKey)) { overlay && overlay.redo(); }
      return;
    }
    switch (e.code) {
      case 'Space': case 'ArrowRight': e.preventDefault(); advance(); break;
      case 'KeyB': openModal('buy'); break;
      case 'KeyS': openModal('sell'); break;
      case 'KeyF': finish('manual'); break;
      case 'KeyP': playing ? stopPlay() : startPlay(); break;
    }
  });

  // 点击空白处收起搜索下拉
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.custom-search')) $('search-drop').classList.add('hidden');
  });

  bindSearch();

  // 行情更新（baostock，后台执行）
  $('btn-mkt').onclick = async () => {
    const btn = $('btn-mkt');
    btn.disabled = true;
    try {
      const st = await api('/api/market/status');
      if (st.running) {
        toast('行情更新正在后台运行，稍后再看');
      } else {
        const r = await api('/api/market/update', {});
        toast(r.started ? '已在后台启动行情更新（约几分钟），完成自动生效' : '更新已在运行中', true);
      }
    } catch (e) {
      toast('更新失败：' + e.message);
    } finally {
      setTimeout(() => { btn.disabled = false; }, 1500);
    }
  };

  // 恢复上局参数
  try {
    const saved = JSON.parse(localStorage.getItem('bz_params') || 'null');
    if (saved) {
      $('p-capital').value = saved.capital ?? 100000;
      $('p-history').value = saved.history ?? 120;
      $('p-forward').value = saved.forward ?? 120;
      $('p-year-from').value = saved.year_from ?? 2016;
      $('p-year-to').value = saved.year_to ?? 2025;
      $('p-list-years').value = saved.min_list_years ?? 1;
      $('p-exclude-st').checked = saved.exclude_st !== false;
      if (saved.date_from) $('p-date-from').value = saved.date_from;
      if (saved.date_to) $('p-date-to').value = saved.date_to;
      $('p-comm').value = saved.commission_rate != null ? Math.round(saved.commission_rate * 10000 * 10) / 10 : 1;
      $('p-comm-min').value = saved.commission_min ?? 5;
      $('p-stamp').value = saved.stamp_rate != null ? Math.round(saved.stamp_rate * 10000 * 10) / 10 : 5;
      $('p-transfer').value = saved.transfer_rate != null ? Math.round(saved.transfer_rate * 10000 * 100) / 100 : 0.1;
      if (saved.fill_mode) {
        const r = document.querySelector(`input[name="p-fill"][value="${saved.fill_mode}"]`);
        if (r) r.checked = true;
      }
      if (saved.index_key) $('p-index').value = saved.index_key;
      if (saved.category) {
        document.querySelectorAll('.card').forEach((x) => x.classList.toggle('selected', x.dataset.cat === saved.category));
        $('panel-index').classList.toggle('hidden', saved.category !== 'index');
        $('panel-custom').classList.toggle('hidden', saved.category !== 'custom');
      }
      if (Array.isArray(saved.codes)) {
        for (const c of saved.codes) selectedCodes.set(c.code, c.name);
      }
    }
  } catch { /* 忽略坏数据 */ }

  loadWatchlist();
  renderChips();
  renderWatchlist();
  updateRulesTip();
}

bind();
loadStats();
loadIndexOptions();
initTheme();
