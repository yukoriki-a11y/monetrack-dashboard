// マネートラック管理画面からの取得。
//
// ログインはしない。人が1回ログインして得たセッション（Cookie）を使う。
// ログインフォームには reCAPTCHA v3 が入っているので、そこは人が通す。
// 仕組みの詳細は docs/daily-sync.md にある。

const BASE = 'https://app.monetrack.com';
const POLL_INTERVAL = 1500;   // ジョブの進捗を見にいく間隔
const POLL_MAX = 120;         // 最大で3分ほど待つ

// ---- Cookie の管理 -------------------------------------------------------
// fetch は Cookie を覚えてくれないし、リダイレクトを追うと途中の Set-Cookie を
// 取りこぼす。成り代わり（admin_log_in_as）でセッションが差し替わるので、
// ここは自前で持つ必要がある。リダイレクトも手で追う。

export class Session {
  constructor(cookieHeader) {
    this.jar = new Map();
    for (const part of String(cookieHeader || '').split(';')) {
      const i = part.indexOf('=');
      if (i > 0) this.jar.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
    }
    if (!this.jar.size) throw new Error('MT_COOKIE が空です');
  }

  header() {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  absorb(res) {
    // Node 18+ の getSetCookie() が使える。無ければ単数の set-cookie を見る。
    const list = typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : [res.headers.get('set-cookie')].filter(Boolean);
    for (const line of list) {
      const [pair] = String(line).split(';');
      const i = pair.indexOf('=');
      if (i <= 0) continue;
      const name = pair.slice(0, i).trim();
      const value = pair.slice(i + 1).trim();
      // 期限切れ指定で消しにきているものは落とす
      if (value === '' || /expires=Thu, 01 Jan 1970/i.test(line)) this.jar.delete(name);
      else this.jar.set(name, value);
    }
  }

  // リダイレクトを手で追う。各段の Set-Cookie を取りこぼさないため。
  async fetch(path, opts = {}) {
    let url = path.startsWith('http') ? path : BASE + path;
    let body = opts.body;
    let method = opts.method || 'GET';

    for (let hop = 0; hop < 10; hop += 1) {
      const res = await fetch(url, {
        method,
        body,
        redirect: 'manual',
        headers: {
          'Cookie': this.header(),
          'User-Agent': 'monetrack-daily-sync (dashboard internal)',
          ...(opts.headers || {}),
        },
      });
      this.absorb(res);

      const loc = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && loc) {
        url = new URL(loc, url).href;
        // リダイレクト後は本文を持ち回らない（POST→GET になる）
        method = 'GET';
        body = undefined;
        continue;
      }
      return { res, url };
    }
    throw new Error(`リダイレクトが多すぎます: ${path}`);
  }
}

// ---- ページから admin_id と CSRF を読む ----------------------------------
// admin_id はページによって入っていたりいなかったりする。
// /users/get_transactions は空で、/merchants には入っている。
// 空のまま成り代わると back_to_admin が効かなくなるので、必ず /merchants から読む。

export async function readAdminContext(s) {
  const { res } = await s.fetch('/merchants?status=approved');
  const html = await res.text();
  const pick = (name) => {
    const re = new RegExp(`name=["']${name}["'][^>]*value=["']([^"']*)["']`, 'i');
    const alt = new RegExp(`value=["']([^"']*)["'][^>]*name=["']${name}["']`, 'i');
    return (html.match(re) || html.match(alt) || [])[1] || '';
  };
  const adminId = pick('admin_id');
  const csrf = (html.match(/name="csrf-token" content="([^"]+)"/) || [])[1] || pick('authenticity_token');

  if (!adminId || !csrf) {
    const loggedOut = /users\/sign_in|authenticate_email/.test(html);
    throw new Error(loggedOut
      ? 'セッションが切れています。MT_COOKIE を入れ直してください（docs/daily-sync.md 参照）'
      : 'admin_id / CSRF を読めませんでした。画面構成が変わった可能性があります');
  }
  return { adminId, csrf };
}

// ---- 非同期ジョブ方式のエクスポート --------------------------------------
// ①成果 と ③広告主別クリック が同じ作り。
//   xlsx のURLを叩く → {job_id, attachment_id} → /check_progress を繰り返す
//   → finished になったら attachment_url（S3）から落とす

export async function exportViaJob(s, path, params) {
  const qs = new URLSearchParams(params).toString();
  const { res } = await s.fetch(`${path}?${qs}`, {
    headers: { 'X-Requested-With': 'XMLHttpRequest', 'Accept': 'application/json' },
  });
  const text = await res.text();

  let job;
  try { job = JSON.parse(text); } catch {
    throw new Error(`${path}: JSON が返りませんでした（セッション切れ？）: ${text.slice(0, 120)}`);
  }
  if (!job.job_id) throw new Error(`${path}: job_id がありません: ${text.slice(0, 120)}`);

  for (let i = 0; i < POLL_MAX; i += 1) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL));
    const p = new URLSearchParams({ job_id: job.job_id, attachment_id: job.attachment_id });
    const { res: pr } = await s.fetch(`/check_progress?${p}`, {
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
    });
    const st = await pr.json();
    if (st.finished) {
      if (!st.attachment_url) throw new Error(`${path}: 完了したが URL がありません`);
      const { res: fr } = await s.fetch(st.attachment_url);
      if (!fr.ok) throw new Error(`${path}: ダウンロードに失敗 (${fr.status})`);
      return Buffer.from(await fr.arrayBuffer());
    }
  }
  throw new Error(`${path}: ジョブが終わりません（${(POLL_MAX * POLL_INTERVAL) / 1000}秒待ちました）`);
}

// ---- ① 成果データ --------------------------------------------------------

export function fetchTransactions(s, fromYmd, toYmd) {
  return exportViaJob(s, '/users/get_transactions.xlsx', {
    type: '', status: '', paid: '',
    fromdate: fromYmd, todate: toYmd,
    affiliate_token: '', merchant_id: '',
    sSearch: '', iSortCol_0: '', sSortDir_0: '',
  });
}

// ---- ② 全体のクリック・表示（CSV、ジョブ不要） ---------------------------

export async function fetchAffiliateActivityCsv(s, year, month) {
  const { res } = await s.fetch(
    `/users/affiliate_activity_csv.csv?year=${year}&month=${month}`,
    { headers: { 'X-Requested-With': 'XMLHttpRequest' } },
  );
  const text = await res.text();
  if (text.trimStart().startsWith('{')) {
    throw new Error('affiliate_activity_csv: CSV ではなく JSON が返りました（セッション切れ？）');
  }
  return text;
}

// ---- ③ 広告主別のクリック（成り代わりが要る） ----------------------------

export async function withMerchant(s, ctx, merchant, fn) {
  const body = new URLSearchParams({
    authenticity_token: ctx.csrf,
    admin_id: ctx.adminId,          // ここを空にすると back_to_admin が効かなくなる
    user_id: merchant.id,
    type: 'merchant',
  });
  const { url } = await s.fetch('/users/admin_log_in_as', {
    method: 'POST',
    body,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  if (!/\/merchants\//.test(url)) {
    throw new Error(`${merchant.slug}: 成り代わりに失敗しました（${url}）`);
  }

  try {
    return await fn();
  } finally {
    // 失敗しても必ず管理者に戻す。戻れないと以降の社が全部こける。
    const { url: back } = await s.fetch('/users/back_to_admin');
    if (!/report_overall/.test(back)) {
      throw new Error(`${merchant.slug}: 管理者に戻れませんでした（${back}）。以降は中止します`);
    }
  }
}

export function fetchRawClick(s, slug, fromYmd, toYmd) {
  return exportViaJob(s, `/merchants/${slug}/raw_click.xlsx`, {
    fromdate: fromYmd, todate: toYmd,
    sSearch: '', iSortCol_0: '', sSortDir_0: '',
  });
}
