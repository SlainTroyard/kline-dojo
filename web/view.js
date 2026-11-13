/* 图表工作台公共套件 (BzChartKit) + 指数/行情看板引擎 (createBoard)
 *
 * 架构说明：
 * 1. BzChartKit 统一封装训练页、指数看板、行情板共用的：
 *    - 多面板图表创建与可视区间/十字光标联动（主图 + BOLL/VOL/MACD/KDJ 四副图）
 *    - O(1) 指标计算缓存（消除十字光标移动时的全量重算性能瓶颈）
 *    - 顶部等宽数字图例渲染（updateLegend）
 *    - 均线勾选菜单（buildMaMenu）、画线样式浮层及选中态回显（buildDrawStylePop）
 *    - 图表模板 CRUD（bindTemplates）与结算净值对比曲线绘制（drawEquityCurve）
 * 2. createBoard 基于 BzChartKit 实例化「指数看板 (View)」与「行情看板 (Mkt)」。
 */
'use strict';

/* 分钟 bar 的 d 是北京时间墙上时间，lightweight-charts 却按 UTC 渲染数字时间。
 * 解析时补 Z，把墙上时间当成 UTC，坐标轴/十字光标便显示 24 小时制的北京时间；
 * 这样也避免浏览器时区不是 UTC+8 时整体偏移。 */
const barTs = (s) => Math.floor(Date.parse(s.replace(' ', 'T') + 'Z') / 1000);

window.BzChartKit = (() => {
  const AXIS_W = 62;
  const DRAW_COLORS = ['#f0b90b', '#e0483e', '#4a90e2', '#1fa06b', '#c77dff', '#e6ebf4'];

  function loadToggles(key, defaults) {
    const base = Object.assign(
      { maSel: null, boll: false, macd: true, kdj: false, vol: true, chip: false, chan: false, duan: false, bei: false },
      defaults || {}
    );
    let obj = base;
    try { obj = Object.assign(base, JSON.parse(localStorage.getItem(key) || '{}')); }
    catch { obj = base; }
    if (!Array.isArray(obj.maSel)) {
      obj.maSel = obj.ma === false ? [] : window.BzTheme.MA_DEFAULT.slice();
    }
    delete obj.ma;
    return obj;
  }

  const fmtVol = (v) => v >= 1e8 ? (v / 1e8).toFixed(2) + '亿'
    : v >= 1e4 ? (v / 1e4).toFixed(2) + '万' : String(Math.round(v));

  /** 构建 MA 周期勾选浮层（训练/指数/行情三处共用） */
  function buildMaMenu({ btnEl, menuEl, getMaSel, onChange }) {
    if (!menuEl || !btnEl) return { sync() {} };
    const MA_DEFS = window.BzTheme.MA_DEFS;
    menuEl.textContent = '';
    for (const m of MA_DEFS) {
      const lab = document.createElement('label');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.dataset.ma = String(m.p);
      cb.checked = getMaSel().includes(m.p);
      cb.onchange = () => {
        const cur = getMaSel();
        const next = cb.checked
          ? [...new Set([...cur, m.p])].sort((a, b) => a - b)
          : cur.filter((p) => p !== m.p);
        onChange(next);
      };
      const dot = document.createElement('i');
      dot.dataset.ma = String(m.p);
      dot.style.background = window.BzTheme.maColor(m.p, m.color);
      lab.append(cb, dot, document.createTextNode(`MA${m.p}`));
      menuEl.appendChild(lab);
    }
    btnEl.onclick = (e) => { e.stopPropagation(); menuEl.classList.toggle('hidden'); };
    if (!menuEl._boundGlobal) {
      menuEl._boundGlobal = true;
      document.addEventListener('click', (e) => {
        if (!menuEl.classList.contains('hidden') && !menuEl.contains(e.target) && e.target !== btnEl) {
          menuEl.classList.add('hidden');
        }
      });
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') menuEl.classList.add('hidden');
      });
    }
    return {
      sync() {
        const on = new Set(getMaSel());
        btnEl.classList.toggle('on', on.size > 0);
        menuEl.querySelectorAll('input[data-ma]').forEach((cb) => {
          cb.checked = on.has(Number(cb.dataset.ma));
        });
        menuEl.querySelectorAll('i[data-ma]').forEach((dot) => {
          const m = MA_DEFS.find((x) => String(x.p) === dot.dataset.ma);
          if (m) dot.style.background = window.BzTheme.maColor(m.p, m.color);
        });
      },
    };
  }

  /** 构建画线样式浮层（支持当前颜色/粗细/虚实高亮回显） */
  function buildDrawStylePop({ btnEl, popEl, getOverlay }) {
    if (!popEl || !btnEl) return { sync() {} };
    popEl.innerHTML =
      `<div class="ds-row"><span class="ds-lab">颜色</span><span class="ds-colors">` +
      DRAW_COLORS.map((c) => `<button class="ds-c" data-color="${c}" style="background:${c}" title="${c}"></button>`).join('') +
      `</span></div>` +
      `<div class="ds-row"><span class="ds-lab">粗细</span>` +
      `<button class="ds-b" data-width="1">细</button>` +
      `<button class="ds-b" data-width="1.6">中</button>` +
      `<button class="ds-b" data-width="2.6">粗</button></div>` +
      `<div class="ds-row"><span class="ds-lab">线型</span>` +
      `<button class="ds-b" data-dash="0">实线</button>` +
      `<button class="ds-b" data-dash="1">虚线</button></div>` +
      `<div class="ds-row"><button class="ds-del" data-del="1">删除选中线</button></div>`;

    const sync = (st) => {
      const ov = getOverlay();
      const s = st || (ov && ov.getActiveStyle ? ov.getActiveStyle() : null);
      if (!s) return;
      const curCol = String(s.color || '').toLowerCase();
      popEl.querySelectorAll('.ds-c').forEach((b) => {
        b.classList.toggle('active', b.dataset.color.toLowerCase() === curCol);
      });
      popEl.querySelectorAll('.ds-b[data-width]').forEach((b) => {
        b.classList.toggle('active', Math.abs(Number(b.dataset.width) - Number(s.width || 1.6)) < 0.15);
      });
      popEl.querySelectorAll('.ds-b[data-dash]').forEach((b) => {
        b.classList.toggle('active', (b.dataset.dash === '1') === !!s.dash);
      });
      const delBtn = popEl.querySelector('.ds-del');
      if (delBtn) delBtn.disabled = !s.hasSelected;
    };

    popEl.onclick = (e) => {
      const t = e.target.closest('button');
      const ov = getOverlay();
      if (!t || !ov) return;
      e.stopPropagation();
      if (t.dataset.color) ov.setStyle({ color: t.dataset.color });
      else if (t.dataset.width) ov.setStyle({ width: Number(t.dataset.width) });
      else if (t.dataset.dash) ov.setStyle({ dash: t.dataset.dash === '1' });
      else if (t.dataset.del) ov.deleteSelected();
      sync();
    };
    btnEl.onclick = (e) => {
      e.stopPropagation();
      popEl.classList.toggle('hidden');
      if (!popEl.classList.contains('hidden')) sync();
    };
    if (!popEl._boundGlobal) {
      popEl._boundGlobal = true;
      document.addEventListener('click', (e) => {
        if (!popEl.classList.contains('hidden') && !popEl.contains(e.target) && e.target !== btnEl) {
          popEl.classList.add('hidden');
        }
      });
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') popEl.classList.add('hidden');
      });
    }
    return { sync };
  }

  /** 绑定图表模板下拉与保存/删除按钮 */
  function bindTemplates({ storageKey, selEl, saveBtn, delBtn, getState, onApply }) {
    if (!selEl || !saveBtn || !delBtn) return;
    const loadMap = () => {
      try { return JSON.parse(localStorage.getItem(storageKey) || '{}'); }
      catch { return {}; }
    };
    const refreshSel = () => {
      selEl.textContent = '';
      for (const k of ['', ...Object.keys(loadMap())]) {
        const o = document.createElement('option');
        o.value = k;
        o.textContent = k || '模板…';
        selEl.appendChild(o);
      }
    };
    refreshSel();
    saveBtn.onclick = () => {
      window.bzPrompt('模板名称：', '', (name) => {
        name = (name || '').slice(0, 40);
        if (!name) return;
        const m = loadMap();
        m[name] = getState();
        localStorage.setItem(storageKey, JSON.stringify(m));
        refreshSel();
        selEl.value = name;
      });
    };
    delBtn.onclick = () => {
      const name = selEl.value;
      if (!name) return;
      const m = loadMap();
      delete m[name];
      localStorage.setItem(storageKey, JSON.stringify(m));
      refreshSel();
    };
    selEl.onchange = () => {
      const t = loadMap()[selEl.value];
      if (t) onApply(t);
    };
  }

  /**
   * 多面板图表工作台：封装主面板 + BOLL/VOL/MACD/KDJ 四副图 + O(1) 指标缓存 + 十字光标与图例联动
   * @param opts {
   *   ids: { chart, paneMain, paneBoll, paneVol, paneMacd, paneKdj, bollChart, volChart, macdChart, kdjChart, legend, chip },
   *   rightOffset?: number,
   *   blindMode?: boolean,          // 训练页双盲模式：不显示标的名称与日期，主图不回退显示时间轴
   *   timeOf: (bar) => number|string,
   *   getTitle?: (bar) => string,   // 图例首段标题（如 "沪深300 2025-01-02"）
   *   onRangeChange?: (range) => void,
   *   onOverlayModeChange?: (mode) => void,
   *   onOverlayChange?: () => void,
   *   onOverlayStyleChange?: (st) => void,
   * }
   */
  function createWorkbench(opts) {
    const ids = opts.ids;
    const rightOffset = opts.rightOffset || 6;
    const timeOf = opts.timeOf || ((b) => (b.t != null ? b.t : b.d));
    const MA_DEFS = window.BzTheme.MA_DEFS;

    let chart = null, candle = null;
    let bollChart = null, volChart = null, macdChart = null, kdjChart = null;
    let maS = {}, bollS = {}, bollBar = null, volS = null, macdS = {}, kdjS = {};
    let overlay = null, chip = null;
    let curBars = [];
    let curToggles = null;
    let isMinute = false;
    let indCache = { timeIdxMap: new Map(), ma: {}, boll: null, macd: null, kdj: null };

    function mkSubPane(elId) {
      const T = window.BzTheme.colors();
      return LightweightCharts.createChart(document.getElementById(elId), {
        layout: { background: { color: T.panel }, textColor: T.dim, fontSize: 10 },
        grid: { vertLines: { color: T.grid }, horzLines: { color: T.grid } },
        rightPriceScale: {
          borderColor: T.line, minimumWidth: AXIS_W, maximumWidth: AXIS_W,
          scaleMargins: { top: 0.12, bottom: 0.08 },
        },
        timeScale: { borderColor: T.line, visible: false, rightOffset },
        crosshair: { mode: 0 },
        autoSize: true,
        handleScroll: false, handleScale: false,
      });
    }

    function build() {
      for (const c of [chart, volChart, bollChart, macdChart, kdjChart]) {
        if (c) c.remove();
      }
      chart = bollChart = volChart = macdChart = kdjChart = null;
      const T = window.BzTheme.colors();

      chart = LightweightCharts.createChart(document.getElementById(ids.chart), {
        layout: { background: { color: T.panel }, textColor: T.dim, fontSize: 12 },
        grid: { vertLines: { color: T.grid }, horzLines: { color: T.grid } },
        rightPriceScale: {
          borderColor: T.line, minimumWidth: AXIS_W, maximumWidth: AXIS_W,
          scaleMargins: { top: 0.08, bottom: 0.05 },
        },
        timeScale: { borderColor: T.line, visible: false, rightOffset },
        crosshair: { mode: 0 },
        autoSize: true,
      });
      candle = chart.addCandlestickSeries({
        upColor: T.up, downColor: T.down, borderUpColor: T.up, borderDownColor: T.down,
        wickUpColor: T.up, wickDownColor: T.down,
      });
      maS = {};
      for (const m of MA_DEFS) {
        maS[m.p] = chart.addLineSeries({
          color: window.BzTheme.maColor(m.p, m.color), lineWidth: 1,
          priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
        });
      }

      bollChart = mkSubPane(ids.bollChart);
      bollBar = bollChart.addBarSeries({
        upColor: T.up, downColor: T.down, thinBars: true,
        priceLineVisible: false, lastValueVisible: false,
      });
      bollS = {
        mid: bollChart.addLineSeries({ color: T.bollMid, lineWidth: 1, lineStyle: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }),
        up: bollChart.addLineSeries({ color: T.bollBand, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }),
        low: bollChart.addLineSeries({ color: T.bollBand, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }),
      };

      volChart = mkSubPane(ids.volChart);
      volS = volChart.addHistogramSeries({
        priceFormat: { type: 'volume' }, color: T.volDown,
        priceLineVisible: false, lastValueVisible: false,
      });

      macdChart = mkSubPane(ids.macdChart);
      macdS = {
        hist: macdChart.addHistogramSeries({ priceLineVisible: false, lastValueVisible: false }),
        dif: macdChart.addLineSeries({ color: T.up, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }),
        dea: macdChart.addLineSeries({ color: T.blue, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }),
      };

      kdjChart = mkSubPane(ids.kdjChart);
      kdjS = {
        k: kdjChart.addLineSeries({ color: T.kdjK, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }),
        d: kdjChart.addLineSeries({ color: T.kdjD, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }),
        j: kdjChart.addLineSeries({ color: T.kdjJ, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }),
      };

      overlay = new window.Overlay(chart, candle, document.getElementById(ids.paneMain), {
        onModeChange: opts.onOverlayModeChange,
        onChange: opts.onOverlayChange,
        onStyleChange: opts.onOverlayStyleChange,
      });
      if (!chip && window.ChipProfile && ids.chip) {
        chip = new window.ChipProfile(document.getElementById(ids.chip));
      }
      if (chip) chip.attach(chart, candle);

      let syncingVR = false;
      chart.timeScale().subscribeVisibleLogicalRangeChange((r) => {
        if (opts.onRangeChange) opts.onRangeChange(r);
        if (r && !syncingVR) {
          syncingVR = true;
          for (const c of [bollChart, volChart, macdChart, kdjChart]) {
            try { c.timeScale().setVisibleLogicalRange(r); } catch { /* ignore empty */ }
          }
          syncingVR = false;
        }
      });
      chart.subscribeClick((param) => {
        if (overlay.handleClick(param) && opts.onOverlayChange) opts.onOverlayChange();
      });
      chart.subscribeCrosshairMove((param) => updateLegend(param));

      return { chart, candle, overlay, chip };
    }

    /** 时间轴归属：挂在最底部的可见副图；若副图全关且非双盲模式，则挂回主图（修复副图全关无时间轴 Bug） */
    function refreshAxisOwner(toggles, minute = false) {
      if (!chart) return;
      isMinute = !!minute;
      const tg = toggles || curToggles || {};
      const order = [
        [bollChart, tg.boll], [volChart, tg.vol],
        [macdChart, tg.macd], [kdjChart, tg.kdj],
      ];
      let owner = null;
      for (const [c, on] of order) if (on) owner = c;
      for (const [c] of order) {
        if (c) c.timeScale().applyOptions({ visible: !opts.blindMode && c === owner, timeVisible: isMinute, secondsVisible: false });
      }
      chart.timeScale().applyOptions({
        visible: !opts.blindMode && owner === null,
        timeVisible: isMinute,
        secondsVisible: false,
      });
    }

    /** 灌入指标数据并构建 O(1) 指标查询缓存 */
    function refillIndicators(bars, toggles) {
      curBars = bars || [];
      curToggles = toggles || curToggles || {};
      const tg = curToggles;
      const closes = curBars.map((b) => b.c);
      const timeIdxMap = new Map();
      for (let i = 0; i < curBars.length; i++) timeIdxMap.set(timeOf(curBars[i]), i);

      const line = (arr) => arr.map((v, i) => (v == null ? null : { time: timeOf(curBars[i]), value: v })).filter(Boolean);
      const on = new Set(tg.maSel || []);
      const maMap = {};
      for (const m of MA_DEFS) {
        if (on.has(m.p) && curBars.length) {
          const arr = window.Ind.sma(closes, m.p);
          maMap[m.p] = arr;
          maS[m.p].setData(line(arr));
        } else {
          maS[m.p].setData([]);
        }
      }

      let bo = null, mc = null, kj = null;
      if (tg.boll && curBars.length) {
        bo = window.Ind.boll(closes);
        bollBar.setData(curBars.map((b) => ({ time: timeOf(b), open: b.o, high: b.h, low: b.l, close: b.c })));
        bollS.mid.setData(line(bo.mid));
        bollS.up.setData(line(bo.up));
        bollS.low.setData(line(bo.low));
      } else {
        bollBar.setData([]);
        bollS.mid.setData([]); bollS.up.setData([]); bollS.low.setData([]);
      }

      if (tg.macd && curBars.length) {
        const T = window.BzTheme.colors();
        mc = window.Ind.macd(closes);
        macdS.hist.setData(mc.hist.map((v, i) => ({
          time: timeOf(curBars[i]), value: v, color: v >= 0 ? T.macdUp : T.macdDown,
        })));
        macdS.dif.setData(mc.dif.map((v, i) => ({ time: timeOf(curBars[i]), value: v })));
        macdS.dea.setData(mc.dea.map((v, i) => ({ time: timeOf(curBars[i]), value: v })));
      } else {
        macdS.hist.setData([]); macdS.dif.setData([]); macdS.dea.setData([]);
      }

      if (tg.kdj && curBars.length) {
        kj = window.Ind.kdj(curBars);
        kdjS.k.setData(kj.k.map((v, i) => ({ time: timeOf(curBars[i]), value: v })));
        kdjS.d.setData(kj.d.map((v, i) => ({ time: timeOf(curBars[i]), value: v })));
        kdjS.j.setData(kj.j.map((v, i) => ({ time: timeOf(curBars[i]), value: v })));
      } else {
        kdjS.k.setData([]); kdjS.d.setData([]); kdjS.j.setData([]);
      }

      indCache = { timeIdxMap, ma: maMap, boll: bo, macd: mc, kdj: kj };
    }

    /** 显隐各面板与均线 series */
    function applyPaneVisibility(toggles, minute = false) {
      curToggles = toggles || curToggles || {};
      const tg = curToggles;
      const on = new Set(tg.maSel || []);
      for (const m of MA_DEFS) {
        if (maS[m.p]) maS[m.p].applyOptions({ visible: on.has(m.p) });
      }
      const visPane = (id, flag) => {
        const el = document.getElementById(id);
        if (el) el.classList.toggle('hidden', !flag);
      };
      visPane(ids.paneBoll, tg.boll);
      visPane(ids.paneVol, tg.vol);
      visPane(ids.paneMacd, tg.macd);
      visPane(ids.paneKdj, tg.kdj);
      refreshAxisOwner(tg, minute);
      if (chip) chip.setVisible(!!tg.chip);
    }

    /** O(1) 十字光标图例渲染与副图光标同步（消除 mousemove 全量重算） */
    function updateLegend(param) {
      const el = document.getElementById(ids.legend);
      if (!el) return;
      if (!curBars.length || !curToggles) { el.textContent = ''; return; }
      const T = window.BzTheme.colors();
      const tg = curToggles;
      let idx = curBars.length - 1;
      if (param && param.time != null && indCache.timeIdxMap) {
        const hit = indCache.timeIdxMap.get(param.time);
        if (hit != null) idx = hit;
      }
      const b = curBars[idx];
      const chg = idx > 0 ? (b.c / curBars[idx - 1].c - 1) * 100 : 0;
      const sec = (txt, color) => txt ? `<span class="lg" style="color:${color}">${txt}</span>` : '';

      const titlePrefix = opts.getTitle ? opts.getTitle(b) : '';
      let html =
        `<span class="lg">` +
        (titlePrefix ? `<b style="color:${chg >= 0 ? T.up : T.down}">${titlePrefix}</b> ` : '') +
        `开<b>${b.o.toFixed(2)}</b> 高<b>${b.h.toFixed(2)}</b> 低<b>${b.l.toFixed(2)}</b> 收<b>${b.c.toFixed(2)}</b> ` +
        `<b style="color:${chg >= 0 ? T.up : T.down}">${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%</b></span>`;

      if (tg.maSel && tg.maSel.length) {
        const on = new Set(tg.maSel);
        const maParts = MA_DEFS.filter((m) => on.has(m.p)).map((m) => {
          const arr = indCache.ma[m.p];
          const v = arr ? arr[idx] : null;
          if (v == null) return '';
          const col = window.BzTheme.maColor(m.p, m.color);
          return `<span style="color:${col}">MA${m.p}</span> <b>${v.toFixed(1)}</b>`;
        }).filter(Boolean);
        if (maParts.length) html += `<span class="lg" style="color:${T.dim}">${maParts.join(' ')}</span>`;
      }

      const xv = {};
      if (tg.vol) {
        xv.vol = b.v;
        html += sec(`VOL <b>${fmtVol(b.v)}</b>`, b.c >= b.o ? T.up : T.down);
      }
      if (tg.macd && indCache.macd) {
        const mc = indCache.macd;
        const d = mc.dif[idx], e = mc.dea[idx], h = mc.hist[idx];
        xv.dif = d;
        if (d != null && e != null) {
          html += sec(
            `MACD <b style="color:${T.up}">${d.toFixed(2)}</b> ` +
            `<b style="color:${T.blue}">${e.toFixed(2)}</b> ` +
            `<b style="color:${h >= 0 ? T.up : T.down}">${h.toFixed(2)}</b>`,
            T.dim
          );
        }
      }
      if (tg.kdj && indCache.kdj) {
        const kj = indCache.kdj;
        xv.k = kj.k[idx];
        if (xv.k != null) {
          html += sec(
            `K <b style="color:${T.kdjK}">${kj.k[idx].toFixed(1)}</b> ` +
            `D <b style="color:${T.kdjD}">${kj.d[idx].toFixed(1)}</b> ` +
            `J <b style="color:${T.kdjJ}">${kj.j[idx].toFixed(1)}</b>`,
            T.dim
          );
        }
      }
      if (tg.boll && indCache.boll) {
        const bo = indCache.boll;
        xv.bollMid = bo.mid[idx];
        if (xv.bollMid != null) {
          html += sec(
            `BOLL <b style="color:${T.bollMid}">${bo.mid[idx].toFixed(2)}</b> ` +
            `<b style="color:${T.bollBand}">${bo.up[idx].toFixed(2)}</b> ` +
            `<b style="color:${T.bollBand}">${bo.low[idx].toFixed(2)}</b>`,
            T.dim
          );
        }
      }
      el.innerHTML = html;

      // 主面板十字光标 → 各副图面板（BOLL 副图定位到收盘价 b.c）
      const tk = timeOf(b);
      const setX = (c, series, v) => {
        if (!c || !series) return;
        if (param && param.time != null && v != null) c.setCrosshairPosition(v, tk, series);
        else c.clearCrosshairPosition();
      };
      setX(bollChart, bollBar, xv.bollMid != null ? b.c : null);
      setX(volChart, volS, tg.vol ? xv.vol : null);
      setX(macdChart, macdS.dif, xv.dif);
      setX(kdjChart, kdjS.k, xv.k);
    }

    /** 灌入完整 bars 数据（K线+成交量+副图指标+缠论+筹码） */
    function renderBars(bars, toggles, minute = false) {
      if (!chart) return;
      const T = window.BzTheme.colors();
      curBars = bars || [];
      curToggles = toggles || curToggles || {};
      candle.setData(curBars.map((b) => ({ time: timeOf(b), open: b.o, high: b.h, low: b.l, close: b.c })));
      volS.setData(curToggles.vol ? curBars.map((b) => ({
        time: timeOf(b), value: b.v,
        color: b.c >= b.o ? T.volUp : T.volDown,
      })) : []);
      refreshAxisOwner(curToggles, minute);
      refillIndicators(curBars, curToggles);
      if (overlay) {
        overlay.setBars(curBars);
        overlay.setChan(window.Ind.chanView(curBars, curToggles));
      }
      if (chip) chip.setBars(curBars);
    }

    function clearAll() {
      if (!chart) return;
      curBars = [];
      indCache = { timeIdxMap: new Map(), ma: {}, boll: null, macd: null, kdj: null };
      candle.setData([]);
      volS.setData([]);
      for (const m of MA_DEFS) maS[m.p].setData([]);
      bollBar.setData([]);
      bollS.mid.setData([]); bollS.up.setData([]); bollS.low.setData([]);
      macdS.hist.setData([]); macdS.dif.setData([]); macdS.dea.setData([]);
      kdjS.k.setData([]); kdjS.d.setData([]); kdjS.j.setData([]);
      if (overlay) {
        overlay.setBars([]);
        overlay.setLines([]);
        overlay.setChan(null);
      }
      if (chip) chip.setBars([]);
      const el = document.getElementById(ids.legend);
      if (el) el.textContent = '';
    }

    return {
      build,
      renderBars,
      refillIndicators,
      applyPaneVisibility,
      updateLegend,
      clearAll,
      get chart() { return chart; },
      get candle() { return candle; },
      get overlay() { return overlay; },
      get chip() { return chip; },
    };
  }

  /**
   * 绘制结算页/复盘页「账户收益率 vs 持有不动基准」对比曲线
   * @param canvas HTMLCanvasElement
   * @param eqList [{i, equity}] 或 [[i, equity]]
   * @param bars   原始 bars（对象 {c} 或数组 [o,h,l,c,v]）
   * @param histIdx 训练起点前一根下标 (S.history - 1)
   * @param capital 初始资金
   */
  function drawEquityCurve(canvas, eqList, bars, histIdx, capital) {
    if (!canvas || !eqList || !eqList.length || !bars || !bars.length) return;
    const box = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(box.width) || 520;
    const h = Math.round(box.height) || 120;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const T = window.BzTheme.colors();
    const closeAt = (idx) => {
      const b = bars[Math.max(0, Math.min(bars.length - 1, idx))];
      return Array.isArray(b) ? b[3] : b.c;
    };
    const basePrice = closeAt(histIdx) || 1;
    const cap = capital || 100000;

    const pts = eqList.map((item) => {
      const i = Array.isArray(item) ? item[0] : item.i;
      const eq = Array.isArray(item) ? item[1] : item.equity;
      const ret = (eq / cap - 1) * 100;
      const bm = (closeAt(i) / basePrice - 1) * 100;
      return { i, ret, bm };
    });

    let lo = 0, hi = 0;
    for (const p of pts) {
      if (p.ret < lo) lo = p.ret;
      if (p.ret > hi) hi = p.ret;
      if (p.bm < lo) lo = p.bm;
      if (p.bm > hi) hi = p.bm;
    }
    const padPct = Math.max(1.5, (hi - lo) * 0.12);
    lo -= padPct;
    hi += padPct;
    const span = (hi - lo) || 1;

    const padL = 6, padR = 52, padT = 8, padB = 8;
    const plotW = Math.max(10, w - padL - padR);
    const plotH = Math.max(10, h - padT - padB);
    const X = (k) => padL + (pts.length > 1 ? (k / (pts.length - 1)) * plotW : plotW / 2);
    const Y = (val) => padT + (1 - (val - lo) / span) * plotH;

    // 0% 基准水平虚线
    const y0 = Y(0);
    ctx.strokeStyle = T.line;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(padL, y0);
    ctx.lineTo(padL + plotW, y0);
    ctx.stroke();
    ctx.setLineDash([]);

    // 持有不动基准曲线（虚线或浅色细线）
    ctx.strokeStyle = T.dim;
    ctx.lineWidth = 1.3;
    ctx.globalAlpha = 0.75;
    ctx.beginPath();
    pts.forEach((p, k) => {
      const x = X(k), y = Y(p.bm);
      if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.globalAlpha = 1;

    // 账户净值曲线及下方微渐变填充
    ctx.beginPath();
    pts.forEach((p, k) => {
      const x = X(k), y = Y(p.ret);
      if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = T.accent;
    ctx.lineWidth = 2;
    ctx.stroke();

    if (pts.length > 1) {
      ctx.save();
      ctx.lineTo(X(pts.length - 1), y0);
      ctx.lineTo(X(0), y0);
      ctx.closePath();
      ctx.fillStyle = T.accent;
      ctx.globalAlpha = 0.10;
      ctx.fill();
      ctx.restore();
    }

    // 右侧刻度标签（最高 / 0% / 最低 + 终点值）
    ctx.font = '10px "JetBrains Mono", monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const last = pts[pts.length - 1];
    const fmt = (v) => (v >= 0 ? '+' : '') + v.toFixed(1) + '%';
    ctx.fillStyle = T.dim;
    ctx.fillText('0.0%', padL + plotW + 5, Math.max(10, Math.min(h - 10, y0)));
    const yRet = Math.max(10, Math.min(h - 10, Y(last.ret)));
    ctx.fillStyle = last.ret >= 0 ? T.up : T.down;
    ctx.fillText(fmt(last.ret), padL + plotW + 5, yRet);
  }

  return {
    loadToggles,
    buildMaMenu,
    buildDrawStylePop,
    bindTemplates,
    createWorkbench,
    drawEquityCurve,
  };
})();

/* ============================================================================
 * 看板工厂 createBoard：指数看板 (mode='index') 与 行情看板 (mode='market') 共用
 * ============================================================================ */
window.createBoard = function createBoard(cfg) {
  const P = cfg.mode === 'market' ? 'mkt' : 'view';
  const root = document.getElementById(P === 'mkt' ? 'screen-mkt' : 'screen-view');
  const $ = (suf) => document.getElementById(P + '-' + suf);
  const lsKey = (k) => 'bz_' + P + '_' + k;

  let inited = false;
  let wb = null;
  let maMenuCtrl = null, drawStyleCtrl = null;
  let insts = [];
  let curKey = null, curName = '';
  let rawBars = [];
  let period = localStorage.getItem(lsKey('period')) || 'D';
  const MINUTE_PERIODS = ['5m', '30m'];
  let adjMode = localStorage.getItem(lsKey('adj')) || 'qfq';
  let asof = '';
  let liveTimer = null, liveBusy = false;
  const LIVE_MS = 20000;
  const toggles = window.BzChartKit.loadToggles(lsKey('toggles'));

  /* ---------------- 小地图：全历史缩略条 ---------------- */
  class Minimap {
    constructor() {
      this.cvs = $( 'minimap');
      this.ctx = this.cvs.getContext('2d');
      this.bars = [];
      this.drag = false;
      this.cvs.addEventListener('mousedown', (e) => { this.drag = true; this._jump(e); e.preventDefault(); });
      window.addEventListener('mousemove', (e) => { if (this.drag) this._jump(e); });
      window.addEventListener('mouseup', () => { this.drag = false; });
    }
    attach(chart) { this.chart = chart; }
    setBars(bars) { this.bars = bars || []; this.redraw(); }
    _idxAt(ev) {
      const r = this.cvs.getBoundingClientRect();
      const tsW = (this.chart && this.chart.timeScale().width()) || Math.max(1, r.width - 62);
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
      const tsW = this.chart.timeScale().width() || Math.max(1, w - 62);
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
      const vr = this.chart.timeScale().getVisibleLogicalRange();
      if (vr) {
        const x0 = Math.max(0, (vr.from / Math.max(1, n - 1)) * tsW);
        const x1 = Math.min(tsW, (vr.to / Math.max(1, n - 1)) * tsW);
        ctx.fillStyle = T.accent;
        ctx.globalAlpha = 0.14;
        ctx.fillRect(x0, 0, x1 - x0, h);
        ctx.globalAlpha = 0.75;
        ctx.fillStyle = T.accent;
        ctx.fillRect(x0, 0, 1.5, h);
        ctx.fillRect(Math.max(0, x1 - 1.5), 0, 1.5, h);
        ctx.globalAlpha = 1;
      }
    }
  }
  let minimap = null;

  function syncDrawBtns() {
    if (!wb || !wb.overlay) return;
    const mode = wb.overlay.mode, sticky = !!wb.overlay.sticky;
    root.querySelectorAll('[data-draw]').forEach((x) => {
      const on = x.dataset.draw === mode;
      const cycle = on && mode !== 'select' && mode !== 'del';
      x.classList.toggle('on', on);
      x.classList.toggle('draw-once', cycle && !sticky);
      x.classList.toggle('draw-lock', cycle && sticky);
    });
  }

  function buildChart() {
    if (!minimap) minimap = new Minimap();
    if (!wb) {
      wb = window.BzChartKit.createWorkbench({
        ids: {
          chart: P + '-chart',
          paneMain: P + '-pane-main',
          paneBoll: P + '-pane-boll',
          paneVol: P + '-pane-vol',
          paneMacd: P + '-pane-macd',
          paneKdj: P + '-pane-kdj',
          bollChart: P + '-bollchart',
          volChart: P + '-volchart',
          macdChart: P + '-macdchart',
          kdjChart: P + '-kdjchart',
          legend: P + '-legend',
          chip: P + '-chip',
        },
        rightOffset: 5,
        blindMode: false,
        timeOf: (b) => (b.t != null ? b.t : b.d),
        getTitle: (b) => `${curName} ${b.d}`,
        onRangeChange: () => minimap && minimap.redraw(),
        onOverlayModeChange: syncDrawBtns,
        onOverlayChange: saveLines,
        onOverlayStyleChange: (st) => drawStyleCtrl && drawStyleCtrl.sync(st),
      });
    }
    const { chart, overlay } = wb.build();
    minimap.attach(chart);
    window.__bzView = { chart, overlay, minimap };
    applyToggles();
  }

  function curBars() {
    return MINUTE_PERIODS.includes(period) ? rawBars : window.Ind.aggregate(rawBars, period);
  }

  function renderAll(keepView = false) {
    if (!wb || !wb.chart || !curKey) return;
    if (!rawBars.length) { $('title').textContent = `${curName}：无数据`; return; }
    const prevVR = keepView ? wb.chart.timeScale().getVisibleLogicalRange() : null;
    const isMin = MINUTE_PERIODS.includes(period);
    const bars = curBars();

    wb.renderBars(bars, toggles, isMin);
    minimap && minimap.setBars(bars);

    wb.chart.timeScale().setVisibleLogicalRange(prevVR || {
      from: Math.max(0, bars.length - 260),
      to: Math.min(bars.length + 5, bars.length + 8),
    });
    wb.updateLegend(null);

    const pn = { '5m': '5分', '30m': '30分', D: '日K', W: '周K', M: '月K', Y: '年K' }[period];
    const scope = isMin
      ? `${rawBars[0].d.slice(0, 10)} ~ ${rawBars[rawBars.length - 1].d.slice(0, 10)}`
      : `${rawBars[0].d} ~ ${rawBars[rawBars.length - 1].d}`;
    const cnt = isMin ? `${pn} ${rawBars.length} 根（限最近）`
      : period === 'D' ? `日K ${bars.length} 根`
        : `日线 ${rawBars.length} 根 · ${pn} ${bars.length} 根`;
    // 分钟数据的最新时间戳是「当前 bar 的结束标签」，盘中会大于墙上时间；
    // 标成「最新 bar」并注明进行中，避免误读成未来数据。
    let liveTxt = '';
    if (cfg.mode === 'market' && asof) {
      if (isMin) {
        const asofHM = asof.slice(11, 16);
        const nd = new Date(Date.now() + 8 * 3600 * 1000);
        const p2 = (n) => String(n).padStart(2, '0');
        const today = `${nd.getUTCFullYear()}-${p2(nd.getUTCMonth() + 1)}-${p2(nd.getUTCDate())}`;
        const nowHM = `${p2(nd.getUTCHours())}:${p2(nd.getUTCMinutes())}`;
        const forming = asof.slice(0, 10) === today && asofHM >= nowHM;
        liveTxt = ` · 最新 ${pn} ${asofHM}${forming ? '（进行中）' : ''}`;
      } else {
        liveTxt = ` · 数据截至 ${asof.slice(0, 10)}`;
      }
    }
    $('title').textContent = `${curName}（${scope} · ${cnt}${liveTxt}）`;
  }

  /* ---------------- 盘中实时 K 线 ---------------- */
  let liveFast = true;

  function sameBar(a, b) {
    return a.d === b.d && a.o === b.o && a.h === b.h && a.l === b.l &&
      a.c === b.c && a.v === b.v;
  }

  function mergeDailyLive(bar) {
    if (!Array.isArray(bar) || bar.length < 6) return false;
    const [d, o, h, l, c, v] = bar;
    if (!d || !(o > 0) || !(h > 0) || !(l > 0) || !(c > 0)) return false;
    const last = rawBars[rawBars.length - 1];
    if (!last || d < last.d) return false;
    const nb = { d, o: +o, h: +h, l: +l, c: +c, v: +v };
    if (d === last.d) {
      if (sameBar(last, nb)) return false;
      rawBars[rawBars.length - 1] = nb;
    } else {
      rawBars.push(nb);
    }
    return true;
  }

  function mergeMinuteLive(bars) {
    if (!Array.isArray(bars) || !bars.length || !rawBars.length) return false;
    const idx = new Map(rawBars.map((b, i) => [b.d, i]));
    let changed = false;
    for (const row of bars) {
      if (!Array.isArray(row) || row.length < 6) continue;
      const [d, o, h, l, c, v] = row;
      if (!d || !(o > 0) || !(h > 0) || !(l > 0) || !(c > 0)) continue;
      const nb = { d, o: +o, h: +h, l: +l, c: +c, v: +v };
      if (d.length > 10) nb.t = barTs(d);
      const i = idx.get(d);
      if (i != null) {
        if (sameBar(rawBars[i], nb)) continue;
        rawBars[i] = nb;
        changed = true;
      } else if (d > rawBars[rawBars.length - 1].d) {
        rawBars.push(nb);
        idx.set(d, rawBars.length - 1);
        changed = true;
      }
    }
    return changed;
  }

  async function refreshLive() {
    if (liveBusy || !curKey || !rawBars.length) return;
    if (document.hidden || root.classList.contains('hidden')) return;
    const minute = MINUTE_PERIODS.includes(period);
    if (minute && cfg.mode !== 'market') return;
    const key = curKey, seq = selSeq;
    const url = minute
      ? `/api/market/live?code=${encodeURIComponent(key)}&freq=${period}`
      : (cfg.mode === 'market'
        ? `/api/market/live?code=${encodeURIComponent(key)}`
        : `/api/index/live?key=${encodeURIComponent(key)}`);
    liveBusy = true;
    try {
      const d = await fetch(url, { cache: 'no-store' }).then((r) => r.json());
      if (seq !== selSeq || key !== curKey || d.error) return;
      if (d.asof) asof = d.asof;
      if (typeof d.trading === 'boolean') liveFast = d.trading;
      // 追加新 bar 时若视图停在右缘，跟着右移同样的根数；
      // 否则新 bar 会落在视口外，看起来像行情没跟上。
      const ts = wb && wb.chart ? wb.chart.timeScale() : null;
      const beforeLen = curBars().length;
      const vr0 = ts ? ts.getVisibleLogicalRange() : null;
      const atRight = !!(vr0 && beforeLen && vr0.to >= beforeLen - 2);
      const changed = minute ? mergeMinuteLive(d.bars) : mergeDailyLive(d.bar);
      if (changed) {
        renderAll(true);
        const delta = curBars().length - beforeLen;
        if (atRight && delta > 0 && ts) {
          const vr = ts.getVisibleLogicalRange();
          if (vr) ts.setVisibleLogicalRange({ from: vr.from + delta, to: vr.to + delta });
        }
      }
    } catch { /* 上游抖动忽略 */ }
    finally { liveBusy = false; }
  }

  function startLive() {
    if (liveTimer) clearTimeout(liveTimer);
    const tick = async () => {
      await refreshLive();
      if (root.classList.contains('hidden')) return;   // 切走 Tab 后停止空转轮询
      const wait = document.hidden ? 60000 : (liveFast ? LIVE_MS : 120000);
      liveTimer = setTimeout(tick, wait);
    };
    liveTimer = setTimeout(tick, LIVE_MS);
  }

  function applyToggles() {
    if (!wb || !wb.chart) return;
    const isMin = MINUTE_PERIODS.includes(period);
    wb.applyPaneVisibility(toggles, isMin);
    maMenuCtrl && maMenuCtrl.sync();
    if (rawBars.length) {
      const bars = curBars();
      wb.refillIndicators(bars, toggles);
      if (wb.overlay) wb.overlay.setChan(window.Ind.chanView(bars, toggles));
    }
    root.querySelectorAll('[data-tg]').forEach((b) => {
      b.classList.toggle('on', !!toggles[b.dataset.tg]);
    });
    localStorage.setItem(lsKey('toggles'), JSON.stringify(toggles));
  }

  /* ---------------- 列表 / 自选 / 选股 ---------------- */
  let quotes = {};
  let quoteAsOf = '';

  async function loadList() {
    if (cfg.mode === 'market') {
      const wl = window.BzWatchlist.load();
      insts = wl.map((w) => ({ key: w.code, name: w.name, group: '自选' }));
      renderList();
      refreshQuotes();
      return;
    }
    const d = await fetch('/api/index/list').then((r) => r.json());
    insts = d.instruments || [];
    renderList();
  }

  function renderList() {
    const q = ($('search').value || '').trim().toLowerCase();
    const box = $('list');
    box.innerHTML = '';
    if (cfg.mode === 'market') {
      const mk = (it, extra, onDel) => {
        const el = document.createElement('div');
        el.className = 'list-item' + (it.key === curKey ? ' active' : '') + (onDel ? ' has-q' : '');
        el.dataset.key = it.key;
        if (onDel) el.dataset.code = it.key;
        el.innerHTML = onDel
          ? `<span class="n"></span><span class="px"></span>` +
            `<span class="d"></span><span class="pc"></span>` +
            '<span class="rm" title="从自选移除">✕</span>'
          : `<span class="n"></span><span class="d"></span>`;
        el.querySelector('.n').textContent = it.name;
        el.querySelector('.d').textContent = onDel ? it.key : (extra || '');
        el.onclick = () => {
          if (extra === '＋') addToWatchlist(it);
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
          if (($('search').value || '').trim().toLowerCase() !== q) return;
          box.innerHTML = '';
          const hits = d.items || [];
          if (!hits.length) box.innerHTML = '<div class="list-group">无匹配</div>';
          for (const h of hits.slice(0, 30)) {
            mk(
              { key: h.code, name: `${h.name} ${h.code}` },
              window.BzWatchlist.has(h.code) ? '✓' : '＋'
            );
          }
        }).catch(() => {});
        return;
      }
      if (!insts.length) box.innerHTML = '<div class="list-group">自选为空：搜索代码/名称添加</div>';
      for (const it of insts) mk(it, it.key, true);
      paintQuotes();
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
        el.innerHTML = `<span class="n"></span><span class="d"></span>`;
        el.querySelector('.n').textContent = it.name;
        el.querySelector('.d').textContent = it.last ? it.last.slice(2) : (it.cached ? '' : '未缓存');
        el.onclick = () => select(it.key);
        box.appendChild(el);
      }
    }
  }

  async function refreshQuotes() {
    if (cfg.mode !== 'market' || root.classList.contains('hidden')) return;
    const codes = window.BzWatchlist.load().map((w) => w.code).slice(0, 80);
    if (!codes.length) return;
    try {
      const d = await fetch('/api/market/quotes?codes=' + codes.join(',')).then((r) => r.json());
      if (d.error) return;
      quotes = d.quotes || {};
      quoteAsOf = d.asof || '';
      paintQuotes();
    } catch { /* ignore */ }
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

  function removeFromWatchlist(code) {
    window.BzWatchlist.remove(code);
    loadList();
    if (code === curKey) {
      if (insts.length) select(insts[0].key);
      else clearChart();
    }
    refreshQuotes();
  }

  function clearChart() {
    curKey = null;
    rawBars = [];
    wb && wb.clearAll();
    minimap && minimap.setBars([]);
    $('title').textContent = '自选为空：搜索代码/名称添加';
  }

  function addToWatchlist(it) {
    const code = it.key;
    window.BzWatchlist.add(code, it.name);
    const s = $('search');
    if (s.value) s.value = '';
    loadList();
    select(code);
    refreshQuotes();
  }

  function klineUrl(key) {
    if (cfg.mode === 'market') {
      const freq = MINUTE_PERIODS.includes(period) ? period.replace('m', 'min') : 'D';
      return `/api/market/kline?code=${encodeURIComponent(key)}&freq=${freq}&adj=${adjMode}`;
    }
    return '/api/index/kline?key=' + encodeURIComponent(key);
  }

  let selSeq = 0;

  async function select(key) {
    // 从搜索结果点选后回到完整自选列表，避免左侧一直停在搜索结果
    if (cfg.mode === 'market') {
      const s = $('search');
      if (s.value) {
        s.value = '';
        renderList();
      }
    }
    curKey = key;
    const seq = ++selSeq;
    const it = insts.find((x) => x.key === key);
    curName = it ? it.name : key;
    root.querySelectorAll('.list-item').forEach((e) => e.classList.toggle('active', e.dataset.key === key));
    $('title').textContent = `${curName} 加载中…`;
    try {
      const d = await fetch(klineUrl(key)).then((r) => r.json());
      if (seq !== selSeq) return;
      if (d.error) throw new Error(d.error);
      asof = d.asof || '';
      rawBars = d.bars.map((b) => ({
        d: b[0], o: b[1], h: b[2], l: b[3], c: b[4], v: b[5],
        t: b[0].length > 10 ? barTs(b[0]) : null,
      }));
      wb.overlay.setLines(loadLines());
      renderAll();
      refreshLive();
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

  /* ---------------- 画线持久化 ---------------- */
  const lkey = () => lsKey('draw_' + curKey);
  function loadLines() {
    try { return JSON.parse(localStorage.getItem(lkey()) || '[]'); } catch { return []; }
  }
  function saveLines() {
    if (wb && wb.overlay && curKey) {
      localStorage.setItem(lkey(), JSON.stringify(wb.overlay.lines));
    }
  }

  /* ---------------- 初始化与事件绑定 ---------------- */
  function bind() {
    root.querySelectorAll('[data-period]').forEach((b) => {
      b.classList.toggle('on', b.dataset.period === period);
      b.onclick = () => {
        const wasPeriod = period;
        period = b.dataset.period;
        localStorage.setItem(lsKey('period'), period);
        root.querySelectorAll('[data-period]').forEach((x) => x.classList.toggle('on', x === b));
        if (cfg.mode === 'market' &&
            (MINUTE_PERIODS.includes(period) || MINUTE_PERIODS.includes(wasPeriod))) {
          if (curKey) select(curKey);
          return;
        }
        renderAll();
        refreshLive();
      };
    });

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
      b.onclick = () => {
        toggles[b.dataset.tg] = !toggles[b.dataset.tg];
        applyToggles();
        wb && wb.updateLegend(null);
      };
    });

    maMenuCtrl = window.BzChartKit.buildMaMenu({
      btnEl: $('ma-btn'),
      menuEl: $('ma-menu'),
      getMaSel: () => toggles.maSel,
      onChange: (next) => {
        toggles.maSel = next;
        applyToggles();
        wb && wb.updateLegend(null);
      },
    });

    drawStyleCtrl = window.BzChartKit.buildDrawStylePop({
      btnEl: $('draw-style'),
      popEl: $('draw-style-pop'),
      getOverlay: () => wb && wb.overlay,
    });

    root.querySelectorAll('[data-draw]').forEach((b) => {
      if (!b.title.includes('单击单次')) b.title += '（单击单次 / 再点持续 / 第三次取消）';
      b.onclick = () => {
        if (!wb || !wb.overlay) return;
        wb.overlay.toggleMode(b.dataset.draw);
      };
    });

    $('undo').onclick = () => { if (wb && wb.overlay && wb.overlay.undo()) saveLines(); };
    $('redo').onclick = () => { if (wb && wb.overlay && wb.overlay.redo()) saveLines(); };
    $('clear-draw').onclick = () => { if (wb && wb.overlay) { wb.overlay.clearAll(); saveLines(); } };
    if ($('refresh')) $('refresh').onclick = refreshData;
    $('search').oninput = renderList;

    window.BzChartKit.bindTemplates({
      storageKey: 'bz_tpl_' + P,
      selEl: $('tpl-sel'),
      saveBtn: $('tpl-save'),
      delBtn: $('tpl-del'),
      getState: () => ({ period, toggles: { ...toggles } }),
      onApply: (t) => {
        if (t.period) {
          const wasPeriod = period;
          period = t.period;
          localStorage.setItem(lsKey('period'), period);
          root.querySelectorAll('[data-period]').forEach((x) => x.classList.toggle('on', x.dataset.period === period));
          if (cfg.mode === 'market' &&
              (MINUTE_PERIODS.includes(period) || MINUTE_PERIODS.includes(wasPeriod))) {
            Object.assign(toggles, t.toggles || {});
            applyToggles();
            if (curKey) select(curKey);
            return;
          }
        }
        Object.assign(toggles, t.toggles || {});
        applyToggles();
        renderAll();
        refreshLive();
      },
    });

    document.addEventListener('keydown', (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
      if (root.classList.contains('hidden') || !wb || !wb.overlay) return;
      if (e.code === 'KeyZ' && !e.shiftKey) { if (wb.overlay.undo()) saveLines(); }
      else if (e.code === 'KeyY' || (e.code === 'KeyZ' && e.shiftKey)) { if (wb.overlay.redo()) saveLines(); }
    });
  }

  function enter() {
    if (!wb || !wb.chart) buildChart();
    if (!insts.length || cfg.mode === 'market') loadList()
      .then(() => { if (!curKey && insts.length) select(cfg.mode === 'market' ? insts[0].key : 'sh000300'); })
      .catch((e) => { $('title').textContent = `列表加载失败：${e.message}`; });
    if (cfg.mode === 'market') refreshQuotes();
    startLive();
  }

  function init() {
    if (inited) return;
    inited = true;
    bind();
    if (cfg.mode === 'market') {
      setInterval(refreshQuotes, 60 * 1000);
      window.BzWatchlist.onChange(() => {
        if (!root.classList.contains('hidden')) loadList();
      });
    }
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && !root.classList.contains('hidden')) {
        if (cfg.mode === 'market') refreshQuotes();
        refreshLive();
        startLive();
      }
    });
    window.BzTheme.onChange(() => {
      if (!inited) return;
      maMenuCtrl && maMenuCtrl.sync();
      if (wb && wb.chart) {
        buildChart();
        wb.overlay.setLines(loadLines());
        if (rawBars.length) renderAll();
      }
    });
  }

  return { init, enter, reload: () => { if (curKey) select(curKey); } };
};

window.View = window.createBoard({ mode: 'index' });
window.Mkt = window.createBoard({ mode: 'market' });

/* ---------------- 三页签导航（训练 / 指数看板 / 行情） ---------------- */
window.bzNav = {
  switch(which) {
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
