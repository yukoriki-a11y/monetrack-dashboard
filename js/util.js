// 共通ユーティリティ

export const $  = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

// ---- 数値フォーマット --------------------------------------------------

const nf0 = new Intl.NumberFormat('ja-JP');
const nf2 = new Intl.NumberFormat('ja-JP', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const num = (v) => (v === null || v === undefined || v === '' ? '—' : nf0.format(Math.round(Number(v))));
// マイナスは「¥-180,000」ではなく「-¥180,000」と出す（記号の位置を通貨の外に）
export const yen = (v) => {
  if (v === null || v === undefined || v === '') return '—';
  const n = Math.round(Number(v));
  return (n < 0 ? '-¥' : '¥') + nf0.format(Math.abs(n));
};
export const pct = (v) => (v === null || v === undefined || v === '' ? '—' : nf2.format(Number(v)) + '%');

// グラフの軸や KPI 用の短縮表記。1230万 / 1.2億 のように読める形にする。
export function compact(v) {
  const n = Number(v || 0);
  const a = Math.abs(n);
  const unit = (div, suffix) => {
    const x = n / div;
    // 3桁以上あれば小数は落とす（4845.5万 ではなく 4,846万）
    const s = Math.abs(x) >= 100 ? nf0.format(Math.round(x)) : x.toFixed(1).replace(/\.0$/, '');
    return s + suffix;
  };
  if (a >= 1e8) return unit(1e8, '億');
  if (a >= 1e4) return unit(1e4, '万');
  return nf0.format(Math.round(n));
}

// ---- 日付 --------------------------------------------------------------

// Date → 'YYYY-MM-DD'（ローカル基準。端末は JST 前提）
export function ymd(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

// '2026/09/07 17:49:54' / '2026-09-07T17:49' / Excel シリアル値 → ISO(+09:00)
// マネートラックの出力は JST 表記なので、明示的に +09:00 を付けて保存する。
export function toIsoJst(value) {
  if (value === null || value === undefined || value === '') return null;

  if (value instanceof Date) return jstIsoFromParts(
    value.getFullYear(), value.getMonth() + 1, value.getDate(),
    value.getHours(), value.getMinutes(), value.getSeconds());

  if (typeof value === 'number') {
    // Excel シリアル値（1900 系）。0.5 日 = 12:00。
    const ms = Math.round((value - 25569) * 86400 * 1000);
    const d = new Date(ms);
    return jstIsoFromParts(
      d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(),
      d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds());
  }

  const s = String(value).trim();
  if (!s || s === '-') return null;
  const m = s.match(
    /^(\d{4})[/\-.](\d{1,2})[/\-.](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return null;
  return jstIsoFromParts(+m[1], +m[2], +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
}

function jstIsoFromParts(y, mo, d, h, mi, s) {
  const p = (n) => String(n).padStart(2, '0');
  return `${y}-${p(mo)}-${p(d)}T${p(h)}:${p(mi)}:${p(s)}+09:00`;
}

// 日付だけ（請求日など）
export function toDateOnly(value) {
  const iso = toIsoJst(value);
  return iso ? iso.slice(0, 10) : null;
}

// timestamptz → 'MM/DD HH:MM'（JST）
export function fmtDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(+d)) return '—';
  return d.toLocaleString('ja-JP', {
    timeZone: 'Asia/Tokyo', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
}

// ---- 数値パース --------------------------------------------------------

// '¥1,190' / '20164.0' / '' → number | null
export function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const s = String(value).replace(/[¥,\s円]/g, '').trim();
  if (!s || s === '-') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export function clean(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s === '' ? null : s;
}

// ---- ハッシュ ----------------------------------------------------------

// 行の指紋用の 128bit ハッシュ（同期・高速）。
// crypto.subtle は 1 万行ぶん呼ぶと遅いのでこちらを使う。
// 128bit あれば数十万行でも衝突は実質起きない。
export function hash128(str) {
  let h1 = 0x9e3779b1 | 0;
  let h2 = 0x85ebca6b | 0;
  let h3 = 0xc2b2ae35 | 0;
  let h4 = 0x27d4eb2f | 0;
  for (let i = 0; i < str.length; i += 1) {
    const c = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x85ebca6b) ^ (h1 >>> 13);
    h3 = Math.imul(h3 ^ c, 0xc2b2ae35) ^ (h2 >>> 7);
    h4 = Math.imul(h4 ^ c, 0x27d4eb2f) ^ (h3 >>> 17);
  }
  const mix = (h) => {
    h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b);
    h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
    return h >>> 0;
  };
  return [h1, h2, h3, h4].map((h) => mix(h).toString(16).padStart(8, '0')).join('');
}

export async function sha256Hex(input) {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  const buf = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---- CSV 出力 ----------------------------------------------------------

export function downloadCsv(filename, headers, rows) {
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const body = [headers.map(esc).join(','), ...rows.map((r) => r.map(esc).join(','))].join('\r\n');
  // Excel で開いたときに文字化けしないよう BOM を付ける
  const blob = new Blob(['﻿' + body], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ---- 小物 --------------------------------------------------------------

export const chunk = (arr, size) => {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

export function debounce(fn, ms = 250) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

// 広告主名・アフィリエイター名を「押せる名前」にする。
// クリックとマウス置きの扱いは app.js が画面全体でまとめて拾うので、
// ここでは目印（data-kind / data-name）を付けた button を返すだけ。
// 取り込み画面など、app.js の外からも使うので util に置いてある。
export const ENT_LABEL = { advertiser: '広告主', affiliate: 'アフィリエイター' };

export function nameNode(kind, label) {
  const text = label === null || label === undefined ? '' : String(label);
  // 「(なし)」や空はページが無いので、ただの文字にしておく
  if (!ENT_LABEL[kind] || !text || text === '(なし)') return text;
  return el('button', {
    type: 'button',
    class: 'ent-link',
    'data-kind': kind,
    'data-name': text,
    title: `クリックで${ENT_LABEL[kind]}のページへ／少し置くと直近3カ月`,
    text,
  });
}

// ---- 流入元を開くリンク ------------------------------------------------
// 値は取り込んだファイルから来る（＝こちらで中身を保証できない）ので、
// http / https だけを通す。javascript: のような細工を踏まないため。

function safeHref(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (!u.hostname.includes('.')) return null;
    return u.href;
  } catch {
    return null;
  }
}

// ホスト名（example.com）から、そのサイトを開くリンクを作る
export function hostLink(host, label = null) {
  const text = String(host || '');
  const href = safeHref(text);
  if (!href) return text;
  return el('a', {
    class: 'ext-link',
    href,
    target: '_blank',
    // 開いた先からこちらのタブを触られないようにする
    rel: 'noopener noreferrer nofollow',
    title: `${href} を開く`,
    text: label || text,
  });
}

export function statusBadge(status) {
  const cls = status === '承認' ? 'ok' : status === '却下' ? 'ng' : 'hold';
  return el('span', { class: `badge ${cls}`, text: status || '—' });
}
