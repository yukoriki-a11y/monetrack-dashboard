-- =====================================================================
--  成果明細を軽くする
--
--  これまでの dash_conversions は、条件に合う行をいったん全部
--  CTE に貯めてから（= 一時ファイルに書き出してから）並べ替えて
--  100件を切り出していた。1回呼ぶたびに数MBのディスク書き込みが
--  発生するので、続けて呼ぶと詰まって「statement timeout」で
--  画面が真っ白になることがあった。
--
--  件数の数え上げだけを別にして、本体は occurred_at の索引を
--  そのまま使って上から100件取るように書き換える。
--  返す中身と引数は今までと同じなので、画面側の変更は要らない。
--
--  Supabase の SQL Editor に全文貼って Run。
--  テーブルとデータには触りません。関数の作り直しだけです。
--
--  ⚠ 「destructive operations」の警告が出ます
--     消えるのは dash_conversions の古い定義だけです。
-- =====================================================================

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
  -- 件数は数えるだけ（1行しか返らないので貯め込みが起きない）
  with n as (
    select count(*) as total
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
  )
  -- 本体は occurred_at の索引を新しい順にたどって、必要なぶんだけ取る
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
    and (p_search is null or p_search = ''
         or c.product_name   ilike '%' || p_search || '%'
         or c.ad_name        ilike '%' || p_search || '%'
         or c.affiliate_id   ilike '%' || p_search || '%'
         or c.campaign       ilike '%' || p_search || '%'
         or c.order_id       ilike '%' || p_search || '%'
         or c.first_referrer ilike '%' || p_search || '%')
  order by c.occurred_at desc
  limit greatest(p_limit, 1) offset greatest(p_offset, 0)
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
