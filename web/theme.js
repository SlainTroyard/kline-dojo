/* 多主题（K线道场）：明/暗/白蓝/深蓝
 * CSS 变量在 style.css 按 [data-theme] 切换；图表/canvas 颜色由本模块提供，
 * 主题切换时通知所有监听方重建图表。记忆在 localStorage(bz_theme)。
 */
'use strict';
window.BzTheme = (() => {
  const THEMES = {
    dark: {
      label: '暗黑',
      bg: '#0b0e14', panel: '#12161f', panel2: '#171c27', line: '#232a38',
      text: '#e6ebf4', dim: '#9aa4b8', grid: '#1a2130',
      up: '#e0483e', down: '#1fa06b', accent: '#f0b90b', onAccent: '#1a1a05',
      blue: '#4a90e2', trend: '#4a90e2', hline: '#e0483e',
      fib: '#c77dff', channel: '#ffa94d', rect: '#8892a6', note: '#f0b90b',
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
      chanBi: '#0087a8', chanZs: 'rgba(200,134,10,.10)', chanZsBorder: 'rgba(200,134,10,.6)',
      chanDuan: '#c2410c',
      volUp: 'rgba(217,56,46,.4)', volDown: 'rgba(23,143,95,.4)',
      macdUp: 'rgba(217,56,46,.65)', macdDown: 'rgba(23,143,95,.65)',
      toastBg: '#fdecee', toastText: '#b3271d', toastOkBg: '#e8f7f0', toastOkText: '#0e7a52',
    },
    cream: {
      label: '米色',
      bg: '#efe9dc', panel: '#f8f4ea', panel2: '#f0ead9', line: '#ddd3bd',
      text: '#3f3a2d', dim: '#857c66', grid: '#e9e2d0',
      up: '#c73e3a', down: '#157f52', accent: '#b8860b', onAccent: '#fffaf0',
      blue: '#3a6ea5', trend: '#3a6ea5', hline: '#c73e3a',
      fib: '#7c5cd6', channel: '#a16207', rect: '#857c66', note: '#8a6d0a',
      chanBi: '#00798c', chanZs: 'rgba(184,134,11,.10)', chanZsBorder: 'rgba(184,134,11,.6)',
      chanDuan: '#c2540a',
      volUp: 'rgba(199,62,58,.4)', volDown: 'rgba(21,127,82,.4)',
      macdUp: 'rgba(199,62,58,.65)', macdDown: 'rgba(21,127,82,.65)',
      toastBg: '#f8e8e6', toastText: '#a3271d', toastOkBg: '#e6f2ea', toastOkText: '#0e7a52',
    },
    blue: {
      label: '白蓝',
      bg: '#eef3fa', panel: '#ffffff', panel2: '#e7eef8', line: '#d3dfec',
      text: '#1f3350', dim: '#5c7189', grid: '#e3ecf6',
      up: '#d9382e', down: '#178f5f', accent: '#1e6fd9', onAccent: '#ffffff',
      blue: '#1e6fd9', trend: '#1e6fd9', hline: '#d9382e',
      fib: '#6d5bd0', channel: '#a16207', rect: '#5c7189', note: '#8a6d0a',
      chanBi: '#0087a8', chanZs: 'rgba(30,111,217,.10)', chanZsBorder: 'rgba(30,111,217,.55)',
      chanDuan: '#c2540a',
      volUp: 'rgba(217,56,46,.4)', volDown: 'rgba(23,143,95,.4)',
      macdUp: 'rgba(217,56,46,.65)', macdDown: 'rgba(23,143,95,.65)',
      toastBg: '#fdf0f1', toastText: '#b3271d', toastOkBg: '#e8f7f0', toastOkText: '#0e7a52',
    },
    navy: {
      label: '深蓝',
      bg: '#0a1428', panel: '#0f1d36', panel2: '#142544', line: '#1e3252',
      text: '#d6e2f2', dim: '#7186a3', grid: '#12233d',
      up: '#ff5d52', down: '#2ecc8f', accent: '#4da3ff', onAccent: '#06122b',
      blue: '#4da3ff', trend: '#4da3ff', hline: '#ff5d52',
      fib: '#b98cff', channel: '#f0b35c', rect: '#7186a3', note: '#ffd24d',
      chanBi: '#00e5ff', chanZs: 'rgba(77,163,255,.10)', chanZsBorder: 'rgba(77,163,255,.55)',
      chanDuan: '#ff8c42',
      volUp: 'rgba(255,93,82,.45)', volDown: 'rgba(46,204,143,.45)',
      macdUp: 'rgba(255,93,82,.7)', macdDown: 'rgba(46,204,143,.7)',
      toastBg: '#2a1520', toastText: '#ffb4b4', toastOkBg: '#10231b', toastOkText: '#8fe6c0',
    },
  };

  const _saved = localStorage.getItem('bz_theme');
  let current = THEMES[_saved] ? _saved : 'dark';   // 坏值回退，避免 colors() 返回 undefined
  const listeners = [];

  function get() { return current; }
  function colors() { return THEMES[current]; }
  function list() { return Object.keys(THEMES).map((k) => ({ key: k, label: THEMES[k].label })); }

  function apply(name, silent) {
    if (!THEMES[name]) return;
    current = name;
    localStorage.setItem('bz_theme', name);
    document.documentElement.setAttribute('data-theme', name);
    if (!silent) listeners.forEach((f) => { try { f(name); } catch (e) { console.error('theme listener error', e); /* 单个失败不阻断 */ } });
  }

  function onChange(f) { listeners.push(f); }

  apply(current, true);
  return { get, colors, apply, onChange, list };
})();
