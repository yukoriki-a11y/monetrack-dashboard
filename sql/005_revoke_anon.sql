-- =====================================================================
--  004 のあと始末: 未ログイン（anon）から関数の実行権を剥がし直す
--
--  Postgres は新しく作った関数に既定で PUBLIC へ実行権を付けるため、
--  004 で関数を作り直した時点で anon が実行できる状態に戻っていた。
--  （データ自体は RLS とテーブル権限で守られているので漏れてはいないが、
--    意図していた二重の防御に戻す）
--
--  Supabase の SQL Editor に全文貼って Run。
--  何度実行しても同じ結果になります。テーブルとデータには触りません。
-- =====================================================================

do $$
declare
  fn record;
begin
  for fn in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and (p.proname like 'dash\_%' or p.proname like 'import\_%')
  loop
    execute format('revoke all on function %s from public', fn.sig);
    execute format('revoke all on function %s from anon', fn.sig);
    execute format('grant execute on function %s to authenticated', fn.sig);
  end loop;
end $$;

-- 確認用（この2行を選択して実行すると、剥がせているか見られる）
-- select p.proname, has_function_privilege('anon', p.oid, 'execute') as anon_ok
-- from pg_proc p join pg_namespace n on n.oid=p.pronamespace
-- where n.nspname='public' and (p.proname like 'dash\_%' or p.proname like 'import\_%') order by 1;
