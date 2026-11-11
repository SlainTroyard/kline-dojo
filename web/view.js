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
  let maS = {}, bollS = {}, macdS = {}, kdjS = {};
  let overlay = null;
  let insts = [];
  let curKey = null, curName = '';
  let rawBars = [];                       // 全量日线
  let period = localStorage.getItem('bz_view_period') || 'D';
  const toggles = Object.assign(
    { ma: true, boll: false, macd: true, kdj: false, vol: true, chan: false, duan: false, bei: false },
    JSON.parse(localStorage.getItem('bz_view_toggles') || '{}'));

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
    chart.priceScale('vol').applyOptions({
      scaleMargins: { top: 0.70, bottom: 0.22 }, visible: false,
    });

    maS = {};
    for (const m of MA_DEFS) {
      maS[m.p] = chart.addLineSeries({
        color: m.color, lineWidth: 1, title: `MA${m.p}`,
        priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
      });
    }
    bollS = {
      mid: chart.addLineSeries({ color: '#f0b90b', lineWidth: 1, lineStyle: 2, title: 'BOLL中轨', priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }),
      up: chart.addLineSeries({ color: '#8892a6', lineWidth: 1, title: 'BOLL上轨', priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }),
      low: chart.addLineSeries({ color: '#8892a6', lineWidth: 1, title: 'BOLL下轨', priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }),
    };
    macdS = {
      hist: chart.addHistogramSeries({ priceScaleId: 'macd', priceLineVisible: false, lastValueVisible: false }),
      dif: chart.addLineSeries({ priceScaleId: 'macd', color: '#e0483e', lineWidth: 1, title: 'DIF', priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }),
      dea: chart.addLineSeries({ priceScaleId: 'macd', color: '#4a90e2', lineWidth: 1, title: 'DEA', priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }),
    };
    chart.priceScale('macd').applyOptions({
      scaleMargins: { top: 0.82, bottom: 0.10 }, visible: false,
    });
    kdjS = {
      k: chart.addLineSeries({ priceScaleId: 'kdj', color: '#f0b90b', lineWidth: 1, title: 'K', priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }),
      d: chart.addLineSeries({ priceScaleId: 'kdj', color: '#4a90e2', lineWidth: 1, title: 'D', priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }),
      j: chart.addLineSeries({ priceScaleId: 'kdj', color: '#c77dff', lineWidth: 1, title: 'J', priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }),
    };
    chart.priceScale('kdj').applyOptions({
      scaleMargins: { top: 0.94, bottom: 0 }, visible: false,
    });

    overlay = new window.Overlay(chart, candle, $('view-chart-wrap'), {
      onModeChange: syncDrawBtns,
      onChange: saveLines,
    });
    chart.subscribeClick((param) => {
      if (overlay.handleClick(param)) saveLines();
    });
    chart.subscribeCrosshairMove((param) => updateLegend(param));
    window.__bzView = { chart, overlay };   // 调试/自动化测试用

    // 遮住副图区背后的主轴刻度（外推负值会误导）；主题重建时先清旧的
    $('view-chart-wrap').querySelectorAll('.axis-cover').forEach((e) => e.remove());
    const cover = document.createElement('div');
    cover.className = 'axis-cover';
    $('view-chart-wrap').appendChild(cover);
    const fitCover = () => { cover.style.width = (chart.priceScale('right').width() + 2) + 'px'; };
    fitCover();
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(fitCover).observe($('view-chart'));

    applyToggles();
  }

  /** 画线工具按钮高亮与 overlay.mode 同步（含画完线自动复位 none 的场景） */
  function syncDrawBtns() {
    document.querySelectorAll('[data-draw]').forEach((x) => {
      x.classList.toggle('on', x.dataset.draw === overlay.mode);
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
      bollS.mid.setData(line(bo.mid));
      bollS.up.setData(line(bo.up));
      bollS.low.setData(line(bo.low));
    } else {
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
    vis(bollS.mid, toggles.boll); vis(bollS.up, toggles.boll); vis(bollS.low, toggles.boll);
    vis(macdS.hist, toggles.macd); vis(macdS.dif, toggles.macd); vis(macdS.dea, toggles.macd);
    vis(kdjS.k, toggles.kdj); vis(kdjS.d, toggles.kdj); vis(kdjS.j, toggles.kdj);
    vis(volS, toggles.vol);
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
    const maTxt = MA_DEFS
      .map((m) => {
        const v = window.Ind.sma(closes, m.p)[idx];
        return v == null ? '' : `MA${m.p} ${v.toFixed(1)}`;
      }).filter(Boolean).join('  ');
    el.innerHTML =
      `<b style="color:${chg >= 0 ? T.up : T.down}">${curName} ${b.d}</b> ` +
      `开${b.o.toFixed(2)} 高${b.h.toFixed(2)} 低${b.l.toFixed(2)} 收${b.c.toFixed(2)} ` +
      `<span style="color:${chg >= 0 ? T.up : T.down}">${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%</span>` +
      (toggles.ma ? `  <span style="color:${T.dim}">${maTxt}</span>` : '');
  }

  /* ---------------- 列表 / 选指 / 刷新 ---------------- */
  async function loadList() {
    const d = await fetch('/api/index/list').then((r) => r.json());
    insts = d.instruments || [];
    renderList();
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

  async function select(key) {
    curKey = key;
    const it = insts.find((x) => x.key === key);
    curName = it ? it.name : key;
    document.querySelectorAll('.list-item').forEach((e) => e.classList.toggle('active', e.dataset.key === key));
    $('view-title').textContent = `${curName} 加载中…`;
    try {
      const d = await fetch('/api/index/kline?key=' + encodeURIComponent(key)).then((r) => r.json());
      if (d.error) throw new Error(d.error);
      rawBars = d.bars.map((b) => ({ d: b[0], o: b[1], h: b[2], l: b[3], c: b[4], v: b[5] }));
      overlay.setLines(loadLines());
      renderAll();
    } catch (e) {
      $('view-title').textContent = `${curName} 加载失败：${e.message}`;
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
    } finally {
      btn.disabled = false;
      btn.textContent = '⟳ 同步数据';
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
    $('view-tpl-sel').innerHTML = '<option value="">模板…</option>' +
      Object.keys(tpls()).map((k) => `<option value="${k}">${k}</option>`).join('');
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

    // 图表模板
    refreshTplSel();
    $('view-tpl-save').onclick = () => {
      window.bzPrompt('模板名称：', '', (name) => {
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
    $('nav-train').onclick = () => switchTab('train');
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
      if (!insts.length) loadList().then(() => { if (!curKey && insts.length) select('sh000300'); });
    }
  }

  function init() {
    if (inited) return;
    inited = true;
    bind();
    // 主题切换：重建图表（配色/画线 canvas 跟随新主题）
    window.BzTheme.onChange(() => {
      if (!inited) return;
      if (chart) {
        buildChart();
        overlay.setLines(loadLines());
        if (rawBars.length) renderAll();
      }
    });
  }

  return { init };
})();
