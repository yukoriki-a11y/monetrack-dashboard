// 画面全体の制御：認証ゲート → フィルタ → 各ビューの描画

import { $, $$, el, num, yen, pct, compact, ymd, addDays, fmtDateTime, downloadCsv, debounce, statusBadge } from './util.js';
import { hasConn, saveConn, clearConn, getConn, sb, signIn, signOut, currentUser, onAuthChange, api } from './db.js';
import * as ch from './charts.js';
import { renderTable, resetSort } from './table.js';
import { initImporter, loadImportHistory } from './importer.js';

// ---- 状態 --------------------------------------------------------------

const state = {
  view: 'summary',
  filter: { from: null, to: null, statuses: [], advertisers: [] },
  meta: null,           // dash_filters の結果
  grain: 'day',
  dim: 'product',
  affiliates: [],       // アフィリエイター一覧のキャッシュ
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
      err.textContent = 'anon key を貼り付けてください';
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

  $('#aff-search').addEventListener('input', debounce(() => renderAffiliateTable(), 200));
  $('#aff-detail-close').addEventListener('click', () => {
    state.selectedAffiliate = null;
    $('#aff-detail').hidden = true;
    renderAffiliateTable();
  });

  $('#detail-go').addEventListener('click', () => {
    state.detail.search = $('#detail-search').value.trim();
    state.detail.page = 0;
    renderDetail();
  });
  $('#detail-search').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('#detail-go').click();
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

  // 広告主
  const sel = $('#f-advertiser');
  const prevAdv = new Set(state.filter.advertisers);
  sel.replaceChildren();
  for (const a of m.advertisers || []) {
    const o = el('option', { value: a, text: a });
    o.selected = prevAdv.has(a);
    sel.append(o);
  }
  sel.size = Math.min(Math.max((m.advertisers || []).length, 3), 8);

  const range = [];
  if (m.cv_date_min) range.push(`成果 ${m.cv_date_min}〜${m.cv_date_max}（${num(m.cv_rows)}件）`);
  if (m.ck_date_min) range.push(`クリック ${m.ck_date_min}〜${m.ck_date_max}（${num(m.ck_rows)}件）`);
  $('#data-range').textContent = range.join(' / ') || 'データがありません。「データ取込」から入れてください。';

  readFilterInputs();
}

function readFilterInputs() {
  state.filter.from = $('#f-from').value || state.filter.from;
  state.filter.to = $('#f-to').value || state.filter.to;
  state.filter.statuses = $$('#f-status input:checked').map((c) => c.value);
  state.filter.advertisers = Array.from($('#f-advertiser').selectedOptions).map((o) => o.value);
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

async function renderSummary() {
  const f = state.filter;
  const [kpi, ts, status, device, adv, affs] = await Promise.all([
    api.kpi(f),
    api.timeseries(f, 'day'),
    api.dimension(f, 'status', 20),
    api.dimension(f, 'device', 20),
    api.dimension(f, 'advertiser', 12),
    api.affiliates(f, 10),
  ]);

  renderKpis('#kpis', [
    { k: '成果件数',   v: num(kpi.conversions), s: `${num(kpi.qty)} 点` },
    { k: 'クリック数', v: num(kpi.clicks) },
    { k: 'CVR',        v: kpi.cvr === null ? '—' : pct(kpi.cvr), s: kpi.cvr === null ? '同期間のクリック未取込' : null },
    { k: '売上',       v: '¥' + compact(kpi.sales), s: yen(kpi.sales) },
    { k: '報酬額',     v: '¥' + compact(kpi.reward), s: kpi.reward_ratio === null ? null : `売上比 ${pct(kpi.reward_ratio)}` },
    { k: '平均単価',   v: yen(kpi.aov) },
    { k: 'アフィリエイター', v: num(kpi.affiliates), s: `商品 ${num(kpi.products)} 種` },
  ]);

  const labels = ts.map((r) => r.bucket.slice(5));
  ch.line('c-summary-line', labels, [
    { label: '成果件数', data: ts.map((r) => r.conversions), axis: 'y', fill: true },
    { label: 'クリック数', data: ts.map((r) => r.clicks), axis: 'y1', color: ch.color(1) },
  ], { yTitle: '成果', y1Title: 'クリック' });

  ch.pie('c-summary-status', status.map((r) => r.label), status.map((r) => r.conversions));
  ch.pie('c-summary-device', device.map((r) => r.label), device.map((r) => r.conversions));

  ch.bar('c-summary-adv', adv.map((r) => r.label), [
    { label: '成果件数', data: adv.map((r) => r.conversions) },
  ], { horizontal: true });

  const top = affs.filter((r) => Number(r.sales) > 0).slice(0, 10);
  ch.bar('c-summary-aff', top.map((r) => r.affiliate_id), [
    { label: '売上', data: top.map((r) => r.sales), color: ch.color(2) },
  ], { horizontal: true, money: true });
}

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

  renderTable($('#t-trend'), [
    { key: 'bucket', label: '期間', type: 'text', cellClass: 'num' },
    { key: 'clicks', label: 'クリック', type: 'num' },
    { key: 'conversions', label: '成果', type: 'num' },
    { key: 'cvr', label: 'CVR', type: 'pct' },
    { key: 'sales', label: '売上', type: 'yen' },
    { key: 'reward', label: '報酬額', type: 'yen' },
  ], ts, { sortKey: 'bucket', sortDir: 'asc' });
}

// ---- アフィリエイター --------------------------------------------------

async function renderAffiliates() {
  state.affiliates = await api.affiliates(state.filter, 500);

  const byClicks = state.affiliates.slice().sort((a, b) => b.clicks - a.clicks).slice(0, 15);
  ch.bar('c-aff-clicks', byClicks.map((r) => r.affiliate_id), [
    { label: 'クリック数', data: byClicks.map((r) => r.clicks), color: ch.color(1) },
  ], { horizontal: true });

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

    renderTable($('#t-affd-ads'), [
      { key: 'label', label: '広告名', type: 'text' },
      { key: 'clicks', label: 'クリック', type: 'num' },
      { key: 'conversions', label: '成果', type: 'num' },
      { key: 'sales', label: '売上', type: 'yen' },
    ], d.ads || [], { sortKey: 'conversions', sortDir: 'desc' });

    renderTable($('#t-affd-products'), [
      { key: 'label', label: '商品名', type: 'text' },
      { key: 'conversions', label: '成果', type: 'num' },
      { key: 'sales', label: '売上', type: 'yen' },
      { key: 'reward', label: '報酬額', type: 'yen' },
    ], d.products || [], { sortKey: 'conversions', sortDir: 'desc' });

    $('#aff-detail').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
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
  const [rows, os] = await Promise.all([
    api.dimension(state.filter, state.dim, 200),
    api.dimension(state.filter, 'os', 20),
  ]);
  state.dimRows = rows;

  const label = DIM_LABEL[state.dim] || state.dim;
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

  const pieRows = rows.slice(0, 10);
  ch.pie('c-dim-pie',
    pieRows.map((r) => (r.label.length > 24 ? r.label.slice(0, 23) + '…' : r.label)),
    pieRows.map((r) => (useClicks ? r.clicks : r.conversions)));

  ch.pie('c-dim-os', os.map((r) => r.label), os.map((r) => r.conversions || r.clicks));

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

  const byClicks = rows.slice().sort((a, b) => b.clicks - a.clicks).slice(0, 15);
  ch.bar('c-src-clicks', byClicks.map((r) => r.label), [
    { label: 'クリック', data: byClicks.map((r) => r.clicks), color: ch.color(1) },
  ], { horizontal: true });

  const byCv = rows.slice().sort((a, b) => b.conversions - a.conversions).slice(0, 15);
  ch.bar('c-src-cv', byCv.map((r) => r.label), [
    { label: '成果', data: byCv.map((r) => r.conversions) },
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

  renderTable($('#t-detail'), [
    { key: 'occurred_at', label: '発生日時', render: (r) => fmtDateTime(r.occurred_at), cellClass: 'num' },
    { key: 'status', label: 'ステータス', render: (r) => statusBadge(r.status), cellClass: null },
    { key: 'advertiser_id', label: '広告主', type: 'text' },
    { key: 'affiliate_id', label: 'アフィリエイター', type: 'text' },
    { key: 'product_name', label: '商品名', type: 'text' },
    { key: 'ad_name', label: '広告名', type: 'text' },
    { key: 'qty', label: '数量', type: 'num' },
    { key: 'sale_price', label: '販売価格', type: 'yen' },
    { key: 'reward', label: '報酬額', type: 'yen' },
    { key: 'reward_rate', label: '報酬率', type: 'text', cellClass: 'num' },
    { key: 'pay_status', label: '支払い', type: 'text' },
    { key: 'device', label: 'デバイス', type: 'text' },
    { key: 'first_referrer', label: '初回リファラ', type: 'text' },
    { key: 'order_id', label: '注文ID', type: 'text' },
  ], rows, { sortKey: 'occurred_at', sortDir: 'desc', empty: '該当する成果がありません' });
}

// ---- CSV 出力 ----------------------------------------------------------

function exportCsv(kind) {
  const stamp = `${state.filter.from}_${state.filter.to}`;
  if (kind === 'affiliates') {
    downloadCsv(`アフィリエイター別_${stamp}.csv`,
      ['アフィリエイターID', 'クリック', '成果', 'CVR(%)', '売上', '報酬額', '平均単価'],
      state.affiliates.map((r) => [r.affiliate_id, r.clicks, r.conversions, r.cvr, r.sales, r.reward, r.aov]));
  } else if (kind === 'dimension') {
    const label = DIM_LABEL[state.dim] || state.dim;
    downloadCsv(`${label}別_${stamp}.csv`,
      [label, 'クリック', '成果', 'CVR(%)', '数量', '売上', '報酬額'],
      state.dimRows.map(withCvr).map((r) => [r.label, r.clicks, r.conversions, r.cvr, r.qty, r.sales, r.reward]));
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
