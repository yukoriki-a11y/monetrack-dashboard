-- =====================================================================
--  いまのプロジェクトに適用が必要な差分をまとめたもの
--
--  Supabase の SQL Editor に全文貼って Run を1回押せば完了します。
--  何度実行しても同じ結果になります。テーブルとデータには触りません。
--
--  中身
--   1) 再取り込み時のステータス判定（保留→確定の前進だけ反映）
--   2) アフィリエイターでの絞り込み / 比較機能 / フィルタ一覧の拡張
--
--  ⚠ 「This query includes destructive operations」の警告が出ます。
--     関数の引数が増えるため古い定義を drop しているだけで、
--     取り込んだデータは消えません。
-- =====================================================================


-- =====================================================================
--  追加分: 再取り込み時のステータスの扱いを変更する
--
--  すでに schema.sql を実行済みのプロジェクトに、この差分だけ流すファイル。
--  Supabase の SQL Editor に全文貼って Run してください。
--  （テーブルは触りません。関数の作り直しと権限付与だけです）
--
--  変更内容
--   これまで: 同じ注文IDは無条件で上書き
--             → 古いファイルを入れ直すと「承認」が「保留」に戻ってしまう
--   これから: 保留 → 確定（承認/却下）の前進だけ反映し、確定は巻き戻さない。
--             完全に同じ内容なら書き込み自体をしない（据え置き）
-- =====================================================================

-- ステータスの決め方をひとつの関数にまとめる。
-- 「保留」以外（承認 / 却下 / 否認 など）はすべて確定として扱うので、
-- ラベルが増えても直す必要はない。
create or replace function public.resolve_status(
  p_old text,
  p_new text,
  p_old_at timestamptz,
  p_new_at timestamptz
) returns text language sql immutable as $$
  select case
    -- 新規（既存が無い）
    when p_old is null then p_new
    -- 保留 → 確定 は前進なので採用する
    when p_old = '保留' and p_new is not null and p_new <> '保留' then p_new
    -- 確定 → 保留 は巻き戻しなので採用しない（古いファイルの入れ直し事故を防ぐ）
    when p_old <> '保留' and p_new = '保留' then p_old
    -- 確定同士で中身が違うときは、ステータス変更日が新しい方を採用する
    when p_old is distinct from p_new
         and p_new_at is not null
         and (p_old_at is null or p_new_at > p_old_at) then p_new
    -- それ以外は既存のまま
    else p_old
  end
$$;

-- 成果データの取り込み（1チャンクぶん）
create or replace function public.import_conversions_chunk(
  p_rows      jsonb,
  p_file_name text
) returns jsonb
language plpgsql security invoker as $$
declare
  v_inserted integer := 0;
  v_updated  integer := 0;
  v_total    integer := jsonb_array_length(p_rows);
begin
  with src as (
    select * from jsonb_to_recordset(p_rows) as x(
      order_id text, occurred_at timestamptz, product_id text, advertiser_id text,
      product_name text, qty numeric, unit_price numeric, affiliate_id text,
      reward numeric, reward_rate text, pay_status1 text, tier2_id text,
      tier2_reward numeric, tier2_rate text, pay_status2 text, sale_price numeric,
      campaign text, ad_name text, status text, pay_status text, billed_on date,
      last_click_at timestamptz, last_referrer text, first_click_at timestamptz,
      first_referrer text, device text, os text, status_changed_at timestamptz, memo text
    )
  ), todo as (
    -- 既存行と突き合わせて「これから書き込む姿」を作り、
    -- 既存と1つも違わない行はここで落とす（= 据え置き）
    select
      s.order_id, s.occurred_at, s.product_id, s.advertiser_id, s.product_name,
      s.qty, s.unit_price, s.affiliate_id, s.reward, s.reward_rate, s.pay_status1,
      s.tier2_id, s.tier2_reward, s.tier2_rate, s.pay_status2, s.sale_price,
      s.campaign, s.ad_name,
      public.resolve_status(c.status, s.status, c.status_changed_at, s.status_changed_at) as status,
      s.pay_status, s.billed_on, s.last_click_at, s.last_referrer,
      s.first_click_at, s.first_referrer, s.device, s.os,
      -- 採用したステータスに対応する変更日を持たせる
      case when public.resolve_status(c.status, s.status, c.status_changed_at, s.status_changed_at)
                is distinct from c.status
           then s.status_changed_at
           else c.status_changed_at end as status_changed_at,
      s.memo
    from src s
    left join public.conversions c on c.order_id = s.order_id
    where c.order_id is null
       or row(
            c.occurred_at, c.product_id, c.advertiser_id, c.product_name, c.qty, c.unit_price,
            c.affiliate_id, c.reward, c.reward_rate, c.pay_status1, c.tier2_id, c.tier2_reward,
            c.tier2_rate, c.pay_status2, c.sale_price, c.campaign, c.ad_name,
            c.status, c.pay_status, c.billed_on, c.last_click_at, c.last_referrer,
            c.first_click_at, c.first_referrer, c.device, c.os, c.status_changed_at, c.memo
          ) is distinct from row(
            s.occurred_at, s.product_id, s.advertiser_id, s.product_name, s.qty, s.unit_price,
            s.affiliate_id, s.reward, s.reward_rate, s.pay_status1, s.tier2_id, s.tier2_reward,
            s.tier2_rate, s.pay_status2, s.sale_price, s.campaign, s.ad_name,
            public.resolve_status(c.status, s.status, c.status_changed_at, s.status_changed_at),
            s.pay_status, s.billed_on, s.last_click_at, s.last_referrer,
            s.first_click_at, s.first_referrer, s.device, s.os,
            case when public.resolve_status(c.status, s.status, c.status_changed_at, s.status_changed_at)
                      is distinct from c.status
                 then s.status_changed_at
                 else c.status_changed_at end,
            s.memo
          )
  ), up as (
    insert into public.conversions (
      order_id, occurred_at, product_id, advertiser_id, product_name, qty, unit_price,
      affiliate_id, reward, reward_rate, pay_status1, tier2_id, tier2_reward, tier2_rate,
      pay_status2, sale_price, campaign, ad_name, status, pay_status, billed_on,
      last_click_at, last_referrer, first_click_at, first_referrer, device, os,
      status_changed_at, memo, source_file)
    select
      t.order_id, t.occurred_at, t.product_id, t.advertiser_id, t.product_name, t.qty, t.unit_price,
      t.affiliate_id, t.reward, t.reward_rate, t.pay_status1, t.tier2_id, t.tier2_reward, t.tier2_rate,
      t.pay_status2, t.sale_price, t.campaign, t.ad_name, t.status, t.pay_status, t.billed_on,
      t.last_click_at, t.last_referrer, t.first_click_at, t.first_referrer, t.device, t.os,
      t.status_changed_at, t.memo, p_file_name
    from todo t
    on conflict (order_id) do update set
      occurred_at       = excluded.occurred_at,
      product_id        = excluded.product_id,
      advertiser_id     = excluded.advertiser_id,
      product_name      = excluded.product_name,
      qty               = excluded.qty,
      unit_price        = excluded.unit_price,
      affiliate_id      = excluded.affiliate_id,
      reward            = excluded.reward,
      reward_rate       = excluded.reward_rate,
      pay_status1       = excluded.pay_status1,
      tier2_id          = excluded.tier2_id,
      tier2_reward      = excluded.tier2_reward,
      tier2_rate        = excluded.tier2_rate,
      pay_status2       = excluded.pay_status2,
      sale_price        = excluded.sale_price,
      campaign          = excluded.campaign,
      ad_name           = excluded.ad_name,
      status            = excluded.status,          -- ここは既に resolve 済みの値
      pay_status        = excluded.pay_status,
      billed_on         = excluded.billed_on,
      last_click_at     = excluded.last_click_at,
      last_referrer     = excluded.last_referrer,
      first_click_at    = excluded.first_click_at,
      first_referrer    = excluded.first_referrer,
      device            = excluded.device,
      os                = excluded.os,
      status_changed_at = excluded.status_changed_at,
      memo              = excluded.memo,
      source_file       = excluded.source_file,
      updated_at        = now()
    returning (xmax = 0) as was_insert
  )
  select
    count(*) filter (where up.was_insert),
    count(*) filter (where not up.was_insert)
  into v_inserted, v_updated
  from up;

  return jsonb_build_object(
    'total', v_total,
    'inserted', v_inserted,
    'updated', v_updated,
    -- 既存と1つも違わなかった行（書き込みをしていない）
    'stayed', v_total - v_inserted - v_updated,
    'skipped', v_total - v_inserted - v_updated);
end $$;

grant execute on function public.resolve_status(text, text, timestamptz, timestamptz) to authenticated;
grant execute on function public.import_conversions_chunk(jsonb, text) to authenticated;


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
