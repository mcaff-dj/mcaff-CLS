# Monthly/Weekly Analysis tab: auto-generated narrative comparing a picked period to the
# one before it, mirroring the manual "segmented KYC" write-up style. Stats-only — no
# root-cause text is inferred, since that isn't present in any structured column.
# Dot-sourced by Generate-Report.ps1 (shares its variables/functions). Depends on gen-weekly.ps1
# having already run (for $allWeeks / $weekMonthOf / $totalWeeks / Get-WeekNum).

function PctFmt($v){
    if($null -eq $v){ return "-" }
    if($v -ge 1){ return "$([math]::Round($v,2))%" }
    return "$([math]::Round($v,3))%"
}

function ChangeVerb($prev,$cur){
    if($prev -le 0){ if($cur -gt 0){ return "appeared" } else { return "held at" } }
    if($cur -le 0){ return "disappeared" }
    $mult = $cur/$prev
    if($mult -lt 1){
        $drop = 1-$mult
        if($drop -ge 0.5){ return "dropped sharply" }
        elseif($drop -ge 0.25){ return "fell" }
        else { return "eased" }
    }
    if($mult -ge 5.5){ return "increased $([math]::Round($mult))-fold" }
    elseif($mult -ge 2.6){ return "nearly tripled" }
    elseif($mult -ge 1.8){ return "nearly doubled" }
    elseif($mult -ge 1.35){ return "surged" }
    elseif($mult -ge 1.12){ return "rose" }
    else { return "edged up" }
}

# One-level drill-down dimension per class id.
$script:MA_SubDim   = @{ delivery="partner"; warehouse="wh"; packaging="prod"; product="prod"; suggestion="prod" }
$script:MA_SubLabel = @{ partner="courier"; wh="warehouse"; prod="product" }

# Fast (month-label, week-label) -> global week index lookup.
$script:MA_WeekGlobalIdx = @{}
for($mawi=0; $mawi -lt $totalWeeks; $mawi++){ $script:MA_WeekGlobalIdx["$($months[$weekMonthOf[$mawi]])||$($allWeeks[$mawi])"] = $mawi }
function Get-GlobalWeekIndex($moLbl,$wkVal){ $k="$moLbl||$wkVal"; if($script:MA_WeekGlobalIdx.ContainsKey($k)){ return $script:MA_WeekGlobalIdx[$k] }; return -1 }
function PrettyWeekFull($weekIdx){
    $mi=$weekMonthOf[$weekIdx]; $wn=Get-WeekNum $allWeeks[$weekIdx]
    $lbl="$(PrettyMonth $months[$mi]) W$wn"
    if($weekIdx -eq $lastWeekIdx){ $lbl += " (partial)" }
    return $lbl
}

# Period context: abstracts "month" vs "week" so the narrative builders below run unchanged
# against either. indexFn returns this row's period index (or -1 to skip); labelFn formats it.
$script:MA_MonthCtx = @{
    n = $N
    sales = $salesArr
    indexFn = { param($r) [array]::IndexOf($months,(Cell $r $Col.month)) }
    labelFn = { param($idx) PrettyMonth $months[$idx] }
}
$script:MA_WeekCtx = @{
    n = $totalWeeks
    sales = $weekSalesArr
    indexFn = { param($r)
        $wk=Cell $r $Col.week; if([string]::IsNullOrWhiteSpace($wk) -or $wk -eq "#N/A"){ return -1 }
        Get-GlobalWeekIndex (Cell $r $Col.month) $wk
    }
    labelFn = { param($idx) PrettyWeekFull $idx }
}

# Year index lookup + year-summed sales, built from the same $distinctYears the Year
# filter chips use, so "2025" here always means the same set of months as elsewhere.
$script:MA_YearIndexOf = @{}
for($mayi=0; $mayi -lt $distinctYears.Count; $mayi++){ $script:MA_YearIndexOf[$distinctYears[$mayi]] = $mayi }
$script:MA_YearSalesArr = New-Object 'double[]' $distinctYears.Count
for($mayi2=0; $mayi2 -lt $N; $mayi2++){ $yr=YearOf $months[$mayi2]; if($script:MA_YearIndexOf.ContainsKey($yr)){ $script:MA_YearSalesArr[$script:MA_YearIndexOf[$yr]] += $salesArr[$mayi2] } }
$script:MA_YearCtx = @{
    n = $distinctYears.Count
    sales = $script:MA_YearSalesArr
    indexFn = { param($r) $yr=YearOf (Cell $r $Col.month); if($script:MA_YearIndexOf.ContainsKey($yr)){ return $script:MA_YearIndexOf[$yr] }; return -1 }
    labelFn = { param($idx) $distinctYears[$idx] }
}

function Build-ClassPeriodData($cls,$period){
    $subset = @($unique | Where-Object { (Cell $_ $Col.cls) -eq $cls.key })
    $subDimName = $script:MA_SubDim[$cls.id]
    $subCol = if($subDimName){ $Col[$subDimName] } else { $null }

    $catPeriod=[ordered]@{}; $catTot=@{}
    $subPeriod=@{}
    $classPeriodTot = New-Object 'int[]' $period.n

    foreach($r in $subset){
        $pIdx = & $period.indexFn $r
        if($pIdx -lt 0){continue}
        $cat=Cell $r $Col.cat; if([string]::IsNullOrWhiteSpace($cat)){$cat="(blank)"}
        if(-not $catPeriod.Contains($cat)){$catPeriod[$cat]=(New-Object 'int[]' $period.n)}
        $catPeriod[$cat][$pIdx]++
        if(-not $catTot.ContainsKey($cat)){$catTot[$cat]=0}; $catTot[$cat]++
        $classPeriodTot[$pIdx]++
        if($subCol -ne $null){
            $sv=Cell $r $subCol; if([string]::IsNullOrWhiteSpace($sv)){$sv="(blank)"}
            if(-not $subPeriod.ContainsKey($cat)){$subPeriod[$cat]=@{}}
            if(-not $subPeriod[$cat].ContainsKey($sv)){$subPeriod[$cat][$sv]=(New-Object 'int[]' $period.n)}
            $subPeriod[$cat][$sv][$pIdx]++
        }
    }
    $catOrder=@($catTot.GetEnumerator()|Sort-Object Value -Descending|ForEach-Object{$_.Key})
    return @{ catPeriod=$catPeriod; catOrder=$catOrder; subPeriod=$subPeriod; subDimName=$subDimName; classPeriodTot=$classPeriodTot }
}

function Build-ClassPeriodNarrative($cls,$data,$period,$curIdx){
    $prevIdx=$curIdx-1
    $curLabel = & $period.labelFn $curIdx
    $prevLabel = & $period.labelFn $prevIdx
    $salesCur=$period.sales[$curIdx]; $salesPrev=$period.sales[$prevIdx]
    $totCur=$data.classPeriodTot[$curIdx]; $totPrev=$data.classPeriodTot[$prevIdx]
    $pctCur=if($salesCur -gt 0){$totCur/$salesCur*100}else{0}
    $pctPrev=if($salesPrev -gt 0){$totPrev/$salesPrev*100}else{0}
    $relChange = if($pctPrev -gt 0){[math]::Abs($pctCur-$pctPrev)/$pctPrev} else { if($pctCur -gt 0){1}else{0} }

    $bullets=@()
    foreach($cat in $data.catOrder){
        $curC=$data.catPeriod[$cat][$curIdx]; $prevC=$data.catPeriod[$cat][$prevIdx]
        if($curC -lt 3){ continue }
        $growth = if($prevC -gt 0){$curC/$prevC}else{[double]::PositiveInfinity}
        $absDelta = $curC-$prevC
        $qualifies = ($prevC -eq 0 -and $curC -ge 3) -or ($prevC -gt 0 -and ($growth -ge 1.3 -or $absDelta -ge 10))
        if(-not $qualifies){ continue }
        $pC=if($salesCur -gt 0){$curC/$salesCur*100}else{0}
        $pP=if($salesPrev -gt 0){$prevC/$salesPrev*100}else{0}
        $verb=ChangeVerb $prevC $curC
        $line="<b>$(HEnc $cat)</b>: Complaints $verb from $($prevC.ToString('N0')) to $($curC.ToString('N0')) ($(PctFmt $pP) &rarr; $(PctFmt $pC))."

        $subLines=@()
        if($data.subDimName -and $data.subPeriod.ContainsKey($cat)){
            $movers=@()
            foreach($sv in $data.subPeriod[$cat].Keys){
                if($sv -eq "(blank)"){continue}
                $sc=$data.subPeriod[$cat][$sv][$curIdx]; $sp=$data.subPeriod[$cat][$sv][$prevIdx]
                $d=$sc-$sp
                if($d -gt 0 -and $sc -ge 3){ $movers += @{name=$sv;cur=$sc;prev=$sp;delta=$d} }
            }
            $movers = @($movers | Sort-Object -Property delta -Descending | Select-Object -First 2)
            foreach($m in $movers){
                if($absDelta -gt 0 -and ($m.delta/$absDelta) -lt 0.25){continue}
                $mp=if($salesCur -gt 0){$m.cur/$salesCur*100}else{0}
                $mpp=if($salesPrev -gt 0){$m.prev/$salesPrev*100}else{0}
                $mverb=ChangeVerb $m.prev $m.cur
                $subLabel=$script:MA_SubLabel[$data.subDimName]
                $subLines += "<li><b>$(HEnc $m.name)</b> ($subLabel): complaint rate $mverb from $(PctFmt $mpp) to $(PctFmt $mp) ($($m.prev.ToString('N0')) &rarr; $($m.cur.ToString('N0')))."
            }
        }
        if($subLines.Count -gt 0){ $line += "<ul class='ma-sub'>$($subLines -join '')</ul>" }
        $bullets += @{ line=$line; sortKey=$absDelta }
    }
    $bullets = @($bullets | Sort-Object -Property sortKey -Descending)

    if($bullets.Count -eq 0 -and $relChange -lt 0.1){ return "" }

    $overallVerb = ChangeVerb $pctPrev $pctCur
    $sb=New-Object System.Text.StringBuilder
    [void]$sb.Append("<div class='ma-class'><h4>$(HEnc $cls.label) Complaints</h4>")
    [void]$sb.Append("<p class='ma-overall'>Overall $(HEnc $cls.label.ToLower()) complaints $overallVerb from $(PctFmt $pctPrev) in $prevLabel to $(PctFmt $pctCur) in $curLabel.</p>")
    if($bullets.Count -gt 0){
        [void]$sb.Append("<ul class='ma-list'>")
        foreach($b in $bullets){ [void]$sb.Append("<li>$($b.line)</li>") }
        [void]$sb.Append("</ul>")
    }
    [void]$sb.Append("</div>")
    return $sb.ToString()
}

function Build-MonthlyAnalysisPanel {
    if($N -lt 2){ return "" }

    # ---------- Monthly narrative (existing) ----------
    $monthClassData=@{}
    foreach($c in $B.Classes){ $monthClassData[$c.key] = Build-ClassPeriodData $c $script:MA_MonthCtx }
    $monthDivs=New-Object System.Text.StringBuilder
    for($mi=1; $mi -lt $N; $mi++){
        $sections=@()
        foreach($c in $B.Classes){
            $html = Build-ClassPeriodNarrative $c $monthClassData[$c.key] $script:MA_MonthCtx $mi
            if($html){ $sections += $html }
        }
        $body = if($sections.Count -gt 0){ $sections -join "" } else { "<p class='note'>No notable month-on-month changes crossed the reporting threshold for $(HEnc (PrettyMonth $months[$mi])).</p>" }
        $disp = if($mi -eq $N-1){""}else{" style='display:none;'"}
        [void]$monthDivs.Append("<div class='ma-period' id='ma-month-$mi'$disp>$body</div>")
    }
    $monthOpts=New-Object System.Text.StringBuilder
    for($mi=1; $mi -lt $N; $mi++){ $sel=if($mi -eq $N-1){" selected"}else{""}; [void]$monthOpts.Append("<option value='$mi'$sel>$(HEnc (PrettyMonth $months[$mi])) vs $(HEnc (PrettyMonth $months[$mi-1]))</option>") }

    # ---------- Weekly narrative (new) ----------
    $weekDivs=New-Object System.Text.StringBuilder
    $weekOpts=New-Object System.Text.StringBuilder
    if($totalWeeks -ge 2){
        $weekClassData=@{}
        foreach($c in $B.Classes){ $weekClassData[$c.key] = Build-ClassPeriodData $c $script:MA_WeekCtx }
        for($wi=1; $wi -lt $totalWeeks; $wi++){
            $sections=@()
            foreach($c in $B.Classes){
                $html = Build-ClassPeriodNarrative $c $weekClassData[$c.key] $script:MA_WeekCtx $wi
                if($html){ $sections += $html }
            }
            $body = if($sections.Count -gt 0){ $sections -join "" } else { "<p class='note'>No notable week-on-week changes crossed the reporting threshold for $(HEnc (PrettyWeekFull $wi)).</p>" }
            $disp = if($wi -eq $totalWeeks-1){""}else{" style='display:none;'"}
            [void]$weekDivs.Append("<div class='ma-period' id='ma-week-$wi'$disp>$body</div>")
        }
        for($wi=1; $wi -lt $totalWeeks; $wi++){ $sel=if($wi -eq $totalWeeks-1){" selected"}else{""}; [void]$weekOpts.Append("<option value='$wi'$sel>$(HEnc (PrettyWeekFull $wi)) vs $(HEnc (PrettyWeekFull ($wi-1)))</option>") }
    }

    # ---------- Yearly narrative (new) ----------
    $yearDivs=New-Object System.Text.StringBuilder
    $yearOpts=New-Object System.Text.StringBuilder
    if($distinctYears.Count -ge 2){
        $yearClassData=@{}
        foreach($c in $B.Classes){ $yearClassData[$c.key] = Build-ClassPeriodData $c $script:MA_YearCtx }
        for($yi=1; $yi -lt $distinctYears.Count; $yi++){
            $sections=@()
            foreach($c in $B.Classes){
                $html = Build-ClassPeriodNarrative $c $yearClassData[$c.key] $script:MA_YearCtx $yi
                if($html){ $sections += $html }
            }
            $body = if($sections.Count -gt 0){ $sections -join "" } else { "<p class='note'>No notable year-on-year changes crossed the reporting threshold for $(HEnc $distinctYears[$yi]).</p>" }
            $disp = if($yi -eq $distinctYears.Count-1){""}else{" style='display:none;'"}
            [void]$yearDivs.Append("<div class='ma-period' id='ma-year-$yi'$disp>$body</div>")
        }
        for($yi=1; $yi -lt $distinctYears.Count; $yi++){ $sel=if($yi -eq $distinctYears.Count-1){" selected"}else{""}; [void]$yearOpts.Append("<option value='$yi'$sel>$(HEnc $distinctYears[$yi]) vs $(HEnc $distinctYears[$yi-1])</option>") }
    }

    $js = @"
<script>
(function(){
  window.onMonthlyAnalysisChange=function(v){
    document.querySelectorAll('#ma-monthly-wrap .ma-period').forEach(function(el){ el.style.display = (el.id==='ma-month-'+v) ? '' : 'none'; });
  };
  window.onWeeklyAnalysisChange=function(v){
    document.querySelectorAll('#ma-weekly-wrap .ma-period').forEach(function(el){ el.style.display = (el.id==='ma-week-'+v) ? '' : 'none'; });
  };
  window.onYearlyAnalysisChange=function(v){
    document.querySelectorAll('#ma-yearly-wrap .ma-period').forEach(function(el){ el.style.display = (el.id==='ma-year-'+v) ? '' : 'none'; });
  };
  window.setMaGranularity=function(g){
    document.querySelectorAll('.ma-gran-toggle .gran-btn').forEach(function(b){ b.classList.toggle('active', b.dataset.magran===g); });
    var mw=document.getElementById('ma-monthly-wrap'), ww=document.getElementById('ma-weekly-wrap'), yw=document.getElementById('ma-yearly-wrap');
    if(mw){ mw.style.display = (g==='monthly') ? '' : 'none'; }
    if(ww){ ww.style.display = (g==='weekly') ? '' : 'none'; }
    if(yw){ yw.style.display = (g==='yearly') ? '' : 'none'; }
  };
})();
</script>
"@

    $weeklyToggleHtml = if($totalWeeks -ge 2){ "<button type=""button"" class=""gran-btn"" data-magran=""weekly"" onclick=""setMaGranularity('weekly')"">Weekly</button>" } else { "" }
    $weeklySectionHtml = if($totalWeeks -ge 2){
@"
    <div id="ma-weekly-wrap" style="display:none;">
      <div style="margin-bottom:18px;"><label for="ma-week-select" style="font-size:12px;color:var(--text-muted);margin-right:8px;">Week</label><select id="ma-week-select" onchange="onWeeklyAnalysisChange(this.value)" style="font-size:13px;padding:7px 12px;border-radius:8px;border:1px solid var(--border);background:var(--surface-card);color:var(--text-primary);font-family:inherit;">$($weekOpts.ToString())</select></div>
      $($weekDivs.ToString())
    </div>
"@
    } else { "" }
    $yearlyToggleHtml = if($distinctYears.Count -ge 2){ "<button type=""button"" class=""gran-btn"" data-magran=""yearly"" onclick=""setMaGranularity('yearly')"">Yearly</button>" } else { "" }
    $yearlySectionHtml = if($distinctYears.Count -ge 2){
@"
    <div id="ma-yearly-wrap" style="display:none;">
      <div style="margin-bottom:18px;"><label for="ma-year-select" style="font-size:12px;color:var(--text-muted);margin-right:8px;">Year</label><select id="ma-year-select" onchange="onYearlyAnalysisChange(this.value)" style="font-size:13px;padding:7px 12px;border-radius:8px;border:1px solid var(--border);background:var(--surface-card);color:var(--text-primary);font-family:inherit;">$($yearOpts.ToString())</select></div>
      $($yearDivs.ToString())
    </div>
"@
    } else { "" }

    return @"
<div class="tab-panel" id="panel-monthly">
  <section>
    <h2>Monthly Analysis</h2>
    <p class="desc">Auto-generated from ticket data &mdash; compares the selected period to the one before it. Figures are wrt that period's total sales; drill-downs show the courier/warehouse/product driving most of a category's change. Root-cause context (e.g. a specific coupon bug) isn't captured in the data and is not inferred here.</p>
    <div class="ma-gran-toggle">
      <button type="button" class="gran-btn active" data-magran="monthly" onclick="setMaGranularity('monthly')">Monthly</button>
      $weeklyToggleHtml
      $yearlyToggleHtml
    </div>
    <div id="ma-monthly-wrap">
      <div style="margin-bottom:18px;"><label for="ma-select" style="font-size:12px;color:var(--text-muted);margin-right:8px;">Month</label><select id="ma-select" onchange="onMonthlyAnalysisChange(this.value)" style="font-size:13px;padding:7px 12px;border-radius:8px;border:1px solid var(--border);background:var(--surface-card);color:var(--text-primary);font-family:inherit;">$($monthOpts.ToString())</select></div>
      $($monthDivs.ToString())
    </div>
$weeklySectionHtml
$yearlySectionHtml
  </section>
</div>
$js
"@
}
