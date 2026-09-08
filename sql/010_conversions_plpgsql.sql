-- =====================================================================
--  成果データを、パラメータで呼ばれても速いように作り直す
--
--  経緯:
--   008 … 列フィルタを足したら、jsonb_pick が行ごとに評価されて重くなった
--   009 … 配列を CTE に追い出したが、まだ遅い
--
--  残っていた原因は「引数がパラメータのままだと計画が固まらない」こと。
--   ・order by の case 式が畳み込めないので occurred_at の索引が使えない
--   ・件数の数え上げと本体を cross join でつないでいるため、
--     見積りを外すと組み合わせ方まで悪くなる
--  SQLエディタでリテラルを書くと畳み込まれて速く見えるので、
--  この形では何度測っても本番の遅さを再現できなかった。
--
--  そこで、
--   1. 列フィルタの配列は手続きの変数として先に1回だけ作る
--   2. 件数は別の文で数える（本体と join しない）
--   3. 本体の order by は、許可した列名だけを文字列として埋め込む
--      → 実行される文は「order by c.occurred_at desc」のような
--         ただの並べ替えになり、索引がそのまま使える
--  という形にする。並べ替えの列は決め打ちの一覧から選ぶので、
--  外から来た文字列がそのまま SQL に入ることはない。
--
--  引数も返す列も今までと同じなので、画面側の変更は要りません。
--
--  Supabase の SQL Editor に全文貼って Run。
--  テーブルとデータには触りません。
--
--  ⚠ 言語が変わる（sql → plpgsql）ので先に drop します。
--     消えるのは関数の定義だけです。
-- =====================================================================

drop function if exists public.dash_conversions(date, date, text[], text[], text, integer, integer, text[], jsonb, text, text);
drop function if exists public.dash_conversion_values(date, date, text, text[], text[], text[], text, jsonb, integer);

-- 絞り込みの本体。件数用と明細用で同じものを使う。
-- $1 from / $2 to / $3 statuses / $4 advertisers / $5 affiliates
-- $6..$15 列フィルタ / $16 キーワード
create or replace function public.dash_conv_where() returns text
language sql immutable as $$
  select $w$
    c.occurred_at >= public.jst_start($1::date)
    and c.occurred_at <  public.jst_start($2::date + 1)
    and ($3::text[]  is null or c.status        = any($3::text[]))
    and ($4::text[]  is null or c.advertiser_id = any($4::text[]))
    and ($5::text[]  is null or c.affiliate_id  = any($5::text[]))
    and ($6::text[]  is null or c.status        = any($6::text[]))
    and ($7::text[]  is null or c.advertiser_id = any($7::text[]))
    and ($8::text[]  is null or c.affiliate_id  = any($8::text[]))
    and ($9::text[]  is null or c.product_name  = any($9::text[]))
    and ($10::text[] is null or c.ad_name       = any($10::text[]))
    and ($11::text[] is null or c.campaign      = any($11::text[]))
    and ($12::text[] is null or c.reward_rate   = any($12::text[]))
    and ($13::text[] is null or c.pay_status    = any($13::text[]))
    and ($14::text[] is null or c.device        = any($14::text[]))
    and ($15::text[] is null or c.os            = any($15::text[]))
    and ($16::text is null or $16::text = ''
         or c.product_name   ilike '%' || $16::text || '%'
         or c.ad_name        ilike '%' || $16::text || '%'
         or c.affiliate_id   ilike '%' || $16::text || '%'
         or c.campaign       ilike '%' || $16::text || '%'
         or c.order_id       ilike '%' || $16::text || '%'
         or c.first_referrer ilike '%' || $16::text || '%')
  $w$
$$;

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
) language plpgsql security invoker stable as $fn$
declare
  -- 空配列は「全部外した」なので、どれにも当たらない値にしておく
  st  text[] := case when p_statuses    is null then null when array_length(p_statuses,1)    is null then array['__afd_none__'] else p_statuses end;
  adv text[] := case when p_advertisers is null then null when array_length(p_advertisers,1) is null then array['__afd_none__'] else p_advertisers end;
  aff text[] := case when p_affiliates  is null then null when array_length(p_affiliates,1)  is null then array['__afd_none__'] else p_affiliates end;
  -- 列フィルタの配列は、ここで1回だけ作る（行ごとに作らせない）
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
  -- 件数は別に数える。本体と join しないので、ただの集計で済む。
  execute 'select count(*) from public.conversions c where ' || w
    into v_total
    using p_from, p_to, st, adv, aff, f1, f2, f3, f4, f5, f6, f7, f8, f9, f10, p_search;

  -- 並べ替えの列は、この一覧にあるものだけ。無ければ発生日時に落とす。
  v_sort := case p_sort
    when 'advertiser_id'  then 'c.advertiser_id'
    when 'affiliate_id'   then 'c.affiliate_id'
    when 'product_name'   then 'c.product_name'
    when 'ad_name'        then 'c.ad_name'
    when 'campaign'       then 'c.campaign'
    when 'status'         then 'c.status'
    when 'pay_status'     then 'c.pay_status'
    when 'device'         then 'c.device'
    when 'os'             then 'c.os'
    when 'reward_rate'    then 'c.reward_rate'
    when 'order_id'       then 'c.order_id'
    when 'first_referrer' then 'c.first_referrer'
    when 'qty'            then 'c.qty'
    when 'sale_price'     then 'c.sale_price'
    when 'reward'         then 'c.reward'
    else 'c.occurred_at'
  end;
  v_dir := case when lower(coalesce(p_dir, 'desc')) = 'asc' then 'asc' else 'desc' end;

  -- format() は使わない。絞り込みの文に ilike の % が入っていて、
  -- 書式指定と誤解されるため。つなぎ合わせだけにする。
  return query execute
    'select c.order_id, c.occurred_at, c.advertiser_id, c.affiliate_id,
            c.product_name, c.ad_name, c.campaign, c.qty, c.sale_price,
            c.reward, c.reward_rate, c.status, c.pay_status,
            c.device, c.os, c.first_referrer, ' || v_total::text || '::bigint
     from public.conversions c
     where ' || w || '
     order by ' || v_sort || ' ' || v_dir || ' nulls last
     limit $17 offset $18'
    using p_from, p_to, st, adv, aff, f1, f2, f3, f4, f5, f6, f7, f8, f9, f10, p_search,
          greatest(p_limit, 1), greatest(p_offset, 0);
end
$fn$;

-- 列フィルタに出す「値の候補」。
-- 自分の列の絞り込みは外す（外さないと、いま選んでいる値しか出てこない）。
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
) returns table(value text, n bigint) language plpgsql security invoker stable as $fn$
declare
  st  text[] := case when p_statuses    is null then null when array_length(p_statuses,1)    is null then array['__afd_none__'] else p_statuses end;
  adv text[] := case when p_advertisers is null then null when array_length(p_advertisers,1) is null then array['__afd_none__'] else p_advertisers end;
  aff text[] := case when p_affiliates  is null then null when array_length(p_affiliates,1)  is null then array['__afd_none__'] else p_affiliates end;
  ff jsonb := coalesce(p_filters, '{}'::jsonb) - p_col;
  f1 text[] := public.jsonb_pick(ff, 'status');
  f2 text[] := public.jsonb_pick(ff, 'advertiser_id');
  f3 text[] := public.jsonb_pick(ff, 'affiliate_id');
  f4 text[] := public.jsonb_pick(ff, 'product_name');
  f5 text[] := public.jsonb_pick(ff, 'ad_name');
  f6 text[] := public.jsonb_pick(ff, 'campaign');
  f7 text[] := public.jsonb_pick(ff, 'reward_rate');
  f8 text[] := public.jsonb_pick(ff, 'pay_status');
  f9 text[] := public.jsonb_pick(ff, 'device');
  f10 text[] := public.jsonb_pick(ff, 'os');
  w text := public.dash_conv_where();
  v_col text;
begin
  v_col := case p_col
    when 'status'        then 'c.status'
    when 'advertiser_id' then 'c.advertiser_id'
    when 'affiliate_id'  then 'c.affiliate_id'
    when 'product_name'  then 'c.product_name'
    when 'ad_name'       then 'c.ad_name'
    when 'campaign'      then 'c.campaign'
    when 'reward_rate'   then 'c.reward_rate'
    when 'pay_status'    then 'c.pay_status'
    when 'device'        then 'c.device'
    when 'os'            then 'c.os'
    else null
  end;
  if v_col is null then return; end if;

  return query execute
    'select coalesce(nullif(' || v_col || ', ''''), ''(なし)'') as value, count(*) as n
     from public.conversions c
     where ' || w || '
     group by 1
     order by 2 desc, 1
     limit $17'
    using p_from, p_to, st, adv, aff, f1, f2, f3, f4, f5, f6, f7, f8, f9, f10, p_search,
          greatest(p_limit, 1);
end
$fn$;

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
