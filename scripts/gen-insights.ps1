# Insight-card builders, dot-sourced by Generate-Report.ps1 (shares its variables/functions).
# Each Build-*Insights function inspects the same data used to build a tab's panel and
# returns a small HTML card of colour-coded callouts (severity = conditional formatting):
#   crit  = red   (sharp negative swing / bad score)
#   watch = amber (notable but not alarming)
#   good  = green (improvement)
#   info  = blue  (neutral fact, e.g. "top issue this month")

function InsightItem($tag,$html){
    $label = switch($tag){ 'crit'{'Pain Point'} 'watch'{'Watch'} 'good'{'Improving'} default{'Info'} }
    return "<div class='insight-item'><span class='insight-dot $tag'></span><span>$html <span class='tag $tag'>$label</span></span></div>"
}
function Build-InsightsCard($title,$items){
    $items = @($items | Where-Object { $_ })
    if($items.Count -eq 0){ return "" }
    return "<div class='insights'><h3>$title</h3><div class='insight-list'>$($items -join "`n")</div></div>"
}

# Generic "top issue + biggest mover" insights for any Query-Category breakdown
# (used by every per-class tab and by Delivery). Independent of the pivot builders
# so it can't disturb their already-verified output.
function Get-CategoryInsightItems($subset){
    $LM=$N-1; $PM=$N-2
    $catMonth=[ordered]@{}; $catTot=@{}
    foreach($r in $subset){ $cat=Cell $r $Col.cat; if([string]::IsNullOrWhiteSpace($cat)){$cat="(blank)"}; $mo=Cell $r $Col.month; if([string]::IsNullOrWhiteSpace($mo)){continue}
        if(-not $catMonth.Contains($cat)){$catMonth[$cat]=@{}}; if($catMonth[$cat].ContainsKey($mo)){$catMonth[$cat][$mo]++}else{$catMonth[$cat][$mo]=1}
        if(-not $catTot.ContainsKey($cat)){$catTot[$cat]=0}; $catTot[$cat]++ }
    $catOrder=@($catTot.GetEnumerator()|Sort-Object Value -Descending|ForEach-Object{$_.Key})
    if($catOrder.Count -eq 0){ return @() }

    $items=@()
    $top=$null; $topVal=-1
    foreach($cat in $catOrder){ $v=0; if($catMonth[$cat].ContainsKey($months[$LM])){$v=$catMonth[$cat][$months[$LM]]}; if($v -gt $topVal){$topVal=$v;$top=$cat} }
    $totLM=0; foreach($cat in $catOrder){ if($catMonth[$cat].ContainsKey($months[$LM])){$totLM+=$catMonth[$cat][$months[$LM]]} }
    if($top -and $topVal -gt 0){
        $sh=if($totLM -gt 0){Round1 ($topVal/$totLM*100)}else{0}
        $sm=0; if($salesM.ContainsKey($months[$LM])){$sm=$salesM[$months[$LM]]}
        $wrt=if($sm -gt 0){Round1 ($topVal/$sm*100)}else{0}
        $items += InsightItem 'info' "Top issue in $(PrettyMonth $months[$LM]): <b>$(HEnc $top)</b> &mdash; $($topVal.ToString('N0')) tickets ($sh% of this tab's volume, $wrt% of sales)."
    }

    if($PM -ge 0){
        $riser=$null;$riserPct=-999999;$riserLM=0;$riserPM=0
        $faller=$null;$fallerPct=999999;$fallerLM=0;$fallerPM=0
        foreach($cat in $catOrder){
            $vLM=0; if($catMonth[$cat].ContainsKey($months[$LM])){$vLM=$catMonth[$cat][$months[$LM]]}
            $vPM=0; if($catMonth[$cat].ContainsKey($months[$PM])){$vPM=$catMonth[$cat][$months[$PM]]}
            if($vPM -ge 3){
                $chg=Round1 ((($vLM-$vPM)/$vPM)*100)
                if($chg -gt $riserPct){$riserPct=$chg;$riser=$cat;$riserLM=$vLM;$riserPM=$vPM}
                if($chg -lt $fallerPct){$fallerPct=$chg;$faller=$cat;$fallerLM=$vLM;$fallerPM=$vPM}
            }
        }
        if($riser -and $riserPct -gt 30){ $items += InsightItem 'crit' "<b>$(HEnc $riser)</b> spiked $riserPct% vs $(PrettyMonth $months[$PM]) ($($riserPM.ToString('N0')) &rarr; $($riserLM.ToString('N0')) tickets)." }
        elseif($riser -and $riserPct -gt 12){ $items += InsightItem 'watch' "<b>$(HEnc $riser)</b> rose $riserPct% vs $(PrettyMonth $months[$PM]) ($($riserPM.ToString('N0')) &rarr; $($riserLM.ToString('N0')) tickets)." }
        if($faller -and $fallerPct -lt -25 -and $faller -ne $riser){ $items += InsightItem 'good' "<b>$(HEnc $faller)</b> improved, down $([math]::Abs($fallerPct))% vs $(PrettyMonth $months[$PM]) ($($fallerPM.ToString('N0')) &rarr; $($fallerLM.ToString('N0')) tickets)." }
    }
    return $items
}

# Delivery-only extra: worst delivery partner by complaint rate wrt allocation, latest month.
function Get-DeliveryPartnerInsight($delivery){
    $LM=$N-1
    $pm=[ordered]@{}; $aSum=@{}; $aCnt=@{}
    foreach($r in $delivery){ $p=Cell $r $Col.partner; if([string]::IsNullOrWhiteSpace($p)){$p="(blank)"}; $mo=Cell $r $Col.month; if([string]::IsNullOrWhiteSpace($mo)){continue}
        if(-not $pm.Contains($p)){$pm[$p]=@{}}; if($pm[$p].ContainsKey($mo)){$pm[$p][$mo]++}else{$pm[$p][$mo]=1}
        $ar=Cell $r $Col.alloc; $av=0.0; if([double]::TryParse(($ar -replace ',',''),[ref]$av) -and $av -gt 0){ $ak="$p|$mo"; if($aSum.ContainsKey($ak)){$aSum[$ak]+=$av;$aCnt[$ak]++}else{$aSum[$ak]=$av;$aCnt[$ak]=1} } }
    $worst=$null;$worstRate=-1;$worstCnt=0
    foreach($p in $pm.Keys){ $cnt=0; if($pm[$p].ContainsKey($months[$LM])){$cnt=$pm[$p][$months[$LM]]}; if($cnt -lt 5){continue}
        $ak="$p|$($months[$LM])"; $avg=0; if($aCnt.ContainsKey($ak) -and $aCnt[$ak] -gt 0){$avg=$aSum[$ak]/$aCnt[$ak]}
        if($avg -gt 0){ $rate=Round1 ($cnt/$avg*100); if($rate -gt $worstRate){$worstRate=$rate;$worst=$p;$worstCnt=$cnt} } }
    if(-not $worst){ return $null }
    $tag = if($worstRate -gt 8){'crit'} elseif($worstRate -gt 4){'watch'} else {'good'}
    return InsightItem $tag "<b>$(HEnc $worst)</b> had the highest complaint rate wrt allocation in $(PrettyMonth $months[$LM]): $worstRate% ($($worstCnt.ToString('N0')) tickets)."
}

# Overview tab: top query class this month + biggest class-level mover, across the
# whole brand (not one class). $classMonth is a Build-ClassMonthCounts result.
function Get-OverviewInsightItems($classMonth){
    $LM=$N-1; $PM=$N-2
    $items=@()
    $top=$null;$topVal=-1
    $riser=$null;$riserPct=-999999;$riserLM=0;$riserPM=0
    $totLM=0
    foreach($c in $B.Classes){
        $cm = if($classMonth.Contains($c.key)){$classMonth[$c.key]}else{$null}
        $vLM=0; if($cm -and $cm.Contains($months[$LM])){$vLM=$cm[$months[$LM]]}
        $totLM+=$vLM
        if($vLM -gt $topVal){$topVal=$vLM;$top=$c}
        if($PM -ge 0){
            $vPM=0; if($cm -and $cm.Contains($months[$PM])){$vPM=$cm[$months[$PM]]}
            if($vPM -ge 5){
                $chg=Round1 ((($vLM-$vPM)/$vPM)*100)
                if($chg -gt $riserPct){$riserPct=$chg;$riser=$c;$riserLM=$vLM;$riserPM=$vPM}
            }
        }
    }
    if($top -and $topVal -gt 0){
        $sh=if($totLM -gt 0){Round1 ($topVal/$totLM*100)}else{0}
        $items += InsightItem 'info' "<b>$(HEnc $top.label)</b> was the top complaint driver in $(PrettyMonth $months[$LM]) with $($topVal.ToString('N0')) tickets ($sh% of that month's volume)."
    }
    if($riser -and $riserPct -gt 25){ $items += InsightItem 'crit' "<b>$(HEnc $riser.label)</b> complaints jumped $riserPct% month-on-month ($($riserPM.ToString('N0')) &rarr; $($riserLM.ToString('N0')))." }
    elseif($riser -and $riserPct -gt 10){ $items += InsightItem 'watch' "<b>$(HEnc $riser.label)</b> complaints rose $riserPct% month-on-month ($($riserPM.ToString('N0')) &rarr; $($riserLM.ToString('N0')))." }
    return $items
}

# NPS / CSAT score insight: level (good/watch/crit) + month-on-month direction.
function Get-ScoreInsight($rows,$label,$scoreGood,$scoreWatch){
    if(-not $rows -or $rows.Count -lt 2){ return $null }
    $last=$rows[$rows.Count-1]; $lastScore=[double]$last[2]; $lastMonth=PrettyMonth $last[0]
    $chg=$null
    if($rows.Count -ge 3){ $prev=$rows[$rows.Count-2]; $chg=Round1 ($lastScore-[double]$prev[2]) }
    $tag = if($lastScore -ge $scoreGood){'good'} elseif($lastScore -ge $scoreWatch){'watch'} else {'crit'}
    $trend=""
    if($null -ne $chg){
        if($chg -gt 0){$trend=" (up $chg vs prior month)"} elseif($chg -lt 0){$trend=" (down $([math]::Abs($chg)) vs prior month)"} else {$trend=" (flat vs prior month)"}
    }
    return InsightItem $tag "<b>$(HEnc $label)</b> is at <b>$lastScore</b> in $lastMonth$trend."
}
