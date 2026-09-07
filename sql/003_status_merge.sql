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
