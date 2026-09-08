-- =====================================================================
--  成果データの列フィルタを、行ごとに評価しないようにする
--
--  008 では列フィルタの条件を
--    jsonb_pick(p_filters,'status') is null or c.status = any(jsonb_pick(...))
--  と書いていた。jsonb_pick は immutable だが、引数が「関数の引数」
--  （＝定数ではない）ので畳み込まれない。結果、10列×2か所＝20回 ×
--  行数ぶん呼ばれる。9,554行なら約19万回で、8秒の上限に当たる。
--
--  SQLエディタで試すと速く見えるのは、そこでは引数がリテラルなので
--  畳み込まれるから。アプリはパラメータで渡すので畳み込まれない。
--
--  そこで、10列ぶんの配列を CTE で先に1回だけ作り、あとはその値と
--  比べるだけにする。ふつうの text[] 比較になるので、もとからある
--  p_statuses などと同じ速さになる。
--
--  Supabase の SQL Editor に全文貼って Run。
--  テーブルとデータには触りません。関数の作り直しだけです。
--  引数は 008 と同じなので、警告は出ても drop は不要です。
-- =====================================================================

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
  -- 列フィルタの配列は、ここで1回だけ作る。
  -- 2か所から参照するので materialized にして、確実に1回にする。
  with fl as materialized (
    select
      public.jsonb_pick(p_filters, 'status')        as f_status,
      public.jsonb_pick(p_filters, 'advertiser_id') as f_adv,
      public.jsonb_pick(p_filters, 'affiliate_id')  as f_aff,
      public.jsonb_pick(p_filters, 'product_name')  as f_prod,
      public.jsonb_pick(p_filters, 'ad_name')       as f_ad,
      public.jsonb_pick(p_filters, 'campaign')      as f_camp,
      public.jsonb_pick(p_filters, 'reward_rate')   as f_rate,
      public.jsonb_pick(p_filters, 'pay_status')    as f_pay,
      public.jsonb_pick(p_filters, 'device')        as f_dev,
      public.jsonb_pick(p_filters, 'os')            as f_os
  ), n as (
    select count(*) as total
    from public.conversions c cross join fl
    where c.occurred_at >= public.jst_start(p_from)
      and c.occurred_at <  public.jst_start(p_to + 1)
      and (p_statuses is null or array_length(p_statuses, 1) is null or c.status = any(p_statuses))
      and (p_advertisers is null or array_length(p_advertisers, 1) is null or c.advertiser_id = any(p_advertisers))
      and (p_affiliates is null or array_length(p_affiliates, 1) is null or c.affiliate_id = any(p_affiliates))
      and (fl.f_status is null or c.status        = any(fl.f_status))
      and (fl.f_adv    is null or c.advertiser_id = any(fl.f_adv))
      and (fl.f_aff    is null or c.affiliate_id  = any(fl.f_aff))
      and (fl.f_prod   is null or c.product_name  = any(fl.f_prod))
      and (fl.f_ad     is null or c.ad_name       = any(fl.f_ad))
      and (fl.f_camp   is null or c.campaign      = any(fl.f_camp))
      and (fl.f_rate   is null or c.reward_rate   = any(fl.f_rate))
      and (fl.f_pay    is null or c.pay_status    = any(fl.f_pay))
      and (fl.f_dev    is null or c.device        = any(fl.f_dev))
      and (fl.f_os     is null or c.os            = any(fl.f_os))
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
  from public.conversions c cross join n cross join fl
  where c.occurred_at >= public.jst_start(p_from)
    and c.occurred_at <  public.jst_start(p_to + 1)
    and (p_statuses is null or array_length(p_statuses, 1) is null or c.status = any(p_statuses))
    and (p_advertisers is null or array_length(p_advertisers, 1) is null or c.advertiser_id = any(p_advertisers))
    and (p_affiliates is null or array_length(p_affiliates, 1) is null or c.affiliate_id = any(p_affiliates))
    and (fl.f_status is null or c.status        = any(fl.f_status))
    and (fl.f_adv    is null or c.advertiser_id = any(fl.f_adv))
    and (fl.f_aff    is null or c.affiliate_id  = any(fl.f_aff))
    and (fl.f_prod   is null or c.product_name  = any(fl.f_prod))
    and (fl.f_ad     is null or c.ad_name       = any(fl.f_ad))
    and (fl.f_camp   is null or c.campaign      = any(fl.f_camp))
    and (fl.f_rate   is null or c.reward_rate   = any(fl.f_rate))
    and (fl.f_pay    is null or c.pay_status    = any(fl.f_pay))
    and (fl.f_dev    is null or c.device        = any(fl.f_dev))
    and (fl.f_os     is null or c.os            = any(fl.f_os))
    and (p_search is null or p_search = ''
         or c.product_name   ilike '%' || p_search || '%'
         or c.ad_name        ilike '%' || p_search || '%'
         or c.affiliate_id   ilike '%' || p_search || '%'
         or c.campaign       ilike '%' || p_search || '%'
         or c.order_id       ilike '%' || p_search || '%'
         or c.first_referrer ilike '%' || p_search || '%')
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

-- 値の候補も同じ直し方をする
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
  -- 自分の列の絞り込みは外す（外すと候補が減らない＝表計算ソフトと同じ）
  with fl as materialized (
    select
      public.jsonb_pick(f, 'status')        as f_status,
      public.jsonb_pick(f, 'advertiser_id') as f_adv,
      public.jsonb_pick(f, 'affiliate_id')  as f_aff,
      public.jsonb_pick(f, 'product_name')  as f_prod,
      public.jsonb_pick(f, 'ad_name')       as f_ad,
      public.jsonb_pick(f, 'campaign')      as f_camp,
      public.jsonb_pick(f, 'reward_rate')   as f_rate,
      public.jsonb_pick(f, 'pay_status')    as f_pay,
      public.jsonb_pick(f, 'device')        as f_dev,
      public.jsonb_pick(f, 'os')            as f_os
    from (select coalesce(p_filters, '{}'::jsonb) - p_col as f) s
  )
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
  from public.conversions c cross join fl
  where c.occurred_at >= public.jst_start(p_from)
    and c.occurred_at <  public.jst_start(p_to + 1)
    and (p_statuses is null or array_length(p_statuses, 1) is null or c.status = any(p_statuses))
    and (p_advertisers is null or array_length(p_advertisers, 1) is null or c.advertiser_id = any(p_advertisers))
    and (p_affiliates is null or array_length(p_affiliates, 1) is null or c.affiliate_id = any(p_affiliates))
    and (fl.f_status is null or c.status        = any(fl.f_status))
    and (fl.f_adv    is null or c.advertiser_id = any(fl.f_adv))
    and (fl.f_aff    is null or c.affiliate_id  = any(fl.f_aff))
    and (fl.f_prod   is null or c.product_name  = any(fl.f_prod))
    and (fl.f_ad     is null or c.ad_name       = any(fl.f_ad))
    and (fl.f_camp   is null or c.campaign      = any(fl.f_camp))
    and (fl.f_rate   is null or c.reward_rate   = any(fl.f_rate))
    and (fl.f_pay    is null or c.pay_status    = any(fl.f_pay))
    and (fl.f_dev    is null or c.device        = any(fl.f_dev))
    and (fl.f_os     is null or c.os            = any(fl.f_os))
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
