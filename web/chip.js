/* 筹码峰：主图右侧「价格 → 成交量」横条直方图（可视区间口径）。
 *
 * 做法：在右侧价格轴左边叠一块窄 canvas（pointer-events:none），把可视 bars 的
 * 成交量按 [low, high] 均匀摊到价格分箱里，横条向左伸展——峰越宽该价位筹码越厚。
 * 为避免盖住最新 K 线，开启时同步给时间轴预留 pad 根空白（rightOffset + 可视范围
 * 平移），缩放到不同 barSpacing 时自动重算，保证空白宽度稳定 ≈ 画布宽。
 */
'use strict';
window.ChipProfile = class ChipProfile {
  constructor(canvas, opts = {}) {
    this.cvs = canvas;
    this.ctx = canvas.getContext('2d');
    this.chart = null;
    this.series = null;
    this.bars = [];
    this.on = false;
    this.W = opts.width || 66;        // 画布宽（CSS px），与 .chip-canvas 一致
    this.BINS = opts.bins || 48;
    this._lastRO = 0;                 // 已写入 timeScale.rightOffset 的根数
    this._busy = false;
    this._ro = null;
    if (typeof ResizeObserver !== 'undefined' && canvas.parentElement) {
      this._ro = new ResizeObserver(() => this.redraw());
      this._ro.observe(canvas.parentElement);
    }
  }

  attach(chart, series) {
    this.chart = chart;
    this.series = series;
    this._lastRO = 0;
    chart.timeScale().subscribeVisibleLogicalRangeChange(() => this._onRange());
  }

  destroy() {
    if (this._ro) this._ro.disconnect();
    this._ro = null;
  }

  setBars(bars) { this.bars = bars || []; if (this.on) this._syncPad(); this.redraw(); }

  setVisible(on) {
    this.on = !!on;
    this.cvs.classList.toggle('hidden', !this.on);
    if (!this.on) {
      this._lastRO = 0;
      if (this.chart) this.chart.timeScale().applyOptions({ rightOffset: 8 });
      this._clear();
    } else {
      this._syncPad();
      this.redraw();
    }
  }

  _barSpacing() {
    return (this.chart && this.chart.timeScale().options().barSpacing) || 6;
  }

  /** 需要的空白根数：画布宽 / 每根像素宽 */
  _padFor() { return this.on ? Math.ceil((this.W + 8) / Math.max(2, this._barSpacing())) : 0; }

  _onRange() {
    if (!this.on || this._busy || !this.chart) return;
    this._syncPad();
    this.redraw();
  }

  /** 右侧空白 = pad 根：rightOffset 应对滚回右缘的场景，可视窗口平移应对缩放 */
  _syncPad() {
    if (!this.chart || !this.on) return;
    const ts = this.chart.timeScale();
    const pad = this._padFor();
    if (pad !== this._lastRO) {
      this._lastRO = pad;
      this._busy = true;
      ts.applyOptions({ rightOffset: Math.max(2, pad + 1) });
      this._busy = false;
    }
    const n = this.bars.length;
    const vr = ts.getVisibleLogicalRange();
    if (!vr || !n) return;
    if (vr.to < n - 1.5) return;                    // 用户已左移：不干预窗口
    const d = n + pad - vr.to;                      // 目标右缘 n+pad
    if (Math.abs(d) < 1.5) return;
    this._busy = true;
    ts.setVisibleLogicalRange({ from: vr.from + d, to: n + pad });
    this._busy = false;
  }

  _clear() {
    const box = this.cvs.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(box.width), h = Math.round(box.height);
    if (w <= 0 || h <= 0) return;
    if (this.cvs.width !== Math.round(w * dpr) || this.cvs.height !== Math.round(h * dpr)) {
      this.cvs.width = Math.round(w * dpr);
      this.cvs.height = Math.round(h * dpr);
    }
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.ctx.clearRect(0, 0, w, h);
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
    if (!this.on || !this.chart || !this.series || !this.bars.length) return;

    const vr = this.chart.timeScale().getVisibleLogicalRange();
    if (!vr) return;
    const n = this.bars.length;
    const i0 = Math.max(0, Math.floor(vr.from));
    const i1 = Math.min(n - 1, Math.ceil(vr.to));
    if (i1 <= i0) return;

    // 可视区间价格范围
    let lo = Infinity, hi = -Infinity;
    for (let i = i0; i <= i1; i++) {
      const b = this.bars[i];
      if (b.l < lo) lo = b.l;
      if (b.h > hi) hi = b.h;
    }
    if (!(hi > lo)) return;

    // 分箱：每根 bar 的成交量按 [low, high] 重叠比例摊入，峰形更平滑
    const BINS = this.BINS;
    const bins = new Float64Array(BINS);
    const step = (hi - lo) / BINS;
    for (let i = i0; i <= i1; i++) {
      const b = this.bars[i];
      if (!(b.v > 0)) continue;
      const span = b.h - b.l;
      const a = Math.max(0, Math.min(BINS - 1, Math.floor((b.l - lo) / step)));
      const z = Math.max(0, Math.min(BINS - 1, Math.floor((b.h - lo) / step)));
      if (span <= 0 || z === a) {
        bins[a] += b.v;
      } else {
        for (let k = a; k <= z; k++) {
          const klo = lo + k * step;
          const ov = Math.min(b.h, klo + step) - Math.max(b.l, klo);
          if (ov > 0) bins[k] += (b.v * ov) / span;
        }
      }
    }
    let mx = 0, pocK = -1;
    for (let k = 0; k < BINS; k++) if (bins[k] > mx) { mx = bins[k]; pocK = k; }
    if (!(mx > 0)) return;

    const T = window.BzTheme.colors();
    const close = this.bars[i1].c;
    const padX = 3;
    const maxW = w - padX * 2;
    const Y = (price) => this.series.priceToCoordinate(price);
    const top0 = Y(lo + step);          // 箱顶（高价在上）
    if (top0 == null) return;

    // 不画标题：主图图例区在顶部，避免叠字（开关按钮已标明「筹码」）
    ctx.textBaseline = 'middle';
    for (let k = 0; k < BINS; k++) {
      if (bins[k] <= 0) continue;
      const yA = Y(lo + (k + 1) * step);
      const yB = Y(lo + k * step);
      if (yA == null || yB == null) continue;
      const top = Math.min(yA, yB);
      const hh = Math.abs(yB - yA);
      if (top > h + 2 || top + hh < -2) continue;
      const price = lo + (k + 0.5) * step;
      const bw = Math.max(1, (bins[k] / mx) * maxW);
      const isPoc = k === pocK;
      // 获利盘（低于现价）红、套牢盘（高于现价）蓝；峰顶用主题色强调
      ctx.fillStyle = isPoc ? T.accent : price <= close ? T.up : T.blue;
      ctx.globalAlpha = isPoc ? 0.85 : price <= close ? 0.5 : 0.42;
      ctx.fillRect(padX + maxW - bw, top + 0.3, bw, Math.max(1, hh - 0.6));
    }
    ctx.globalAlpha = 1;

    // 峰顶价格标签
    if (pocK >= 0) {
      const y = Y(lo + (pocK + 0.5) * step);
      if (y != null && y > 14 && y < h - 6) {
        const txt = (lo + (pocK + 0.5) * step).toFixed(2);
        ctx.font = '10px sans-serif';
        const tw = ctx.measureText(txt).width;
        ctx.fillStyle = T.accent;
        ctx.textAlign = 'right';
        ctx.fillText(txt, padX + maxW, Math.max(10, y - 9));
        ctx.textAlign = 'left';
      }
    }
  }
};
