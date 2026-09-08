// Chart.js の薄いラッパ。同じ canvas に描き直すときは古いインスタンスを破棄する。

import { compact, num, yen } from './util.js?v=202609081424';
import { palette, isDark } from './settings.js?v=202609081424';

const registry = new Map();

function themeColors() {
  const dark = isDark();
  return {
    ink:  dark ? '#e8edf3' : '#1c2430',
    ink2: dark ? '#a7b2c0' : '#5b6775',
    grid: dark ? 'rgba(255,255,255,.08)' : 'rgba(16,24,40,.08)',
  };
}

// 系列色。設定で切り替えられる（js/settings.js の PALETTES）。
export const color = (i) => {
  const p = palette();
  return p[i % p.length];
};

export function destroyAll() {
  for (const c of registry.values()) c.destroy();
  registry.clear();
  hideTip();
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
  hideTip();

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

// 凡例のクリックで系列を出し入れする。
// 既定の動きは残しつつ、呼び出し側に「いま隠したか」を知らせて覚えてもらう
// （描き直すたびに Chart.js の状態は消えるため）。
function legendPlugin(series, onLegend) {
  return {
    labels: { filter: () => true },
    onClick(e, item, legend) {
      const chart = legend.chart;
      const meta = chart.getDatasetMeta(item.datasetIndex);
      const hidden = meta.hidden === null ? !chart.data.datasets[item.datasetIndex].hidden : !meta.hidden;
      meta.hidden = hidden;
      chart.update();
      onLegend?.(series[item.datasetIndex]?.label, hidden);
    },
  };
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

// =======================================================================
// 内訳の円グラフツールチップ
// マウスを当てた1点の内訳を、行の羅列ではなく円グラフで見せる。
// 常時表示の円グラフは持たない（画面が埋まるので）。
// =======================================================================

let tipEl = null;

function tipBox() {
  if (tipEl && tipEl.isConnected) return tipEl;
  tipEl = document.createElement('div');
  tipEl.className = 'chart-tip';
  tipEl.hidden = true;
  document.body.append(tipEl);
  return tipEl;
}

function hideTip() {
  if (tipEl) tipEl.hidden = true;
}

// タブを切り替えたときなど、外から消したいとき用
export const hideTooltip = hideTip;

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// 値の配列 → ドーナツの SVG。合計が0のときは空を返す。
function donutSvg(parts, size = 108) {
  const total = parts.reduce((a, p) => a + p.value, 0);
  if (!total) return '';
  const r = size / 2;
  const ir = r * 0.56;
  const pt = (ang, rad) =>
    `${(r + Math.cos(ang) * rad).toFixed(2)} ${(r + Math.sin(ang) * rad).toFixed(2)}`;

  // 1系列で100%のとき、円弧の始点と終点が重なって描けないのでリングで塗る
  if (parts.length === 1) {
    return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-hidden="true">`
      + `<circle cx="${r}" cy="${r}" r="${(r + ir) / 2}" fill="none"`
      + ` stroke="${parts[0].color}" stroke-width="${r - ir}"/></svg>`;
  }

  let acc = 0;
  const arcs = parts.map((p) => {
    const a0 = (acc / total) * Math.PI * 2 - Math.PI / 2;
    acc += p.value;
    const a1 = (acc / total) * Math.PI * 2 - Math.PI / 2;
    const large = a1 - a0 > Math.PI ? 1 : 0;
    return `<path d="M ${pt(a0, r)} A ${r} ${r} 0 ${large} 1 ${pt(a1, r)}`
      + ` L ${pt(a1, ir)} A ${ir} ${ir} 0 ${large} 0 ${pt(a0, ir)} Z" fill="${p.color}"/>`;
  }).join('');
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-hidden="true">${arcs}</svg>`;
}

const TIP_LEGEND = 8;   // 円グラフの脇に名前を出す数。あとは「ほか」でまとめる

// Chart.js の external ツールチップ。fmt は合計の書式。
function pieTooltip(fmt) {
  return {
    enabled: false,
    external(ctx) {
      const box = tipBox();
      const tt = ctx.tooltip;
      const i = tt?.dataPoints?.[0]?.dataIndex;
      if (!tt || tt.opacity === 0 || i == null) { box.hidden = true; return; }

      const parts = ctx.chart.data.datasets
        .map((ds, k) => ({
          label: ds.label,
          value: Number(ds.data[i] || 0),
          color: ds.borderColor || color(k),
          hidden: ctx.chart.getDatasetMeta(k).hidden,
        }))
        .filter((p) => !p.hidden && p.value > 0)
        .sort((a, b) => b.value - a.value);

      const total = parts.reduce((a, p) => a + p.value, 0);
      if (!total) { box.hidden = true; return; }

      const share = (v) => ((v / total) * 100).toFixed(1) + '%';
      const shown = parts.slice(0, TIP_LEGEND);
      const rest = parts.slice(TIP_LEGEND);
      const restSum = rest.reduce((a, p) => a + p.value, 0);

      const legend = shown.map((p) =>
        `<li><i style="background:${p.color}"></i>`
        + `<b>${esc(p.label)}</b><span>${share(p.value)}</span></li>`).join('')
        + (rest.length
          ? `<li class="rest"><i></i><b>ほか ${rest.length} 件</b><span>${share(restSum)}</span></li>`
          : '');

      box.innerHTML =
        `<div class="tip-head"><span>${esc(tt.title?.[0] || '')}</span><b>${esc(fmt(total))}</b></div>`
        + `<div class="tip-body">${donutSvg(parts)}<ul>${legend}</ul></div>`;
      box.hidden = false;

      // 位置決め。カーソルの右に置き、画面からはみ出すなら左に寄せる。
      const rect = ctx.chart.canvas.getBoundingClientRect();
      const w = box.offsetWidth;
      const h = box.offsetHeight;
      let x = rect.left + tt.caretX + 16;
      if (x + w > innerWidth - 8) x = rect.left + tt.caretX - w - 16;
      x = Math.max(8, x);
      const y = Math.max(8, Math.min(rect.top + tt.caretY - h / 2, innerHeight - h - 8));
      box.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    },
  };
}

// ---- 折れ線 ------------------------------------------------------------

export function line(canvasId, labels, series, opts = {}) {
  const money = Boolean(opts.money);
  const fmt = (v) => (money ? yen(v) : num(v));
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
        tension: 0,          // 点と点を直線でつなぐ（曲線にすると無い値を通ってしまう）
        fill: Boolean(s.fill),
        hidden: Boolean(s.hidden),
        yAxisID: s.axis || 'y',
        spanGaps: true,
      })),
    },
    options: {
      scales: axes(opts),
      plugins: {
        legend: legendPlugin(series, opts.onLegend),
        ...(opts.pieTooltip ? { tooltip: pieTooltip(fmt) } : {}),
      },
    },
  });
}

// ---- 積み上げ面 --------------------------------------------------------
// 「合計のうち、どれがどれだけ稼いだか」を色の面積で見せる。
// 高さの合計が全体の値になり、各帯がその内訳。
// 割合は足し算にならないので、CVR のような比率には使わない。
//
// opts.filled === false のときは塗らずに線だけにする。積み上げもやめて
// 素の重ね合わせにする（塗らないまま積み上げると読み違えるため）。
export function area(canvasId, labels, series, opts = {}) {
  const t = themeColors();
  const money = Boolean(opts.money);
  const filled = opts.filled !== false;
  const fmt = (v) => (money ? yen(v) : num(v));

  return draw(canvasId, {
    type: 'line',
    data: {
      labels,
      datasets: series.map((s, i) => ({
        label: s.label,
        data: s.data,
        borderColor: s.color || color(i),
        backgroundColor: (s.color || color(i)) + (filled ? 'd0' : '18'),
        borderWidth: filled ? 1 : 2,
        pointRadius: 0,
        pointHoverRadius: 3,
        tension: 0,          // 点と点を直線でつなぐ
        fill: filled,
        hidden: Boolean(s.hidden),
        spanGaps: true,
      })),
    },
    options: {
      scales: {
        x: {
          stacked: filled,
          grid: { display: false },
          ticks: { color: t.ink2, font: { size: 11 }, maxRotation: 0, autoSkip: true },
        },
        y: {
          stacked: filled,
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
        // 内訳はマウスを当てたときに円グラフで見せる
        tooltip: pieTooltip(fmt),
        legend: legendPlugin(series, opts.onLegend),
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
        tension: 0,          // 点と点を直線でつなぐ（曲線にすると無い値を通ってしまう）
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

// 円グラフの各切れ端に割合を書く。
// 外部プラグインを足さずに済ませたいので、描き終わりに自分で書き込む。
// 小さすぎる切れ端は字が入らないので飛ばす（重なって読めなくなる）。
const PIE_MIN_LABEL = 4;   // これ未満（%）は書かない

const pieLabelPlugin = {
  id: 'afdPieLabels',
  afterDatasetsDraw(chart) {
    const meta = chart.getDatasetMeta(0);
    if (!meta?.data?.length) return;
    const values = chart.data.datasets[0].data.map((v) => Number(v || 0));
    const total = values.reduce((a, b) => a + b, 0);
    if (!total) return;

    const { ctx } = chart;
    ctx.save();
    ctx.font = '600 11px -apple-system, "Segoe UI", "Hiragino Kaku Gothic ProN", Meiryo, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';

    meta.data.forEach((arc, i) => {
      if (meta.data[i].hidden) return;
      const share = (values[i] / total) * 100;
      if (share < PIE_MIN_LABEL) return;
      const { x, y } = arc.tooltipPosition();
      const text = `${share < 10 ? share.toFixed(1) : Math.round(share)}%`;
      // 塗りの色は濃淡がまちまちなので、白字に暗い縁を付けて必ず読めるようにする
      ctx.strokeStyle = 'rgba(16,24,40,.65)';
      ctx.lineWidth = 3;
      ctx.strokeText(text, x, y);
      ctx.fillStyle = '#fff';
      ctx.fillText(text, x, y);
    });
    ctx.restore();
  },
};

export function pie(canvasId, labels, data, opts = {}) {
  const total = data.reduce((a, b) => a + Number(b || 0), 0);
  return draw(canvasId, {
    type: 'doughnut',
    plugins: [pieLabelPlugin],
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
