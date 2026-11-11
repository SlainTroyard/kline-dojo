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

  /* ---------------- 简化缠论：合并K → 分型 → 笔 → 中枢 → 线段/背驰 ----------------
   * 说明：这是工程简化版。
   *  - 合并K：标准包含关系处理（方向高低取合并）
   *  - 分型：合并K三连的顶/底分型
   *  - 笔：顶底交替 + 两分型间隔 ≥4 根合并K + 同型更极端则前移（简化：不检查笔内穿越）
   *  - 中枢：连续三笔的重叠区间，后续笔有重叠则延伸
   *  - 线段（实验性）：极值破坏法——反向笔的端点突破本段起点价则本段在段内
   *    极值处终结（未做特征序列分型，与严格定义有出入，仅供目视参考）
   *  - 背驰：同向相邻两笔比较 MACD 柱面积（Σ|hist|），价创新高/新低而面积
   *    收缩即标记（顶背驰/底背驰）
   */
  function chanlun(bars) {
    const n = bars.length;
    if (n < 30) return { bis: [], zs: [], duans: [], divs: [] };

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
    if (pts.length < 2) return { bis: [], zs: [], duans: [], divs: [] };

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

    // 5) 线段（实验性，极值破坏法）：段起点→段内极值端点连线；
    //    反向笔端点突破段起点价 → 本段终结于极值端点，新段自极值端点起
    const duans = [];
    {
      let st = { t: bis[0].t0, p: bis[0].p0 };
      let dir = bis[0].p1 > bis[0].p0 ? 1 : -1;
      let ep = { t: bis[0].t1, p: bis[0].p1 };
      for (let i = 1; i < bis.length; i++) {
        const b = bis[i];
        const up = b.p1 > b.p0;
        if (up === (dir > 0)) {                 // 同向：延伸段内极值
          if (dir > 0 ? b.p1 > ep.p : b.p1 < ep.p) ep = { t: b.t1, p: b.p1 };
        } else if (dir > 0 ? b.p1 < st.p : b.p1 > st.p) {   // 破坏段起点
          duans.push({ t0: st.t, p0: st.p, t1: ep.t, p1: ep.p });
          st = ep;
          dir = -dir;
          ep = { t: b.t1, p: b.p1 };
        }
      }
      duans.push({ t0: st.t, p0: st.p, t1: ep.t, p1: ep.p });
    }

    // 6) 背驰：同向相邻笔（bi i 与 i+2），价更极端而 MACD 柱面积（Σ|hist|）收缩
    const divs = [];
    {
      const hist = macd(bars.map((b) => b.c)).hist;
      const area = (b) => {
        let s = 0;
        for (let i = b.i0; i <= b.i1; i++) s += Math.abs(hist[i]);
        return s;
      };
      for (let i = 0; i + 2 < bis.length; i++) {
        const a = bis[i], b = bis[i + 2];
        const up = a.p1 > a.p0;
        if (up && b.p1 > a.p1 && area(b) < area(a)) {
          divs.push({ t: b.t1, p: b.p1, type: 'top' });
        } else if (!up && b.p1 < a.p1 && area(b) < area(a)) {
          divs.push({ t: b.t1, p: b.p1, type: 'bot' });
        }
      }
    }

    return { bis, zs, duans, divs };
  }

  /** 按开关组装缠论视图：{chan:笔+中枢, duan:线段, bei:背驰} 任一开则画笔作参照 */
  function chanView(bars, tg) {
    if (!(tg.chan || tg.duan || tg.bei)) return { bis: [], zs: [], duans: [], divs: [] };
    const c = chanlun(bars);
    return {
      bis: c.bis,
      zs: tg.chan ? c.zs : [],
      duans: tg.duan ? c.duans : [],
      divs: tg.bei ? c.divs : [],
    };
  }

  return { sma, ema, macd, boll, kdj, aggregate, chanlun, chanView };
})();
