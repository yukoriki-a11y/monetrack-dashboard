// 急上昇タブの実装（いったん外したもの／このファイルは読み込まれません）
//
// 戻し方は wip/surge/README.md を見てください。
// trendOf / rateText / trendNode は日別ランキングでも使うので js/app.js に残してあります。

// state に足していたもの:
//   surge: { dim: 'affiliate', window: 7, order: 'up', by: 'delta', rows: [] },

// wireViewControls に足していたもの:
//   segClick('#surge-dim', 'surgedim', (v) => { state.surge.dim = v; resetSort($('#t-surge')); });
//   segClick('#surge-window', 'surgewindow', (v) => { state.surge.window = Number(v); });
//   segClick('#surge-order', 'surgeorder', (v) => { state.surge.order = v; resetSort($('#t-surge')); });
//   segClick('#surge-by', 'surgeby', (v) => { state.surge.by = v; resetSort($('#t-surge')); });

// render() の振り分けに足していたもの:
//   else if (state.view === 'surge') await renderSurge();

// ---- 急上昇 --------------------------------------------------------------
//
// 期間の終わりから「直近◯日」と「その前の◯日」を切り出して、
// 売上がどれだけ動いたかで並べる。伸びた相手を見つけるための画面。

const SURGE_ROWS = 40;      // 表に出す件数
const SURGE_BARS = 15;      // グラフに出す本数
// 伸び率だけで並べると、100円が1,100円になった相手が1位になってしまう。
// 直近の売上がこの額に満たない相手は、伸び率順から外す。
const SURGE_FLOOR = 10000;

// 見出しから並べ替えたとき、上のボタンの見た目も合わせる
function syncSurgeChips() {
  const s = state.surge;
  $$('#surge-by .chip').forEach((c) => c.classList.toggle('is-active', c.dataset.surgeby === s.by));
  $$('#surge-order .chip').forEach((c) => c.classList.toggle('is-active', c.dataset.surgeorder === s.order));
}

async function renderSurge() {
  const s = state.surge;
  const f = state.filter;
  const win = s.window;

  // 期間の終わりを起点に、直近◯日 と その前の◯日
  const to = new Date(f.to);
  const recentFrom = addDays(to, -(win - 1));
  const prevTo = addDays(recentFrom, -1);
  const prevFrom = addDays(prevTo, -(win - 1));

  const range = (from, until) => ({ ...f, from: ymd(from), to: ymd(until) });
  const dimLabel = LIST_LABEL[s.dim];

  $('#surge-title').textContent =
    `${dimLabel}の${s.order === 'up' ? '急上昇' : '急降下'}`;

  // 2回に分けて取る（一度に投げると小さいインスタンスで詰まる）
  const recent = await api.dimension(range(recentFrom, to), s.dim, 500);
  const before = await api.dimension(range(prevFrom, prevTo), s.dim, 500);

  const prevBy = new Map(before.map((r) => [r.label, Number(r.sales || 0)]));
  const seen = new Set();
  const rows = [];

  const push = (label, now, prev) => {
    if (seen.has(label)) return;
    seen.add(label);
    const t = trendOf(now, prev);
    rows.push({
      label,
      recent: now,
      before: prev,
      delta: now - prev,
      rate: t.rate,
      trend: t,
      // 伸び率順のときは、金額が小さすぎる相手を後ろに回す
      rateSortable: now >= SURGE_FLOOR || prev >= SURGE_FLOOR,
    });
  };

  for (const r of recent) push(r.label, Number(r.sales || 0), prevBy.get(r.label) || 0);
  // 直近で消えた相手（前はあったのに今は0）も拾う
  for (const r of before) push(r.label, 0, Number(r.sales || 0));

  const dir = s.order === 'up' ? 1 : -1;
  rows.sort((a, b) => {
    if (s.by === 'rate') {
      // 金額が小さすぎるものは常に後ろ
      if (a.rateSortable !== b.rateSortable) return a.rateSortable ? -1 : 1;
      const ra = a.rate === null ? (a.recent > 0 ? Infinity : -Infinity) : a.rate;
      const rb = b.rate === null ? (b.recent > 0 ? Infinity : -Infinity) : b.rate;
      if (ra !== rb) return (rb - ra) * dir;
    }
    return (b.delta - a.delta) * dir;
  });

  // 「上がった相手」を見たいのに下がった相手が混ざると読みにくいので分ける
  const picked = rows
    .filter((r) => (s.order === 'up' ? r.delta > 0 : r.delta < 0))
    .slice(0, SURGE_ROWS);
  s.rows = picked;

  const label = (d) => ymd(d).slice(5).replace('-', '/');
  const spanText = `直近 ${label(recentFrom)}〜${label(to)} と `
    + `その前 ${label(prevFrom)}〜${label(prevTo)} をくらべています`;

  // 並べ替えは上のボタンと同じ仕組みでやる。
  // ここで表に任せてしまうと、順位の数字と行の並びがずれる。
  renderTable($('#t-surge'), [
    { key: 'rank', label: '順位', type: 'num', sortable: false },
    { key: 'label', label: dimLabel, type: 'text', sortable: false },
    { key: 'trendKey', label: '動き', sortable: false, cellClass: 'num',
      render: (r) => trendNode(r.trend) || el('span', { class: 'muted', text: '—' }) },
    { key: 'recent', label: `直近${win}日`, type: 'yen', sortable: false },
    { key: 'before', label: `前の${win}日`, type: 'yen', sortable: false },
    { key: 'delta', label: '増減額', type: 'yen', title: 'クリックで増減額順' },
    { key: 'rate', label: '伸び率', cellClass: 'num', title: 'クリックで伸び率順',
      render: (r) => (r.rate === null
        ? el('span', { class: 'muted', text: '新規' })
        : rateText(r.rate)) },
  ], picked.map((r, i) => ({ ...r, rank: i + 1 })), {
    empty: `${spanText}／該当なし`,
    externalSort: { key: s.by === 'rate' ? 'rate' : 'delta', dir: s.order === 'up' ? 'desc' : 'asc' },
    onSort: (col) => {
      const by = col.key === 'rate' ? 'rate' : 'delta';
      // 同じ列をもう一度押したら、急上昇 ↔ 急降下 を入れ替える
      if (s.by === by) s.order = s.order === 'up' ? 'down' : 'up';
      else s.by = by;
      syncSurgeChips();
      render();
    },
  });

  $('#surge-chart-title').textContent = `増減額 上位${Math.min(SURGE_BARS, picked.length)} — ${spanText}`;

  const top = picked.slice(0, SURGE_BARS);
  ch.bar('c-surge', top.map((r) => r.label), [
    { label: '増減額', data: top.map((r) => r.delta) },
  ], { horizontal: true, money: true });
}

