-- =====================================================================
--  起動時に呼ぶ dash_filters を軽くする
--
--  データが 9,554行 → 264,794行 に増えたことで、この関数が
--  10.9秒かかるようになっていた（上限は8秒）。中身は10個の
--  数え上げ・並べ直しで、そのうち6個がテーブルの全読みだった。
--
--  直す点:
--   1. 期間の最小/最大が
--        min(c.occurred_at at time zone 'Asia/Tokyo')
--      と書かれていた。列に式をかぶせると索引が使えないので、
--      全読みになっていた。
--        (min(c.occurred_at) at time zone 'Asia/Tokyo')
--      の順にすれば索引の端を見るだけで済む（4か所）。
--   2. pay_statuses / cv_rows / ck_rows は画面のどこからも
--      使っていないので返すのをやめる（全読み3回ぶん）。
--
--  残る作業は statuses / advertisers / affiliates の重複除去で、
--  これは索引だけを読む形になる。
--
--  Supabase の SQL Editor に全文貼って Run。
--  テーブルとデータには触りません。関数の作り直しだけです。
--  引数は変わらないので drop は不要です。
-- =====================================================================

create or replace function public.dash_filters()
returns jsonb language sql security invoker stable as $$
  select jsonb_build_object(
    'statuses', (
      select coalesce(jsonb_agg(t.v order by t.v), '[]'::jsonb)
      from (select distinct c.status v from public.conversions c
            where c.status is not null and c.status <> '') t),
    'advertisers', (
      select coalesce(jsonb_agg(t.v order by t.v), '[]'::jsonb)
      from (select distinct c.advertiser_id v from public.conversions c
            where c.advertiser_id is not null and c.advertiser_id <> ''
            union
            select distinct k.advertiser_id from public.clicks k
            where k.advertiser_id is not null) t),
    'affiliates', (
      select coalesce(jsonb_agg(t.v order by t.v), '[]'::jsonb)
      from (select distinct c.affiliate_id v from public.conversions c
            where c.affiliate_id is not null and c.affiliate_id <> ''
            union
            select distinct k.affiliate_id from public.clicks k
            where k.affiliate_id is not null and k.affiliate_id <> '') t),
    -- 先に集めてから時間帯を直す。こう書くと occurred_at の索引の
    -- 端をのぞくだけで済む（式をかぶせると全読みになる）。
    'cv_date_min', ((select min(c.occurred_at) from public.conversions c) at time zone 'Asia/Tokyo')::date,
    'cv_date_max', ((select max(c.occurred_at) from public.conversions c) at time zone 'Asia/Tokyo')::date,
    'ck_date_min', ((select min(k.clicked_at)  from public.clicks k)      at time zone 'Asia/Tokyo')::date,
    'ck_date_max', ((select max(k.clicked_at)  from public.clicks k)      at time zone 'Asia/Tokyo')::date
  )
$$;

-- 作り直した関数には既定で PUBLIC 実行権が付くので、未ログインから剥がし直す
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
