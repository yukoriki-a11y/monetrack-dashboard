-- =====================================================================
--  アフィリエイト分析ダッシュボード / Supabase スキーマ
--
--  使い方: Supabase ダッシュボード → SQL Editor に全文貼り付けて Run。
--  何度実行しても同じ結果になります（冪等）。
--
--  設計メモ
--   * IPアドレスは列自体を作らない。取り込み時にブラウザ側で捨てている。
--   * 成果は「注文ID」を主キーにしているので、再取り込みでは行が増えない。
--     ステータスは「保留 → 確定（承認/却下）」の前進だけ反映し、確定は
--     保留に巻き戻さない（古いファイルを入れ直したときの事故を防ぐ）。
--     既存とまったく同じ内容の行は書き込み自体をしない（据え置き）。
--     判定は resolve_status() に集約してある。
--   * クリックは一意キーが無いので、内容から作った指紋(fingerprint)＋
--     同一内容の通番(dup_seq)で一意化する。同じファイルを何度入れても増えない。
--   * 集計は SQL 側（RPC）で行う。ブラウザに数万行を送らないため。
--   * RETURNS TABLE の列名がテーブル列名と衝突しないよう、
--     関数の中では必ずテーブルに別名を付けて列を修飾している。
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. テーブル
-- ---------------------------------------------------------------------

create table if not exists public.conversions (
  order_id          text primary key,
  occurred_at       timestamptz not null,
  product_id        text,
  advertiser_id     text,
  product_name      text,
  qty               numeric,
  unit_price        numeric,
  affiliate_id      text,
  reward            numeric,          -- 報酬額（円）
  reward_rate       text,             -- 報酬率（"30%" / "¥100" など表記のまま）
  pay_status1       text,
  tier2_id          text,
  tier2_reward      numeric,
  tier2_rate        text,
  pay_status2       text,
  sale_price        numeric,          -- 販売価格
  campaign          text,
  ad_name           text,
  status            text,             -- 承認 / 保留 / 却下
  pay_status        text,             -- 支払い済み / 未確定 / 発行済
  billed_on         date,
  last_click_at     timestamptz,
  last_referrer     text,
  first_click_at    timestamptz,
  first_referrer    text,
  device            text,
  os                text,
  status_changed_at timestamptz,
  memo              text,
  source_file       text,
  imported_at       timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

alter table public.conversions
  add column if not exists first_referrer_host text
  generated always as (substring(first_referrer from '^[a-zA-Z]+://([^/?#]+)')) stored;

create table if not exists public.clicks (
  id            bigserial primary key,
  fingerprint   text not null,
  dup_seq       integer not null default 1,
  clicked_at    timestamptz not null,
  advertiser_id text not null default 'bestkenko',
  affiliate_id  text,
  ad_type       text,
  ad_name       text,
  campaign      text,
  referrer      text,
  os            text,
  source_file   text,
  imported_at   timestamptz not null default now(),
  constraint clicks_dedupe_key unique (fingerprint, dup_seq)
);

alter table public.clicks
  add column if not exists referrer_host text
  generated always as (substring(referrer from '^[a-zA-Z]+://([^/?#]+)')) stored;

create table if not exists public.imports (
  id             bigserial primary key,
  file_name      text not null,
  file_hash      text not null unique,
  kind           text not null,             -- 'conversions' | 'clicks'
  advertiser_id  text,
  row_count      integer,
  inserted_count integer,
  updated_count  integer,
  skipped_count  integer,
  imported_at    timestamptz not null default now(),
  imported_by    uuid default auth.uid()
);

-- ---------------------------------------------------------------------
-- 2. インデックス
-- ---------------------------------------------------------------------
create index if not exists conversions_occurred_at_idx on public.conversions (occurred_at);
create index if not exists conversions_advertiser_idx  on public.conversions (advertiser_id, occurred_at);
create index if not exists conversions_affiliate_idx   on public.conversions (affiliate_id, occurred_at);
create index if not exists conversions_status_idx      on public.conversions (status);
create index if not exists conversions_ad_name_idx     on public.conversions (ad_name);
create index if not exists conversions_product_idx     on public.conversions (product_name);

create index if not exists clicks_clicked_at_idx on public.clicks (clicked_at);
create index if not exists clicks_advertiser_idx on public.clicks (advertiser_id, clicked_at);
create index if not exists clicks_affiliate_idx  on public.clicks (affiliate_id, clicked_at);
create index if not exists clicks_ad_name_idx    on public.clicks (ad_name);

-- ---------------------------------------------------------------------
-- 3. RLS（ログインしたユーザーだけが読み書きできる）
-- ---------------------------------------------------------------------
alter table public.conversions enable row level security;
alter table public.clicks      enable row level security;
alter table public.imports     enable row level security;

do $$
declare t text;
begin
  foreach t in array array['conversions','clicks','imports'] loop
    execute format('drop policy if exists %I on public.%I', t || '_authenticated_all', t);
    execute format(
      'create policy %I on public.%I for all to authenticated using (true) with check (true)',
      t || '_authenticated_all', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 4. 共通ヘルパー
-- ---------------------------------------------------------------------

-- JST の日付 → その日の 00:00 JST（timestamptz）。
-- インデックスが使える形で期間を絞るために使う。
create or replace function public.jst_start(p_day date)
returns timestamptz language sql immutable as $$
  select timezone('Asia/Tokyo', p_day::timestamp)
$$;

-- ---------------------------------------------------------------------
-- 5. 取り込み用 RPC
-- ---------------------------------------------------------------------

-- まったく同じファイルが既に取り込まれていないか確認する。
-- file_hash はファイルのバイト列そのものの SHA-256。
create or replace function public.import_check(p_file_hash text)
returns jsonb language sql security invoker stable as $$
  select coalesce(
    (select jsonb_build_object(
       'found',       true,
       'file_name',   i.file_name,
       'kind',        i.kind,
       'imported_at', i.imported_at,
       'row_count',   i.row_count)
     from public.imports i
     where i.file_hash = p_file_hash),
    jsonb_build_object('found', false))
$$;

-- 取り込み結果を履歴に記録する（同じファイルなら 1 行を上書き）。
create or replace function public.import_record(
  p_file_name     text,
  p_file_hash     text,
  p_kind          text,
  p_advertiser_id text,
  p_row_count     integer,
  p_inserted      integer,
  p_updated       integer,
  p_skipped       integer
) returns void language sql security invoker as $$
  insert into public.imports as i (
    file_name, file_hash, kind, advertiser_id,
    row_count, inserted_count, updated_count, skipped_count)
  values (
    p_file_name, p_file_hash, p_kind, p_advertiser_id,
    p_row_count, p_inserted, p_updated, p_skipped)
  on conflict (file_hash) do update set
    file_name      = excluded.file_name,
    kind           = excluded.kind,
    advertiser_id  = excluded.advertiser_id,
    row_count      = excluded.row_count,
    inserted_count = excluded.inserted_count,
    updated_count  = excluded.updated_count,
    skipped_count  = excluded.skipped_count,
    imported_at    = now(),
    imported_by    = auth.uid();
$$;

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


-- クリックデータの取り込み。既存と同一の (fingerprint, dup_seq) は無視される。
create or replace function public.import_clicks_chunk(
  p_rows          jsonb,
  p_file_name     text,
  p_advertiser_id text default 'bestkenko'
) returns jsonb
language plpgsql security invoker as $$
declare
  v_inserted integer := 0;
  v_total    integer := jsonb_array_length(p_rows);
begin
  with src as (
    select * from jsonb_to_recordset(p_rows) as x(
      fingerprint text, dup_seq integer, clicked_at timestamptz, affiliate_id text,
      ad_type text, ad_name text, campaign text, referrer text, os text
    )
  ), ins as (
    insert into public.clicks (
      fingerprint, dup_seq, clicked_at, advertiser_id, affiliate_id,
      ad_type, ad_name, campaign, referrer, os, source_file)
    select
      s.fingerprint, s.dup_seq, s.clicked_at, p_advertiser_id, s.affiliate_id,
      s.ad_type, s.ad_name, s.campaign, s.referrer, s.os, p_file_name
    from src s
    on conflict (fingerprint, dup_seq) do nothing
    returning 1 as ok
  )
  select count(*) into v_inserted from ins;

  return jsonb_build_object(
    'total', v_total, 'inserted', v_inserted, 'updated', 0,
    'skipped', v_total - v_inserted);
end $$;

-- ---------------------------------------------------------------------
-- 6. 分析用 RPC
-- ---------------------------------------------------------------------


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

-- 成果データの明細と、列フィルタの値候補
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
-- アフィリエイター 1 人の内訳（流入元・広告・商品・日別）
create or replace function public.dash_affiliate_detail(
  p_affiliate text,
  p_from date,
  p_to date,
  p_statuses text[] default null,
  p_advertisers text[] default null
) returns jsonb language sql security invoker stable as $$
  with cv as (
    select c.*
    from public.conversions c
    where c.affiliate_id = p_affiliate
      and c.occurred_at >= public.jst_start(p_from)
      and c.occurred_at <  public.jst_start(p_to + 1)
      and (p_statuses is null or array_length(p_statuses, 1) is null or c.status = any(p_statuses))
      and (p_advertisers is null or array_length(p_advertisers, 1) is null or c.advertiser_id = any(p_advertisers))
  ), ck as (
    select k.*
    from public.clicks k
    where k.affiliate_id = p_affiliate
      and k.clicked_at >= public.jst_start(p_from)
      and k.clicked_at <  public.jst_start(p_to + 1)
      and (p_advertisers is null or array_length(p_advertisers, 1) is null or k.advertiser_id = any(p_advertisers))
  ), totals as (
    select
      (select count(*) from cv)                          as cv_n,
      (select count(*) from ck)                          as ck_n,
      (select coalesce(sum(x.sale_price), 0) from cv x)   as sales,
      (select coalesce(sum(x.reward), 0) from cv x)       as reward
  ), daily as (
    select coalesce(a.d, b.d) as d,
           coalesce(a.n, 0) as cv_n, coalesce(b.n, 0) as ck_n,
           coalesce(a.s, 0) as sales
    from (select (x.occurred_at at time zone 'Asia/Tokyo')::date as d,
                 count(*) as n, coalesce(sum(x.sale_price), 0) as s
          from cv x group by 1) a
    full outer join
         (select (y.clicked_at at time zone 'Asia/Tokyo')::date as d, count(*) as n
          from ck y group by 1) b
      on a.d = b.d
  ), refs as (
    select coalesce(a.l, b.l) as l, coalesce(b.n, 0) as ck_n, coalesce(a.n, 0) as cv_n
    from (select coalesce(x.first_referrer_host, '') as l, count(*) as n from cv x group by 1) a
    full outer join
         (select coalesce(y.referrer_host, '') as l, count(*) as n from ck y group by 1) b
      on a.l = b.l
    order by coalesce(b.n, 0) desc, coalesce(a.n, 0) desc
    limit 30
  ), ads as (
    select coalesce(a.l, b.l) as l, coalesce(b.n, 0) as ck_n,
           coalesce(a.n, 0) as cv_n, coalesce(a.s, 0) as sales
    from (select coalesce(x.ad_name, '') as l, count(*) as n,
                 coalesce(sum(x.sale_price), 0) as s
          from cv x group by 1) a
    full outer join
         (select coalesce(y.ad_name, '') as l, count(*) as n from ck y group by 1) b
      on a.l = b.l
    order by coalesce(a.n, 0) desc, coalesce(b.n, 0) desc
    limit 30
  ), prods as (
    select coalesce(nullif(x.product_name, ''), '(なし)') as l,
           count(*) as n,
           coalesce(sum(x.sale_price), 0) as s,
           coalesce(sum(x.reward), 0) as r
    from cv x group by 1 order by 2 desc limit 30
  )
  select jsonb_build_object(
    'affiliate_id', p_affiliate,
    'totals', (
      select jsonb_build_object(
        'conversions', t.cv_n, 'clicks', t.ck_n,
        'sales', t.sales, 'reward', t.reward,
        'cvr', case when t.ck_n = 0 then null else round(t.cv_n::numeric * 100 / t.ck_n, 2) end)
      from totals t),
    'daily', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'd', d.d, 'cv', d.cv_n, 'ck', d.ck_n, 'sales', d.sales) order by d.d), '[]'::jsonb)
      from daily d),
    'referrers', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'label', coalesce(nullif(r.l, ''), '(直接/不明)'),
               'clicks', r.ck_n, 'conversions', r.cv_n)), '[]'::jsonb)
      from refs r),
    'ads', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'label', coalesce(nullif(a.l, ''), '(なし)'),
               'clicks', a.ck_n, 'conversions', a.cv_n, 'sales', a.sales)), '[]'::jsonb)
      from ads a),
    'products', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'label', p.l, 'conversions', p.n, 'sales', p.s, 'reward', p.r)), '[]'::jsonb)
      from prods p)
  )
$$;

-- 取り込み履歴
create or replace function public.dash_imports(p_limit integer default 50)
returns setof public.imports language sql security invoker stable as $$
  select i.* from public.imports i order by i.imported_at desc limit greatest(p_limit, 1)
$$;

-- ---------------------------------------------------------------------
-- 7. 権限
-- ---------------------------------------------------------------------

-- 7-1. テーブルへの権限
--   プロジェクト作成時に「Automatically expose new tables」をオフにしているので、
--   ここで明示的に付ける。Postgres では GRANT と RLS ポリシーの両方が必要で、
--   ポリシーを書いただけでは permission denied になる。
--   RPC は security invoker（呼び出したユーザーの権限で動く）なので、
--   関数の EXECUTE 権だけでなくテーブルの権限も要る。
grant usage on schema public to authenticated;

grant select, insert, update, delete on public.conversions to authenticated;
grant select, insert, update, delete on public.clicks      to authenticated;
grant select, insert, update, delete on public.imports     to authenticated;

-- clicks.id / imports.id は bigserial なので連番の使用権も要る
grant usage, select on sequence public.clicks_id_seq  to authenticated;
grant usage, select on sequence public.imports_id_seq to authenticated;

-- 未ログイン（anon）には一切渡さない
revoke all on public.conversions from anon;
revoke all on public.clicks      from anon;
revoke all on public.imports     from anon;
revoke all on sequence public.clicks_id_seq  from anon;
revoke all on sequence public.imports_id_seq from anon;

-- 7-2. 関数への権限
--   関数は既定で PUBLIC に実行権が付くので、いったん剥がして
--   ログイン済みユーザーにだけ付け直す。
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

grant execute on function public.jst_start(date) to authenticated;
grant execute on function public.resolve_status(text, text, timestamptz, timestamptz) to authenticated;
