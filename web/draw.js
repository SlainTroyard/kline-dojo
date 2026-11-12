/* 画线工具（canvas 叠加层）+ 缠论/画线统一渲染（K线道场 · 看板/训练共用）
 * 线存逻辑坐标，看板按指数 key 持久化 localStorage；周期切换时日期自动
 * 吸附到该周期最近的 bar。工具（v1.2）：
 *   trend   趋势线（2 点）         arrow   箭头（2 点，第二点为箭头方向）
 *   hline   水平线（1 点）
 *   fib     斐波那契回撤（2 点）    channel 平行通道（3 点：基线 2 点+宽度 1 点）
 *   rect    矩形区域（2 点）        text    文字标注（1 点，弹窗输入）
 * 通用能力：磁吸（画点工具 12px 内吸附最近 bar 的 OHLC）、撤销/重做
 * （栈深 50，undo()/redo()/clearAll()）、点击线上删除（del 模式）。
 *
 * 历史：
 *  v1.2 新增 fib/channel/rect/text 工具、磁吸、撤销重做、缠论线段/背驰渲染
 *  v1.1 修复：param.logical 浮点取最近 bar；setMode 回调同步工具栏高亮；
 *       canvas 按 devicePixelRatio 缩放；颜色取自 BzTheme 随主题切换。
 */
'use strict';

/* 轻量输入对话框（主题化，替代原生 prompt——嵌入式 webview 不支持原生弹窗） */
window.bzPrompt = (msg, def, cb) => {
  const old = document.getElementById('bz-prompt');
  if (old) old.remove();
  const T = window.BzTheme.colors();
  const wrap = document.createElement('div');
  wrap.id = 'bz-prompt';
  wrap.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:99;display:flex;align-items:center;justify-content:center;';
  const box = document.createElement('div');
  box.style.cssText = `background:${T.panel};border:1px solid ${T.line};border-radius:10px;padding:14px 16px;min-width:280px;box-shadow:0 8px 30px rgba(0,0,0,.35);`;
  box.innerHTML =
    `<div style="color:${T.text};font-size:13px;margin-bottom:10px"></div>` +
    `<input style="width:100%;padding:7px 9px;border:1px solid ${T.line};border-radius:6px;background:${T.bg};color:${T.text};font-size:13px;box-sizing:border-box;outline:none;">` +
    `<div style="text-align:right;margin-top:12px;display:flex;gap:8px;justify-content:flex-end;">` +
    `<button data-act="cancel" style="padding:6px 14px;border:1px solid ${T.line};border-radius:6px;background:transparent;color:${T.dim};cursor:pointer;font-size:13px;">取消</button>` +
    `<button data-act="ok" style="padding:6px 14px;border:none;border-radius:6px;background:${T.accent};color:${T.onAccent};cursor:pointer;font-size:13px;">确定</button></div>`;
  const label = box.querySelector('div');
  label.textContent = msg;
  const input = box.querySelector('input');
  input.value = def || '';
  wrap.appendChild(box);
  document.body.appendChild(wrap);
  const done = (val) => { wrap.remove(); if (val != null) cb(val); };
  wrap.onclick = (e) => { if (e.target === wrap) done(null); };
  box.querySelector('[data-act="ok"]').onclick = () => done(input.value.trim());
  box.querySelector('[data-act="cancel"]').onclick = () => done(null);
  input.onkeydown = (e) => {
    if (e.key === 'Enter') done(input.value.trim());
    if (e.key === 'Escape') done(null);
  };
  setTimeout(() => { input.focus(); input.select(); }, 0);
};

window.Overlay = class Overlay {
  /** 容器 → 现存实例：主题重建前 destroy 旧实例（disconnect ResizeObserver） */
  static _byContainer = new Map();

  /**
   * @param chart lightweight-charts 实例
   * @param series 主图 candlestick series（价格坐标转换）
   * @param container 图表容器 div（canvas 叠加在其内）
   * @param opts {onModeChange?: (mode)=>void, onChange?: ()=>void}
   *   onChange：lines 异步变更（文字标注对话框确认）后的持久化回调
   */
  constructor(chart, series, container, opts = {}) {
    this.chart = chart;
    this.series = series;
    this.container = container;
    this.onModeChange = opts.onModeChange || null;
    this.onChange = opts.onChange || null;
    this.bars = [];            // 当前周期 bars [{d,o,h,l,c,v}]（吸附日期用）
    this.lines = [];           // 用户画线
    this.chan = { bis: [], zs: [], duans: [], divs: [] };
    this.mode = 'none';        // none | trend | arrow | hline | fib | channel | rect | drect | pen | text | select | del
    this.pts = [];             // 多点工具已落点 [{d, p}]
    this.style = { color: null, width: null, dash: null };    // 新画线默认样式（null=按类型取主题默认）
    this.selected = null;      // 选择模式下选中的线下标
    this._drag = null;         // 拖拽绘制中的临时状态 {type,start,cur,pts}
    this.undoStack = [];       // 撤销栈（lines 快照，深 50）
    this.redoStack = [];

    const cvs = document.createElement('canvas');
    cvs.className = 'bz-overlay';
    cvs.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:5;';
    container.style.position = 'relative';
    // 主题重建等场景会再次 new Overlay：destroy 旧实例（RO）并清掉旧 canvas，避免重影/泄漏
    const prev = Overlay._byContainer.get(container);
    if (prev) prev.destroy();
    container.querySelectorAll('canvas.bz-overlay').forEach((e) => e.remove());
    container.appendChild(cvs);
    this.cvs = cvs;
    this.ctx = cvs.getContext('2d');

    const rerender = () => this.redraw();
    chart.timeScale().subscribeVisibleLogicalRangeChange(rerender);
    // 拖拽绘制（框选/涂鸦）：mousedown 在容器，move/up 挂 window（拖出画布也能收尾）
    this._hDown = (e) => this._onDown(e);
    this._hMove = (e) => this._onMove(e);
    this._hUp = (e) => this._onUp(e);
    container.addEventListener('mousedown', this._hDown);
    window.addEventListener('mousemove', this._hMove);
    window.addEventListener('mouseup', this._hUp);
    this._ro = (typeof ResizeObserver !== 'undefined') ? new ResizeObserver(rerender) : null;
    if (this._ro) this._ro.observe(container);
    Overlay._byContainer.set(container, this);
  }

  /** 释放 ResizeObserver（主题重建时由下一个实例的构造调用） */
  destroy() {
    if (this._ro) this._ro.disconnect();
    if (this._hDown) this.container.removeEventListener('mousedown', this._hDown);
    if (this._hMove) window.removeEventListener('mousemove', this._hMove);
    if (this._hUp) window.removeEventListener('mouseup', this._hUp);
    Overlay._byContainer.delete(this.container);
  }

  /* 各工具需要的点击数 */
  static get NEED() { return { trend: 2, arrow: 2, hline: 1, fib: 2, channel: 3, rect: 2, text: 1 }; }
  static get FIB_RATIOS() { return ['0', '0.236', '0.382', '0.5', '0.618', '0.786', '1']; }

  setBars(bars) { this.bars = bars || []; this.pts = []; this.redraw(); }
  setLines(lines) {            // 外部装载（换标的/换主题重建）：撤销栈随之重置
    this.lines = lines || [];
    this.pts = [];
    this.undoStack = [];
    this.redoStack = [];
    this.redraw();
  }
  setChan(chan) {
    this.chan = chan || { bis: [], zs: [], duans: [], divs: [] };
    this.redraw();
  }
  setMode(m) {
    const drag = (m === 'drect' || m === 'pen');
    // 拖拽绘制时禁用图表平移/缩放，避免和图表手势打架
    this.chart.applyOptions({ handleScroll: !drag, handleScale: !drag });
    this.container.style.cursor = m === 'none' ? '' : (m === 'select' ? 'default' : 'crosshair');
    if (m !== 'select') this.selected = null;
    this.mode = m;
    this.pts = [];
    this._drag = null;
    this.redraw();
    if (this.onModeChange) this.onModeChange(m);
  }

  /** 样式：作用于「选中的线」，否则作为新画线默认样式 */
  setStyle(patch) {
    Object.assign(this.style, patch);
    if (this.selected != null && this.lines[this.selected]) {
      this._pushUndo();                        // 先快照再改，撤销回到旧样式
      const ln = this.lines[this.selected];
      ln.st = Object.assign({}, ln.st, patch);
      this.redraw();
      if (this.onChange) this.onChange();
    }
  }

  /** 删除选中的线（选择模式） */
  deleteSelected() {
    if (this.selected == null || !this.lines[this.selected]) return false;
    this._pushUndo();
    this.lines.splice(this.selected, 1);
    this.selected = null;
    this.redraw();
    if (this.onChange) this.onChange();
    return true;
  }

  /** 线样式合并：颜色/粗细/虚实（未设置取主题默认） */
  _st(ln) {
    const T = window.BzTheme.colors();
    const def = {
      trend: T.trend, arrow: T.trend, hline: T.hline, fib: T.fib, channel: T.channel,
      rect: T.rect, drect: T.rect, pen: T.trend, text: T.note,
    }[ln.type] || T.trend;
    const s = ln.st || {};
    return {
      color: s.color || def,
      width: s.width || ((ln.type === 'drect' || ln.type === 'pen') ? 2 : 1.6),
      dash: s.dash != null ? !!s.dash : (ln.type === 'rect'),
    };
  }

  /** 屏幕坐标 → {d,p}（拖拽绘制用） */
  _evPos(e) {
    if (!this.bars.length) return null;
    const r = this.container.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    const p = this.series.coordinateToPrice(y);
    const li = this.chart.timeScale().coordinateToLogical(x);
    if (p == null || li == null) return null;
    const i = Math.max(0, Math.min(this.bars.length - 1, Math.round(li)));
    return { d: this.bars[i].d, p, x, y };
  }

  /* ---------------- 撤销 / 重做 ---------------- */
  _pushUndo() {
    this.undoStack.push(this.lines.slice());
    if (this.undoStack.length > 50) this.undoStack.shift();
    this.redoStack.length = 0;
  }
  /** 撤销最近一次画线/删除/清空；有变更返回 true（调用方负责持久化） */
  undo() {
    if (!this.undoStack.length) return false;
    this.redoStack.push(this.lines.slice());
    this.lines = this.undoStack.pop();
    this.redraw();
    return true;
  }
  redo() {
    if (!this.redoStack.length) return false;
    this.undoStack.push(this.lines.slice());
    this.lines = this.redoStack.pop();
    this.redraw();
    return true;
  }
  /** 清空（可撤销；区别于 setLines 的装载语义） */
  clearAll() { this._pushUndo(); this.lines = []; this.redraw(); }

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

  /** 磁吸：画点工具在 12px 内吸附最近 bar 的 OHLC（hline/text 不吸） */
  _magnet(li, py) {
    const b = this.bars[li];
    if (!b) return null;
    let best = null;
    for (const v of [b.o, b.h, b.l, b.c]) {
      const y = this.series.priceToCoordinate(v);
      if (y == null) continue;
      const dist = Math.abs(py - y);
      if (!best || dist < best.dist) best = { dist, price: v };
    }
    return (best && best.dist <= 12) ? best.price : null;
  }

  /* ---------------- 拖拽绘制（drect 框选 / pen 涂鸦） ---------------- */
  _onDown(e) {
    if (this.mode !== 'drect' && this.mode !== 'pen') return;
    if (e.button !== 0) return;
    const pos = this._evPos(e);
    if (!pos) return;
    e.preventDefault();
    e.stopPropagation();
    this._drag = { type: this.mode, start: pos, cur: pos, pts: [pos] };
    this.redraw();
  }

  _onMove(e) {
    const D = this._drag;
    if (!D) return;
    const pos = this._evPos(e);
    if (!pos) return;
    D.cur = pos;
    if (D.type === 'pen') {
      const last = D.pts[D.pts.length - 1];
      if (!last || Math.hypot(pos.x - last.x, pos.y - last.y) >= 3) D.pts.push(pos);
    }
    this.redraw();
  }

  _onUp() {
    const D = this._drag;
    if (!D) return;
    this._drag = null;
    let ln = null;
    if (D.type === 'drect') {
      const dx = Math.abs(D.cur.x - D.start.x);
      const dy = Math.abs(D.cur.y - D.start.y);
      if (dx >= 5 && dy >= 5) {
        ln = { type: 'drect', d1: D.start.d, p1: D.start.p, d2: D.cur.d, p2: D.cur.p };
      }
    } else if (D.type === 'pen' && D.pts.length >= 3) {
      ln = { type: 'pen', pts: D.pts.map((q) => ({ d: q.d, p: q.p })) };
    }
    if (ln) {
      ln.st = { ...this.style };
      this._pushUndo();
      this.lines.push(ln);
      this.redraw();
      if (this.onChange) this.onChange();
    }
    this.setMode('none');
  }

  /** 图表点击：按当前模式处理画线/删除。返回是否变更了 lines。 */
  handleClick(param) {
    if (!param.point || param.time == null) return false;
    // param.logical 可为浮点（点击落在两根 bar 之间），取最近 bar
    const li = Math.round(param.logical);
    if (!(li >= 0) || li >= this.bars.length) return false;
    const d = this.bars[li].d;
    let p = this.series.coordinateToPrice(param.point.y);
    if (p == null) return false;

    if (this.mode === 'del') {
      const hit = this._hitTest(param.point.x, param.point.y);
      if (hit >= 0) { this._pushUndo(); this.lines.splice(hit, 1); this.redraw(); return true; }
      return false;
    }
    if (this.mode === 'select') {
      const hit = this._hitTest(param.point.x, param.point.y);
      this.selected = hit >= 0 ? hit : null;
      this.redraw();
      return false;
    }

    const need = Overlay.NEED[this.mode];
    if (!need) return false;
    // 磁吸（hline 任意价位、text 任意位置均不吸）
    if (this.mode !== 'hline' && this.mode !== 'text') {
      p = this._magnet(li, param.point.y) ?? p;
    }
    this.pts.push({ d, p });
    if (this.pts.length < need) { this.redraw(); return false; }

    const [a, b, c] = this.pts;
    let ln = null;
    if (this.mode === 'hline') ln = { type: 'hline', d1: d, p1: p };
    else if (this.mode === 'trend') ln = { type: 'trend', d1: a.d, p1: a.p, d2: b.d, p2: b.p };
    else if (this.mode === 'arrow') ln = { type: 'arrow', d1: a.d, p1: a.p, d2: b.d, p2: b.p };
    else if (this.mode === 'fib') ln = { type: 'fib', d1: a.d, p1: a.p, d2: b.d, p2: b.p };
    else if (this.mode === 'rect') ln = { type: 'rect', d1: a.d, p1: a.p, d2: b.d, p2: b.p };
    else if (this.mode === 'channel') ln = { type: 'channel', d1: a.d, p1: a.p, d2: b.d, p2: b.p, d3: c.d, p3: c.p };
    else if (this.mode === 'text') {
      // 异步：对话框确认后才真正落线（onChange 通知持久化）
      this.pts = [];
      this.setMode('none');
      window.bzPrompt('标注文字：', '', (txt) => {
        if (txt) {
          this._pushUndo();
          this.lines.push({ type: 'text', d1: d, p1: p, txt: txt.slice(0, 40) });
          this.redraw();
          if (this.onChange) this.onChange();
        }
      });
      return false;
    }
    this.pts = [];
    if (ln) {
      ln.st = { ...this.style };        // 落线时固化当前样式（null 字段按类型兜底）
      this._pushUndo();
      this.lines.push(ln);
    }
    this.setMode('none');
    return !!ln;
  }

  /** fib 档位价：r=0 在终点 B、r=1 在起点 A（TradingView 惯例） */
  _fibLevels(ln) {
    const range = ln.p2 - ln.p1;
    return Overlay.FIB_RATIOS.map((r) => ({ r, price: ln.p2 - range * Number(r) }));
  }

  /** 通道：基线 (d1,p1)→(d2,p2) 在逻辑索引 li 处的价格 */
  _chanBaseAt(ln, li) {
    const i1 = this._idxOfDate(ln.d1), i2 = this._idxOfDate(ln.d2);
    if (i1 == null || i2 == null || i2 === i1) return (ln.p1 + ln.p2) / 2;
    return ln.p1 + (ln.p2 - ln.p1) * (li - i1) / (i2 - i1);
  }
  /** 通道两边界在逻辑索引 li 处的价格（下边界 = 过第三点的平行线） */
  _chanLines(ln) {
    const i3 = this._idxOfDate(ln.d3);
    if (i3 == null) return null;
    const off = ln.p3 - this._chanBaseAt(ln, i3);
    return {
      base: (li) => this._chanBaseAt(ln, li),
      para: (li) => this._chanBaseAt(ln, li) + off,
    };
  }

  _hitTest(px, py) {
    const R = 6;
    const w = this.cvs.clientWidth;
    for (let i = this.lines.length - 1; i >= 0; i--) {
      const ln = this.lines[i];
      if (ln.type === 'hline') {
        const y = this.series.priceToCoordinate(ln.p1);
        if (y != null && Math.abs(py - y) <= R) return i;
      } else if (ln.type === 'fib') {
        const a = this._xy(ln.d1, ln.p1);
        if (a && _distToSeg(px, py, a.x, a.y, a.x + 40, a.y) <= R) return i;   // 锚点附近
        for (const { price } of this._fibLevels(ln)) {
          const y = this.series.priceToCoordinate(price);
          if (y != null && Math.abs(py - y) <= R) return i;
        }
      } else if (ln.type === 'channel') {
        const L = this._chanLines(ln);
        if (!L) continue;
        const x0 = this.chart.timeScale().logicalToCoordinate(0);
        const x1 = this.chart.timeScale().logicalToCoordinate(this.bars.length - 1);
        if (x0 == null || x1 == null) continue;
        for (const f of [L.base, L.para]) {
          const yA = this.series.priceToCoordinate(f(0));
          const yB = this.series.priceToCoordinate(f(this.bars.length - 1));
          if (yA != null && yB != null && _distToSeg(px, py, x0, yA, x1, yB) <= R) return i;
        }
      } else if (ln.type === 'rect' || ln.type === 'drect') {
        const a = this._xy(ln.d1, ln.p1), b = this._xy(ln.d2, ln.p2);
        if (!a || !b) continue;
        const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x);
        const y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
        // 框选矩形：点框内或边框附近都算命中（便于选中改样式）
        if (px >= x0 - R && px <= x1 + R && py >= y0 - R && py <= y1 + R) return i;
      } else if (ln.type === 'pen') {
        const pts = (ln.pts || []).map((q) => this._xy(q.d, q.p)).filter(Boolean);
        for (let k = 1; k < pts.length; k++) {
          if (_distToSeg(px, py, pts[k - 1].x, pts[k - 1].y, pts[k].x, pts[k].y) <= R) return i;
        }
      } else if (ln.type === 'text') {
        const a = this._xy(ln.d1, ln.p1);
        if (!a) continue;
        const tw = ln._w || (ln.txt ? ln.txt.length : 0) * 7 + 10;   // _w 由 redraw 缓存
        if (px >= a.x - 3 && px <= a.x + tw && py >= a.y - 14 && py <= a.y + 4) return i;
      } else {                    // trend
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

    // ---- 缠论：中枢矩形 + 线段（下）+ 笔折线 + 背驰标记 ----
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
    const duans = this.chan.duans || [];
    if (duans.length) {
      ctx.strokeStyle = T.chanDuan;
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (const s of duans) {
        const a = this._xy(s.t0, s.p0), b = this._xy(s.t1, s.p1);
        if (!a || !b) continue;
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
      }
      ctx.stroke();
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
    const divs = this.chan.divs || [];
    ctx.font = '9px sans-serif';
    for (const dv of divs) {
      const a = this._xy(dv.t, dv.p);
      if (!a) continue;
      const top = dv.type === 'top';
      ctx.fillStyle = top ? T.up : T.down;
      ctx.beginPath();
      if (top) {                  // 顶背驰：端点上方倒三角
        ctx.moveTo(a.x - 5, a.y - 8); ctx.lineTo(a.x + 5, a.y - 8); ctx.lineTo(a.x, a.y - 2);
      } else {                    // 底背驰：端点下方正三角
        ctx.moveTo(a.x - 5, a.y + 8); ctx.lineTo(a.x + 5, a.y + 8); ctx.lineTo(a.x, a.y + 2);
      }
      ctx.closePath();
      ctx.fill();
      ctx.fillText(top ? '顶背驰' : '底背驰', a.x + 7, top ? a.y - 4 : a.y + 12);
    }

    // ---- 用户画线（支持自定义颜色/粗细/虚实） ----
    for (let li = 0; li < this.lines.length; li++) {
      const ln = this.lines[li];
      const st = this._st(ln);
      const hl = li === this.selected;
      ctx.lineWidth = st.width;
      ctx.strokeStyle = st.color;
      ctx.fillStyle = st.color;
      ctx.setLineDash(st.dash ? [6, 4] : []);

      if (ln.type === 'hline') {
        const y = this.series.priceToCoordinate(ln.p1);
        if (y == null) continue;
        ctx.beginPath();
        ctx.moveTo(0, y); ctx.lineTo(w, y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.font = '10px sans-serif';
        ctx.fillText(String(Number(ln.p1).toFixed(2)), 4, y - 3);
      } else if (ln.type === 'fib') {
        const a = this._xy(ln.d1, ln.p1), b = this._xy(ln.d2, ln.p2);
        if (!a || !b) continue;
        ctx.setLineDash([]);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
        ctx.stroke();
        ctx.font = '10px sans-serif';
        const x0 = Math.min(a.x, b.x);
        for (const { r, price } of this._fibLevels(ln)) {
          const y = this.series.priceToCoordinate(price);
          if (y == null) continue;
          ctx.setLineDash([4, 3]);
          ctx.lineWidth = (r === '0.618' || r === '0.5') ? Math.max(1, st.width) : 1;
          ctx.beginPath();
          ctx.moveTo(x0, y); ctx.lineTo(w, y);
          ctx.stroke();
          ctx.setLineDash([]);
          const label = `${r} ${price.toFixed(2)}`;
          const tw = ctx.measureText(label).width;
          ctx.fillText(label, w - tw - 4, y - 3);
        }
      } else if (ln.type === 'channel') {
        const L = this._chanLines(ln);
        if (!L) continue;
        const x0 = this.chart.timeScale().logicalToCoordinate(0);
        const x1 = this.chart.timeScale().logicalToCoordinate(this.bars.length - 1);
        if (x0 == null || x1 == null) continue;
        const ys = [L.base, L.para].map((f) => [
          this.series.priceToCoordinate(f(0)),
          this.series.priceToCoordinate(f(this.bars.length - 1)),
        ]);
        if (ys.some((seg) => seg.some((y) => y == null))) continue;
        ctx.fillStyle = st.color;
        ctx.save();
        ctx.globalAlpha = 0.07;
        ctx.beginPath();
        ctx.moveTo(x0, ys[0][0]); ctx.lineTo(x1, ys[0][1]);
        ctx.lineTo(x1, ys[1][1]); ctx.lineTo(x0, ys[1][0]);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
        ctx.strokeStyle = st.color;
        for (const [ya, yb] of ys) {
          ctx.beginPath();
          ctx.moveTo(x0, ya); ctx.lineTo(x1, yb);
          ctx.stroke();
        }
      } else if (ln.type === 'rect' || ln.type === 'drect') {
        const a = this._xy(ln.d1, ln.p1), b = this._xy(ln.d2, ln.p2);
        if (!a || !b) continue;
        const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x);
        const y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
        ctx.fillStyle = st.color;
        ctx.save();
        ctx.globalAlpha = ln.type === 'drect' ? 0.08 : 0.10;
        ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
        ctx.restore();
        ctx.strokeStyle = st.color;
        ctx.setLineDash(st.dash ? [5, 3] : []);
        ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
        ctx.setLineDash([]);
      } else if (ln.type === 'pen') {
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.beginPath();
        let started = false;
        for (const q of ln.pts || []) {
          const a = this._xy(q.d, q.p);
          if (!a) continue;
          if (!started) { ctx.moveTo(a.x, a.y); started = true; }
          else ctx.lineTo(a.x, a.y);
        }
        if (started) ctx.stroke();
        ctx.lineJoin = 'miter';
        ctx.lineCap = 'butt';
      } else if (ln.type === 'text') {
        const a = this._xy(ln.d1, ln.p1);
        if (!a) continue;
        ctx.font = '11px sans-serif';
        const tw = ctx.measureText(ln.txt).width;
        ln._w = tw + 8;                    // 命中检测复用真实宽度（中英文混排估算不准）
        ctx.fillStyle = T.panel;
        ctx.save();
        ctx.globalAlpha = 0.85;
        if (ctx.roundRect) {
          ctx.beginPath();
          ctx.roundRect(a.x - 3, a.y - 14, tw + 8, 18, 3);
          ctx.fill();
        } else {
          ctx.fillRect(a.x - 3, a.y - 14, tw + 8, 18);
        }
        ctx.restore();
        ctx.strokeStyle = st.color;
        ctx.setLineDash([]);
        ctx.lineWidth = 1;
        ctx.strokeRect(a.x - 3, a.y - 14, tw + 8, 18);
        ctx.fillStyle = st.color;
        ctx.fillText(ln.txt, a.x + 1, a.y - 1);
      } else if (ln.type === 'arrow') {
        const a = this._xy(ln.d1, ln.p1), b = this._xy(ln.d2, ln.p2);
        if (!a || !b) continue;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
        ctx.stroke();
        ctx.setLineDash([]);
        // 实心三角箭头，方向由第二点决定
        const ang = Math.atan2(b.y - a.y, b.x - a.x);
        const L = Math.max(8, st.width * 5);
        const W = L * 0.55;
        ctx.beginPath();
        ctx.moveTo(b.x, b.y);
        ctx.lineTo(b.x - L * Math.cos(ang) + W * Math.sin(ang),
          b.y - L * Math.sin(ang) - W * Math.cos(ang));
        ctx.lineTo(b.x - L * Math.cos(ang) - W * Math.sin(ang),
          b.y - L * Math.sin(ang) + W * Math.cos(ang));
        ctx.closePath();
        ctx.fill();
      } else {                    // trend
        const a = this._xy(ln.d1, ln.p1), b = this._xy(ln.d2, ln.p2);
        if (!a || !b) continue;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
        ctx.stroke();
        ctx.setLineDash([]);
        for (const pt of [a, b]) {
          ctx.fillStyle = st.color;
          ctx.beginPath();
          ctx.arc(pt.x, pt.y, 3, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // 选中态：锚点手柄（选择模式下点中的线）
      if (hl) {
        const anchors = [];
        if (ln.type === 'hline') {
          const y = this.series.priceToCoordinate(ln.p1);
          if (y != null) anchors.push({ x: 20, y });
        } else if (ln.type === 'pen') {
          for (const q of [ln.pts && ln.pts[0], ln.pts && ln.pts[ln.pts.length - 1]]) {
            const a = q && this._xy(q.d, q.p);
            if (a) anchors.push(a);
          }
        } else if (ln.type === 'channel') {
          for (const [d, p] of [[ln.d1, ln.p1], [ln.d2, ln.p2], [ln.d3, ln.p3]]) {
            const a = this._xy(d, p);
            if (a) anchors.push(a);
          }
        } else {
          const a = this._xy(ln.d1, ln.p1);
          if (a) anchors.push(a);
          if (ln.type !== 'text') {
            const b = this._xy(ln.d2, ln.p2);
            if (b) anchors.push(b);
          }
        }
        ctx.setLineDash([]);
        for (const a of anchors) {
          ctx.beginPath();
          ctx.arc(a.x, a.y, 4.2, 0, Math.PI * 2);
          ctx.fillStyle = T.accent;
          ctx.fill();
          ctx.lineWidth = 1.4;
          ctx.strokeStyle = T.panel;
          ctx.stroke();
        }
      }
    }

    // ---- 拖拽预览（框选矩形 / 涂鸦笔迹） ----
    if (this._drag) {
      const D = this._drag;
      ctx.setLineDash([5, 4]);
      ctx.strokeStyle = T.accent;
      ctx.lineWidth = 1.4;
      if (D.type === 'drect') {
        const a = this._xy(D.start.d, D.start.p), b = this._xy(D.cur.d, D.cur.p);
        if (a && b) {
          ctx.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y),
            Math.abs(b.x - a.x), Math.abs(b.y - a.y));
        }
      } else {
        ctx.beginPath();
        let started = false;
        for (const q of D.pts) {
          const a = this._xy(q.d, q.p);
          if (!a) continue;
          if (!started) { ctx.moveTo(a.x, a.y); started = true; }
          else ctx.lineTo(a.x, a.y);
        }
        if (started) ctx.stroke();
      }
      ctx.setLineDash([]);
    }

    // ---- 已落点提示（多点工具） ----
    if (this.pts.length) {
      ctx.setLineDash([]);
      for (const q of this.pts) {
        const a = this._xy(q.d, q.p);
        if (!a) continue;
        ctx.fillStyle = T.trend;
        ctx.beginPath();
        ctx.arc(a.x, a.y, 4, 0, Math.PI * 2);
        ctx.fill();
      }
      const need = Overlay.NEED[this.mode];
      if (need && this.pts.length < need) {
        const last = this.pts[this.pts.length - 1];
        const a = this._xy(last.d, last.p);
        if (a) {
          ctx.font = '10px sans-serif';
          ctx.fillStyle = T.dim;
          ctx.fillText(`再点 ${need - this.pts.length} 次完成`, a.x + 8, a.y - 8);
        }
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
