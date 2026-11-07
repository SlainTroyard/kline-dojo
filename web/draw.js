/* 画线工具（canvas 叠加层）+ 缠论/画线统一渲染（K线道场 · 看板/训练共用）
 * 线存逻辑坐标 {type:'trend'|'hline', d1,p1,d2,p2}，看板按指数 key 持久化
 * localStorage；周期切换时日期自动吸附到该周期最近的 bar。
 *
 * v1.1 修复：
 *  - param.logical 是浮点（点在两根 bar 之间时如 56.48），直接做数组下标会
 *    得到 undefined 并抛错 → 画线"时灵时不灵"。现在四舍五入取最近 bar。
 *  - 画完线模式自动复位后工具栏按钮高亮不同步 → setMode 经 onModeChange 回调。
 *  - canvas 按 devicePixelRatio 缩放，高分屏不再发虚。
 *  - 颜色取自 BzTheme，随主题切换。
 */
'use strict';
window.Overlay = class Overlay {
  /**
   * @param chart lightweight-charts 实例
   * @param series 主图 candlestick series（价格坐标转换）
   * @param container 图表容器 div（canvas 叠加在其内）
   * @param opts {onModeChange?: (mode)=>void}
   */
  constructor(chart, series, container, opts = {}) {
    this.chart = chart;
    this.series = series;
    this.container = container;
    this.onModeChange = opts.onModeChange || null;
    this.bars = [];            // 当前周期 bars [{d,o,h,l,c,v}]（吸附日期用）
    this.lines = [];           // 用户画线
    this.chan = { bis: [], zs: [] };
    this.mode = 'none';        // none | trend | hline | del
    this.pending = null;       // 趋势线第一个点 {d, p}

    const cvs = document.createElement('canvas');
    cvs.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:5;';
    container.style.position = 'relative';
    container.appendChild(cvs);
    this.cvs = cvs;
    this.ctx = cvs.getContext('2d');

    const rerender = () => this.redraw();
    chart.timeScale().subscribeVisibleLogicalRangeChange(rerender);
    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(rerender).observe(container);
    }
  }

  setBars(bars) { this.bars = bars || []; this.pending = null; this.redraw(); }
  setLines(lines) { this.lines = lines || []; this.pending = null; this.redraw(); }
  setChan(chan) { this.chan = chan || { bis: [], zs: [] }; this.redraw(); }
  setMode(m) {
    this.mode = m;
    this.pending = null;
    this.redraw();
    if (this.onModeChange) this.onModeChange(m);
  }

  /** 日期 → 该周期最近(≤) bar 的逻辑索引；早于首根则 0 */
  _idxOfDate(d) {
    const bs = this.bars;
    if (!bs.length) return null;
    let lo = 0, hi = bs.length - 1, ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (bs[mid].d <= d) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
  }

  _xy(d, p) {
    const li = this._idxOfDate(d);
    if (li == null) return null;
    const x = this.chart.timeScale().logicalToCoordinate(li);
    const y = this.series.priceToCoordinate(p);
    return (x == null || y == null) ? null : { x, y };
  }

  /** 图表点击：按当前模式处理画线/删除。返回是否变更了 lines。 */
  handleClick(param) {
    if (!param.point || param.time == null) return false;
    // param.logical 可为浮点（点击落在两根 bar 之间），取最近 bar
    const li = Math.round(param.logical);
    if (!(li >= 0) || li >= this.bars.length) return false;
    const d = this.bars[li].d;
    const p = this.series.coordinateToPrice(param.point.y);
    if (p == null) return false;

    if (this.mode === 'hline') {
      this.lines.push({ type: 'hline', d1: d, p1: p });
      this.setMode('none');
      return true;
    }
    if (this.mode === 'trend') {
      if (!this.pending) { this.pending = { d, p }; this.redraw(); return false; }
      this.lines.push({ type: 'trend', d1: this.pending.d, p1: this.pending.p, d2: d, p2: p });
      this.pending = null;
      this.setMode('none');
      return true;
    }
    if (this.mode === 'del') {
      const hit = this._hitTest(param.point.x, param.point.y);
      if (hit >= 0) { this.lines.splice(hit, 1); this.redraw(); return true; }
    }
    return false;
  }

  _hitTest(px, py) {
    const R = 6;
    for (let i = this.lines.length - 1; i >= 0; i--) {
      const ln = this.lines[i];
      if (ln.type === 'hline') {
        const y = this.series.priceToCoordinate(ln.p1);
        if (y != null && Math.abs(py - y) <= R) return i;
      } else {
        const a = this._xy(ln.d1, ln.p1), b = this._xy(ln.d2, ln.p2);
        if (a && b && _distToSeg(px, py, a.x, a.y, b.x, b.y) <= R) return i;
      }
    }
    return -1;
  }

  redraw() {
    const cvs = this.cvs, box = this.container.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(box.width), h = Math.round(box.height);
    if (w <= 0 || h <= 0) return;
    if (cvs.width !== Math.round(w * dpr) || cvs.height !== Math.round(h * dpr)) {
      cvs.width = Math.round(w * dpr);
      cvs.height = Math.round(h * dpr);
    }
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!this.bars.length) return;
    const T = window.BzTheme.colors();

    // ---- 缠论：中枢矩形 + 笔折线 ----
    const zs = this.chan.zs || [];
    ctx.lineWidth = 1;
    for (const z of zs) {
      const a = this._xy(z.t0, z.zg), b = this._xy(z.t1, z.zl);
      if (!a || !b) continue;
      const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x);
      ctx.fillStyle = T.chanZs;
      ctx.fillRect(x0, a.y, x1 - x0, b.y - a.y);
      ctx.strokeStyle = T.chanZsBorder;
      ctx.strokeRect(x0, a.y, x1 - x0, b.y - a.y);
    }
    const bis = this.chan.bis || [];
    if (bis.length) {
      ctx.strokeStyle = T.chanBi;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      for (const s of bis) {
        const a = this._xy(s.t0, s.p0), b = this._xy(s.t1, s.p1);
        if (!a || !b) continue;
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
      }
      ctx.stroke();
    }

    // ---- 用户画线 ----
    ctx.lineWidth = 1.6;
    for (const ln of this.lines) {
      if (ln.type === 'hline') {
        const y = this.series.priceToCoordinate(ln.p1);
        if (y == null) continue;
        ctx.strokeStyle = T.hline;
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(0, y); ctx.lineTo(w, y);
        ctx.stroke();
        ctx.fillStyle = T.hline;
        ctx.font = '10px sans-serif';
        ctx.fillText(String(Number(ln.p1).toFixed(2)), 4, y - 3);
      } else {
        const a = this._xy(ln.d1, ln.p1), b = this._xy(ln.d2, ln.p2);
        if (!a || !b) continue;
        ctx.strokeStyle = T.trend;
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
        ctx.stroke();
        for (const pt of [a, b]) {
          ctx.fillStyle = T.trend;
          ctx.beginPath();
          ctx.arc(pt.x, pt.y, 3, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    // ---- 趋势线第一点提示 ----
    if (this.pending) {
      const a = this._xy(this.pending.d, this.pending.p);
      if (a) {
        ctx.fillStyle = T.trend;
        ctx.beginPath();
        ctx.arc(a.x, a.y, 4, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
};

function _distToSeg(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len2)) : 0;
  const cx = x1 + t * dx, cy = y1 + t * dy;
  return Math.hypot(px - cx, py - cy);
}
