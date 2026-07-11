# Weekly-granularity builders, dot-sourced by Generate-Report.ps1 (shares its variables/functions).
# Reuses the sheet's own native Week / Total Sales W columns. For each month that has real
# week data, pre-renders a week-columned variant of the Overview pivots and each (non-Delivery)
# class's category pivot + chart, hidden by default. A global Monthly/Weekly toggle + month
# picker (built in gen-panels.ps1) shows/hides the right one client-side — no dynamic DOM
# construction needed, consistent with how the rest of this report is built.
#
# Bucketing is done in a SINGLE pass per dataset (not once per month) to avoid an
# O(months x rows) rescan — important since this report's row counts run into the 100k range.

$script:WeeklyEligibleMonths = @(for($wemi=0; $wemi -lt $N; $wemi++){ if($weeksByMonthIdx[$wemi].Count -gt 0){ $wemi } })
$script:MonthIndexLookup = @{}
for($wemi2=0; $wemi2 -lt $N; $wemi2++){ $script:MonthIndexLookup[$months[$wemi2]] = $wemi2 }

function Get-WeekSalesMap($monthIdx){
    $map=[ordered]@{}
    $start=$weekStartIdx[$monthIdx]; $wks=$weeksByMonthIdx[$monthIdx]
    for($j=0; $j -lt $wks.Count; $j++){ $map[$wks[$j]] = $weekSalesArr[$start+$j] }
    return $map
}
function Is-PartialWeek($weekVal, $monthIdx){
    if($monthIdx -ne ($N-1)){ return $false }
    $lastMonthWeeks = $weeksByMonthIdx[$monthIdx]
    if($lastMonthWeeks.Count -eq 0){ return $false }
    return ($weekVal -eq $lastMonthWeeks[$lastMonthWeeks.Count-1])
}
function WeekColHeader($weekVal, $monthIdx){
    $wn = Get-WeekNum $weekVal
    $lbl = "W$wn"
    if(Is-PartialWeek $weekVal $monthIdx){ $lbl += " (partial)" }
    return $lbl
}

# Single pass over $rows: buckets by (month, keyColIdx value, week). Returns an array
# (index = month index) of @{ byKey = [ordered] key->weekVal->count; keyTot = key->count }.
function Get-WeekBucketsAllMonths($rows, $keyColIdx){
    $byMonth = @()
    for($m=0; $m -lt $N; $m++){ $byMonth += ,@{ byKey=[ordered]@{}; keyTot=@{} } }
    foreach($r in $rows){
        $moLbl = Cell $r $Col.month
        if(-not $script:MonthIndexLookup.ContainsKey($moLbl)){ continue }
        $mi = $script:MonthIndexLookup[$moLbl]
        $wkVal = Cell $r $Col.week; if([string]::IsNullOrWhiteSpace($wkVal) -or $wkVal -eq "#N/A"){ continue }
        $k = Cell $r $keyColIdx; if([string]::IsNullOrWhiteSpace($k)){ $k = "(blank)" }
        $bkt = $byMonth[$mi]
        if(-not $bkt.byKey.Contains($k)){ $bkt.byKey[$k] = @{} }
        if($bkt.byKey[$k].ContainsKey($wkVal)){ $bkt.byKey[$k][$wkVal]++ } else { $bkt.byKey[$k][$wkVal]=1 }
        if(-not $bkt.keyTot.ContainsKey($k)){ $bkt.keyTot[$k]=0 }; $bkt.keyTot[$k]++
    }
    return $byMonth
}

function Build-PeriodPivot($title, $cornerLabel, $rowDefs, $byKeyCounts, $weekList, $weekSalesMap, $monthIdx){
    $sb=New-Object System.Text.StringBuilder
    [void]$sb.Append("<div class='pivot-wrap'><div class='pivot-title'>$(HEnc $title)</div><div class='pivot-scroll'><table class='pivot-table'><thead><tr><th class='corner' rowspan='2'>$(HEnc $cornerLabel)</th>")
    foreach($wk in $weekList){ [void]$sb.Append("<th colspan='2' class='month-hdr'>$(HEnc (WeekColHeader $wk $monthIdx))</th>") }
    [void]$sb.Append("</tr><tr>")
    foreach($wk in $weekList){ [void]$sb.Append("<th class='sub-hdr'>Count</th><th class='sub-hdr'>%</th>") }
    [void]$sb.Append("</tr></thead><tbody>")
    $ri=0; $totals=@{}
    foreach($rd in $rowDefs){ $ri++; $z=if($ri%2 -eq 1){"zebra"}else{""}
        [void]$sb.Append("<tr class='$z'><td class='rowlabel'>$(HEnc $rd.label)</td>")
        foreach($wk in $weekList){
            $cnt=0; if($byKeyCounts.Contains($rd.key) -and $byKeyCounts[$rd.key].ContainsKey($wk)){$cnt=$byKeyCounts[$rd.key][$wk]}
            if(-not $totals.ContainsKey($wk)){$totals[$wk]=0}; $totals[$wk]+=$cnt
            $sm=0; if($weekSalesMap.Contains($wk)){$sm=$weekSalesMap[$wk]}; $pct=0; if($sm -gt 0){$pct=Round1 ($cnt/$sm*100)}
            $cd=if($cnt -gt 0){$cnt.ToString('N0')}else{"-"}
            [void]$sb.Append("<td class='num'>$cd</td><td class='pct'>$pct%</td>")
        }
        [void]$sb.Append("</tr>")
    }
    [void]$sb.Append("<tr class='total-row'><td class='rowlabel'>Total</td>")
    foreach($wk in $weekList){ $t=0; if($totals.ContainsKey($wk)){$t=$totals[$wk]}; $sm=0; if($weekSalesMap.Contains($wk)){$sm=$weekSalesMap[$wk]}; $pct=0; if($sm -gt 0){$pct=Round1 ($t/$sm*100)}
        [void]$sb.Append("<td class='num'>$($t.ToString('N0'))</td><td class='pct'>$pct%</td>") }
    [void]$sb.Append("</tr></tbody></table></div></div>")
    return $sb.ToString()
}

function Build-PeriodChart($title, $vals, $weekList, $weekSalesMap, $monthIdx, $barColor, $lineColor){
    $n=$weekList.Count
    if($n -eq 0){ return "<div class='card'><p class='note'>No weekly data.</p></div>" }
    $pcts=@(); for($i=0; $i -lt $n; $i++){ $sm=0; if($weekSalesMap.Contains($weekList[$i])){$sm=$weekSalesMap[$weekList[$i]]}; $p=0; if($sm -gt 0){$p=[math]::Round(($vals[$i]/$sm*100),2)}; $pcts+=$p }
    $barMax=NiceMax ((($vals|Measure-Object -Maximum).Maximum)*1.15); $pctMax=NiceMax ((($pcts|Measure-Object -Maximum).Maximum)*1.2)
    $W=1200;$H=380;$padL=55;$padR=55;$padT=40;$padB=55;$plotW=$W-$padL-$padR;$plotH=$H-$padT-$padB;$slot=$plotW/$n;$barW=$slot*0.55
    $sb=New-Object System.Text.StringBuilder
    [void]$sb.Append("<div class='card'><div class='pivot-title' style='margin-bottom:18px;'>$(HEnc $title)</div><div class='legend-row' style='justify-content:center;'><div class='legend-item'><span class='swatch' style='background:$barColor;'></span><span class='lname'>Complaints</span></div><div class='legend-item'><span class='swatch' style='background:$lineColor;border-radius:50%;'></span><span class='lname'>wrt sales %</span></div></div>")
    [void]$sb.Append("<svg viewBox='0 0 $W $H' width='100%' height='$H' role='img'><line x1='$padL' y1='$($padT+$plotH)' x2='$($W-$padR)' y2='$($padT+$plotH)' stroke='var(--baseline)' stroke-width='1'/>")
    $pts=@()
    for($i=0; $i -lt $n; $i++){ $cx=$padL+$slot*$i+$slot/2; $bx=$cx-$barW/2; $bh=$plotH*($vals[$i]/$barMax); $by=$padT+$plotH-$bh
        [void]$sb.Append("<rect x='$bx' y='$by' width='$barW' height='$bh' fill='$barColor' rx='2'/><text x='$cx' y='$($by-8)' text-anchor='middle' font-size='10.5' fill='var(--text-primary)' font-weight='600'>$('{0:N0}' -f $vals[$i])</text>")
        $ly=$padT+$plotH-($plotH*($pcts[$i]/$pctMax)); $pts+="$cx,$ly"
        $ml=WeekColHeader $weekList[$i] $monthIdx; [void]$sb.Append("<text x='$cx' y='$($H-$padB+18)' text-anchor='middle' font-size='10.5' fill='var(--text-muted)'>$ml</text>") }
    [void]$sb.Append("<polyline points='$($pts -join ' ')' fill='none' stroke='$lineColor' stroke-width='2'/>")
    for($i=0; $i -lt $n; $i++){ $p=$pts[$i] -split ','; [void]$sb.Append("<circle cx='$($p[0])' cy='$($p[1])' r='3' fill='$lineColor'/><text x='$($p[0])' y='$([double]$p[1]-10)' text-anchor='middle' font-size='10.5' font-weight='600' fill='$lineColor'>$($pcts[$i])%</text>") }
    [void]$sb.Append("</svg></div>")
    return $sb.ToString()
}

function Build-WeeklyOverviewBlock {
    if($script:WeeklyEligibleMonths.Count -eq 0){ return "" }
    $rowDefs = @($B.Classes | ForEach-Object { @{ key=$_.key; label=$_.label } })
    $overallByMonth = Get-WeekBucketsAllMonths $dataRows $Col.cls
    $uniqueByMonth  = Get-WeekBucketsAllMonths $unique    $Col.cls
    $sb=New-Object System.Text.StringBuilder
    foreach($mi in $script:WeeklyEligibleMonths){
        $weekList = $weeksByMonthIdx[$mi]
        $weekSalesMap = Get-WeekSalesMap $mi
        [void]$sb.Append("<div class='gran-weekly' data-month='$mi' style='display:none;'>")
        [void]$sb.Append("<p class='note'>Weekly view for $(HEnc (PrettyMonth $months[$mi])).</p>")
        [void]$sb.Append((Build-PeriodPivot "Overall Query Class-Wise Comparison (Weekly)" "Query Class" $rowDefs $overallByMonth[$mi].byKey $weekList $weekSalesMap $mi))
        [void]$sb.Append((Build-PeriodPivot "Unique Query Class-Wise Comparison (Weekly)" "Query Class" $rowDefs $uniqueByMonth[$mi].byKey $weekList $weekSalesMap $mi))
        [void]$sb.Append("</div>")
    }
    return $sb.ToString()
}

function Build-WeeklyClassBlock($cls){
    if($script:WeeklyEligibleMonths.Count -eq 0){ return "" }
    $subset = @($unique | Where-Object { (Cell $_ $Col.cls) -eq $cls.key })
    $byMonth = Get-WeekBucketsAllMonths $subset $Col.cat
    $sb=New-Object System.Text.StringBuilder
    foreach($mi in $script:WeeklyEligibleMonths){
        $weekList = $weeksByMonthIdx[$mi]
        $weekSalesMap = Get-WeekSalesMap $mi
        $bkt = $byMonth[$mi]
        if($bkt.keyTot.Count -eq 0){
            [void]$sb.Append("<div class='gran-weekly' data-month='$mi' style='display:none;'><p class='note'>No $(HEnc $cls.label) tickets in $(HEnc (PrettyMonth $months[$mi])).</p></div>")
            continue
        }
        $catOrder = @($bkt.keyTot.GetEnumerator() | Sort-Object Value -Descending | ForEach-Object { $_.Key })
        $rowDefs = @($catOrder | ForEach-Object { @{ key=$_; label=$_ } })
        $vals = @(foreach($wk in $weekList){ $t=0; foreach($k in $catOrder){ if($bkt.byKey[$k].ContainsKey($wk)){ $t += $bkt.byKey[$k][$wk] } }; $t })
        [void]$sb.Append("<div class='gran-weekly' data-month='$mi' style='display:none;'>")
        [void]$sb.Append("<p class='note'>Weekly view for $(HEnc (PrettyMonth $months[$mi])).</p>")
        [void]$sb.Append((Build-PeriodPivot "$(HEnc $cls.label) Complaints (Weekly)" "Query Category" $rowDefs $bkt.byKey $weekList $weekSalesMap $mi))
        [void]$sb.Append((Build-PeriodChart "$(HEnc $cls.label) Complaints wrt Sales (Weekly)" $vals $weekList $weekSalesMap $mi $cls.color "var(--s1)"))
        [void]$sb.Append("</div>")
    }
    return $sb.ToString()
}
