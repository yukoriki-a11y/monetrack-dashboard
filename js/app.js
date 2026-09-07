// 画面全体の制御：認証ゲート → フィルタ → 各ビューの描画

import { $, $$, el, num, yen, pct, compact, ymd, addDays, fmtDateTime, downloadCsv, debounce, statusBadge } from './util.js';
import { hasConn, saveConn, clearConn, getConn, sb, signIn, signOut, currentUser, onAuthChange, api } from './db.js';
import * as ch from './charts.js';
import { renderTable, resetSort } from './table.js';
import { initImporter, loadImportHistory } from './importer.js';
import { initMyPage, renderMyPage, exportMyPage } from './mypage.js';

// ---- 状態 --------------------------------------------------------------

const state = {
  view: 'summary',
  filter: { from: null, to: null, statuses: [], advertisers: [] },
  meta: null,           // dash_filters の結果
  grain: 'day',
  dim: 'product',
  summaryRows: [],      // サマリーの日別行
  affiliates: [],       // アフィリエイター一覧のキャッシュ
  compare: {            // 比較タブ
    dim: 'affiliate',
    metric: 'conversions',
    grain: 'day',
    // null = まだ選んでいない（上位を自動選択する） / [] = 明示的に空にした
    picked: { affiliate: null, advertiser: null },
    candidates: [],
    rows: [],
    totals: [],
  },
  trendRows: [],
  dimRows: [],
  srcRows: [],
  selectedAffiliate: null,
  detail: { page: 0, size: 100, search: '', rows: [], total: 0 },
};

// ---- 起動 --------------------------------------------------------------

boot();

async function boot() {
  wireSetup();
  wireLogin();

  if (!hasConn()) return show('setup');

  try {
    sb();
  } catch {
    return show('setup');
  }

  onAuthChange((user) => {
    if (user) startApp(user);
    else show('login');
  });

  const user = await currentUser();
  if (user) startApp(user);
  else show('login');
}

function show(which) {
  for (const id of ['setup', 'login', 'app']) {
    $('#' + id).hidden = id !== which;
  }
}

// ---- 接続設定 / ログイン ------------------------------------------------

function wireSetup() {
  // 鍵は表示しない（設定済みかどうかは placeholder で示す）
  const { url, key } = getConn();
  $('#setup-url').value = url;
  if (key) $('#setup-key').placeholder = '（設定済み。変更するときだけ入力）';

  $('#setup-save').addEventListener('click', () => {
    const u = $('#setup-url').value.trim();
    const k = $('#setup-key').value.trim();
    const err = $('#setup-err');
    if (!/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/i.test(u)) {
      err.hidden = false;
      err.textContent = 'Project URL の形式が違います（https://xxxx.supabase.co）';
      return;
    }
    if (k.length < 30) {
      err.hidden = false;
      err.textContent = '公開用APIキー（Publishable / anon public）を貼り付けてください';
      return;
    }
    // service_role / secret のキーを誤って貼るのを防ぐ
    if (/^sb_secret_/i.test(k) || isServiceRoleJwt(k)) {
      err.hidden = false;
      err.textContent =
        'これは service_role（管理者）のキーです。RLS を無視できるため使えません。'
        + 'Publishable / anon public のキーを貼ってください。';
      return;
    }
    err.hidden = true;
    saveConn(u, k);
    location.reload();
  });

  $('#setup-reset').addEventListener('click', () => {
    clearConn();
    location.reload();
  });
}

// 旧形式（JWT）のキーは payload の role で見分けられる。
// service_role を貼られたらブラウザに保存させない。
function isServiceRoleJwt(key) {
  const parts = key.split('.');
  if (parts.length !== 3) return false;
  try {
    const json = atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'));
    return JSON.parse(json).role === 'service_role';
  } catch {
    return false;
  }
}

function wireLogin() {
  const doLogin = async () => {
    const err = $('#login-err');
    err.hidden = true;
    try {
      busy(true);
      await signIn($('#login-email').value.trim(), $('#login-pass').value);
    } catch (e) {
      err.hidden = false;
      err.textContent = e.message === 'Invalid login credentials'
        ? 'メールアドレスまたはパスワードが違います'
        : e.message;
    } finally {
      busy(false);
    }
  };
  $('#login-btn').addEventListener('click', doLogin);
  $('#login-pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
}

// ---- アプリ本体 --------------------------------------------------------

let started = false;

async function startApp(user) {
  show('app');
  $('#who').textContent = user.email || '';
  if (started) return;
  started = true;

  $('#logout').addEventListener('click', async () => {
    await signOut();
    location.reload();
  });

  wireTabs();
  wireFilters();
  wireViewControls();
  initImporter({ onImported: async () => { await loadMeta(); await render(); } });
  initMyPage({
    getFilter: () => state.filter,
    rerender: () => renderMyPage(state.filter),
  });

  await loadMeta();
  // データがあれば全期間、無ければ直近30日を初期表示にする
  const initial = state.meta?.cv_date_min || state.meta?.ck_date_min ? 'all' : '30';
  $$('#presets .chip').forEach((c) => c.classList.toggle('is-active', c.dataset.preset === initial));
  applyPreset(initial);
  await render();
}

function wireTabs() {
  $('#tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.tab');
    if (!btn) return;
    state.view = btn.dataset.view;
    $$('.tab').forEach((t) => t.classList.toggle('is-active', t === btn));
    // hidden を外してから render する。Chart.js は非表示の器で初期化すると
    // 0x0 に固定され、あとから resize しても戻らないため順序が重要。
    $$('.view').forEach((v) => { v.hidden = v.dataset.view !== state.view; });
    $('#filterbar').hidden = state.view === 'import';
    render();
  });
}

function wireFilters() {
  $('#f-apply').addEventListener('click', () => {
    readFilterInputs();
    render();
  });
  $('#presets').addEventListener('click', (e) => {
    const btn = e.target.closest('.chip');
    if (!btn) return;
    $$('#presets .chip').forEach((c) => c.classList.toggle('is-active', c === btn));
    applyPreset(btn.dataset.preset);
    render();
  });
}

function wireViewControls() {
  // 想定マネートラック報酬率。入れた値はこのブラウザに覚えさせる。
  const saved = localStorage.getItem(LS_MT_RATE);
  if (saved !== null) $('#mt-rate').value = saved;
  $('#mt-rate').addEventListener('change', () => {
    localStorage.setItem(LS_MT_RATE, String(mtRate()));
    resetSort($('#t-summary'));
    render();
  });

  $('#grain').addEventListener('click', (e) => {
    const btn = e.target.closest('.chip');
    if (!btn) return;
    $$('#grain .chip').forEach((c) => c.classList.toggle('is-active', c === btn));
    state.grain = btn.dataset.grain;
    renderTrend();
  });

  $('#dim').addEventListener('click', (e) => {
    const btn = e.target.closest('.chip');
    if (!btn) return;
    $$('#dim .chip').forEach((c) => c.classList.toggle('is-active', c === btn));
    state.dim = btn.dataset.dim;
    resetSort($('#t-dim'));
    renderProducts();
  });

  // 比較タブ
  $('#cmp-dim').addEventListener('click', (e) => {
    const btn = e.target.closest('.chip');
    if (!btn) return;
    $$('#cmp-dim .chip').forEach((x) => x.classList.toggle('is-active', x === btn));
    state.compare.dim = btn.dataset.cmpdim;
    $('#cmp-search').value = '';
    resetSort($('#t-compare'));
    render();
  });
  $('#cmp-metric').addEventListener('click', (e) => {
    const btn = e.target.closest('.chip');
    if (!btn) return;
    $$('#cmp-metric .chip').forEach((x) => x.classList.toggle('is-active', x === btn));
    state.compare.metric = btn.dataset.cmpmetric;
    render();
  });
  $('#cmp-grain').addEventListener('click', (e) => {
    const btn = e.target.closest('.chip');
    if (!btn) return;
    $$('#cmp-grain .chip').forEach((x) => x.classList.toggle('is-active', x === btn));
    state.compare.grain = btn.dataset.cmpgrain;
    render();
  });
  $('#cmp-search').addEventListener('input', debounce(() => renderCompareList(), 200));
  $('#cmp-top5').addEventListener('click', () => {
    const c = state.compare;
    c.picked[c.dim] = c.candidates.slice(0, 5).map((r) => r.label);
    render();
  });
  $('#cmp-clear').addEventListener('click', () => {
    state.compare.picked[state.compare.dim] = [];
    render();
  });

  $('#aff-search').addEventListener('input', debounce(() => renderAffiliateTable(), 200));
  $('#aff-detail-close').addEventListener('click', () => {
    state.selectedAffiliate = null;
    $('#aff-detail').hidden = true;
    // 内訳を閉じると一覧グラフが再表示される（CSS側で切り替え）。
    // 隠れている間にキャンバスが潰れているので描き直す。
    renderAffiliates();
  });

  $('#detail-go').addEventListener('click', () => {
    state.detail.search = $('#detail-search').value.trim();
    state.detail.page = 0;
    renderDetail();
  });
  $('#detail-search').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('#detail-go').click();
  });
  $('#detail-allcols').addEventListener('change', () => {
    resetSort($('#t-detail'));
    renderDetail();
  });
  $('#mp-export').addEventListener('click', async () => {
    busy(true);
    try { await exportMyPage(state.filter); }
    catch (e) { toast(e.message); }
    finally { busy(false); }
  });
  $('#detail-prev').addEventListener('click', () => {
    if (state.detail.page > 0) { state.detail.page -= 1; renderDetail(); }
  });
  $('#detail-next').addEventListener('click', () => {
    const max = Math.ceil(state.detail.total / state.detail.size) - 1;
    if (state.detail.page < max) { state.detail.page += 1; renderDetail(); }
  });

  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-export]');
    if (btn) exportCsv(btn.dataset.export);
  });
}

// ---- フィルタ ----------------------------------------------------------

async function loadMeta() {
  try {
    state.meta = await api.filters();
  } catch (e) {
    toast('メタ情報の取得に失敗: ' + e.message);
    state.meta = null;
    return;
  }
  const m = state.meta;

  // ステータスのチェックボックス（確定/保留を切り替えるフィルタ）
  const box = $('#f-status');
  const prev = new Set(state.filter.statuses);
  box.replaceChildren();
  const statuses = m.statuses || [];
  for (const s of statuses) {
    const id = 'st-' + s;
    const cb = el('input', { type: 'checkbox', id, value: s });
    cb.checked = prev.size ? prev.has(s) : true;
    cb.addEventListener('change', () => { readFilterInputs(); render(); });
    box.append(el('label', { class: 'inline check' }, cb, s));
  }
  if (!statuses.length) box.append(el('span', { class: 'muted small', text: 'データ未取込' }));

  // 広告主（チェックボックスのドロップダウン。何も選ばなければ「全て」）
  const box2 = $('#f-advertiser');
  const prevAdv = new Set(state.filter.advertisers);
  box2.replaceChildren();
  const advertisers = m.advertisers || [];
  for (const a of advertisers) {
    const cb = el('input', { type: 'checkbox', value: a });
    cb.checked = prevAdv.has(a);
    cb.addEventListener('change', () => { readFilterInputs(); updateAdvertiserLabel(); render(); });
    box2.append(el('label', { class: 'inline check' }, cb, a));
  }
  if (!advertisers.length) box2.append(el('span', { class: 'muted small', text: 'データ未取込' }));

  const range = [];
  if (m.cv_date_min) range.push(`成果 ${m.cv_date_min}〜${m.cv_date_max}（${num(m.cv_rows)}件）`);
  if (m.ck_date_min) range.push(`クリック ${m.ck_date_min}〜${m.ck_date_max}（${num(m.ck_rows)}件）`);
  $('#data-range').textContent = range.join(' / ') || 'データがありません。「データ取込」から入れてください。';

  readFilterInputs();
  updateAdvertiserLabel();
}

function readFilterInputs() {
  state.filter.from = $('#f-from').value || state.filter.from;
  state.filter.to = $('#f-to').value || state.filter.to;
  state.filter.statuses = $$('#f-status input:checked').map((c) => c.value);
  state.filter.advertisers = $$('#f-advertiser input:checked').map((c) => c.value);
}

function updateAdvertiserLabel() {
  const picked = state.filter.advertisers;
  $('#f-advertiser-label').textContent = picked.length
    ? `広告主: ${picked.length === 1 ? picked[0] : picked.length + '件'}`
    : '広告主: 全て';
}

function applyPreset(preset) {
  const m = state.meta || {};
  const today = new Date();
  let from;
  let to = today;

  if (preset === 'all') {
    const mins = [m.cv_date_min, m.ck_date_min].filter(Boolean).sort();
    const maxs = [m.cv_date_max, m.ck_date_max].filter(Boolean).sort();
    $('#f-from').value = mins[0] || ymd(addDays(today, -30));
    $('#f-to').value = maxs[maxs.length - 1] || ymd(today);
    readFilterInputs();
    return;
  }
  if (preset === 'thismonth') {
    from = new Date(today.getFullYear(), today.getMonth(), 1);
  } else if (preset === 'lastmonth') {
    from = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    to = new Date(today.getFullYear(), today.getMonth(), 0);
  } else {
    from = addDays(today, -(Number(preset) - 1));
  }
  $('#f-from').value = ymd(from);
  $('#f-to').value = ymd(to);
  readFilterInputs();
}

// ---- 描画の入口 --------------------------------------------------------

async function render() {
  if (state.view === 'import') { loadImportHistory(); return; }
  if (!state.filter.from || !state.filter.to) return;

  busy(true);
  try {
    if (state.view === 'summary')         await renderSummary();
    else if (state.view === 'mypage')     await renderMyPage(state.filter);
    else if (state.view === 'compare')    await renderCompare();
    else if (state.view === 'trend')      await renderTrend();
    else if (state.view === 'affiliates') await renderAffiliates();
    else if (state.view === 'products')   await renderProducts();
    else if (state.view === 'sources')    await renderSources();
    else if (state.view === 'detail')     await renderDetail();
  } catch (e) {
    toast(e.message);
    console.error(e);
  } finally {
    busy(false);
  }
}

// ---- サマリー ----------------------------------------------------------

// サマリー: 連日の売上を一覧と線グラフで見る画面。
// 「想定マネートラック報酬」は アフィリエイター報酬額 × 率（既定30%）で出す。
const LS_MT_RATE = 'afd.mtRate';

function mtRate() {
  const v = Number($('#mt-rate').value);
  return Number.isFinite(v) && v >= 0 ? v : 30;
}

async function renderSummary() {
  const f = state.filter;
  const ts = await api.timeseries(f, 'day');
  const rate = mtRate() / 100;

  // 成果が無かった日も 0 として並べる（連日で見たいので歯抜けにしない）
  const byDay = new Map(ts.map((r) => [String(r.bucket), r]));
  const rows = [];
  for (let d = new Date(f.from); ymd(d) <= f.to; d = addDays(d, 1)) {
    const key = ymd(d);
    const r = byDay.get(key);
    const sales = Number(r?.sales || 0);
    const reward = Number(r?.reward || 0);
    rows.push({
      bucket: key,
      day: `${key.slice(5).replace('-', '/')}（${WEEKDAY[d.getDay()]}）`,
      conversions: Number(r?.conversions || 0),
      sales,
      reward,
      mt: Math.round(reward * rate),
    });
  }
  state.summaryRows = rows;

  ch.line('c-summary-line', rows.map((r) => r.day.slice(0, 5)), [
    { label: '売上', data: rows.map((r) => r.sales), fill: true },
  ], { money: true });

  const sum = (k) => rows.reduce((a, r) => a + r[k], 0);
  $('#summary-total').textContent =
    `期間合計 売上 ${yen(sum('sales'))} / 報酬額 ${yen(sum('reward'))} / 想定 ${yen(sum('mt'))}`;

  renderTable($('#t-summary'), [
    { key: 'day', label: '日付', type: 'text', cellClass: 'num' },
    { key: 'sales', label: '売上', type: 'yen' },
    { key: 'reward', label: 'アフィリエイター報酬額', type: 'yen' },
    { key: 'mt', label: `想定マネートラック報酬（${mtRate()}%）`, type: 'yen' },
    { key: 'conversions', label: '成果件数', type: 'num' },
  ], rows, { sortKey: 'bucket', sortDir: 'asc', empty: 'この期間の成果がありません' });
}

const WEEKDAY = ['日', '月', '火', '水', '木', '金', '土'];

// アフィリエイター内訳などで使う小さな数値タイル
function renderKpis(sel, items) {
  const box = $(sel);
  box.replaceChildren(...items.map((i) => el('div', { class: 'kpi' },
    el('div', { class: 'k', text: i.k }),
    el('div', { class: 'v', text: i.v }),
    i.s ? el('div', { class: 's', text: i.s }) : null,
  )));
}

// ---- 推移 --------------------------------------------------------------

async function renderTrend() {
  const ts = await api.timeseries(state.filter, state.grain);
  state.trendRows = ts;
  const labels = ts.map((r) => (state.grain === 'month' ? r.bucket.slice(0, 7) : r.bucket.slice(5)));

  ch.bar('c-trend-main', labels, [
    { label: 'クリック数', data: ts.map((r) => r.clicks), color: ch.color(1) + 'cc' },
    { label: '成果件数', data: ts.map((r) => r.conversions), type: 'line', axis: 'y1', color: ch.color(0) },
  ], { yTitle: 'クリック', y1Title: '成果' });

  ch.line('c-trend-money', labels, [
    { label: '売上', data: ts.map((r) => r.sales), fill: true, color: ch.color(2) },
    { label: '報酬額', data: ts.map((r) => r.reward), color: ch.color(1) },
  ], { money: true });

  ch.line('c-trend-cvr', labels, [
    { label: 'CVR (%)', data: ts.map((r) => r.cvr), color: ch.color(3) },
  ]);
}

// ---- 比較 --------------------------------------------------------------
// 「この人はどのくらい動いているのか」「この広告主はどうか」を、
// 選んだ相手ぶんの線を重ねて見る画面。

const CMP_METRIC = {
  conversions: { label: '成果件数', type: 'num', money: false },
  sales:       { label: '売上',     type: 'yen', money: true },
  reward:      { label: '報酬額',   type: 'yen', money: true },
  clicks:      { label: 'クリック', type: 'num', money: false },
  cvr:         { label: 'CVR',      type: 'pct', money: false },
};

async function renderCompare() {
  const c = state.compare;
  const dimLabel = c.dim === 'advertiser' ? '広告主' : 'アフィリエイター';

  // 選択候補の一覧（売上順）
  c.candidates = await api.dimension(state.filter, c.dim, 300);

  // 初回だけ上位5件を自動で選ぶ。自分で空にした場合はそのまま空にしておく。
  if (c.picked[c.dim] === null) {
    c.picked[c.dim] = c.candidates.slice(0, 5).map((r) => r.label);
  }
  renderCompareList();

  const picked = c.picked[c.dim];
  $('#cmp-title').textContent = `${dimLabel}の動き（${CMP_METRIC[c.metric].label}）`;

  if (!picked.length) {
    ch.line('c-compare', [], []);
    renderTable($('#t-compare'), [{ key: 'series', label: dimLabel, type: 'text' }], [],
      { empty: `左の一覧から${dimLabel}を選んでください` });
    c.rows = [];
    c.totals = [];
    return;
  }

  const rows = await api.compare(state.filter, c.dim, picked, c.grain, 5);
  c.rows = rows;

  // series × bucket の行を、系列ごとの配列に組み替える
  const buckets = [...new Set(rows.map((r) => r.bucket))].sort();
  const bySeries = new Map();
  for (const r of rows) {
    if (!bySeries.has(r.series)) bySeries.set(r.series, new Map());
    bySeries.get(r.series).set(r.bucket, r);
  }

  const labels = buckets.map((b) => (c.grain === 'month' ? String(b).slice(0, 7) : String(b).slice(5)));
  const series = picked
    .filter((name) => bySeries.has(name))
    .map((name, i) => ({
      label: name,
      color: ch.color(colorIndexOf(name, picked)),
      data: buckets.map((b) => {
        const r = bySeries.get(name).get(b);
        if (!r) return c.metric === 'cvr' ? null : 0;
        return r[c.metric] === null ? null : Number(r[c.metric]);
      }),
    }));

  ch.line('c-compare', labels, series, { money: CMP_METRIC[c.metric].money });

  // 期間合計
  const totals = picked.map((name) => {
    const map = bySeries.get(name);
    const all = map ? Array.from(map.values()) : [];
    const sum = (k) => all.reduce((a, r) => a + Number(r[k] || 0), 0);
    const conversions = sum('conversions');
    const clicks = sum('clicks');
    return {
      series: name,
      clicks,
      conversions,
      cvr: clicks ? (conversions * 100) / clicks : null,
      sales: sum('sales'),
      reward: sum('reward'),
      days: all.filter((r) => Number(r.conversions || 0) > 0 || Number(r.clicks || 0) > 0).length,
    };
  });
  c.totals = totals;

  renderTable($('#t-compare'), [
    { key: 'series', label: dimLabel, type: 'text' },
    { key: 'clicks', label: 'クリック', type: 'num' },
    { key: 'conversions', label: '成果', type: 'num' },
    { key: 'cvr', label: 'CVR', type: 'pct' },
    { key: 'sales', label: '売上', type: 'yen' },
    { key: 'reward', label: '報酬額', type: 'yen' },
    { key: 'days', label: '稼働日数', type: 'num', title: '成果かクリックがあった期間の数' },
  ], totals, { sortKey: 'sales', sortDir: 'desc' });
}

// 線の色は「選んだ順」で決める。並べ替えても同じ人が同じ色でいられるように。
function colorIndexOf(name, picked) {
  const i = picked.indexOf(name);
  return i < 0 ? 0 : i;
}

function renderCompareList() {
  const c = state.compare;
  const q = ($('#cmp-search').value || '').toLowerCase();
  const box = $('#cmp-list');
  const current = c.picked[c.dim] ?? [];
  const picked = new Set(current);

  const list = c.candidates.filter((r) => !q || String(r.label).toLowerCase().includes(q));
  box.replaceChildren();
  if (!list.length) {
    box.append(el('p', { class: 'muted small', text: '該当なし' }));
    return;
  }

  for (const r of list) {
    const cb = el('input', { type: 'checkbox', value: r.label });
    cb.checked = picked.has(r.label);
    cb.addEventListener('change', () => {
      const cur = new Set(c.picked[c.dim] ?? []);
      if (cb.checked) cur.add(r.label);
      else cur.delete(r.label);
      c.picked[c.dim] = c.candidates.map((x) => x.label).filter((l) => cur.has(l));
      render();
    });
    const idx = current.indexOf(r.label);
    const swatch = el('span', { class: 'swatch' });
    swatch.style.background = idx >= 0 ? ch.color(idx) : 'var(--line-strong)';
    box.append(el('label', {}, cb, swatch, r.label,
      el('span', { class: 'cmp-sub', text: '¥' + compact(r.sales) })));
  }
}

// ---- アフィリエイター --------------------------------------------------

async function renderAffiliates() {
  state.affiliates = await api.affiliates(state.filter, 500);

  const bySales = state.affiliates.slice().sort((a, b) => b.sales - a.sales).slice(0, 15);
  ch.bar('c-aff-sales', bySales.map((r) => r.affiliate_id), [
    { label: '売上', data: bySales.map((r) => r.sales), color: ch.color(2) },
  ], { horizontal: true, money: true });

  renderAffiliateTable();
  if (state.selectedAffiliate) await renderAffiliateDetail(state.selectedAffiliate);
}

function renderAffiliateTable() {
  const q = ($('#aff-search').value || '').toLowerCase();
  const rows = q
    ? state.affiliates.filter((r) => String(r.affiliate_id || '').toLowerCase().includes(q))
    : state.affiliates;

  renderTable($('#t-aff'), [
    { key: 'affiliate_id', label: 'アフィリエイターID', type: 'text' },
    { key: 'clicks', label: 'クリック', type: 'num' },
    { key: 'conversions', label: '成果', type: 'num' },
    { key: 'cvr', label: 'CVR', type: 'pct' },
    { key: 'sales', label: '売上', type: 'yen' },
    { key: 'reward', label: '報酬額', type: 'yen' },
    { key: 'aov', label: '平均単価', type: 'yen' },
  ], rows, {
    sortKey: 'sales',
    sortDir: 'desc',
    rowKey: 'affiliate_id',
    selectedKey: state.selectedAffiliate,
    empty: '該当するアフィリエイターがいません',
    onRowClick: (row) => {
      state.selectedAffiliate = row.affiliate_id;
      renderAffiliateTable();
      renderAffiliateDetail(row.affiliate_id);
    },
  });
}

async function renderAffiliateDetail(affiliateId) {
  busy(true);
  try {
    const d = await api.affiliateDetail(affiliateId, state.filter);
    $('#aff-detail').hidden = false;
    $('#aff-detail-title').textContent = `${affiliateId} の内訳`;

    renderKpis('#aff-detail-kpis', [
      { k: 'クリック', v: num(d.totals.clicks) },
      { k: '成果', v: num(d.totals.conversions) },
      { k: 'CVR', v: d.totals.cvr === null ? '—' : pct(d.totals.cvr) },
      { k: '売上', v: yen(d.totals.sales) },
      { k: '報酬額', v: yen(d.totals.reward) },
    ]);

    const refs = (d.referrers || []).slice(0, 10);
    ch.bar('c-affd-ref', refs.map((r) => r.label), [
      { label: 'クリック', data: refs.map((r) => r.clicks), color: ch.color(1) },
      { label: '成果', data: refs.map((r) => r.conversions), color: ch.color(0) },
    ], { horizontal: true });

    const daily = (d.daily || []).slice().sort((a, b) => String(a.d).localeCompare(String(b.d)));
    ch.line('c-affd-daily', daily.map((r) => String(r.d).slice(5)), [
      { label: 'クリック', data: daily.map((r) => r.ck), color: ch.color(1) },
      { label: '成果', data: daily.map((r) => r.cv), color: ch.color(0), fill: true },
    ]);

    renderTable($('#t-affd-products'), [
      { key: 'label', label: '商品名', type: 'text' },
      { key: 'conversions', label: '成果', type: 'num' },
      { key: 'sales', label: '売上', type: 'yen' },
      { key: 'reward', label: '報酬額', type: 'yen' },
    ], d.products || [], { sortKey: 'conversions', sortDir: 'desc' });

  } finally {
    busy(false);
  }
}

// ---- 商品・広告 --------------------------------------------------------

const DIM_LABEL = {
  product: '商品', ad: '広告', campaign: 'キャンペーン',
  advertiser: '広告主', ad_type: '広告タイプ',
};

async function renderProducts() {
  const rows = await api.dimension(state.filter, state.dim, 200);
  state.dimRows = rows;

  const label = DIM_LABEL[state.dim] || state.dim;
  $('#dim-chart-title').textContent = `${label}別 集計`;
  $('#dim-table-title').textContent = `${label}別 明細`;

  const top = rows.slice(0, 15);
  const useClicks = state.dim === 'ad_type';
  ch.bar('c-dim-bar', top.map((r) => r.label), useClicks
    ? [{ label: 'クリック数', data: top.map((r) => r.clicks), color: ch.color(1) }]
    : [
      { label: '成果件数', data: top.map((r) => r.conversions) },
      { label: '売上', data: top.map((r) => r.sales), axis: 'y1', color: ch.color(2) },
    ],
  { horizontal: useClicks, y1Title: useClicks ? null : '売上' });

  renderTable($('#t-dim'), [
    { key: 'label', label: label, type: 'text' },
    { key: 'clicks', label: 'クリック', type: 'num' },
    { key: 'conversions', label: '成果', type: 'num' },
    { key: 'cvr', label: 'CVR', type: 'pct' },
    { key: 'qty', label: '数量', type: 'num' },
    { key: 'sales', label: '売上', type: 'yen' },
    { key: 'reward', label: '報酬額', type: 'yen' },
  ], rows.map(withCvr), { sortKey: useClicks ? 'clicks' : 'conversions', sortDir: 'desc' });
}

function withCvr(r) {
  const clicks = Number(r.clicks || 0);
  return { ...r, cvr: clicks ? (Number(r.conversions) * 100) / clicks : null };
}

// ---- 流入元 ------------------------------------------------------------

async function renderSources() {
  const rows = (await api.dimension(state.filter, 'referrer', 200)).map(withCvr);
  state.srcRows = rows;

  // クリックと成果を1枚にまとめて、流入元ごとの効率を並べて見られるようにする
  const byClicks = rows.slice().sort((a, b) => b.clicks - a.clicks).slice(0, 15);
  ch.bar('c-src-clicks', byClicks.map((r) => r.label), [
    { label: 'クリック', data: byClicks.map((r) => r.clicks), color: ch.color(1) },
    { label: '成果', data: byClicks.map((r) => r.conversions) },
  ], { horizontal: true });

  renderTable($('#t-src'), [
    { key: 'label', label: 'リファラ（ホスト）', type: 'text' },
    { key: 'clicks', label: 'クリック', type: 'num' },
    { key: 'conversions', label: '成果', type: 'num' },
    { key: 'cvr', label: 'CVR', type: 'pct' },
    { key: 'sales', label: '売上', type: 'yen' },
    { key: 'reward', label: '報酬額', type: 'yen' },
  ], rows, { sortKey: 'clicks', sortDir: 'desc' });
}

// ---- 成果明細 ----------------------------------------------------------

async function renderDetail() {
  const d = state.detail;
  const rows = await api.conversions(state.filter, d.search, d.size, d.page * d.size);
  d.rows = rows;
  d.total = rows.length ? Number(rows[0].total_count) : 0;

  $('#detail-count').textContent = `${num(d.total)} 件中 ${d.total ? d.page * d.size + 1 : 0}〜${d.page * d.size + rows.length} 件を表示`;
  const pages = Math.max(Math.ceil(d.total / d.size), 1);
  $('#detail-page').textContent = `${d.page + 1} / ${pages} ページ`;
  $('#detail-prev').disabled = d.page === 0;
  $('#detail-next').disabled = d.page + 1 >= pages;

  // 既定は主要8列だけ。残りは「全列」で出す。
  const core = [
    { key: 'occurred_at', label: '発生日時', render: (r) => fmtDateTime(r.occurred_at), cellClass: 'num' },
    { key: 'status', label: 'ステータス', render: (r) => statusBadge(r.status), cellClass: null },
    { key: 'advertiser_id', label: '広告主', type: 'text' },
    { key: 'affiliate_id', label: 'アフィリエイター', type: 'text' },
    { key: 'product_name', label: '商品名', type: 'text' },
    { key: 'qty', label: '数量', type: 'num' },
    { key: 'sale_price', label: '販売価格', type: 'yen' },
    { key: 'reward', label: '報酬額', type: 'yen' },
  ];
  const extra = [
    { key: 'ad_name', label: '広告名', type: 'text' },
    { key: 'campaign', label: 'キャンペーン', type: 'text' },
    { key: 'reward_rate', label: '報酬率', type: 'text', cellClass: 'num' },
    { key: 'pay_status', label: '支払い', type: 'text' },
    { key: 'device', label: 'デバイス', type: 'text' },
    { key: 'os', label: 'OS', type: 'text' },
    { key: 'first_referrer', label: '初回リファラ', type: 'text' },
    { key: 'order_id', label: '注文ID', type: 'text' },
  ];
  const cols = $('#detail-allcols').checked ? [...core, ...extra] : core;

  renderTable($('#t-detail'), cols, rows,
    { sortKey: 'occurred_at', sortDir: 'desc', empty: '該当する成果がありません' });
}

// ---- CSV 出力 ----------------------------------------------------------

function exportCsv(kind) {
  const stamp = `${state.filter.from}_${state.filter.to}`;
  if (kind === 'summary') {
    downloadCsv(`日別売上_${stamp}.csv`,
      ['日付', '売上', 'アフィリエイター報酬額', `想定マネートラック報酬(${mtRate()}%)`, '成果件数'],
      (state.summaryRows || []).map((r) => [r.bucket, r.sales, r.reward, r.mt, r.conversions]));
  } else if (kind === 'affiliates') {
    downloadCsv(`アフィリエイター別_${stamp}.csv`,
      ['アフィリエイターID', 'クリック', '成果', 'CVR(%)', '売上', '報酬額', '平均単価'],
      state.affiliates.map((r) => [r.affiliate_id, r.clicks, r.conversions, r.cvr, r.sales, r.reward, r.aov]));
  } else if (kind === 'dimension') {
    const label = DIM_LABEL[state.dim] || state.dim;
    downloadCsv(`${label}別_${stamp}.csv`,
      [label, 'クリック', '成果', 'CVR(%)', '数量', '売上', '報酬額'],
      state.dimRows.map(withCvr).map((r) => [r.label, r.clicks, r.conversions, r.cvr, r.qty, r.sales, r.reward]));
  } else if (kind === 'compare') {
    const dimLabel = state.compare.dim === 'advertiser' ? '広告主' : 'アフィリエイター';
    downloadCsv(`比較_${dimLabel}_${stamp}.csv`,
      [dimLabel, 'クリック', '成果', 'CVR(%)', '売上', '報酬額', '稼働日数'],
      (state.compare.totals || []).map((r) =>
        [r.series, r.clicks, r.conversions, r.cvr, r.sales, r.reward, r.days]));
  } else if (kind === 'trend') {
    downloadCsv(`推移_${stamp}.csv`,
      ['期間', 'クリック', '成果', 'CVR(%)', '売上', '報酬額'],
      (state.trendRows || []).map((r) => [r.bucket, r.clicks, r.conversions, r.cvr, r.sales, r.reward]));
  } else if (kind === 'sources') {
    downloadCsv(`流入元別_${stamp}.csv`,
      ['リファラ', 'クリック', '成果', 'CVR(%)', '売上', '報酬額'],
      state.srcRows.map((r) => [r.label, r.clicks, r.conversions, r.cvr, r.sales, r.reward]));
  } else if (kind === 'conversions') {
    downloadCsv(`成果明細_${stamp}.csv`,
      ['発生日時', 'ステータス', '広告主', 'アフィリエイター', '商品名', '広告名', 'キャンペーン',
        '数量', '販売価格', '報酬額', '報酬率', '支払い状況', 'デバイス', 'OS', '初回リファラ', '注文ID'],
      state.detail.rows.map((r) => [
        r.occurred_at, r.status, r.advertiser_id, r.affiliate_id, r.product_name, r.ad_name, r.campaign,
        r.qty, r.sale_price, r.reward, r.reward_rate, r.pay_status, r.device, r.os, r.first_referrer, r.order_id]));
  }
}

// ---- 小物 --------------------------------------------------------------

let busyCount = 0;
function busy(on) {
  busyCount = Math.max(0, busyCount + (on ? 1 : -1));
  $('#busy').hidden = busyCount === 0;
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 5000);
}

// テーマが切り替わったらチャートを描き直す
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  ch.destroyAll();
  render();
});
