// Supabase クライアントと認証。
//
// 接続情報（Project URL / anon key）はこのブラウザの localStorage に保存する。
// リポジトリには入らないので、公開リポジトリでも鍵が漏れない。
// チーム全員に同じ設定を配りたい場合は js/config.js に直接書いてもよい。

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
import { DEFAULT_SUPABASE_URL, DEFAULT_SUPABASE_ANON_KEY } from './config.js';

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

async function rpc(name, args) {
  const { data, error } = await sb().rpc(name, args);
  if (error) throw new Error(`${name}: ${error.message}`);
  return data;
}

// フィルタ条件をまとめて RPC 引数に変換する
function base(f) {
  return {
    p_from: f.from,
    p_to: f.to,
    p_statuses: f.statuses?.length ? f.statuses : null,
    p_advertisers: f.advertisers?.length ? f.advertisers : null,
  };
}

export const api = {
  filters:   ()                  => rpc('dash_filters', {}),
  kpi:       (f)                 => rpc('dash_kpi', base(f)),
  timeseries:(f, grain = 'day')  => rpc('dash_timeseries', { ...base(f), p_grain: grain }),
  affiliates:(f, limit = 300)    => rpc('dash_affiliates', { ...base(f), p_limit: limit }),
  dimension: (f, dim, limit = 50, affiliate = null) =>
    rpc('dash_dimension', { ...base(f), p_dim: dim, p_limit: limit, p_affiliate: affiliate }),
  affiliateDetail: (affiliateId, f) =>
    rpc('dash_affiliate_detail', { p_affiliate: affiliateId, ...base(f) }),
  conversions: (f, search, limit, offset) =>
    rpc('dash_conversions', { ...base(f), p_search: search || null, p_limit: limit, p_offset: offset }),
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
