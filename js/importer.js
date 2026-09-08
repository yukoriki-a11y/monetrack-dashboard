// 取り込み画面のロジック。
//
// 1. ファイルのバイト列から SHA-256 を取り、同じファイルが既に取り込まれていないか確認
// 2. 見出しから種別（成果 / クリック）を判定
// 3. IP 列を落として整形
// 4. 500 行ずつに分けて RPC へ送る（行レベルでも重複は弾かれる）
// 5. 取り込み履歴に記録

import { $, el, num, fmtDateTime, chunk, nameNode } from './util.js?v=202609081924';
import { api } from './db.js?v=202609081924';
import { readFile, detectKind, parseConversions, parseClicks } from './parse.js?v=202609081924';
import { renderTable } from './table.js?v=202609081924';

const CHUNK = 500;

let logEl;

export function initImporter({ onImported }) {
  logEl = $('#import-log');
  const drop = $('#drop');
  const input = $('#file-input');

  input.addEventListener('change', () => {
    handleFiles(Array.from(input.files), onImported);
    input.value = '';
  });

  for (const type of ['dragenter', 'dragover']) {
    drop.addEventListener(type, (e) => { e.preventDefault(); drop.classList.add('over'); });
  }
  for (const type of ['dragleave', 'drop']) {
    drop.addEventListener(type, (e) => { e.preventDefault(); drop.classList.remove('over'); });
  }
  drop.addEventListener('drop', (e) => {
    const files = Array.from(e.dataTransfer?.files || []);
    if (files.length) handleFiles(files, onImported);
  });

  $('#imports-reload').addEventListener('click', loadImportHistory);
}

function log(kind, text) {
  const li = el('li', { class: kind, text });
  logEl.prepend(li);
  return li;
}

async function handleFiles(files, onImported) {
  let any = false;
  for (const file of files) {
    try {
      const done = await importOne(file);
      any = any || done;
    } catch (err) {
      log('ng', `${file.name}: ${err.message}`);
    }
  }
  await loadImportHistory();
  if (any) onImported?.();
}

async function importOne(file) {
  const line = log('', `${file.name} を読み込み中…`);

  const { fileHash, header, rows } = await readFile(file);

  const kind = detectKind(header);
  if (!kind) {
    line.className = 'ng';
    line.textContent = `${file.name}: 種別を判定できませんでした（見出し: ${header.slice(0, 6).join(', ')}…）`;
    return false;
  }

  // まったく同じファイルは 1 件としてしか扱わない
  const check = await api.importCheck(fileHash);
  if (check?.found) {
    line.className = 'warn';
    line.textContent =
      `${file.name}: 同じ内容のファイルが既に取り込まれています`
      + `（${fmtDateTime(check.imported_at)} / ${check.file_name} / ${num(check.row_count)}行）。スキップしました。`;
    return false;
  }

  const advertiserId = ($('#import-advertiser').value || 'bestkenko').trim();

  const parsed = kind === 'conversions'
    ? parseConversions(header, rows)
    : parseClicks(header, rows);

  if (!parsed.rows.length) {
    line.className = 'ng';
    line.textContent = `${file.name}: 取り込める行がありませんでした`;
    return false;
  }

  const label = kind === 'conversions' ? '成果データ' : 'クリックデータ';
  const parts = chunk(parsed.rows, CHUNK);
  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  let stayed = 0;

  for (const [i, part] of parts.entries()) {
    line.className = '';
    line.textContent =
      `${file.name}（${label}）: 送信中 ${num(Math.min((i + 1) * CHUNK, parsed.rows.length))} / ${num(parsed.rows.length)} 行`;
    const res = kind === 'conversions'
      ? await api.importConversionsChunk(part, file.name)
      : await api.importClicksChunk(part, file.name, advertiserId);
    inserted += res?.inserted ?? 0;
    updated  += res?.updated ?? 0;
    skipped  += res?.skipped ?? 0;
    stayed   += res?.stayed ?? 0;
  }

  await api.importRecord(
    file.name, fileHash, kind,
    kind === 'clicks' ? advertiserId : null,
    parsed.rows.length, inserted, updated, skipped);

  line.className = 'ok';
  const bits = [`新規 ${num(inserted)}件`];
  if (kind === 'conversions') {
    // 「更新」はステータスや金額が変わった行。「据え置き」は既存とまったく
    // 同じで書き込みをしなかった行（承認を保留に巻き戻さないための判定も含む）。
    bits.push(`更新 ${num(updated)}件`, `据え置き ${num(stayed)}件`);
  } else {
    bits.push(`重複スキップ ${num(skipped)}件`);
  }
  if (parsed.dropped) bits.push(`日付が読めず除外 ${num(parsed.dropped)}件`);
  line.textContent = `${file.name}（${label} ${num(parsed.rows.length)}行）: ${bits.join(' / ')}`;
  return true;
}

export async function loadImportHistory() {
  const table = $('#t-imports');
  if (!table) return;
  try {
    const rows = await api.imports(50);
    renderTable(table, [
      { key: 'imported_at', label: '取込日時', render: (r) => fmtDateTime(r.imported_at), cellClass: 'num' },
      { key: 'file_name', label: 'ファイル名' },
      { key: 'kind', label: '種別', render: (r) => (r.kind === 'conversions' ? '成果' : 'クリック'), cellClass: null },
      { key: 'advertiser_id', label: '広告主', render: (r) => nameNode('advertiser', r.advertiser_id) },
      { key: 'row_count', label: '行数', type: 'num' },
      { key: 'inserted_count', label: '新規', type: 'num' },
      { key: 'updated_count', label: '更新', type: 'num' },
      { key: 'skipped_count', label: '据え置き', type: 'num', title: '成果は既存と同じで書き込まなかった行、クリックは重複で弾いた行' },
    ], rows || [], { empty: 'まだ取り込み履歴がありません' });
  } catch (err) {
    renderTable(table, [{ key: 'e', label: 'エラー' }], [], { empty: err.message });
  }
}
