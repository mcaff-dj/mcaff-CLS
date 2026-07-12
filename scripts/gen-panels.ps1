# Panel builders, dot-sourced by Generate-Report.ps1 (shares its variables/functions).

# Generic bidirectional category <-> second-dimension cross-filter panel, used by
# every class that has a meaningful second breakdown dimension (Delivery: partner,
# Technical: platform, Warehouse: facility, Product/Suggestion: product name).
# Clicking a row in EITHER table filters the OTHER table + chart to that selection;
# the clicked table itself keeps showing its full breakdown so the user can pick again.
# Packaging & Operational has no viable second dimension (its QA fields are <1% populated)
# so it stays on the plain single-table Build-ClassPanel below.
function Build-CrossFilterPanel($cls, $dim2Key, $dim2Label, $dim2Title, $pctMode, $dim2PctLabel, $dim2Cap, $coverageMode){
    $subset = $unique | Where-Object { (Cell $_ $Col.cls) -eq $cls.key }
    $pfx = $cls.id
    $dim2Col = $Col[$dim2Key]

    $catTot=@{}; foreach($r in $subset){ $c=Cell $r $Col.cat; if([string]::IsNullOrWhiteSpace($c)){$c="(blank)"}; if(-not $catTot.ContainsKey($c)){$catTot[$c]=0}; $catTot[$c]++ }
    $catOrder=@($catTot.GetEnumerator()|Sort-Object Value -Descending|ForEach-Object{$_.Key})

    $dim2TotAll=@{}; foreach($r in $subset){ $v=Cell $r $dim2Col; if([string]::IsNullOrWhiteSpace($v)){$v="(blank)"}; if(-not $dim2TotAll.ContainsKey($v)){$dim2TotAll[$v]=0}; $dim2TotAll[$v]++ }
    $dim2OrderFull=@($dim2TotAll.GetEnumerator()|Sort-Object Value -Descending|ForEach-Object{$_.Key})
    $dim2Capped = $dim2OrderFull.Count -gt $dim2Cap
    $dim2Top = New-Object 'System.Collections.Generic.HashSet[string]'
    if($dim2Capped){
        $topVals = @($dim2OrderFull | Select-Object -First ($dim2Cap-1))
        $dim2Order = @($topVals) + @("(other)")
        foreach($v in $topVals){ [void]$dim2Top.Add($v) }
    } else {
        $dim2Order = $dim2OrderFull
        foreach($v in $dim2OrderFull){ [void]$dim2Top.Add($v) }
    }
    $otherIdx = $dim2Order.Count - 1

    $dim2NonBlank=0; foreach($kv in $dim2TotAll.GetEnumerator()){ if($kv.Key -ne "(blank)"){$dim2NonBlank+=$kv.Value} }
    $dim2CoveragePct=if($subset.Count -gt 0){Round1 ($dim2NonBlank/$subset.Count*100)}else{0}
    $firstCoveredMonth=$null
    if($coverageMode -eq "sinceFirst"){
        foreach($mo in $months){ $has=$false
            foreach($r in $subset){ if((Cell $r $Col.month) -eq $mo -and -not [string]::IsNullOrWhiteSpace((Cell $r $dim2Col))){$has=$true;break} }
            if($has){ $firstCoveredMonth=$mo; break } }
    }
    $coverageNote = switch($coverageMode){
        "sinceFirst" { if($firstCoveredMonth){ "<p class='desc'>$(HEnc $dim2Label) has only been captured since $(HEnc (PrettyMonth $firstCoveredMonth)) &mdash; $dim2CoveragePct% of all $(HEnc $cls.label) tickets have it filled in; earlier months show entirely as &quot;(blank)&quot;.</p>" } else { "<p class='desc'>$(HEnc $dim2Label) isn't populated on any $(HEnc $cls.label) tickets yet.</p>" } }
        "sparsePct" { "<p class='desc'>$(HEnc $dim2Label) is only tagged on $dim2CoveragePct% of $(HEnc $cls.label) tickets &mdash; directional only; the rest show as &quot;(blank)&quot;.</p>" }
        default { "" }
    }
    $cappedNote = if($dim2Capped){ "<p class='desc'>Showing the top $($dim2Cap-1) $(HEnc $dim2Label) values by ticket volume (of $($dim2OrderFull.Count) total); the rest are grouped into &quot;(other)&quot;.</p>" } else { "" }

    $tk=New-Object System.Collections.Generic.List[object]
    $allocSum=@{}; $allocCnt=@{}
    foreach($r in $subset){ $mo=Cell $r $Col.month; $mi=[array]::IndexOf($months,$mo); if($mi -lt 0){continue}
        $cat=Cell $r $Col.cat; if([string]::IsNullOrWhiteSpace($cat)){$cat="(blank)"}; $ci=[array]::IndexOf($catOrder,$cat)
        $v=Cell $r $dim2Col; if([string]::IsNullOrWhiteSpace($v)){$v="(blank)"}
        $di = if($dim2Capped -and -not $dim2Top.Contains($v)){ $otherIdx } else { [array]::IndexOf($dim2Order,$v) }
        $tk.Add("[$mi,$ci,$di]")
        if($pctMode -eq "alloc"){
            $ar=Cell $r $Col.alloc; $av=0.0
            if([double]::TryParse(($ar -replace ',',''),[ref]$av) -and $av -gt 0){
                $ak="$di|$mi"; if($allocSum.ContainsKey($ak)){$allocSum[$ak]+=$av;$allocCnt[$ak]++}else{$allocSum[$ak]=$av;$allocCnt[$ak]=1}
            }
        }
    }
    $ticketsJson="[" + ($tk -join ",") + "]"
    $catsJson="[" + (($catOrder|ForEach-Object{'"'+(JEnc $_)+'"'}) -join ",") + "]"
    $dim2sJson="[" + (($dim2Order|ForEach-Object{'"'+(JEnc $_)+'"'}) -join ",") + "]"
    $monthsJson="[" + (($months|ForEach-Object{'"'+(JEnc $_)+'"'}) -join ",") + "]"
    $salesJson="[" + (($salesArr|ForEach-Object{[string]$_}) -join ",") + "]"
    $allocJson = "[]"
    if($pctMode -eq "alloc"){
        $rows=@()
        for($di=0;$di -lt $dim2Order.Count;$di++){
            $cols=@()
            for($mi=0;$mi -lt $N;$mi++){ $ak="$di|$mi"; $avg=0; if($allocCnt.ContainsKey($ak) -and $allocCnt[$ak] -gt 0){$avg=$allocSum[$ak]/$allocCnt[$ak]}; $cols+=[string]$avg }
            $rows+="[" + ($cols -join ",") + "]"
        }
        $allocJson = "[" + ($rows -join ",") + "]"
    }

    $W=1200;$H=380;$padL=55;$padR=55;$padT=40;$padB=55;$plotW=$W-$padL-$padR;$plotH=$H-$padT-$padB;$slot=$plotW/$N;$barW=$slot*0.55
    $barColor = $cls.color
    $lineColor = if($cls.color -eq "var(--s1)"){"var(--s3)"}else{"var(--s1)"}

    $sb1=New-Object System.Text.StringBuilder
    [void]$sb1.Append("<div class='pivot-wrap'><div class='pivot-title'>$(HEnc $cls.label) Complaints by Issue Category</div><div class='pivot-scroll'><table class='pivot-table'><thead><tr><th class='corner' rowspan='2'>Query Category</th>")
    foreach($mo in $months){[void]$sb1.Append("<th colspan='2' class='month-hdr' data-yr='$(YearOf $mo)'>$(HEnc $mo)</th>")}
    [void]$sb1.Append("</tr><tr>"); foreach($mo in $months){$yr=YearOf $mo; [void]$sb1.Append("<th class='sub-hdr' data-yr='$yr'>Complaints</th><th class='sub-hdr' data-yr='$yr'>wrt sales</th>")}
    [void]$sb1.Append("</tr></thead><tbody>")
    for($ci=0;$ci -lt $catOrder.Count;$ci++){ $z=if(($ci+1)%2 -eq 1){"zebra"}else{""}
        [void]$sb1.Append("<tr class='$z xf-row' id='xf-$pfx-catrow-$ci' onclick='onXfClick(""$pfx"",""cat"",$ci)'><td class='rowlabel'>$(HEnc $catOrder[$ci])</td>")
        for($mi=0;$mi -lt $N;$mi++){$yr=YearOf $months[$mi]; [void]$sb1.Append("<td class='num' id='xf-$pfx-cat-$ci-mo-$mi-cnt' data-yr='$yr'>-</td><td class='pct' id='xf-$pfx-cat-$ci-mo-$mi-pct' data-yr='$yr'>-</td>")}
        [void]$sb1.Append("</tr>") }
    [void]$sb1.Append("<tr class='total-row'><td class='rowlabel'>Grand Total</td>")
    for($mi=0;$mi -lt $N;$mi++){$yr=YearOf $months[$mi]; [void]$sb1.Append("<td class='num' id='xf-$pfx-cat-total-mo-$mi-cnt' data-yr='$yr'>-</td><td class='pct' id='xf-$pfx-cat-total-mo-$mi-pct' data-yr='$yr'>-</td>")}
    [void]$sb1.Append("</tr></tbody></table></div></div>")

    $sb2=New-Object System.Text.StringBuilder
    [void]$sb2.Append("<div class='pivot-wrap'><div class='pivot-title'>$(HEnc $dim2Title)</div><div class='pivot-scroll'><table class='pivot-table'><thead><tr><th class='corner' rowspan='2'>$(HEnc $dim2Label)</th>")
    foreach($mo in $months){[void]$sb2.Append("<th colspan='2' class='month-hdr' data-yr='$(YearOf $mo)'>$(HEnc $mo)</th>")}
    [void]$sb2.Append("</tr><tr>"); foreach($mo in $months){$yr=YearOf $mo; [void]$sb2.Append("<th class='sub-hdr' data-yr='$yr'>Complaints</th><th class='sub-hdr' data-yr='$yr'>$(HEnc $dim2PctLabel)</th>")}
    [void]$sb2.Append("</tr></thead><tbody>")
    for($di=0;$di -lt $dim2Order.Count;$di++){ $z=if(($di+1)%2 -eq 1){"zebra"}else{""}
        [void]$sb2.Append("<tr class='$z xf-row' id='xf-$pfx-dimrow-$di' onclick='onXfClick(""$pfx"",""dim2"",$di)'><td class='rowlabel'>$(HEnc $dim2Order[$di])</td>")
        for($mi=0;$mi -lt $N;$mi++){$yr=YearOf $months[$mi]; [void]$sb2.Append("<td class='num' id='xf-$pfx-dim-$di-mo-$mi-cnt' data-yr='$yr'>-</td><td class='pct' id='xf-$pfx-dim-$di-mo-$mi-pct' data-yr='$yr'>-</td>")}
        [void]$sb2.Append("</tr>") }
    [void]$sb2.Append("<tr class='total-row'><td class='rowlabel'>Grand Total</td>")
    for($mi=0;$mi -lt $N;$mi++){$yr=YearOf $months[$mi]; [void]$sb2.Append("<td class='num' id='xf-$pfx-dim-total-mo-$mi-cnt' data-yr='$yr'>-</td><td class='pct' id='xf-$pfx-dim-total-mo-$mi-pct' data-yr='$yr'>-</td>")}
    [void]$sb2.Append("</tr></tbody></table></div></div>")

    $sb3=New-Object System.Text.StringBuilder
    [void]$sb3.Append("<div class='card'><div class='pivot-title' style='margin-bottom:18px;'>$(HEnc $cls.label) Complaints wrt Sales</div><div class='legend-row' style='justify-content:center;'><div class='legend-item'><span class='swatch' style='background:$barColor;'></span><span class='lname'>Complaints</span></div><div class='legend-item'><span class='swatch' style='background:$lineColor;border-radius:50%;'></span><span class='lname'>wrt sales %</span></div></div>")
    [void]$sb3.Append("<svg viewBox='0 0 $W $H' width='100%' height='$H' role='img'><line x1='$padL' y1='$($padT+$plotH)' x2='$($W-$padR)' y2='$($padT+$plotH)' stroke='var(--baseline)' stroke-width='1'/>")
    for($i=0;$i -lt $N;$i++){ $cx=$padL+$slot*$i+$slot/2; $bx=$cx-$barW/2; $ml=PrettyMonth $months[$i]; $yr=YearOf $months[$i]
        [void]$sb3.Append("<g data-yr='$yr'><rect id='xf-$pfx-bar-$i' x='$bx' y='$($padT+$plotH)' width='$barW' height='0' fill='$barColor' rx='2'/><text id='xf-$pfx-barval-$i' x='$cx' y='$($padT+$plotH-8)' text-anchor='middle' font-size='10.5' fill='var(--text-primary)' font-weight='600'></text><text x='$cx' y='$($H-$padB+18)' text-anchor='middle' font-size='10.5' fill='var(--text-muted)'>$ml</text></g>") }
    [void]$sb3.Append("<polyline id='xf-$pfx-polyline' points='' fill='none' stroke='$lineColor' stroke-width='2'/>")
    for($i=0;$i -lt $N;$i++){ $yr=YearOf $months[$i]; [void]$sb3.Append("<g data-yr='$yr'><circle id='xf-$pfx-dot-$i' cx='0' cy='0' r='3' fill='$lineColor' visibility='hidden'/><text id='xf-$pfx-dotval-$i' x='0' y='0' text-anchor='middle' font-size='10.5' font-weight='600' fill='$lineColor'></text></g>")}
    [void]$sb3.Append("</svg></div>")

    $filterNote = "<div class='filter-row' style='display:flex;align-items:center;gap:10px;margin:0 0 4px;flex-wrap:wrap;'><span id='xf-$pfx-filter-note' style='font-size:12px;color:var(--text-muted);'></span></div>"

    $js = @"
<script>
(function(){
  var DT=$ticketsJson, CATS=$catsJson, DIMS=$dim2sJson, MONTHS=$monthsJson, SALES=$salesJson, ALLOC=$allocJson, N=MONTHS.length;
  var padL=$padL,padT=$padT,plotH=$plotH,slot=$slot,barW=$barW, BAR=null,PCT=null, pctMode='$pctMode', filter=null;
  function fmt(n){return n.toLocaleString('en-IN');}
  function nice(v){ if(v<=0)return 10; var m=Math.pow(10,Math.floor(Math.log10(v))); var s=[1,2,2.5,5,10]; for(var i=0;i<s.length;i++){var c=s[i]*m; if(c>=v)return c;} return 10*m; }
  function passOther(t, exceptAxis){ var mo=t[0],c=t[1],d=t[2]; if(mo<0||mo>=N||c<0||c>=CATS.length||d<0||d>=DIMS.length)return false;
    if(filter && filter.axis!==exceptAxis){ if(filter.axis==='cat'&&c!==filter.idx)return false; if(filter.axis==='dim2'&&d!==filter.idx)return false; }
    return true; }
  function catBreakdown(){ var cm=CATS.map(function(){return new Array(N).fill(0)});
    for(var i=0;i<DT.length;i++){ var t=DT[i]; if(!passOther(t,'cat'))continue; cm[t[1]][t[0]]++; } return cm; }
  function dimBreakdown(){ var dm=DIMS.map(function(){return new Array(N).fill(0)});
    for(var i=0;i<DT.length;i++){ var t=DT[i]; if(!passOther(t,'dim2'))continue; dm[t[2]][t[0]]++; } return dm; }
  function filteredTotals(){ var tot=new Array(N).fill(0),tc=0; for(var i=0;i<DT.length;i++){ var t=DT[i]; if(!passOther(t,null))continue; tot[t[0]]++; tc++; } return {tot:tot,tc:tc}; }
  function rct(){ var cm=catBreakdown(), tot=new Array(N).fill(0);
    for(var ci=0;ci<CATS.length;ci++){ for(var mi=0;mi<N;mi++){ var cnt=cm[ci][mi],sm=SALES[mi],p=sm>0?Math.round(cnt/sm*1000)/10:0; tot[mi]+=cnt;
      var ce=document.getElementById('xf-$pfx-cat-'+ci+'-mo-'+mi+'-cnt'); if(ce)ce.textContent=cnt>0?fmt(cnt):'-';
      var pe=document.getElementById('xf-$pfx-cat-'+ci+'-mo-'+mi+'-pct'); if(pe)pe.textContent=cnt>0?(p+'%'):'-'; } }
    for(var m=0;m<N;m++){ var sm2=SALES[m],p2=sm2>0?Math.round(tot[m]/sm2*1000)/10:0;
      var ce2=document.getElementById('xf-$pfx-cat-total-mo-'+m+'-cnt'); if(ce2)ce2.textContent=fmt(tot[m]);
      var pe2=document.getElementById('xf-$pfx-cat-total-mo-'+m+'-pct'); if(pe2)pe2.textContent=p2+'%'; } }
  function rdt(){ var dm=dimBreakdown(), tot=new Array(N).fill(0);
    for(var di=0;di<DIMS.length;di++){ for(var mi=0;mi<N;mi++){ var cnt=dm[di][mi]; tot[mi]+=cnt;
      var basis = (pctMode==='alloc') ? (ALLOC[di]?ALLOC[di][mi]:0) : SALES[mi];
      var p = basis>0?Math.round(cnt/basis*1000)/10:0;
      var ce=document.getElementById('xf-$pfx-dim-'+di+'-mo-'+mi+'-cnt'); if(ce)ce.textContent=cnt>0?fmt(cnt):'-';
      var pe=document.getElementById('xf-$pfx-dim-'+di+'-mo-'+mi+'-pct'); if(pe)pe.textContent=(cnt>0&&basis>0)?(p+'%'):'-'; } }
    for(var m=0;m<N;m++){
      var ce2=document.getElementById('xf-$pfx-dim-total-mo-'+m+'-cnt'); if(ce2)ce2.textContent=fmt(tot[m]);
      var pe2=document.getElementById('xf-$pfx-dim-total-mo-'+m+'-pct');
      if(pe2){ if(pctMode==='alloc'){ pe2.textContent='-'; } else { var sm3=SALES[m],p3=sm3>0?Math.round(tot[m]/sm3*1000)/10:0; pe2.textContent=p3+'%'; } } } }
  function rch(){ var r=filteredTotals(); var vals=r.tot, pcts=vals.map(function(v,i){var sm=SALES[i];return sm>0?Math.round(v/sm*10000)/100:0;});
    BAR=nice(Math.max.apply(null,vals)*1.15); PCT=nice(Math.max.apply(null,pcts)*1.2); var pts=[];
    for(var i=0;i<N;i++){ var cx=padL+slot*i+slot/2,bx=cx-barW/2,bh=plotH*(vals[i]/BAR),by=padT+plotH-bh;
      var rEl=document.getElementById('xf-$pfx-bar-'+i); rEl.setAttribute('y',by); rEl.setAttribute('height',bh);
      var bv=document.getElementById('xf-$pfx-barval-'+i); bv.setAttribute('y',by-8); bv.textContent=vals[i]>0?fmt(vals[i]):'';
      var ly=padT+plotH-(plotH*(pcts[i]/PCT)); pts.push(cx+','+ly);
      var d=document.getElementById('xf-$pfx-dot-'+i); d.setAttribute('cx',cx); d.setAttribute('cy',ly); d.setAttribute('visibility','visible');
      var dv=document.getElementById('xf-$pfx-dotval-'+i); dv.setAttribute('x',cx); dv.setAttribute('y',ly-10); dv.textContent=pcts[i]+'%'; }
    document.getElementById('xf-$pfx-polyline').setAttribute('points',pts.join(' ')); return r; }
  function render(){ try{ rct(); rdt(); var r=rch();
      var note=document.getElementById('xf-$pfx-filter-note');
      if(note){
        if(!filter){ note.textContent='Showing all $(HEnc $cls.label) tickets. Click a row in either table to cross-filter.'; }
        else if(filter.axis==='cat'){ note.textContent='Filtered to category "'+CATS[filter.idx]+'" ('+fmt(r.tc)+' tickets). Click the row again to clear.'; }
        else { note.textContent='Filtered to $(HEnc $dim2Label) "'+DIMS[filter.idx]+'" ('+fmt(r.tc)+' tickets). Click the row again to clear.'; }
      }
    }catch(e){ var n2=document.getElementById('xf-$pfx-filter-note'); if(n2){n2.textContent='Filter error: '+e.message; n2.style.color='var(--s6)';} if(window.console)console.error('$pfx filter error',e); } }
  window._xfPanels = window._xfPanels || {};
  window._xfPanels['$pfx'] = { onClick: function(axis, idx){
    filter = (filter && filter.axis===axis && filter.idx===idx) ? null : {axis:axis, idx:idx};
    document.querySelectorAll('#panel-$pfx .xf-row').forEach(function(row){ row.classList.remove('active-filter'); });
    if(filter){ var id = filter.axis==='cat' ? ('xf-$pfx-catrow-'+filter.idx) : ('xf-$pfx-dimrow-'+filter.idx); var el=document.getElementById(id); if(el)el.classList.add('active-filter'); }
    render();
  }};
  window.onXfClick = window.onXfClick || function(pfx, axis, idx){ if(window._xfPanels[pfx])window._xfPanels[pfx].onClick(axis, idx); };
  function init(){ render(); }
  if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',init);}else{init();}
})();
</script>
"@

    if($cls.id -eq "delivery"){
        $insightsBlock = Build-InsightsCard "Insights &mdash; Delivery" (@(Get-CategoryInsightItems $subset) + @(Get-DeliveryPartnerInsight $subset))
        $weeklyBlock = Build-WeeklyDeliveryBlock
    } else {
        $insightsBlock = Build-InsightsCard "Insights &mdash; $(HEnc $cls.label)" (Get-CategoryInsightItems $subset)
        $weeklyBlock = Build-WeeklyClassBlock $cls
    }
    $batch = ""
    if($cls.key -eq "Product" -or $cls.key -eq "Product Suggestion/Recommendation"){ $batch = Build-BatchTable $subset $cls.label }

    return @"
<div class="gran-monthly">
$filterNote
<section><h2>$(HEnc $cls.label) Complaints by Issue Category</h2><p class="desc">Percent = complaints &divide; that month's total order volume ("Total Sales M"). Click a row in either table below to cross-filter.</p>$($sb1.ToString())</section>
<section><h2>$(HEnc $dim2Title)</h2>$coverageNote$cappedNote$($sb2.ToString())</section>
<section><h2>$(HEnc $cls.label) Complaints wrt Sales</h2><p class="desc">Monthly complaint volume (bars) against complaint rate as a share of sales (line). Recomputes for the row selected above.</p>$($sb3.ToString())</section>
</div>
$weeklyBlock
$batch
$insightsBlock
$js
"@
}

function Build-ClassPanel($cls){
    $subset = $unique | Where-Object { (Cell $_ $Col.cls) -eq $cls.key }
    $mt=[ref]@()
    $pivot = Build-CategoryPivot $subset "$($cls.label) Complaints" $mt
    $chart = Build-ComboChart $mt.Value "$($cls.label) Complaints wrt Sales" $cls.color "var(--s1)"
    $batch = Build-BatchTable $subset $cls.label
    $insights = Build-InsightsCard "Insights &mdash; $(HEnc $cls.label)" (Get-CategoryInsightItems $subset)
    $weekly = Build-WeeklyClassBlock $cls
    return @"
<div class="gran-monthly">
<section><h2>$(HEnc $cls.label) Complaints by Issue Category</h2><p class="desc">Percent = complaints &divide; that month's total order volume ("Total Sales M").</p>$pivot</section>
<section><h2>$(HEnc $cls.label) Complaints wrt Sales</h2><p class="desc">Monthly complaint volume (bars) against complaint rate as a share of sales (line).</p>$chart</section>
</div>
$weekly
$batch
$insights
"@
}

function Build-Combo2($rows,$title,$scoreLabel,$scoreMax){
    $mos=@();$vals=@();$sc=@();$yrsRaw=@();$monthNums=@()
    for($i=1;$i -lt $rows.Count;$i++){ $r=$rows[$i]; $raw=$r[0]
        $mos+=(PrettyMonth $raw); $yrsRaw+=(YearOf $raw); $vals+=[double]($r[1] -replace ',',''); $sc+=[double]$r[2]
        $mn=0; if($raw -match '^(\d+)_'){ $mn=[int]$Matches[1] }
        $monthNums+=$mn }
    $n=$mos.Count; if($n -eq 0){ return "<div class='card'><p class='note'>No data.</p></div>" }
    # This sheet's month labels are inconsistently formatted (some carry no year at all,
    # e.g. "12_Dec" vs "2_Feb'26") - backfill missing years by walking backward from the
    # nearest row that does have one, decrementing across month-number wraparounds
    # (e.g. Dec(12) immediately before a known Jan(1)/2026 must be Dec 2025).
    $yrs = New-Object 'string[]' $n
    $carryYear = $null
    for($i=$n-1; $i -ge 0; $i--){
        if($yrsRaw[$i]){ $carryYear = $yrsRaw[$i] }
        elseif($carryYear -and $i -lt ($n-1) -and $monthNums[$i] -gt 0 -and $monthNums[$i+1] -gt 0 -and $monthNums[$i] -gt $monthNums[$i+1]){
            $carryYear = [string]([int]$carryYear - 1)
        }
        $yrs[$i] = $carryYear
    }
    $barMax=NiceMax ((($vals|Measure-Object -Maximum).Maximum)*1.12)
    $W=1120;$H=420;$padL=55;$padR=55;$padT=40;$padB=55;$plotW=$W-$padL-$padR;$plotH=$H-$padT-$padB;$slot=$plotW/$n;$barW=$slot*0.55
    $sb=New-Object System.Text.StringBuilder
    [void]$sb.Append("<div class='card'><div class='pivot-title' style='margin-bottom:18px;'>$(HEnc $title)</div><div class='legend-row' style='justify-content:center;'><div class='legend-item'><span class='swatch' style='background:var(--s1);border-radius:50%;'></span><span class='lname'>$scoreLabel</span></div><div class='legend-item'><span class='swatch' style='background:var(--s2);'></span><span class='lname'>Total Responses</span></div></div>")
    [void]$sb.Append("<svg viewBox='0 0 $W $H' width='100%' height='$H' role='img'>")
    for($g=0;$g -le 5;$g++){ $fr=$g/5.0; $y=$padT+$plotH*(1-$fr); $st=Round1 ($scoreMax*$fr); $rl=[math]::Round($barMax*$fr); $rs=if($rl -ge 1000){"$([math]::Round($rl/1000,1))K"}else{"$rl"}
        [void]$sb.Append("<line x1='$padL' y1='$y' x2='$($W-$padR)' y2='$y' stroke='var(--grid)' stroke-width='1'/><text x='$($padL-10)' y='$($y+4)' text-anchor='end' font-size='11' fill='var(--text-muted)'>$st</text><text x='$($W-$padR+10)' y='$($y+4)' text-anchor='start' font-size='11' fill='var(--text-muted)'>$rs</text>") }
    [void]$sb.Append("<line x1='$padL' y1='$($padT+$plotH)' x2='$($W-$padR)' y2='$($padT+$plotH)' stroke='var(--baseline)' stroke-width='1'/>")
    $pts=@()
    for($i=0;$i -lt $n;$i++){ $cx=$padL+$slot*$i+$slot/2; $bx=$cx-$barW/2; $bh=$plotH*($vals[$i]/$barMax); $by=$padT+$plotH-$bh
        [void]$sb.Append("<g data-yr='$($yrs[$i])'><rect x='$bx' y='$by' width='$barW' height='$bh' fill='var(--s2)' rx='2'/><text x='$cx' y='$($by-8)' text-anchor='middle' font-size='12' font-weight='700' fill='var(--text-primary)'>$('{0:N0}' -f $vals[$i])</text>")
        $ly=$padT+$plotH*(1-$sc[$i]/$scoreMax); $pts+="$cx,$ly"
        [void]$sb.Append("<text x='$cx' y='$($H-$padB+20)' text-anchor='middle' font-size='11' fill='var(--text-muted)'>$($mos[$i])</text></g>") }
    [void]$sb.Append("<polyline points='$($pts -join ' ')' fill='none' stroke='var(--s1)' stroke-width='2.5'/>")
    for($i=0;$i -lt $n;$i++){ $p=$pts[$i] -split ','; [void]$sb.Append("<g data-yr='$($yrs[$i])'><circle cx='$($p[0])' cy='$($p[1])' r='4' fill='var(--s1)'/><text x='$($p[0])' y='$([double]$p[1]-12)' text-anchor='middle' font-size='12' font-weight='700' fill='var(--s1)'>$($sc[$i])</text></g>") }
    [void]$sb.Append("</svg></div>")
    return $sb.ToString()
}

function Build-NpsPanel {
    $o = Build-Combo2 $mom "NPS - Overall" "NPS%" 100
    $p = Build-Combo2 $prodnps "NPS - Product" "NPS" 100
    $insights = Build-InsightsCard "Insights &mdash; NPS" @((Get-ScoreInsight $mom "Overall NPS" 30 0), (Get-ScoreInsight $prodnps "Product NPS" 30 0))
    return "<div class=""tab-panel"" id=""panel-nps""><section><h2>Net Promoter Score</h2><p class=""desc"">Monthly survey responses (bars, right axis) against NPS (line, left axis).</p>$o</section><section>$p</section>$insights</div>"
}
function Build-CsatPanel {
    $a = Build-Combo2 $agent "Agent CSAT" "CSAT" 5
    $i = Build-Combo2 $ai "AI CSAT" "CSAT" 5
    $insights = Build-InsightsCard "Insights &mdash; CSAT" @((Get-ScoreInsight $agent "Agent CSAT" 4.3 3.7), (Get-ScoreInsight $ai "AI CSAT" 4.3 3.7))
    return "<div class=""tab-panel active"" id=""panel-csat""><section><h2>Customer Satisfaction (CSAT)</h2><p class=""desc"">Monthly survey responses (bars, right axis) against CSAT out of 5 (line, left axis).</p>$a</section><section>$i</section>$insights</div>"
}

# ---------- Product & Packaging 5-level drilldown ----------
function Build-ProdPkgPanel {
    $ppsub = $unique | Where-Object { $k=(Cell $_ $Col.cls); $k -eq "Packaging and Operational" -or $k -eq "Product" }
    $skuSet=[ordered]@{};$prodSet=[ordered]@{};$clsSet=[ordered]@{};$catSet=[ordered]@{};$batchSet=[ordered]@{}
    function Norm($v){ $s=[string]$v; if([string]::IsNullOrWhiteSpace($s)){return "(blank)"}; return $s }
    foreach($r in $ppsub){
        $vsku=Norm (Cell $r $Col.sku);   if(-not $skuSet.Contains($vsku)){$skuSet[$vsku]=$true}
        $vpr =Norm (Cell $r $Col.prod);  if(-not $prodSet.Contains($vpr)){$prodSet[$vpr]=$true}
        $vcl =Norm (Cell $r $Col.cls);   if(-not $clsSet.Contains($vcl)){$clsSet[$vcl]=$true}
        $vca =Norm (Cell $r $Col.cat);   if(-not $catSet.Contains($vca)){$catSet[$vca]=$true}
        $vba =Norm (Cell $r $Col.batch); if(-not $batchSet.Contains($vba)){$batchSet[$vba]=$true}
    }
    $SKUS=@($skuSet.Keys);$PRODS=@($prodSet.Keys);$CLASSES=@($clsSet.Keys);$CATS=@($catSet.Keys);$BATCHES=@($batchSet.Keys)
    $LM=$N-1; $lmSales=$salesArr[$LM]
    $comboTot=@{};$comboMC=@{};$comboK2I=@{};$comboList=New-Object System.Collections.Generic.List[object]
    $tickets=New-Object System.Collections.Generic.List[object]
    foreach($r in $ppsub){ $mo=Cell $r $Col.month; $mi=[array]::IndexOf($months,$mo); if($mi -lt 0){continue}
        $sku=Norm (Cell $r $Col.sku);$si=[array]::IndexOf($SKUS,$sku); $prod=Norm (Cell $r $Col.prod);$pi=[array]::IndexOf($PRODS,$prod)
        $cls=Norm (Cell $r $Col.cls);$li=[array]::IndexOf($CLASSES,$cls); $cat=Norm (Cell $r $Col.cat);$ci=[array]::IndexOf($CATS,$cat); $bat=Norm (Cell $r $Col.batch);$bi=[array]::IndexOf($BATCHES,$bat)
        $tickets.Add("[$mi,$si,$pi,$li,$ci,$bi]")
        $ck="$si|$pi|$li|$ci|$bi"; if(-not $comboTot.ContainsKey($ck)){$comboTot[$ck]=0;$comboMC[$ck]=New-Object 'int[]' $N;$comboK2I[$ck]=$comboList.Count;$comboList.Add(@{sku=$si;prod=$pi;cls=$li;cat=$ci;batch=$bi})}
        $comboTot[$ck]++; $comboMC[$ck][$mi]++ }
    function LMK($arr){ $c=$arr[$LM]; $p=if($lmSales -gt 0){$c/$lmSales}else{0}; return @{cnt=$c;pct=$p} }
    $MaxP=60;$MaxProd=10;$MaxCls=5;$MaxCat=15;$MaxBat=20
    $skuTree=[ordered]@{}
    foreach($kv in $comboTot.GetEnumerator()){ $c=$comboList[$comboK2I[$kv.Key]]; $sk=[string]$c.sku
        if(-not $skuTree.Contains($sk)){$skuTree[$sk]=@{sku=$c.sku;mc=(New-Object 'int[]' $N);products=[ordered]@{}}}
        $sn=$skuTree[$sk]; for($m=0;$m -lt $N;$m++){$sn.mc[$m]+=$comboMC[$kv.Key][$m]}
        $pk=[string]$c.prod; if(-not $sn.products.Contains($pk)){$sn.products[$pk]=@{prod=$c.prod;mc=(New-Object 'int[]' $N);classes=[ordered]@{}}}
        $pn=$sn.products[$pk]; for($m=0;$m -lt $N;$m++){$pn.mc[$m]+=$comboMC[$kv.Key][$m]}
        $lk=[string]$c.cls; if(-not $pn.classes.Contains($lk)){$pn.classes[$lk]=@{cls=$c.cls;mc=(New-Object 'int[]' $N);cats=[ordered]@{}}}
        $ln=$pn.classes[$lk]; for($m=0;$m -lt $N;$m++){$ln.mc[$m]+=$comboMC[$kv.Key][$m]}
        $catk=[string]$c.cat; if(-not $ln.cats.Contains($catk)){$ln.cats[$catk]=@{cat=$c.cat;mc=(New-Object 'int[]' $N);batches=New-Object System.Collections.Generic.List[object]}}
        $cn=$ln.cats[$catk]; for($m=0;$m -lt $N;$m++){$cn.mc[$m]+=$comboMC[$kv.Key][$m]}
        $cn.batches.Add(@{combo=$c;mc=$comboMC[$kv.Key]}) }
    $topSku=$skuTree.Keys|Sort-Object -Descending {(LMK $skuTree[$_].mc).cnt},{(LMK $skuTree[$_].mc).pct}|Select-Object -First $MaxP
    $parentsOut=@();$prodGroups=@();$clsGroups=@();$catGroups=@();$rowsOut=@();$rowCatIdx=@()
    foreach($sk in $topSku){ $sn=$skuTree[$sk]; $pidx=$parentsOut.Count; $parentsOut+=@{sku=$sn.sku}
        $tp=$sn.products.Keys|Sort-Object -Descending {(LMK $sn.products[$_].mc).cnt},{(LMK $sn.products[$_].mc).pct}|Select-Object -First $MaxProd
        foreach($pk in $tp){ $pn=$sn.products[$pk]; $pgi=$prodGroups.Count; $prodGroups+=@{parentIdx=$pidx;prod=$pn.prod}
            $tc=$pn.classes.Keys|Sort-Object -Descending {(LMK $pn.classes[$_].mc).cnt},{(LMK $pn.classes[$_].mc).pct}|Select-Object -First $MaxCls
            foreach($lk in $tc){ $ln=$pn.classes[$lk]; $cgi=$clsGroups.Count; $clsGroups+=@{productGroupIdx=$pgi;cls=$ln.cls}
                $tcat=$ln.cats.Keys|Sort-Object -Descending {(LMK $ln.cats[$_].mc).cnt},{(LMK $ln.cats[$_].mc).pct}|Select-Object -First $MaxCat
                foreach($catk in $tcat){ $cn=$ln.cats[$catk]; $catgi=$catGroups.Count; $catGroups+=@{classGroupIdx=$cgi;cat=$cn.cat}
                    $tb=$cn.batches|Sort-Object -Descending {(LMK $_.mc).cnt},{(LMK $_.mc).pct}|Select-Object -First $MaxBat
                    foreach($b in $tb){ $rowsOut+=$b.combo; $rowCatIdx+=$catgi } } } } }
    function AJ($a){ "[" + (($a|ForEach-Object{'"'+(JEnc $_)+'"'}) -join ",") + "]" }
    $ticketsJson="[" + ($tickets -join ",") + "]"
    $rowsJson="[" + (($rowsOut|ForEach-Object{"[$($_.sku),$($_.prod),$($_.cls),$($_.cat),$($_.batch)]"}) -join ",") + "]"
    $parentsJson="[" + (($parentsOut|ForEach-Object{"[$($_.sku)]"}) -join ",") + "]"
    $prodGJson="[" + (($prodGroups|ForEach-Object{"[$($_.parentIdx),$($_.prod)]"}) -join ",") + "]"
    $clsGJson="[" + (($clsGroups|ForEach-Object{"[$($_.productGroupIdx),$($_.cls)]"}) -join ",") + "]"
    $catGJson="[" + (($catGroups|ForEach-Object{"[$($_.classGroupIdx),$($_.cat)]"}) -join ",") + "]"
    $rowCatJson="[" + (($rowCatIdx -join ",")) + "]"
    $skusJson=AJ $SKUS;$prodsJson=AJ $PRODS;$classesJson=AJ $CLASSES;$catsJson=AJ $CATS;$batchesJson=AJ $BATCHES;$monthsJson=AJ $months
    $salesJson="[" + (($salesArr|ForEach-Object{[string]$_}) -join ",") + "]"

    # nested table skeleton
    $pgByP=@{}; for($i=0;$i -lt $prodGroups.Count;$i++){ $k=$prodGroups[$i].parentIdx; if(-not $pgByP.ContainsKey($k)){$pgByP[$k]=@()}; $pgByP[$k]+=$i }
    $cgByPg=@{}; for($i=0;$i -lt $clsGroups.Count;$i++){ $k=$clsGroups[$i].productGroupIdx; if(-not $cgByPg.ContainsKey($k)){$cgByPg[$k]=@()}; $cgByPg[$k]+=$i }
    $catByCg=@{}; for($i=0;$i -lt $catGroups.Count;$i++){ $k=$catGroups[$i].classGroupIdx; if(-not $catByCg.ContainsKey($k)){$catByCg[$k]=@()}; $catByCg[$k]+=$i }
    $rowsByCat=@{}; for($i=0;$i -lt $rowsOut.Count;$i++){ $k=$rowCatIdx[$i]; if(-not $rowsByCat.ContainsKey($k)){$rowsByCat[$k]=@()}; $rowsByCat[$k]+=$i }
    $t=New-Object System.Text.StringBuilder
    [void]$t.Append("<div class='pivot-scroll ppk-scroll'><table class='pivot-table' id='ppk-pivot-table'><thead><tr><th class='corner'>SKU</th><th class='corner'>Product Name</th><th class='corner'>Query Class</th><th class='corner'>Query Category</th><th class='corner'>Batch Number</th>")
    foreach($mo in $months){[void]$t.Append("<th colspan='2' class='month-hdr' data-yr='$(YearOf $mo)'>$(HEnc $mo)</th>")}
    [void]$t.Append("</tr><tr><th class='corner'></th><th class='corner'></th><th class='corner'></th><th class='corner'></th><th class='corner'></th>")
    foreach($mo in $months){$yr=YearOf $mo; [void]$t.Append("<th class='sub-hdr' data-yr='$yr'>complain</th><th class='sub-hdr' data-yr='$yr'>complain%</th>")}
    [void]$t.Append("</tr></thead><tbody>")
    for($pi=0;$pi -lt $parentsOut.Count;$pi++){ $p=$parentsOut[$pi]; $z=if(($pi+1)%2 -eq 1){"zebra"}else{""}
        [void]$t.Append("<tr class='$z ppk-lvl1' id='ppk-parent-$pi' style='font-weight:700;'><td class='rowlabel'><span id='ppk-icon-1-$pi' class='ppk-toggle-icon' onclick='ppkToggle(1,$pi,event)' style='cursor:pointer;'>+</span>$(HEnc $SKUS[$p.sku])</td><td class='rowlabel'>&mdash;</td><td class='rowlabel'>&mdash;</td><td class='rowlabel'>&mdash;</td><td class='rowlabel'>&mdash;</td>")
        for($mi=0;$mi -lt $N;$mi++){$yr=YearOf $months[$mi]; [void]$t.Append("<td class='num' id='ppk-p-$pi-$mi-cnt' data-yr='$yr'>-</td><td class='pct' id='ppk-p-$pi-$mi-pct' data-yr='$yr'>-</td>")}
        [void]$t.Append("</tr>")
        foreach($pgi in ($pgByP[$pi])){ $pg=$prodGroups[$pgi]
            [void]$t.Append("<tr class='ppk-lvl2 ppk-child-of-p$pi' id='ppk-pg-$pgi' style='display:none;font-weight:600;background:var(--surface-1);'><td class='rowlabel'></td><td class='rowlabel' title=""$(HEnc $PRODS[$pg.prod])""><span id='ppk-icon-2-$pgi' class='ppk-toggle-icon' onclick='ppkToggle(2,$pgi,event)' style='cursor:pointer;'>+</span>$(HEnc $PRODS[$pg.prod])</td><td class='rowlabel'>&mdash;</td><td class='rowlabel'>&mdash;</td><td class='rowlabel'>&mdash;</td>")
            for($mi=0;$mi -lt $N;$mi++){$yr=YearOf $months[$mi]; [void]$t.Append("<td class='num' id='ppk-pg-$pgi-$mi-cnt' data-yr='$yr'>-</td><td class='pct' id='ppk-pg-$pgi-$mi-pct' data-yr='$yr'>-</td>")}
            [void]$t.Append("</tr>")
            foreach($cgi in ($cgByPg[$pgi])){ $cg=$clsGroups[$cgi]
                [void]$t.Append("<tr class='ppk-lvl3 ppk-child-of-pg$pgi' id='ppk-cg-$cgi' style='display:none;background:var(--pivot-zebra-bg);'><td class='rowlabel'></td><td class='rowlabel'></td><td class='rowlabel'><span id='ppk-icon-3-$cgi' class='ppk-toggle-icon' onclick='ppkToggle(3,$cgi,event)' style='cursor:pointer;'>+</span>$(HEnc $CLASSES[$cg.cls])</td><td class='rowlabel'>&mdash;</td><td class='rowlabel'>&mdash;</td>")
                for($mi=0;$mi -lt $N;$mi++){$yr=YearOf $months[$mi]; [void]$t.Append("<td class='num' id='ppk-cg-$cgi-$mi-cnt' data-yr='$yr'>-</td><td class='pct' id='ppk-cg-$cgi-$mi-pct' data-yr='$yr'>-</td>")}
                [void]$t.Append("</tr>")
                foreach($catgi in ($catByCg[$cgi])){ $catg=$catGroups[$catgi]
                    [void]$t.Append("<tr class='ppk-lvl4 ppk-child-of-cg$cgi' id='ppk-catg-$catgi' style='display:none;'><td class='rowlabel'></td><td class='rowlabel'></td><td class='rowlabel'></td><td class='rowlabel'><span id='ppk-icon-4-$catgi' class='ppk-toggle-icon' onclick='ppkToggle(4,$catgi,event)' style='cursor:pointer;'>+</span>$(HEnc $CATS[$catg.cat])</td><td class='rowlabel'>&mdash;</td>")
                    for($mi=0;$mi -lt $N;$mi++){$yr=YearOf $months[$mi]; [void]$t.Append("<td class='num' id='ppk-catg-$catgi-$mi-cnt' data-yr='$yr'>-</td><td class='pct' id='ppk-catg-$catgi-$mi-pct' data-yr='$yr'>-</td>")}
                    [void]$t.Append("</tr>")
                    foreach($ri in ($rowsByCat[$catgi])){ $c=$rowsOut[$ri]
                        [void]$t.Append("<tr class='ppk-lvl5 ppk-child-of-catg$catgi' id='ppk-row-$ri' style='display:none;background:var(--surface-card);'><td class='rowlabel'></td><td class='rowlabel'></td><td class='rowlabel'></td><td class='rowlabel'></td><td class='rowlabel'>$(HEnc $BATCHES[$c.batch])</td>")
                        for($mi=0;$mi -lt $N;$mi++){$yr=YearOf $months[$mi]; [void]$t.Append("<td class='num' id='ppk-$ri-$mi-cnt' data-yr='$yr'>-</td><td class='pct' id='ppk-$ri-$mi-pct' data-yr='$yr'>-</td>")}
                        [void]$t.Append("</tr>") } } } } }
    [void]$t.Append("</tbody></table></div>")

    $ppkCss = "<style>.ppk-scroll{max-height:640px;overflow-y:auto;}#ppk-pivot-table thead th{position:sticky;top:0;z-index:4;}#ppk-pivot-table thead tr:nth-child(2) th{top:28px;}.ppk-toggle-icon{display:inline-block;width:14px;font-weight:700;color:var(--s1);}#ppk-pivot-table td.rowlabel{position:sticky;z-index:3;background:var(--surface-card);}#ppk-pivot-table th.corner{z-index:6;}#ppk-pivot-table th.corner:nth-child(1),#ppk-pivot-table td.rowlabel:nth-child(1){left:0;width:90px;min-width:90px;max-width:90px;}#ppk-pivot-table th.corner:nth-child(2),#ppk-pivot-table td.rowlabel:nth-child(2){left:90px;width:190px;min-width:190px;max-width:190px;}#ppk-pivot-table th.corner:nth-child(3),#ppk-pivot-table td.rowlabel:nth-child(3){left:280px;width:130px;min-width:130px;max-width:130px;}#ppk-pivot-table th.corner:nth-child(4),#ppk-pivot-table td.rowlabel:nth-child(4){left:410px;width:170px;min-width:170px;max-width:170px;}#ppk-pivot-table th.corner:nth-child(5),#ppk-pivot-table td.rowlabel:nth-child(5){left:580px;width:110px;min-width:110px;max-width:110px;box-shadow:2px 0 4px -2px rgba(0,0,0,0.25);}</style>"

    $js = @"
<script>
(function(){
  var TICKETS=$ticketsJson,SKUS=$skusJson,PRODS=$prodsJson,CLASSES=$classesJson,CATS=$catsJson,BATCHES=$batchesJson,MONTHS=$monthsJson,SALES=$salesJson;
  var ROWS=$rowsJson,ROW_CATGROUP=$rowCatJson,PARENTS=$parentsJson,PRODUCT_GROUPS=$prodGJson,CLASS_GROUPS=$clsGJson,CATEGORY_GROUPS=$catGJson,N=MONTHS.length;
  var e1={},e2={},e3={},e4={},EB={1:e1,2:e2,3:e3,4:e4};
  function fmt(n){return n.toLocaleString('en-IN');}
  window.ppkToggle=function(lv,idx,ev){ if(ev)ev.stopPropagation(); var s=EB[lv]; s[idx]=!s[idx]; var ic=document.getElementById('ppk-icon-'+lv+'-'+idx); if(ic)ic.textContent=s[idx]?'−':'+'; render(); };
  function leafCounts(f){ var c=[]; for(var ri=0;ri<ROWS.length;ri++){c.push(new Array(N).fill(0));} var idx={}; for(var r2=0;r2<ROWS.length;r2++){idx[ROWS[r2].join('|')]=r2;}
    for(var i=0;i<TICKETS.length;i++){ var t=TICKETS[i],mo=t[0],sku=t[1],pr=t[2],cl=t[3],ca=t[4],ba=t[5];
      if(mo<0||mo>=N||sku<0||sku>=SKUS.length||pr<0||pr>=PRODS.length||cl<0||cl>=CLASSES.length||ca<0||ca>=CATS.length||ba<0||ba>=BATCHES.length)continue;
      if(f.month!==null&&mo!==f.month)continue; if(f.product!==null&&pr!==f.product)continue; if(f.sku!==null&&sku!==f.sku)continue; if(f.cls!==null&&cl!==f.cls)continue; if(f.category!==null&&ca!==f.category)continue;
      var k=sku+'|'+pr+'|'+cl+'|'+ca+'|'+ba; var ri=idx[k]; if(ri===undefined)continue; c[ri][mo]++; } return c; }
  function sm(a,b){var o=new Array(a.length);for(var i=0;i<a.length;i++){o[i]=a[i]+b[i];}return o;}
  function has(a){for(var i=0;i<a.length;i++){if(a[i]>0)return true;}return false;}
  function wc(pfx,idx,arr){ for(var mi=0;mi<N;mi++){ var v=arr[mi],s=SALES[mi],p=s>0?Math.round(v/s*100000)/1000:0; var cc=document.getElementById(pfx+'-'+idx+'-'+mi+'-cnt'),pc=document.getElementById(pfx+'-'+idx+'-'+mi+'-pct'); if(cc)cc.textContent=v>0?fmt(v):'-'; if(pc)pc.textContent=v>0?(p+'%'):'-'; } }
  var DIMS=['month','product','sku','cls','category'],SIDS={month:'ppk-filter-month',product:'ppk-filter-product',sku:'ppk-filter-sku',cls:'ppk-filter-class',category:'ppk-filter-category'},TP={month:0,sku:1,product:2,cls:3,category:4};
  function rf(){ var g=function(id){var e=document.getElementById(id);return e?e.value:'';}; return {month:g(SIDS.month)?MONTHS.indexOf(g(SIDS.month)):null,product:g(SIDS.product)?PRODS.indexOf(g(SIDS.product)):null,sku:g(SIDS.sku)?SKUS.indexOf(g(SIDS.sku)):null,cls:g(SIDS.cls)?CLASSES.indexOf(g(SIDS.cls)):null,category:g(SIDS.category)?CATS.indexOf(g(SIDS.category)):null}; }
  function tmatch(t,f,ex){ for(var d=0;d<DIMS.length;d++){var dim=DIMS[d]; if(dim===ex)continue; var w=f[dim]; if(w===null)continue; if(t[TP[dim]]!==w)return false;} return true; }
  function upd(f){ DIMS.forEach(function(dim){ var valid={}; for(var i=0;i<TICKETS.length;i++){var t=TICKETS[i]; if(tmatch(t,f,dim)){valid[t[TP[dim]]]=true;}} var sel=document.getElementById(SIDS[dim]); if(!sel)return; var hid=false; sel.querySelectorAll('option[data-idx]').forEach(function(o){var ix=parseInt(o.getAttribute('data-idx'),10),ok=!!valid[ix]; o.style.display=ok?'':'none'; o.disabled=!ok; if(!ok&&o.selected)hid=true;}); if(hid)sel.value=''; }); }
  function sk(a){var LM=N-1,c=a[LM],p=SALES[LM]>0?c/SALES[LM]:0;return {c:c,p:p};}
  function cmp(a,b){var ka=sk(a),kb=sk(b); if(kb.c!==ka.c)return kb.c-ka.c; return kb.p-ka.p;}
  function render(){ try{ var f=rf(); upd(f); f=rf(); var lc=leafCounts(f);
      var catgC=CATEGORY_GROUPS.map(function(){return new Array(N).fill(0);});
      for(var ri=0;ri<ROWS.length;ri++){var ci=ROW_CATGROUP[ri]; if(ci!==undefined&&catgC[ci]){catgC[ci]=sm(catgC[ci],lc[ri]);} wc('ppk',ri,lc[ri]);}
      var clsC=CLASS_GROUPS.map(function(){return new Array(N).fill(0);});
      for(var cg=0;cg<CATEGORY_GROUPS.length;cg++){var k=CATEGORY_GROUPS[cg][0]; if(clsC[k]){clsC[k]=sm(clsC[k],catgC[cg]);} wc('ppk-catg',cg,catgC[cg]);}
      var pgC=PRODUCT_GROUPS.map(function(){return new Array(N).fill(0);});
      for(var c2=0;c2<CLASS_GROUPS.length;c2++){var k2=CLASS_GROUPS[c2][0]; if(pgC[k2]){pgC[k2]=sm(pgC[k2],clsC[c2]);} wc('ppk-cg',c2,clsC[c2]);}
      var pC=PARENTS.map(function(){return new Array(N).fill(0);});
      for(var p2=0;p2<PRODUCT_GROUPS.length;p2++){var k3=PRODUCT_GROUPS[p2][0]; if(pC[k3]){pC[k3]=sm(pC[k3],pgC[p2]);} wc('ppk-pg',p2,pgC[p2]);}
      for(var pi=0;pi<PARENTS.length;pi++){wc('ppk-p',pi,pC[pi]);}
      var withData=0;
      for(var p3=0;p3<PARENTS.length;p3++){var hd=has(pC[p3]),el=document.getElementById('ppk-parent-'+p3); if(el)el.style.display=hd?'':'none'; if(hd)withData++;}
      for(var pg3=0;pg3<PRODUCT_GROUPS.length;pg3++){var hd2=has(pgC[pg3]),par=PRODUCT_GROUPS[pg3][0],el2=document.getElementById('ppk-pg-'+pg3); if(el2)el2.style.display=(!!e1[par]&&hd2)?'':'none';}
      for(var cg3=0;cg3<CLASS_GROUPS.length;cg3++){var hd3=has(clsC[cg3]),par2=CLASS_GROUPS[cg3][0],el3=document.getElementById('ppk-cg-'+cg3); if(el3)el3.style.display=(!!e2[par2]&&hd3)?'':'none';}
      for(var ca3=0;ca3<CATEGORY_GROUPS.length;ca3++){var hd4=has(catgC[ca3]),par3=CATEGORY_GROUPS[ca3][0],el4=document.getElementById('ppk-catg-'+ca3); if(el4)el4.style.display=(!!e3[par3]&&hd4)?'':'none';}
      for(var r4=0;r4<ROWS.length;r4++){var hd5=has(lc[r4]),par4=ROW_CATGROUP[r4],el5=document.getElementById('ppk-row-'+r4); if(el5)el5.style.display=(!!e4[par4]&&hd5)?'':'none';}
      var tb=document.querySelector('#ppk-pivot-table tbody');
      if(tb){ var po=PARENTS.map(function(_,i){return i;}); po.sort(function(a,b){return cmp(pC[a],pC[b]);});
        var pgBy={};PRODUCT_GROUPS.forEach(function(x,i){var k=x[0];(pgBy[k]=pgBy[k]||[]).push(i);});
        var cgBy={};CLASS_GROUPS.forEach(function(x,i){var k=x[0];(cgBy[k]=cgBy[k]||[]).push(i);});
        var caBy={};CATEGORY_GROUPS.forEach(function(x,i){var k=x[0];(caBy[k]=caBy[k]||[]).push(i);});
        var rBy={};ROWS.forEach(function(_,i){var k=ROW_CATGROUP[i];(rBy[k]=rBy[k]||[]).push(i);});
        po.forEach(function(pi){ var pe=document.getElementById('ppk-parent-'+pi); if(pe)tb.appendChild(pe);
          (pgBy[pi]||[]).slice().sort(function(a,b){return cmp(pgC[a],pgC[b]);}).forEach(function(pgi){ var pge=document.getElementById('ppk-pg-'+pgi); if(pge)tb.appendChild(pge);
            (cgBy[pgi]||[]).slice().sort(function(a,b){return cmp(clsC[a],clsC[b]);}).forEach(function(cgi){ var cge=document.getElementById('ppk-cg-'+cgi); if(cge)tb.appendChild(cge);
              (caBy[cgi]||[]).slice().sort(function(a,b){return cmp(catgC[a],catgC[b]);}).forEach(function(cai){ var cae=document.getElementById('ppk-catg-'+cai); if(cae)tb.appendChild(cae);
                (rBy[cai]||[]).slice().sort(function(a,b){return cmp(lc[a],lc[b]);}).forEach(function(ri){ var re=document.getElementById('ppk-row-'+ri); if(re)tb.appendChild(re); }); }); }); }); }); }
      var note=document.getElementById('ppk-filter-note'); if(note){note.textContent=withData+' of '+PARENTS.length+' SKUs have complaints for the selected filters, sorted by '+MONTHS[N-1]+' complaints. Expand SKU → Product → Query Class → Query Category to drill down.'; note.style.color='';}
    }catch(e){ var n2=document.getElementById('ppk-filter-note'); if(n2){n2.textContent='Filter error: '+e.message;n2.style.color='var(--s6)';} if(window.console)console.error('ProdPkg error',e); } }
  window.onProdPkgFilterChange=render;
  function init(){render();}
  if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',init);}else{init();}
})();
</script>
"@
    function DD($id,$lbl,$opts){ $s=New-Object System.Text.StringBuilder; [void]$s.Append("<div style='display:flex;flex-direction:column;gap:4px;min-width:150px;'><label for='$id' style='font-size:11px;color:var(--text-muted);'>$(HEnc $lbl)</label><select id='$id' onchange='onProdPkgFilterChange()' style='font-size:12.5px;padding:7px 10px;border-radius:8px;border:1px solid var(--border);background:var(--surface-card);color:var(--text-primary);font-family:inherit;max-width:220px;'><option value=''>All</option>"); for($oi=0;$oi -lt $opts.Count;$oi++){[void]$s.Append("<option value=""$(HEnc $opts[$oi])"" data-idx='$oi'>$(HEnc $opts[$oi])</option>")}; [void]$s.Append("</select></div>"); return $s.ToString() }
    $filterHtml="<div style='display:flex;gap:14px;flex-wrap:wrap;margin-bottom:16px;align-items:flex-end;'>" + (DD "ppk-filter-month" "Month" $months) + (DD "ppk-filter-product" "Product Name" $PRODS) + (DD "ppk-filter-sku" "SKU" $SKUS) + (DD "ppk-filter-class" "Query Class" $CLASSES) + (DD "ppk-filter-category" "Query Category" $CATS) + "</div><div id='ppk-filter-note' style='font-size:12px;color:var(--text-muted);margin-bottom:14px;'></div>"

    # ---- insights: sharpest single combo + top SKU overall, both by last month volume ----
    $ppkItems=@()
    $topKey=$null; $topComboVal=-1
    foreach($kv in $comboTot.GetEnumerator()){ $cval=$comboMC[$kv.Key][$LM]; if($cval -gt $topComboVal){$topComboVal=$cval;$topKey=$kv.Key} }
    if($topKey -and $topComboVal -gt 0){
        $parts=$topKey -split '\|'; $si=[int]$parts[0];$tpi=[int]$parts[1];$tli=[int]$parts[2];$tci=[int]$parts[3];$tbi=[int]$parts[4]
        $pct=if($lmSales -gt 0){Round1 ($topComboVal/$lmSales*100)}else{0}
        $ppkItems += InsightItem 'watch' "Sharpest single pain point in $(PrettyMonth $months[$LM]): <b>$(HEnc $SKUS[$si])</b> / $(HEnc $PRODS[$tpi]) &mdash; $(HEnc $CLASSES[$tli]) &rarr; $(HEnc $CATS[$tci]) (batch $(HEnc $BATCHES[$tbi])), $($topComboVal.ToString('N0')) tickets ($pct% of last month's sales)."
    }
    if($topSku.Count -gt 0){
        $tsIdx=[int]$topSku[0]; $tsVal=(LMK $skuTree[$topSku[0]].mc).cnt
        if($tsVal -gt 0){
            $tsPct=if($lmSales -gt 0){Round1 ($tsVal/$lmSales*100)}else{0}
            $ppkItems += InsightItem 'info' "SKU with the most product/packaging complaints overall in $(PrettyMonth $months[$LM]): <b>$(HEnc $SKUS[$tsIdx])</b> &mdash; $($tsVal.ToString('N0')) tickets ($tsPct% of last month's sales)."
        }
    }
    $ppkInsights = Build-InsightsCard "Insights &mdash; Product &amp; Packaging" $ppkItems

    return @"
  <div class="tab-panel" id="panel-prodpkg">
    <section>
      <h2>Product Packaging and Operational Complaints wrt Product Sales</h2>
      <p class="desc">Combines "Product" and "Packaging and Operational" tickets by SKU &rarr; Product &rarr; Query Class &rarr; Query Category &rarr; Batch. Click the + at each level to drill down; percent = complaints &divide; that month's total order volume.</p>
      $filterHtml
      <div class='pivot-wrap'><div class='pivot-title'>Product Packaging and Operational Complaints wrt Product Sales</div>$($t.ToString())</div>
    </section>
    $ppkInsights
  </div>
$ppkCss
$js
"@
}

function Assemble-Report {
    $head = Get-Content -Raw -Path (Join-Path $Here "_shell_head.html")
    # tab nav: CSAT, NPS, Overview, then classes, then Product & Packaging
    $nav = "<button class=""tab-btn active"" data-tab=""csat"">CSAT</button><button class=""tab-btn"" data-tab=""nps"">NPS</button><button class=""tab-btn"" data-tab=""overview"">Overview</button><button class=""tab-btn"" data-tab=""monthly"">Monthly Analysis</button>"
    foreach($c in $B.Classes){ $nav += "<button class=""tab-btn"" data-tab=""$($c.id)"">$(HEnc $c.label)</button>" }
    $nav += "<button class=""tab-btn"" data-tab=""prodpkg"">Product &amp; Packaging wrt Sales</button>"

    $panels = New-Object System.Text.StringBuilder
    [void]$panels.Append("<div class=""tab-panel"" id=""panel-overview"">$($ov.ToString())</div>")
    [void]$panels.Append((Build-MonthlyAnalysisPanel))
    foreach($c in $B.Classes){
        $kpi = KpiRow $c ($unique | Where-Object { (Cell $_ $Col.cls) -eq $c.key })
        $detail = switch($c.id){
            "delivery"   { Build-CrossFilterPanel $c "partner"  "Delivery Partner Name" "$(HEnc $c.label) Complaints wrt Delivery Partners" "alloc" "wrt allocation" 9999 "none" }
            "technical"  { Build-CrossFilterPanel $c "platform" "Platform"              "$(HEnc $c.label) Complaints by Platform"           "sales" "wrt sales"      9999 "sinceFirst" }
            "warehouse"  { Build-CrossFilterPanel $c "wh"       "Warehouse Facility"    "$(HEnc $c.label) Complaints by Warehouse Facility" "sales" "wrt sales"      9999 "none" }
            "product"    { Build-CrossFilterPanel $c "prod"     "Product Name"          "$(HEnc $c.label) Complaints by Product"            "sales" "wrt sales"      25   "none" }
            "suggestion" { Build-CrossFilterPanel $c "prod"     "Product Name"          "$(HEnc $c.label) Complaints by Product"            "sales" "wrt sales"      25   "sparsePct" }
            default      { Build-ClassPanel $c }
        }
        [void]$panels.Append("<div class=""tab-panel"" id=""panel-$($c.id)"">$kpi`n$detail</div>")
    }
    $nowStr = (Get-Date).ToUniversalTime().AddHours(5.5).ToString('dd MMM yyyy, HH:mm') + " IST"
    $foot = "<footer><p><strong>Methodology:</strong> Aggregated from the raw ""$($B.SheetName)"" tab. Rows flagged ""Duplicate"" are excluded from per-class drill-downs (Overview shows both). Percentages use the sheet's own ""Total Sales M"" / ""Partner Allocation"" figures.</p><p>Auto-refreshed daily at 2 PM IST. Last updated $nowStr. No raw ticket-level PII is stored &mdash; all figures are aggregated segment counts.</p></footer>"
    $tabjs = "<script>document.querySelectorAll('.tab-btn').forEach(function(b){b.addEventListener('click',function(){document.querySelectorAll('.tab-btn').forEach(function(x){x.classList.remove('active');});document.querySelectorAll('.tab-panel').forEach(function(p){p.classList.remove('active');});b.classList.add('active');document.getElementById('panel-'+b.dataset.tab).classList.add('active');});});</script>"

    $monthChips = New-Object System.Text.StringBuilder
    $lastEligible = if($script:WeeklyEligibleMonths.Count -gt 0){$script:WeeklyEligibleMonths[$script:WeeklyEligibleMonths.Count-1]}else{-1}
    foreach($mi in $script:WeeklyEligibleMonths){ $act=if($mi -eq $lastEligible){" active"}else{""}
        [void]$monthChips.Append("<button type=""button"" class=""month-chip$act"" data-month=""$mi"" data-yr=""$(YearOf $months[$mi])"" onclick=""toggleWeekMonthChip($mi)"">$(HEnc (PrettyMonth $months[$mi]))</button>") }
    $granToolbar = @"
<div class="gran-toolbar">
  <div class="gran-toggle">
    <button type="button" class="gran-btn active" data-gran="monthly" onclick="setGranularity('monthly')">Monthly</button>
    <button type="button" class="gran-btn" data-gran="weekly" onclick="setGranularity('weekly')">Weekly</button>
  </div>
  <div class="gran-month-picker" id="gran-month-wrap" style="display:none;">
    <span class="gran-note" style="font-weight:600;">Month</span>
    $($monthChips.ToString())
  </div>
  <span class="gran-note">Weekly applies to Overview and every complaint-category tab, including the category breakdown on Delivery/Technical/Warehouse/Product/Suggestion &mdash; but their second-dimension breakdown (partner/platform/facility/product name) and click-to-cross-filter stay monthly-only. Not available on NPS/CSAT or the separate Product &amp; Packaging wrt Sales tab. Pick multiple months to stack their weekly tables; the Year filter below also narrows which months are offered here.</span>
</div>
<script>
(function(){
  var curGran='monthly';
  var selectedWeekMonths = new Set([$lastEligible]);
  window.setGranularity=function(g){
    curGran=g;
    document.querySelectorAll('.gran-btn').forEach(function(b){b.classList.toggle('active',b.dataset.gran===g);});
    var mw=document.getElementById('gran-month-wrap'); if(mw){mw.style.display=(g==='weekly')?'':'none';}
    applyGranularity();
  };
  window.toggleWeekMonthChip=function(mi){
    if(selectedWeekMonths.has(mi)){ if(selectedWeekMonths.size>1){selectedWeekMonths.delete(mi);} }
    else { selectedWeekMonths.add(mi); }
    document.querySelectorAll('#gran-month-wrap .month-chip').forEach(function(b){ b.classList.toggle('active', selectedWeekMonths.has(parseInt(b.dataset.month,10))); });
    applyGranularity();
  };
  window.applyGranularity=function(){
    document.querySelectorAll('.gran-monthly').forEach(function(el){el.style.display=(curGran==='monthly')?'':'none';});
    document.querySelectorAll('.gran-weekly').forEach(function(el){el.style.display='none';});
    if(curGran==='weekly'){
      selectedWeekMonths.forEach(function(mi){
        document.querySelectorAll('.gran-weekly[data-month="'+mi+'"]').forEach(function(el){el.style.display='';});
      });
    }
  };
})();
</script>
"@

    $yearToolbar = ""
    if($distinctYears.Count -gt 1){
        $yearChips = ($distinctYears | ForEach-Object { "<button type=""button"" class=""year-chip active"" data-yr=""$_"" onclick=""toggleYearChip('$_')"">$_</button>" }) -join ""
        $yearToolbar = @"
<div class="gran-toolbar">
  <span class="gran-note" style="font-weight:600;">Year</span>
  $yearChips
  <span class="gran-note">Narrows which month columns/bars show in every table and chart on the page (weekly view and Monthly Analysis are unaffected).</span>
</div>
<script>
(function(){
  var activeYears = new Set([$(($distinctYears | ForEach-Object { "'$_'" }) -join ",")]);
  window.toggleYearChip=function(yr){
    if(activeYears.has(yr)){ if(activeYears.size>1){ activeYears.delete(yr); } }
    else { activeYears.add(yr); }
    document.querySelectorAll('.year-chip').forEach(function(b){ b.classList.toggle('active', activeYears.has(b.dataset.yr)); });
    document.querySelectorAll('[data-yr]').forEach(function(el){ el.style.display = activeYears.has(el.getAttribute('data-yr')) ? '' : 'none'; });
  };
})();
</script>
"@
    }

    return @"
<title>$(HEnc $B.Title) Customer Query &mdash; Segment Report</title>
$head
<div class="wrap">
  <header class="hero">
    <a class="home-link" href="/">&larr; Home</a>
    <div>
      <span class="badge">Customer Experience</span>
      <span class="badge">$(HEnc $B.Title)</span>
      <span class="badge">Updated $nowStr</span>
    </div>
    <h1>Customer Query Segment Report &mdash; $(HEnc $B.Title)</h1>
    <p>Source: "$(HEnc $B.SheetName)" tab &middot; $($totalRows.ToString('N0')) raw ticket rows, deduplicated to $($totalUnique.ToString('N0')) unique tickets</p>
  </header>
  <nav class="tab-nav">$nav</nav>
  $granToolbar
  $yearToolbar
  $(Build-CsatPanel)
  $(Build-NpsPanel)
  $($panels.ToString())
  $(Build-ProdPkgPanel)
  $foot
</div>
$tabjs
"@
}
