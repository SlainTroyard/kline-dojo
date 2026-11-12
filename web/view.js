/* 指数看板（K线道场）：选指 / 日周月年 / 指标开关 / 画线 / 缠论 / 增量刷新 */
'use strict';
window.createBoard = function createBoard(cfg) {
  const P = cfg.mode === 'market' ? 'mkt' : 'view';      // DOM id 前缀 / localStorage 命名空间
  const root = document.getElementById(P === 'mkt' ? 'screen-mkt' : 'screen-view');
  const $ = (suf) => document.getElementById(P + '-' + suf);
  const lsKey = (k) => 'bz_' + P + '_' + k;
  const UP = '#e0483e', DOWN = '#1fa06b';
  const MA_DEFS = [                       // 可选均线（勾选开关，默认 5/10/20/60）
    { p: 5, color: '#f0b90b' }, { p: 10, color: '#4a90e2' },
    { p: 13, color: '#22c1c3' }, { p: 20, color: '#c77dff' },
    { p: 21, color: '#ff6b9d' }, { p: 40, color: '#9ccc65' },
    { p: 60, color: '#ff8c42' }, { p: 120, color: '#8892a6' },
  ];
  const MA_DEFAULT = [5, 10, 20, 60];

  let inited = false;
  let chart = null, candle = null;
  let volChart = null, bollChart = null, macdChart = null, kdjChart = null;   // 独立小面板
  let maS = {}, bollS = {}, bollBar = null, macdS = {}, kdjS = {};
  let overlay = null;
  let chip = null;                        // 筹码峰（右侧价格分布直方图）
  let insts = [];
  let curKey = null, curName = '';
  let rawBars = [];                       // 全量日线（分钟模式下为分钟 bar）
  let period = localStorage.getItem(lsKey('period')) || 'D';
  const MINUTE_PERIODS = ['5m', '30m'];   // 分钟周期（仅行情板；数据源 astock，收盘后更新）
  let adjMode = localStorage.getItem(lsKey('adj')) || 'qfq';   // 行情板复权：qfq/none
  let asof = '';                          // 数据截止时刻（行情板标题展示）
  function loadToggles(key, defaults) {    // localStorage 坏值不炸整个看板模块
    try { return Object.assign(defaults, JSON.parse(localStorage.getItem(key) || '{}')); }
    catch { return defaults; }
  }
  const toggles = loadToggles(lsKey('toggles'),
    { maSel: null, boll: false, macd: true, kdj: false, vol: true, chip: false, chan: false, duan: false, bei: false });
  if (!Array.isArray(toggles.maSel)) {          // 旧版只有 ma:true/false
    toggles.maSel = toggles.ma === false ? [] : MA_DEFAULT.slice();
  }
  delete toggles.ma;
  const maOn = () => new Set(toggles.maSel);

  /* ---------------- 小地图：全历史缩略条（点击/拖动跳转可视区间） ---------------- */
  class Minimap {
    constructor() {
      this.cvs = document.getElementById(P + '-minimap');
      this.ctx = this.cvs.getContext('2d');
      this.bars = [];
      this.drag = false;
      this.cvs.addEventListener('mousedown', (e) => { this.drag = true; this._jump(e); e.preventDefault(); });
      window.addEventListener('mousemove', (e) => { if (this.drag) this._jump(e); });
      window.addEventListener('mouseup', () => { this.drag = false; });
    }
    attach(chart) { this.chart = chart; }
    setBars(bars) { this.bars = bars || []; this.redraw(); }
    /** 画布内的 x → bar 索引（对齐主图时间轴宽度，不含右侧价格轴） */
    _idxAt(ev) {
      const r = this.cvs.getBoundingClientRect();
      const tsW = (this.chart && this.chart.timeScale().width()) || r.width;
      const x = ev.clientX - r.left;
      const n = this.bars.length;
      return n ? Math.max(0, Math.min(n - 1, Math.round((x / tsW) * (n - 1)))) : -1;
    }
    _jump(ev) {
      const i = this._idxAt(ev);
      if (i < 0 || !this.chart) return;
      const vr = this.chart.timeScale().getVisibleLogicalRange();
      if (!vr) return;
      const w = vr.to - vr.from;
      this.chart.timeScale().setVisibleLogicalRange({ from: i - w / 2, to: i + w / 2 });
    }
    redraw() {
      const box = this.cvs.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const w = Math.round(box.width), h = Math.round(box.height);
      if (w <= 0 || h <= 0) return;
      if (this.cvs.width !== Math.round(w * dpr) || this.cvs.height !== Math.round(h * dpr)) {
        this.cvs.width = Math.round(w * dpr);
        this.cvs.height = Math.round(h * dpr);
      }
      const ctx = this.ctx;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const n = this.bars.length;
      if (!n || !this.chart) return;
      const T = window.BzTheme.colors();
      const tsW = this.chart.timeScale().width() || w;
      // 收盘价全历史折线（等比压缩）
      let lo = Infinity, hi = -Infinity;
      for (const b of this.bars) { if (b.c < lo) lo = b.c; if (b.c > hi) hi = b.c; }
      const span = (hi - lo) || 1;
      const X = (i) => (i / Math.max(1, n - 1)) * tsW;
      const Y = (p) => 2 + (1 - (p - lo) / span) * (h - 4);
      ctx.strokeStyle = T.dim;
      ctx.globalAlpha = 0.9;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const x = X(i), y = Y(this.bars[i].c);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
      // 当前可视窗口高亮
      const vr = this.chart.timeScale().getVisibleLogicalRange();
      if (vr) {
        const x0 = Math.max(0, (vr.from / Math.max(1, n - 1)) * tsW);
        const x1 = Math.min(tsW, (vr.to / Math.max(1, n - 1)) * tsW);
        ctx.fillStyle = T.accent;
        ctx.globalAlpha = 0.13;
        ctx.fillRect(x0, 0, x1 - x0, h);
        ctx.globalAlpha = 0.7;
        ctx.fillStyle = T.accent;
        ctx.fillRect(x0, 0, 1.5, h);
        ctx.fillRect(x1 - 1.5, 0, 1.5, h);
        ctx.globalAlpha = 1;
      }
    }
  }
  let minimap = null;

  /* ---------------- 联动副图：同标的异周期 / 另选标的对照 ---------------- */
  let syncOn = localStorage.getItem(lsKey('sync')) === '1';
  let subChart = null, subCandle = null, subMA = {};
  let subKey = '';                       // '' = 同主图
  let subPeriod = localStorage.getItem(lsKey('subperiod')) || 'W';
  let subRaw = [], subBars = [];         // 副图全量日线 / 当前周期聚合
  let syncingVR = false;                 // 可视范围同步防回环


  /* ---------------- 图表：主面板 + 指标小面板（各独立 chart，时间轴只在最底） ---------------- */
  const AXIS_W = 62;                       // 各面板右轴定宽 → 时间轴垂直对齐

  function mkPane(elId) {
    const T = window.BzTheme.colors();
    return LightweightCharts.createChart($(elId), {
      layout: { background: { color: T.panel }, textColor: T.dim, fontSize: 10 },
      grid: { vertLines: { color: T.grid }, horzLines: { color: T.grid } },
      rightPriceScale: {
        borderColor: T.line, minimumWidth: AXIS_W, maximumWidth: AXIS_W,
        scaleMargins: { top: 0.12, bottom: 0.08 },
      },
      timeScale: { borderColor: T.line, visible: false, rightOffset: 5 },
      crosshair: { mode: 0 },
      autoSize: true,
      handleScroll: false, handleScale: false,   // 小面板不响应交互，主面板单向同步
    });
  }

  function buildChart() {
    for (const c of [chart, volChart, bollChart, macdChart, kdjChart]) {
      if (c) { c.remove(); }
    }
    chart = bollChart = macdChart = kdjChart = volChart = null;
    const T = window.BzTheme.colors();
    // 主面板：K线 + MA + 画线（时间轴隐藏，由最底小面板显示）
    chart = LightweightCharts.createChart($('chart'), {
      layout: { background: { color: T.panel }, textColor: T.dim, fontSize: 12 },
      grid: { vertLines: { color: T.grid }, horzLines: { color: T.grid } },
      rightPriceScale: {
        borderColor: T.line, minimumWidth: AXIS_W, maximumWidth: AXIS_W,
        scaleMargins: { top: 0.05, bottom: 0.05 },
      },
      timeScale: { borderColor: T.line, visible: false, rightOffset: 5 },
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
    // 小面板：BOLL（竹线+三轨）/ VOL / MACD / KDJ
    bollChart = mkPane('bollchart');
    bollBar = bollChart.addBarSeries({
      upColor: UP, downColor: DOWN, thinBars: true,
      priceLineVisible: false, lastValueVisible: false,
    });
    bollS = {
      mid: bollChart.addLineSeries({ color: '#f0b90b', lineWidth: 1, lineStyle: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }),
      up: bollChart.addLineSeries({ color: '#8892a6', lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }),
      low: bollChart.addLineSeries({ color: '#8892a6', lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }),
    };
    volChart = mkPane('volchart');
    volS = volChart.addHistogramSeries({
      priceFormat: { type: 'volume' }, priceLineVisible: false, lastValueVisible: false,
    });
    macdChart = mkPane('macdchart');
    macdS = {
      hist: macdChart.addHistogramSeries({ priceLineVisible: false, lastValueVisible: false }),
      dif: macdChart.addLineSeries({ color: '#e0483e', lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }),
      dea: macdChart.addLineSeries({ color: '#4a90e2', lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }),
    };
    kdjChart = mkPane('kdjchart');
    kdjS = {
      k: kdjChart.addLineSeries({ color: '#f0b90b', lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }),
      d: kdjChart.addLineSeries({ color: '#4a90e2', lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }),
      j: kdjChart.addLineSeries({ color: '#c77dff', lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }),
    };

    overlay = new window.Overlay(chart, candle, $('pane-main'), {
      onModeChange: syncDrawBtns,
      onChange: saveLines,
    });
    // 筹码峰：跟随主面板 chart 重建（canvas 本身持久）
    if (!chip && window.ChipProfile) chip = new window.ChipProfile(document.getElementById(P + '-chip'));
    if (chip) chip.attach(chart, candle);
    if (!minimap) minimap = new Minimap();
    minimap.attach(chart);
    // 主面板 → 小面板：可视范围单向同步（小面板 handleScale 已关，无回环）
    chart.timeScale().subscribeVisibleLogicalRangeChange((r) => {
      minimap.redraw();
      syncSubRange();                     // 联动副图
      if (r && !syncingVR) {
        syncingVR = true;
        for (const c of [bollChart, volChart, macdChart, kdjChart]) {
          try { c.timeScale().setVisibleLogicalRange(r); } catch { /* 空数据面板 */ }
        }
        syncingVR = false;
      }
    });
    chart.subscribeClick((param) => {
      if (overlay.handleClick(param)) saveLines();
    });
    chart.subscribeCrosshairMove((param) => {
      updateLegend(param);                // 内含小面板十字光标同步
      crosshairToSub(param);
    });
    window.__bzView = { chart, overlay, minimap };   // 调试/自动化测试用

    applyToggles();
  }

  /** 时间轴只挂最底部的可见小面板（分钟周期显示时分） */
  function refreshAxisOwner() {
    const order = [
      [bollChart, toggles.boll], [volChart, toggles.vol],
      [macdChart, toggles.macd], [kdjChart, toggles.kdj],
    ];
    let owner = null;
    for (const [c, on] of order) if (on) owner = c;
    const minute = MINUTE_PERIODS.includes(period);
    for (const [c, on] of order) {
      c.timeScale().applyOptions({ visible: c === owner, timeVisible: minute, secondsVisible: false });
    }
  }

  /** 画线工具按钮高亮与 overlay.mode 同步（含画完线自动复位 none 的场景） */
  function syncDrawBtns() {
    root.querySelectorAll('[data-draw]').forEach((x) => {
      x.classList.toggle('on', x.dataset.draw === overlay.mode);
    });
  }

  /* ---------------- 数据渲染 ---------------- */
  /** 指标重灌：关闭的指标清空数据（visible:false 的 series 仍会参与主轴
   *  autoscale，年K 小样本的 BOLL 下轨可为负，不清会污染价格刻度）。 */
  function refillIndicators(bars) {
    const closes = bars.map((b) => b.c);
    const tOf = (i) => (bars[i].t != null ? bars[i].t : bars[i].d);
    const line = (arr) => arr.map((v, i) => (v == null ? null : { time: tOf(i), value: v })).filter(Boolean);

    const on = maOn();
    for (const m of MA_DEFS) {
      maS[m.p].setData(on.has(m.p) ? line(window.Ind.sma(closes, m.p)) : []);
    }
    if (toggles.boll) {
      const bo = window.Ind.boll(closes);
      bollBar.setData(bars.map((b) => ({ time: b.t != null ? b.t : b.d, open: b.o, high: b.h, low: b.l, close: b.c })));
      bollS.mid.setData(line(bo.mid));
      bollS.up.setData(line(bo.up));
      bollS.low.setData(line(bo.low));
    } else {
      bollBar.setData([]);
      bollS.mid.setData([]); bollS.up.setData([]); bollS.low.setData([]);
    }
    if (toggles.macd) {
      const T = window.BzTheme.colors();
      const mc = window.Ind.macd(closes);
      macdS.hist.setData(mc.hist.map((v, i) => ({
        time: tOf(i), value: v, color: v >= 0 ? T.macdUp : T.macdDown,
      })));
      macdS.dif.setData(mc.dif.map((v, i) => ({ time: tOf(i), value: v })));
      macdS.dea.setData(mc.dea.map((v, i) => ({ time: tOf(i), value: v })));
    } else {
      macdS.hist.setData([]); macdS.dif.setData([]); macdS.dea.setData([]);
    }
    if (toggles.kdj) {
      const kj = window.Ind.kdj(bars);
      kdjS.k.setData(kj.k.map((v, i) => ({ time: tOf(i), value: v })));
      kdjS.d.setData(kj.d.map((v, i) => ({ time: tOf(i), value: v })));
      kdjS.j.setData(kj.j.map((v, i) => ({ time: tOf(i), value: v })));
    } else {
      kdjS.k.setData([]); kdjS.d.setData([]); kdjS.j.setData([]);
    }
  }

  function renderAll() {
    if (!chart || !curKey) return;
    if (!rawBars.length) { $('title').textContent = `${curName}：无数据`; return; }
    const T = window.BzTheme.colors();
    const bars = curBars();
    const tOf = (b) => (b.t != null ? b.t : b.d);       // 分钟 bar 用 unix ts，日线用日期串
    candle.setData(bars.map((b) => ({ time: tOf(b), open: b.o, high: b.h, low: b.l, close: b.c })));
    volS.setData(toggles.vol ? bars.map((b) => ({
      time: tOf(b), value: b.v,
      color: b.c >= b.o ? T.volUp : T.volDown,
    })) : []);
    refreshAxisOwner();
    refillIndicators(bars);

    overlay.setBars(bars);
    overlay.setChan(window.Ind.chanView(bars, toggles));
    minimap && minimap.setBars(bars);

    // 默认显示最近 ~260 根（不足 260 根的周期从头铺满）
    chart.timeScale().setVisibleLogicalRange({
      from: Math.max(0, bars.length - 260),
      to: Math.min(bars.length + 5, bars.length + 8),
    });
    updateLegend(null);
    chip && chip.setBars(bars);
    const pn = { '5m': '5分', '30m': '30分', D: '日K', W: '周K', M: '月K', Y: '年K' }[period];
    const isMin = MINUTE_PERIODS.includes(period);
    const scope = isMin
      ? `${rawBars[0].d.slice(0, 10)} ~ ${rawBars[rawBars.length - 1].d.slice(0, 10)}`
      : `${rawBars[0].d} ~ ${rawBars[rawBars.length - 1].d}`;
    const cnt = isMin ? `分钟 ${rawBars.length} 根（限最近）` : `日线 ${rawBars.length} 根`;
    $('title').textContent =
      `${curName}（${scope}，${cnt} · ${pn} ${bars.length} 根` +
      (cfg.mode === 'market' && asof ? ` · 数据截至 ${asof.slice(0, 10)}${isMin ? ' ' + asof.slice(11, 16) : ''}` : '') + `）`;
  }

  /** 当前周期 bars：分钟=rawBars 原样（含 t），日线系=本地聚合 */
  function curBars() {
    return MINUTE_PERIODS.includes(period) ? rawBars : window.Ind.aggregate(rawBars, period);
  }

  function applyToggles() {
    const on = maOn();
    for (const m of MA_DEFS) maS[m.p].applyOptions({ visible: on.has(m.p) });
    const maBtn = $('ma-btn');
    if (maBtn) maBtn.classList.toggle('on', on.size > 0);
    const menu = $('ma-menu');
    if (menu) {
      menu.querySelectorAll('input[data-ma]').forEach((cb) => { cb.checked = on.has(Number(cb.dataset.ma)); });
    }
    // 各指标独立小面板：显隐即面板显隐，时间轴重新挂到最底可见面板
    const visPane = (id, on) => { const el = $(id); if (el) el.classList.toggle('hidden', !on); };
    visPane('pane-boll', toggles.boll);
    visPane('pane-vol', toggles.vol);
    visPane('pane-macd', toggles.macd);
    visPane('pane-kdj', toggles.kdj);
    refreshAxisOwner();
    chip && chip.setVisible(!!toggles.chip);
    // 关闭的指标清空数据（面板隐藏即可见性，清数据防内存与轴残留）
    if (rawBars.length) refillIndicators(curBars());
    root.querySelectorAll('[data-tg]').forEach((b) => {
      b.classList.toggle('on', !!toggles[b.dataset.tg]);
    });
    localStorage.setItem(lsKey('toggles'), JSON.stringify(toggles));
    if (overlay) {
      overlay.setChan(window.Ind.chanView(curBars(), toggles));
    }
  }

  /** 画线样式浮层：颜色/粗细/虚实；有选中线作用于选中，否则设为新线默认 */
  function buildDrawStyle() {
    const pop = $('draw-style-pop');
    const btn = $('draw-style');
    if (!pop || !btn) return;
    const COLORS = ['#f0b90b', '#e0483e', '#4a90e2', '#1fa06b', '#c77dff', '#e6ebf4'];
    pop.innerHTML =
      `<div class="ds-row"><span class="ds-lab">颜色</span><span class="ds-colors">` +
      COLORS.map((c) => `<button class="ds-c" data-color="${c}" style="background:${c}" title="${c}"></button>`).join('') +
      `</span></div>` +
      `<div class="ds-row"><span class="ds-lab">粗细</span>` +
      `<button class="ds-b" data-width="1">细</button>` +
      `<button class="ds-b" data-width="1.6">中</button>` +
      `<button class="ds-b" data-width="2.6">粗</button></div>` +
      `<div class="ds-row"><span class="ds-lab">线型</span>` +
      `<button class="ds-b" data-dash="0">实线</button>` +
      `<button class="ds-b" data-dash="1">虚线</button></div>` +
      `<div class="ds-row"><button class="ds-del" data-del="1">删除选中线</button></div>`;
    pop.onclick = (e) => {
      const t = e.target.closest('button');
      if (!t || !overlay) return;
      e.stopPropagation();
      if (t.dataset.color) overlay.setStyle({ color: t.dataset.color });
      else if (t.dataset.width) overlay.setStyle({ width: Number(t.dataset.width) });
      else if (t.dataset.dash) overlay.setStyle({ dash: t.dataset.dash === '1' });
      else if (t.dataset.del) overlay.deleteSelected();
    };
    btn.onclick = (e) => { e.stopPropagation(); pop.classList.toggle('hidden'); };
    document.addEventListener('click', (e) => {
      if (!pop.classList.contains('hidden') && !pop.contains(e.target) && e.target !== btn) pop.classList.add('hidden');
    });
  }

  /** MA 周期勾选浮层：勾选即时生效（本板持久化） */
  function buildMaMenu() {
    const menu = $('ma-menu');
    const btn = $('ma-btn');
    if (!menu || !btn) return;
    menu.textContent = '';
    for (const m of MA_DEFS) {
      const lab = document.createElement('label');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.dataset.ma = String(m.p);
      cb.checked = toggles.maSel.includes(m.p);
      cb.onchange = () => {
        toggles.maSel = cb.checked
          ? [...new Set([...toggles.maSel, m.p])].sort((a, b) => a - b)
          : toggles.maSel.filter((p) => p !== m.p);
        applyToggles();
        updateLegend(null);
      };
      const dot = document.createElement('i');
      dot.style.background = m.color;
      lab.append(cb, dot, document.createTextNode(`MA${m.p}`));
      menu.appendChild(lab);
    }
    btn.onclick = (e) => { e.stopPropagation(); menu.classList.toggle('hidden'); };
    // 点浮层外或按 Esc 收起
    document.addEventListener('click', (e) => {
      if (!menu.classList.contains('hidden') && !menu.contains(e.target) && e.target !== btn) {
        menu.classList.add('hidden');
      }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') menu.classList.add('hidden');
    });
  }

  /* ---------------- 图例 ---------------- */
  const fmtVol = (v) => v >= 1e8 ? (v / 1e8).toFixed(2) + '亿'
    : v >= 1e4 ? (v / 1e4).toFixed(2) + '万' : String(Math.round(v));

  function updateLegend(param) {
    const el = $('legend');
    if (!rawBars.length) { el.textContent = ''; return; }
    const T = window.BzTheme.colors();
    const bars = curBars();
    let idx = bars.length - 1;
    if (param && param.time) {
      const i = bars.findIndex((b) => (b.t != null ? b.t : b.d) === param.time);
      if (i >= 0) idx = i;
    }
    const b = bars[idx];
    const chg = idx > 0 ? (b.c / bars[idx - 1].c - 1) * 100 : 0;
    const closes = bars.map((x) => x.c);
    const sec = (txt, color) => txt ? `<span style="color:${color};margin-left:12px">${txt}</span>` : '';
    let html =
      `<b style="color:${chg >= 0 ? T.up : T.down}">${curName} ${b.d}</b> ` +
      `开${b.o.toFixed(2)} 高${b.h.toFixed(2)} 低${b.l.toFixed(2)} 收${b.c.toFixed(2)} ` +
      `<span style="color:${chg >= 0 ? T.up : T.down}">${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%</span>`;
    if (toggles.maSel.length) {
      const on = maOn();
      html += sec(MA_DEFS.filter((m) => on.has(m.p)).map((m) => {
        const v = window.Ind.sma(closes, m.p)[idx];
        return v == null ? '' : `MA${m.p} <b>${v.toFixed(1)}</b>`;
      }).filter(Boolean).join(' '), T.dim);
    }
    const xv = {};                       // 小面板十字光标定位值（各面板用自身指标值）
    if (toggles.vol) { xv.vol = b.v; html += sec(`VOL <b>${fmtVol(b.v)}</b>`, b.c >= b.o ? T.up : T.down); }
    if (toggles.macd) {
      const mc = window.Ind.macd(closes);
      const d = mc.dif[idx], e = mc.dea[idx], h = mc.hist[idx];
      xv.dif = d;
      if (d != null && e != null) {
        html += sec(`MACD <b style="color:${T.up}">${d.toFixed(2)}</b> ` +
          `<b style="color:${T.blue}">${e.toFixed(2)}</b> ` +
          `<b style="color:${h >= 0 ? T.up : T.down}">${h.toFixed(2)}</b>`, T.dim);
      }
    }
    if (toggles.kdj) {
      const kj = window.Ind.kdj(bars);
      xv.k = kj.k[idx];
      html += sec(`K <b style="color:#f0b90b">${kj.k[idx].toFixed(1)}</b> ` +
        `D <b style="color:${T.blue}">${kj.d[idx].toFixed(1)}</b> ` +
        `J <b style="color:#c77dff">${kj.j[idx].toFixed(1)}</b>`, T.dim);
    }
    if (toggles.boll) {
      const bo = window.Ind.boll(closes);
      xv.bollMid = bo.mid[idx];
      if (bo.mid[idx] != null) {
        html += sec(`BOLL <b style="color:#f0b90b">${bo.mid[idx].toFixed(2)}</b> ` +
          `<b style="color:${T.dim}">${bo.up[idx].toFixed(2)}</b> ` +
          `<b style="color:${T.dim}">${bo.low[idx].toFixed(2)}</b>`, T.dim);
      }
    }
    el.innerHTML = html;
    // 主面板十字光标 → 各小面板（无 param 时全部清除）
    const tk = b.t != null ? b.t : b.d;
    const setX = (c, series, v) => {
      if (!c || !series) return;
      if (param && param.time != null && v != null) c.setCrosshairPosition(v, tk, series);
      else c.clearCrosshairPosition();
    };
    setX(bollChart, bollBar, xv.bollMid != null ? b.v : null);      // BOLL 面板定位到收盘价
    setX(volChart, volS, xv.vol);
    setX(macdChart, macdS.dif, xv.dif);
    setX(kdjChart, kdjS.k, xv.k);
  }

  /* ---------------- 列表 / 选指 / 刷新 ---------------- */
  async function loadList() {
    if (cfg.mode === 'market') {           // 行情板：自选列表（与训练页自选共用 bz_watchlist）
      try { watchlist = JSON.parse(localStorage.getItem('bz_watchlist') || '[]'); } catch { watchlist = []; }
      insts = watchlist.map((w) => ({ key: w.code, name: w.name, group: '自选' }));
      renderList();
      fillSubSel();
      refreshQuotes();                               // 进入/刷新自选后立刻取行情
      return;
    }
    const d = await fetch('/api/index/list').then((r) => r.json());
    insts = d.instruments || [];
    renderList();
    fillSubSel();
  }

  /** 联动副图标的下拉（bind 时 insts 尚空，loadList 后填充；DOM 构建 + 回设当前选择） */
  function fillSubSel() {
    const subSel = $('sub-key');
    subSel.textContent = '';
    for (const [val, label] of [['', '同主图'], ...['A股', '海外']
      .flatMap((g) => insts.filter((i) => i.group === g)).map((i) => [i.key, i.name])]) {
      const o = document.createElement('option');
      o.value = val;
      o.textContent = label;
      subSel.appendChild(o);
    }
    subSel.value = subKey;               // 重建 options 后恢复用户选择
  }

  function renderList() {
    const q = ($('search').value || '').trim().toLowerCase();
    const box = $('list');
    box.innerHTML = '';
    if (cfg.mode === 'market') {
      // 自选 + 搜索结果（/api/search 添加到自选）；自选行悬停出现 ✕ 可移除
      const mk = (it, extra, onDel) => {
        const el = document.createElement('div');
        el.className = 'list-item' + (it.key === curKey ? ' active' : '') + (onDel ? ' has-q' : '');
        el.dataset.key = it.key;
        if (onDel) el.dataset.code = it.key;
        el.innerHTML = onDel
          ? `<span class="n">${it.name}</span><span class="px"></span>` +
            `<span class="d">${it.key}</span><span class="pc"></span>` +
            '<span class="rm" title="从自选移除">✕</span>'
          : `<span class="n">${it.name}</span><span class="d">${extra || ''}</span>`;
        el.onclick = () => {
          if (extra === '＋') addToWatchlist(it);
          else if (extra === '✓') removeFromWatchlist(it.key);   // 搜索命中已在自选：点击移出
          else select(it.key);
        };
        if (onDel) {
          el.querySelector('.rm').onclick = (e) => {
            e.stopPropagation();
            removeFromWatchlist(it.key);
          };
        }
        box.appendChild(el);
      };
      if (q) {
        fetch('/api/search?q=' + encodeURIComponent(q)).then((r) => r.json()).then((d) => {
          if (( $('search').value || '').trim().toLowerCase() !== q) return;   // 输入已变
          box.innerHTML = '';
          const hits = d.items || [];
          if (!hits.length) box.innerHTML = '<div class="list-group">无匹配</div>';
          for (const h of hits.slice(0, 30)) mk({ key: h.code, name: `${h.name} ${h.code}` },
            watchlist.some((w) => w.code === h.code) ? '✓' : '＋');
        }).catch(() => {});
        return;
      }
      if (!insts.length) box.innerHTML = '<div class="list-group">自选为空：搜索代码/名称添加</div>';
      for (const it of insts) mk(it, it.key, true);   // 副文本显示代码 + 悬停 ✕
      paintQuotes();                                  // 有缓存快照先填上，等轮询再刷新
      return;
    }
    for (const g of ['A股', '海外']) {
      const items = insts.filter((i) => i.group === g &&
        (!q || i.name.toLowerCase().includes(q) || i.key.toLowerCase().includes(q)));
      if (!items.length) continue;
      const h = document.createElement('div');
      h.className = 'list-group';
      h.textContent = g;
      box.appendChild(h);
      for (const it of items) {
        const el = document.createElement('div');
        el.className = 'list-item' + (it.key === curKey ? ' active' : '');
        el.dataset.key = it.key;
        el.innerHTML = `<span class="n">${it.name}</span><span class="d">${it.last ? it.last.slice(2) : (it.cached ? '' : '未缓存')}</span>`;
        el.onclick = () => select(it.key);
        box.appendChild(el);
      }
    }
  }

  let watchlist = [];
  let quotes = {};                       // 实时行情快照 {code: quote}
  let quoteAsOf = '';                    // 快照时间（服务端）

  /** 拉自选实时行情（腾讯源经服务端缓存，60s 轮询；不在前台不拉） */
  async function refreshQuotes() {
    if (cfg.mode !== 'market' || root.classList.contains('hidden')) return;
    const codes = watchlist.map((w) => w.code).slice(0, 80);
    if (!codes.length) return;
    try {
      const d = await fetch('/api/market/quotes?codes=' + codes.join(',')).then((r) => r.json());
      if (d.error) return;
      quotes = d.quotes || {};
      quoteAsOf = d.asof || '';
      paintQuotes();
    } catch { /* 行情非关键路径，失败静默 */ }
  }

  function paintQuotes() {
    root.querySelectorAll('#mkt-list .list-item[data-code]').forEach((el) => {
      const q = quotes[el.dataset.code];
      if (!q || !(q.price > 0)) return;
      const cls = q.pct >= 0 ? 'up' : 'down';
      const px = el.querySelector('.px');
      const pc = el.querySelector('.pc');
      if (px) { px.textContent = q.price.toFixed(2); px.className = 'px ' + cls; }
      if (pc) { pc.textContent = (q.pct >= 0 ? '+' : '') + q.pct.toFixed(2) + '%'; pc.className = 'pc ' + cls; }
      el.title = `${q.name} ${q.price.toFixed(2)} ${(q.pct >= 0 ? '+' : '') + q.pct.toFixed(2)}%` +
        (q.time ? ` · ${q.time}` : '') + (quoteAsOf ? `（快照 ${quoteAsOf}）` : '');
    });
  }

  /** 自选移除：同步 localStorage；移除的是当前标的则切到下一个，空则清空图表 */
  function removeFromWatchlist(code) {
    watchlist = watchlist.filter((w) => w.code !== code);
    localStorage.setItem('bz_watchlist', JSON.stringify(watchlist));
    loadList();
    if (code === curKey) {
      if (insts.length) select(insts[0].key);
      else clearChart();
    }
    refreshQuotes();
  }

  /** 自选清空后的空图表状态（保留画线设置不动，仅清数据） */
  function clearChart() {
    curKey = null;
    rawBars = [];
    candle.setData([]);
    volS.setData([]);
    for (const m of MA_DEFS) maS[m.p].setData([]);
    bollBar.setData([]);
    bollS.mid.setData([]); bollS.up.setData([]); bollS.low.setData([]);
    macdS.hist.setData([]); macdS.dif.setData([]); macdS.dea.setData([]);
    kdjS.k.setData([]); kdjS.d.setData([]); kdjS.j.setData([]);
    overlay.setBars([]);
    overlay.setLines([]);
    overlay.setChan(null);
    minimap && minimap.setBars([]);
    chip && chip.setBars([]);
    $('legend').textContent = '';
    $('title').textContent = '自选为空：搜索代码/名称添加';
  }

  function addToWatchlist(it) {
    const code = it.key;
    if (watchlist.some((w) => w.code === code)) return;
    const name = it.name.replace(/\s+\d{6}$/, '');     // 去掉搜索结果里拼的代码尾巴
    watchlist.push({ code, name });
    localStorage.setItem('bz_watchlist', JSON.stringify(watchlist));
    loadList();
    select(code);
    refreshQuotes();
  }

  /** 本板数据拉取：指数 /api/index/kline；个股/ETF /api/market/kline（日线或分钟） */
  function klineUrl(key) {
    if (cfg.mode === 'market') {
      const freq = MINUTE_PERIODS.includes(period) ? period.replace('m', 'min') : 'D';   // 5m→5min
      return `/api/market/kline?code=${encodeURIComponent(key)}&freq=${freq}&adj=${adjMode}`;
    }
    return '/api/index/kline?key=' + encodeURIComponent(key);
  }

  let selSeq = 0, subSeq = 0;            // 竞态守卫：晚到的旧响应不覆盖新选择

  async function select(key) {
    curKey = key;
    const seq = ++selSeq;
    const it = insts.find((x) => x.key === key);
    curName = it ? it.name : key;
    root.querySelectorAll('.list-item').forEach((e) => e.classList.toggle('active', e.dataset.key === key));
    $('title').textContent = `${curName} 加载中…`;
    try {
      const d = await fetch(klineUrl(key)).then((r) => r.json());
      if (seq !== selSeq) return;        // 期间用户又切了别的标的
      if (d.error) throw new Error(d.error);
      asof = d.asof || '';
      rawBars = d.bars.map((b) => ({
        d: b[0], o: b[1], h: b[2], l: b[3], c: b[4], v: b[5],
        t: b[0].length > 10 ? Math.floor(Date.parse(b[0].replace(' ', 'T')) / 1000) : null,  // 分钟→unix ts（含秒无需再拼）
      }));
      overlay.setLines(loadLines());
      renderAll();
      if (syncOn) loadSub(subKey || curKey);   // 联动：主图换标的 → 副图跟随（同主图模式）
    } catch (e) {
      if (seq === selSeq) $('title').textContent = `${curName} 加载失败：${e.message}`;
    }
  }

  async function refreshData() {
    const btn = $('refresh');
    btn.disabled = true;
    btn.textContent = '刷新中…';
    try {
      await fetch('/api/index/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      await loadList();
      if (curKey) await select(curKey);
    } catch (e) {
      $('title').textContent = `同步失败：${e.message}`;
    } finally {
      btn.disabled = false;
      btn.textContent = '⟳ 同步数据';
    }
  }

  /* ---------------- 联动副图 ---------------- */
  function buildSubChart() {
    if (subChart) { subChart.remove(); subChart = null; }
    const T = window.BzTheme.colors();
    subChart = LightweightCharts.createChart($('sub'), {
      layout: { background: { color: T.panel }, textColor: T.dim, fontSize: 11 },
      grid: { vertLines: { color: T.grid }, horzLines: { color: T.grid } },
      rightPriceScale: { borderColor: T.line, scaleMargins: { top: 0.05, bottom: 0.05 } },
      timeScale: { borderColor: T.line, timeVisible: false, rightOffset: 3 },
      crosshair: { mode: 0 },
      autoSize: true,
      handleScale: { axisPressedMouseMove: false },   // 副图缩放以主图为准
    });
    subCandle = subChart.addCandlestickSeries({
      upColor: UP, downColor: DOWN, borderUpColor: UP, borderDownColor: DOWN,
      wickUpColor: UP, wickDownColor: DOWN,
    });
    subMA = {
      5: subChart.addLineSeries({ color: '#f0b90b', lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }),
      20: subChart.addLineSeries({ color: '#c77dff', lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }),
    };
    subChart.subscribeCrosshairMove((param) => {
      // 副图十字光标 → 主图（带收盘价定位）
      if (param.time && chart && candle && rawBars.length) {
        const b = rawBars.find((x) => x.d === param.time) ||
          rawBars[_nearestIdx(rawBars, param.time)];
        if (b) chart.setCrosshairPosition(b.c, b.d, candle);
      } else if (chart) {
        chart.clearCrosshairPosition();
      }
    });
  }

  /** 副图数据加载：key 为指数 key；渲染聚合周期 + MA5/20 */
  async function loadSub(key) {
    if (!subChart) return;
    const seq = ++subSeq;
    const it = insts.find((x) => x.key === key);
    $('sub-title').textContent = `${it ? it.name : key} · ${key} 加载中…`;
    try {
      const url = cfg.mode === 'market'
        ? `/api/market/kline?code=${encodeURIComponent(key)}&freq=D&adj=${adjMode}`
        : '/api/index/kline?key=' + encodeURIComponent(key);
      const d = await fetch(url).then((r) => r.json());
      if (seq !== subSeq) return;        // 期间副图标的又被改选
      if (d.error) throw new Error(d.error);
      subRaw = d.bars.map((b) => ({ d: b[0], o: b[1], h: b[2], l: b[3], c: b[4], v: b[5] }));
      renderSub();
    } catch (e) {
      if (seq === subSeq) $('sub-title').textContent = `${it ? it.name : key} 加载失败：${e.message}`;
    }
  }

  function renderSub() {
    if (!subChart || !subRaw.length) return;
    subBars = window.Ind.aggregate(subRaw, subPeriod);
    subCandle.setData(subBars.map((b) => ({ time: b.d, open: b.o, high: b.h, low: b.l, close: b.c })));
    const closes = subBars.map((b) => b.c);
    for (const p of [5, 20]) {
      const arr = window.Ind.sma(closes, p);
      subMA[p].setData(arr.map((v, i) => (v == null ? null : { time: subBars[i].d, value: v })).filter(Boolean));
    }
    const it = insts.find((x) => x.key === (subKey || curKey));
    const pn = { D: '日K', W: '周K', M: '月K', Y: '年K' }[subPeriod];
    $('sub-title').textContent = `${it ? it.name : (subKey || curKey)}（${pn} ${subBars.length} 根）`;
    syncSubRange(true);
  }

  /** 日期在 bars（.d 升序）里的最近(≤)索引 */
  function _nearestIdx(bs, d) {
    let lo = 0, hi = bs.length - 1, ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (bs[mid].d <= d) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
  }

  /** 主图可视范围 → 副图（按日期映射到副图周期聚合索引） */
  function syncSubRange(force = false) {
    if (!syncOn || !subChart || !subBars.length || !rawBars.length) return;
    if (syncingVR && !force) return;
    const vr = chart.timeScale().getVisibleLogicalRange();
    if (!vr) return;
    const clamp = (i) => Math.max(0, Math.min(rawBars.length - 1, i));
    const d0 = rawBars[clamp(Math.round(vr.from))].d;
    const d1 = rawBars[clamp(Math.round(vr.to))].d;
    const j0 = _nearestIdx(subBars, d0);
    const j1 = _nearestIdx(subBars, d1);
    if (j1 <= j0) return;
    syncingVR = true;
    try {
      subChart.timeScale().setVisibleLogicalRange({ from: j0, to: j1 + 1 });
    } finally {
      requestAnimationFrame(() => { syncingVR = false; });
    }
  }

  /** 主图十字光标 → 副图 */
  function crosshairToSub(param) {
    if (!syncOn || !subChart || !subCandle || !subBars.length) return;
    if (param.time) {
      const b = subBars.find((x) => x.d === param.time) || subBars[_nearestIdx(subBars, param.time)];
      if (b) { subChart.setCrosshairPosition(b.c, b.d, subCandle); return; }
    }
    subChart.clearCrosshairPosition();
  }

  function applySync(on) {
    syncOn = on;
    localStorage.setItem(lsKey('sync'), on ? '1' : '0');
    $('sync').classList.toggle('on', on);
    root.querySelector('.view-main').classList.toggle('sub-on', on);
    $('sub-wrap').classList.toggle('hidden', !on);
    if (on) {
      if (!subChart) buildSubChart();
      loadSub(subKey || curKey);
      root.querySelectorAll('[data-subp]').forEach((b) => {
        b.classList.toggle('on', b.dataset.subp === subPeriod);
      });
    } else if (subChart) {
      subChart.remove();
      subChart = null;
    }
  }

  /* ---------------- 画线持久化 ---------------- */
  const lkey = () => lsKey('draw_' + curKey);
  function loadLines() {
    try { return JSON.parse(localStorage.getItem(lkey()) || '[]'); } catch { return []; }
  }
  function saveLines() {
    localStorage.setItem(lkey(), JSON.stringify(overlay.lines));
  }

  /* ---------------- 图表模板（周期+指标开关组合，localStorage） ---------------- */
  const TPL_KEY = 'bz_tpl_' + P;
  function tpls() {
    try { return JSON.parse(localStorage.getItem(TPL_KEY) || '{}'); } catch { return {}; }
  }
  function refreshTplSel() {
    const sel = $('tpl-sel');
    sel.textContent = '';                  // DOM 构建：模板名自由输入不拼 HTML
    for (const k of ['', ...Object.keys(tpls())]) {
      const o = document.createElement('option');
      o.value = k;
      o.textContent = k || '模板…';
      sel.appendChild(o);
    }
  }
  function applyTpl(t) {
    if (t.period) {
      const wasMin = MINUTE_PERIODS.includes(period);
      period = t.period;
      localStorage.setItem(lsKey('period'), period);
      root.querySelectorAll('[data-period]').forEach((x) => x.classList.toggle('on', x.dataset.period === period));
    }
    Object.assign(toggles, t.toggles || {});
    applyToggles();
    if (cfg.mode === 'market' && MINUTE_PERIODS.includes(period) !== wasMin) {
      if (curKey) select(curKey);
      return;
    }
    renderAll();
  }

  /* ---------------- 初始化 ---------------- */
  function bind() {
    root.querySelectorAll('[data-period]').forEach((b) => {
      b.classList.toggle('on', b.dataset.period === period);
      b.onclick = () => {
        const wasMin = MINUTE_PERIODS.includes(period);
        period = b.dataset.period;
        localStorage.setItem(lsKey('period'), period);
        root.querySelectorAll('[data-period]').forEach((x) => x.classList.toggle('on', x === b));
        // 分钟⇆日线数据形态不同：重取数；日线系周期本地聚合即可
        if (cfg.mode === 'market' && MINUTE_PERIODS.includes(period) !== wasMin) {
          if (curKey) select(curKey);
          return;
        }
        renderAll();
      };
    });
    // 行情板：复权切换（前复权锚定最新 / 不复权）
    if (cfg.mode === 'market') {
      const adjBtn = $('adj');
      const syncAdj = () => {
        adjBtn.classList.toggle('on', adjMode === 'qfq');
        adjBtn.textContent = adjMode === 'qfq' ? '前复权' : '不复权';
      };
      syncAdj();
      adjBtn.onclick = () => {
        adjMode = adjMode === 'qfq' ? 'none' : 'qfq';
        localStorage.setItem(lsKey('adj'), adjMode);
        syncAdj();
        if (curKey) select(curKey);
      };
    }
    root.querySelectorAll('[data-tg]').forEach((b) => {
      b.onclick = () => { toggles[b.dataset.tg] = !toggles[b.dataset.tg]; applyToggles(); updateLegend(null); };
    });
    buildMaMenu();
    buildDrawStyle();
    root.querySelectorAll('[data-draw]').forEach((b) => {
      b.onclick = () => {
        const m = b.dataset.draw;
        overlay.setMode(overlay.mode === m ? 'none' : m);   // 高亮经 onModeChange 同步
      };
    });
    $('undo').onclick = () => { if (overlay.undo()) saveLines(); };
    $('redo').onclick = () => { if (overlay.redo()) saveLines(); };
    $('clear-draw').onclick = () => { overlay.clearAll(); saveLines(); };
    if ($('refresh')) $('refresh').onclick = refreshData;
    $('search').oninput = renderList;

    // 联动副图
    $('sync').onclick = () => applySync(!syncOn);
    root.querySelectorAll('[data-subp]').forEach((b) => {
      b.onclick = () => {
        subPeriod = b.dataset.subp;
        localStorage.setItem(lsKey('subperiod'), subPeriod);
        root.querySelectorAll('[data-subp]').forEach((x) => x.classList.toggle('on', x === b));
        renderSub();
      };
    });
    const subSel = $('sub-key');
    subSel.onchange = () => {
      subKey = subSel.value;
      if (syncOn) loadSub(subKey || curKey);
    };

    // 图表模板
    refreshTplSel();
    $('tpl-save').onclick = () => {
      window.bzPrompt('模板名称：', '', (name) => {
        name = name.slice(0, 40);
        if (!name) return;
        const m = tpls();
        m[name] = { period, toggles: { ...toggles } };
        localStorage.setItem(TPL_KEY, JSON.stringify(m));
        refreshTplSel();
        $('tpl-sel').value = name;
      });
    };
    $('tpl-del').onclick = () => {
      const name = $('tpl-sel').value;
      if (!name) return;
      const m = tpls();
      delete m[name];
      localStorage.setItem(TPL_KEY, JSON.stringify(m));
      refreshTplSel();
    };
    $('tpl-sel').onchange = () => {
      const t = tpls()[$('tpl-sel').value];
      if (t) applyTpl(t);
    };

    // 顶部导航统一由 window.bzNav 管理（view.js 顶层绑定）

    // 撤销/重做快捷键（仅本板可见时生效；输入框内不拦）
    document.addEventListener('keydown', (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
      if (root.classList.contains('hidden') || !overlay) return;
      if (e.code === 'KeyZ' && !e.shiftKey) { if (overlay.undo()) saveLines(); }
      else if (e.code === 'KeyY' || (e.code === 'KeyZ' && e.shiftKey)) { if (overlay.redo()) saveLines(); }
    });
  }

  /** 进入本板（由 bzNav 调用）：首进建图/加载列表/恢复联动 */
  function enter() {
    if (!chart) buildChart();            // 首次进入且容器可见时建图
    if (!insts.length || cfg.mode === 'market') loadList()   // 行情板每次进入都刷新自选
      .then(() => { if (!curKey && insts.length) select(cfg.mode === 'market' ? insts[0].key : 'sh000300'); })
      .catch((e) => { $('title').textContent = `列表加载失败：${e.message}`; });
    if (syncOn && !subChart) applySync(true);   // 恢复上次的联动状态
    if (cfg.mode === 'market') refreshQuotes();
  }

  function init() {
    if (inited) return;
    inited = true;
    bind();
    if (cfg.mode === 'market') {
      setInterval(refreshQuotes, 60 * 1000);
      document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshQuotes(); });
    }
    // 联动按钮初始高亮（进入看板前也保持记忆状态）
    $('sync').classList.toggle('on', syncOn);

    // 主题切换：重建图表（配色/画线 canvas 跟随新主题）
    window.BzTheme.onChange(() => {
      if (!inited) return;
      if (chart) {
        buildChart();
        overlay.setLines(loadLines());
        if (rawBars.length) renderAll();
        if (syncOn && subChart) { buildSubChart(); renderSub(); }   // 副图随主题重建
      }
    });
  }

  return { init, enter, reload: () => { if (curKey) select(curKey); } };
};

window.View = window.createBoard({ mode: 'index' });
window.Mkt = window.createBoard({ mode: 'market' });   // 个股/ETF 行情板（日线+分钟）

/* ---------------- 三页签导航（训练 / 指数看板 / 行情） ---------------- */
window.bzNav = {
  switch(which) {           // 'train' | 'view' | 'mkt'
    document.getElementById('app-train').classList.toggle('hidden', which !== 'train');
    document.getElementById('screen-view').classList.toggle('hidden', which !== 'view');
    document.getElementById('screen-mkt').classList.toggle('hidden', which !== 'mkt');
    for (const w of ['train', 'view', 'mkt']) {
      document.getElementById('nav-' + w).classList.toggle('active', w === which);
    }
    if (which === 'view' && window.View) window.View.enter();
    if (which === 'mkt' && window.Mkt) window.Mkt.enter();
    if (which === 'train') window.dispatchEvent(new Event('bz-tab-train'));
  },
};
for (const w of ['train', 'view', 'mkt']) {
  document.getElementById('nav-' + w).onclick = () => window.bzNav.switch(w);
}
