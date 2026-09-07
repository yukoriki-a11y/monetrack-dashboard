-- =====================================================================
--  追加分: 比較の絞り込みにアフィリエイターを足す
--
--  「選んだアフィリエイターの中を、どの広告主が作っているか」を出すために、
--  dash_compare にアフィリエイターの絞り込み（p_affiliates）を追加する。
--
--  Supabase の SQL Editor に全文貼って Run。
--  テーブルとデータには触りません。関数の作り直しだけです。
--
--  ⚠ 「destructive operations」の警告が出ます
--     引数が増えると create or replace では差し替えにならないため、
--     先に古い定義を drop している。消えるのは関数の定義だけです。
-- =====================================================================

drop function if exists public.dash_compare(date, date, text[], text, text[], text, integer, text[]);

-- 選んだ相手ごとの時系列を返す。
--   p_dim         : 系列にする軸（'affiliate' | 'advertiser'）
--   p_keys        : 系列を明示指定する場合のID配列。null なら売上上位を p_limit 件
--   p_advertisers : 広告主で絞る
--   p_affiliates  : アフィリエイターで絞る
-- 「軸」と「絞り込み」を別に渡せるので、
--   軸=広告主 × アフィリエイターで絞る → 選んだ人の中の広告主内訳
--   軸=アフィリエイター × 広告主で絞る → 選んだ広告主の中の人別内訳
-- の両方が出せる。
create or replace function public.dash_compare(
  p_from date,
  p_to date,
  p_statuses text[] default null,
  p_dim text default 'affiliate',
  p_keys text[] default null,
  p_grain text default 'day',
  p_limit integer default 5,
  p_advertisers text[] default null,
  p_affiliates text[] default null
) returns table(
  series text, bucket date, conversions bigint,
  sales numeric, reward numeric, clicks bigint, cvr numeric
) language sql security invoker stable as $$
  with g as (
    select case when p_grain in ('day','week','month') then p_grain else 'day' end as unit
  ), picked as (
    select u.k
    from unnest(coalesce(p_keys, '{}'::text[])) as u(k)
    where p_keys is not null and array_length(p_keys, 1) is not null
    union all
    select t.k from (
      select case p_dim when 'advertiser' then c.advertiser_id else c.affiliate_id end as k,
             coalesce(sum(c.sale_price), 0) as s
      from public.conversions c
      where (p_keys is null or array_length(p_keys, 1) is null)
        and c.occurred_at >= public.jst_start(p_from)
        and c.occurred_at <  public.jst_start(p_to + 1)
        and (p_statuses is null or array_length(p_statuses, 1) is null or c.status = any(p_statuses))
        and (p_advertisers is null or array_length(p_advertisers, 1) is null or c.advertiser_id = any(p_advertisers))
        and (p_affiliates is null or array_length(p_affiliates, 1) is null or c.affiliate_id = any(p_affiliates))
        and (case p_dim when 'advertiser' then c.advertiser_id else c.affiliate_id end) is not null
      group by 1
      order by 2 desc
      limit greatest(p_limit, 1)
    ) t
  ), cv as (
    select case p_dim when 'advertiser' then c.advertiser_id else c.affiliate_id end as k,
           date_trunc((select unit from g), c.occurred_at at time zone 'Asia/Tokyo')::date as b,
           count(*) as n,
           coalesce(sum(c.sale_price), 0) as s,
           coalesce(sum(c.reward), 0) as r
    from public.conversions c
    where c.occurred_at >= public.jst_start(p_from)
      and c.occurred_at <  public.jst_start(p_to + 1)
      and (p_statuses is null or array_length(p_statuses, 1) is null or c.status = any(p_statuses))
      and (p_advertisers is null or array_length(p_advertisers, 1) is null or c.advertiser_id = any(p_advertisers))
      and (p_affiliates is null or array_length(p_affiliates, 1) is null or c.affiliate_id = any(p_affiliates))
      and (case p_dim when 'advertiser' then c.advertiser_id else c.affiliate_id end)
          in (select p.k from picked p)
    group by 1, 2
  ), ck as (
    select case p_dim when 'advertiser' then k2.advertiser_id else k2.affiliate_id end as k,
           date_trunc((select unit from g), k2.clicked_at at time zone 'Asia/Tokyo')::date as b,
           count(*) as n
    from public.clicks k2
    where k2.clicked_at >= public.jst_start(p_from)
      and k2.clicked_at <  public.jst_start(p_to + 1)
      and (p_advertisers is null or array_length(p_advertisers, 1) is null or k2.advertiser_id = any(p_advertisers))
      and (p_affiliates is null or array_length(p_affiliates, 1) is null or k2.affiliate_id = any(p_affiliates))
      and (case p_dim when 'advertiser' then k2.advertiser_id else k2.affiliate_id end)
          in (select p.k from picked p)
    group by 1, 2
  )
  select
    coalesce(cv.k, ck.k), coalesce(cv.b, ck.b),
    coalesce(cv.n, 0), coalesce(cv.s, 0), coalesce(cv.r, 0), coalesce(ck.n, 0),
    case when coalesce(ck.n, 0) = 0 then null
         else round(coalesce(cv.n, 0)::numeric * 100 / ck.n, 2) end
  from cv full outer join ck on cv.k = ck.k and cv.b = ck.b
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
