param([Parameter(Mandatory=$true)][int]$BrandIndex)

# Config-driven report generator. Fetches a brand's sheet data and produces the
# full self-contained <brand>.html at the repo root. Reuses the verified build
# logic from the original per-brand scripts, generalised via scripts/brands.ps1.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Web

$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
. "$Here\lib.ps1"
. "$Here\brands.ps1"
. "$Here\gen-insights.ps1"
$B   = $Brands[$BrandIndex]
$Col = $B.Col
$RepoRoot = Split-Path -Parent $Here
$OutPath  = Join-Path $RepoRoot $B.OutFile

function HEnc($s){ return [System.Web.HttpUtility]::HtmlEncode([string]$s) }
function Round1($n){ return [math]::Round($n,1) }
function JEnc($s){ $s=[string]$s; $s=$s -replace '\\','\\\\' -replace '"','\"' -replace "`r`n",'\n' -replace "`r",'\n' -replace "`n",'\n' -replace "`t",'\t'; return $s }
# The older KYC raw-dump sheet (see brands.ps1 Secondary config) worded some Query
# Category values differently than the primary sheet - normalized here so both sides
# of a merged report count as one category instead of splitting the same complaint
# type into two rows.
$script:CatNormMap = @{
    "Reattempt Request/ Fake update" = "Fake update"
    "Pincode non Serviceable"        = "Pincode not serviceable"
    "Lost order/Destroyed/Damaged"   = "Lost/Damaged/Destroyed"
    "Marked Delivered but customer did not received the order" = "Marked Delivered but customer did not receive order"
}
# Same reasoning as CatNormMap above, but for Delivery Partner Name: the older KYC
# raw-dump sheet has messy operational sub-labels (surface/air legs, direct/hyphen
# routing codes, brand-specific suffixes) for couriers the primary sheet already
# reports under clean canonical names.
$script:PartnerNormMap = @{
    "Blue Dart Air"                     = "Blue Dart"
    "Blue Dart Surface"                 = "Blue Dart"
    "Bluedart"                          = "Blue Dart"
    "Bluedart brands 500 g Surface"     = "Blue Dart"
    "Bluedart Surface - Select  500gm"  = "Blue Dart"
    "Bluedart Surface - Select 500gm"   = "Blue Dart"
    "Bluedart Surface 500 gms- Select"  = "Blue Dart"
    "Cuberooteeine"                     = "PurpleDrone"
    "Purpledrone_mCaff"                 = "PurpleDrone"
    "Delhivery Air"                     = "DELHIVERY"
    "DELHIVERY_SMYTTEN"                 = "DELHIVERY"
    "DLSRF_Direct"                      = "DELHIVERY"
    "Dlv_Direct_Air"                    = "DELHIVERY"
    "HYP_DELHIVERY"                     = "DELHIVERY"
    "SR_Delhivery"                      = "DELHIVERY"
    "DTDC Surface"                      = "DTDC"
    "DTDC_Surface_Direct"               = "DTDC"
    "Ekart Logistics Surface"           = "Ekart"
    "Elasticrun_direct_M"               = "ElasticRun"
    "Pidge_Omnivio"                     = "Pidge"
    "Pikndel_M_SDD"                     = "Pikndel"
    "Shadowfax Surface"                 = "Shadowfax"
    "SHADOWFAX_ESSENTIAL"               = "Shadowfax"
    "Shadowfax_M_NDD"                   = "Shadowfax"
    "Shadowfax_M_SDD"                   = "Shadowfax"
    "Fedex Air"                         = "Fedex"
    "SR_Fedex_Courier"                  = "Fedex"
    "XBSRF_ Air_Direct"                 = "Xpressbees"
    "XBSRF_Direct"                      = "Xpressbees"
    "XBSRF_Direct_NDD"                  = "Xpressbees"
    "xpressbees"                        = "Xpressbees"
    "Xpressbees Surface"                = "Xpressbees"
    "na"                                = "(blank)"
}
function Cell($row,$i){
    if($null -eq $row){ return "" }
    if($row -is [System.Collections.IList]){ if($i -lt $row.Count){ $v=$row[$i]; if($null -eq $v){return ""} } else { return "" } }
    elseif($i -eq 0){ $v=$row } else { return "" }   # scalar row -> single cell at col 0
    if($i -eq $Col.cat -and $script:CatNormMap.ContainsKey($v)){ return $script:CatNormMap[$v] }
    if($i -eq $Col.partner -and $script:PartnerNormMap.ContainsKey($v)){ return $script:PartnerNormMap[$v] }
    return $v
}
function PrettyMonth($raw){ $p=$raw -split "_",2; if($p.Count -lt 2){return $raw}; return ($p[1] -replace "'"," '") }
$script:YearOfCache = @{}
function YearOf($mo){
    if($script:YearOfCache.ContainsKey($mo)){ return $script:YearOfCache[$mo] }
    $y = if($mo -match "['\s](\d{2})$"){ "20$($Matches[1])" } else { "" }
    $script:YearOfCache[$mo] = $y
    return $y
}
function NiceMax($v){ if($v -le 0){return 10}; $m=[math]::Pow(10,[math]::Floor([math]::Log10($v))); foreach($s in @(1,2,2.5,5,10)){ $c=$s*$m; if($c -ge $v){return $c} }; return 10*$m }
function CountBy($data,$i){ $d=[ordered]@{}; foreach($r in $data){ $v=Cell $r $i; if([string]::IsNullOrWhiteSpace($v)){$v="(blank)"}; if($d.Contains($v)){$d[$v]++}else{$d[$v]=1} }; return $d }
function TopN($dict,$n){ return @($dict.GetEnumerator()|Sort-Object Value -Descending|Select-Object -First $n|ForEach-Object{[PSCustomObject]@{key=$_.Key;value=$_.Value}}) }

if ($env:REPORT_CACHE_FILE -and (Test-Path $env:REPORT_CACHE_FILE)) {
    Write-Host "[$($B.Brand)] loading main rows from cache $($env:REPORT_CACHE_FILE)"
    $dataRows = Get-Content -Raw -Path $env:REPORT_CACHE_FILE | ConvertFrom-Json
} else {
    # Rows for months older than the last 3 are treated as settled and reused from the
    # persisted primary-sheet cache instead of being re-fetched on every refresh - only
    # the last-3-months tail (plus anything newly appended) is pulled live each time.
    Write-Host "[$($B.Brand)] fetching main sheet (incremental: last 3 months live, rest from cache)..."
    $primaryCachePath = Join-Path $RepoRoot "data/$($B.Brand)_primary_cache.json"
    $targetMonths = $B.Months[-3..-1]
    $dataRows = Get-SheetRowsIncremental $B.SpreadsheetId $B.SheetName $B.LastCol $primaryCachePath $Col.month $targetMonths
}
if ($dataRows -isnot [System.Collections.Generic.List[object]]) {
    $listed = New-Object System.Collections.Generic.List[object]
    foreach ($r in $dataRows) { [void]$listed.Add($r) }
    $dataRows = $listed
}

# Older KYC raw-dump sheet covering months the primary sheet doesn't (see brands.ps1).
# Its Last Source Type / Parent Order columns are swapped vs the primary sheet, so each
# kept row is realigned before merging; months that overlap with the primary sheet are
# skipped there to avoid double-counting the same period from two different systems.
# Its Unique column also uses a different convention: a numeric duplicate-rank ("1","2",...)
# instead of the primary sheet's literal "Unique"/"Duplicate" strings, so every downstream
# `-eq "Unique"` check (KPI cards, per-category tables) silently dropped these rows until
# the value is normalized here (rank "1" -> "Unique", everything else -> "Duplicate").
if ($B.ContainsKey('Secondary')) {
    Write-Host "[$($B.Brand)] fetching secondary sheet ($($B.Secondary.SpreadsheetId))..."
    $secRows = Get-SheetRowsChunked $B.Secondary.SpreadsheetId $B.Secondary.SheetName $B.Secondary.LastCol
    $swapA, $swapB = $B.Secondary.SwapCols
    $exclude = $B.Secondary.ExcludeMonths
    $keptCount = 0
    foreach ($r in $secRows) {
        $mo = Cell $r $Col.month
        if ($exclude -contains $mo) { continue }
        $row = @($r)
        if ($swapA -lt $row.Count -and $swapB -lt $row.Count) {
            $t = $row[$swapA]; $row[$swapA] = $row[$swapB]; $row[$swapB] = $t
        }
        if ($Col.uniq -lt $row.Count) {
            $row[$Col.uniq] = if ((Cell $row $Col.uniq).Trim() -eq "1") { "Unique" } else { "Duplicate" }
        }
        [void]$dataRows.Add($row)
        $keptCount++
    }
    Write-Host "[$($B.Brand)] secondary sheet: $($secRows.Count) rows fetched, $keptCount kept after excluding overlapping months"
}
Write-Host "[$($B.Brand)] fetched $($dataRows.Count) rows; fetching small tabs..."
$mom     = Get-SheetValues $B.SpreadsheetId $B.SmallTabs.mom
$prodnps = Get-SheetValues $B.SpreadsheetId $B.SmallTabs.prodnps
$agent   = Get-SheetValues $B.SpreadsheetId $B.SmallTabs.agent
$ai      = Get-SheetValues $B.SpreadsheetId $B.SmallTabs.ai

$months = $B.Months
$N = $months.Count
$distinctYears = @($months | ForEach-Object { YearOf $_ } | Where-Object { $_ } | Select-Object -Unique | Sort-Object)
$unique = $dataRows | Where-Object { (Cell $_ $Col.uniq) -eq "Unique" }

function Get-SalesMByMonth($rowsSubset){
    $tmp=@{}
    foreach($r in $rowsSubset){ $mo=Cell $r $Col.month; $sm=Cell $r $Col.sales
        if([string]::IsNullOrWhiteSpace($mo) -or [string]::IsNullOrWhiteSpace($sm)){continue}
        if(-not $tmp.ContainsKey($mo)){$tmp[$mo]=@{}}
        if($tmp[$mo].ContainsKey($sm)){$tmp[$mo][$sm]++}else{$tmp[$mo][$sm]=1} }
    $res=@{}; foreach($mo in $tmp.Keys){ $best=$tmp[$mo].GetEnumerator()|Sort-Object Value -Descending|Select-Object -First 1; $res[$mo]=[double]$best.Key }
    return $res
}
$salesM = Get-SalesMByMonth $dataRows
$salesArr = @(foreach($mo in $months){ if($salesM.ContainsKey($mo)){$salesM[$mo]}else{0} })

# ---------- Weekly period derivation (native Week / Total Sales W columns) ----------
function Get-WeekNum($weekLabel){ if($weekLabel -match 'Week\s*(\d+)'){ return [int]$Matches[1] }; return 999 }

$weeksByMonthIdx = New-Object System.Collections.Generic.List[object]
$allWeeks        = New-Object System.Collections.Generic.List[object]
$weekMonthOf     = New-Object System.Collections.Generic.List[object]

for($mi2=0; $mi2 -lt $N; $mi2++){
    $moLbl2 = $months[$mi2]
    $wkSeen = [ordered]@{}
    foreach($r in $dataRows){
        if((Cell $r $Col.month) -ne $moLbl2){ continue }
        $wkVal2 = Cell $r $Col.week
        if([string]::IsNullOrWhiteSpace($wkVal2) -or $wkVal2 -eq "#N/A"){ continue }
        if(-not $wkSeen.Contains($wkVal2)){ $wkSeen[$wkVal2] = $true }
    }
    $wkOrdered2 = @($wkSeen.Keys | Sort-Object { Get-WeekNum $_ })
    [void]$weeksByMonthIdx.Add($wkOrdered2)
    foreach($wkVal2 in $wkOrdered2){ [void]$allWeeks.Add($wkVal2); [void]$weekMonthOf.Add($mi2) }
}
$totalWeeks = $allWeeks.Count
$lastWeekIdx = $totalWeeks - 1
$weekStartIdx = New-Object System.Collections.Generic.List[object]
$weekStartAcc = 0
for($mi2=0; $mi2 -lt $N; $mi2++){ [void]$weekStartIdx.Add($weekStartAcc); $weekStartAcc += $weeksByMonthIdx[$mi2].Count }

function Get-SalesWByWeek($rowsSubset){
    $tmp=@{}
    foreach($r in $rowsSubset){
        $wkVal3=Cell $r $Col.week; if([string]::IsNullOrWhiteSpace($wkVal3) -or $wkVal3 -eq "#N/A"){continue}
        $moLbl3=Cell $r $Col.month
        $sw=Cell $r $Col.salesW; if([string]::IsNullOrWhiteSpace($sw)){continue}
        $wkKey3="$moLbl3||$wkVal3"
        if(-not $tmp.ContainsKey($wkKey3)){$tmp[$wkKey3]=@{}}
        if($tmp[$wkKey3].ContainsKey($sw)){$tmp[$wkKey3][$sw]++}else{$tmp[$wkKey3][$sw]=1}
    }
    $res=@{}
    foreach($wkKey3 in $tmp.Keys){ $best3=$tmp[$wkKey3].GetEnumerator()|Sort-Object Value -Descending|Select-Object -First 1; $res[$wkKey3]=[double]$best3.Key }
    return $res
}
$salesWLookup = Get-SalesWByWeek $dataRows
$weekSalesArr = New-Object System.Collections.Generic.List[object]
for($wi2=0; $wi2 -lt $totalWeeks; $wi2++){
    $mi3 = $weekMonthOf[$wi2]; $wkKey4 = "$($months[$mi3])||$($allWeeks[$wi2])"
    if($salesWLookup.ContainsKey($wkKey4)){ [void]$weekSalesArr.Add($salesWLookup[$wkKey4]) } else { [void]$weekSalesArr.Add(0.0) }
}

# ---------- Overview ----------
function Build-ClassMonthCounts($rows){
    $res=[ordered]@{}
    foreach($r in $rows){ $c=Cell $r $Col.cls; if([string]::IsNullOrWhiteSpace($c)){continue}; $mo=Cell $r $Col.month; if([string]::IsNullOrWhiteSpace($mo)){continue}
        if(-not $res.Contains($c)){$res[$c]=[ordered]@{}}; if($res[$c].Contains($mo)){$res[$c][$mo]++}else{$res[$c][$mo]=1} }
    return $res
}
function Build-Pivot($title,$countsByClassMonth){
    $sb=New-Object System.Text.StringBuilder
    [void]$sb.Append("<div class='pivot-wrap'><div class='pivot-title'>$(HEnc $title)</div><div class='pivot-scroll'><table class='pivot-table'><thead><tr><th class='corner' rowspan='2'>Query Class</th>")
    foreach($mo in $months){[void]$sb.Append("<th colspan='2' class='month-hdr' data-yr='$(YearOf $mo)'>$(HEnc $mo)</th>")}
    [void]$sb.Append("</tr><tr>")
    foreach($mo in $months){[void]$sb.Append("<th class='sub-hdr' data-yr='$(YearOf $mo)'>Count</th><th class='sub-hdr' data-yr='$(YearOf $mo)'>%</th>")}
    [void]$sb.Append("</tr></thead><tbody>")
    $ri=0; $totals=@{}
    foreach($c in $B.Classes){ $ri++; $z=if($ri%2 -eq 1){"zebra"}else{""}
        [void]$sb.Append("<tr class='$z'><td class='rowlabel'>$(HEnc $c.label)</td>")
        foreach($mo in $months){ $cnt=0; if($countsByClassMonth.Contains($c.key) -and $countsByClassMonth[$c.key].Contains($mo)){$cnt=$countsByClassMonth[$c.key][$mo]}
            if(-not $totals.ContainsKey($mo)){$totals[$mo]=0}; $totals[$mo]+=$cnt
            $sm=0; if($salesM.ContainsKey($mo)){$sm=$salesM[$mo]}; $pct=0; if($sm -gt 0){$pct=Round1 ($cnt/$sm*100)}
            $cd=if($cnt -gt 0){$cnt.ToString('N0')}else{"-"}
            $yr=YearOf $mo
            [void]$sb.Append("<td class='num' data-yr='$yr'>$cd</td><td class='pct' data-yr='$yr'>$pct%</td>") }
        [void]$sb.Append("</tr>") }
    [void]$sb.Append("<tr class='total-row'><td class='rowlabel'>Total</td>")
    foreach($mo in $months){ $t=0; if($totals.ContainsKey($mo)){$t=$totals[$mo]}; $sm=0; if($salesM.ContainsKey($mo)){$sm=$salesM[$mo]}; $pct=0; if($sm -gt 0){$pct=Round1 ($t/$sm*100)}
        $yr=YearOf $mo
        [void]$sb.Append("<td class='num' data-yr='$yr'>$($t.ToString('N0'))</td><td class='pct' data-yr='$yr'>$pct%</td>") }
    [void]$sb.Append("</tr></tbody></table></div></div>")
    return $sb.ToString()
}
$totalRows=$dataRows.Count; $totalUnique=$unique.Count; $totalDup=$totalRows-$totalUnique
$ov=New-Object System.Text.StringBuilder
[void]$ov.Append("<div class=""kpi-row""><div class=""kpi""><div class=""label"">Total Rows</div><div class=""value"">$($totalRows.ToString('N0'))</div></div><div class=""kpi""><div class=""label"">Unique Tickets</div><div class=""value"">$($totalUnique.ToString('N0'))</div></div><div class=""kpi""><div class=""label"">Duplicate Rows</div><div class=""value"">$($totalDup.ToString('N0'))</div></div><div class=""kpi""><div class=""label"">Overall Duplicate Rate</div><div class=""value"">$(Round1 ($totalDup/$totalRows*100))%</div></div></div>")
$uniqClassMonth = Build-ClassMonthCounts $unique
[void]$ov.Append("<div class='gran-monthly'>")
[void]$ov.Append((Build-Pivot "Overall Query Class-Wise Comparison" (Build-ClassMonthCounts $dataRows)))
[void]$ov.Append((Build-Pivot "Unique Query Class-Wise Comparison" $uniqClassMonth))
[void]$ov.Append('<p class="note">Count = tickets that month for that query class. Percent = count &divide; that month''s total order volume ("Total Sales M"). "Overall" includes duplicates; "Unique" excludes them.</p>')
[void]$ov.Append("</div>")

# ---------- shared chart + category-pivot builders ----------
function Build-CategoryPivot($subset,$title,[ref]$monthTotalsOut){
    $catMonth=[ordered]@{}; $catTot=@{}
    foreach($r in $subset){ $cat=Cell $r $Col.cat; if([string]::IsNullOrWhiteSpace($cat)){$cat="(blank)"}; $mo=Cell $r $Col.month; if([string]::IsNullOrWhiteSpace($mo)){continue}
        if(-not $catMonth.Contains($cat)){$catMonth[$cat]=@{}}; if($catMonth[$cat].ContainsKey($mo)){$catMonth[$cat][$mo]++}else{$catMonth[$cat][$mo]=1}
        if(-not $catTot.ContainsKey($cat)){$catTot[$cat]=0}; $catTot[$cat]++ }
    $catOrder=$catTot.GetEnumerator()|Sort-Object Value -Descending|ForEach-Object{$_.Key}
    $sb=New-Object System.Text.StringBuilder
    [void]$sb.Append("<div class='pivot-wrap'><div class='pivot-title'>$(HEnc $title)</div><div class='pivot-scroll'><table class='pivot-table'><thead><tr><th class='corner' rowspan='2'>Query Category</th>")
    foreach($mo in $months){[void]$sb.Append("<th colspan='2' class='month-hdr' data-yr='$(YearOf $mo)'>$(HEnc $mo)</th>")}
    [void]$sb.Append("</tr><tr>")
    foreach($mo in $months){[void]$sb.Append("<th class='sub-hdr' data-yr='$(YearOf $mo)'>Complaints</th><th class='sub-hdr' data-yr='$(YearOf $mo)'>wrt sales</th>")}
    [void]$sb.Append("</tr></thead><tbody>")
    $ri=0; $totals=@{}
    foreach($cat in $catOrder){ $ri++; $z=if($ri%2 -eq 1){"zebra"}else{""}
        [void]$sb.Append("<tr class='$z'><td class='rowlabel'>$(HEnc $cat)</td>")
        foreach($mo in $months){ $cnt=0; if($catMonth[$cat].ContainsKey($mo)){$cnt=$catMonth[$cat][$mo]}
            if(-not $totals.ContainsKey($mo)){$totals[$mo]=0}; $totals[$mo]+=$cnt
            $sm=0; if($salesM.ContainsKey($mo)){$sm=$salesM[$mo]}; $pct=0; if($sm -gt 0){$pct=Round1 ($cnt/$sm*100)}
            $cd=if($cnt -gt 0){$cnt.ToString('N0')}else{"-"}; $pd=if($cnt -gt 0){"$pct%"}else{"-"}
            $yr=YearOf $mo
            [void]$sb.Append("<td class='num' data-yr='$yr'>$cd</td><td class='pct' data-yr='$yr'>$pd</td>") }
        [void]$sb.Append("</tr>") }
    [void]$sb.Append("<tr class='total-row'><td class='rowlabel'>Grand Total</td>")
    foreach($mo in $months){ $t=0; if($totals.ContainsKey($mo)){$t=$totals[$mo]}; $sm=0; if($salesM.ContainsKey($mo)){$sm=$salesM[$mo]}; $pct=0; if($sm -gt 0){$pct=Round1 ($t/$sm*100)}
        $yr=YearOf $mo
        [void]$sb.Append("<td class='num' data-yr='$yr'>$($t.ToString('N0'))</td><td class='pct' data-yr='$yr'>$pct%</td>") }
    [void]$sb.Append("</tr></tbody></table></div></div>")
    $mt=@(foreach($mo in $months){ if($totals.ContainsKey($mo)){$totals[$mo]}else{0} })
    $monthTotalsOut.Value=$mt
    return $sb.ToString()
}
function Build-ComboChart($vals,$title,$barColor,$lineColor){
    $pcts=@(); for($i=0;$i -lt $N;$i++){ $sm=$salesArr[$i]; $p=0; if($sm -gt 0){$p=[math]::Round(($vals[$i]/$sm*100),2)}; $pcts+=$p }
    $barMax=NiceMax ((($vals|Measure-Object -Maximum).Maximum)*1.15); $pctMax=NiceMax ((($pcts|Measure-Object -Maximum).Maximum)*1.2)
    $W=1200;$H=380;$padL=55;$padR=55;$padT=40;$padB=55;$plotW=$W-$padL-$padR;$plotH=$H-$padT-$padB;$slot=$plotW/$N;$barW=$slot*0.55
    $sb=New-Object System.Text.StringBuilder
    [void]$sb.Append("<div class='card'><div class='pivot-title' style='margin-bottom:18px;'>$(HEnc $title)</div><div class='legend-row' style='justify-content:center;'><div class='legend-item'><span class='swatch' style='background:$barColor;'></span><span class='lname'>Complaints</span></div><div class='legend-item'><span class='swatch' style='background:$lineColor;border-radius:50%;'></span><span class='lname'>wrt sales %</span></div></div>")
    [void]$sb.Append("<svg viewBox='0 0 $W $H' width='100%' height='$H' role='img'><line x1='$padL' y1='$($padT+$plotH)' x2='$($W-$padR)' y2='$($padT+$plotH)' stroke='var(--baseline)' stroke-width='1'/>")
    $pts=@()
    for($i=0;$i -lt $N;$i++){ $cx=$padL+$slot*$i+$slot/2; $bx=$cx-$barW/2; $bh=$plotH*($vals[$i]/$barMax); $by=$padT+$plotH-$bh; $yr=YearOf $months[$i]
        [void]$sb.Append("<g data-yr='$yr'><rect x='$bx' y='$by' width='$barW' height='$bh' fill='$barColor' rx='2'/><text x='$cx' y='$($by-8)' text-anchor='middle' font-size='10.5' fill='var(--text-primary)' font-weight='600'>$('{0:N0}' -f $vals[$i])</text>")
        $ly=$padT+$plotH-($plotH*($pcts[$i]/$pctMax)); $pts+="$cx,$ly"
        $ml=PrettyMonth $months[$i]; [void]$sb.Append("<text x='$cx' y='$($H-$padB+18)' text-anchor='middle' font-size='10.5' fill='var(--text-muted)'>$ml</text></g>") }
    [void]$sb.Append("<polyline points='$($pts -join ' ')' fill='none' stroke='$lineColor' stroke-width='2'/>")
    for($i=0;$i -lt $N;$i++){ $p=$pts[$i] -split ','; $yr=YearOf $months[$i]; [void]$sb.Append("<g data-yr='$yr'><circle cx='$($p[0])' cy='$($p[1])' r='3' fill='$lineColor'/><text x='$($p[0])' y='$([double]$p[1]-10)' text-anchor='middle' font-size='10.5' font-weight='600' fill='$lineColor'>$($pcts[$i])%</text></g>") }
    [void]$sb.Append("</svg></div>")
    return $sb.ToString()
}

# ---------- KPI helpers ----------
$classDup=[ordered]@{}
foreach($r in $dataRows){ $c=Cell $r $Col.cls; if([string]::IsNullOrWhiteSpace($c)){$c="(blank)"}; $f=Cell $r $Col.uniq
    if(-not $classDup.Contains($c)){$classDup[$c]=@{U=0;D=0}}; if($f -eq "Unique"){$classDup[$c].U++}elseif($f -eq "Duplicate"){$classDup[$c].D++} }
function KpiRow($cls,$subset){
    $m=$classDup[$cls.key]; if(-not $m){$m=@{U=$subset.Count;D=0}}
    $tot=$m.U+$m.D; $dup=if($tot -gt 0){Round1 ($m.D/$tot*100)}else{0}
    $share=if($totalUnique -gt 0){Round1 ($subset.Count/$totalUnique*100)}else{0}
    $tm=CountBy $subset $Col.month
    $peakKey=""; $peakVal=0; foreach($mo in $months){ $v=0; if($tm.Contains($mo)){$v=$tm[$mo]}; if($v -gt $peakVal){$peakVal=$v;$peakKey=$mo} }
    $peakLabel=if($peakKey){PrettyMonth $peakKey}else{"-"}
    $uid=if($cls.id -eq "delivery"){" id=""delivery-kpi-unique-label"""}else{""}
    $vid=if($cls.id -eq "delivery"){" id=""delivery-kpi-unique-value"""}else{""}
    return "<div class=""kpi-row""><div class=""kpi""><div class=""label""$uid>Unique Tickets</div><div class=""value""$vid>$($subset.Count.ToString('N0'))</div></div><div class=""kpi""><div class=""label"">Share of All Unique Tickets</div><div class=""value"">$share%</div></div><div class=""kpi""><div class=""label"">Duplicate Rate (this class)</div><div class=""value"">$dup%</div><div class=""sub"">$($m.D.ToString('N0')) duplicates</div></div><div class=""kpi""><div class=""label"">Peak Ticket Month</div><div class=""value"">$peakLabel</div><div class=""sub"">$($peakVal.ToString('N0')) tickets</div></div></div>"
}

# ---------- Batch table (packaging/product) ----------
function Build-BatchTable($subset,$title){
    $pm=[ordered]@{}; $pt=@{}
    foreach($r in $subset){ $b=Cell $r $Col.batch; if([string]::IsNullOrWhiteSpace($b)){continue}; $prod=Cell $r $Col.prod; if([string]::IsNullOrWhiteSpace($prod)){$prod="(blank)"}; $mo=Cell $r $Col.month; if([string]::IsNullOrWhiteSpace($mo)){continue}
        if(-not $pm.Contains($prod)){$pm[$prod]=@{}}; if($pm[$prod].ContainsKey($mo)){$pm[$prod][$mo]++}else{$pm[$prod][$mo]=1}
        if(-not $pt.ContainsKey($prod)){$pt[$prod]=0}; $pt[$prod]++ }
    $order=$pt.GetEnumerator()|Sort-Object Value -Descending|Select-Object -First 25|ForEach-Object{$_.Key}
    if(-not $order){ return "" }
    $sb=New-Object System.Text.StringBuilder
    [void]$sb.Append("<div class='pivot-wrap'><div class='pivot-title'>$(HEnc $title) Batch Numberwise Complaints - Monthly</div><div class='pivot-scroll'><table class='pivot-table'><thead><tr><th class='corner'>Product Name</th>")
    foreach($mo in $months){[void]$sb.Append("<th class='month-hdr' data-yr='$(YearOf $mo)'>$(HEnc $mo)</th>")}
    [void]$sb.Append("</tr></thead><tbody>")
    $ri=0; foreach($prod in $order){ $ri++; $z=if($ri%2 -eq 1){"zebra"}else{""}
        [void]$sb.Append("<tr class='$z'><td class='rowlabel' title=""$(HEnc $prod)"">$(HEnc $prod)</td>")
        foreach($mo in $months){ $cnt=0; if($pm[$prod].ContainsKey($mo)){$cnt=$pm[$prod][$mo]}; $cd=if($cnt -gt 0){$cnt.ToString('N0')}else{"-"}; [void]$sb.Append("<td class='num' data-yr='$(YearOf $mo)'>$cd</td>") }
        [void]$sb.Append("</tr>") }
    [void]$sb.Append("</tbody></table></div></div>")
    return "<section><h2>Batch Numberwise Complaints (Top 25 Products)</h2><p class=""desc"">Count of $(HEnc $title) tickets that carry a Batch Number, by product and ticket month.</p>$($sb.ToString())</section>"
}

Write-Host "[$($B.Brand)] building panels..."
. "$Here\gen-weekly.ps1"   # defines Build-Week* helpers for the weekly-granularity view
[void]$ov.Append((Build-WeeklyOverviewBlock))
[void]$ov.Append((Build-InsightsCard "Insights &mdash; Overview" (Get-OverviewInsightItems $uniqClassMonth)))
. "$Here\gen-monthly.ps1"  # defines Build-MonthlyAnalysisPanel using the vars above
. "$Here\gen-panels.ps1"   # defines Build-DeliveryPanel, Build-ClassPanel, Build-NpsCsat, Build-ProdPkg using the vars above

$html = Assemble-Report
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $OutPath) | Out-Null
Set-Content -Path $OutPath -Value $html -Encoding utf8
Write-Host "[$($B.Brand)] wrote $OutPath ($([math]::Round((Get-Item $OutPath).Length/1KB)) KB)"
