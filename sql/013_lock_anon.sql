-- =====================================================================
--  未ログイン（anon）から、public の関数をすべて外す
--
--  これまでの権限の付け直しは dash_ / import_ で始まる関数だけを見ていた。
--  そのため補助の3つ（jst_start / resolve_status / jsonb_pick）に
--  PUBLIC 実行権が残っていた。
--
--  この3つは受け取った値を計算して返すだけで、テーブルは一切見ないので
--  データが漏れることはない。実際、
--    ・RLS が付いていない public のテーブル … なし
--    ・anon が select できるテーブル       … なし
--    ・anon 向けのポリシー                 … なし
--  であることは確認済み。
--
--  ただ、公開リポジトリに anon key を置くにあたって
--  「未ログインが触れるものは public に一つも無い」状態に揃えておく。
--
--  名前の決め打ちをやめて public の関数を全部見るようにしたので、
--  今後 関数を足しても同じ取りこぼしは起きない。
--
--  Supabase の SQL Editor に全文貼って Run。
--  テーブル・データ・関数の中身には触れません。権限の付け替えだけです。
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
      and p.prokind = 'f'          -- 集約やウィンドウ関数は対象外
  loop
    execute format('revoke all on function %s from public', fn.sig);
    execute format('revoke all on function %s from anon', fn.sig);
    execute format('grant execute on function %s to authenticated', fn.sig);
  end loop;
end $$;

-- 確認: どれも「なし」「0」になっていれば、未ログインからは何も触れない
select
  (select coalesce(string_agg(c.relname, ', '), 'なし')
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity) as "RLSなしのテーブル",
  (select coalesce(string_agg(c.relname, ', '), 'なし')
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r'
       and has_table_privilege('anon', c.oid, 'select')) as "anonが読めるテーブル",
  (select coalesce(string_agg(p.proname, ', '), 'なし')
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.prokind = 'f'
       and has_function_privilege('anon', p.oid, 'execute')) as "anonが実行できる関数",
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.prokind = 'f'
       and not has_function_privilege('authenticated', p.oid, 'execute')) as "ログイン済みが実行できない関数";
