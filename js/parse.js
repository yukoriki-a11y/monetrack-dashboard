// xlsx / csv をブラウザ内で読み、DB に入れる形へ整える。
//
// 方針
//  * 列は「見出し名」で対応付ける（列順が変わっても壊れない）。
//  * IP の列は読み込み時点で捨てる。DB にも送らない。
//  * クリックデータには一意キーが無いので、内容から fingerprint を作り、
//    まったく同じ内容が複数行あるときは通番 (dup_seq) を振って区別する。

import { toIsoJst, toDateOnly, toNumber, clean, sha256Hex, hash128 } from './util.js?v=202609080159';

// ---- 見出し名のゆらぎ吸収 --------------------------------------------

// fingerprint を作るときの区切り文字。データに現れない制御文字を使う。
const SEP = String.fromCharCode(1);

const norm = (s) =>
  String(s ?? '')
    .replace(/\s+/g, '')
    .replace(/[（）]/g, (c) => (c === '（' ? '(' : ')'))
    .trim();

// 成果リストの見出し → 内部キー
const CV_HEADERS = {
  '日付': 'occurred_at',
  '注文ID': 'order_id',
  '商品ID': 'product_id',
  '広告主ID': 'advertiser_id',
  '商品名': 'product_name',
  '数量': 'qty',
  '単価': 'unit_price',
  'アフィリエイトID': 'affiliate_id',
  'お支払い状況1': 'pay_status1',
  '2ティアID': 'tier2_id',
  'お支払い状況2': 'pay_status2',
  '販売価格': 'sale_price',
  'キャンペーン名': 'campaign',
  '広告名': 'ad_name',
  'ステータス': 'status',
  '支払い状況': 'pay_status',
  '請求日': 'billed_on',
  '最後にクリックされた時間': 'last_click_at',
  '最後のリファラ': 'last_referrer',
  '最初のクリック発生時間': 'first_click_at',
  '最初のリファラ': 'first_referrer',
  'デバイス': 'device',
  'OS': 'os',
  'ステータス変更日': 'status_changed_at',
  'メモ': 'memo',
  // 捨てる列
  '最後のクリックIP': '__drop_ip',
  '最初のクリックIP': '__drop_ip',
  'IP': '__drop_ip',
};

// クリックデータの見出し → 内部キー
const CK_HEADERS = {
  '日付': 'clicked_at',
  'アフィリエイター': 'affiliate_id',
  'アフィリエイトID': 'affiliate_id',
  '広告タイプ': 'ad_type',
  '広告名': 'ad_name',
  'キャンペーン': 'campaign',
  'キャンペーン名': 'campaign',
  '参照URL': 'referrer',
  'リファラ': 'referrer',
  'OS': 'os',
  'IP': '__drop_ip',
};

// 「報酬 / 報酬額」「2ティア報酬 / 2ティア報酬」は元ファイルの見出しが
// 紛らわしい（金額の列と料率の列が隣り合い、名前が重複することもある）。
// 見出しではなく中身で判定する: '30%' や '¥100' のような表記なら料率側。
const REWARD_HEADER = /^報酬(額)?$/;
const TIER2_HEADER  = /^2ティア報酬(額)?$/;

// ---- ファイル読み込み --------------------------------------------------

export async function readFile(file) {
  const buf = await file.arrayBuffer();
  const fileHash = await sha256Hex(new Uint8Array(buf));
  const wb = XLSX.read(buf, { type: 'array', cellDates: false, raw: true });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) throw new Error('シートが見つかりません');

  // 見出しも含めて 2 次元配列で取り出す
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: '', blankrows: false });
  if (rows.length < 2) throw new Error('データ行がありません');

  return { fileHash, header: rows[0].map(norm), rows: rows.slice(1) };
}

export function detectKind(header) {
  const set = new Set(header);
  if (set.has('注文ID')) return 'conversions';
  if (set.has('参照URL') || set.has('アフィリエイター')) return 'clicks';
  if (set.has('アフィリエイトID') && set.has('商品名')) return 'conversions';
  return null;
}

// ---- 成果データ --------------------------------------------------------

export function parseConversions(header, rows) {
  const map = buildMap(header, CV_HEADERS);
  const rewardCols = header.map((h, i) => (REWARD_HEADER.test(h) ? i : -1)).filter((i) => i >= 0);
  const tier2Cols  = header.map((h, i) => (TIER2_HEADER.test(h)  ? i : -1)).filter((i) => i >= 0);

  if (map.order_id === undefined) throw new Error('「注文ID」列が見つかりません');

  const out = [];
  const seen = new Set();
  let dropped = 0;

  for (const row of rows) {
    const orderId = clean(row[map.order_id]);
    const occurredAt = toIsoJst(row[map.occurred_at]);
    if (!orderId || !occurredAt) { dropped += 1; continue; }
    // 同じファイル内に同じ注文IDが複数ある場合は後の行を採用する
    if (seen.has(orderId)) {
      const idx = out.findIndex((r) => r.order_id === orderId);
      if (idx >= 0) out.splice(idx, 1);
    }
    seen.add(orderId);

    const { amount: reward, rate: rewardRate } = splitAmountRate(row, rewardCols);
    const { amount: tier2Reward, rate: tier2Rate } = splitAmountRate(row, tier2Cols);

    out.push({
      order_id:          orderId,
      occurred_at:       occurredAt,
      product_id:        clean(row[map.product_id]),
      advertiser_id:     clean(row[map.advertiser_id]),
      product_name:      clean(row[map.product_name]),
      qty:               toNumber(row[map.qty]),
      unit_price:        toNumber(row[map.unit_price]),
      affiliate_id:      clean(row[map.affiliate_id]),
      reward:            reward,
      reward_rate:       rewardRate,
      pay_status1:       clean(row[map.pay_status1]),
      tier2_id:          nullIfDash(row[map.tier2_id]),
      tier2_reward:      tier2Reward,
      tier2_rate:        tier2Rate,
      pay_status2:       clean(row[map.pay_status2]),
      sale_price:        toNumber(row[map.sale_price]),
      campaign:          clean(row[map.campaign]),
      ad_name:           clean(row[map.ad_name]),
      status:            clean(row[map.status]),
      pay_status:        clean(row[map.pay_status]),
      billed_on:         toDateOnly(row[map.billed_on]),
      last_click_at:     toIsoJst(row[map.last_click_at]),
      last_referrer:     clean(row[map.last_referrer]),
      first_click_at:    toIsoJst(row[map.first_click_at]),
      first_referrer:    clean(row[map.first_referrer]),
      device:            clean(row[map.device]),
      os:                clean(row[map.os]),
      status_changed_at: toIsoJst(row[map.status_changed_at]),
      memo:              clean(row[map.memo]),
    });
  }

  return { rows: out, dropped };
}

// 隣接する「金額の列」と「料率の列」を中身で見分ける。
// '30%' / '¥1,190' のような表記があれば料率(表記のまま)、素の数値なら金額。
function splitAmountRate(row, cols) {
  let amount = null;
  let rate = null;
  for (const i of cols) {
    const raw = row[i];
    const s = raw === null || raw === undefined ? '' : String(raw).trim();
    if (!s || s === '-') continue;
    if (/[%％]/.test(s) || /^[¥￥]/.test(s)) {
      if (rate === null) rate = s;
    } else if (amount === null) {
      amount = toNumber(s);
    }
  }
  return { amount, rate };
}

function nullIfDash(v) {
  const s = clean(v);
  return s === '-' ? null : s;
}

// ---- クリックデータ ----------------------------------------------------

export function parseClicks(header, rows) {
  const map = buildMap(header, CK_HEADERS);
  if (map.clicked_at === undefined) throw new Error('「日付」列が見つかりません');

  const staged = [];
  let dropped = 0;

  for (const row of rows) {
    const clickedAt = toIsoJst(row[map.clicked_at]);
    if (!clickedAt) { dropped += 1; continue; }
    staged.push({
      clicked_at:   clickedAt,
      affiliate_id: clean(row[map.affiliate_id]),
      ad_type:      clean(row[map.ad_type]),
      ad_name:      clean(row[map.ad_name]),
      campaign:     clean(row[map.campaign]),
      referrer:     clean(row[map.referrer]),
      os:           clean(row[map.os]),
    });
  }

  // 内容から fingerprint を作る。IP を使わないぶん、まったく同じ内容の行が
  // 複数あり得るので通番を振って区別する（件数が減らないようにするため）。
  const counter = new Map();
  const out = [];
  for (const r of staged) {
    const key = [r.clicked_at, r.affiliate_id, r.ad_type, r.ad_name, r.campaign, r.referrer, r.os]
      .map((v) => v ?? '')
      .join(SEP);
    const seq = (counter.get(key) ?? 0) + 1;
    counter.set(key, seq);
    out.push({ ...r, fingerprint: hash128(key), dup_seq: seq });
  }

  return { rows: out, dropped };
}

// ---- 見出し → 列番号 ---------------------------------------------------

function buildMap(header, dict) {
  const map = {};
  header.forEach((h, i) => {
    const key = dict[h];
    if (!key || key === '__drop_ip') return;   // IP 列は取り込まない
    if (map[key] === undefined) map[key] = i;
  });
  return map;
}
