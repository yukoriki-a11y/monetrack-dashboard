// 毎日の取り込み本体。GitHub Actions から呼ばれる。
//
//   node sync/sync.mjs                  … 前日ぶん（日本時間）
//   node sync/sync.mjs --date 2026/09/20
//   node sync/sync.mjs --from 2026/09/01 --to 2026/09/07
//   node sync/sync.mjs --skip clicks    … 一部だけ動かす（transactions / activity / clicks）
//
// 仕組みと、なぜログインを自動化しないのかは docs/daily-sync.md に書いてある。

import * as XLSX from 'xlsx';
import { Session, readAdminContext, fetchTransactions, fetchAffiliateActivityCsv,
  withMerchant, fetchRawClick } from './mt.mjs';
import { Supa } from './supa.mjs';
import { toAffiliateDaily } from './activity.mjs';

// 画面と同じパーサを使い回す。ここを別に書くと、報酬額と報酬率の判別のような
// 実データで詰めた処理が二重管理になる。
globalThis.XLSX = XLSX;
const { parseConversions, parseClicks, norm } = await import('../js/parse.js');

// ③ を取りにいく広告主。slug は実際のURL、id は成り代わりに使う ObjectId。
const MERCHANTS = [
  { slug: 'bestkenko',     id: '56556f3f69702d6d5b500200' },
  { slug: 'kusuriexpress', id: '5655702c69702d6d5b590200' },
  { slug: 'petkusuri',     id: '56556c3569702d6d5b390200' },
  { slug: 'unidru',        id: '5a950f3900ada01f43af4694' },
  { slug: 'Jade2019',      id: '5d24a16b3f52cd5176edcec4' },
];

// ---- 小物 ----------------------------------------------------------------

const log = (...a) => console.log(...a);

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : null;
}

// 日本時間の「今日」。Actions は UTC で動くのでズレる。
function jstToday() {
  return new Date(Date.now() + 9 * 3600 * 1000);
}

const ymd = (d) => [
  d.getUTCFullYear(),
  String(d.getUTCMonth() + 1).padStart(2, '0'),
  String(d.getUTCDate()).padStart(2, '0'),
].join('/');

// xlsx のバイト列 → 見出し行と中身。
// 見出しは画面側の readFile と同じ norm() を通す。ここを trim だけで済ませると、
// 全角カッコや空白の入った見出しが辞書に当たらず、黙って列が欠ける。
function readSheet(buf) {
  const wb = XLSX.read(buf, { type: 'buffer', cellDates: false, raw: true });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: '', blankrows: false });
  if (!rows.length) return { header: [], rows: [] };
  return { header: rows[0].map(norm), rows: rows.slice(1) };
}

// ---- 本体 ----------------------------------------------------------------

async function main() {
  const skip = new Set(String(arg('skip') || '').split(',').filter(Boolean));

  const today = jstToday();
  const yesterday = new Date(today.getTime() - 24 * 3600 * 1000);
  const from = arg('from') || arg('date') || ymd(yesterday);
  const to = arg('to') || arg('date') || ymd(yesterday);

  log(`対象期間: ${from} 〜 ${to}（日本時間）`);

  const supa = new Supa({ url: process.env.SUPABASE_URL, anonKey: process.env.SUPABASE_ANON_KEY });
  await supa.signIn(process.env.SUPABASE_EMAIL, process.env.SUPABASE_PASSWORD);
  log('Supabase にログインしました');

  const s = new Session(process.env.MT_COOKIE);
  const ctx = await readAdminContext(s);
  log('マネートラックのセッションは有効です');

  const summary = [];

  // ① 成果データ
  if (!skip.has('transactions')) {
    const buf = await fetchTransactions(s, from, to);
    const { header, rows } = readSheet(buf);
    const parsed = parseConversions(header, rows);
    log(`① 成果: ${rows.length} 行を読み、${parsed.rows.length} 行を取り込みます`);
    const t = await supa.rpcChunked('import_conversions_chunk', parsed.rows,
      (part) => ({ p_rows: part, p_file_name: `auto:${from}_${to}` }),
      (done, all) => log(`   送信中 ${done}/${all}`));
    summary.push(`成果 新規${t.inserted || 0} / 更新${t.updated || 0} / 据置${t.stayed || 0}`);
  }

  // ② 全体のクリック・表示（当月ぶんを丸ごと入れ直す）
  if (!skip.has('activity')) {
    const y = Number(to.slice(0, 4));
    const m = Number(to.slice(5, 7));
    const csv = await fetchAffiliateActivityCsv(s, y, m);
    const { rows, dropped } = toAffiliateDaily(csv);
    log(`② 日次実績: ${rows.length} 行（${y}年${m}月ぶん${dropped ? ` / 捨てた ${dropped} 行` : ''}）`);
    const t = await supa.rpcChunked('import_affiliate_daily', rows,
      (part) => ({ p_rows: part }),
      (done, all) => log(`   送信中 ${done}/${all}`));
    summary.push(`日次実績 新規${t.inserted || 0} / 更新${t.updated || 0}`);
  }

  // ③ 広告主別クリック（成り代わり → 取得 → 復帰 を社ごとに）
  if (!skip.has('clicks')) {
    let ins = 0;
    let skipped = 0;
    for (const mch of MERCHANTS) {
      const buf = await withMerchant(s, ctx, mch, () => fetchRawClick(s, mch.slug, from, to));
      const { header, rows } = readSheet(buf);
      if (!rows.length) { log(`③ ${mch.slug}: 0 行`); continue; }
      const parsed = parseClicks(header, rows);
      const t = await supa.rpcChunked('import_clicks_chunk', parsed.rows,
        (part) => ({ p_rows: part, p_file_name: `auto:${mch.slug}:${from}_${to}`, p_advertiser_id: mch.slug }));
      ins += t.inserted || 0;
      skipped += t.skipped || 0;
      log(`③ ${mch.slug}: ${parsed.rows.length} 行 → 新規${t.inserted || 0} / 重複${t.skipped || 0}`);
    }
    summary.push(`クリック 新規${ins} / 重複${skipped}`);
  }

  log('\n完了: ' + summary.join(' / '));
}

main().catch((e) => {
  console.error('\n失敗しました: ' + (e && e.message ? e.message : e));
  if (e && e.stack) console.error(e.stack);
  process.exit(1);
});
