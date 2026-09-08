# 急上昇タブ（作りかけを保管）

あとで作り込むことにしたので、画面からはいったん外して「調整中」に
差し替えてあります。**このフォルダのファイルはアプリから読み込まれません。**
作り込みを再開するときの元にしてください。

## 何をするものだったか

期間の終わりを起点に「直近◯日」と「その前の◯日」を切り出して、
売上がどれだけ動いたかで相手を並べる画面です。

- 軸: アフィリエイター / 広告主
- くらべる幅: 3 / 7 / 14 / 30 日
- 並び: 急上昇 / 急降下 × 増減額順 / 伸び率順
- 表（順位・動き・直近・前・増減額・伸び率）と、増減額の横棒グラフ

伸び率順のときは、直近も前も1万円未満の相手を後ろに回していました
（100円が1,100円になった相手が「+1000%で1位」になるのを避けるため）。

## 中身

| ファイル | 何が入っているか |
| --- | --- |
| `surge.js` | `renderSurge` 一式。先頭のコメントに、`state` / `wireViewControls` / `render()` へ足す行も書いてあります |
| `surge.view.html` | `index.html` に入れていた `<section>` まるごと |

## 戻し方

1. `index.html` の `data-view="surge"` の `<section>`（いまは「調整中」の
   カードだけ）を、`surge.view.html` の中身に置き換える
2. `surge.js` の中身を `js/app.js` の「急上昇」の位置に貼る
   （`// ---- 比較 ----` の直前が元の場所）
3. `surge.js` 冒頭のコメントにある3か所を `js/app.js` に足す
   - `state` に `surge: {...}`
   - `wireViewControls()` に `segClick('#surge-…')` 4行
   - `render()` の振り分けに `else if (state.view === 'surge')`
4. `exportCsv()` に `surge` の枝を戻す（下に載せてあります）
5. `bump.ps1` を走らせる

## exportCsv に戻す枝

```js
} else if (kind === 'surge') {
  const s = state.surge;
  downloadCsv(`${s.order === 'up' ? '急上昇' : '急降下'}_${LIST_LABEL[s.dim]}_${s.window}日_${stamp}.csv`,
    [LIST_LABEL[s.dim], `直近${s.window}日 売上`, `前の${s.window}日 売上`, '増減額', '伸び率(%)', '動き'],
    (s.rows || []).map((r) => [
      r.label, r.recent, r.before, r.delta,
      r.rate === null ? '' : Math.round(r.rate * 1000) / 10, r.trend.label]));
```

## 注意

`trendOf` / `rateText` / `trendNode`（⇈ ↑ → ↓ ⇊ ★ の目印）と、
CSS の `.trend` は **`js/app.js` と `css/app.css` に残してあります**。
ランキングの日別でも使っているので、消さないでください。

外した時点の版: 202609081407（コミット 35b356e）
