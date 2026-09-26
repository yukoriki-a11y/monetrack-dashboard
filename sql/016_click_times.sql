-- =====================================================================
--  成果データに「最初のクリック」「最後のクリック」「ステータス変更日」を出す
--
--  この3つは取り込み時から conversions に保存してあったが、
--  dash_conversions が返していなかったので画面から見えなかった。
--
--  なぜ要るか:
--    2026-09-25 に、8月末〜9月中旬にクリックされた注文 約1,500件が
--    まとめて登録され、売上が10倍に見える日ができた。
--    これを見抜けたのは「ステータス変更日が全件同じ日」だったから。
--    同じことが起きたときに画面だけで気づけるようにする。
--    報酬率がクッキーの古さで下がる件（初回クリックからの経過日数）の
--    調査にも毎回必要になる。
--
--  返す列が増えるので、いったん drop してから作り直す。
--  消えるのは関数の定義だけで、データには触らない。
--
--  Supabase の SQL Editor に全文貼って Run。
-- =====================================================================

drop function if exists public.dash_conversions(date, date, text[], text[], text, integer, integer, text[], jsonb, text, text);

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
  device text, os text, first_referrer text,
  first_click_at timestamptz, last_click_at timestamptz, status_changed_at timestamptz,
  total_count bigint
) language plpgsql security invoker stable as $fn$
declare
  st  text[] := case when p_statuses    is null then null when array_length(p_statuses,1)    is null then array['__afd_none__'] else p_statuses end;
  adv text[] := case when p_advertisers is null then null when array_length(p_advertisers,1) is null then array['__afd_none__'] else p_advertisers end;
  aff text[] := case when p_affiliates  is null then null when array_length(p_affiliates,1)  is null then array['__afd_none__'] else p_affiliates end;
  f1 text[] := public.jsonb_pick(p_filters, 'status');
  f2 text[] := public.jsonb_pick(p_filters, 'advertiser_id');
  f3 text[] := public.jsonb_pick(p_filters, 'affiliate_id');
  f4 text[] := public.jsonb_pick(p_filters, 'product_name');
  f5 text[] := public.jsonb_pick(p_filters, 'ad_name');
  f6 text[] := public.jsonb_pick(p_filters, 'campaign');
  f7 text[] := public.jsonb_pick(p_filters, 'reward_rate');
  f8 text[] := public.jsonb_pick(p_filters, 'pay_status');
  f9 text[] := public.jsonb_pick(p_filters, 'device');
  f10 text[] := public.jsonb_pick(p_filters, 'os');
  w text := public.dash_conv_where();
  v_total bigint;
  v_sort text;
  v_dir text;
begin
  execute 'select count(*) from public.conversions c where ' || w
    into v_total
    using p_from, p_to, st, adv, aff, f1, f2, f3, f4, f5, f6, f7, f8, f9, f10, p_search;

  v_sort := case p_sort
    when 'advertiser_id'     then 'c.advertiser_id'
    when 'affiliate_id'      then 'c.affiliate_id'
    when 'product_name'      then 'c.product_name'
    when 'ad_name'           then 'c.ad_name'
    when 'campaign'          then 'c.campaign'
    when 'status'            then 'c.status'
    when 'pay_status'        then 'c.pay_status'
    when 'device'            then 'c.device'
    when 'os'                then 'c.os'
    when 'reward_rate'       then 'c.reward_rate'
    when 'order_id'          then 'c.order_id'
    when 'first_referrer'    then 'c.first_referrer'
    when 'first_click_at'    then 'c.first_click_at'
    when 'last_click_at'     then 'c.last_click_at'
    when 'status_changed_at' then 'c.status_changed_at'
    when 'qty'               then 'c.qty'
    when 'sale_price'        then 'c.sale_price'
    when 'reward'            then 'c.reward'
    else 'c.occurred_at'
  end;
  v_dir := case when lower(coalesce(p_dir, 'desc')) = 'asc' then 'asc' else 'desc' end;

  -- format() は使わない。絞り込みの文に ilike の % が入っていて、
  -- 書式指定と誤解されるため。つなぎ合わせだけにする。
  return query execute
    'select c.order_id, c.occurred_at, c.advertiser_id, c.affiliate_id,
            c.product_name, c.ad_name, c.campaign, c.qty, c.sale_price,
            c.reward, c.reward_rate, c.status, c.pay_status,
            c.device, c.os, c.first_referrer,
            c.first_click_at, c.last_click_at, c.status_changed_at, ' || v_total::text || '::bigint
     from public.conversions c
     where ' || w || '
     order by ' || v_sort || ' ' || v_dir || ' nulls last
     limit $17 offset $18'
    using p_from, p_to, st, adv, aff, f1, f2, f3, f4, f5, f6, f7, f8, f9, f10, p_search,
          greatest(p_limit, 1), greatest(p_offset, 0);
end
$fn$;

-- 作り直した関数には既定で PUBLIC 実行権が付くので剥がし直す（013 と同じ）
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
