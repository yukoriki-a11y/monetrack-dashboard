// マイページ（自分で組み立てるダッシュボード）
//
// 「軸 × 指標 × グラフ種類」を選んでカードを並べる。
// データは既存の RPC（dash_dimension / dash_timeseries / dash_kpi）で全部作れるので、
// SQL 側の追加は不要。
// 並びはこのブラウザの localStorage に保存する（人によって違う画面にしたいので）。

import { $, el, num, yen, pct, compact, downloadCsv } from './util.js?v=202609080135';
import { api } from './db.js?v=202609080135';
import * as ch from './charts.js?v=202609080135';
import { renderTable } from './table.js?v=202609080135';

const LS_KEY = 'afd.mypage.widgets';

// ---- 選べるもの --------------------------------------------------------

export const DIMS = {
  date:       { label: '日付（推移）', clicks: true },
  affiliate:  { label: 'アフィリエイター', clicks: true },
  product:    { label: '商品', clicks: false },
  ad:         { label: '広告', clicks: true },
  campaign:   { label: 'キャンペーン', clicks: true },
  advertiser: { label: '広告主・プログラム', clicks: true },
  referrer:   { label: '流入元（リファラ）', clicks: true },
  device:     { label: 'デバイス', clicks: false },
  os:         { label: 'OS', clicks: true },
  ad_type:    { label: '広告タイプ', clicks: true, cvOnly: false, clicksOnly: true },
  status:     { label: 'ステータス', clicks: false },
  pay_status: { label: '支払い状況', clicks: false },
};

export const METRICS = {
  conversions: { label: '成果件数', fmt: num,  short: compact },
  sales:       { label: '売上',     fmt: yen,  short: (v) => '¥' + compact(v) },
  reward:      { label: '報酬額',   fmt: yen,  short: (v) => '¥' + compact(v) },
  clicks:      { label: 'クリック数', fmt: num, short: compact },
  cvr:         { label: 'CVR',      fmt: pct,  short: (v) => (v === null ? '—' : pct(v)) },
  qty:         { label: '数量',     fmt: num,  short: compact },
  aov:         { label: '平均単価', fmt: yen,  short: (v) => '¥' + compact(v) },
};

export const CHARTS = {
  bar:   '棒グラフ',
  hbar:  '横棒グラフ',
  line:  '折れ線',
  pie:   '円グラフ',
  kpi:   '数値ひとつ',
  table: '表',
};

const SIZES = { 1: '小（1枠）', 2: '中（2枠）', 3: '大（3枠）' };

// ---- 保存 --------------------------------------------------------------

const DEFAULTS = [
  { dim: 'date',       metric: 'conversions', chart: 'line', size: 3, limit: 60 },
  { dim: 'affiliate',  metric: 'sales',       chart: 'hbar', size: 2, limit: 10 },
  { dim: 'device',     metric: 'conversions', chart: 'pie',  size: 1, limit: 10 },
  { dim: 'product',    metric: 'sales',       chart: 'hbar', size: 2, limit: 10 },
  { dim: 'status',     metric: 'conversions', chart: 'pie',  size: 1, limit: 10 },
];

let widgets = [];

function load() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.filter(valid).map(withId);
    }
  } catch { /* 壊れていたら既定に戻す */ }
  return DEFAULTS.map(withId);
}

function save() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(widgets));
  } catch { /* 保存できなくても画面は動かす */ }
}

const valid = (w) => w && DIMS[w.dim] && METRICS[w.metric] && CHARTS[w.chart];
const withId = (w) => ({ size: 1, limit: 10, ...w, id: w.id || crypto.randomUUID() });

// ---- 初期化 ------------------------------------------------------------

let ctx = null;   // { getFilter, rerender }

export function initMyPage(options) {
  ctx = options;
  widgets = load();

  $('#mp-add').addEventListener('click', () => openEditor(null));
  $('#mp-reset').addEventListener('click', () => {
    if (!confirm('並びを初期状態に戻します。よろしいですか？')) return;
    widgets = DEFAULTS.map(withId);
    save();
    ctx.rerender();
  });

  $('#mp-form').addEventListener('submit', (e) => {
    e.preventDefault();
    commitEditor();
  });
  $('#mp-cancel').addEventListener('click', () => $('#mp-dialog').close());
  $('#mp-dim').addEventListener('change', syncEditorOptions);
  $('#mp-chart').addEventListener('change', syncEditorOptions);

  fillSelect($('#mp-dim'), DIMS);
  fillSelect($('#mp-metric'), METRICS);
  fillSelect($('#mp-chart'), CHARTS);
  fillSelect($('#mp-size'), SIZES);
}

function fillSelect(sel, dict) {
  sel.replaceChildren(...Object.entries(dict).map(([v, d]) =>
    el('option', { value: v, text: typeof d === 'string' ? d : d.label })));
}

// ---- 追加・編集ダイアログ ----------------------------------------------

let editingId = null;

function openEditor(widget) {
  editingId = widget?.id ?? null;
  $('#mp-dialog-title').textContent = widget ? 'グラフを編集' : 'グラフを追加';
  $('#mp-dim').value = widget?.dim ?? 'affiliate';
  $('#mp-metric').value = widget?.metric ?? 'sales';
  $('#mp-chart').value = widget?.chart ?? 'hbar';
  $('#mp-size').value = String(widget?.size ?? 2);
  $('#mp-limit').value = String(widget?.limit ?? 10);
  syncEditorOptions();
  $('#mp-dialog').showModal();
}

// 軸やグラフ種類によって意味を持たない組み合わせを塞ぐ
function syncEditorOptions() {
  const dim = $('#mp-dim').value;
  const chart = $('#mp-chart').value;
  const d = DIMS[dim] || {};

  for (const opt of $('#mp-metric').options) {
    // クリック側に存在しない軸では「クリック数」「CVR」は出せない
    const needsClicks = opt.value === 'clicks' || opt.value === 'cvr';
    opt.disabled = needsClicks && !d.clicks;
  }
  // 広告タイプはクリックにしか無い軸なので、成果系の指標は出せない
  if (d.clicksOnly) {
    for (const opt of $('#mp-metric').options) {
      opt.disabled = !['clicks'].includes(opt.value);
    }
  }
  if ($('#mp-metric').selectedOptions[0]?.disabled) {
    const first = Array.from($('#mp-metric').options).find((o) => !o.disabled);
    if (first) $('#mp-metric').value = first.value;
  }

  // 「数値ひとつ」は軸を使わない / 円グラフは件数系のみ意味がある
  const isKpi = chart === 'kpi';
  $('#mp-dim').disabled = isKpi;
  $('#mp-limit').disabled = isKpi || chart === 'pie' ? isKpi : false;
  $('#mp-limit-row').hidden = isKpi;
  $('#mp-dim-row').hidden = isKpi;
  $('#mp-hint').textContent = isKpi
    ? '期間全体の合計をひとつの数字として出します。'
    : dim === 'date'
      ? '日ごとの推移として出します。表示件数は日数の上限です。'
      : `${DIMS[dim].label}の上位を、指定した件数だけ出します。`;
}

function commitEditor() {
  const w = {
    id: editingId,
    dim: $('#mp-chart').value === 'kpi' ? 'date' : $('#mp-dim').value,
    metric: $('#mp-metric').value,
    chart: $('#mp-chart').value,
    size: Number($('#mp-size').value),
    limit: Math.min(Math.max(Number($('#mp-limit').value) || 10, 3), 50),
  };
  if (editingId) {
    const i = widgets.findIndex((x) => x.id === editingId);
    if (i >= 0) widgets[i] = { ...widgets[i], ...w };
  } else {
    widgets.push(withId(w));
  }
  save();
  $('#mp-dialog').close();
  ctx.rerender();
}

// ---- 描画 --------------------------------------------------------------

export async function renderMyPage(filter) {
  const board = $('#mp-board');
  board.replaceChildren();

  if (!widgets.length) {
    board.append(el('div', { class: 'card mp-empty' },
      el('p', { class: 'muted', text: 'まだグラフがありません。「グラフを追加」から作ってください。' })));
    return;
  }

  // カードの枠を先に作る（Chart.js は表示された器の中で初期化する必要がある）
  const slots = widgets.map((w) => {
    const canvasId = `mp-c-${w.id}`;
    const body = w.chart === 'table'
      ? el('div', { class: 'table-wrap' }, el('table', { id: `mp-t-${w.id}` }))
      : w.chart === 'kpi'
        ? el('div', { class: 'mp-kpi', id: `mp-k-${w.id}` })
        : el('div', { class: 'chart-wrap' }, el('canvas', { id: canvasId }));

    const card = el('div', { class: `card span${w.size} mp-card` },
      el('div', { class: 'card-head' },
        el('h2', { text: titleOf(w) }),
        el('div', { class: 'row mp-tools' },
          el('button', { class: 'btn link', text: '←', title: '左へ', onclick: () => move(w.id, -1) }),
          el('button', { class: 'btn link', text: '→', title: '右へ', onclick: () => move(w.id, 1) }),
          el('button', { class: 'btn link', text: '編集', onclick: () => openEditor(w) }),
          el('button', { class: 'btn link', text: '×', title: '削除', onclick: () => remove(w.id) }),
        )),
      body);
    board.append(card);
    return { w, canvasId };
  });

  // データを取ってから描く
  await Promise.all(slots.map(({ w, canvasId }) => drawWidget(w, canvasId, filter)));
}

function titleOf(w) {
  if (w.chart === 'kpi') return METRICS[w.metric].label;
  if (w.dim === 'date') return `${METRICS[w.metric].label} の推移`;
  return `${DIMS[w.dim].label}別 ${METRICS[w.metric].label}`;
}

async function drawWidget(w, canvasId, filter) {
  try {
    if (w.chart === 'kpi') {
      const k = await api.kpi(filter);
      const v = k[w.metric] ?? null;
      $(`#mp-k-${w.id}`).replaceChildren(
        el('div', { class: 'v', text: METRICS[w.metric].fmt(v) }));
      return;
    }

    const rows = w.dim === 'date'
      ? (await api.timeseries(filter, grainFor(w.limit))).slice(-w.limit)
        .map((r) => ({ label: String(r.bucket).slice(5), ...pickAll(r) }))
      : (await api.dimension(filter, w.dim, w.limit)).map((r) => ({ label: r.label, ...pickAll(r) }));

    const values = rows.map((r) => r[w.metric]);
    const label = METRICS[w.metric].label;
    const money = w.metric === 'sales' || w.metric === 'reward' || w.metric === 'aov';

    if (w.chart === 'line') {
      ch.line(canvasId, rows.map((r) => r.label), [{ label, data: values, fill: true }], { money });
    } else if (w.chart === 'hbar') {
      ch.bar(canvasId, rows.map((r) => r.label), [{ label, data: values }], { horizontal: true, money });
    } else if (w.chart === 'bar') {
      ch.bar(canvasId, rows.map((r) => r.label), [{ label, data: values }], { money });
    } else if (w.chart === 'pie') {
      ch.pie(canvasId, rows.map((r) => r.label), values);
    } else if (w.chart === 'table') {
      renderTable($(`#mp-t-${w.id}`), [
        { key: 'label', label: w.dim === 'date' ? '期間' : DIMS[w.dim].label, type: 'text' },
        { key: w.metric, label, type: metricType(w.metric) },
      ], rows, { sortKey: w.metric, sortDir: 'desc' });
    }
  } catch (e) {
    const box = $(`#mp-c-${w.id}`)?.parentElement || $(`#mp-t-${w.id}`)?.parentElement || $(`#mp-k-${w.id}`);
    if (box) box.replaceChildren(el('p', { class: 'err small', text: e.message }));
  }
}

// 全指標を計算して持たせる（CVR と平均単価は割り算で作る）
function pickAll(r) {
  const conversions = Number(r.conversions || 0);
  const clicks = Number(r.clicks || 0);
  const sales = Number(r.sales || 0);
  return {
    conversions,
    clicks,
    sales,
    reward: Number(r.reward || 0),
    qty: Number(r.qty || 0),
    cvr: r.cvr !== undefined && r.cvr !== null
      ? Number(r.cvr)
      : (clicks ? (conversions * 100) / clicks : null),
    aov: conversions ? Math.round(sales / conversions) : 0,
  };
}

const metricType = (m) =>
  m === 'sales' || m === 'reward' || m === 'aov' ? 'yen' : m === 'cvr' ? 'pct' : 'num';

// 表示件数から粒度を決める（60日を超えたら週、200を超えたら月）
const grainFor = (limit) => (limit > 200 ? 'month' : limit > 60 ? 'week' : 'day');

// ---- 並べ替え・削除 ----------------------------------------------------

function move(id, delta) {
  const i = widgets.findIndex((w) => w.id === id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= widgets.length) return;
  [widgets[i], widgets[j]] = [widgets[j], widgets[i]];
  save();
  ctx.rerender();
}

function remove(id) {
  widgets = widgets.filter((w) => w.id !== id);
  save();
  ctx.rerender();
}

// ---- CSV 出力 ----------------------------------------------------------

export async function exportMyPage(filter) {
  const rowsOut = [];
  for (const w of widgets) {
    if (w.chart === 'kpi') continue;
    const rows = w.dim === 'date'
      ? (await api.timeseries(filter, grainFor(w.limit))).slice(-w.limit)
        .map((r) => ({ label: String(r.bucket), ...pickAll(r) }))
      : (await api.dimension(filter, w.dim, w.limit)).map((r) => ({ label: r.label, ...pickAll(r) }));
    for (const r of rows) rowsOut.push([titleOf(w), r.label, r[w.metric]]);
  }
  downloadCsv(`マイページ_${filter.from}_${filter.to}.csv`, ['グラフ', '項目', '値'], rowsOut);
}
