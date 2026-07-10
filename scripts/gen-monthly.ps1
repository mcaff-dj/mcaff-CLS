# Monthly Analysis tab: auto-generated narrative comparing a picked month to the one
# before it, mirroring the manual "segmented KYC" write-up style. Stats-only — no
# root-cause text is inferred, since that isn't present in any structured column.
# Dot-sourced by Generate-Report.ps1 (shares its variables/functions).

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

function Build-ClassMonthlyData($cls){
    $subset = @($unique | Where-Object { (Cell $_ $Col.cls) -eq $cls.key })
    $subDimName = $script:MA_SubDim[$cls.id]
    $subCol = if($subDimName){ $Col[$subDimName] } else { $null }

    $catMonth=[ordered]@{}; $catTot=@{}
    $subMonth=@{}
    $classMonthTot = New-Object 'int[]' $N

    foreach($r in $subset){
        $mo=Cell $r $Col.month; $mi=[array]::IndexOf($months,$mo); if($mi -lt 0){continue}
        $cat=Cell $r $Col.cat; if([string]::IsNullOrWhiteSpace($cat)){$cat="(blank)"}
        if(-not $catMonth.Contains($cat)){$catMonth[$cat]=(New-Object 'int[]' $N)}
        $catMonth[$cat][$mi]++
        if(-not $catTot.ContainsKey($cat)){$catTot[$cat]=0}; $catTot[$cat]++
        $classMonthTot[$mi]++
        if($subCol -ne $null){
            $sv=Cell $r $subCol; if([string]::IsNullOrWhiteSpace($sv)){$sv="(blank)"}
            if(-not $subMonth.ContainsKey($cat)){$subMonth[$cat]=@{}}
            if(-not $subMonth[$cat].ContainsKey($sv)){$subMonth[$cat][$sv]=(New-Object 'int[]' $N)}
            $subMonth[$cat][$sv][$mi]++
        }
    }
    $catOrder=@($catTot.GetEnumerator()|Sort-Object Value -Descending|ForEach-Object{$_.Key})
    return @{ catMonth=$catMonth; catOrder=$catOrder; subMonth=$subMonth; subDimName=$subDimName; classMonthTot=$classMonthTot }
}

function Build-ClassNarrative($cls,$data,$curIdx){
    $prevIdx=$curIdx-1
    $curLabel=PrettyMonth $months[$curIdx]; $prevLabel=PrettyMonth $months[$prevIdx]
    $salesCur=$salesArr[$curIdx]; $salesPrev=$salesArr[$prevIdx]
    $totCur=$data.classMonthTot[$curIdx]; $totPrev=$data.classMonthTot[$prevIdx]
    $pctCur=if($salesCur -gt 0){$totCur/$salesCur*100}else{0}
    $pctPrev=if($salesPrev -gt 0){$totPrev/$salesPrev*100}else{0}
    $relChange = if($pctPrev -gt 0){[math]::Abs($pctCur-$pctPrev)/$pctPrev} else { if($pctCur -gt 0){1}else{0} }

    $bullets=@()
    foreach($cat in $data.catOrder){
        $curC=$data.catMonth[$cat][$curIdx]; $prevC=$data.catMonth[$cat][$prevIdx]
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
        if($data.subDimName -and $data.subMonth.ContainsKey($cat)){
            $movers=@()
            foreach($sv in $data.subMonth[$cat].Keys){
                if($sv -eq "(blank)"){continue}
                $sc=$data.subMonth[$cat][$sv][$curIdx]; $sp=$data.subMonth[$cat][$sv][$prevIdx]
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
    $classData=@{}
    foreach($c in $B.Classes){ $classData[$c.key] = Build-ClassMonthlyData $c }

    $monthDivs=New-Object System.Text.StringBuilder
    for($mi=1; $mi -lt $N; $mi++){
        $sections=@()
        foreach($c in $B.Classes){
            $html = Build-ClassNarrative $c $classData[$c.key] $mi
            if($html){ $sections += $html }
        }
        $body = if($sections.Count -gt 0){ $sections -join "" } else { "<p class='note'>No notable month-on-month changes crossed the reporting threshold for $(HEnc (PrettyMonth $months[$mi])).</p>" }
        $disp = if($mi -eq $N-1){""}else{" style='display:none;'"}
        [void]$monthDivs.Append("<div class='ma-month' id='ma-month-$mi'$disp>$body</div>")
    }

    $opts=New-Object System.Text.StringBuilder
    for($mi=1; $mi -lt $N; $mi++){ $sel=if($mi -eq $N-1){" selected"}else{""}; [void]$opts.Append("<option value='$mi'$sel>$(HEnc (PrettyMonth $months[$mi])) vs $(HEnc (PrettyMonth $months[$mi-1]))</option>") }

    $js = @"
<script>
(function(){
  window.onMonthlyAnalysisChange=function(v){
    document.querySelectorAll('.ma-month').forEach(function(el){ el.style.display = (el.id==='ma-month-'+v) ? '' : 'none'; });
  };
})();
</script>
"@

    return @"
<div class="tab-panel" id="panel-monthly">
  <section>
    <h2>Monthly Analysis</h2>
    <p class="desc">Auto-generated from ticket data &mdash; compares the selected month to the one before it. Figures are wrt that month's total sales; drill-downs show the courier/warehouse/product driving most of a category's change. Root-cause context (e.g. a specific coupon bug) isn't captured in the data and is not inferred here.</p>
    <div style="margin-bottom:18px;"><label for="ma-select" style="font-size:12px;color:var(--text-muted);margin-right:8px;">Month</label><select id="ma-select" onchange="onMonthlyAnalysisChange(this.value)" style="font-size:13px;padding:7px 12px;border-radius:8px;border:1px solid var(--border);background:var(--surface-card);color:var(--text-primary);font-family:inherit;">$($opts.ToString())</select></div>
    $($monthDivs.ToString())
  </section>
</div>
$js
"@
}
