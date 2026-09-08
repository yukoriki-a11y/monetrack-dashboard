// 並べ替えできるテーブルの描画。
//
// cols の各要素:
//   { key, label, type: 'text'|'num'|'yen'|'pct'|'node', width, render(row) }

import { el, num, yen, pct } from './util.js?v=202609081436';

const state = new WeakMap();

export function renderTable(tableEl, cols, rows, opts = {}) {
  if (!tableEl) return;

  // externalSort を渡されたときは、並べ替えはサーバ側でやっている前提。
  // ここでは並べ替えず、見出しの ▲▼ を合わせるだけにする。
  const ext = opts.externalSort || null;
  const st = ext
    ? { sortKey: ext.key, sortDir: ext.dir }
    : (state.get(tableEl) || { sortKey: opts.sortKey ?? null, sortDir: opts.sortDir ?? 'desc' });
  if (!ext) state.set(tableEl, st);

  const sorted = (!ext && st.sortKey) ? sortRows(rows, st.sortKey, st.sortDir, cols) : rows.slice();

  tableEl.replaceChildren();

  // 見出し
  const thead = el('thead');
  const tr = el('tr');
  for (const c of cols) {
    const cls = [
      c.type === 'num' || c.type === 'yen' || c.type === 'pct' ? 'num' : '',
      st.sortKey === c.key ? (st.sortDir === 'asc' ? 'sorted-asc' : 'sorted-desc') : '',
    ].filter(Boolean).join(' ');
    const th = el('th', { class: cls || null, title: c.title || c.label },
      el('span', { class: 'th-label', text: c.label }));
    if (c.width) th.style.width = c.width;

    // 見出しに付ける追加の操作（列フィルタのボタンなど）
    const addon = opts.headerAddon?.(c, th);
    if (addon) th.append(addon);

    if (c.sortable === false) {
      th.style.cursor = 'default';
    } else if (ext) {
      // 並べ替えはサーバ側。呼び出し側に任せる。
      th.addEventListener('click', (e) => {
        if (e.target.closest('.th-tool')) return;   // フィルタのボタンは別扱い
        opts.onSort?.(c);
      });
    } else {
      th.addEventListener('click', () => {
        if (st.sortKey === c.key) st.sortDir = st.sortDir === 'asc' ? 'desc' : 'asc';
        else { st.sortKey = c.key; st.sortDir = c.type === 'text' ? 'asc' : 'desc'; }
        renderTable(tableEl, cols, rows, opts);
      });
    }
    tr.append(th);
  }
  thead.append(tr);
  tableEl.append(thead);

  // 本体
  const tbody = el('tbody');
  if (!sorted.length) {
    tbody.append(el('tr', {}, el('td', { class: 'empty', colspan: cols.length, text: opts.empty || 'データがありません' })));
  }
  for (const row of sorted) {
    const trb = el('tr', { class: opts.onRowClick ? 'clickable' : null });
    if (opts.onRowClick) trb.addEventListener('click', () => opts.onRowClick(row, trb, tbody));
    if (opts.rowKey && opts.selectedKey && row[opts.rowKey] === opts.selectedKey) trb.classList.add('is-selected');

    for (const c of cols) {
      const v = row[c.key];
      let td;
      if (c.render) {
        const content = c.render(row);
        td = el('td', { class: c.cellClass || null }, content ?? '');
      } else if (c.type === 'num') td = el('td', { class: 'num', text: num(v) });
      else if (c.type === 'yen') td = el('td', { class: 'num', text: yen(v) });
      else if (c.type === 'pct') td = el('td', { class: 'num', text: pct(v) });
      else td = el('td', { class: c.cellClass || 'trunc', text: v ?? '—', title: v ?? '' });
      trb.append(td);
    }
    tbody.append(trb);
  }
  tableEl.append(tbody);
}

function sortRows(rows, key, dir, cols) {
  const col = cols.find((c) => c.key === key);
  const numeric = col && col.type !== 'text' && col.type !== 'node';
  const sign = dir === 'asc' ? 1 : -1;
  return rows.slice().sort((a, b) => {
    const x = a[key];
    const y = b[key];
    if (x === null || x === undefined) return 1;
    if (y === null || y === undefined) return -1;
    if (numeric) return (Number(x) - Number(y)) * sign;
    return String(x).localeCompare(String(y), 'ja') * sign;
  });
}

export function resetSort(tableEl) {
  state.delete(tableEl);
}
