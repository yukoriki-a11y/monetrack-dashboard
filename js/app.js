// 画面全体の制御：認証ゲート → フィルタ → 各ビューの描画

import { $, $$, el, num, yen, pct, compact, ymd, addDays, fmtDateTime, downloadCsv, debounce, statusBadge } from './util.js?v=202609081008';
import { hasConn, saveConn, clearConn, getConn, sb, signIn, signOut, currentUser, onAuthChange, api } from './db.js?v=202609081008';
import * as ch from './charts.js?v=202609081008';
import { renderTable, resetSort } from './table.js?v=202609081008';
import { initImporter, loadImportHistory } from './importer.js?v=202609081008';
import { dayKind, holidayName } from './holiday.js?v=202609081008';
import * as cfg from './settings.js?v=202609081008';

// 保存されている見た目の設定を、何より先に <html> へ当てる
// （あとから当てると一瞬だけ既定の配色が見えてしまう）
cfg.applyToDocument();

// ---- 状態 --------------------------------------------------------------

// フィルタはページごとに別々に持つ。
// サマリーで8月を見ながら、成果明細では9月を見る、といった使い分けができる。
// タブを戻すと、そのページで見ていた条件に戻る。
// 絞り込みの3状態:
//   null … 絞らない（＝全部。チェックは全部入って見える）
//   [..] … その相手だけ
//   []   … 「全員外す」を押した状態。全部とは区別して0件にする。
const newFilter = () => ({
  from: null, to: null, month: '', preset: '',
  statuses: null, advertisers: null, affiliates: null,
});

// 選択肢を配列に均す（null は「全部」なので空配列扱いで数えない）
const asList = (v) => (Array.isArray(v) ? v : []);

const state = {
  view: 'summary',
  filters: {},          // ビュー名 → フィルタ
  filter: newFilter(),  // いま見ているビューのフィルタ（filters の中身への参照）
  meta: null,           // dash_filters の結果
  grain: 'day',
  dim: 'product',
  summaryRows: [],      // サマリーの日別行
  affiliates: [],       // アフィリエイター一覧のキャッシュ
  compare: newPickState('affiliate', true),   // 広告主/アフィリエイター（内訳を塗り分け）
  list: {               // 広告主タブ / アフィリエイタータブ
    advertiser: { search: '', rows: [], grain: 'day' },
    affiliate:  { search: '', rows: [], grain: 'day' },
  },
  // 比較: 2つの枠に別々の相手を入れて、同じ見方で並べる
  versus: {
    layout: 'row',        // row = 左右 / col = 上下
    mode: 'line',         // line | pie | rank
    metric: 'sales',
    grain: 'day',
    panes: [
      { dim: 'affiliate', picked: [], data: null },
      { dim: 'affiliate', picked: [], data: null },
    ],
  },
  rank: { metric: 'sales', dayDim: 'affiliate', data: {}, open: new Set() },
  detail: { page: 0, size: 100, search: '', rows: [], total: 0 },
};

// 「相手を選んで時系列で見る」画面（広告主/アフィリエイター・比較）の共通の持ち物
function newPickState(dim, filled) {
  return {
    dim,
    metric: 'conversions',
    grain: 'day',
    filled,
    // null = まだ選んでいない（上位を自動選択する） / [] = 明示的に空にした
    picked: { affiliate: null, advertiser: null },
    candidates: [],
    query: '',
    rows: [],
    // 凡例をクリックして隠した帯。描き直しても消えないようここに置く。
    hiddenBands: new Set(),
  };
}

// いま読み込まれている版。index.html の ?v=... がそのまま入る（bump.ps1 が更新する）。
// 「直したのに変わらない」ときにキャッシュかどうかを目で確認できるようにしている。
const BUILD = new URL(import.meta.url).searchParams.get('v') || 'dev';

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
  $('#build').textContent = `版 ${BUILD}`;
  if (started) return;
  started = true;

  $('#logout').addEventListener('click', async () => {
    await signOut();
    location.reload();
  });

  wireTabs();
  wireNavToggle();
  buildMonthOptions();
  wireFilters();
  wireViewControls();
  wireSettings();
  initImporter({ onImported: async () => { await loadMeta(); await render(); } });

  await loadMeta();

  // 最初のページ（サマリー）の初期条件は全期間。
  // データがまだ無いときは applyPreset 側で直近30日に落ちる。
  state.filters.summary = state.filter;
  $$('#presets .chip').forEach((c) => c.classList.toggle('is-active', c.dataset.preset === 'all'));
  applyPreset('all');
  await render();
}

function wireTabs() {
  $('#tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.tab');
    if (!btn || !btn.dataset.view) return;   // 設定ボタンもナビの中にいる
    if (btn.dataset.view === state.view) return;

    // 出ていくページの条件を確定させてから切り替える
    if (state.view !== 'import') readFilterInputs();
    switchView(btn.dataset.view);
  });
}

function switchView(view) {
  state.view = view;
  state.filter = filterFor(view);
  ch.hideTooltip();     // 出しっぱなしの内訳ツールチップを畳む

  $$('.tab[data-view]').forEach((t) => t.classList.toggle('is-active', t.dataset.view === view));
  // hidden を外してから render する。Chart.js は非表示の器で初期化すると
  // 0x0 に固定され、あとから resize しても戻らないため順序が重要。
  $$('.view').forEach((v) => { v.hidden = v.dataset.view !== view; });
  $('#filterbar').hidden = view === 'import';

  if (view !== 'import') syncFilterUI();
  render();
}

// そのページのフィルタを取り出す。初めて開くページは、
// いま見ている条件を引き継いで始める（毎回ゼロからだと面倒なので）。
function filterFor(view) {
  if (!state.filters[view]) {
    const base = state.filter;
    const copy = (v) => (Array.isArray(v) ? [...v] : v);
    state.filters[view] = base
      ? {
        ...base,
        statuses: copy(base.statuses),
        advertisers: copy(base.advertisers),
        affiliates: copy(base.affiliates),
      }
      : newFilter();
  }
  return state.filters[view];
}

// ページごとに、フィルタ帯のどの絞り込みを出さないか。
//   広告主の画面 … 主役は広告主なので、人の絞り込みは出さない（逆も同じ）
//   広告主/アフィリエイター・比較 … 相手は画面の中で選ぶので、どちらも出さない
const PICKER_OFF = {
  advertiser: ['affiliate'],
  affiliate: ['advertiser'],
  compare: ['advertiser', 'affiliate'],
  versus: ['advertiser', 'affiliate'],
};
const pickerOff = (view) => PICKER_OFF[view] || [];

// フィルタ帯の見た目を、いま見ているページの条件に合わせる
function syncFilterUI() {
  const f = state.filter;
  const off = pickerOff(state.view);
  $('#f-advertiser-dd').hidden = off.includes('advertiser');
  $('#f-affiliate-dd').hidden = off.includes('affiliate');

  $('#f-from').value = f.from || '';
  $('#f-to').value = f.to || '';
  $('#f-month').value = f.month || '';
  $$('#presets .chip').forEach((c) => c.classList.toggle('is-active', c.dataset.preset === f.preset));
  buildStatusBoxes();
  buildPicker('advertiser', state.meta?.advertisers || []);
  buildPicker('affiliate', state.meta?.affiliates || []);
}

// ---- 左ナビの開閉 ------------------------------------------------------
// 畳んだ状態はこのブラウザに覚えさせる。
// 幅が足りない画面では自動で畳む（手動で開いていても物理的に入らないので）。
const LS_NAV = 'afd.navCollapsed';
const NAV_NARROW = 1180;

function wireNavToggle() {
  let manual = localStorage.getItem(LS_NAV) === '1';

  const apply = () => {
    $('#app').classList.toggle('nav-collapsed', manual || innerWidth <= NAV_NARROW);
  };

  $('#nav-toggle').addEventListener('click', () => {
    manual = !$('#app').classList.contains('nav-collapsed');
    localStorage.setItem(LS_NAV, manual ? '1' : '0');
    apply();
  });
  addEventListener('resize', debounce(apply, 150));
  apply();
}

function wireFilters() {
  $('#f-apply').addEventListener('click', () => {
    // 日付を直接いじった場合は、月やプリセットの選択を外す
    state.filter.month = '';
    state.filter.preset = '';
    $('#f-month').value = '';
    $$('#presets .chip').forEach((c) => c.classList.remove('is-active'));
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
  // 年月をカタカタ変えるとその月に切り替わる
  $('#f-month').addEventListener('change', () => {
    applyMonth($('#f-month').value);
    render();
  });

  // 開いたドロップダウン以外は閉じる。
  // フィルタ帯を横スクロールさせている（=はみ出しが切られる）ので、
  // メニューは position: fixed にして開いた瞬間に位置を計算する。
  // 比較タブのドロップダウンは描き直すたびに作られるので、
  // 「そのときある details 全部」を毎回引き直す。
  for (const dd of $$('#filterbar details.dropdown')) {
    dd.addEventListener('toggle', () => {
      if (!dd.open) return;
      for (const other of $$('details.dropdown')) if (other !== dd) other.open = false;
      placeMenu(dd);
    });
  }
  document.addEventListener('click', (e) => {
    if (e.target.closest('details.dropdown')) return;
    for (const dd of $$('details.dropdown')) dd.open = false;
  });
  addEventListener('resize', debounce(() => {
    for (const dd of $$('details.dropdown')) if (dd.open) placeMenu(dd);
  }, 100));
}

// ドロップダウンのメニューを、ボタンの真下（画面からはみ出すなら内側に寄せて）置く
function placeMenu(dd) {
  const menu = dd.querySelector('.menu');
  const anchor = dd.querySelector('summary').getBoundingClientRect();
  menu.style.top = `${anchor.bottom + 4}px`;
  menu.style.left = '0px';        // 幅を測るためいったん左に置く
  const width = menu.offsetWidth;
  const left = Math.min(anchor.left, Math.max(8, innerWidth - width - 8));
  menu.style.left = `${left}px`;
  menu.style.maxHeight = `${Math.max(160, innerHeight - anchor.bottom - 20)}px`;
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

  // 広告主/アフィリエイター（内訳を塗り分ける画面）
  wirePickView('cmp', state.compare);

  // 比較
  segClick('#vs-layout', 'vslayout', (v) => { state.versus.layout = v; });
  segClick('#vs-mode', 'vsmode', (v) => { state.versus.mode = v; });
  segClick('#vs-metric', 'vsmetric', (v) => { state.versus.metric = v; });
  segClick('#vs-grain', 'vsgrain', (v) => { state.versus.grain = v; });

  // ランキング
  segClick('#rank-metric', 'rankmetric', (v) => { state.rank.metric = v; });

  // 広告主タブ / アフィリエイタータブ
  for (const kind of ['advertiser', 'affiliate']) {
    const input = $(`#${kind}-search`);
    const run = () => {
      state.list[kind].search = input.value.trim();
      render();
    };
    input.addEventListener('input', debounce(run, 300));
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });

    segClick(`#${kind}-grain`, 'egrain', (v) => { state.list[kind].grain = v; });
  }

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

// チップの列。押したものだけ is-active にして、値を渡して描き直す。
function segClick(sel, dataKey, set) {
  const box = $(sel);
  if (!box) return;
  box.addEventListener('click', (e) => {
    const btn = e.target.closest('.chip');
    if (!btn || !(dataKey in btn.dataset)) return;
    $$(`${sel} .chip`).forEach((x) => x.classList.toggle('is-active', x === btn));
    set(btn.dataset[dataKey]);
    render();
  });
}

// 「広告主/アフィリエイター」の操作系。
// prefix は HTML 側の id と data 属性の頭（'cmp'）。
function wirePickView(prefix, st) {
  const seg = (name, set) => {
    const box = $(`#${prefix}-${name}`);
    if (!box) return;
    box.addEventListener('click', (e) => {
      const btn = e.target.closest('.chip');
      if (!btn) return;
      $$(`#${prefix}-${name} .chip`).forEach((x) => x.classList.toggle('is-active', x === btn));
      set(btn.dataset[prefix + name]);
      render();
    });
  };
  seg('dim', (v) => {
    st.dim = v;
    st.query = '';
    st.hiddenBands.clear();       // 軸が変われば塗り分けの相手も変わる
    $(`#${prefix}-search`).value = '';
  });
  seg('metric', (v) => { st.metric = v; });
  seg('grain', (v) => { st.grain = v; });

  $(`#${prefix}-fill`).addEventListener('change', (e) => {
    st.filled = e.target.checked;
    render();
  });

  const search = $(`#${prefix}-search`);
  const runSearch = () => { st.query = search.value.trim(); renderPickList(prefix, st); };
  search.addEventListener('input', debounce(runSearch, 200));
  search.addEventListener('keydown', (e) => { if (e.key === 'Enter') runSearch(); });
  $(`#${prefix}-search-go`).addEventListener('click', runSearch);

  // 全員選択は「いま一覧に出ているぶん」。検索で絞ってから押せる。
  $(`#${prefix}-all`).addEventListener('click', () => {
    st.picked[st.dim] = visibleCandidates(st).map((r) => r.label);
    render();
  });
  $(`#${prefix}-top5`).addEventListener('click', () => {
    st.picked[st.dim] = st.candidates.slice(0, 5).map((r) => r.label);
    render();
  });
  $(`#${prefix}-clear`).addEventListener('click', () => {
    st.picked[st.dim] = [];
    render();
  });
}

// ---- 設定 --------------------------------------------------------------

function wireSettings() {
  const dlg = $('#settings');
  const themeSel = $('#set-theme');
  const paletteSel = $('#set-palette');
  const statusChk = $('#set-status-color');
  const densitySel = $('#set-density');

  paletteSel.replaceChildren(...Object.entries(cfg.PALETTES)
    .map(([value, p]) => el('option', { value, text: p.label })));

  const showPreview = () => {
    $('#palette-preview').replaceChildren(
      ...(cfg.PALETTES[paletteSel.value] || cfg.PALETTES.standard).colors
        .map((c) => {
          const sw = el('i');
          sw.style.background = c;
          return sw;
        }));
  };

  const sync = () => {
    const s = cfg.settings();
    themeSel.value = s.theme;
    paletteSel.value = s.palette;
    statusChk.checked = s.statusColor;
    densitySel.value = s.density;
    showPreview();
  };

  // 配色を変えると Chart.js が持っている色は古いままなので、作り直す
  const applyAndRedraw = (patch) => {
    cfg.update(patch);
    sync();
    ch.destroyAll();
    render();
  };

  themeSel.addEventListener('change', () => applyAndRedraw({ theme: themeSel.value }));
  paletteSel.addEventListener('change', () => applyAndRedraw({ palette: paletteSel.value }));
  densitySel.addEventListener('change', () => applyAndRedraw({ density: densitySel.value }));
  statusChk.addEventListener('change', () => cfg.update({ statusColor: statusChk.checked }));
  $('#set-reset').addEventListener('click', () => { cfg.reset(); applyAndRedraw({}); });

  $('#open-settings').addEventListener('click', () => { sync(); dlg.showModal(); });
  sync();
}

// ---- フィルタ ----------------------------------------------------------

async function loadMeta() {
  // 起動直後に一度だけ失敗することがある（接続の立ち上がり）。
  // ここで諦めるとフィルタが空のまま残ってしまうので、1回だけ入れ直す。
  try {
    state.meta = await api.filters();
  } catch (first) {
    await new Promise((r) => setTimeout(r, 400));
    try {
      state.meta = await api.filters();
    } catch (e) {
      toast('フィルタ情報の取得に失敗: ' + e.message);
      state.meta = null;
      return;
    }
  }
  const m = state.meta;

  buildStatusBoxes();
  buildPicker('advertiser', m.advertisers || []);
  buildPicker('affiliate', m.affiliates || []);
  readFilterInputs();
  updatePickerLabel('advertiser');
  updatePickerLabel('affiliate');
}

// ステータスの色分け。承認=緑 / 保留=黄 / 却下=赤。
// 実際の色は CSS 側（設定でオフにもできる）。
export const STATUS_CLASS = (s) =>
  (s === '承認' ? 'st-ok' : s === '却下' ? 'st-ng' : s === '保留' ? 'st-hold' : 'st-other');

// ステータスのチェックボックス。いま見ているページの条件を反映する。
// 何も選んでいない状態（初期）は「全部オン」として扱う。
function buildStatusBoxes() {
  const box = $('#f-status');
  const statuses = state.meta?.statuses || [];
  const sel = state.filter.statuses;      // null なら全部オン
  box.replaceChildren();
  for (const s of statuses) {
    const cb = el('input', { type: 'checkbox', value: s });
    cb.checked = sel === null || sel.includes(s);
    cb.addEventListener('change', () => { readFilterInputs(); render(); });
    box.append(el('label', { class: `inline check status ${STATUS_CLASS(s)}` },
      cb, el('i', { class: 'dot' }), s));
  }
  if (!statuses.length) box.append(el('span', { class: 'muted small', text: 'データ未取込' }));
}

// チェックの状態を絞り込みの値に直す。
// 全部入っていれば null（＝絞らない）。0個なら []（＝全員外した）。
function readBoxes(sel) {
  const boxes = $$(sel);
  if (!boxes.length) return null;
  const checked = boxes.filter((b) => b.checked).map((b) => b.value);
  return checked.length === boxes.length ? null : checked;
}

function readFilterInputs() {
  const off = pickerOff(state.view);
  // 条件が変われば件数も変わる。ページ送りは1ページ目に戻す。
  state.detail.page = 0;
  state.filter.from = $('#f-from').value || state.filter.from;
  state.filter.to = $('#f-to').value || state.filter.to;
  state.filter.statuses = readBoxes('#f-status input[type=checkbox]');
  // 出していない側の絞り込みは、引き継いだ値が残っていても効かせない
  state.filter.advertisers = off.includes('advertiser') ? null
    : readBoxes('#f-advertiser input[type=checkbox]');
  state.filter.affiliates = off.includes('affiliate') ? null
    : readBoxes('#f-affiliate input[type=checkbox]');
}

// ---- 広告主 / アフィリエイターの選択（お気に入り付き） ------------------

const PICKERS = {
  advertiser: { label: '広告主', box: '#f-advertiser', tag: '#f-advertiser-label', key: 'advertisers' },
  affiliate:  { label: 'アフィリエイター', box: '#f-affiliate', tag: '#f-affiliate-label', key: 'affiliates' },
};

const LS_FAV = (kind) => `afd.fav.${kind}`;

// ドロップダウン内の検索語。作り直しても消えないようにここに置く。
const pickerQuery = { advertiser: '', affiliate: '' };

function favorites(kind) {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_FAV(kind)) || '[]');
    return new Set(Array.isArray(raw) ? raw : []);
  } catch {
    return new Set();
  }
}

function toggleFavorite(kind, name) {
  const set = favorites(kind);
  if (set.has(name)) set.delete(name);
  else set.add(name);
  localStorage.setItem(LS_FAV(kind), JSON.stringify([...set]));
}

// 一覧をお気に入り優先で並べる（★が上、その中はもとの順）
function sortByFavorite(items, fav) {
  return items.slice().sort((a, b) => (fav.has(b) ? 1 : 0) - (fav.has(a) ? 1 : 0));
}

function buildPicker(kind, items) {
  const p = PICKERS[kind];
  const box = $(p.box);
  const fav = favorites(kind);
  const sel = state.filter[p.key];     // null なら「全部」＝チェックも全部入れて見せる

  box.replaceChildren();

  if (!items.length) {
    box.append(el('p', { class: 'muted small menu-empty', text: 'データ未取込' }));
    updatePickerLabel(kind);
    return;
  }

  const apply = () => {
    readFilterInputs();
    updatePickerLabel(kind);
    render();
  };
  // 検索中は、見えている行だけを「すべて / 解除」の対象にする
  // （絞り込んだつもりで隠れているものまで動くと分からなくなるため）
  const visibleBoxes = () =>
    $$(`${p.box} .pick`).filter((row) => !row.hidden)
      .map((row) => row.querySelector('input[type=checkbox]'));
  const setAll = (on) => {
    visibleBoxes().forEach((c) => { c.checked = on; });
    apply();
  };
  const setFavOnly = () => {
    const f = favorites(kind);
    $$(`${p.box} input[type=checkbox]`).forEach((c) => { c.checked = f.has(c.value); });
    apply();
  };

  // 検索欄。件数が多いので絞れないと選べない。
  // 星の付け外しで作り直すため、打ちかけの語は覚えておく。
  const search = el('input', {
    type: 'search',
    class: 'menu-search',
    placeholder: `${p.label}を検索`,
    value: pickerQuery[kind] || '',
  });
  const runSearch = () => {
    pickerQuery[kind] = search.value;
    const q = search.value.trim().toLowerCase();
    for (const row of $$(`${p.box} .pick`)) {
      row.hidden = Boolean(q) && !row.dataset.name.includes(q);
    }
  };
  search.addEventListener('input', runSearch);
  // details の中なので、Enter でフォーム送信や閉じる動作に流れないようにする
  search.addEventListener('keydown', (e) => { if (e.key === 'Enter') e.preventDefault(); });

  box.append(el('div', { class: 'menu-tools' },
    search,
    el('div', { class: 'seg' },
      el('button', { type: 'button', class: 'chip', text: 'すべて', onclick: () => setAll(true) }),
      el('button', { type: 'button', class: 'chip', text: '全員外す', onclick: () => setAll(false) }),
      el('button', { type: 'button', class: 'chip', text: '★だけ', title: 'お気に入りに付けたものだけで絞る', onclick: setFavOnly }),
    ),
  ));

  for (const name of sortByFavorite(items, fav)) {
    const cb = el('input', { type: 'checkbox', value: name });
    cb.checked = sel === null || sel.includes(name);
    cb.addEventListener('change', apply);

    const star = el('button', {
      type: 'button',
      class: `fav${fav.has(name) ? ' on' : ''}`,
      text: fav.has(name) ? '★' : '☆',
      title: 'お気に入り',
    });
    // ラベルの中のボタンなので、クリックがチェックに伝わらないようにする
    star.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleFavorite(kind, name);
      buildPicker(kind, items);
    });

    box.append(el('label', { class: 'pick', 'data-name': String(name).toLowerCase() },
      cb, el('span', { class: 'name', text: name }), star));
  }
  runSearch();          // 打ちかけの検索語があれば、作り直した直後にも効かせる
  updatePickerLabel(kind);
}

function updatePickerLabel(kind) {
  const p = PICKERS[kind];
  const sel = state.filter[p.key];
  const tag = $(p.tag);
  if (sel === null) { tag.textContent = `${p.label}: 全て`; return; }
  if (!sel.length) { tag.textContent = `${p.label}: なし`; return; }
  const fav = favorites(kind);
  const allFav = sel.length === fav.size && sel.every((x) => fav.has(x));
  tag.textContent =
    `${p.label}: ${allFav ? '★のみ' : sel.length === 1 ? sel[0] : sel.length + '件'}`;
}

function applyPreset(preset) {
  const m = state.meta || {};
  const today = new Date();

  state.filter.preset = preset;
  state.filter.month = '';
  $('#f-month').value = '';

  if (preset === 'all') {
    const mins = [m.cv_date_min, m.ck_date_min].filter(Boolean).sort();
    const maxs = [m.cv_date_max, m.ck_date_max].filter(Boolean).sort();
    setRange(mins[0] || ymd(addDays(today, -30)), maxs[maxs.length - 1] || ymd(today));
    return;
  }
  // 過去1週間（今日を含む7日）
  setRange(ymd(addDays(today, -(Number(preset) - 1))), ymd(today));
}

// 月の選択肢を作る。新しい月が上、いちばん下が 2025/1。
const MONTH_FLOOR = { year: 2025, month: 1 };

function buildMonthOptions() {
  const sel = $('#f-month');
  const now = new Date();
  const opts = [el('option', { value: '', text: '月を選ぶ' })];
  for (let y = now.getFullYear(), m = now.getMonth() + 1;
    y > MONTH_FLOOR.year || (y === MONTH_FLOOR.year && m >= MONTH_FLOOR.month);) {
    const value = `${y}-${String(m).padStart(2, '0')}`;
    opts.push(el('option', { value, text: `${y}/${m}` }));
    m -= 1;
    if (m === 0) { m = 12; y -= 1; }
  }
  sel.replaceChildren(...opts);
}

// 年月（YYYY-MM）→ その月の1日〜末日
function applyMonth(value) {
  const m = /^(\d{4})-(\d{1,2})$/.exec(value || '');
  if (!m) return;
  const year = Number(m[1]);
  const month = Number(m[2]);
  state.filter.month = value;
  state.filter.preset = '';
  $$('#presets .chip').forEach((c) => c.classList.remove('is-active'));
  setRange(ymd(new Date(year, month - 1, 1)), ymd(new Date(year, month, 0)));
}

function setRange(from, to) {
  $('#f-from').value = from;
  $('#f-to').value = to;
  readFilterInputs();
}

// ---- 描画の入口 --------------------------------------------------------

// いまの条件を人が読める形で書き出す。空っぽの画面の理由を説明するのに使う。
function filterSummaryText() {
  const f = state.filter;
  const bits = [`${f.from} 〜 ${f.to}`];
  const part = (label, v) => {
    if (v === null || v === undefined) return;
    bits.push(v.length ? `${label} ${v.length}件` : `${label} なし`);
  };
  part('ステータス', f.statuses);
  part('広告主', f.advertisers);
  part('アフィリエイター', f.affiliates);
  return bits.join(' / ');
}

async function render() {
  if (state.view === 'import') { loadImportHistory(); return; }
  // 期間が決まっていないと問い合わせようがない。黙って戻ると
  // 「何も出てこない」画面になるので、理由を出しておく。
  if (!state.filter.from || !state.filter.to) {
    if (state.view === 'detail') showDetailEmpty('期間を選んでください');
    return;
  }

  busy(true);
  try {
    if (state.view === 'summary')            await renderSummary();
    else if (state.view === 'compare')       await renderPickView('cmp', state.compare);
    else if (state.view === 'versus')        await renderVersus();
    else if (state.view === 'advertiser')    await renderEntity('advertiser');
    else if (state.view === 'affiliate')     await renderEntity('affiliate');
    else if (state.view === 'rank')          await renderRank();
    else if (state.view === 'detail')        await renderDetail();
  } catch (e) {
    toast(e.message);
    console.error(e);
    // 失敗したまま前の中身が残る／空のままになるのを避ける
    if (state.view === 'detail') showDetailEmpty('読み込めませんでした: ' + e.message);
  } finally {
    busy(false);
  }
}

// 成果明細を、理由つきの空表示にする
function showDetailEmpty(reason) {
  const table = $('#t-detail');
  table.replaceChildren(el('tbody', {}, el('tr', {},
    el('td', { class: 'empty' },
      el('div', { text: reason }),
      el('div', { class: 'muted small', text: 'いまの条件: ' + filterSummaryText() })))));
  $('#detail-count').textContent = '';
  $('#detail-page').textContent = '';
  $('#detail-prev').disabled = true;
  $('#detail-next').disabled = true;
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
  const rows = dailyRows(ts, f.from, f.to);
  state.summaryRows = rows;

  const sum = (k) => rows.reduce((a, r) => a + r[k], 0);
  $('#summary-total').textContent =
    `期間合計 売上 ${yen(sum('sales'))} / 報酬額 ${yen(sum('reward'))} / 想定 ${yen(sum('mt'))}`;

  renderDailyMatrix($('#t-summary'), rows, $('#summary-matrix-wrap'));

  ch.line('c-summary-line', rows.map((r) => r.md), [
    { label: '売上', data: rows.map((r) => r.sales), fill: true },
  ], { money: true });
}

const WEEKDAY = ['日', '月', '火', '水', '木', '金', '土'];

// dash_timeseries の結果を、期間ぶんの「1日1行」に均す。
// 成果が無かった日も 0 として並べる（連日で見たいので歯抜けにしない）。
// 並びは古い → 新しい。つまり左から右へ行くほど今日に近づく。
function dailyRows(ts, from, to) {
  const rate = mtRate() / 100;
  const byDay = new Map(ts.map((r) => [String(r.bucket), r]));
  const rows = [];
  for (let d = new Date(from); ymd(d) <= to; d = addDays(d, 1)) {
    const key = ymd(d);
    const r = byDay.get(key);
    const reward = Number(r?.reward || 0);
    rows.push({
      bucket: key,
      md: key.slice(5).replace('-', '/'),
      wd: WEEKDAY[d.getDay()],
      kind: dayKind(key, d.getDay()),         // 'sat' | 'sun' | 'holiday' | null
      holiday: holidayName(key),
      conversions: Number(r?.conversions || 0),
      clicks: Number(r?.clicks || 0),
      sales: Number(r?.sales || 0),
      reward,
      mt: Math.round(reward * rate),
    });
  }
  return rows;
}

// 日付を「列」にした表を組む。指標名の列は CSS で左に固定してある。
function renderDailyMatrix(table, rows, wrap) {
  const last = rows.length - 1;

  if (!rows.length) {
    table.replaceChildren(el('tbody', {}, el('tr', {},
      el('td', { class: 'empty', text: '期間を選んでください' }))));
    return;
  }

  const metrics = [
    { key: 'sales', label: '売上', fmt: yen },
    { key: 'reward', label: 'アフィリエイター報酬額', fmt: yen },
    { key: 'mt', label: `想定マネートラック報酬（${mtRate()}%）`, fmt: yen },
    { key: 'conversions', label: '成果件数', fmt: num },
  ];

  // 土日祝と最新日は class で見分ける（色は CSS 側）
  const cls = (r, i) => [
    r.kind ? `is-${r.kind}` : '',
    i === last ? 'is-latest' : '',
  ].filter(Boolean).join(' ') || null;

  table.replaceChildren(
    el('thead', {}, el('tr', {},
      el('th', { class: 'rowhead', text: '日付' }),
      ...rows.map((r, i) => el('th', {
        class: cls(r, i),
        title: r.holiday ? `${r.bucket} ${r.holiday}` : r.bucket,
      },
      r.md,
      el('span', { class: 'wd', text: r.holiday ? '祝' : r.wd }))))),
    el('tbody', {}, ...metrics.map((m) => el('tr', {},
      el('th', { class: 'rowhead', text: m.label }),
      ...rows.map((r, i) => el('td', { class: cls(r, i), text: m.fmt(r[m.key]) }))))),
  );

  // 直近の日付が見えている状態で開きたいので、右端まで寄せる
  if (wrap) wrap.scrollLeft = wrap.scrollWidth;
}

// ---- 相手を選んで時系列で見る2画面 --------------------------------------
//
// 「広告主/アフィリエイター」(cmp) … 選んだ相手の合計を、もう一方の軸で塗り分ける
// 「比較」(vs)                     … 選んだ相手を1本ずつの線にして直接くらべる
//
// 操作も取ってくるデータもほぼ同じなので、prefix で HTML を切り替えて共有する。

const CMP_METRIC = {
  conversions: { key: 'conversions', label: '成果件数', type: 'num', money: false },
  sales:       { key: 'sales',       label: '売上',     type: 'yen', money: true },
  reward:      { key: 'reward',      label: '報酬額',   type: 'yen', money: true },
  clicks:      { key: 'clicks',      label: 'クリック', type: 'num', money: false },
  cvr:         { key: 'cvr',         label: 'CVR',      type: 'pct', money: false },
};

// 積み上げる帯の本数。増やしすぎると色が見分けられなくなる。
const CMP_BANDS = 8;

// 検索欄で絞ったあとの候補
function visibleCandidates(st) {
  const q = (st.query || '').toLowerCase();
  return q ? st.candidates.filter((r) => String(r.label).toLowerCase().includes(q)) : st.candidates;
}

async function renderPickView(prefix, st) {
  const byAdvertiser = st.dim === 'advertiser';
  const dimLabel = byAdvertiser ? '広告主' : 'アフィリエイター';

  // 選択候補（売上順）
  st.candidates = await api.dimension(state.filter, st.dim, 300);

  // 初回だけ上位を自動で選ぶ。自分で空にした場合はそのまま空にしておく。
  if (st.picked[st.dim] === null) {
    st.picked[st.dim] = st.candidates.slice(0, byAdvertiser ? 3 : 5).map((r) => r.label);
  }
  renderPickList(prefix, st);

  const picked = st.picked[st.dim];
  const metric = CMP_METRIC[st.metric];

  // 内訳の画面では、塗り分けは常に“もう一方の軸”でやる。
  //   広告主を選んだ           → 誰（アフィリエイター）が作っているかで塗る
  //   アフィリエイターを選んだ → どこ（広告主）で稼いだかで塗る
  const bandLabel = byAdvertiser ? 'アフィリエイター' : '広告主';
  $(`#${prefix}-title`).textContent =
    `選んだ${dimLabel}の${metric.label} — ${bandLabel}別の内訳（凡例をクリックで出し入れ）`;

  const canvas = 'c-compare';
  if (!picked.length) {
    ch.line(canvas, [], []);
    st.rows = [];
    return;
  }

  const rows = byAdvertiser
    // 選んだ広告主に絞って、その中の上位アフィリエイターを系列にする
    ? await api.compare(state.filter, 'affiliate', null, st.grain, CMP_BANDS, { advertisers: picked })
    // 選んだアフィリエイターに絞って、その中の上位広告主を系列にする
    : await api.compare(state.filter, 'advertiser', null, st.grain, CMP_BANDS, { affiliates: picked });
  st.rows = rows;

  // series × bucket の行を、系列ごとの配列に組み替える
  const buckets = [...new Set(rows.map((r) => String(r.bucket)))].sort();
  const bySeries = new Map();
  for (const r of rows) {
    if (!bySeries.has(r.series)) bySeries.set(r.series, new Map());
    bySeries.get(r.series).set(String(r.bucket), r);
  }

  // 期間合計の大きい順に積む（下が大きい方）
  const order = [...bySeries.keys()].sort((a, b) => {
    const sum = (k) => [...bySeries.get(k).values()]
      .reduce((acc, r) => acc + Number(r[st.metric] || 0), 0);
    return sum(b) - sum(a);
  });

  const labels = buckets.map((b) => (st.grain === 'month' ? b.slice(0, 7) : b.slice(5)));
  const series = order.map((name, i) => ({
    label: name,
    color: ch.color(i),
    // 凡例で消したものは Chart.js に「隠し」として渡す（並び順と色は変えない）
    hidden: st.hiddenBands.has(name),
    data: buckets.map((b) => {
      const r = bySeries.get(name).get(b);
      if (!r) return st.metric === 'cvr' ? null : 0;
      return r[st.metric] === null ? null : Number(r[st.metric]);
    }),
  }));

  // 凡例のクリックで、その相手だけ出し入れする。
  // 描き直しても状態が消えないよう、隠した相手は st に覚えておく。
  const onLegend = (name, nowHidden) => {
    if (nowHidden) st.hiddenBands.add(name);
    else st.hiddenBands.delete(name);
  };

  // CVR は足し算にならないので積み上げない（線のまま重ねる）
  if (st.metric === 'cvr') {
    ch.line(canvas, labels, series, { onLegend });
  } else {
    ch.area(canvas, labels, series, { money: metric.money, filled: st.filled, onLegend });
  }
}

function renderPickList(prefix, st) {
  const box = $(`#${prefix}-list`);
  const current = st.picked[st.dim] ?? [];
  const picked = new Set(current);
  const list = visibleCandidates(st);

  box.replaceChildren();
  if (!list.length) {
    box.append(el('p', { class: 'muted small', text: '該当なし' }));
    return;
  }

  for (const r of list) {
    const cb = el('input', { type: 'checkbox', value: r.label });
    cb.checked = picked.has(r.label);
    cb.addEventListener('change', () => {
      const cur = new Set(st.picked[st.dim] ?? []);
      if (cb.checked) cur.add(r.label);
      else cur.delete(r.label);
      st.picked[st.dim] = st.candidates.map((x) => x.label).filter((l) => cur.has(l));
      render();
    });

    box.append(el('label', {}, cb, r.label,
      el('span', { class: 'cmp-sub', text: '¥' + compact(r.sales) })));
  }
}

// ---- 広告主タブ / アフィリエイタータブ ----------------------------------
//
// 選んだ相手ぶんの「かたまり」を縦に並べて、スクロールして見ていく画面。
// 1かたまりの中身（広告主なら）:
//   ・アフィリエイター別 売上の円グラフ
//   ・売上上位アフィリエイター / 上位商品
//   ・売上の推移（線）
//   ・日別の金額明細（日付を横に並べて横スクロール）
// アフィリエイターの側は「アフィリエイター↔広告主」を入れ替えたうえで
// 流入元の円グラフが1つ増える。
//
// 期間・ステータスは上のフィルタ帯に従う。相手の絞り込みも上のドロップダウンで、
// この2画面では自分に関係ある側だけを出す（広告主の画面に人の絞り込みは出さない）。

const LIST_LABEL = { advertiser: '広告主', affiliate: 'アフィリエイター' };

// 相手の軸。広告主の画面では中身をアフィリエイターで割る（その逆も同じ）。
const OTHER = { advertiser: 'affiliate', affiliate: 'advertiser' };

// 表示する部品。ボタンで一時的に隠せる。
const ENTITY_PARTS = {
  advertiser: [
    { key: 'pie',      label: 'アフィリエイター内訳' },
    { key: 'top',      label: '上位アフィリエイター' },
    { key: 'products', label: '上位商品' },
    { key: 'line',     label: '売上の推移' },
    { key: 'matrix',   label: '日別明細' },
  ],
  affiliate: [
    { key: 'pie',      label: '広告主内訳' },
    { key: 'top',      label: '上位広告主' },
    { key: 'products', label: '上位商品' },
    { key: 'line',     label: '売上の推移' },
    { key: 'referrer', label: '流入元' },
    { key: 'matrix',   label: '日別明細' },
  ],
};

const PIE_SLICES = 10;   // 円グラフに出す数（残りは「その他」にまとめる）
const TOP_ROWS = 8;      // 「上位」に出す行数
const MAX_BLOCKS = 60;   // 一度に並べるかたまりの上限

const LS_PARTS = (kind) => `afd.parts.${kind}`;

function hiddenParts(kind) {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_PARTS(kind)) || '[]');
    return new Set(Array.isArray(raw) ? raw : []);
  } catch {
    return new Set();
  }
}

function togglePart(kind, key) {
  const set = hiddenParts(kind);
  if (set.has(key)) set.delete(key);
  else set.add(key);
  localStorage.setItem(LS_PARTS(kind), JSON.stringify([...set]));
}

// 「表示するもの」のボタン列
function buildPartButtons(kind) {
  const box = $(`#${kind}-parts`);
  const off = hiddenParts(kind);
  box.replaceChildren(...ENTITY_PARTS[kind].map((p) => el('button', {
    type: 'button',
    class: `chip${off.has(p.key) ? '' : ' is-active'}`,
    text: p.label,
    title: off.has(p.key) ? 'クリックで表示する' : 'クリックで隠す',
    onclick: () => {
      togglePart(kind, p.key);
      buildPartButtons(kind);
      renderEntity(kind);          // 隠す/出すで作り直す（Chart.js が 0x0 で固まるため）
    },
  })));
}

// 読み込み済みの中身。タブを行き来しても取り直さない。
const entityCache = new Map();     // `${kind}|${id}|条件` → payload
const entityLoading = new Set();
let entityToken = 0;               // 条件が変わったら古い読み込みを捨てるための世代番号

// 日別の行を 日 / 月 / 年 にまとめ直す。
// SQL 側は日・週・月しか受けないので、年はここで足す。
// もとの日別は明細でも使うので、取り直さずに使い回す。
function rollup(daily, grain) {
  const withCvr = (r) => ({ ...r, cvr: r.clicks ? (r.conversions / r.clicks) * 100 : null });
  if (grain === 'day' || !grain) {
    return daily.map((r) => withCvr({
      label: r.md, sales: r.sales, reward: r.reward, conversions: r.conversions, clicks: r.clicks,
    }));
  }
  const keyOf = (r) => (grain === 'year' ? r.bucket.slice(0, 4) : r.bucket.slice(0, 7));
  const out = [];
  const index = new Map();
  for (const r of daily) {
    const k = keyOf(r);
    let row = index.get(k);
    if (!row) {
      row = { label: k, sales: 0, reward: 0, conversions: 0, clicks: 0 };
      index.set(k, row);
      out.push(row);
    }
    row.sales += r.sales;
    row.reward += r.reward;
    row.conversions += r.conversions;
    row.clicks += r.clicks;
  }
  // 比率は足せないので、まとめたあとの成果とクリックから出し直す
  return out.map(withCvr);
}

function entityCacheKey(kind, id) {
  const f = state.filter;
  return [kind, id, f.from, f.to, (f.statuses || []).join(','), mtRate()].join('|');
}

async function renderEntity(kind) {
  const f = state.filter;
  const st = state.list[kind];
  const token = ++entityToken;

  buildPartButtons(kind);

  // 一覧（売上順）。上のドロップダウンで絞られていれば、その相手だけが返る。
  const all = await api.dimension(f, kind, 500);
  if (token !== entityToken) return;

  const q = st.search.trim().toLowerCase();
  const rows = q ? all.filter((r) => String(r.label).toLowerCase().includes(q)) : all;
  st.rows = rows.map((r) => ({
    ...r,
    cvr: Number(r.clicks) > 0 ? (Number(r.conversions) / Number(r.clicks)) * 100 : null,
  }));

  const shown = rows.slice(0, MAX_BLOCKS);
  const totalSales = rows.reduce((a, r) => a + Number(r.sales || 0), 0);
  $(`#${kind}-count`).textContent = rows.length > shown.length
    ? `${num(rows.length)} 件中 上位 ${num(shown.length)} 件 / 売上 ${yen(totalSales)}`
    : `${num(rows.length)} 件 / 売上 ${yen(totalSales)}`;

  const box = $(`#${kind}-blocks`);
  box.replaceChildren();

  if (!shown.length) {
    box.append(el('p', { class: 'empty', text: '該当するデータがありません' }));
    return;
  }

  const off = hiddenParts(kind);
  const parts = ENTITY_PARTS[kind].filter((p) => !off.has(p.key));
  for (const row of shown) box.append(entityShell(kind, row, parts));

  fillVisibleBlocks(kind, box, parts, token);
}

// 見えているぶん（と、その少し先）だけ中身を取りに行く。
// かたまり1つにつき数本の問い合わせが要るので、まとめて投げない。
//
// IntersectionObserver は「描画されていない状態」だと発火しないことがあり、
// 画面が出ているのに永遠に「読み込み中」で止まることがある。
// 位置を自分で測るほうが確実なので、スクロールに合わせて都度判定する。
const BLOCK_LOOKAHEAD = 400;   // 画面外どれだけ先まで先読みするか（px）

function fillVisibleBlocks(kind, box, parts, token) {
  const run = () => {
    if (token !== entityToken || !box.isConnected) return;
    const br = box.getBoundingClientRect();
    let filled = 0;
    for (const node of box.children) {
      if (node.dataset.filled) continue;
      const r = node.getBoundingClientRect();
      const offscreen = r.bottom < br.top - BLOCK_LOOKAHEAD || r.top > br.bottom + BLOCK_LOOKAHEAD;
      // 高さが取れない（= まだ描画されていない）ときは、先頭だけでも出す
      if (offscreen && !(br.height === 0 && filled < 3)) continue;
      node.dataset.filled = '1';
      filled += 1;
      fillEntityBlock(kind, node, parts, token);
    }
  };
  box.onscroll = debounce(run, 80);
  run();
  // 折り返しやフォントの反映で高さが変わることがあるので、次のフレームでもう一度
  requestAnimationFrame(run);
}

// かたまりの外枠だけ先に作る（中身は見えたときに入れる）
function entityShell(kind, row, parts) {
  const cvr = Number(row.clicks) > 0
    ? (Number(row.conversions) / Number(row.clicks)) * 100 : null;

  return el('section', { class: 'eblock', 'data-id': row.label },
    el('header', { class: 'eb-head' },
      el('h3', { text: row.label }),
      el('span', { class: 'eb-stats' },
        `売上 ${yen(row.sales)}`,
        el('span', { class: 'sep', text: '/' }), `成果 ${num(row.conversions)}件`,
        el('span', { class: 'sep', text: '/' }), `報酬 ${yen(row.reward)}`,
        el('span', { class: 'sep', text: '/' }), `クリック ${num(row.clicks)}`,
        el('span', { class: 'sep', text: '/' }), `CVR ${cvr === null ? '—' : pct(cvr)}`)),
    el('div', { class: 'eb-grid' },
      ...parts.map((p) => el('div', { class: `eb-cell${p.key === 'matrix' ? ' wide' : ''}`, 'data-part': p.key },
        el('h4', { text: p.label }),
        el('div', { class: 'eb-body', text: '読み込み中…' })))),
  );
}

// 見えたかたまりの中身を作る
async function fillEntityBlock(kind, node, parts, token) {
  const id = node.dataset.id;
  const key = entityCacheKey(kind, id);
  if (entityLoading.has(key)) return;

  let data = entityCache.get(key);
  if (!data) {
    entityLoading.add(key);
    try {
      data = await loadEntity(kind, id);
      entityCache.set(key, data);
    } catch (e) {
      node.querySelectorAll('.eb-body').forEach((b) => {
        b.replaceChildren(el('p', { class: 'muted small', text: '読み込めませんでした: ' + e.message }));
      });
      return;
    } finally {
      entityLoading.delete(key);
    }
  }
  if (token !== entityToken || !node.isConnected) return;

  for (const p of parts) {
    const cell = node.querySelector(`.eb-cell[data-part="${p.key}"] .eb-body`);
    if (cell) drawEntityPart(kind, id, p.key, cell, data);
  }
}

async function loadEntity(kind, id) {
  const f = state.filter;
  const scope = kind === 'advertiser' ? { advertisers: [id] } : { affiliates: [id] };
  const other = OTHER[kind];

  // 相手ごとに数本ずつ問い合わせる。まとめて await して往復を減らす。
  const jobs = [
    api.dimension(f, other, 60, null, scope),
    api.dimension(f, 'product', TOP_ROWS, null, scope),
    api.timeseries(f, 'day', scope),
  ];
  if (kind === 'affiliate') jobs.push(api.dimension(f, 'referrer', PIE_SLICES + 5, null, scope));

  const [others, products, ts, referrers] = await Promise.all(jobs);
  return { others, products, ts, referrers: referrers || [], daily: dailyRows(ts, f.from, f.to) };
}

// 上位 N 件＋「その他」にまとめた円グラフ用のデータ
function pieParts(rows, valueKey = 'sales', limit = PIE_SLICES) {
  const sorted = rows.slice().sort((a, b) => Number(b[valueKey] || 0) - Number(a[valueKey] || 0));
  const top = sorted.slice(0, limit);
  const restSum = sorted.slice(limit).reduce((a, r) => a + Number(r[valueKey] || 0), 0);
  const labels = top.map((r) => r.label);
  const values = top.map((r) => Number(r[valueKey] || 0));
  if (restSum > 0) { labels.push('その他'); values.push(restSum); }
  return { labels, values };
}

function miniTable(head, rows, fmt) {
  return el('table', { class: 'mini' },
    el('thead', {}, el('tr', {},
      el('th', { text: head }), el('th', { class: 'num', text: '売上' }))),
    el('tbody', {}, ...(rows.length
      ? rows.map((r) => el('tr', {},
        el('td', { class: 'trunc', text: r.label, title: r.label }),
        el('td', { class: 'num', text: fmt(r.sales) })))
      : [el('tr', {}, el('td', { class: 'empty', colspan: 2, text: 'データなし' }))])));
}

function drawEntityPart(kind, id, part, cell, data) {
  const other = OTHER[kind];
  const safeId = String(id).replace(/[^\w-]/g, '_');

  if (part === 'pie' || part === 'referrer') {
    const src = part === 'pie' ? data.others : data.referrers;
    const { labels, values } = pieParts(src);
    if (!values.length) {
      cell.replaceChildren(el('p', { class: 'muted small', text: 'データなし' }));
      return;
    }
    const cid = `c-${kind}-${part}-${safeId}`;
    cell.replaceChildren(el('div', { class: 'chart-wrap' }, el('canvas', { id: cid })));
    ch.pie(cid, labels, values);
    return;
  }

  if (part === 'top') {
    cell.replaceChildren(miniTable(LIST_LABEL[other], data.others.slice(0, TOP_ROWS), yen));
    return;
  }

  if (part === 'products') {
    cell.replaceChildren(miniTable('商品', data.products.slice(0, TOP_ROWS), yen));
    return;
  }

  if (part === 'line') {
    const cid = `c-${kind}-line-${safeId}`;
    const pts = rollup(data.daily, state.list[kind].grain);
    cell.replaceChildren(el('div', { class: 'chart-wrap' }, el('canvas', { id: cid })));
    ch.line(cid, pts.map((r) => r.label), [
      { label: '売上', data: pts.map((r) => r.sales), fill: true },
    ], { money: true });
    return;
  }

  if (part === 'matrix') {
    const table = el('table', { class: 'matrix' });
    const wrap = el('div', { class: 'matrix-wrap' }, table);
    cell.replaceChildren(wrap);
    renderDailyMatrix(table, data.daily, wrap);
  }
}

// ---- ランキング ----------------------------------------------------------
//
// 期間まるごとの順位を、アフィリエイター / 広告主 / 商品 の3枚に分けて出す。
// もう1枚「日別」があり、日付を横に並べてその日ごとの順位を見られる。
// 行の ▸ を押すと、その相手の内訳（広告主なら中のアフィリエイター）が開く。

const RANK_PARTS = [
  { key: 'affiliate',  label: 'アフィリエイター' },
  { key: 'advertiser', label: '広告主' },
  { key: 'product',    label: '商品' },
  { key: 'daily',      label: '日別' },
];

const RANK_ROWS = 30;        // 1枚に出す順位の数
const RANK_DAY_SERIES = 12;  // 日別で追いかける相手の数
const RANK_DAY_TOP = 5;      // 日別で1日あたりに出す順位の数

const LS_RANK_PARTS = 'afd.parts.rank';

function rankHiddenParts() {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_RANK_PARTS) || '[]');
    return new Set(Array.isArray(raw) ? raw : []);
  } catch {
    return new Set();
  }
}

function buildRankPartButtons() {
  const off = rankHiddenParts();
  $('#rank-parts').replaceChildren(...RANK_PARTS.map((p) => el('button', {
    type: 'button',
    class: `chip${off.has(p.key) ? '' : ' is-active'}`,
    text: p.label,
    title: off.has(p.key) ? 'クリックで表示する' : 'クリックで隠す',
    onclick: () => {
      const set = rankHiddenParts();
      if (set.has(p.key)) set.delete(p.key);
      else set.add(p.key);
      localStorage.setItem(LS_RANK_PARTS, JSON.stringify([...set]));
      render();
    },
  })));
}

async function renderRank() {
  const r = state.rank;
  const f = state.filter;
  const metric = CMP_METRIC[r.metric];
  buildRankPartButtons();

  const off = rankHiddenParts();
  const parts = RANK_PARTS.filter((p) => !off.has(p.key));
  const box = $('#rank-blocks');

  if (!parts.length) {
    box.replaceChildren(el('p', { class: 'empty', text: '表示するものを選んでください' }));
    return;
  }

  // まとめて取りに行く（1枚ずつ待つと画面が段々に出て落ち着かない）
  const dims = parts.filter((p) => p.key !== 'daily').map((p) => p.key);
  const jobs = dims.map((d) => api.dimension(f, d, RANK_ROWS, null));
  if (parts.some((p) => p.key === 'daily')) {
    jobs.push(api.compare(f, r.dayDim, null, 'day', RANK_DAY_SERIES));
  }
  const results = await Promise.all(jobs);

  r.data = {};
  dims.forEach((d, i) => { r.data[d] = results[i]; });
  const dayRows = parts.some((p) => p.key === 'daily') ? results[dims.length] : null;

  // 期間まるごとの枠を上の段に横並びにし、日別を下の段いっぱいに置く。
  // 出している枚数ぶんだけ列を作る（auto-fit だと空き列ができてしまう）。
  const across = Math.max(parts.filter((p) => p.key !== 'daily').length, 1);
  box.style.gridTemplateColumns = `repeat(${across}, minmax(0, 1fr))`;

  box.replaceChildren(...parts.map((p) => (p.key === 'daily'
    ? rankDayWidget(dayRows, metric)
    : rankWidget(p, r.data[p.key] || [], metric))));
}

// 指標の列に続けて出す参考列。指標と同じものは出さない（同じ数字が2列並ぶので）。
function rankExtras(metric) {
  return [
    { key: 'conversions', label: '成果', fmt: num },
    { key: 'sales', label: '売上', fmt: yen },
  ].filter((c) => c.key !== metric.key);
}

// 期間まるごとの順位1枚
function rankWidget(part, rows, metric) {
  const sorted = rows.slice()
    .sort((a, b) => Number(b[metric.key] || 0) - Number(a[metric.key] || 0))
    .slice(0, RANK_ROWS);

  const body = el('tbody');
  sorted.forEach((row, i) => body.append(...rankRow(part.key, row, i + 1, metric)));

  if (!sorted.length) {
    body.append(el('tr', {}, el('td', {
      class: 'empty', colspan: 3 + rankExtras(metric).length, text: 'データがありません',
    })));
  }

  return el('section', { class: 'rank-card' },
    el('header', { class: 'eb-head' },
      el('h3', { text: `${part.label} ${metric.label}ランキング` }),
      el('span', { class: 'eb-stats', text: `${state.filter.from} 〜 ${state.filter.to}` })),
    el('div', { class: 'table-wrap' },
      el('table', { class: 'rank-table' },
        el('thead', {}, el('tr', {},
          el('th', { class: 'num', text: '順位' }),
          el('th', { text: part.label }),
          el('th', { class: 'num', text: metric.label }),
          ...rankExtras(metric).map((c) => el('th', { class: 'num', text: c.label })))),
        body)));
}

// 1行ぶん（＋開いたときの内訳行）
function rankRow(dimKey, row, rank, metric) {
  const value = Number(row[metric.key] || 0);
  const openKey = `${dimKey}|${row.label}`;
  const isOpen = state.rank.open.has(openKey);
  // 商品は「その中の誰か」を出す手立てがないので、開くボタンを付けない
  const expandable = dimKey === 'advertiser' || dimKey === 'affiliate';

  const name = el('td', { class: 'trunc', title: row.label });
  if (expandable) {
    name.append(el('button', {
      type: 'button',
      class: `disclose${isOpen ? ' is-open' : ''}`,
      title: isOpen ? '内訳を閉じる' : '内訳を開く',
      'aria-expanded': String(isOpen),
      text: '▸',
      onclick: () => {
        if (isOpen) state.rank.open.delete(openKey);
        else state.rank.open.add(openKey);
        render();
      },
    }));
  }
  name.append(el('span', { text: row.label }));

  const extras = rankExtras(metric);
  const tr = el('tr', { class: isOpen ? 'is-open' : null },
    el('td', { class: 'num rank-no', text: String(rank) }),
    name,
    el('td', { class: 'num strong', text: fmtMetric(value, metric) }),
    ...extras.map((c) => el('td', { class: 'num', text: c.fmt(row[c.key]) })));

  if (!isOpen) return [tr];

  const detail = el('tr', { class: 'rank-detail' },
    el('td', { colspan: 3 + extras.length },
      el('div', { class: 'rank-detail-body', text: '読み込み中…' })));
  loadRankBreakdown(dimKey, row.label, detail.querySelector('.rank-detail-body'), metric);
  return [tr, detail];
}

// 開いた内訳は覚えておく（別のところを触るたびに取り直さないように）
const rankBreakCache = new Map();

async function loadRankBreakdown(dimKey, id, host, metric) {
  const other = OTHER[dimKey];
  const scope = dimKey === 'advertiser' ? { advertisers: [id] } : { affiliates: [id] };
  const f = state.filter;
  const ck = [dimKey, id, f.from, f.to, (f.statuses || ['*']).join(',')].join('|');
  try {
    let rows = rankBreakCache.get(ck);
    if (!rows) {
      rows = await api.dimension(f, other, 12, null, scope);
      rankBreakCache.set(ck, rows);
    }
    if (!host.isConnected) return;
    const sorted = rows.slice()
      .sort((a, b) => Number(b[metric.key] || 0) - Number(a[metric.key] || 0));
    if (!sorted.length) {
      host.replaceChildren(el('p', { class: 'muted small', text: '内訳がありません' }));
      return;
    }
    const total = sorted.reduce((a, x) => a + Number(x[metric.key] || 0), 0);
    host.replaceChildren(
      el('span', { class: 'muted small', text: `${LIST_LABEL[other]}別の内訳` }),
      el('ul', { class: 'rank-break' }, ...sorted.map((x, i) => {
        const v = Number(x[metric.key] || 0);
        const share = total ? ((v / total) * 100).toFixed(1) : '0.0';
        const bar = el('i');
        bar.style.width = `${total ? (v / total) * 100 : 0}%`;
        return el('li', {},
          el('span', { class: 'no', text: `${i + 1}` }),
          el('span', { class: 'nm trunc', text: x.label, title: x.label }),
          el('span', { class: 'bar' }, bar),
          el('span', { class: 'vl', text: `${metric.money ? yen(v) : num(v)}（${share}%）` }));
      })));
  } catch (e) {
    if (host.isConnected) {
      host.replaceChildren(el('p', { class: 'muted small', text: '読み込めませんでした: ' + e.message }));
    }
  }
}

// 日別ランキング。日付を横に並べて、その下にその日の順位を積む。
function rankDayWidget(rows, metric) {
  const buckets = [...new Set((rows || []).map((x) => String(x.bucket)))].sort();

  // 日 → その日の順位（上位だけ）
  const byDay = new Map(buckets.map((b) => [b, []]));
  for (const x of rows || []) {
    byDay.get(String(x.bucket))?.push({ label: x.series, value: Number(x[metric.key] || 0) });
  }
  for (const list of byDay.values()) list.sort((a, b) => b.value - a.value);

  const dimSeg = el('div', { class: 'seg' },
    ...[['affiliate', 'アフィリエイター'], ['advertiser', '広告主']].map(([v, label]) =>
      el('button', {
        type: 'button',
        class: `chip${state.rank.dayDim === v ? ' is-active' : ''}`,
        text: label,
        onclick: () => { state.rank.dayDim = v; render(); },
      })));

  const head = el('tr', {}, el('th', { class: 'rowhead', text: '順位' }));
  const bodyRows = Array.from({ length: RANK_DAY_TOP }, (_, i) =>
    el('tr', {}, el('th', { class: 'rowhead', text: `${i + 1}位` })));

  for (const b of buckets) {
    const d = new Date(b + 'T00:00:00');
    const kind = dayKind(b, d.getDay());
    const cls = kind ? `is-${kind}` : null;
    head.append(el('th', { class: cls, title: holidayName(b) ? `${b} ${holidayName(b)}` : b },
      b.slice(5).replace('-', '/'),
      el('span', { class: 'wd', text: holidayName(b) ? '祝' : WEEKDAY[d.getDay()] })));

    const list = byDay.get(b) || [];
    for (let i = 0; i < RANK_DAY_TOP; i += 1) {
      const hit = list[i];
      bodyRows[i].append(el('td', { class: cls },
        hit && hit.value > 0
          ? el('span', { class: 'day-hit' },
            el('span', { class: 'nm trunc', text: hit.label, title: hit.label }),
            el('span', { class: 'vl', text: metric.money ? compact(hit.value) : num(hit.value) }))
          : el('span', { class: 'muted', text: '—' })));
    }
  }

  const table = el('table', { class: 'matrix rank-day' },
    el('thead', {}, head), el('tbody', {}, ...bodyRows));
  const wrap = el('div', { class: 'matrix-wrap' }, table);

  // 直近が見えている状態で開きたいので右端に寄せる
  requestAnimationFrame(() => { wrap.scrollLeft = wrap.scrollWidth; });

  return el('section', { class: 'rank-card is-daily' },
    el('header', { class: 'eb-head' },
      el('h3', { text: `日別 ${metric.label}ランキング` }),
      dimSeg,
      el('span', { class: 'eb-stats', text: `上位${RANK_DAY_SERIES}件の中での順位` })),
    buckets.length ? wrap : el('p', { class: 'empty', text: 'データがありません' }));
}

// ---- 比較 ----------------------------------------------------------------
//
// 2つの枠に別々の相手を入れて、同じ見方で並べる画面。
// 枠ごとに「軸（アフィリエイター/広告主）」と「相手」を選ぶ。
// 見方は 線グラフ / 円グラフ / ランキング、指標は売上ほか。

const VS_PIE = 10;
const VS_RANK_ROWS = 12;

async function renderVersus() {
  const v = state.versus;
  const metric = CMP_METRIC[v.metric];
  const panes = $('#vs-panes');
  panes.classList.toggle('is-col', v.layout === 'col');

  // 枠ごとの候補（軸が同じなら1回で済ませる）
  const need = [...new Set(v.panes.map((p) => p.dim))];
  const lists = {};
  await Promise.all(need.map(async (d) => { lists[d] = await api.dimension(state.filter, d, 300); }));

  // 何も選んでいない枠は、売上の上位から1件だけ入れておく（空の画面だと何も分からない）
  v.panes.forEach((p, i) => {
    if (!p.picked.length && lists[p.dim]?.length) p.picked = [lists[p.dim][i]?.label || lists[p.dim][0].label];
  });

  const data = await Promise.all(v.panes.map((p) => loadVersusPane(p, v)));
  v.panes.forEach((p, i) => { p.data = data[i]; });

  // グラフは canvas を DOM に入れてから描く
  // （非表示の器で初期化すると Chart.js が 0x0 のまま固まる）
  const draws = [];
  const built = v.panes.map((p, i) => versusPane(i, p, lists[p.dim] || [], v, metric, draws));
  panes.replaceChildren(...built);
  for (const d of draws) d();
}

async function loadVersusPane(pane, v) {
  if (!pane.picked.length) return null;
  const scope = pane.dim === 'advertiser'
    ? { advertisers: pane.picked } : { affiliates: pane.picked };
  const other = OTHER[pane.dim];
  const [ts, breakdown] = await Promise.all([
    api.timeseries(state.filter, 'day', scope),
    api.dimension(state.filter, other, 60, null, scope),
  ]);
  return { ts, breakdown, daily: dailyRows(ts, state.filter.from, state.filter.to) };
}

function versusPane(index, pane, candidates, v, metric, draws) {
  const label = String.fromCharCode(65 + index);          // A / B
  const other = OTHER[pane.dim];
  const safe = `vs${index}`;

  // 見出し: 枠の名前 + 軸の切り替え + 相手を選ぶドロップダウン
  const dimSeg = el('div', { class: 'seg' },
    ...[['affiliate', 'アフィリエイター'], ['advertiser', '広告主']].map(([val, text]) =>
      el('button', {
        type: 'button',
        class: `chip${pane.dim === val ? ' is-active' : ''}`,
        text,
        onclick: () => { pane.dim = val; pane.picked = []; render(); },
      })));

  const head = el('header', { class: 'eb-head' },
    el('h3', {}, el('span', { class: 'vs-tag', text: label }), pickedLabel(pane)),
    dimSeg,
    versusPicker(pane, candidates));

  const body = el('div', { class: 'vs-body' });
  if (!pane.data) {
    body.append(el('p', { class: 'empty', text: '相手を選んでください' }));
    return el('section', { class: 'vs-pane' }, head, body);
  }

  const totals = paneTotals(pane.data, metric);
  head.append(el('span', { class: 'eb-stats', text: `${metric.label} ${fmtMetric(totals, metric)}` }));

  if (v.mode === 'line') {
    const pts = rollup(pane.data.daily, v.grain);
    const cid = `c-${safe}-line`;
    body.append(el('div', { class: 'chart-wrap' }, el('canvas', { id: cid })));
    draws.push(() => ch.line(cid, pts.map((r) => r.label), [
      { label: `${label}: ${metric.label}`, data: pts.map((r) => metricOfRow(r, metric)), fill: true },
    ], { money: metric.money }));
  } else if (v.mode === 'pie') {
    const { labels, values } = pieParts(pane.data.breakdown, metric.key, VS_PIE);
    const cid = `c-${safe}-pie`;
    body.append(el('div', { class: 'chart-wrap' }, el('canvas', { id: cid })));
    draws.push(() => ch.pie(cid, labels, values));
  } else {
    const rows = pane.data.breakdown.slice()
      .sort((a, b) => Number(b[metric.key] || 0) - Number(a[metric.key] || 0))
      .slice(0, VS_RANK_ROWS);
    body.append(el('div', { class: 'table-wrap' }, el('table', { class: 'rank-table' },
      el('thead', {}, el('tr', {},
        el('th', { class: 'num', text: '順位' }),
        el('th', { text: LIST_LABEL[other] }),
        el('th', { class: 'num', text: metric.label }))),
      el('tbody', {}, ...(rows.length
        ? rows.map((r, i) => el('tr', {},
          el('td', { class: 'num rank-no', text: String(i + 1) }),
          el('td', { class: 'trunc', text: r.label, title: r.label }),
          el('td', { class: 'num strong', text: fmtMetric(Number(r[metric.key] || 0), metric) })))
        : [el('tr', {}, el('td', { class: 'empty', colspan: 3, text: 'データがありません' }))])))));
  }

  return el('section', { class: 'vs-pane' }, head, body);
}

function pickedLabel(pane) {
  if (!pane.picked.length) return '未選択';
  return pane.picked.length === 1 ? pane.picked[0] : `${pane.picked.length}件`;
}

// 枠ごとの相手選び。フィルタ帯のドロップダウンと同じ作り。
function versusPicker(pane, candidates) {
  const dd = el('details', { class: 'dropdown vs-pick' });
  const summary = el('summary', { text: '相手を選ぶ' });
  const menu = el('div', { class: 'menu' });

  const search = el('input', { type: 'search', class: 'menu-search', placeholder: '検索' });
  const rowsHost = el('div', { class: 'vs-pick-list' });

  const draw = () => {
    const q = search.value.trim().toLowerCase();
    const list = q
      ? candidates.filter((r) => String(r.label).toLowerCase().includes(q))
      : candidates;
    rowsHost.replaceChildren(...list.slice(0, 300).map((r) => {
      const cb = el('input', { type: 'checkbox' });
      cb.checked = pane.picked.includes(r.label);
      cb.addEventListener('change', () => {
        const set = new Set(pane.picked);
        if (cb.checked) set.add(r.label);
        else set.delete(r.label);
        pane.picked = candidates.map((x) => x.label).filter((l) => set.has(l));
        render();
      });
      return el('label', { class: 'pick' }, cb,
        el('span', { class: 'name', text: r.label }),
        el('span', { class: 'cmp-sub', text: '¥' + compact(r.sales) }));
    }));
  };
  search.addEventListener('input', draw);
  search.addEventListener('keydown', (e) => { if (e.key === 'Enter') e.preventDefault(); });

  menu.append(el('div', { class: 'menu-tools' }, search,
    el('div', { class: 'seg' },
      el('button', {
        type: 'button', class: 'chip', text: 'すべて',
        onclick: () => { pane.picked = candidates.map((x) => x.label); render(); },
      }),
      el('button', {
        type: 'button', class: 'chip', text: '全員外す',
        onclick: () => { pane.picked = []; render(); },
      }))), rowsHost);
  draw();

  dd.append(summary, menu);
  dd.addEventListener('toggle', () => { if (dd.open) placeMenu(dd); });
  return dd;
}

// 枠の合計。CVR だけは足せないので、成果とクリックから出し直す。
function paneTotals(data, metric) {
  const sum = (k) => data.ts.reduce((a, r) => a + Number(r[k] || 0), 0);
  if (metric.key === 'cvr') {
    const clicks = sum('clicks');
    return clicks ? (sum('conversions') / clicks) * 100 : null;
  }
  return sum(metric.key);
}

function metricOfRow(row, metric) {
  if (metric.key === 'cvr') return null;   // 比率は日別にまとめ直せない
  return Number(row[metric.key] ?? row.sales ?? 0);
}

function fmtMetric(v, metric) {
  if (v === null || v === undefined) return '—';
  if (metric.key === 'cvr') return pct(v);
  return metric.money ? yen(v) : num(v);
}

// ---- 成果明細 ----------------------------------------------------------

async function renderDetail() {
  const d = state.detail;
  const rows = await api.conversions(state.filter, d.search, d.size, d.page * d.size);

  // 何ページも送ったあとで期間や絞り込みを変えると、件数が減って
  // 「ページの先」を見に行ったままになり、表が丸ごと空になる。
  // その場合は黙って1ページ目に戻す。
  if (!rows.length && d.page > 0) {
    d.page = 0;
    return renderDetail();
  }

  d.rows = rows;
  d.total = rows.length ? Number(rows[0].total_count) : 0;

  // 0件のときは、条件のどこが効いているのかまで出す。
  // （クリックしか無い月を選んでいる、が一番よくある）
  if (!rows.length) {
    showDetailEmpty(d.search
      ? `「${d.search}」に当てはまる成果がありません`
      : 'この条件に当てはまる成果がありません');
    return;
  }

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

// 成果明細は画面に出ている100件だけでなく、条件に合う全件を出す。
// 1回で取ると重いので、ページ送りしながら集める。
const CSV_PAGE = 1000;

async function fetchAllConversions() {
  const d = state.detail;
  const out = [];
  let total = Infinity;

  while (out.length < total) {
    const rows = await api.conversions(state.filter, d.search, CSV_PAGE, out.length);
    if (!rows.length) break;
    total = Number(rows[0].total_count) || rows.length;
    out.push(...rows);
    if (rows.length < CSV_PAGE) break;
    if (out.length < total) toast(`CSVを作成中… ${num(out.length)} / ${num(total)} 件`);
  }
  return out;
}

async function exportCsv(kind) {
  const stamp = `${state.filter.from}_${state.filter.to}`;
  if (kind === 'summary') {
    downloadCsv(`日別売上_${stamp}.csv`,
      ['日付', '売上', 'アフィリエイター報酬額', `想定マネートラック報酬(${mtRate()}%)`, '成果件数'],
      (state.summaryRows || []).map((r) => [r.bucket, r.sales, r.reward, r.mt, r.conversions]));
  } else if (kind === 'compare') {
    // グラフに出ている内訳をそのまま（系列 × 期間）出す
    downloadCsv(`内訳_${stamp}.csv`,
      ['系列', '期間', 'クリック', '成果', 'CVR(%)', '売上', '報酬額'],
      (state.compare.rows || []).map((r) =>
        [r.series, r.bucket, r.clicks, r.conversions, r.cvr, r.sales, r.reward]));
  } else if (kind === 'versus') {
    // 2つの枠を、枠ごとの内訳として並べて出す
    const v = state.versus;
    const rows = [];
    v.panes.forEach((p, i) => {
      const tag = String.fromCharCode(65 + i);
      for (const b of p.data?.breakdown || []) {
        rows.push([tag, p.picked.join(' / '), b.label, b.conversions, b.sales, b.reward, b.clicks]);
      }
    });
    downloadCsv(`比較_${stamp}.csv`,
      ['枠', '選んだ相手', '内訳', '成果件数', '売上', '報酬額', 'クリック'], rows);
  } else if (kind === 'advertiser' || kind === 'affiliate') {
    downloadCsv(`${LIST_LABEL[kind]}別_${stamp}.csv`,
      [LIST_LABEL[kind], '成果件数', '売上', '報酬額', 'クリック', 'CVR(%)'],
      (state.list[kind].rows || []).map((r) =>
        [r.label, r.conversions, r.sales, r.reward, r.clicks, r.cvr]));
  } else if (kind === 'rank') {
    // 出ているランキングを、種類ごとに1つのファイルへまとめる
    const r = state.rank;
    const metric = CMP_METRIC[r.metric];
    const rows = [];
    for (const p of RANK_PARTS) {
      const src = r.data?.[p.key];
      if (!src) continue;
      src.slice()
        .sort((a, b) => Number(b[metric.key] || 0) - Number(a[metric.key] || 0))
        .forEach((x, i) => rows.push([p.label, i + 1, x.label, x.conversions, x.sales, x.reward, x.clicks]));
    }
    downloadCsv(`ランキング_${metric.label}_${stamp}.csv`,
      ['種類', '順位', '名前', '成果件数', '売上', '報酬額', 'クリック'], rows);
  } else if (kind === 'conversions') {
    // 画面は100件ずつだが、CSV は条件に合う全件を出す
    busy(true);
    try {
      const all = await fetchAllConversions();
      if (!all.length) { toast('出力する成果がありません'); return; }
      downloadCsv(`成果明細_${stamp}.csv`,
        ['発生日時', 'ステータス', '広告主', 'アフィリエイター', '商品名', '広告名', 'キャンペーン',
          '数量', '販売価格', '報酬額', '報酬率', '支払い状況', 'デバイス', 'OS', '初回リファラ', '注文ID'],
        all.map((r) => [
          r.occurred_at, r.status, r.advertiser_id, r.affiliate_id, r.product_name, r.ad_name, r.campaign,
          r.qty, r.sale_price, r.reward, r.reward_rate, r.pay_status, r.device, r.os, r.first_referrer, r.order_id]));
      toast(`${num(all.length)} 件を出力しました`);
    } catch (e) {
      toast('CSVを作れませんでした: ' + e.message);
    } finally {
      busy(false);
    }
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
