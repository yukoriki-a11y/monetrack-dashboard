-- =====================================================================
--  日別ランキングを「その日ごとの順位」にする
--
--  いままで日別ランキングは dash_compare を使っていた。
--  dash_compare は
--    ① 期間まるごとの売上で上位 N 件を選ぶ
--    ② その N 件だけを日ごとに並べ替え直す
--  という作りなので、ある日に1位でも、期間合計で N 位に入らない相手は
--  一度も画面に出てこない。
--  N は ランキング画面の日別で 12件、サマリーの日別ランキングで 60件。
--  （2026-11-26 に tamane001 が日別広告主ランキングに出てこない件で判明）
--
--  この関数は順番を逆にする。先に日ごとに順位をつけてから候補を決める。
--    1. 日 × 相手 で集計する（成果とクリックの両方）
--    2. 日ごとに p_order の降順で順位をつける
--    3. 期間中に一度でも p_top 位以内に入った相手を候補にする
--    4. 候補の「全日ぶん」を返す
--
--  4 で入賞した日だけでなく全日を返すのは、画面が前日とくらべて
--  ⇈ ↑ → ↓ ⇊ を出すため。前日の数字が無いと前日0として扱われ、
--  ただ順位に戻ってきただけの相手が急上昇に見えてしまう。
--
--  p_order は画面で選んでいる指標（sales / conversions / reward / clicks）。
--  dash_compare は常に売上で切っていたので、
--  「クリック」で見ているのに売上順で候補が決まる、というズレもあった。
--
--  Supabase の SQL Editor に全文貼って Run。
--  テーブルとデータには触りません。関数を1つ足すだけです。
-- =====================================================================

create or replace function public.dash_rank_daily(
  p_from date,
  p_to date,
  p_statuses text[] default null,
  p_dim text default 'advertiser',
  p_top integer default 10,
  p_order text default 'sales',
  p_advertisers text[] default null,
  p_affiliates text[] default null
) returns table(
  series text, bucket date, conversions bigint,
  sales numeric, reward numeric, clicks bigint, cvr numeric
) language sql security invoker stable as $$
  with cv as (
    select case p_dim when 'advertiser' then c.advertiser_id else c.affiliate_id end as k,
           (c.occurred_at at time zone 'Asia/Tokyo')::date as b,
           count(*) as n,
           coalesce(sum(c.sale_price), 0) as s,
           coalesce(sum(c.reward), 0) as r
    from public.conversions c
    where c.occurred_at >= public.jst_start(p_from)
      and c.occurred_at <  public.jst_start(p_to + 1)
      and (p_statuses is null or array_length(p_statuses, 1) is null or c.status = any(p_statuses))
      and (p_advertisers is null or array_length(p_advertisers, 1) is null or c.advertiser_id = any(p_advertisers))
      and (p_affiliates is null or array_length(p_affiliates, 1) is null or c.affiliate_id = any(p_affiliates))
      and (case p_dim when 'advertiser' then c.advertiser_id else c.affiliate_id end) is not null
    group by 1, 2
  ), ck as (
    select case p_dim when 'advertiser' then k2.advertiser_id else k2.affiliate_id end as k,
           (k2.clicked_at at time zone 'Asia/Tokyo')::date as b,
           count(*) as n
    from public.clicks k2
    where k2.clicked_at >= public.jst_start(p_from)
      and k2.clicked_at <  public.jst_start(p_to + 1)
      and (p_advertisers is null or array_length(p_advertisers, 1) is null or k2.advertiser_id = any(p_advertisers))
      and (p_affiliates is null or array_length(p_affiliates, 1) is null or k2.affiliate_id = any(p_affiliates))
      and (case p_dim when 'advertiser' then k2.advertiser_id else k2.affiliate_id end) is not null
    group by 1, 2
  ), d as (
    -- 成果しか無い日・クリックしか無い日のどちらも落とさない
    select coalesce(cv.k, ck.k) as k,
           coalesce(cv.b, ck.b) as b,
           coalesce(cv.n, 0)    as n,
           coalesce(cv.s, 0)    as s,
           coalesce(cv.r, 0)    as r,
           coalesce(ck.n, 0)    as c
    from cv full outer join ck on cv.k = ck.k and cv.b = ck.b
  ), ov as (
    select d.*,
           case p_order
             when 'conversions' then d.n::numeric
             when 'reward'      then d.r
             when 'clicks'      then d.c::numeric
             else d.s
           end as v
    from d
  ), ranked as (
    -- 0 の相手は順位に入れない。静かな日に 0 で枠が埋まるのを防ぐ。
    -- 同じ値のときは名前順にして、日によって入れ替わらないようにする。
    select ov.k, ov.b,
           row_number() over (partition by ov.b order by ov.v desc, ov.k) as rk
    from ov
    where ov.v > 0
  ), pool as (
    select distinct ranked.k from ranked where ranked.rk <= greatest(p_top, 1)
  )
  select ov.k, ov.b, ov.n, ov.s, ov.r, ov.c,
         case when ov.c = 0 then null
              else round(ov.n::numeric * 100 / ov.c, 2) end
  from ov join pool on pool.k = ov.k
  order by 1, 2
$$;

-- 新しく作った関数には既定で PUBLIC 実行権が付くので、未ログインから剥がし直す
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
