-- =====================================================================
--  成果データに「表計算ソフトのような列フィルタ」を足す
--
--  見出しをクリックすると、その列にある値の一覧が出て、
--  チェックした値だけに絞れるようにする。並べ替えも列ごとに。
--
--  画面は100件ずつしか持っていないので、絞り込みも並べ替えも
--  サーバ側でやる必要がある。そのための引数を足す。
--
--  Supabase の SQL Editor に全文貼って Run。
--  テーブルとデータには触りません。関数の作り直しだけです。
--
--  ⚠ 「destructive operations」の警告が出ます
--     引数が増えると create or replace では差し替えにならないため、
--     先に古い定義を drop している。消えるのは関数の定義だけです。
-- =====================================================================

-- 絞り込み指定（列名 → 値の配列）から、その列ぶんを取り出す。
-- 指定が無ければ null（＝その列では絞らない）。
-- immutable なので、行ごとではなく一度だけ評価される。
create or replace function public.jsonb_pick(f jsonb, k text)
returns text[] language sql immutable as $$
  select case
    when f is null or not (f ? k) or jsonb_typeof(f -> k) <> 'array' then null
    when jsonb_array_length(f -> k) = 0 then array['__afd_none__']
    else array(select jsonb_array_elements_text(f -> k))
  end
$$;

drop function if exists public.dash_conversions(date, date, text[], text[], text, integer, integer, text[]);

-- 成果データの明細。
--   p_filters : 列ごとの絞り込み {"device":["パソコン"],"status":["承認"]}
--   p_sort    : 並べ替える列名（既定 occurred_at）
--   p_dir     : 'asc' か 'desc'
create or replace function public.dash_conversions(
  p_from date,
  p_to date,
  p_statuses text[] default null,
  p_advertisers text[] default null,
  p_search text default null,
  p_limit integer default 200,
  p_offset integer default 0,
  p_affiliates text[] default null,
  p_filters jsonb default null,
  p_sort text default 'occurred_at',
  p_dir text default 'desc'
) returns table(
  order_id text, occurred_at timestamptz, advertiser_id text, affiliate_id text,
  product_name text, ad_name text, campaign text, qty numeric, sale_price numeric,
  reward numeric, reward_rate text, status text, pay_status text,
  device text, os text, first_referrer text, total_count bigint
) language sql security invoker stable as $$
  with n as (
    select count(*) as total
    from public.conversions c
    where c.occurred_at >= public.jst_start(p_from)
      and c.occurred_at <  public.jst_start(p_to + 1)
      and (p_statuses is null or array_length(p_statuses, 1) is null or c.status = any(p_statuses))
      and (p_advertisers is null or array_length(p_advertisers, 1) is null or c.advertiser_id = any(p_advertisers))
      and (p_affiliates is null or array_length(p_affiliates, 1) is null or c.affiliate_id = any(p_affiliates))
      and (public.jsonb_pick(p_filters,'status')        is null or c.status        = any(public.jsonb_pick(p_filters,'status')))
      and (public.jsonb_pick(p_filters,'advertiser_id') is null or c.advertiser_id = any(public.jsonb_pick(p_filters,'advertiser_id')))
      and (public.jsonb_pick(p_filters,'affiliate_id')  is null or c.affiliate_id  = any(public.jsonb_pick(p_filters,'affiliate_id')))
      and (public.jsonb_pick(p_filters,'product_name')  is null or c.product_name  = any(public.jsonb_pick(p_filters,'product_name')))
      and (public.jsonb_pick(p_filters,'ad_name')       is null or c.ad_name       = any(public.jsonb_pick(p_filters,'ad_name')))
      and (public.jsonb_pick(p_filters,'campaign')      is null or c.campaign      = any(public.jsonb_pick(p_filters,'campaign')))
      and (public.jsonb_pick(p_filters,'reward_rate')   is null or c.reward_rate   = any(public.jsonb_pick(p_filters,'reward_rate')))
      and (public.jsonb_pick(p_filters,'pay_status')    is null or c.pay_status    = any(public.jsonb_pick(p_filters,'pay_status')))
      and (public.jsonb_pick(p_filters,'device')        is null or c.device        = any(public.jsonb_pick(p_filters,'device')))
      and (public.jsonb_pick(p_filters,'os')            is null or c.os            = any(public.jsonb_pick(p_filters,'os')))
      and (p_search is null or p_search = ''
           or c.product_name   ilike '%' || p_search || '%'
           or c.ad_name        ilike '%' || p_search || '%'
           or c.affiliate_id   ilike '%' || p_search || '%'
           or c.campaign       ilike '%' || p_search || '%'
           or c.order_id       ilike '%' || p_search || '%'
           or c.first_referrer ilike '%' || p_search || '%')
  )
  select
    c.order_id, c.occurred_at, c.advertiser_id, c.affiliate_id,
    c.product_name, c.ad_name, c.campaign, c.qty, c.sale_price,
    c.reward, c.reward_rate, c.status, c.pay_status,
    c.device, c.os, c.first_referrer, n.total
  from public.conversions c cross join n
  where c.occurred_at >= public.jst_start(p_from)
    and c.occurred_at <  public.jst_start(p_to + 1)
    and (p_statuses is null or array_length(p_statuses, 1) is null or c.status = any(p_statuses))
    and (p_advertisers is null or array_length(p_advertisers, 1) is null or c.advertiser_id = any(p_advertisers))
    and (p_affiliates is null or array_length(p_affiliates, 1) is null or c.affiliate_id = any(p_affiliates))
    and (public.jsonb_pick(p_filters,'status')        is null or c.status        = any(public.jsonb_pick(p_filters,'status')))
    and (public.jsonb_pick(p_filters,'advertiser_id') is null or c.advertiser_id = any(public.jsonb_pick(p_filters,'advertiser_id')))
    and (public.jsonb_pick(p_filters,'affiliate_id')  is null or c.affiliate_id  = any(public.jsonb_pick(p_filters,'affiliate_id')))
    and (public.jsonb_pick(p_filters,'product_name')  is null or c.product_name  = any(public.jsonb_pick(p_filters,'product_name')))
    and (public.jsonb_pick(p_filters,'ad_name')       is null or c.ad_name       = any(public.jsonb_pick(p_filters,'ad_name')))
    and (public.jsonb_pick(p_filters,'campaign')      is null or c.campaign      = any(public.jsonb_pick(p_filters,'campaign')))
    and (public.jsonb_pick(p_filters,'reward_rate')   is null or c.reward_rate   = any(public.jsonb_pick(p_filters,'reward_rate')))
    and (public.jsonb_pick(p_filters,'pay_status')    is null or c.pay_status    = any(public.jsonb_pick(p_filters,'pay_status')))
    and (public.jsonb_pick(p_filters,'device')        is null or c.device        = any(public.jsonb_pick(p_filters,'device')))
    and (public.jsonb_pick(p_filters,'os')            is null or c.os            = any(public.jsonb_pick(p_filters,'os')))
    and (p_search is null or p_search = ''
         or c.product_name   ilike '%' || p_search || '%'
         or c.ad_name        ilike '%' || p_search || '%'
         or c.affiliate_id   ilike '%' || p_search || '%'
         or c.campaign       ilike '%' || p_search || '%'
         or c.order_id       ilike '%' || p_search || '%'
         or c.first_referrer ilike '%' || p_search || '%')
  -- 並べ替え。使わない行は null になるので、指定した列だけが効く。
  -- 既定（発生日時の新しい順）は occurred_at の索引をそのまま使える。
  order by
    (case when p_sort = 'occurred_at' and p_dir = 'asc'  then c.occurred_at end) asc  nulls last,
    (case when p_sort = 'occurred_at' and p_dir = 'desc' then c.occurred_at end) desc nulls last,
    (case when p_dir = 'asc' then
       case p_sort when 'qty' then c.qty when 'sale_price' then c.sale_price
                   when 'reward' then c.reward end end) asc nulls last,
    (case when p_dir = 'desc' then
       case p_sort when 'qty' then c.qty when 'sale_price' then c.sale_price
                   when 'reward' then c.reward end end) desc nulls last,
    (case when p_dir = 'asc' then
       case p_sort when 'advertiser_id' then c.advertiser_id when 'affiliate_id' then c.affiliate_id
                   when 'product_name' then c.product_name   when 'ad_name' then c.ad_name
                   when 'campaign' then c.campaign           when 'status' then c.status
                   when 'pay_status' then c.pay_status       when 'device' then c.device
                   when 'os' then c.os                       when 'reward_rate' then c.reward_rate
                   when 'order_id' then c.order_id           when 'first_referrer' then c.first_referrer
       end end) asc nulls last,
    (case when p_dir = 'desc' then
       case p_sort when 'advertiser_id' then c.advertiser_id when 'affiliate_id' then c.affiliate_id
                   when 'product_name' then c.product_name   when 'ad_name' then c.ad_name
                   when 'campaign' then c.campaign           when 'status' then c.status
                   when 'pay_status' then c.pay_status       when 'device' then c.device
                   when 'os' then c.os                       when 'reward_rate' then c.reward_rate
                   when 'order_id' then c.order_id           when 'first_referrer' then c.first_referrer
       end end) desc nulls last
  limit greatest(p_limit, 1) offset greatest(p_offset, 0)
$$;

-- 列フィルタに出す「値の候補」を、多い順に返す。
-- ほかの列の絞り込みは効かせるが、自分自身の絞り込みは外す
-- （表計算ソフトと同じ。外さないと、いま選んでいる値しか出てこなくなる）。
create or replace function public.dash_conversion_values(
  p_from date,
  p_to date,
  p_col text,
  p_statuses text[] default null,
  p_advertisers text[] default null,
  p_affiliates text[] default null,
  p_search text default null,
  p_filters jsonb default null,
  p_limit integer default 500
) returns table(value text, n bigint) language sql security invoker stable as $$
  with g as (select coalesce(p_filters, '{}'::jsonb) - p_col as f)
  select
    coalesce(nullif(case p_col
      when 'status'        then c.status
      when 'advertiser_id' then c.advertiser_id
      when 'affiliate_id'  then c.affiliate_id
      when 'product_name'  then c.product_name
      when 'ad_name'       then c.ad_name
      when 'campaign'      then c.campaign
      when 'reward_rate'   then c.reward_rate
      when 'pay_status'    then c.pay_status
      when 'device'        then c.device
      when 'os'            then c.os
    end, ''), '(なし)') as value,
    count(*) as n
  from public.conversions c cross join g
  where c.occurred_at >= public.jst_start(p_from)
    and c.occurred_at <  public.jst_start(p_to + 1)
    and (p_statuses is null or array_length(p_statuses, 1) is null or c.status = any(p_statuses))
    and (p_advertisers is null or array_length(p_advertisers, 1) is null or c.advertiser_id = any(p_advertisers))
    and (p_affiliates is null or array_length(p_affiliates, 1) is null or c.affiliate_id = any(p_affiliates))
    and (public.jsonb_pick(g.f,'status')        is null or c.status        = any(public.jsonb_pick(g.f,'status')))
    and (public.jsonb_pick(g.f,'advertiser_id') is null or c.advertiser_id = any(public.jsonb_pick(g.f,'advertiser_id')))
    and (public.jsonb_pick(g.f,'affiliate_id')  is null or c.affiliate_id  = any(public.jsonb_pick(g.f,'affiliate_id')))
    and (public.jsonb_pick(g.f,'product_name')  is null or c.product_name  = any(public.jsonb_pick(g.f,'product_name')))
    and (public.jsonb_pick(g.f,'ad_name')       is null or c.ad_name       = any(public.jsonb_pick(g.f,'ad_name')))
    and (public.jsonb_pick(g.f,'campaign')      is null or c.campaign      = any(public.jsonb_pick(g.f,'campaign')))
    and (public.jsonb_pick(g.f,'reward_rate')   is null or c.reward_rate   = any(public.jsonb_pick(g.f,'reward_rate')))
    and (public.jsonb_pick(g.f,'pay_status')    is null or c.pay_status    = any(public.jsonb_pick(g.f,'pay_status')))
    and (public.jsonb_pick(g.f,'device')        is null or c.device        = any(public.jsonb_pick(g.f,'device')))
    and (public.jsonb_pick(g.f,'os')            is null or c.os            = any(public.jsonb_pick(g.f,'os')))
    and (p_search is null or p_search = ''
         or c.product_name   ilike '%' || p_search || '%'
         or c.ad_name        ilike '%' || p_search || '%'
         or c.affiliate_id   ilike '%' || p_search || '%'
         or c.campaign       ilike '%' || p_search || '%'
         or c.order_id       ilike '%' || p_search || '%'
         or c.first_referrer ilike '%' || p_search || '%')
  group by 1
  order by 2 desc, 1
  limit greatest(p_limit, 1)
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
