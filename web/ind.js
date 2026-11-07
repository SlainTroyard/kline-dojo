/* 指标计算 + 日/周/月/年聚合 + 简化缠论（K线道场 · 指数看板）
 * 输入 bars: [{d:'YYYY-MM-DD', o,h,l,c,v}]，全部纯函数、只用已揭示侧数据。
 */
'use strict';
window.Ind = (() => {

  /* ---------------- 基础指标 ---------------- */
  function sma(vals, n) {
    const out = new Array(vals.length).fill(null);
    let s = 0;
    for (let i = 0; i < vals.length; i++) {
      s += vals[i];
      if (i >= n) s -= vals[i - n];
      if (i >= n - 1) out[i] = s / n;
    }
    return out;
  }

  function ema(vals, n) {
    const out = new Array(vals.length).fill(null);
    const k = 2 / (n + 1);
    let prev = null;
    for (let i = 0; i < vals.length; i++) {
      prev = prev == null ? vals[i] : vals[i] * k + prev * (1 - k);
      out[i] = prev;
    }
    return out;
  }

  /** 中式 SMA(X,N,M)（KDJ 用）：Y = (M*X + (N-M)*Y') / N */
  function smaCN(vals, n, m = 1) {
    const out = new Array(vals.length).fill(null);
    let prev = null;
    for (let i = 0; i < vals.length; i++) {
      prev = prev == null ? vals[i] : (m * vals[i] + (n - m) * prev) / n;
      out[i] = prev;
    }
    return out;
  }

  function macd(closes) {          // (12,26,9)，柱 = 2*(DIF-DEA)
    const dif = [], e12 = ema(closes, 12), e26 = ema(closes, 26);
    for (let i = 0; i < closes.length; i++) dif.push(e12[i] - e26[i]);
    const dea = ema(dif, 9);
    const hist = dif.map((v, i) => 2 * (v - dea[i]));
    return { dif, dea, hist };
  }

  function boll(closes, n = 20, k = 2) {
    const mid = sma(closes, n);
    const up = new Array(closes.length).fill(null);
    const low = new Array(closes.length).fill(null);
    for (let i = n - 1; i < closes.length; i++) {
      let s = 0;
      for (let j = i - n + 1; j <= i; j++) s += (closes[j] - mid[i]) ** 2;
      const sd = Math.sqrt(s / n);
      up[i] = mid[i] + k * sd;
      low[i] = mid[i] - k * sd;
    }
    return { mid, up, low };
  }

  function kdj(bars, n = 9) {      // (9,3,3)
    const k = [], d = [], j = [];
    let pk = 50, pd = 50;
    for (let i = 0; i < bars.length; i++) {
      const s = Math.max(0, i - n + 1);
      let hh = -Infinity, ll = Infinity;
      for (let t = s; t <= i; t++) {
        if (bars[t].h > hh) hh = bars[t].h;
        if (bars[t].l < ll) ll = bars[t].l;
      }
      const rsv = hh === ll ? 50 : ((bars[i].c - ll) / (hh - ll)) * 100;
      pk = (2 / 3) * pk + (1 / 3) * rsv;
      pd = (2 / 3) * pd + (1 / 3) * pk;
      k.push(pk); d.push(pd); j.push(3 * pk - 2 * pd);
    }
    return { k, d, j };
  }

  /* ---------------- 日 → 周/月/年 聚合 ---------------- */
  function isoWeek(dstr) {         // ISO 年-周（周四所在年为归属年）
    const d = new Date(dstr + 'T00:00:00Z');
    const day = (d.getUTCDay() + 6) % 7;            // 周一=0
    const thu = new Date(d);
    thu.setUTCDate(d.getUTCDate() + 3 - day);
    const year = thu.getUTCFullYear();
    const jan4 = new Date(Date.UTC(year, 0, 4));
    const jan4Day = (jan4.getUTCDay() + 6) % 7;
    const week1Mon = new Date(jan4);
    week1Mon.setUTCDate(jan4.getUTCDate() - jan4Day);
    const wk = Math.floor((thu - week1Mon) / 604800000) + 1;
    return `${year}-W${String(wk).padStart(2, '0')}`;
  }

  function aggregate(bars, period) {
    if (period === 'D') return bars;
    const keyOf = (d) =>
      period === 'W' ? isoWeek(d) :
      period === 'M' ? d.slice(0, 7) : d.slice(0, 4);
    const out = [];
    let cur = null, curKey = null;
    for (const b of bars) {
      const k = keyOf(b.d);
      if (k !== curKey) {
        if (cur) out.push(cur);
        curKey = k;
        cur = { d: b.d, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v };  // 该周期首个交易日为 time
      } else {
        if (b.h > cur.h) cur.h = b.h;
        if (b.l < cur.l) cur.l = b.l;
        cur.c = b.c;
        cur.v += b.v;
      }
    }
    if (cur) out.push(cur);
    return out;
  }

  /* ---------------- 简化缠论：合并K → 分型 → 笔 → 中枢 ----------------
   * 说明：这是工程简化版。
   *  - 合并K：标准包含关系处理（方向高低取合并）
   *  - 分型：合并K三连的顶/底分型
   *  - 笔：顶底交替 + 两分型间隔 ≥4 根合并K + 同型更极端则前移（简化：不检查笔内穿越）
   *  - 中枢：连续三笔的重叠区间，后续笔有重叠则延伸
   *  线段（特征序列）因定义多义性强，不自动画——可用画线工具手动补。
   */
  function chanlun(bars) {
    const n = bars.length;
    if (n < 30) return { bis: [], zs: [] };

    // 1) 合并K线（记录极值所在原始bar索引）
    const mg = [];   // {hi,lo,iHi,iLo,i0,i1}
    let trend = 0;   // 1 上 -1 下
    for (let i = 0; i < n; i++) {
      const b = bars[i];
      if (!mg.length) {
        mg.push({ hi: b.h, lo: b.l, iHi: i, iLo: i, i0: i, i1: i });
        continue;
      }
      const last = mg[mg.length - 1];
      const contains = (b.h >= last.hi && b.l <= last.lo) || (b.h <= last.hi && b.l >= last.lo);
      if (contains) {
        if (trend >= 0) {           // 向上/未定：高高
          if (b.h >= last.hi) { last.hi = b.h; last.iHi = i; }
          if (b.l >= last.lo) { last.lo = b.l; last.iLo = i; }
        } else {                    // 向下：低低
          if (b.h <= last.hi) { last.hi = b.h; last.iHi = i; }
          if (b.l <= last.lo) { last.lo = b.l; last.iLo = i; }
        }
        last.i1 = i;
      } else {
        trend = b.h > last.hi ? 1 : (b.l < last.lo ? -1 : trend);
        mg.push({ hi: b.h, lo: b.l, iHi: i, iLo: i, i0: i, i1: i });
      }
    }

    // 2) 分型（中间合并K 与前后比较）
    const fx = [];    // {type:'top'|'bot', price, i}
    for (let k = 1; k < mg.length - 1; k++) {
      const a = mg[k - 1], b = mg[k], c = mg[k + 1];
      if (b.hi > a.hi && b.hi > c.hi) fx.push({ type: 'top', price: b.hi, i: b.iHi, k });
      else if (b.lo < a.lo && b.lo < c.lo) fx.push({ type: 'bot', price: b.lo, i: b.iLo, k });
    }

    // 3) 成笔
    const pts = [];   // 端点 {type, price, i}
    let cand = null;
    for (const f of fx) {
      if (!cand) { cand = f; continue; }
      if (f.type === cand.type) {
        if (f.type === 'top' ? f.price >= cand.price : f.price <= cand.price) cand = f;
      } else {
        if (f.k - cand.k >= 4) {           // 间隔至少 4 根合并K
          pts.push(cand);
          cand = f;
        }
      }
    }
    if (cand && pts.length) pts.push(cand);
    if (pts.length < 2) return { bis: [], zs: [] };

    const bis = [];
    for (let k = 0; k + 1 < pts.length; k++) {
      bis.push({
        i0: pts[k].i, t0: bars[pts[k].i].d, p0: pts[k].price,
        i1: pts[k + 1].i, t1: bars[pts[k + 1].i].d, p1: pts[k + 1].price,
      });
    }

    // 4) 中枢：连续三笔重叠区间，向后延伸
    const zs = [];
    let k = 0;
    while (k + 2 < bis.length) {
      const seg = bis.slice(k, k + 3);
      const lows = seg.map((b) => Math.min(b.p0, b.p1));
      const highs = seg.map((b) => Math.max(b.p0, b.p1));
      const zl = Math.max(...lows), zg = Math.min(...highs);
      if (zg > zl) {
        let e = k + 2;
        while (e + 1 < bis.length) {
          const nb = bis[e + 1];
          const nl = Math.min(nb.p0, nb.p1), nh = Math.max(nb.p0, nb.p1);
          if (nh >= zl && nl <= zg) e += 1;
          else break;
        }
        zs.push({ t0: seg[0].t0, t1: bis[e].t1, zl, zg });
        k = e + 1;
      } else {
        k += 1;
      }
    }
    return { bis, zs };
  }

  return { sma, ema, macd, boll, kdj, aggregate, chanlun };
})();
