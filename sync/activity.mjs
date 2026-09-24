// ② 全体のクリック・表示（affiliate_activity_csv.csv）を、保存する形に直す。
//
// 外部の読み込みを持たないので、ブラウザからもそのまま読める。
// 検証は .local-test/synctest.html にある。
//
// 元CSVの見出し（実機で確認）:
//   日付, affiliate_token, affiliate_id, 名前, メールアドレス,
//   成果発生件数, クリック遷移数（短縮URL含む）, 広告表示回数（短縮URL除く）

// CSV を読む。名前に「,」や引用符が入っている行があるので、split では壊れる。
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  const s = String(text).replace(/^﻿/, '');

  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') { cell += '"'; i += 1; }   // "" は引用符1つ
        else quoted = false;
      } else cell += c;
      continue;
    }
    if (c === '"') { quoted = true; continue; }
    if (c === ',') { row.push(cell); cell = ''; continue; }
    if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; continue; }
    if (c === '\r') continue;
    cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

const toInt = (v) => {
  const n = Number(String(v ?? '').replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? Math.round(n) : 0;
};

// 「2026/08/31」「2026-8-3」どちらでも受ける
const toDate = (v) => {
  const m = String(v ?? '').trim().match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
  return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : null;
};

// ⚠ 「名前」「メールアドレス」は個人情報。ここで落として、DBまで持っていかない。
//    IPアドレスを捨てているのと同じ方針。
export function toAffiliateDaily(csvText) {
  const rows = parseCsv(csvText);
  if (rows.length < 2) return { rows: [], dropped: 0, header: [] };

  const header = rows[0].map((h) => String(h || '').trim());
  // 見出しは「クリック遷移数（短縮URL含む）」のように注釈が付くので、前方一致で探す
  const at = (...names) => header.findIndex((h) => names.some((n) => h.includes(n)));
  const idx = {
    d: at('日付'),
    token: at('affiliate_token'),
    aff: at('affiliate_id'),
    cv: at('成果発生件数'),
    click: at('クリック遷移数'),
    imp: at('広告表示回数'),
  };
  if (idx.d < 0 || idx.aff < 0) {
    throw new Error(`affiliate_activity_csv: 見出しが想定と違います: ${header.join(', ')}`);
  }

  const out = [];
  let dropped = 0;
  for (const r of rows.slice(1)) {
    const d = toDate(r[idx.d]);
    const affiliateId = String(r[idx.aff] ?? '').trim();
    if (!d || !affiliateId) { dropped += 1; continue; }
    out.push({
      d,
      affiliate_id: affiliateId,
      affiliate_token: idx.token >= 0 ? String(r[idx.token] ?? '').trim() : null,
      conversions: idx.cv >= 0 ? toInt(r[idx.cv]) : 0,
      clicks: idx.click >= 0 ? toInt(r[idx.click]) : 0,
      impressions: idx.imp >= 0 ? toInt(r[idx.imp]) : 0,
    });
  }
  return { rows: out, dropped, header };
}
