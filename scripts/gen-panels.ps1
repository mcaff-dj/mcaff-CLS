# Panel builders, dot-sourced by Generate-Report.ps1 (shares its variables/functions).

function Build-DeliveryPanel {
    $delivery = $unique | Where-Object { (Cell $_ $Col.cls) -eq "Delivery" }
    $catTot=@{}; foreach($r in $delivery){ $c=Cell $r $Col.cat; if([string]::IsNullOrWhiteSpace($c)){$c="(blank)"}; if(-not $catTot.ContainsKey($c)){$catTot[$c]=0}; $catTot[$c]++ }
    $catOrder=@($catTot.GetEnumerator()|Sort-Object Value -Descending|ForEach-Object{$_.Key})
    $pTot=@{}; foreach($r in $delivery){ $p=Cell $r $Col.partner; if([string]::IsNullOrWhiteSpace($p)){$p="(blank)"}; if(-not $pTot.ContainsKey($p)){$pTot[$p]=0}; $pTot[$p]++ }
    $partnerOrder=@($pTot.GetEnumerator()|Sort-Object Value -Descending|ForEach-Object{$_.Key})

    $tk=New-Object System.Collections.Generic.List[object]
    foreach($r in $delivery){ $mo=Cell $r $Col.month; $mi=[array]::IndexOf($months,$mo); if($mi -lt 0){continue}
        $cat=Cell $r $Col.cat; if([string]::IsNullOrWhiteSpace($cat)){$cat="(blank)"}; $ci=[array]::IndexOf($catOrder,$cat)
        $p=Cell $r $Col.partner; if([string]::IsNullOrWhiteSpace($p)){$p="(blank)"}; $pi=[array]::IndexOf($partnerOrder,$p)
        $tk.Add("[$mi,$ci,$pi]") }
    $ticketsJson="[" + ($tk -join ",") + "]"
    $catsJson="[" + (($catOrder|ForEach-Object{'"'+(JEnc $_)+'"'}) -join ",") + "]"
    $partnersJson="[" + (($partnerOrder|ForEach-Object{'"'+(JEnc $_)+'"'}) -join ",") + "]"
    $monthsJson="[" + (($months|ForEach-Object{'"'+(JEnc $_)+'"'}) -join ",") + "]"
    $salesJson="[" + (($salesArr|ForEach-Object{[string]$_}) -join ",") + "]"

    $W=1200;$H=380;$padL=55;$padR=55;$padT=40;$padB=55;$plotW=$W-$padL-$padR;$plotH=$H-$padT-$padB;$slot=$plotW/$N;$barW=$slot*0.55

    $sb1=New-Object System.Text.StringBuilder
    [void]$sb1.Append("<div class='pivot-wrap'><div class='pivot-title'>Delivery Complaints</div><div class='pivot-scroll'><table class='pivot-table' id='cat-pivot-table'><thead><tr><th class='corner' rowspan='2'>Query Category</th>")
    foreach($mo in $months){[void]$sb1.Append("<th colspan='2' class='month-hdr'>$(HEnc $mo)</th>")}
    [void]$sb1.Append("</tr><tr>"); foreach($mo in $months){[void]$sb1.Append("<th class='sub-hdr'>Complaints</th><th class='sub-hdr'>wrt sales</th>")}
    [void]$sb1.Append("</tr></thead><tbody>")
    for($ci=0;$ci -lt $catOrder.Count;$ci++){ $z=if(($ci+1)%2 -eq 1){"zebra"}else{""}
        [void]$sb1.Append("<tr class='$z'><td class='rowlabel'>$(HEnc $catOrder[$ci])</td>")
        for($mi=0;$mi -lt $N;$mi++){[void]$sb1.Append("<td class='num' id='cat-$ci-mo-$mi-cnt'>-</td><td class='pct' id='cat-$ci-mo-$mi-pct'>-</td>")}
        [void]$sb1.Append("</tr>") }
    [void]$sb1.Append("<tr class='total-row'><td class='rowlabel'>Grand Total</td>")
    for($mi=0;$mi -lt $N;$mi++){[void]$sb1.Append("<td class='num' id='cat-total-mo-$mi-cnt'>-</td><td class='pct' id='cat-total-mo-$mi-pct'>-</td>")}
    [void]$sb1.Append("</tr></tbody></table></div></div>")

    $sb2=New-Object System.Text.StringBuilder
    [void]$sb2.Append("<div class='card'><div class='pivot-title' style='margin-bottom:18px;'>Delivery Complaints wrt Sales</div><div class='legend-row' style='justify-content:center;'><div class='legend-item'><span class='swatch' style='background:var(--s1);'></span><span class='lname'>Complaints</span></div><div class='legend-item'><span class='swatch' style='background:var(--s3);border-radius:50%;'></span><span class='lname'>wrt sales %</span></div></div>")
    [void]$sb2.Append("<svg viewBox='0 0 $W $H' width='100%' height='$H' role='img'><line x1='$padL' y1='$($padT+$plotH)' x2='$($W-$padR)' y2='$($padT+$plotH)' stroke='var(--baseline)' stroke-width='1'/>")
    for($i=0;$i -lt $N;$i++){ $cx=$padL+$slot*$i+$slot/2; $bx=$cx-$barW/2; $ml=PrettyMonth $months[$i]
        [void]$sb2.Append("<rect id='d-bar-$i' x='$bx' y='$($padT+$plotH)' width='$barW' height='0' fill='var(--s1)' rx='2'/><text id='d-barval-$i' x='$cx' y='$($padT+$plotH-8)' text-anchor='middle' font-size='10.5' fill='var(--text-primary)' font-weight='600'></text><text x='$cx' y='$($H-$padB+18)' text-anchor='middle' font-size='10.5' fill='var(--text-muted)'>$ml</text>") }
    [void]$sb2.Append("<polyline id='d-polyline' points='' fill='none' stroke='var(--s3)' stroke-width='2'/>")
    for($i=0;$i -lt $N;$i++){[void]$sb2.Append("<circle id='d-dot-$i' cx='0' cy='0' r='3' fill='var(--s3)' visibility='hidden'/><text id='d-dotval-$i' x='0' y='0' text-anchor='middle' font-size='10.5' font-weight='600' fill='var(--s3)'></text>")}
    [void]$sb2.Append("</svg></div>")

    $pm=[ordered]@{}; $aSum=@{}; $aCnt=@{}
    foreach($r in $delivery){ $p=Cell $r $Col.partner; if([string]::IsNullOrWhiteSpace($p)){$p="(blank)"}; $mo=Cell $r $Col.month; if([string]::IsNullOrWhiteSpace($mo)){continue}
        if(-not $pm.Contains($p)){$pm[$p]=@{}}; if($pm[$p].ContainsKey($mo)){$pm[$p][$mo]++}else{$pm[$p][$mo]=1}
        $ar=Cell $r $Col.alloc; $av=0.0; if([double]::TryParse(($ar -replace ',',''),[ref]$av) -and $av -gt 0){ $ak="$p|$mo"; if($aSum.ContainsKey($ak)){$aSum[$ak]+=$av;$aCnt[$ak]++}else{$aSum[$ak]=$av;$aCnt[$ak]=1} } }
    $sb3=New-Object System.Text.StringBuilder
    [void]$sb3.Append("<div class='pivot-wrap'><div class='pivot-title'>Delivery Complaints wrt Delivery Partners</div><div class='pivot-scroll'><table class='pivot-table' id='partner-pivot-table'><thead><tr><th class='corner' rowspan='2'>Delivery Partner Name</th>")
    foreach($mo in $months){[void]$sb3.Append("<th colspan='2' class='month-hdr'>$(HEnc $mo)</th>")}
    [void]$sb3.Append("</tr><tr>"); foreach($mo in $months){[void]$sb3.Append("<th class='sub-hdr'>Complaints</th><th class='sub-hdr'>wrt allocation</th>")}
    [void]$sb3.Append("</tr></thead><tbody>")
    $ri=0; foreach($p in $partnerOrder){ $ri++; $z=if($ri%2 -eq 1){"zebra"}else{""}
        [void]$sb3.Append("<tr class='$z' data-partner=""$(HEnc $p)""><td class='rowlabel'>$(HEnc $p)</td>")
        foreach($mo in $months){ $cnt=0; if($pm[$p].ContainsKey($mo)){$cnt=$pm[$p][$mo]}; $ak="$p|$mo"; $avg=0; if($aCnt.ContainsKey($ak) -and $aCnt[$ak] -gt 0){$avg=$aSum[$ak]/$aCnt[$ak]}
            $cd=if($cnt -gt 0){$cnt.ToString('N0')}else{"-"}; $pd=if($cnt -gt 0 -and $avg -gt 0){"$(Round1 ($cnt/$avg*100))%"}else{"-"}
            [void]$sb3.Append("<td class='num'>$cd</td><td class='pct'>$pd</td>") }
        [void]$sb3.Append("</tr>") }
    [void]$sb3.Append("</tbody></table></div></div>")

    $filter="<div class='filter-row' style='display:flex;align-items:center;gap:10px;margin:0 0 20px;flex-wrap:wrap;'><label for='delivery-partner-filter' style='font-size:13px;color:var(--text-secondary);font-weight:500;'>Filter by Delivery Partner:</label><select id='delivery-partner-filter' onchange='onDeliveryPartnerChange(this.value)' style='font-size:13px;padding:7px 12px;border-radius:8px;border:1px solid var(--border);background:var(--surface-card);color:var(--text-primary);font-family:inherit;'><option value=''>All Partners</option>" + (($partnerOrder|ForEach-Object{"<option value=""$(HEnc $_)"">$(HEnc $_)</option>"}) -join "") + "</select><span id='delivery-filter-note' style='font-size:12px;color:var(--text-muted);'></span></div>"

    $js = @"
<script>
(function(){
  var DT=$ticketsJson, CATS=$catsJson, PARTNERS=$partnersJson, MONTHS=$monthsJson, SALES=$salesJson, N=MONTHS.length;
  var padL=$padL,padT=$padT,plotH=$plotH,slot=$slot,barW=$barW, BAR=null,PCT=null;
  function agg(pi){ var cm=CATS.map(function(){return new Array(N).fill(0)}), tot=new Array(N).fill(0), tc=0;
    for(var i=0;i<DT.length;i++){ var t=DT[i],mo=t[0],c=t[1],p=t[2]; if(mo<0||mo>=N||c<0||c>=CATS.length||p<0||p>=PARTNERS.length)continue; if(pi!==null&&p!==pi)continue; cm[c][mo]++; tot[mo]++; tc++; }
    return {cm:cm,tot:tot,tc:tc}; }
  function fmt(n){return n.toLocaleString('en-IN');}
  function nice(v){ if(v<=0)return 10; var m=Math.pow(10,Math.floor(Math.log10(v))); var s=[1,2,2.5,5,10]; for(var i=0;i<s.length;i++){var c=s[i]*m; if(c>=v)return c;} return 10*m; }
  function rct(a){ for(var ci=0;ci<CATS.length;ci++){ for(var mi=0;mi<N;mi++){ var cnt=a.cm[ci][mi],sm=SALES[mi],p=sm>0?Math.round(cnt/sm*1000)/10:0; document.getElementById('cat-'+ci+'-mo-'+mi+'-cnt').textContent=cnt>0?fmt(cnt):'-'; document.getElementById('cat-'+ci+'-mo-'+mi+'-pct').textContent=p+'%'; } }
    for(var m2=0;m2<N;m2++){ var t=a.tot[m2],sm2=SALES[m2],p2=sm2>0?Math.round(t/sm2*1000)/10:0; document.getElementById('cat-total-mo-'+m2+'-cnt').textContent=fmt(t); document.getElementById('cat-total-mo-'+m2+'-pct').textContent=p2+'%'; } }
  function rch(a){ var vals=a.tot, pcts=vals.map(function(v,i){var sm=SALES[i];return sm>0?Math.round(v/sm*10000)/100:0;});
    BAR=nice(Math.max.apply(null,vals)*1.15); PCT=nice(Math.max.apply(null,pcts)*1.2); var pts=[];
    for(var i=0;i<N;i++){ var cx=padL+slot*i+slot/2,bx=cx-barW/2,bh=plotH*(vals[i]/BAR),by=padT+plotH-bh;
      var r=document.getElementById('d-bar-'+i); r.setAttribute('y',by); r.setAttribute('height',bh);
      var bv=document.getElementById('d-barval-'+i); bv.setAttribute('y',by-8); bv.textContent=vals[i]>0?fmt(vals[i]):'';
      var ly=padT+plotH-(plotH*(pcts[i]/PCT)); pts.push(cx+','+ly);
      var d=document.getElementById('d-dot-'+i); d.setAttribute('cx',cx); d.setAttribute('cy',ly); d.setAttribute('visibility','visible');
      var dv=document.getElementById('d-dotval-'+i); dv.setAttribute('x',cx); dv.setAttribute('y',ly-10); dv.textContent=pcts[i]+'%'; }
    document.getElementById('d-polyline').setAttribute('points',pts.join(' ')); }
  function fpt(sel){ document.querySelectorAll('#partner-pivot-table tbody tr').forEach(function(row){ row.style.display=(!sel||row.getAttribute('data-partner')===sel)?'':'none'; }); }
  window.onDeliveryPartnerChange=function(sel){ try{ var idx=(sel&&sel.length)?PARTNERS.indexOf(sel):null; var a=agg(idx); rct(a); rch(a); fpt(sel);
      var note=document.getElementById('delivery-filter-note'); if(note){note.textContent=sel?('('+fmt(a.tc)+' tickets for '+sel+')'):'';}
      var kv=document.getElementById('delivery-kpi-unique-value'); if(kv){kv.textContent=fmt(a.tc);}
      var kl=document.getElementById('delivery-kpi-unique-label'); if(kl){kl.textContent=sel?('Tickets ('+sel+')'):'Unique Tickets';}
    }catch(e){ var n2=document.getElementById('delivery-filter-note'); if(n2){n2.textContent='Filter error: '+e.message; n2.style.color='var(--s6)';} if(window.console)console.error('Delivery filter error',e); } };
  function init(){ onDeliveryPartnerChange(''); }
  if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',init);}else{init();}
})();
</script>
"@

    return @"
$filter
<section><h2>Delivery Complaints by Issue Category</h2><p class="desc">Percent = complaints &divide; that month's total order volume ("Total Sales M"). Recomputes for the partner selected above.</p>$($sb1.ToString())</section>
<section><h2>Delivery Complaints wrt Sales</h2><p class="desc">Monthly complaint volume (bars) against complaint rate as a share of sales (line). Recomputes for the partner selected above.</p>$($sb2.ToString())</section>
<section><h2>Delivery Complaints wrt Delivery Partners</h2><p class="desc">Percent = that partner's complaint count &divide; the average of its "Partner Allocation" for the month. "-" means allocation wasn't recorded that month.</p>$($sb3.ToString())</section>
$js
"@
}

function Build-ClassPanel($cls){
    $subset = $unique | Where-Object { (Cell $_ $Col.cls) -eq $cls.key }
    $mt=[ref]@()
    $pivot = Build-CategoryPivot $subset "$($cls.label) Complaints" $mt
    $chart = Build-ComboChart $mt.Value "$($cls.label) Complaints wrt Sales" $cls.color "var(--s1)"
    $batch=""
    if($cls.key -eq "Packaging and Operational" -or $cls.key -eq "Product" -or $cls.key -eq "Product Suggestion/Recommendation"){ $batch = Build-BatchTable $subset $cls.label }
    return @"
<section><h2>$(HEnc $cls.label) Complaints by Issue Category</h2><p class="desc">Percent = complaints &divide; that month's total order volume ("Total Sales M").</p>$pivot</section>
<section><h2>$(HEnc $cls.label) Complaints wrt Sales</h2><p class="desc">Monthly complaint volume (bars) against complaint rate as a share of sales (line).</p>$chart</section>
$batch
"@
}

function Build-Combo2($rows,$title,$scoreLabel,$scoreMax){
    $mos=@();$vals=@();$sc=@()
    for($i=1;$i -lt $rows.Count;$i++){ $r=$rows[$i]; $mos+=(PrettyMonth $r[0]); $vals+=[double]($r[1] -replace ',',''); $sc+=[double]$r[2] }
    $n=$mos.Count; if($n -eq 0){ return "<div class='card'><p class='note'>No data.</p></div>" }
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
        [void]$sb.Append("<rect x='$bx' y='$by' width='$barW' height='$bh' fill='var(--s2)' rx='2'/><text x='$cx' y='$($by-8)' text-anchor='middle' font-size='12' font-weight='700' fill='var(--text-primary)'>$('{0:N0}' -f $vals[$i])</text>")
        $ly=$padT+$plotH*(1-$sc[$i]/$scoreMax); $pts+="$cx,$ly"
        [void]$sb.Append("<text x='$cx' y='$($H-$padB+20)' text-anchor='middle' font-size='11' fill='var(--text-muted)'>$($mos[$i])</text>") }
    [void]$sb.Append("<polyline points='$($pts -join ' ')' fill='none' stroke='var(--s1)' stroke-width='2.5'/>")
    for($i=0;$i -lt $n;$i++){ $p=$pts[$i] -split ','; [void]$sb.Append("<circle cx='$($p[0])' cy='$($p[1])' r='4' fill='var(--s1)'/><text x='$($p[0])' y='$([double]$p[1]-12)' text-anchor='middle' font-size='12' font-weight='700' fill='var(--s1)'>$($sc[$i])</text>") }
    [void]$sb.Append("</svg></div>")
    return $sb.ToString()
}

function Build-NpsPanel {
    $o = Build-Combo2 $mom "NPS - Overall" "NPS%" 100
    $p = Build-Combo2 $prodnps "NPS - Product" "NPS" 100
    return "<div class=""tab-panel"" id=""panel-nps""><section><h2>Net Promoter Score</h2><p class=""desc"">Monthly survey responses (bars, right axis) against NPS (line, left axis).</p>$o</section><section>$p</section></div>"
}
function Build-CsatPanel {
    $a = Build-Combo2 $agent "Agent CSAT" "CSAT" 5
    $i = Build-Combo2 $ai "AI CSAT" "CSAT" 5
    return "<div class=""tab-panel active"" id=""panel-csat""><section><h2>Customer Satisfaction (CSAT)</h2><p class=""desc"">Monthly survey responses (bars, right axis) against CSAT out of 5 (line, left axis).</p>$a</section><section>$i</section></div>"
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
    foreach($mo in $months){[void]$t.Append("<th colspan='2' class='month-hdr'>$(HEnc $mo)</th>")}
    [void]$t.Append("</tr><tr><th class='corner'></th><th class='corner'></th><th class='corner'></th><th class='corner'></th><th class='corner'></th>")
    foreach($mo in $months){[void]$t.Append("<th class='sub-hdr'>complain</th><th class='sub-hdr'>complain%</th>")}
    [void]$t.Append("</tr></thead><tbody>")
    for($pi=0;$pi -lt $parentsOut.Count;$pi++){ $p=$parentsOut[$pi]; $z=if(($pi+1)%2 -eq 1){"zebra"}else{""}
        [void]$t.Append("<tr class='$z ppk-lvl1' id='ppk-parent-$pi' style='font-weight:700;'><td class='rowlabel'><span id='ppk-icon-1-$pi' class='ppk-toggle-icon' onclick='ppkToggle(1,$pi,event)' style='cursor:pointer;'>+</span>$(HEnc $SKUS[$p.sku])</td><td class='rowlabel'>&mdash;</td><td class='rowlabel'>&mdash;</td><td class='rowlabel'>&mdash;</td><td class='rowlabel'>&mdash;</td>")
        for($mi=0;$mi -lt $N;$mi++){[void]$t.Append("<td class='num' id='ppk-p-$pi-$mi-cnt'>-</td><td class='pct' id='ppk-p-$pi-$mi-pct'>-</td>")}
        [void]$t.Append("</tr>")
        foreach($pgi in ($pgByP[$pi])){ $pg=$prodGroups[$pgi]
            [void]$t.Append("<tr class='ppk-lvl2 ppk-child-of-p$pi' id='ppk-pg-$pgi' style='display:none;font-weight:600;background:var(--surface-1);'><td class='rowlabel'></td><td class='rowlabel' title=""$(HEnc $PRODS[$pg.prod])""><span id='ppk-icon-2-$pgi' class='ppk-toggle-icon' onclick='ppkToggle(2,$pgi,event)' style='cursor:pointer;'>+</span>$(HEnc $PRODS[$pg.prod])</td><td class='rowlabel'>&mdash;</td><td class='rowlabel'>&mdash;</td><td class='rowlabel'>&mdash;</td>")
            for($mi=0;$mi -lt $N;$mi++){[void]$t.Append("<td class='num' id='ppk-pg-$pgi-$mi-cnt'>-</td><td class='pct' id='ppk-pg-$pgi-$mi-pct'>-</td>")}
            [void]$t.Append("</tr>")
            foreach($cgi in ($cgByPg[$pgi])){ $cg=$clsGroups[$cgi]
                [void]$t.Append("<tr class='ppk-lvl3 ppk-child-of-pg$pgi' id='ppk-cg-$cgi' style='display:none;background:var(--pivot-zebra-bg);'><td class='rowlabel'></td><td class='rowlabel'></td><td class='rowlabel'><span id='ppk-icon-3-$cgi' class='ppk-toggle-icon' onclick='ppkToggle(3,$cgi,event)' style='cursor:pointer;'>+</span>$(HEnc $CLASSES[$cg.cls])</td><td class='rowlabel'>&mdash;</td><td class='rowlabel'>&mdash;</td>")
                for($mi=0;$mi -lt $N;$mi++){[void]$t.Append("<td class='num' id='ppk-cg-$cgi-$mi-cnt'>-</td><td class='pct' id='ppk-cg-$cgi-$mi-pct'>-</td>")}
                [void]$t.Append("</tr>")
                foreach($catgi in ($catByCg[$cgi])){ $catg=$catGroups[$catgi]
                    [void]$t.Append("<tr class='ppk-lvl4 ppk-child-of-cg$cgi' id='ppk-catg-$catgi' style='display:none;'><td class='rowlabel'></td><td class='rowlabel'></td><td class='rowlabel'></td><td class='rowlabel'><span id='ppk-icon-4-$catgi' class='ppk-toggle-icon' onclick='ppkToggle(4,$catgi,event)' style='cursor:pointer;'>+</span>$(HEnc $CATS[$catg.cat])</td><td class='rowlabel'>&mdash;</td>")
                    for($mi=0;$mi -lt $N;$mi++){[void]$t.Append("<td class='num' id='ppk-catg-$catgi-$mi-cnt'>-</td><td class='pct' id='ppk-catg-$catgi-$mi-pct'>-</td>")}
                    [void]$t.Append("</tr>")
                    foreach($ri in ($rowsByCat[$catgi])){ $c=$rowsOut[$ri]
                        [void]$t.Append("<tr class='ppk-lvl5 ppk-child-of-catg$catgi' id='ppk-row-$ri' style='display:none;background:var(--surface-card);'><td class='rowlabel'></td><td class='rowlabel'></td><td class='rowlabel'></td><td class='rowlabel'></td><td class='rowlabel'>$(HEnc $BATCHES[$c.batch])</td>")
                        for($mi=0;$mi -lt $N;$mi++){[void]$t.Append("<td class='num' id='ppk-$ri-$mi-cnt'>-</td><td class='pct' id='ppk-$ri-$mi-pct'>-</td>")}
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

    return @"
  <div class="tab-panel" id="panel-prodpkg">
    <section>
      <h2>Product Packaging and Operational Complaints wrt Product Sales</h2>
      <p class="desc">Combines "Product" and "Packaging and Operational" tickets by SKU &rarr; Product &rarr; Query Class &rarr; Query Category &rarr; Batch. Click the + at each level to drill down; percent = complaints &divide; that month's total order volume.</p>
      $filterHtml
      <div class='pivot-wrap'><div class='pivot-title'>Product Packaging and Operational Complaints wrt Product Sales</div>$($t.ToString())</div>
    </section>
  </div>
$ppkCss
$js
"@
}

function Assemble-Report {
    $head = Get-Content -Raw -Path (Join-Path $Here "_shell_head.html")
    # tab nav: CSAT, NPS, Overview, then classes, then Product & Packaging
    $nav = "<button class=""tab-btn active"" data-tab=""csat"">CSAT</button><button class=""tab-btn"" data-tab=""nps"">NPS</button><button class=""tab-btn"" data-tab=""overview"">Overview</button>"
    foreach($c in $B.Classes){ $nav += "<button class=""tab-btn"" data-tab=""$($c.id)"">$(HEnc $c.label)</button>" }
    $nav += "<button class=""tab-btn"" data-tab=""prodpkg"">Product &amp; Packaging wrt Sales</button>"

    $panels = New-Object System.Text.StringBuilder
    [void]$panels.Append("<div class=""tab-panel"" id=""panel-overview"">$($ov.ToString())</div>")
    foreach($c in $B.Classes){
        $kpi = KpiRow $c ($unique | Where-Object { (Cell $_ $Col.cls) -eq $c.key })
        $detail = if($c.id -eq "delivery"){ Build-DeliveryPanel } else { Build-ClassPanel $c }
        [void]$panels.Append("<div class=""tab-panel"" id=""panel-$($c.id)"">$kpi`n$detail</div>")
    }
    $nowStr = (Get-Date).ToUniversalTime().AddHours(5.5).ToString('dd MMM yyyy, HH:mm') + " IST"
    $foot = "<footer><p><strong>Methodology:</strong> Aggregated from the raw ""$($B.SheetName)"" tab. Rows flagged ""Duplicate"" are excluded from per-class drill-downs (Overview shows both). Percentages use the sheet's own ""Total Sales M"" / ""Partner Allocation"" figures.</p><p>Auto-refreshed daily at 2 PM IST. Last updated $nowStr. No raw ticket-level PII is stored &mdash; all figures are aggregated segment counts.</p></footer>"
    $tabjs = "<script>document.querySelectorAll('.tab-btn').forEach(function(b){b.addEventListener('click',function(){document.querySelectorAll('.tab-btn').forEach(function(x){x.classList.remove('active');});document.querySelectorAll('.tab-panel').forEach(function(p){p.classList.remove('active');});b.classList.add('active');document.getElementById('panel-'+b.dataset.tab).classList.add('active');});});</script>"

    return @"
<title>$(HEnc $B.Title) Customer Query &mdash; Segment Report</title>
$head
<div class="wrap">
  <header class="hero">
    <div>
      <span class="badge">Customer Experience</span>
      <span class="badge">$(HEnc $B.Title)</span>
      <span class="badge">Updated $nowStr</span>
    </div>
    <h1>Customer Query Segment Report &mdash; $(HEnc $B.Title)</h1>
    <p>Source: "$(HEnc $B.SheetName)" tab &middot; $($totalRows.ToString('N0')) raw ticket rows, deduplicated to $($totalUnique.ToString('N0')) unique tickets</p>
  </header>
  <nav class="tab-nav">$nav</nav>
  $(Build-CsatPanel)
  $(Build-NpsPanel)
  $($panels.ToString())
  $(Build-ProdPkgPanel)
  $foot
</div>
$tabjs
"@
}
