-- =====================================================================
--  アフィリエイター別の日次実績（クリック・表示）を入れる箱
--
--  マネートラックの /users/affiliate_activity_csv.csv から取る。
--  「日付 × アフィリエイター」の粒度で、全広告主ぶんが入っている。
--
--  いまの clicks テーブルは1クリック1行の生データで、bestkenko ぶんしか無い。
--  こちらは集計済みで全社ぶん入るので、別の箱にする。
--
--  ⚠ 元CSVには「名前」「メールアドレス」の列があるが、**保存しない**。
--     分析に要らないし、持たなければ漏れようがない。
--     IPアドレスを捨てているのと同じ方針。
--
--  Supabase の SQL Editor に全文貼って Run。
--  既存のテーブルには触りません。追加だけです。
-- =====================================================================

create table if not exists public.affiliate_daily (
  d               date    not null,
  affiliate_id    text    not null,
  affiliate_token text,
  conversions     integer not null default 0,   -- 成果発生件数
  clicks          integer not null default 0,   -- クリック遷移数（短縮URL含む）
  impressions     integer not null default 0,   -- 広告表示回数（短縮URL除く）
  updated_at      timestamptz not null default now(),
  primary key (d, affiliate_id)
);

create index if not exists affiliate_daily_d_idx    on public.affiliate_daily (d);
create index if not exists affiliate_daily_aff_idx  on public.affiliate_daily (affiliate_id);

alter table public.affiliate_daily enable row level security;

drop policy if exists affiliate_daily_authenticated_all on public.affiliate_daily;
create policy affiliate_daily_authenticated_all on public.affiliate_daily
  for all to authenticated using (true) with check (true);

-- Data API の「新しいテーブルを自動で公開」をオフにしてあるので、明示的に付ける
grant select, insert, update, delete on public.affiliate_daily to authenticated;

-- 取り込み。同じ日・同じアフィリエイターは上書きする。
-- 当月ぶんを毎日まるごと取り直すので、何度流しても同じ結果になる（冪等）。
create or replace function public.import_affiliate_daily(p_rows jsonb)
returns jsonb language plpgsql security invoker as $$
declare
  v_total    integer := coalesce(jsonb_array_length(p_rows), 0);
  v_inserted integer := 0;
  v_updated  integer := 0;
begin
  if v_total = 0 then
    return jsonb_build_object('total', 0, 'inserted', 0, 'updated', 0);
  end if;

  with src as (
    select * from jsonb_to_recordset(p_rows) as x(
      d date, affiliate_id text, affiliate_token text,
      conversions integer, clicks integer, impressions integer
    )
  ), clean as (
    -- 同じファイル内に同じ組み合わせが複数あっても1行にまとめる
    select s.d, s.affiliate_id,
           max(s.affiliate_token)            as affiliate_token,
           sum(coalesce(s.conversions, 0))   as conversions,
           sum(coalesce(s.clicks, 0))        as clicks,
           sum(coalesce(s.impressions, 0))   as impressions
    from src s
    where s.d is not null and s.affiliate_id is not null and s.affiliate_id <> ''
    group by s.d, s.affiliate_id
  ), up as (
    insert into public.affiliate_daily as t
      (d, affiliate_id, affiliate_token, conversions, clicks, impressions, updated_at)
    select c.d, c.affiliate_id, c.affiliate_token, c.conversions, c.clicks, c.impressions, now()
    from clean c
    on conflict (d, affiliate_id) do update set
      affiliate_token = excluded.affiliate_token,
      conversions     = excluded.conversions,
      clicks          = excluded.clicks,
      impressions     = excluded.impressions,
      updated_at      = now()
    returning (xmax = 0) as is_insert
  )
  select count(*) filter (where is_insert), count(*) filter (where not is_insert)
    into v_inserted, v_updated
  from up;

  return jsonb_build_object('total', v_total, 'inserted', v_inserted, 'updated', v_updated);
end $$;

-- 日次実績の取り出し。期間で絞って、日ごとに合計する。
-- 画面のCVRを「全広告主ぶんのクリック」で出せるようにするためのもの。
create or replace function public.dash_affiliate_daily(
  p_from date,
  p_to date,
  p_affiliates text[] default null
) returns table(
  bucket date, conversions bigint, clicks bigint, impressions bigint
) language sql security invoker stable as $$
  select a.d,
         sum(a.conversions)::bigint,
         sum(a.clicks)::bigint,
         sum(a.impressions)::bigint
  from public.affiliate_daily a
  where a.d >= p_from and a.d <= p_to
    and (p_affiliates is null or array_length(p_affiliates, 1) is null
         or a.affiliate_id = any(p_affiliates))
  group by a.d
  order by a.d
$$;

-- 新しく作った関数には既定で PUBLIC 実行権が付くので、未ログインから剥がし直す
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
