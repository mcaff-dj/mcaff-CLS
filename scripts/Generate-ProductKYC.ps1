# Generates product-kyc.html from the "Product feedback KYC" workbook.
# Each product tab has its own bespoke question schema (no shared template), so products
# are configured individually in productkyc-config.ps1 rather than via a generic column map.
#
# For "comparison" products (two SKUs surveyed head-to-head via a "which did you like more"
# question), splits respondents into two groups and shows a side-by-side breakdown, matching
# the workbook's own manually-built "Guava & Caramel Report" comparison-table style.
# For "standalone" products, shows a single breakdown table.
# "Common themes" per product = automated keyword-frequency counts + verbatim sample quotes
# pulled directly from free-text columns (dislikes/improvements/remarks) - not synthesized.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Web

$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
. "$Here\lib.ps1"
. "$Here\productkyc-config.ps1"
$RepoRoot = Split-Path -Parent $Here
$OutPath = Join-Path $RepoRoot "product-kyc.html"

function HEnc($s){ return [System.Web.HttpUtility]::HtmlEncode([string]$s) }
function Cell($row,$i){
    if($null -eq $row){ return "" }
    if($row -is [System.Collections.IList]){ if($i -lt $row.Count){ $v=$row[$i]; if($null -eq $v){return ""}; return $v } else { return "" } }
    if($i -eq 0){ return $row } else { return "" }
}

$script:PKYC_Stopwords = @(
    'the','and','for','are','was','were','this','that','with','have','has','had','not','but','you','your',
    'they','them','their','from','when','what','who','which','these','those','because','about','into','over',
    'under','after','before','both','more','less','most','much','many','some','all','only','out','off','again',
    'once','been','being','than','then','also','there','here','can','could','would','should','will','did','does',
    'she','her','him','his','our','ours','use','used','using','one','two','get','got','felt','feel','really','quite','bit'
)
function Get-Tokens($text){
    $t = $text.ToString().ToLowerInvariant() -replace "[^a-z\s]", " "
    return @($t -split '\s+' | Where-Object { $_.Length -ge 3 })
}
function Get-TopKeywords($texts, $topN = 6){
    $freq = @{}
    foreach($t in $texts){
        if([string]::IsNullOrWhiteSpace($t)){ continue }
        foreach($tok in (Get-Tokens $t)){
            if($script:PKYC_Stopwords -contains $tok){ continue }
            if(-not $freq.ContainsKey($tok)){ $freq[$tok] = 0 }
            $freq[$tok]++
        }
    }
    return @($freq.GetEnumerator() | Sort-Object Value -Descending | Select-Object -First $topN | ForEach-Object { @{ word = $_.Key; count = $_.Value } })
}
function Get-SampleQuotes($texts, $n = 2){
    $seen = @{}; $out = @()
    foreach($t in $texts){
        $tt = if($t){ $t.ToString().Trim() } else { "" }
        if($tt.Length -lt 15){ continue }
        if($seen.ContainsKey($tt)){ continue }
        $seen[$tt] = $true
        $out += $tt
        if($out.Count -ge $n){ break }
    }
    return $out
}

function Get-CategoricalBreakdown($rows, $colIdx){
    $tally = [ordered]@{}; $total = 0
    foreach($r in $rows){
        $v = Cell $r $colIdx
        if([string]::IsNullOrWhiteSpace($v)){ continue }
        $v = $v.ToString().Trim()
        if(-not $tally.Contains($v)){ $tally[$v] = 0 }
        $tally[$v]++; $total++
    }
    $list = @($tally.GetEnumerator() | Sort-Object Value -Descending | ForEach-Object {
        @{ value = $_.Key; count = $_.Value; pct = if($total -gt 0){ [math]::Round($_.Value / $total * 100, 1) } else { 0 } }
    })
    return @{ list = $list; total = $total }
}

function Split-CompareGroups($rows, $compareCfg){
    $groupA = New-Object System.Collections.Generic.List[object]
    $groupB = New-Object System.Collections.Generic.List[object]
    foreach($r in $rows){
        $v = Cell $r $compareCfg.likeMoreCol
        if([string]::IsNullOrWhiteSpace($v)){ continue }
        $v = $v.ToString().Trim()
        if($v -eq $compareCfg.labelA){ [void]$groupA.Add($r) }
        elseif($v -eq $compareCfg.labelB){ [void]$groupB.Add($r) }
    }
    return @{ A = $groupA; B = $groupB }
}

function Build-CompareTable($categoricalCfg, $groupA, $groupB, $shortA, $shortB){
    $sb = New-Object System.Text.StringBuilder
    [void]$sb.Append("<table class='pk-table'><thead><tr><th>Category</th><th>$(HEnc $shortA)</th><th>$(HEnc $shortB)</th></tr></thead><tbody>")
    foreach($f in $categoricalCfg){
        $bdA = (Get-CategoricalBreakdown $groupA $f.c).list
        $bdB = (Get-CategoricalBreakdown $groupB $f.c).list
        $topA = @($bdA | Select-Object -First 2)
        $topB = @($bdB | Select-Object -First 2)
        $cellA = ($topA | ForEach-Object { "$(HEnc $_.value) ($($_.pct)%)" }) -join ", "
        $cellB = ($topB | ForEach-Object { "$(HEnc $_.value) ($($_.pct)%)" }) -join ", "
        if(-not $cellA){ $cellA = "-" }; if(-not $cellB){ $cellB = "-" }
        [void]$sb.Append("<tr><td class='pk-rowlabel'>$(HEnc $f.l)</td><td>$cellA</td><td>$cellB</td></tr>")
    }
    [void]$sb.Append("</tbody></table>")
    return $sb.ToString()
}

function Build-StandaloneStats($categoricalCfg, $rows){
    $sb = New-Object System.Text.StringBuilder
    [void]$sb.Append("<table class='pk-table'><thead><tr><th>Category</th><th>Breakdown</th></tr></thead><tbody>")
    foreach($f in $categoricalCfg){
        $bd = (Get-CategoricalBreakdown $rows $f.c).list
        $top = @($bd | Select-Object -First 3)
        $cell = ($top | ForEach-Object { "$(HEnc $_.value) ($($_.pct)%)" }) -join ", "
        if(-not $cell){ $cell = "-" }
        [void]$sb.Append("<tr><td class='pk-rowlabel'>$(HEnc $f.l)</td><td>$cell</td></tr>")
    }
    [void]$sb.Append("</tbody></table>")
    return $sb.ToString()
}

function Build-ThemesBlock($freeTextCfg, $rows){
    $sb = New-Object System.Text.StringBuilder
    foreach($ft in $freeTextCfg){
        $texts = @(foreach($r in $rows){ Cell $r $ft.c })
        $kw = @(Get-TopKeywords $texts 6)
        $quotes = @(Get-SampleQuotes $texts 2)
        if($kw.Count -eq 0 -and $quotes.Count -eq 0){ continue }
        [void]$sb.Append("<div class='pk-theme'><div class='pk-theme-label'>$(HEnc $ft.l)</div>")
        if($kw.Count -gt 0){
            $kwHtml = ($kw | ForEach-Object { "<span class='pk-kw'>$(HEnc $_.word) &times;$($_.count)</span>" }) -join ""
            [void]$sb.Append("<div class='pk-kw-row'>$kwHtml</div>")
        }
        foreach($q in $quotes){ [void]$sb.Append("<p class='pk-quote'>&ldquo;$(HEnc $q)&rdquo;</p>") }
        [void]$sb.Append("</div>")
    }
    return $sb.ToString()
}

function Build-ProductCard($p){
    Write-Host "  [$($p.key)] fetching '$($p.tab)'..."
    $rows = Get-SheetRowsChunked $PKYC_SpreadsheetId $p.tab "AF"
    Write-Host "  [$($p.key)] fetched $($rows.Count) rows"

    $sb = New-Object System.Text.StringBuilder
    if($p.kind -eq "comparison"){
        $groups = Split-CompareGroups $rows $p.compare
        $title = "$($p.compare.shortA) vs $($p.compare.shortB)"
        $compareTable = Build-CompareTable $p.categorical $groups.A $groups.B $p.compare.shortA $p.compare.shortB
        $allRows = New-Object System.Collections.Generic.List[object]
        $allRows.AddRange($groups.A)
        $allRows.AddRange($groups.B)
        $themes = Build-ThemesBlock $p.freeText $allRows
        [void]$sb.Append("<div class='pk-product'><h3>$(HEnc $title)</h3><p class='pk-meta'>$($groups.A.Count.ToString('N0')) preferred $(HEnc $p.compare.shortA) &middot; $($groups.B.Count.ToString('N0')) preferred $(HEnc $p.compare.shortB) &middot; $($rows.Count.ToString('N0')) total rows</p>")
        [void]$sb.Append($compareTable)
        if($themes){ [void]$sb.Append("<div class='pk-themes-title'>Common themes in constructive feedback</div>$themes") }
        [void]$sb.Append("</div>")
    } else {
        $statsTable = Build-StandaloneStats $p.categorical $rows
        $themes = Build-ThemesBlock $p.freeText $rows
        [void]$sb.Append("<div class='pk-product'><h3>$(HEnc $p.label)</h3><p class='pk-meta'>$($rows.Count.ToString('N0')) total rows</p>")
        [void]$sb.Append($statsTable)
        if($themes){ [void]$sb.Append("<div class='pk-themes-title'>Common themes in constructive feedback</div>$themes") }
        [void]$sb.Append("</div>")
    }
    return $sb.ToString()
}

Write-Host "Building Product Calling KYC report..."
$cardsByCategory = [ordered]@{}
foreach($cat in $PKYC_CategoryLabels.Keys){ $cardsByCategory[$cat] = New-Object System.Text.StringBuilder }
foreach($p in $PKYC_Products){
    $html = Build-ProductCard $p
    [void]$cardsByCategory[$p.category].Append($html)
}

$nowStr = (Get-Date).ToUniversalTime().AddHours(5.5).ToString('dd MMM yyyy, HH:mm') + " IST"

$categoryCardsHtml = New-Object System.Text.StringBuilder
foreach($cat in $PKYC_CategoryLabels.Keys){
    $label = $PKYC_CategoryLabels[$cat]
    [void]$categoryCardsHtml.Append("<div class='card'><span class='status-pill'>Live</span><h2>$(HEnc $label)</h2>$($cardsByCategory[$cat].ToString())</div>")
}

$html = @"
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Product Calling KYC</title>
<style>
  :root{
    --page:#f9f9f7; --surface-card:#ffffff; --text-primary:#0b0b0b; --text-secondary:#52514e;
    --text-muted:#898781; --border:rgba(11,11,11,0.10); --grid:#e1e0d9;
    --pkyc:#c2740c;
  }
  @media (prefers-color-scheme: dark){
    :root{
      --page:#0d0d0d; --surface-card:#1a1a19; --text-primary:#ffffff; --text-secondary:#c3c2b7;
      --text-muted:#898781; --border:rgba(255,255,255,0.10); --grid:#2c2c2a;
      --pkyc:#e0993d;
    }
  }
  *{box-sizing:border-box;}
  body{margin:0;min-height:100vh;background:var(--page);color:var(--text-primary);
    font-family:system-ui,-apple-system,"Segoe UI",sans-serif;padding:32px 20px;}
  .wrap{width:100%;max-width:1000px;margin:0 auto;}
  .home-link{display:inline-flex;align-items:center;gap:6px;text-decoration:none;font-size:13px;font-weight:600;
    color:var(--text-secondary);margin-bottom:20px;}
  .home-link:hover{color:var(--text-primary);}
  header{text-align:center;margin-bottom:24px;}
  .badge{display:inline-block;font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;
    color:var(--pkyc);background:color-mix(in srgb, var(--pkyc) 14%, transparent);border-radius:999px;padding:4px 12px;margin-bottom:14px;}
  h1{font-size:clamp(22px,4vw,28px);margin:0 0 12px;letter-spacing:-0.01em;}
  header p{margin:0;color:var(--text-secondary);font-size:14px;line-height:1.6;}

  .cards{display:flex;flex-direction:column;gap:20px;}
  .card{background:var(--surface-card);border:1px solid var(--border);border-radius:14px;padding:22px 24px;}
  .card h2{font-size:18px;margin:0 0 16px;}
  .status-pill{display:inline-block;font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.03em;
    color:#1a9c5c;background:rgba(26,156,92,.14);border-radius:999px;padding:2px 9px;margin-bottom:10px;}

  .pk-product{padding:16px 0;border-top:1px solid var(--grid);}
  .pk-product:first-of-type{border-top:none;padding-top:0;}
  .pk-product h3{font-size:14.5px;margin:0 0 4px;}
  .pk-meta{margin:0 0 12px;font-size:12px;color:var(--text-muted);}
  .pk-table{width:100%;border-collapse:collapse;font-size:12.5px;margin-bottom:14px;}
  .pk-table th{background:var(--page);text-align:left;padding:7px 10px;border:1px solid var(--grid);font-weight:600;color:var(--text-secondary);}
  .pk-table td{padding:7px 10px;border:1px solid var(--grid);color:var(--text-secondary);vertical-align:top;}
  .pk-rowlabel{font-weight:600;color:var(--text-primary);white-space:nowrap;}
  .pk-themes-title{font-size:11.5px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--text-muted);margin:10px 0 8px;}
  .pk-theme{margin-bottom:12px;}
  .pk-theme-label{font-size:12.5px;font-weight:600;margin-bottom:6px;}
  .pk-kw-row{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:6px;}
  .pk-kw{display:inline-block;font-size:11px;padding:2px 9px;border-radius:999px;background:color-mix(in srgb, var(--pkyc) 12%, transparent);color:var(--pkyc);font-weight:600;}
  .pk-quote{margin:0 0 4px;font-size:12.5px;color:var(--text-secondary);font-style:italic;padding-left:10px;border-left:2px solid var(--grid);}
</style>
</head>
<body>
  <div class="wrap">
    <a class="home-link" href="/">&larr; Home</a>
    <header>
      <div><span class="badge">Auto-refreshed</span></div>
      <h1>Product Calling KYC</h1>
      <p>Built from the "Product feedback KYC" workbook &middot; last updated $nowStr.<br>Comparison tables are computed from response counts; feedback themes are keyword frequency + verbatim quotes pulled directly from free-text answers &mdash; not AI-written summaries.</p>
    </header>
    <div class="cards">
      $($categoryCardsHtml.ToString())
    </div>
  </div>
</body>
</html>
"@

Set-Content -Path $OutPath -Value $html -Encoding utf8
Write-Host "Wrote $OutPath ($([math]::Round((Get-Item $OutPath).Length/1KB)) KB)"
