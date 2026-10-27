// GitHub Actions の Secret を書き換える。
//
// マネートラックの remember_user_token は、使うたびに新しいものへ差し替わる。
// 保存してある Cookie は1回使った時点で古くなり、次の実行で弾かれる。
// （2026-10-22 に入れ直して、翌日にはもう失敗していた）
//
// そこで実行の最後に、そのとき手元にある最新の Cookie を Secret へ書き戻す。
// 次の実行はその新しい Cookie で始まるので、鎖がつながっているかぎり切れない。
//
// Secret は公開鍵で封をしてから送る決まりなので libsodium を使う。
// 必要な権限は「Secrets: Read and write」だけ。

import sodium from 'libsodium-wrappers';

const API = 'https://api.github.com';

function headers(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'monetrack-daily-sync',
  };
}

// 書き込み先のリポジトリは Actions が教えてくれる（owner/repo の形）
function repoSlug() {
  const r = process.env.GITHUB_REPOSITORY;
  if (!r || !r.includes('/')) throw new Error('GITHUB_REPOSITORY が読めません');
  return r;
}

export async function updateSecret(name, value, token) {
  const repo = repoSlug();

  const keyRes = await fetch(`${API}/repos/${repo}/actions/secrets/public-key`, { headers: headers(token) });
  if (!keyRes.ok) {
    const t = await keyRes.text();
    throw new Error(`公開鍵を取れません (${keyRes.status}): ${t.slice(0, 160)}`);
  }
  const { key, key_id: keyId } = await keyRes.json();

  await sodium.ready;
  const sealed = sodium.crypto_box_seal(
    sodium.from_string(value),
    sodium.from_base64(key, sodium.base64_variants.ORIGINAL),
  );
  const encrypted = sodium.to_base64(sealed, sodium.base64_variants.ORIGINAL);

  const putRes = await fetch(`${API}/repos/${repo}/actions/secrets/${name}`, {
    method: 'PUT',
    headers: { ...headers(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ encrypted_value: encrypted, key_id: keyId }),
  });
  if (!putRes.ok) {
    const t = await putRes.text();
    throw new Error(`Secret を更新できません (${putRes.status}): ${t.slice(0, 160)}`);
  }
  return putRes.status;   // 201 = 新規, 204 = 上書き
}

// 書き戻してよい Cookie かどうか。
// ログインに関わるものが欠けていたら、壊れた値で上書きしないよう見送る。
export function looksUsable(cookieHeader) {
  const names = String(cookieHeader || '').split(';')
    .map((p) => p.split('=')[0].trim()).filter(Boolean);
  return names.some((n) => /_session/i.test(n));
}
