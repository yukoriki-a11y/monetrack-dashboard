# 毎日の自動取り込み（マネートラック → Supabase）

手でxlsxを落として画面にドラッグしていたのを、GitHub Actions の日次実行に置き換える。
このファイルは**実機で確認した結果**をまとめたもの。実装の前提になる。

調査日: 2026-09-24 / 管理者アカウントで検証

## なぜログインを自動化しないのか

ログインフォームに **reCAPTCHA v3** が入っている
（`https://www.google.com/recaptcha/api.js?render=6Lf3_1MrAAAAABXUWuJRu7Dkn70LsOn-FhuKKSKB`、
隠しフィールド `g-recaptcha-response`）。これは自動ログインを防ぐための仕組みなので、
そこを突破する処理は書かない。

代わりに **人が1回ログインして得たセッションを使い回す**。ログインが発生しないので
reCAPTCHA に触れない。セッションが切れたら処理が失敗するので、通知を受けて入れ直す。

## 取るもの（3つとも実機で通しで確認済み）

### ① 成果データ　`/users/get_transactions.xlsx`

管理者のまま取れる。**非同期ジョブ方式**。

```
GET /users/get_transactions.xlsx?type=&status=&paid=&fromdate=2026/09/23&todate=2026/09/23
    &affiliate_token=&merchant_id=&sSearch=&iSortCol_0=&sSortDir_0=
    ヘッダ: X-Requested-With: XMLHttpRequest
  → {"job_id":"...","attachment_id":"..."}

GET /check_progress?job_id=...&attachment_id=...     （1秒おきに繰り返す）
  → {"finished":true,"attachment_url":"https://s3-ap-southeast-1.amazonaws.com/..."}

GET <attachment_url>  → xlsx
```

- 日付の形式は **`yyyy/mm/dd`**（bootstrap-datepicker の設定値）
- 実測: 1日分 39,522 バイト
- **1回のエクスポートは最長3か月**（`LIMIT_MONTHS_EXPORT=3`）。
  ただし件数が `LIMIT_ENTRIES=300` 以下なら期間制限は効かない
- 画面のボタンは `data-url="/users/get_transactions.xlsx"`、
  パラメータは `MoneTrack` の `exportCsv()` が組み立てている

### ② 全体のクリック・表示　`/users/affiliate_activity_csv.csv`

管理者のまま取れる。**ジョブ不要、GETで即CSV**。

```
GET /users/affiliate_activity_csv.csv?year=2026&month=8
  → text/csv
```

列: `日付, affiliate_token, affiliate_id, 名前, メールアドレス,
　　 成果発生件数, クリック遷移数（短縮URL含む）, 広告表示回数（短縮URL除く）`

- **日付 × アフィリエイター**の粒度。**全広告主ぶんが入る**
- 広告主の軸は無い（どの広告主のクリックかは分からない）
- 実測: 2026年8月で 27,959 行 / 2.4MB
- ⚠ **`名前` と `メールアドレス` は個人情報。取り込み時に捨てる**（保存しない）

### ③ 広告主別のクリック　`/merchants/<slug>/raw_click.xlsx`

**管理者のままでは取れない**。`/merchants/<id>/get_rawclick` も `/merchants/<id>/report` も
`/users/report_overall` にリダイレクトされる。その広告主に**成り代わる**必要がある。

```
GET  /merchants                     … admin_id と authenticity_token をここから読む
POST /users/admin_log_in_as         { authenticity_token, admin_id, user_id, type:"merchant" }
  → /merchants/<slug>/dashboard     （成り代わり完了）

GET  /merchants/<slug>/raw_click.xlsx?fromdate=…&todate=…
  → ① と同じジョブ方式（check_progress → S3）

GET  /users/back_to_admin           → /users/report_overall（管理者に復帰）
```

- URL は **slug**（`bestkenko`）。ObjectId ではない
- 実測: 1日分 90,103 バイト
- 監査ログ（`/activities_log`）に「log in as」が1社につき1件残る

> **ハマりどころ**: `admin_id` を空で POST すると成り代わりはできるが、
> **`back_to_admin` が効かなくなる**（戻り先が記録されない）。
> `admin_id` はページによって入っていたりいなかったりする。
> - `/users/get_transactions` … **空**
> - `/merchants` … **入っている**（24文字の ObjectId）
>
> 必ず `/merchants` から読むこと。一度これで管理者セッションを失った。

## 対象の広告主（③ 用）

| 広告主 | slug | merchant_id（ObjectId） |
| --- | --- | --- |
| bestkenko | `bestkenko` | `56556f3f69702d6d5b500200` |
| kusuriexpress | `kusuriexpress` | `5655702c69702d6d5b590200` |
| petkusuri | `petkusuri` | `56556c3569702d6d5b390200` |
| unidru | `unidru` | `5a950f3900ada01f43af4694` |
| Jade2019 | `Jade2019` | `5d24a16b3f52cd5176edcec4` |

Jade2019 は**先頭が大文字**。slug は実際のリダイレクト先URLで確認すること。

全139社ぶん回すのは勧めない。監査ログに毎日139件の成り代わりが残るため。

## 毎日の流れ

```
GET /merchants                       … admin_id / CSRF を取る
① 成果（前日分）
② 全体クリック（当月ぶんを丸ごと取り直して上書き）
5社ループ:
    成り代わり → ③（前日分） → back_to_admin
```

`admin_id` も CSRF も**毎回ページから読む**。保存するのは**セッションCookieだけ**。

## 保存する秘密情報

GitHub Secrets に入れる。**値はリポジトリにも会話にも残さない。**

| 名前 | 中身 |
| --- | --- |
| `MT_COOKIE` | `app.monetrack.com` のセッションCookie（Devise の `_session` と `remember_user_token`） |
| `SUPABASE_URL` | Supabase の Project URL |
| `SUPABASE_ANON_KEY` | 公開用 anon key（`service_role` は使わない） |
| `SUPABASE_EMAIL` | 取り込み用ユーザーのメールアドレス |
| `SUPABASE_PASSWORD` | 同パスワード |

取り込みRPCは `authenticated` にしか許可していないので、ログインして JWT を得てから呼ぶ。

## 注意

- CSV形式は ① ③ では非対応（`.csv` を付けても JSON が返る）。xlsx のみ
- セッションが切れたら処理は失敗する。失敗を通知して、人が Cookie を入れ直す
- 実行時刻は UTC。日本時間で回したい場合は cron を9時間ずらす
