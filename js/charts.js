// Chart.js の薄いラッパ。同じ canvas に描き直すときは古いインスタンスを破棄する。

import { compact, num, yen } from './util.js?v=202609080225';

const registry = new Map();

// 系列色。並べたときに見分けやすい順に。
const SERIES = [
  '#2f6feb', '#e07b39', '#13866f', '#a259c4', '#c2413a',
  '#0e8ecf', '#b8730b', '#5b6775', '#3fa06a', '#cf5b8f',
  '#7b6bd6', '#c9a227',
];

function themeColors() {
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  return {
    ink:  dark ? '#e8edf3' : '#1c2430',
    ink2: dark ? '#a7b2c0' : '#5b6775',
    grid: dark ? 'rgba(255,255,255,.08)' : 'rgba(16,24,40,.08)',
  };
}

export const color = (i) => SERIES[i % SERIES.length];

export function destroyAll() {
  for (const c of registry.values()) c.destroy();
  registry.clear();
}

// 注意: Chart.js は display:none の器の中で初期化すると 0x0 に固定され、
// あとから resize() を呼んでも戻らない。なので「ビューを表示にしてから描く」
// 順序を守る必要がある（app.js のタブ切り替えは hidden を外してから render する）。
// draw() は同じ canvas の既存インスタンスを毎回破棄して作り直すので、
// 表示状態で render し直せば必ず正しい寸法になる。

function draw(canvasId, config) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return null;
  registry.get(canvasId)?.destroy();

  const t = themeColors();
  const base = {
    maintainAspectRatio: false,
    responsive: true,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: {
        labels: { color: t.ink2, boxWidth: 10, boxHeight: 10, usePointStyle: true, font: { size: 11 } },
      },
      tooltip: {
        backgroundColor: 'rgba(20,26,34,.94)',
        titleFont: { size: 12 },
        bodyFont: { size: 12 },
        padding: 10,
        cornerRadius: 6,
      },
    },
  };

  config.options = deepMerge(base, config.options || {});
  const chart = new Chart(canvas, config);
  registry.set(canvasId, chart);
  return chart;
}

function deepMerge(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? deepMerge(a[k] || {}, v) : v;
  }
  return out;
}

function axes({ yTitle, y1Title, stacked = false, money = false } = {}) {
  const t = themeColors();
  const scales = {
    x: {
      stacked,
      grid: { display: false },
      ticks: { color: t.ink2, font: { size: 11 }, maxRotation: 0, autoSkip: true },
    },
    y: {
      stacked,
      beginAtZero: true,
      position: 'left',
      grid: { color: t.grid },
      border: { display: false },
      title: yTitle ? { display: true, text: yTitle, color: t.ink2, font: { size: 11 } } : undefined,
      ticks: { color: t.ink2, font: { size: 11 }, callback: (v) => (money ? '¥' + compact(v) : compact(v)) },
    },
  };
  if (y1Title) {
    scales.y1 = {
      beginAtZero: true,
      position: 'right',
      grid: { display: false },
      border: { display: false },
      title: { display: true, text: y1Title, color: t.ink2, font: { size: 11 } },
      ticks: { color: t.ink2, font: { size: 11 }, callback: (v) => compact(v) },
    };
  }
  return scales;
}

// ---- 折れ線 ------------------------------------------------------------

export function line(canvasId, labels, series, opts = {}) {
  return draw(canvasId, {
    type: 'line',
    data: {
      labels,
      datasets: series.map((s, i) => ({
        label: s.label,
        data: s.data,
        borderColor: s.color || color(i),
        backgroundColor: (s.color || color(i)) + '22',
        borderWidth: 2,
        pointRadius: labels.length > 45 ? 0 : 2.5,
        pointHoverRadius: 4,
        tension: 0.25,
        fill: Boolean(s.fill),
        yAxisID: s.axis || 'y',
        spanGaps: true,
      })),
    },
    options: { scales: axes(opts) },
  });
}

// ---- 積み上げ面 --------------------------------------------------------
// 「合計のうち、どれがどれだけ稼いだか」を色の面積で見せる。
// 高さの合計が全体の値になり、各帯がその内訳。
// 割合は足し算にならないので、CVR のような比率には使わない。
export function area(canvasId, labels, series, opts = {}) {
  const t = themeColors();
  const money = Boolean(opts.money);
  const fmt = (v) => (money ? yen(v) : num(v));

  // 各時点の合計。ツールチップで割合を出すのに使う。
  const totals = labels.map((_, i) => series.reduce((a, s) => a + Number(s.data[i] || 0), 0));

  return draw(canvasId, {
    type: 'line',
    data: {
      labels,
      datasets: series.map((s, i) => ({
        label: s.label,
        data: s.data,
        borderColor: s.color || color(i),
        backgroundColor: (s.color || color(i)) + 'd0',
        borderWidth: 1,
        pointRadius: 0,
        pointHoverRadius: 3,
        tension: 0.2,
        fill: true,
      })),
    },
    options: {
      scales: {
        x: {
          stacked: true,
          grid: { display: false },
          ticks: { color: t.ink2, font: { size: 11 }, maxRotation: 0, autoSkip: true },
        },
        y: {
          stacked: true,
          beginAtZero: true,
          grid: { color: t.grid },
          border: { display: false },
          ticks: {
            color: t.ink2,
            font: { size: 11 },
            callback: (v) => (money ? '¥' + compact(v) : compact(v)),
          },
        },
      },
      plugins: {
        tooltip: {
          callbacks: {
            label(ctx) {
              const v = Number(ctx.parsed.y || 0);
              const sum = totals[ctx.dataIndex] || 0;
              const share = sum ? ((v / sum) * 100).toFixed(1) : '0.0';
              return ` ${ctx.dataset.label}: ${fmt(v)}（${share}%）`;
            },
            footer(items) {
              return `合計 ${fmt(totals[items[0].dataIndex] || 0)}`;
            },
          },
        },
      },
    },
  });
}

// ---- 棒 ----------------------------------------------------------------

export function bar(canvasId, labels, series, opts = {}) {
  return draw(canvasId, {
    type: 'bar',
    data: {
      labels,
      datasets: series.map((s, i) => ({
        label: s.label,
        data: s.data,
        backgroundColor: s.color || color(i),
        borderRadius: 3,
        maxBarThickness: 34,
        yAxisID: s.axis || 'y',
        type: s.type,
        borderColor: s.type === 'line' ? (s.color || color(i)) : undefined,
        borderWidth: s.type === 'line' ? 2 : 0,
        pointRadius: s.type === 'line' ? 0 : undefined,
        tension: 0.25,
        order: s.type === 'line' ? 0 : 1,
      })),
    },
    options: {
      indexAxis: opts.horizontal ? 'y' : 'x',
      scales: opts.horizontal ? horizontalAxes(opts) : axes(opts),
      plugins: { legend: { display: series.length > 1 } },
    },
  });
}

function horizontalAxes({ money = false } = {}) {
  const t = themeColors();
  return {
    x: {
      beginAtZero: true,
      grid: { color: t.grid },
      border: { display: false },
      ticks: { color: t.ink2, font: { size: 11 }, callback: (v) => (money ? '¥' + compact(v) : compact(v)) },
    },
    y: {
      grid: { display: false },
      ticks: {
        color: t.ink2,
        font: { size: 11 },
        callback(value) {
          const raw = this.getLabelForValue(value);
          return raw.length > 22 ? raw.slice(0, 21) + '…' : raw;
        },
      },
    },
  };
}

// ---- 円 / ドーナツ ------------------------------------------------------

export function pie(canvasId, labels, data, opts = {}) {
  const total = data.reduce((a, b) => a + Number(b || 0), 0);
  return draw(canvasId, {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{
        data,
        backgroundColor: labels.map((_, i) => color(i)),
        borderWidth: 0,
        hoverOffset: 6,
      }],
    },
    options: {
      cutout: opts.cutout ?? '58%',
      plugins: {
        legend: { position: 'right' },
        tooltip: {
          callbacks: {
            label(ctx) {
              const v = Number(ctx.parsed || 0);
              const p = total ? ((v / total) * 100).toFixed(1) : '0.0';
              return ` ${ctx.label}: ${compact(v)}（${p}%）`;
            },
          },
        },
      },
    },
  });
}
