# 配信キャッシュ対策のバージョン番号を一括で更新する。
#
#   powershell -ExecutionPolicy Bypass -File bump.ps1
#
# GitHub Pages は全ファイルに Cache-Control: max-age=600 を付けるため、
# ファイル名が同じだとブラウザが10分間サーバーに問い合わせず古い版を使う。
# import 先と CSS のURLに ?v=... を付け、変更するたびにここを回すことで、
# 新しい版が確実に読み込まれるようにする。
#
# 変更するファイル
#   index.html : css/app.css?v=... と js/app.js?v=...
#   js/*.js    : from './xxx.js?v=...' の相対 import すべて

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$v = Get-Date -Format 'yyyyMMddHHmm'

$changed = 0

# --- index.html ---
$indexPath = Join-Path $root 'index.html'
$html = [System.IO.File]::ReadAllText($indexPath)
$html = [regex]::Replace($html, '(href="css/app\.css)(\?v=[^"]*)?(")', "`${1}?v=$v`${3}")
$html = [regex]::Replace($html, '(src="js/app\.js)(\?v=[^"]*)?(")', "`${1}?v=$v`${3}")
[System.IO.File]::WriteAllText($indexPath, $html, (New-Object System.Text.UTF8Encoding($false)))
$changed++

# --- js/*.js の相対 import ---
foreach ($f in Get-ChildItem (Join-Path $root 'js') -Filter *.js) {
  $src = [System.IO.File]::ReadAllText($f.FullName)
  # from './util.js' / from './util.js?v=123' → from './util.js?v=新しい値'
  $out = [regex]::Replace($src, "(from\s+'\./[A-Za-z0-9_./-]+\.js)(\?v=[^']*)?(')", "`${1}?v=$v`${3}")
  if ($out -ne $src) {
    [System.IO.File]::WriteAllText($f.FullName, $out, (New-Object System.Text.UTF8Encoding($false)))
    $changed++
  }
}

Write-Output "version = $v  (updated $changed files)"
