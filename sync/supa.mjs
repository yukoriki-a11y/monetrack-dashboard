// Supabase への取り込み。
//
// 取り込みRPCは authenticated にしか許可していないので、
// メール＋パスワードでログインして JWT を取ってから呼ぶ。
// service_role キーは使わない（RLS を無視できてしまうため）。

const CHUNK = 500;   // js/importer.js と同じ刻み

export class Supa {
  constructor({ url, anonKey }) {
    if (!url || !anonKey) throw new Error('SUPABASE_URL / SUPABASE_ANON_KEY がありません');
    this.url = url.replace(/\/+$/, '');
    this.anonKey = anonKey;
    this.token = null;
  }

  async signIn(email, password) {
    if (!email || !password) throw new Error('SUPABASE_EMAIL / SUPABASE_PASSWORD がありません');
    const res = await fetch(`${this.url}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: this.anonKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) {
      throw new Error(`Supabase のログインに失敗 (${res.status}): ${data.error_description || data.msg || ''}`);
    }
    this.token = data.access_token;
  }

  async rpc(name, args) {
    if (!this.token) throw new Error('先に signIn を呼んでください');
    const res = await fetch(`${this.url}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: {
        apikey: this.anonKey,
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(args),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${name} (${res.status}): ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : null;
  }

  // 大きい配列は分けて送る。1回で送ると本文が大きすぎて弾かれる。
  async rpcChunked(name, rows, build, onProgress) {
    const totals = {};
    for (let i = 0; i < rows.length; i += CHUNK) {
      const part = rows.slice(i, i + CHUNK);
      const out = await this.rpc(name, build(part));
      for (const [k, v] of Object.entries(out || {})) {
        if (typeof v === 'number') totals[k] = (totals[k] || 0) + v;
      }
      onProgress?.(Math.min(i + CHUNK, rows.length), rows.length);
    }
    return totals;
  }
}
