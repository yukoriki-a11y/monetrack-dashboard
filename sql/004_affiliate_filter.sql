-- =====================================================================
--  追加分: アフィリエイターでの絞り込みを集計関数に足す
--
--  Supabase の SQL Editor に全文貼って Run してください。
--  テーブルとデータには一切触りません。関数の作り直しだけです。
--
--  ⚠ 「destructive operations」の警告が出ます
--     引数が増えると create or replace では差し替えにならず別関数として
--     増えてしまい、呼び出しが曖昧になるため、先に古い定義を drop している。
--     消えるのは関数の定義だけで、取り込んだデータは影響を受けません。
-- =====================================================================

drop function if exists public.dash_kpi(date, date, text[], text[]);
drop function if exists public.dash_timeseries(date, date, text[], text[], text);
drop function if exists public.dash_affiliates(date, date, text[], text[], integer);
drop function if exists public.dash_dimension(date, date, text[], text[], text, integer, text);
drop function if exists public.dash_conversions(date, date, text[], text[], text, integer, integer);
drop function if exists public.dash_compare(date, date, text[], text, text[], text, integer);

-- KPI サマリー
create or replace function public.dash_kpi(
  p_from date,
  p_to date,
  p_statuses text[] default null,
  p_advertisers text[] default null,
  p_affiliates text[] default null
) returns jsonb language sql security invoker stable as $$
  with cv as (
    select c.qty, c.sale_price, c.reward, c.affiliate_id, c.product_name
    from public.conversions c
    where c.occurred_at >= public.jst_start(p_from)
      and c.occurred_at <  public.jst_start(p_to + 1)
      and (p_statuses is null or array_length(p_statuses, 1) is null or c.status = any(p_statuses))
      and (p_advertisers is null or array_length(p_advertisers, 1) is null or c.advertiser_id = any(p_advertisers))
      and (p_affiliates is null or array_length(p_affiliates, 1) is null or c.affiliate_id = any(p_affiliates))
  ), agg as (
    select
      count(*)                        as n,
      coalesce(sum(cv.sale_price), 0) as sales,
      coalesce(sum(cv.reward), 0)     as reward,
      coalesce(sum(cv.qty), 0)        as qty,
      count(distinct cv.affiliate_id) as affiliates,
      count(distinct cv.product_name) as products
    from cv
  ), ck as (
    select count(*) as n
    from public.clicks k
    where k.clicked_at >= public.jst_start(p_from)
      and k.clicked_at <  public.jst_start(p_to + 1)
      and (p_advertisers is null or array_length(p_advertisers, 1) is null or k.advertiser_id = any(p_advertisers))
      and (p_affiliates is null or array_length(p_affiliates, 1) is null or k.affiliate_id = any(p_affiliates))
  )
  select jsonb_build_object(
    'conversions',  a.n,
    'sales',        a.sales,
    'reward',       a.reward,
    'qty',          a.qty,
    'clicks',       k.n,
    'affiliates',   a.affiliates,
    'products',     a.products,
    'aov',          case when a.n = 0 then 0 else round(a.sales / a.n, 0) end,
    'cvr',          case when k.n = 0 then null else round(a.n::numeric * 100 / k.n, 3) end,
    'reward_ratio', case when a.sales = 0 then null else round(a.reward * 100 / a.sales, 2) end
  )
  from agg a cross join ck k
$$;

-- 期間推移
create or replace function public.dash_timeseries(
  p_from date,
  p_to date,
  p_statuses text[] default null,
  p_advertisers text[] default null,
  p_grain text default 'day',
  p_affiliates text[] default null
) returns table(
  bucket date, conversions bigint, sales numeric,
  reward numeric, clicks bigint, cvr numeric
) language sql security invoker stable as $$
  with g as (
    select case when p_grain in ('day','week','month') then p_grain else 'day' end as unit
  ), cv as (
    select date_trunc((select unit from g), c.occurred_at at time zone 'Asia/Tokyo')::date as b,
           count(*) as n,
           coalesce(sum(c.sale_price), 0) as s,
           coalesce(sum(c.reward), 0) as r
    from public.conversions c
    where c.occurred_at >= public.jst_start(p_from)
      and c.occurred_at <  public.jst_start(p_to + 1)
      and (p_statuses is null or array_length(p_statuses, 1) is null or c.status = any(p_statuses))
      and (p_advertisers is null or array_length(p_advertisers, 1) is null or c.advertiser_id = any(p_advertisers))
      and (p_affiliates is null or array_length(p_affiliates, 1) is null or c.affiliate_id = any(p_affiliates))
    group by 1
  ), ck as (
    select date_trunc((select unit from g), k.clicked_at at time zone 'Asia/Tokyo')::date as b,
           count(*) as n
    from public.clicks k
    where k.clicked_at >= public.jst_start(p_from)
      and k.clicked_at <  public.jst_start(p_to + 1)
      and (p_advertisers is null or array_length(p_advertisers, 1) is null or k.advertiser_id = any(p_advertisers))
      and (p_affiliates is null or array_length(p_affiliates, 1) is null or k.affiliate_id = any(p_affiliates))
    group by 1
  )
  select
    coalesce(cv.b, ck.b), coalesce(cv.n, 0), coalesce(cv.s, 0),
    coalesce(cv.r, 0), coalesce(ck.n, 0),
    case when coalesce(ck.n, 0) = 0 then null
         else round(coalesce(cv.n, 0)::numeric * 100 / ck.n, 3) end
  from cv full outer join ck on cv.b = ck.b
  order by 1
$$;

-- アフィリエイター別ランキング
create or replace function public.dash_affiliates(
  p_from date,
  p_to date,
  p_statuses text[] default null,
  p_advertisers text[] default null,
  p_limit integer default 100,
  p_affiliates text[] default null
) returns table(
  affiliate_id text, clicks bigint, conversions bigint,
  cvr numeric, sales numeric, reward numeric, aov numeric
) language sql security invoker stable as $$
  with cv as (
    select c.affiliate_id as a, count(*) as n,
           coalesce(sum(c.sale_price), 0) as s, coalesce(sum(c.reward), 0) as r
    from public.conversions c
    where c.occurred_at >= public.jst_start(p_from)
      and c.occurred_at <  public.jst_start(p_to + 1)
      and (p_statuses is null or array_length(p_statuses, 1) is null or c.status = any(p_statuses))
      and (p_advertisers is null or array_length(p_advertisers, 1) is null or c.advertiser_id = any(p_advertisers))
      and (p_affiliates is null or array_length(p_affiliates, 1) is null or c.affiliate_id = any(p_affiliates))
    group by 1
  ), ck as (
    select k.affiliate_id as a, count(*) as n
    from public.clicks k
    where k.clicked_at >= public.jst_start(p_from)
      and k.clicked_at <  public.jst_start(p_to + 1)
      and (p_advertisers is null or array_length(p_advertisers, 1) is null or k.advertiser_id = any(p_advertisers))
      and (p_affiliates is null or array_length(p_affiliates, 1) is null or k.affiliate_id = any(p_affiliates))
    group by 1
  )
  select
    coalesce(cv.a, ck.a), coalesce(ck.n, 0), coalesce(cv.n, 0),
    case when coalesce(ck.n, 0) = 0 then null
         else round(coalesce(cv.n, 0)::numeric * 100 / ck.n, 2) end,
    coalesce(cv.s, 0), coalesce(cv.r, 0),
    case when coalesce(cv.n, 0) = 0 then 0 else round(cv.s / cv.n, 0) end
  from cv full outer join ck on cv.a = ck.a
  order by coalesce(cv.s, 0) desc, coalesce(ck.n, 0) desc
  limit greatest(p_limit, 1)
$$;

-- 任意の軸で集計
create or replace function public.dash_dimension(
  p_from date,
  p_to date,
  p_statuses text[] default null,
  p_advertisers text[] default null,
  p_dim text default 'product',
  p_limit integer default 50,
  p_affiliate text default null,
  p_affiliates text[] default null
) returns table(
  label text, conversions bigint, sales numeric,
  reward numeric, qty numeric, clicks bigint
) language sql security invoker stable as $$
  with cv as (
    select coalesce(nullif(case p_dim
             when 'product'    then c.product_name
             when 'ad'         then c.ad_name
             when 'campaign'   then c.campaign
             when 'advertiser' then c.advertiser_id
             when 'device'     then c.device
             when 'os'         then c.os
             when 'referrer'   then c.first_referrer_host
             when 'status'     then c.status
             when 'pay_status' then c.pay_status
             when 'affiliate'  then c.affiliate_id
           end, ''), '(なし)') as l,
           count(*) as n,
           coalesce(sum(c.sale_price), 0) as s,
           coalesce(sum(c.reward), 0) as r,
           coalesce(sum(c.qty), 0) as q
    from public.conversions c
    where p_dim <> 'ad_type'
      and c.occurred_at >= public.jst_start(p_from)
      and c.occurred_at <  public.jst_start(p_to + 1)
      and (p_statuses is null or array_length(p_statuses, 1) is null or c.status = any(p_statuses))
      and (p_advertisers is null or array_length(p_advertisers, 1) is null or c.advertiser_id = any(p_advertisers))
      and (p_affiliates is null or array_length(p_affiliates, 1) is null or c.affiliate_id = any(p_affiliates))
      and (p_affiliate is null or c.affiliate_id = p_affiliate)
    group by 1
  ), ck as (
    select coalesce(nullif(case p_dim
             when 'ad'         then k.ad_name
             when 'campaign'   then k.campaign
             when 'advertiser' then k.advertiser_id
             when 'os'         then k.os
             when 'referrer'   then k.referrer_host
             when 'ad_type'    then k.ad_type
             when 'affiliate'  then k.affiliate_id
           end, ''), '(なし)') as l,
           count(*) as n
    from public.clicks k
    where p_dim in ('ad','campaign','advertiser','os','referrer','ad_type','affiliate')
      and k.clicked_at >= public.jst_start(p_from)
      and k.clicked_at <  public.jst_start(p_to + 1)
      and (p_advertisers is null or array_length(p_advertisers, 1) is null or k.advertiser_id = any(p_advertisers))
      and (p_affiliates is null or array_length(p_affiliates, 1) is null or k.affiliate_id = any(p_affiliates))
      and (p_affiliate is null or k.affiliate_id = p_affiliate)
    group by 1
  )
  select
    coalesce(cv.l, ck.l), coalesce(cv.n, 0), coalesce(cv.s, 0),
    coalesce(cv.r, 0), coalesce(cv.q, 0), coalesce(ck.n, 0)
  from cv full outer join ck on cv.l = ck.l
  order by coalesce(cv.n, 0) desc, coalesce(ck.n, 0) desc
  limit greatest(p_limit, 1)
$$;

-- 成果明細
create or replace function public.dash_conversions(
  p_from date,
  p_to date,
  p_statuses text[] default null,
  p_advertisers text[] default null,
  p_search text default null,
  p_limit integer default 200,
  p_offset integer default 0,
  p_affiliates text[] default null
) returns table(
  order_id text, occurred_at timestamptz, advertiser_id text, affiliate_id text,
  product_name text, ad_name text, campaign text, qty numeric, sale_price numeric,
  reward numeric, reward_rate text, status text, pay_status text,
  device text, os text, first_referrer text, total_count bigint
) language sql security invoker stable as $$
  with f as (
    select c.*
    from public.conversions c
    where c.occurred_at >= public.jst_start(p_from)
      and c.occurred_at <  public.jst_start(p_to + 1)
      and (p_statuses is null or array_length(p_statuses, 1) is null or c.status = any(p_statuses))
      and (p_advertisers is null or array_length(p_advertisers, 1) is null or c.advertiser_id = any(p_advertisers))
      and (p_affiliates is null or array_length(p_affiliates, 1) is null or c.affiliate_id = any(p_affiliates))
      and (p_search is null or p_search = ''
           or c.product_name   ilike '%' || p_search || '%'
           or c.ad_name        ilike '%' || p_search || '%'
           or c.affiliate_id   ilike '%' || p_search || '%'
           or c.campaign       ilike '%' || p_search || '%'
           or c.order_id       ilike '%' || p_search || '%'
           or c.first_referrer ilike '%' || p_search || '%')
  ), n as (
    select count(*) as total from f
  )
  select
    f.order_id, f.occurred_at, f.advertiser_id, f.affiliate_id,
    f.product_name, f.ad_name, f.campaign, f.qty, f.sale_price,
    f.reward, f.reward_rate, f.status, f.pay_status,
    f.device, f.os, f.first_referrer, n.total
  from f cross join n
  order by f.occurred_at desc
  limit greatest(p_limit, 1) offset greatest(p_offset, 0)
$$;

-- 比較（広告主の絞り込みも効くようにした）
create or replace function public.dash_compare(
  p_from date,
  p_to date,
  p_statuses text[] default null,
  p_dim text default 'affiliate',
  p_keys text[] default null,
  p_grain text default 'day',
  p_limit integer default 5,
  p_advertisers text[] default null
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

-- フィルタ選択肢にアフィリエイター一覧も返す
create or replace function public.dash_filters()
returns jsonb language sql security invoker stable as $$
  select jsonb_build_object(
    'statuses', (
      select coalesce(jsonb_agg(t.v order by t.v), '[]'::jsonb)
      from (select distinct c.status v from public.conversions c
            where c.status is not null and c.status <> '') t),
    'pay_statuses', (
      select coalesce(jsonb_agg(t.v order by t.v), '[]'::jsonb)
      from (select distinct c.pay_status v from public.conversions c
            where c.pay_status is not null and c.pay_status <> '') t),
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
    'cv_date_min', (select min(c.occurred_at at time zone 'Asia/Tokyo')::date from public.conversions c),
    'cv_date_max', (select max(c.occurred_at at time zone 'Asia/Tokyo')::date from public.conversions c),
    'ck_date_min', (select min(k.clicked_at  at time zone 'Asia/Tokyo')::date from public.clicks k),
    'ck_date_max', (select max(k.clicked_at  at time zone 'Asia/Tokyo')::date from public.clicks k),
    'cv_rows',     (select count(*) from public.conversions),
    'ck_rows',     (select count(*) from public.clicks)
  )
$$;

-- 権限を付け直す
grant execute on function public.dash_filters() to authenticated;
grant execute on function public.dash_kpi(date, date, text[], text[], text[]) to authenticated;
grant execute on function public.dash_timeseries(date, date, text[], text[], text, text[]) to authenticated;
grant execute on function public.dash_affiliates(date, date, text[], text[], integer, text[]) to authenticated;
grant execute on function public.dash_dimension(date, date, text[], text[], text, integer, text, text[]) to authenticated;
grant execute on function public.dash_conversions(date, date, text[], text[], text, integer, integer, text[]) to authenticated;
grant execute on function public.dash_compare(date, date, text[], text, text[], text, integer, text[]) to authenticated;
