-- =====================================================================
--  dash_dimension に「何順で上位を取るか」を足す
--
--  これまで dash_dimension は
--      order by 成果件数 desc  limit p_limit
--  だった。画面では売上を出しているのに、DBは成果件数の多い順に
--  切り出して返していたので、上位◯◯・上位商品の並びが金額順に
--  ならなかった。
--
--  前回、返ってきた行を画面側で売上順に並べ替えたが、それでは足りない。
--  「成果件数の多い8件」を売上順に並べ直しているだけで、本当に売上が
--  大きい商品がその8件に入っていないと出てこない。
--  取り出す時点の順番を変える必要がある。
--
--  そこで p_order を足して、売上 / 成果件数 / 報酬 / クリック の
--  どれで上位を取るかを呼び出し側から指定できるようにする。
--  既定は売上（画面でいちばん多く使うため）。
--  集計の中身は今までとまったく同じで、並び順だけを変えている。
--
--  Supabase の SQL Editor に全文貼って Run。
--  テーブルとデータには触りません。関数の作り直しだけです。
--
--  ⚠ 「destructive operations」の警告が出ます
--     引数が増えると create or replace では差し替えにならないため、
--     先に古い定義を drop している。消えるのは関数の定義だけです。
-- =====================================================================

drop function if exists public.dash_dimension(date, date, text[], text[], text, integer, text, text[]);

-- 軸ごとの集計。
--   p_dim   : 集計する軸
--   p_order : 上位を取るときの基準（sales / conversions / reward / clicks）
--             画面に出している数字と揃えないと、上位の切り出しがずれる
create or replace function public.dash_dimension(
  p_from date,
  p_to date,
  p_statuses text[] default null,
  p_advertisers text[] default null,
  p_dim text default 'product',
  p_limit integer default 50,
  p_affiliate text default null,
  p_affiliates text[] default null,
  p_order text default 'sales'
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
  -- 指定された基準で上位を取る。使わない行は null になるので、指定したものだけが効く。
  order by
    (case when p_order = 'conversions' then coalesce(cv.n, 0) end) desc nulls last,
    (case when p_order = 'reward'      then coalesce(cv.r, 0) end) desc nulls last,
    (case when p_order = 'clicks'      then coalesce(ck.n, 0) end) desc nulls last,
    (case when p_order not in ('conversions','reward','clicks')
          then coalesce(cv.s, 0) end) desc nulls last,
    coalesce(cv.n, 0) desc, coalesce(ck.n, 0) desc
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
