/* 指数看板（K线道场）：选指 / 日周月年 / 指标开关 / 画线 / 缠论 / 增量刷新 */
'use strict';
window.View = (() => {
  const UP = '#e0483e', DOWN = '#1fa06b';
  const MA_DEFS = [
    { p: 5, color: '#f0b90b' }, { p: 10, color: '#4a90e2' },
    { p: 20, color: '#c77dff' }, { p: 60, color: '#ff8c42' },
  ];

  let inited = false;
  let chart = null, candle = null, volS = null;
  let maS = {}, bollS = {}, bollBar = null, macdS = {}, kdjS = {};
  let overlay = null;
  let insts = [];
  let curKey = null, curName = '';
  let rawBars = [];                       // 全量日线
  let period = localStorage.getItem('bz_view_period') || 'D';
  function loadToggles(key, defaults) {    // localStorage 坏值不炸整个看板模块
    try { return Object.assign(defaults, JSON.parse(localStorage.getItem(key) || '{}')); }
    catch { return defaults; }
  }
  const toggles = loadToggles('bz_view_toggles',
    { ma: true, boll: false, macd: true, kdj: false, vol: true, chan: false, duan: false, bei: false });

  /* ---------------- 小地图：全历史缩略条（点击/拖动跳转可视区间） ---------------- */
  class Minimap {
    constructor() {
      this.cvs = document.getElementById('view-minimap');
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
  let coverRO = null;                     // 遮轴条 ResizeObserver（重建前 disconnect）

  /* ---------------- 联动副图：同标的异周期 / 另选标的对照 ---------------- */
  let syncOn = localStorage.getItem('bz_view_sync') === '1';
  let subChart = null, subCandle = null, subMA = {};
  let subKey = '';                       // '' = 同主图
  let subPeriod = localStorage.getItem('bz_view_subperiod') || 'W';
  let subRaw = [], subBars = [];         // 副图全量日线 / 当前周期聚合
  let syncingVR = false;                 // 可视范围同步防回环

  const $ = (id) => document.getElementById(id);

  /* ---------------- 图表 ---------------- */
  function buildChart() {
    if (chart) { chart.remove(); chart = null; }
    const T = window.BzTheme.colors();
    chart = LightweightCharts.createChart($('view-chart'), {
      layout: { background: { color: T.panel }, textColor: T.dim, fontSize: 12 },
      grid: { vertLines: { color: T.grid }, horzLines: { color: T.grid } },
      rightPriceScale: { borderColor: T.line, scaleMargins: { top: 0.02, bottom: 0.44 } },
      timeScale: { borderColor: T.line, timeVisible: false, rightOffset: 5 },
      crosshair: { mode: 0 },
      autoSize: true,
    });
    candle = chart.addCandlestickSeries({
      upColor: UP, downColor: DOWN, borderUpColor: UP, borderDownColor: DOWN,
      wickUpColor: UP, wickDownColor: DOWN,
    });
    volS = chart.addHistogramSeries({
      priceScaleId: 'vol', priceFormat: { type: 'volume' },
      priceLineVisible: false, lastValueVisible: false,
    });
    chart.priceScale('vol').applyOptions({ visible: false });

    maS = {};
    for (const m of MA_DEFS) {
      maS[m.p] = chart.addLineSeries({
        color: m.color, lineWidth: 1, title: `MA${m.p}`,
        priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
      });
    }
      bollBar = chart.addBarSeries({
      priceScaleId: 'boll',
      upColor: UP, downColor: DOWN,
      thinBars: true,                     // 竹线：细竖线=高低，左爪开/右爪收
      priceLineVisible: false, lastValueVisible: false,
    });
    bollS = {
      mid: chart.addLineSeries({ priceScaleId: 'boll', color: '#f0b90b', lineWidth: 1, lineStyle: 2, title: 'BOLL', priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }),
      up: chart.addLineSeries({ priceScaleId: 'boll', color: '#8892a6', lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }),
      low: chart.addLineSeries({ priceScaleId: 'boll', color: '#8892a6', lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }),
    };
    macdS = {
      hist: chart.addHistogramSeries({ priceScaleId: 'macd', title: 'MACD', priceLineVisible: false, lastValueVisible: false }),
      dif: chart.addLineSeries({ priceScaleId: 'macd', color: '#e0483e', lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }),
      dea: chart.addLineSeries({ priceScaleId: 'macd', color: '#4a90e2', lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }),
    };
    chart.priceScale('macd').applyOptions({ visible: false });
    kdjS = {
      k: chart.addLineSeries({ priceScaleId: 'kdj', color: '#f0b90b', lineWidth: 1, title: 'KDJ', priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }),
      d: chart.addLineSeries({ priceScaleId: 'kdj', color: '#4a90e2', lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }),
      j: chart.addLineSeries({ priceScaleId: 'kdj', color: '#c77dff', lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }),
    };
    chart.priceScale('kdj').applyOptions({ visible: false });
    applyPaneLayout();

    overlay = new window.Overlay(chart, candle, $('view-chart-wrap'), {
      onModeChange: syncDrawBtns,
      onChange: saveLines,
    });
    if (!minimap) minimap = new Minimap();
    minimap.attach(chart);
    chart.timeScale().subscribeVisibleLogicalRangeChange(() => {
      minimap.redraw();
      syncSubRange();                     // 主图可视范围 → 副图
    });
    chart.subscribeClick((param) => {
      if (overlay.handleClick(param)) saveLines();
    });
    chart.subscribeCrosshairMove((param) => {
      updateLegend(param);
      crosshairToSub(param);              // 十字光标联动
    });
    window.__bzView = { chart, overlay, minimap };   // 调试/自动化测试用

    // 遮住副图区背后的主轴刻度（外推负值会误导）；主题重建时先清旧的
    $('view-chart-wrap').querySelectorAll('.axis-cover').forEach((e) => e.remove());
    const cover = document.createElement('div');
    cover.className = 'axis-cover';
    $('view-chart-wrap').appendChild(cover);
    const fitCover = () => { cover.style.width = (chart.priceScale('right').width() + 2) + 'px'; };
    fitCover();
    if (coverRO) coverRO.disconnect();          // 主题重建不累积 observer
    coverRO = (typeof ResizeObserver !== 'undefined') ? new ResizeObserver(fitCover) : null;
    if (coverRO) coverRO.observe($('view-chart'));

    applyToggles();
  }

  /** 画线工具按钮高亮与 overlay.mode 同步（含画完线自动复位 none 的场景） */
  function syncDrawBtns() {
    document.querySelectorAll('[data-draw]').forEach((x) => {
      x.classList.toggle('on', x.dataset.draw === overlay.mode);
    });
  }

  /** 面板布局：BOLL 独立窗格（缩略K线+三轨）开启时压缩主图、各副图下移 */
  function applyPaneLayout() {
    const bollOn = !!toggles.boll;
    chart.priceScale('right').applyOptions({
      scaleMargins: bollOn ? { top: 0.01, bottom: 0.51 } : { top: 0.02, bottom: 0.44 },
    });
    chart.priceScale('boll').applyOptions({
      scaleMargins: { top: 0.51, bottom: 0.35 }, visible: false,
    });
    chart.priceScale('vol').applyOptions({
      scaleMargins: bollOn ? { top: 0.68, bottom: 0.20 } : { top: 0.70, bottom: 0.22 },
    });
    chart.priceScale('macd').applyOptions({
      scaleMargins: bollOn ? { top: 0.83, bottom: 0.09 } : { top: 0.82, bottom: 0.10 },
    });
    chart.priceScale('kdj').applyOptions({
      scaleMargins: bollOn ? { top: 0.93, bottom: 0 } : { top: 0.94, bottom: 0 },
    });
  }

  /* ---------------- 数据渲染 ---------------- */
  /** 指标重灌：关闭的指标清空数据（visible:false 的 series 仍会参与主轴
   *  autoscale，年K 小样本的 BOLL 下轨可为负，不清会污染价格刻度）。 */
  function refillIndicators(bars) {
    const closes = bars.map((b) => b.c);
    const line = (arr) => arr.map((v, i) => (v == null ? null : { time: bars[i].d, value: v })).filter(Boolean);

    for (const m of MA_DEFS) {
      maS[m.p].setData(toggles.ma ? line(window.Ind.sma(closes, m.p)) : []);
    }
    if (toggles.boll) {
      const bo = window.Ind.boll(closes);
      bollBar.setData(bars.map((b) => ({ time: b.d, open: b.o, high: b.h, low: b.l, close: b.c })));
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
        time: bars[i].d, value: v, color: v >= 0 ? T.macdUp : T.macdDown,
      })));
      macdS.dif.setData(mc.dif.map((v, i) => ({ time: bars[i].d, value: v })));
      macdS.dea.setData(mc.dea.map((v, i) => ({ time: bars[i].d, value: v })));
    } else {
      macdS.hist.setData([]); macdS.dif.setData([]); macdS.dea.setData([]);
    }
    if (toggles.kdj) {
      const kj = window.Ind.kdj(bars);
      kdjS.k.setData(kj.k.map((v, i) => ({ time: bars[i].d, value: v })));
      kdjS.d.setData(kj.d.map((v, i) => ({ time: bars[i].d, value: v })));
      kdjS.j.setData(kj.j.map((v, i) => ({ time: bars[i].d, value: v })));
    } else {
      kdjS.k.setData([]); kdjS.d.setData([]); kdjS.j.setData([]);
    }
  }

  function renderAll() {
    if (!chart || !curKey) return;
    if (!rawBars.length) { $('view-title').textContent = `${curName}：无数据`; return; }
    const T = window.BzTheme.colors();
    const bars = window.Ind.aggregate(rawBars, period);
    candle.setData(bars.map((b) => ({ time: b.d, open: b.o, high: b.h, low: b.l, close: b.c })));
    volS.setData(toggles.vol ? bars.map((b) => ({
      time: b.d, value: b.v,
      color: b.c >= b.o ? T.volUp : T.volDown,
    })) : []);
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
    const pn = { D: '日K', W: '周K', M: '月K', Y: '年K' }[period];
    $('view-title').textContent =
      `${curName}（${rawBars[0].d} ~ ${rawBars[rawBars.length - 1].d}，日线 ${rawBars.length} 根 · ${pn} ${bars.length} 根）`;
  }

  function applyToggles() {
    const vis = (s, on) => s.applyOptions({ visible: !!on });
    for (const m of MA_DEFS) vis(maS[m.p], toggles.ma);
    vis(bollBar, toggles.boll);
    vis(bollS.mid, toggles.boll); vis(bollS.up, toggles.boll); vis(bollS.low, toggles.boll);
    vis(macdS.hist, toggles.macd); vis(macdS.dif, toggles.macd); vis(macdS.dea, toggles.macd);
    vis(kdjS.k, toggles.kdj); vis(kdjS.d, toggles.kdj); vis(kdjS.j, toggles.kdj);
    vis(volS, toggles.vol);
    applyPaneLayout();
    // 关闭的指标清空数据，避免参与主轴 autoscale（BOLL 年K 可为负）
    if (rawBars.length) refillIndicators(window.Ind.aggregate(rawBars, period));
    if (volS && rawBars.length) {
      const T = window.BzTheme.colors();
      const bars = window.Ind.aggregate(rawBars, period);
      volS.setData(toggles.vol ? bars.map((b) => ({
        time: b.d, value: b.v,
        color: b.c >= b.o ? T.volUp : T.volDown,
      })) : []);
    }
    document.querySelectorAll('[data-tg]').forEach((b) => {
      b.classList.toggle('on', !!toggles[b.dataset.tg]);
    });
    localStorage.setItem('bz_view_toggles', JSON.stringify(toggles));
    if (overlay) {
      overlay.setChan(window.Ind.chanView(window.Ind.aggregate(rawBars, period), toggles));
    }
  }

  /* ---------------- 图例 ---------------- */
  const fmtVol = (v) => v >= 1e8 ? (v / 1e8).toFixed(2) + '亿'
    : v >= 1e4 ? (v / 1e4).toFixed(2) + '万' : String(Math.round(v));

  function updateLegend(param) {
    const el = $('view-legend');
    if (!rawBars.length) { el.textContent = ''; return; }
    const T = window.BzTheme.colors();
    const bars = window.Ind.aggregate(rawBars, period);
    let idx = bars.length - 1;
    if (param && param.time) {
      const i = bars.findIndex((b) => b.d === param.time);
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
    if (toggles.ma) {
      html += sec(MA_DEFS.map((m) => {
        const v = window.Ind.sma(closes, m.p)[idx];
        return v == null ? '' : `MA${m.p} <b>${v.toFixed(1)}</b>`;
      }).filter(Boolean).join(' '), T.dim);
    }
    if (toggles.vol) html += sec(`VOL <b>${fmtVol(b.v)}</b>`, b.c >= b.o ? T.up : T.down);
    if (toggles.macd) {
      const mc = window.Ind.macd(closes);
      const d = mc.dif[idx], e = mc.dea[idx], h = mc.hist[idx];
      if (d != null && e != null) {
        html += sec(`MACD <b style="color:${T.up}">${d.toFixed(2)}</b> ` +
          `<b style="color:${T.blue}">${e.toFixed(2)}</b> ` +
          `<b style="color:${h >= 0 ? T.up : T.down}">${h.toFixed(2)}</b>`, T.dim);
      }
    }
    if (toggles.kdj) {
      const kj = window.Ind.kdj(bars);
      html += sec(`K <b style="color:#f0b90b">${kj.k[idx].toFixed(1)}</b> ` +
        `D <b style="color:${T.blue}">${kj.d[idx].toFixed(1)}</b> ` +
        `J <b style="color:#c77dff">${kj.j[idx].toFixed(1)}</b>`, T.dim);
    }
    if (toggles.boll) {
      const bo = window.Ind.boll(closes);
      if (bo.mid[idx] != null) {
        html += sec(`BOLL <b style="color:#f0b90b">${bo.mid[idx].toFixed(2)}</b> ` +
          `<b style="color:${T.dim}">${bo.up[idx].toFixed(2)}</b> ` +
          `<b style="color:${T.dim}">${bo.low[idx].toFixed(2)}</b>`, T.dim);
      }
    }
    el.innerHTML = html;
  }

  /* ---------------- 列表 / 选指 / 刷新 ---------------- */
  async function loadList() {
    const d = await fetch('/api/index/list').then((r) => r.json());
    insts = d.instruments || [];
    renderList();
    // 联动副图的标的下拉（bind 时 insts 尚空，这里填充；DOM 构建 + 回设当前选择）
    const subSel = $('view-sub-key');
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
    const q = ($('view-search').value || '').trim().toLowerCase();
    const box = $('view-list');
    box.innerHTML = '';
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

  let selSeq = 0, subSeq = 0;            // 竞态守卫：晚到的旧响应不覆盖新选择

  async function select(key) {
    curKey = key;
    const seq = ++selSeq;
    const it = insts.find((x) => x.key === key);
    curName = it ? it.name : key;
    document.querySelectorAll('.list-item').forEach((e) => e.classList.toggle('active', e.dataset.key === key));
    $('view-title').textContent = `${curName} 加载中…`;
    try {
      const d = await fetch('/api/index/kline?key=' + encodeURIComponent(key)).then((r) => r.json());
      if (seq !== selSeq) return;        // 期间用户又切了别的标的
      if (d.error) throw new Error(d.error);
      rawBars = d.bars.map((b) => ({ d: b[0], o: b[1], h: b[2], l: b[3], c: b[4], v: b[5] }));
      overlay.setLines(loadLines());
      renderAll();
      if (syncOn) loadSub(subKey || curKey);   // 联动：主图换标的 → 副图跟随（同主图模式）
    } catch (e) {
      if (seq === selSeq) $('view-title').textContent = `${curName} 加载失败：${e.message}`;
    }
  }

  async function refreshData() {
    const btn = $('view-refresh');
    btn.disabled = true;
    btn.textContent = '刷新中…';
    try {
      await fetch('/api/index/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      await loadList();
      if (curKey) await select(curKey);
    } catch (e) {
      $('view-title').textContent = `同步失败：${e.message}`;
    } finally {
      btn.disabled = false;
      btn.textContent = '⟳ 同步数据';
    }
  }

  /* ---------------- 联动副图 ---------------- */
  function buildSubChart() {
    if (subChart) { subChart.remove(); subChart = null; }
    const T = window.BzTheme.colors();
    subChart = LightweightCharts.createChart($('view-sub'), {
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
    $('view-sub-title').textContent = `${it ? it.name : key} · ${key} 加载中…`;
    try {
      const d = await fetch('/api/index/kline?key=' + encodeURIComponent(key)).then((r) => r.json());
      if (seq !== subSeq) return;        // 期间副图标的又被改选
      if (d.error) throw new Error(d.error);
      subRaw = d.bars.map((b) => ({ d: b[0], o: b[1], h: b[2], l: b[3], c: b[4], v: b[5] }));
      renderSub();
    } catch (e) {
      if (seq === subSeq) $('view-sub-title').textContent = `${it ? it.name : key} 加载失败：${e.message}`;
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
    $('view-sub-title').textContent = `${it ? it.name : (subKey || curKey)}（${pn} ${subBars.length} 根）`;
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
    localStorage.setItem('bz_view_sync', on ? '1' : '0');
    $('view-sync').classList.toggle('on', on);
    document.querySelector('.view-main').classList.toggle('sub-on', on);
    $('view-sub-wrap').classList.toggle('hidden', !on);
    if (on) {
      if (!subChart) buildSubChart();
      loadSub(subKey || curKey);
      document.querySelectorAll('[data-subp]').forEach((b) => {
        b.classList.toggle('on', b.dataset.subp === subPeriod);
      });
    } else if (subChart) {
      subChart.remove();
      subChart = null;
    }
  }

  /* ---------------- 画线持久化 ---------------- */
  const lkey = () => 'bz_draw_' + curKey;
  function loadLines() {
    try { return JSON.parse(localStorage.getItem(lkey()) || '[]'); } catch { return []; }
  }
  function saveLines() {
    localStorage.setItem(lkey(), JSON.stringify(overlay.lines));
  }

  /* ---------------- 图表模板（周期+指标开关组合，localStorage） ---------------- */
  const TPL_KEY = 'bz_tpl_view';
  function tpls() {
    try { return JSON.parse(localStorage.getItem(TPL_KEY) || '{}'); } catch { return {}; }
  }
  function refreshTplSel() {
    const sel = $('view-tpl-sel');
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
      period = t.period;
      localStorage.setItem('bz_view_period', period);
      document.querySelectorAll('[data-period]').forEach((x) => x.classList.toggle('on', x.dataset.period === period));
    }
    Object.assign(toggles, t.toggles || {});
    applyToggles();
    renderAll();
  }

  /* ---------------- 初始化 ---------------- */
  function bind() {
    document.querySelectorAll('[data-period]').forEach((b) => {
      b.classList.toggle('on', b.dataset.period === period);
      b.onclick = () => {
        period = b.dataset.period;
        localStorage.setItem('bz_view_period', period);
        document.querySelectorAll('[data-period]').forEach((x) => x.classList.toggle('on', x === b));
        renderAll();
      };
    });
    document.querySelectorAll('[data-tg]').forEach((b) => {
      b.onclick = () => { toggles[b.dataset.tg] = !toggles[b.dataset.tg]; applyToggles(); updateLegend(null); };
    });
    document.querySelectorAll('[data-draw]').forEach((b) => {
      b.onclick = () => {
        const m = b.dataset.draw;
        overlay.setMode(overlay.mode === m ? 'none' : m);   // 高亮经 onModeChange 同步
      };
    });
    $('view-undo').onclick = () => { if (overlay.undo()) saveLines(); };
    $('view-redo').onclick = () => { if (overlay.redo()) saveLines(); };
    $('view-clear-draw').onclick = () => { overlay.clearAll(); saveLines(); };
    $('view-refresh').onclick = refreshData;
    $('view-search').oninput = renderList;

    // 联动副图
    $('view-sync').onclick = () => applySync(!syncOn);
    document.querySelectorAll('[data-subp]').forEach((b) => {
      b.onclick = () => {
        subPeriod = b.dataset.subp;
        localStorage.setItem('bz_view_subperiod', subPeriod);
        document.querySelectorAll('[data-subp]').forEach((x) => x.classList.toggle('on', x === b));
        renderSub();
      };
    });
    const subSel = $('view-sub-key');
    subSel.onchange = () => {
      subKey = subSel.value;
      if (syncOn) loadSub(subKey || curKey);
    };

    // 图表模板
    refreshTplSel();
    $('view-tpl-save').onclick = () => {
      window.bzPrompt('模板名称：', '', (name) => {
        name = name.slice(0, 40);
        if (!name) return;
        const m = tpls();
        m[name] = { period, toggles: { ...toggles } };
        localStorage.setItem(TPL_KEY, JSON.stringify(m));
        refreshTplSel();
        $('view-tpl-sel').value = name;
      });
    };
    $('view-tpl-del').onclick = () => {
      const name = $('view-tpl-sel').value;
      if (!name) return;
      const m = tpls();
      delete m[name];
      localStorage.setItem(TPL_KEY, JSON.stringify(m));
      refreshTplSel();
    };
    $('view-tpl-sel').onchange = () => {
      const t = tpls()[$('view-tpl-sel').value];
      if (t) applyTpl(t);
    };

    // 顶部导航：训练 / 看板
    $('nav-train').onclick = () => { switchTab('train'); window.dispatchEvent(new Event('bz-tab-train')); };
    $('nav-view').onclick = () => switchTab('view');

    // 撤销/重做快捷键（仅看板页签激活时生效；输入框内不拦）
    document.addEventListener('keydown', (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
      if ($('screen-view').classList.contains('hidden') || !overlay) return;
      if (e.code === 'KeyZ' && !e.shiftKey) { if (overlay.undo()) saveLines(); }
      else if (e.code === 'KeyY' || (e.code === 'KeyZ' && e.shiftKey)) { if (overlay.redo()) saveLines(); }
    });
  }

  function switchTab(which) {
    $('app-train').classList.toggle('hidden', which !== 'train');
    $('screen-view').classList.toggle('hidden', which !== 'view');
    $('nav-train').classList.toggle('active', which === 'train');
    $('nav-view').classList.toggle('active', which === 'view');
    if (which === 'view') {
      if (!chart) buildChart();          // 首次进入且容器可见时建图
      if (!insts.length) loadList()
        .then(() => { if (!curKey && insts.length) select('sh000300'); })
        .catch((e) => { $('view-title').textContent = `列表加载失败：${e.message}`; });
      if (syncOn && !subChart) applySync(true);   // 恢复上次的联动状态
    }
  }

  function init() {
    if (inited) return;
    inited = true;
    bind();
    // 联动按钮初始高亮（进入看板前也保持记忆状态）
    $('view-sync').classList.toggle('on', syncOn);

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

  return { init };
})();
