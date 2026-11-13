/* 多主题与全局基础存储（K线道场）：暗黑 / 明亮 / 米色 / 白蓝 / 深蓝
 * CSS 变量在 style.css 按 [data-theme] 切换；图表/canvas 颜色由本模块提供，
 * 主题切换时通知所有监听方重建图表。记忆在 localStorage(dojo_theme)。
 * 同时提供统一的均线定义 (MA_DEFS) 与跨页签同步的自选股存储 (DojoWatchlist)。
 */
'use strict';

/* 旧版 bz_* localStorage 键一次性迁移到 dojo_*。
 * 只复制不删除旧键，保留回滚余地；新键已存在时不覆盖。 */
(() => {
  try {
    const legacy = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith('bz_')) legacy.push(k);
    }
    for (const k of legacy) {
      const nk = 'dojo_' + k.slice(3);
      if (localStorage.getItem(nk) == null) {
        const v = localStorage.getItem(k);
        if (v != null) localStorage.setItem(nk, v);
      }
    }
  } catch { /* localStorage 不可用或配额不足：继续用默认值 */ }
})();

window.DojoTheme = (() => {
  const MA_DEFS = [
    { p: 5, color: '#f0b90b' }, { p: 10, color: '#4a90e2' },
    { p: 13, color: '#22c1c3' }, { p: 20, color: '#c77dff' },
    { p: 21, color: '#ff6b9d' }, { p: 40, color: '#9ccc65' },
    { p: 60, color: '#ff8c42' }, { p: 120, color: '#8892a6' },
  ];
  const MA_DEFAULT = [5, 10, 20, 60];

  const THEMES = {
    dark: {
      label: '暗黑',
      bg: '#0b0e14', panel: '#12161f', panel2: '#171c27', line: '#232a38',
      text: '#e6ebf4', dim: '#9aa4b8', grid: '#1a2130',
      up: '#e0483e', down: '#1fa06b', accent: '#f0b90b', onAccent: '#1a1a05',
      blue: '#4a90e2', trend: '#4a90e2', hline: '#e0483e',
      fib: '#c77dff', channel: '#ffa94d', rect: '#8892a6', note: '#f0b90b',
      bollMid: '#f0b90b', bollBand: '#8892a6',
      kdjK: '#f0b90b', kdjD: '#4a90e2', kdjJ: '#c77dff',
      chanBi: '#00e5ff', chanZs: 'rgba(240,185,11,.08)', chanZsBorder: 'rgba(240,185,11,.55)',
      chanDuan: '#ff8c42',
      volUp: 'rgba(224,72,62,.45)', volDown: 'rgba(31,160,107,.45)',
      macdUp: 'rgba(224,72,62,.7)', macdDown: 'rgba(31,160,107,.7)',
      toastBg: '#2a1520', toastText: '#ffb4b4', toastOkBg: '#10231b', toastOkText: '#8fe6c0',
    },
    light: {
      label: '明亮',
      bg: '#f4f5f7', panel: '#ffffff', panel2: '#eff1f4', line: '#e2e6eb',
      text: '#2c333d', dim: '#707a86', grid: '#edeff2',
      up: '#d9382e', down: '#178f5f', accent: '#c8860a', onAccent: '#fffaf0',
      blue: '#2f6fd0', trend: '#2f6fd0', hline: '#d9382e',
      fib: '#7c3aed', channel: '#b45309', rect: '#6a737d', note: '#92660a',
      bollMid: '#b47400', bollBand: '#64748b',
      kdjK: '#b47400', kdjD: '#2f6fd0', kdjJ: '#7c3aed',
      chanBi: '#0087a8', chanZs: 'rgba(200,134,10,.10)', chanZsBorder: 'rgba(200,134,10,.6)',
      chanDuan: '#c2410c',
      volUp: 'rgba(217,56,46,.42)', volDown: 'rgba(23,143,95,.42)',
      macdUp: 'rgba(217,56,46,.68)', macdDown: 'rgba(23,143,95,.68)',
      toastBg: '#fdecee', toastText: '#b3271d', toastOkBg: '#e8f7f0', toastOkText: '#0e7a52',
    },
    cream: {
      label: '米色',
      bg: '#efe9dc', panel: '#f8f4ea', panel2: '#f0ead9', line: '#ddd3bd',
      text: '#3f3a2d', dim: '#857c66', grid: '#e9e2d0',
      up: '#c73e3a', down: '#157f52', accent: '#b8860b', onAccent: '#fffaf0',
      blue: '#3a6ea5', trend: '#3a6ea5', hline: '#c73e3a',
      fib: '#7c5cd6', channel: '#a16207', rect: '#857c66', note: '#8a6d0a',
      bollMid: '#9a6b00', bollBand: '#78705e',
      kdjK: '#9a6b00', kdjD: '#3a6ea5', kdjJ: '#7c5cd6',
      chanBi: '#00798c', chanZs: 'rgba(184,134,11,.10)', chanZsBorder: 'rgba(184,134,11,.6)',
      chanDuan: '#c2540a',
      volUp: 'rgba(199,62,58,.42)', volDown: 'rgba(21,127,82,.42)',
      macdUp: 'rgba(199,62,58,.68)', macdDown: 'rgba(21,127,82,.68)',
      toastBg: '#f8e8e6', toastText: '#a3271d', toastOkBg: '#e6f2ea', toastOkText: '#0e7a52',
    },
    blue: {
      label: '白蓝',
      bg: '#eef3fa', panel: '#ffffff', panel2: '#e7eef8', line: '#d3dfec',
      text: '#1f3350', dim: '#5c7189', grid: '#e3ecf6',
      up: '#d9382e', down: '#178f5f', accent: '#1e6fd9', onAccent: '#ffffff',
      blue: '#1e6fd9', trend: '#1e6fd9', hline: '#d9382e',
      fib: '#6d5bd0', channel: '#a16207', rect: '#5c7189', note: '#8a6d0a',
      bollMid: '#b47400', bollBand: '#5c7189',
      kdjK: '#b47400', kdjD: '#1e6fd9', kdjJ: '#6d5bd0',
      chanBi: '#0087a8', chanZs: 'rgba(30,111,217,.10)', chanZsBorder: 'rgba(30,111,217,.55)',
      chanDuan: '#c2540a',
      volUp: 'rgba(217,56,46,.42)', volDown: 'rgba(23,143,95,.42)',
      macdUp: 'rgba(217,56,46,.68)', macdDown: 'rgba(23,143,95,.68)',
      toastBg: '#fdf0f1', toastText: '#b3271d', toastOkBg: '#e8f7f0', toastOkText: '#0e7a52',
    },
    navy: {
      label: '深蓝',
      bg: '#0a1428', panel: '#0f1d36', panel2: '#142544', line: '#1e3252',
      text: '#d6e2f2', dim: '#7186a3', grid: '#12233d',
      up: '#ff5d52', down: '#2ecc8f', accent: '#4da3ff', onAccent: '#06122b',
      blue: '#4da3ff', trend: '#4da3ff', hline: '#ff5d52',
      fib: '#b98cff', channel: '#f0b35c', rect: '#7186a3', note: '#ffd24d',
      bollMid: '#ffd24d', bollBand: '#7186a3',
      kdjK: '#ffd24d', kdjD: '#4da3ff', kdjJ: '#b98cff',
      chanBi: '#00e5ff', chanZs: 'rgba(77,163,255,.10)', chanZsBorder: 'rgba(77,163,255,.55)',
      chanDuan: '#ff8c42',
      volUp: 'rgba(255,93,82,.45)', volDown: 'rgba(46,204,143,.45)',
      macdUp: 'rgba(255,93,82,.7)', macdDown: 'rgba(46,204,143,.7)',
      toastBg: '#2a1520', toastText: '#ffb4b4', toastOkBg: '#10231b', toastOkText: '#8fe6c0',
    },
  };

  // 浅色主题下均线改用加深色，避免亮黄/亮紫在白底上对比度不足
  const MA_LIGHT = {
    5: '#8f6400', 10: '#2f6fd0', 13: '#0b6e70', 20: '#7c3aed',
    21: '#c2185b', 40: '#4f7f2f', 60: '#c25e00', 120: '#5f6b7a',
  };

  const _saved = localStorage.getItem('dojo_theme');
  let current = THEMES[_saved] ? _saved : 'dark';   // 坏值回退，避免 colors() 返回 undefined
  const listeners = [];

  function get() { return current; }
  function colors() { return THEMES[current]; }
  function list() { return Object.keys(THEMES).map((k) => ({ key: k, label: THEMES[k].label })); }
  function maColor(p, fallback) {
    return (current === 'light' || current === 'cream' || current === 'blue') && MA_LIGHT[p]
      ? MA_LIGHT[p] : fallback;
  }

  function apply(name, silent) {
    if (!THEMES[name]) return;
    current = name;
    localStorage.setItem('dojo_theme', name);
    document.documentElement.setAttribute('data-theme', name);
    if (!silent) listeners.forEach((f) => { try { f(name); } catch (e) { console.error('theme listener error', e); } });
  }

  function onChange(f) { listeners.push(f); }

  apply(current, true);
  return { get, colors, apply, onChange, list, maColor, MA_DEFS, MA_DEFAULT };
})();

/* 统一自选股存储：消除训练页与行情板双份内存副本互相覆盖的问题 */
window.DojoWatchlist = (() => {
  const KEY = 'dojo_watchlist';
  const MAX = 60;
  const subs = [];

  function load() {
    try {
      const raw = JSON.parse(localStorage.getItem(KEY) || '[]');
      return Array.isArray(raw) ? raw.filter((x) => x && x.code) : [];
    } catch {
      return [];
    }
  }

  function save(list) {
    localStorage.setItem(KEY, JSON.stringify(list));
    subs.forEach((fn) => { try { fn(list); } catch (e) { console.error('watchlist sub error', e); } });
  }

  function has(code) {
    return load().some((w) => w.code === code);
  }

  function add(code, name) {
    const list = load();
    if (list.some((w) => w.code === code)) return list;
    const cleanName = String(name || code).replace(/\s+\d{6}$/, '');
    list.unshift({ code, name: cleanName });
    const next = list.slice(0, MAX);
    save(next);
    return next;
  }

  function remove(code) {
    const list = load();
    const next = list.filter((w) => w.code !== code);
    if (next.length !== list.length) save(next);
    return next;
  }

  function onChange(fn) {
    subs.push(fn);
  }

  window.addEventListener('storage', (e) => {
    if (e.key === KEY) {
      const list = load();
      subs.forEach((fn) => { try { fn(list); } catch { /* ignore */ } });
    }
  });

  return { load, save, has, add, remove, onChange };
})();
