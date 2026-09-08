// Supabase クライアントと認証。
//
// 接続情報（Project URL / anon key）はこのブラウザの localStorage に保存する。
// リポジトリには入らないので、公開リポジトリでも鍵が漏れない。
// チーム全員に同じ設定を配りたい場合は js/config.js に直接書いてもよい。

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
import { DEFAULT_SUPABASE_URL, DEFAULT_SUPABASE_ANON_KEY } from './config.js?v=202609081407';

const LS_URL = 'afd.supabase.url';
const LS_KEY = 'afd.supabase.key';

let client = null;

export function getConn() {
  return {
    url: localStorage.getItem(LS_URL) || DEFAULT_SUPABASE_URL || '',
    key: localStorage.getItem(LS_KEY) || DEFAULT_SUPABASE_ANON_KEY || '',
  };
}

export function saveConn(url, key) {
  localStorage.setItem(LS_URL, url.trim().replace(/\/+$/, ''));
  localStorage.setItem(LS_KEY, key.trim());
  client = null;
}

export function clearConn() {
  localStorage.removeItem(LS_URL);
  localStorage.removeItem(LS_KEY);
  client = null;
}

export function hasConn() {
  const { url, key } = getConn();
  return Boolean(url && key);
}

export function sb() {
  if (client) return client;
  const { url, key } = getConn();
  if (!url || !key) throw new Error('Supabase の接続先が未設定です');
  client = createClient(url, key, {
    auth: { persistSession: true, autoRefreshToken: true },
  });
  return client;
}

// ---- 認証 --------------------------------------------------------------

export async function currentUser() {
  const { data, error } = await sb().auth.getSession();
  if (error) return null;
  return data.session?.user ?? null;
}

export async function signIn(email, password) {
  const { error } = await sb().auth.signInWithPassword({ email, password });
  if (error) throw error;
}

export async function signOut() {
  await sb().auth.signOut();
}

export function onAuthChange(handler) {
  sb().auth.onAuthStateChange((_event, session) => handler(session?.user ?? null));
}

// ---- RPC ラッパ --------------------------------------------------------

// タイムアウトはたいてい一時的なもの（無料プランの小さいインスタンスが
// 立ち上がりきっていない、直前の重い問い合わせが詰まっている、など）。
// 中身を変えない読み取りなので、少し待って1回だけやり直す。
const TIMEOUT_HINT = /statement timeout|timeout|57014|upstream|fetch failed|Failed to fetch/i;
const RETRY_WAIT = 1200;

async function rpc(name, args, retry = true) {
  const { data, error } = await sb().rpc(name, args);
  if (!error) return data;

  if (retry && TIMEOUT_HINT.test(error.message || '')) {
    await new Promise((r) => setTimeout(r, RETRY_WAIT));
    return rpc(name, args, false);
  }
  const timedOut = /statement timeout|57014/i.test(error.message || '');
  throw new Error(timedOut
    ? `${name}: 応答が間に合いませんでした（時間がかかりすぎ）。期間を短くするか、少し待ってから開き直してください。`
    : `${name}: ${error.message}`);
}

// フィルタ条件をまとめて RPC 引数に変換する。
// 空配列は「絞らない」の意味なので null にして渡す。
//
// scope を渡すと、その相手だけに絞り直す（フィルタの選択より優先）。
// 「広告主ごとのかたまり」を1件ずつ描くときに使う。
//
// 絞り込みの値は3通りの意味を持たせている。
//   null / undefined … 絞らない（＝全部）
//   ["a","b"]        … その相手だけ
//   []               … 「全部外した」。全部と区別したいので、
//                       どの行にも当たらない番兵を送って0件にする。
const NONE = '__afd_none__';
export function listArg(v) {
  if (v === null || v === undefined) return null;
  return v.length ? v : [NONE];
}

function base(f, scope = {}) {
  // scope（かたまり1件ぶんの絞り込み）はフィルタより優先する
  const pick = (a, b) => (a?.length ? a : listArg(b));
  return {
    p_from: f.from,
    p_to: f.to,
    p_statuses: listArg(f.statuses),
    p_advertisers: pick(scope.advertisers, f.advertisers),
    p_affiliates: pick(scope.affiliates, f.affiliates),
  };
}

export const api = {
  filters:   ()                  => rpc('dash_filters', {}),
  kpi:       (f)                 => rpc('dash_kpi', base(f)),
  timeseries:(f, grain = 'day', scope = {}) =>
    rpc('dash_timeseries', { ...base(f, scope), p_grain: grain }),
  affiliates:(f, limit = 300)    => rpc('dash_affiliates', { ...base(f), p_limit: limit }),
  dimension: (f, dim, limit = 50, affiliate = null, scope = {}) =>
    rpc('dash_dimension', { ...base(f, scope), p_dim: dim, p_limit: limit, p_affiliate: affiliate }),
  // 単体詳細はアフィリエイターを指定して呼ぶので、絞り込みの p_affiliates は渡さない
  affiliateDetail: (affiliateId, f) =>
    rpc('dash_affiliate_detail', {
      p_affiliate: affiliateId,
      p_from: f.from, p_to: f.to,
      p_statuses: listArg(f.statuses),
      p_advertisers: listArg(f.advertisers),
    }),
  // scope で絞り込みを上書きできる（フィルタの値より優先）。
  // 「軸」と「絞り込み」を別に渡せるので、
  //   軸=広告主 × アフィリエイターで絞る → 選んだ人の中の広告主内訳
  //   軸=アフィリエイター × 広告主で絞る → 選んだ広告主の中の人別内訳
  // の両方が出せる。
  compare: (f, dim, keys, grain = 'day', limit = 5, scope = {}) =>
    rpc('dash_compare', {
      p_from: f.from, p_to: f.to,
      p_statuses: listArg(f.statuses),
      p_dim: dim,
      p_keys: keys?.length ? keys : null,
      p_grain: grain,
      p_limit: limit,
      p_advertisers: scope.advertisers?.length ? scope.advertisers : listArg(f.advertisers),
      p_affiliates: scope.affiliates?.length ? scope.affiliates : listArg(f.affiliates),
    }),
  // p_filters は列ごとの絞り込み {"device":["パソコン"]}。
  // 表計算ソフトの見出しフィルタに対応する。
  conversions: (f, search, limit, offset, cols = null, sort = null) =>
    rpc('dash_conversions', {
      ...base(f),
      p_search: search || null,
      p_limit: limit,
      p_offset: offset,
      p_filters: cols && Object.keys(cols).length ? cols : null,
      p_sort: sort?.key || 'occurred_at',
      p_dir: sort?.dir === 'asc' ? 'asc' : 'desc',
    }),
  // その列に入っている値の候補（多い順）
  conversionValues: (f, col, search, cols = null, limit = 500) =>
    rpc('dash_conversion_values', {
      p_from: f.from,
      p_to: f.to,
      p_col: col,
      p_statuses: listArg(f.statuses),
      p_advertisers: listArg(f.advertisers),
      p_affiliates: listArg(f.affiliates),
      p_search: search || null,
      p_filters: cols && Object.keys(cols).length ? cols : null,
      p_limit: limit,
    }),
  imports:   (limit = 50)        => rpc('dash_imports', { p_limit: limit }),

  // 取り込み
  importCheck: (fileHash) => rpc('import_check', { p_file_hash: fileHash }),
  importRecord: (fileName, fileHash, kind, advertiserId, rowCount, inserted, updated, skipped) =>
    rpc('import_record', {
      p_file_name: fileName, p_file_hash: fileHash, p_kind: kind,
      p_advertiser_id: advertiserId, p_row_count: rowCount,
      p_inserted: inserted, p_updated: updated, p_skipped: skipped,
    }),
  importConversionsChunk: (rows, fileName) =>
    rpc('import_conversions_chunk', { p_rows: rows, p_file_name: fileName }),
  importClicksChunk: (rows, fileName, advertiserId) =>
    rpc('import_clicks_chunk', { p_rows: rows, p_file_name: fileName, p_advertiser_id: advertiserId }),
};
