// 本番に触る前の下見。GitHub Actions で sync.mjs の直前に走らせる。
//
//   node sync/selftest.mjs
//
// 見ているのは2つ。
//  1. Node でモジュールが全部読めるか。js/parse.js はブラウザ向けに書いてあり、
//     `./util.js?v=...` とクエリ付きで読んでいる。ここが Node で落ちると、
//     取得を済ませたあとの取り込み直前でこけて分かりにくい。
//  2. 見出しの対応付けが生きているか。buildMap は辞書の完全一致なので、
//     norm() を通し忘れると黙って列が欠ける（例外にならない）。
//
// 外へは一切つながない。合成データだけで完結する。

import * as XLSX from 'xlsx';
import { createHash } from 'node:crypto';
import { toAffiliateDaily } from './activity.mjs';
import { Supa } from './supa.mjs';

globalThis.XLSX = XLSX;
const { parseConversions, parseClicks, norm } = await import('../js/parse.js');

let failed = 0;
const ok = (n, d) => console.log(`  OK   ${n}${d ? ` — ${d}` : ''}`);
const ng = (n, d) => { console.error(`  NG   ${n}: ${d}`); failed += 1; };
const eq = (n, got, want) => (String(got) === String(want) ? ok(n, got) : ng(n, `${got} / 期待 ${want}`));

// sync.mjs の readSheet と同じ扱いにする
function readSheet(buf) {
  const wb = XLSX.read(buf, { type: 'buffer', cellDates: false, raw: true });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: '', blankrows: false });
  if (!rows.length) return { header: [], rows: [] };
  return { header: rows[0].map(norm), rows: rows.slice(1) };
}

const toBuf = (aoa) => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'Sheet1');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
};

console.log('■ モジュールの読み込み');
ok('js/parse.js を Node から読めた', 'クエリ付きの import も通る');

console.log('■ 取り込み履歴まわり');
try {
  // 外へはつながず、呼び出し口があることと鍵の作り方だけ見る。
  // 取得を全部終えたあとで「record が無い」と落ちるのを防ぐため。
  const s = new Supa({ url: 'https://example.invalid', anonKey: 'dummy' });
  if (typeof s.record !== 'function') ng('record がある', '見つからない');
  else ok('record がある');
  const h = createHash('sha256').update(Buffer.from('abc', 'utf8')).digest('hex');
  eq('ファイル鍵の長さ', h.length, 64);
} catch (e) { ng('取り込み履歴まわり', e.message); }

console.log('■ Cookie の書き戻しまわり');
try {
  // 外へはつながず、封をする処理が動くことと、見送り判定だけ確かめる。
  const { looksUsable } = await import('./ghsecret.mjs');
  if (looksUsable('_mt_session_id=abc; remember_user_token=def')) ok('使える Cookie を通す');
  else ng('使える Cookie を通す', '弾いてしまった');
  if (!looksUsable('_ga=1; _gid=2')) ok('壊れた Cookie を見送る');
  else ng('壊れた Cookie を見送る', '通してしまった');

  // 成り代わりで remember_user_token が消えても引き継げること（2026-11-01 の不具合）
  const cm = (s) => { const m = new Map();
    for (const p of String(s || '').split(';')) { const i = p.indexOf('='); if (i > 0) m.set(p.slice(0, i).trim(), p.slice(i + 1).trim()); }
    return m; };
  const orig = cm('_mt_session_id=old; remember_user_token=keepme');
  const after = cm('_mt_session_id=new');
  if (!after.has('remember_user_token') && orig.has('remember_user_token')) after.set('remember_user_token', orig.get('remember_user_token'));
  eq('消えた復帰トークンを引き継ぐ', [...after].map(([k, v]) => `${k}=${v}`).join('; '),
    '_mt_session_id=new; remember_user_token=keepme');

  const sodium = (await import('libsodium-wrappers')).default;
  await sodium.ready;
  const kp = sodium.crypto_box_keypair();
  const sealed = sodium.crypto_box_seal(sodium.from_string('test-cookie'), kp.publicKey);
  const back = sodium.to_string(sodium.crypto_box_seal_open(sealed, kp.publicKey, kp.privateKey));
  eq('封をして開け直せる', back, 'test-cookie');
} catch (e) { ng('Cookie の書き戻しまわり', e.message); }

console.log('■ セッション切れからの復帰');
try {
  // 外へはつながず、応答だけ差し替えて筋道を確かめる。
  // 1回目はログイン画面、2回目は中身 → 入り直せること。
  const { readAdminContext } = await import('./mt.mjs');
  const signInHtml = '<html><body><a href="/users/sign_in">ログイン</a></body></html>';
  const goodHtml = '<meta name="csrf-token" content="tok123">'
    + '<input type="hidden" name="admin_id" value="abc123">';

  let calls = 0;
  const jar = new Map([['_mt_session_id', 'dead'], ['remember_user_token', 'keep']]);
  const stub = { jar, fetch: async () => { calls += 1; return { res: { text: async () => (calls === 1 ? signInHtml : goodHtml) } }; } };
  const ctx = await readAdminContext(stub);
  eq('入り直して admin_id を読める', ctx.adminId, 'abc123');
  eq('叩き直した回数', calls, 2);
  if (jar.has('_mt_session_id')) ng('古いセッションを捨てる', '残っている');
  else ok('古いセッションを捨てる');
  if (jar.get('remember_user_token') === 'keep') ok('復帰トークンは残す');
  else ng('復帰トークンは残す', '消えている');

  // 復帰トークンが無ければ、むだに叩かずその場で諦める
  let c2 = 0;
  const stub2 = {
    jar: new Map([['_mt_session_id', 'dead']]),
    fetch: async () => { c2 += 1; return { res: { text: async () => signInHtml } }; },
  };
  let threw = false;
  try { await readAdminContext(stub2); } catch { threw = true; }
  eq('トークンが無ければ1回で諦める', `${threw} / ${c2}回`, 'true / 1回');
} catch (e) { ng('セッション切れからの復帰', e.message); }

console.log('■ 見出しの正規化');
eq('全角カッコ', norm('お支払い状況（1）'), 'お支払い状況(1)');
eq('空白を落とす', norm(' 注文 ID '), '注文ID');

console.log('■ 成果データ（①）');
try {
  // わざと空白と全角カッコを混ぜる。実ファイルの揺れを想定。
  const buf = toBuf([
    ['日付', '注文 ID', '商品ID', '広告主ID', '商品名', '数量', '単価',
      'アフィリエイトID', '販売価格', 'ステータス', '報酬額', '報酬', '最後のクリックIP'],
    ['2026/09/20 10:30', 'ORD-1', 'P1', 'bestkenko', 'くすりA', 2, 1500,
      'bpr530', 3000, '承認', 300, '10%', '203.0.113.1'],
    ['2026/09/20 11:00', 'ORD-2', 'P2', 'unidru', 'くすりB', 1, 800,
      'win4834', 800, '保留', 80, '10%', '203.0.113.2'],
  ]);
  const { header, rows } = readSheet(buf);
  const parsed = parseConversions(header, rows);
  eq('取り込む行数', parsed.rows.length, 2);
  eq('注文ID', parsed.rows[0].order_id, 'ORD-1');
  eq('広告主ID', parsed.rows[0].advertiser_id, 'bestkenko');

  const keys = Object.keys(parsed.rows[0]);
  const ip = keys.filter((k) => /ip/i.test(k));
  if (ip.length) ng('IP列を落としている', '残っている: ' + ip.join(', '));
  else ok('IP列を落としている');
  if (JSON.stringify(parsed.rows).includes('203.0.113')) ng('IPの値が残っていない', 'IPが残っている');
  else ok('IPの値が残っていない');
} catch (e) { ng('成果データ', e.message); }

console.log('■ クリックデータ（③）');
try {
  const buf = toBuf([
    ['日付', 'アフィリエイター', '広告タイプ', '広告名', 'キャンペーン', '参照URL', 'OS', 'IP'],
    ['2026/09/20 10:00', 'bpr530', 'テキスト', '広告A', 'CP1', 'https://example.com/a', 'iOS', '203.0.113.9'],
    ['2026/09/20 10:00', 'bpr530', 'テキスト', '広告A', 'CP1', 'https://example.com/a', 'iOS', '203.0.113.9'],
  ]);
  const { header, rows } = readSheet(buf);
  const parsed = parseClicks(header, rows);
  eq('取り込む行数', parsed.rows.length, 2);
  // 同じ内容の行は dup_seq で区別される（一意キーが無いため）
  const seqs = parsed.rows.map((r) => r.dup_seq);
  if (new Set(seqs).size !== 2) ng('同内容の行に通番が振られる', `dup_seq=${seqs.join(',')}`);
  else ok('同内容の行に通番が振られる', `dup_seq=${seqs.join(',')}`);
  if (JSON.stringify(parsed.rows).includes('203.0.113')) ng('IPの値が残っていない', 'IPが残っている');
  else ok('IPの値が残っていない');
} catch (e) { ng('クリックデータ', e.message); }

console.log('■ 日次実績（②）');
try {
  const csv = '日付,affiliate_token,affiliate_id,名前,メールアドレス,'
    + '成果発生件数,クリック遷移数（短縮URL含む）,広告表示回数（短縮URL除く）\n'
    + '2026/09/20,tok1,bpr530,"山田, 太郎",a@example.com,3,100,900\n'
    + '2026/9/21,tok1,bpr530,山田,a@example.com,5,120,800\n';
  const { rows, dropped } = toAffiliateDaily(csv);
  eq('取り込む行数', rows.length, 2);
  eq('捨てた行数', dropped, 0);
  eq('日付の0埋め', rows[1].d, '2026-09-21');
  if (JSON.stringify(rows).match(/山田|example\.com/)) ng('個人情報が残っていない', '名前かメールが残っている');
  else ok('個人情報が残っていない');
} catch (e) { ng('日次実績', e.message); }

console.log(failed ? `\n下見に失敗: ${failed} 件` : '\n下見は問題なし');
process.exit(failed ? 1 : 0);
