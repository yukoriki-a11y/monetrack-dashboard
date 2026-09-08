// 接続先。ここに書いておくと、開いた人は「ログインするだけ」で使える。
//
// このリポジトリは公開なので、ここに書いた anon key は誰でも読める。
// それでも成立するのは、実データが次の二段で守られているため。
//   1. テーブルは全部 RLS が有効で、ポリシーは authenticated 向けだけ
//   2. public の関数は anon から実行権を剥がしてある（sql/013_lock_anon.sql）
// つまり anon key だけでは 1 件も読めない。読むにはログインが要る。
// 新規登録は Supabase 側で止めてあるので、勝手にアカウントは作れない。
//
// service_role / secret のキーは絶対にここに書かないこと。
// あれは RLS を無視できる管理者キーで、書いた時点で全データが公開になる。
// （画面側でも sb_secret_ と service_role の JWT は弾くようにしてある）

export const DEFAULT_SUPABASE_URL = 'https://xkolhtdajziwjagflqjd.supabase.co';

// ↓ Supabase → Project Settings → API Keys の
//   「Publishable」または「anon public」の値を貼る
export const DEFAULT_SUPABASE_ANON_KEY = '';
