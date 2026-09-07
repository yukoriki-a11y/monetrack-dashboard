-- =====================================================================
--  追加分: 「比較」タブ用の関数
--
--  すでに schema.sql を実行済みのプロジェクトに、この1本だけ足すためのファイル。
--  Supabase の SQL Editor に全文貼って Run してください。
--  （テーブルは触りません。関数の作成と権限付与だけです）
--
--  新規に作る場合は schema.sql にも同じ関数が入っているので、こちらは不要です。
-- =====================================================================

-- 選んだアフィリエイター（または広告主）ごとの時系列を返す。
-- 「この人はどのくらい動いているのか」を線グラフで並べて見るためのもの。
--   p_dim  : 'affiliate' | 'advertiser'
--   p_keys : 見たいIDの配列。null なら売上上位を p_limit 件だけ自動で選ぶ
--   p_grain: 'day' | 'week' | 'month'
create or replace function public.dash_compare(
  p_from date,
  p_to date,
  p_statuses text[] default null,
  p_dim text default 'affiliate',
  p_keys text[] default null,
  p_grain text default 'day',
  p_limit integer default 5
) returns table(
  series text, bucket date, conversions bigint,
  sales numeric, reward numeric, clicks bigint, cvr numeric
) language sql security invoker stable as $$
  with g as (
    select case when p_grain in ('day', 'week', 'month') then p_grain else 'day' end as unit
  ), picked as (
    -- 明示的に指定されたIDがあればそれを使う
    select u.k
    from unnest(coalesce(p_keys, '{}'::text[])) as u(k)
    where p_keys is not null and array_length(p_keys, 1) is not null
    union all
    -- 指定が無ければ、期間内の売上上位を自動で選ぶ
    select t.k from (
      select case p_dim when 'advertiser' then c.advertiser_id else c.affiliate_id end as k,
             coalesce(sum(c.sale_price), 0) as s
      from public.conversions c
      where (p_keys is null or array_length(p_keys, 1) is null)
        and c.occurred_at >= public.jst_start(p_from)
        and c.occurred_at <  public.jst_start(p_to + 1)
        and (p_statuses is null or array_length(p_statuses, 1) is null or c.status = any(p_statuses))
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
      and (case p_dim when 'advertiser' then k2.advertiser_id else k2.affiliate_id end)
          in (select p.k from picked p)
    group by 1, 2
  )
  select
    coalesce(cv.k, ck.k),
    coalesce(cv.b, ck.b),
    coalesce(cv.n, 0),
    coalesce(cv.s, 0),
    coalesce(cv.r, 0),
    coalesce(ck.n, 0),
    case when coalesce(ck.n, 0) = 0 then null
         else round(coalesce(cv.n, 0)::numeric * 100 / ck.n, 2) end
  from cv full outer join ck on cv.k = ck.k and cv.b = ck.b
  order by 1, 2
$$;

grant execute on function
  public.dash_compare(date, date, text[], text, text[], text, integer)
  to authenticated;
