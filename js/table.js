// 並べ替えできるテーブルの描画。
//
// cols の各要素:
//   { key, label, type: 'text'|'num'|'yen'|'pct'|'node', width, render(row) }

import { el, num, yen, pct } from './util.js?v=202609080246';

const state = new WeakMap();

export function renderTable(tableEl, cols, rows, opts = {}) {
  if (!tableEl) return;

  const st = state.get(tableEl) || { sortKey: opts.sortKey ?? null, sortDir: opts.sortDir ?? 'desc' };
  state.set(tableEl, st);

  const sorted = st.sortKey ? sortRows(rows, st.sortKey, st.sortDir, cols) : rows.slice();

  tableEl.replaceChildren();

  // 見出し
  const thead = el('thead');
  const tr = el('tr');
  for (const c of cols) {
    const cls = [
      c.type === 'num' || c.type === 'yen' || c.type === 'pct' ? 'num' : '',
      st.sortKey === c.key ? (st.sortDir === 'asc' ? 'sorted-asc' : 'sorted-desc') : '',
    ].filter(Boolean).join(' ');
    const th = el('th', { class: cls || null, text: c.label, title: c.title || c.label });
    if (c.width) th.style.width = c.width;
    if (c.sortable !== false) {
      th.addEventListener('click', () => {
        if (st.sortKey === c.key) st.sortDir = st.sortDir === 'asc' ? 'desc' : 'asc';
        else { st.sortKey = c.key; st.sortDir = c.type === 'text' ? 'asc' : 'desc'; }
        renderTable(tableEl, cols, rows, opts);
      });
    } else {
      th.style.cursor = 'default';
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
