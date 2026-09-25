-- =====================================================================
--  成果データのキーワード検索を速くする
--
--  いまの困りごと:
--    期間を「全期間」にしてキーワードを入れると応答が返ってこない。
--      dash_conversions: 応答が間に合いませんでした（時間がかかりすぎ）
--
--  なぜ遅いのか:
--    検索は6つの列を ilike '%語%' で見ている。前後に % が付く部分一致は
--    ふつうの索引が効かないので、26万行すべてを読むしかない。
--    しかも「件数」と「明細」で2回読む。期間で絞れているうちは
--    日付の索引が行数を減らしてくれるが、全期間だとそれも効かない。
--
--  直し方:
--    6列をつないだ1本の文字列に対して、pg_trgm（3文字単位の索引）を張る。
--    そして検索も同じつなぎ方をした文字列に対して行う。
--    こうすると索引が1本で済み、部分一致でも索引が使える。
--
--    ⚠ 索引の式と、下の dash_conv_where の式は**同じ**でなければならない。
--       片方だけ直すと索引が使われなくなる（エラーにはならず、ただ遅くなる）。
--
--  注意:
--    2〜3文字未満の検索語では索引が効かない（3文字単位で切るため）。
--    その場合は今までどおり全部読む。実用上は問題にならないはず。
--
--  Supabase の SQL Editor に全文貼って Run。
--  索引を作るので、26万行だと1〜2分かかることがあります。
-- =====================================================================

-- 索引を作る前の大きさを控えておく（Free枠 500MB に対する余裕を見るため）
do $$
begin
  raise notice '作る前: DB全体 % / conversions %',
    pg_size_pretty(pg_database_size(current_database())),
    pg_size_pretty(pg_total_relation_size('public.conversions'));
end $$;

-- pg_trgm が使えない環境（PGliteでの検証など）では索引だけ飛ばす。
-- 検索そのものは索引が無くても正しく動く。遅いだけ。
do $$
begin
  create extension if not exists pg_trgm;
  execute $ix$
    create index if not exists conversions_search_trgm
      on public.conversions using gin (
        (coalesce(product_name,'') || ' ' || coalesce(ad_name,'') || ' ' ||
         coalesce(affiliate_id,'') || ' ' || coalesce(campaign,'') || ' ' ||
         coalesce(order_id,'') || ' ' || coalesce(first_referrer,''))
        gin_trgm_ops
      )
  $ix$;
exception when others then
  raise notice 'pg_trgm が使えないので検索用の索引は作りませんでした: %', sqlerrm;
end $$;

-- 絞り込みの本体。$16 の検索だけを差し替える。
-- 他の条件は 010 のときのまま。
create or replace function public.dash_conv_where() returns text
language sql immutable as $$
  select $w$
    c.occurred_at >= public.jst_start($1::date)
    and c.occurred_at <  public.jst_start($2::date + 1)
    and ($3::text[]  is null or c.status        = any($3::text[]))
    and ($4::text[]  is null or c.advertiser_id = any($4::text[]))
    and ($5::text[]  is null or c.affiliate_id  = any($5::text[]))
    and ($6::text[]  is null or c.status        = any($6::text[]))
    and ($7::text[]  is null or c.advertiser_id = any($7::text[]))
    and ($8::text[]  is null or c.affiliate_id  = any($8::text[]))
    and ($9::text[]  is null or c.product_name  = any($9::text[]))
    and ($10::text[] is null or c.ad_name       = any($10::text[]))
    and ($11::text[] is null or c.campaign      = any($11::text[]))
    and ($12::text[] is null or c.reward_rate   = any($12::text[]))
    and ($13::text[] is null or c.pay_status    = any($13::text[]))
    and ($14::text[] is null or c.device        = any($14::text[]))
    and ($15::text[] is null or c.os            = any($15::text[]))
    and ($16::text is null or $16::text = ''
         or (coalesce(c.product_name,'') || ' ' || coalesce(c.ad_name,'') || ' ' ||
             coalesce(c.affiliate_id,'') || ' ' || coalesce(c.campaign,'') || ' ' ||
             coalesce(c.order_id,'') || ' ' || coalesce(c.first_referrer,''))
            ilike '%' || $16::text || '%')
  $w$
$$;

-- 新しく作り直した関数には既定で PUBLIC 実行権が付くので剥がし直す（013 と同じ）
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

-- 索引がどれだけ大きくなったか。容量に余裕が無ければ
--   drop index public.conversions_search_trgm;
-- で元に戻せる（検索は遅くなるが壊れない）。
do $$
declare
  v_idx text := '(作られていません)';
begin
  if to_regclass('public.conversions_search_trgm') is not null then
    v_idx := pg_size_pretty(pg_relation_size('public.conversions_search_trgm'));
  end if;
  raise notice '作った後: DB全体 % / conversions % / 検索索引 %',
    pg_size_pretty(pg_database_size(current_database())),
    pg_size_pretty(pg_total_relation_size('public.conversions')),
    v_idx;
end $$;
