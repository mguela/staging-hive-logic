// Command Center "Pulse" widget -- the money & watching stat tiles.
//
// Extracted from public/index.html on 2026-08-17, unchanged, alongside the
// layout engine. Loaded via <script src="/app-command-center-pulse.js"> at
// exactly the position the inline block occupied.
//
// Its own file rather than appended to app-command-center.js: the inline block
// sat ~590 lines further down the document than the engine, inside the widget
// markup, and merging the two would have moved this code earlier in the
// execution order for no benefit. Same reason it is not deferred.
//
// The markup it drives (#pg-fin and the .pg-tile grid) and its CSS both remain
// in index.html.

(function(){
  var COL={green:'61,204,138', amber:'244,178,64', red:'232,116,97', off:'138,146,166'};
  // ── Tunable targets + threshold bands live here so they can be adjusted in one place ──
  var PG_CFG={
    cash:    { runwayTargetWeeks:8,  green:8,  amber:4   },  // weeks of runway: green >8, amber 4-8, red <4
    profit:  { marginGoalPct:45,     green:40, amber:30  },  // gross margin %: green >=40, amber 30-40, red <30
    owed:    {                       green:10, amber:25  },  // past-due share %: green <10, amber 10-25, red >25
    incoming:{ pipelineGoal:450000,  green:60, amber:30  },  // % of pipeline goal: green >=60, amber 30-60, red <30
    ap:      { comfortCeiling:100000,green:50, amber:100 },  // % of ceiling: green <50, amber 50-100, red >100
    attn:    {                       green:10, amber:30  }   // unscheduled share %: green <10, amber 10-30, red >30
  };
  var LABEL={cash:'AVAILABLE CASH',profit:'PROFIT (YTD)',owed:'OWED TO YOU',incoming:'WORK COMING IN',ap:'OVERDUE TO VENDORS',attn:'JOBS NEEDING ATTENTION'};
  var JUMP={cash:'cash',profit:'profit',owed:'owed',incoming:'incoming'}; // ap + attn keep their non-clickable behavior
  var ORDER=['cash','profit','owed','incoming','ap','attn'];
  var st={}; // cross-fetch coordination state

  function pgK(n){ if(n==null||isNaN(n)) return '—'; var neg=n<0,a=Math.abs(n); var o=a>=1e6?(a/1e6).toFixed(1)+'M':a>=1e3?Math.round(a/1e3)+'K':Math.round(a).toString(); return (neg?'-$':'$')+o; }
  function band(id,m,lowerBetter){ var c=PG_CFG[id]; if(lowerBetter){ return m<c.green?'green':(m<=c.amber?'amber':'red'); } return m>=c.green?'green':(m>=c.amber?'amber':'red'); }
  function glowOf(k){ return k==='red'?1:(k==='amber'?.8:.6); }

  // One stat tile per metric: label, value, meter vs its target, status, context.
  // No SVG, no 40 tick marks, no sweep animation to schedule -- the meter's width
  // is a single CSS transition.
  var GLYPH={green:'\u2713',amber:'\u25B2',red:'\u25A0',off:'\u2013'}; // distinct per state, so state survives greyscale/CVD
  var STATE={green:'good',amber:'warn',red:'bad',off:'off'};
  function build(){
    var fin=document.getElementById('pg-fin'); if(!fin) return;
    ORDER.forEach(function(id){
      var t=document.createElement('div');
      t.className='pg-tile'+(JUMP[id]?' clickable':'');
      t.id='pg-'+id;
      t.setAttribute('data-state','off');
      if(JUMP[id]) t.setAttribute('onclick',"openDetail('"+JUMP[id]+"')");
      t.innerHTML='<div class="pg-title">'+LABEL[id]+'</div>'+
        '<div class="pg-val">\u2014</div>'+
        '<div class="pg-meterrow"><div class="pg-meter"><i style="width:0%"></i></div>'+
        '<span class="pg-pct">\u2014</span></div>'+
        '<span class="pg-st"><b>\u2013</b><span class="pg-stt">Loading\u2026</span></span>'+
        '<div class="pg-sub">Reading live data\u2026</div>';
      fin.appendChild(t);
    });
    if(window.ResizeObserver && !fin._pgRO){
      fin._pgRO = new ResizeObserver(function(){ pgSizeDials(); });
      fin._pgRO.observe(fin);
    }
  }
  // Kept as the module's public reflow hook (the Command Center layout engine and
  // the ResizeObserver both call it) even though the tiles are now pure CSS and
  // reflow themselves off the widget's container queries. It no longer measures
  // or resizes anything: the whole class of "the number does not fit the dial"
  // bug it existed to work around cannot occur in this design.
  function pgSizeDials(){ /* no measurement needed: the tile is CSS-only */ }
  window.addEventListener('resize', function(){ if(document.getElementById('pg-fin')) pgSizeDials(); });
  window.pgSizeDials = pgSizeDials;

  function apply(id,spec){
    var t=document.getElementById('pg-'+id); if(!t) return null;
    var val=t.querySelector('.pg-val'), fill=t.querySelector('.pg-meter > i'),
        pct=t.querySelector('.pg-pct'), glyph=t.querySelector('.pg-st b'),
        stt=t.querySelector('.pg-stt'), sub=t.querySelector('.pg-sub');
    if(!spec.connected){
      t.setAttribute('data-state','off');
      val.textContent='\u2014'; fill.style.width='0%'; pct.textContent='\u2014';
      glyph.textContent=GLYPH.off; stt.textContent='Not connected';
      sub.innerHTML=spec.sub||'Source unavailable';
      return null;
    }
    t.setAttribute('data-state',STATE[spec.key]||'off');
    val.textContent=spec.value;
    // The bar caps at 100% -- past the target it has nothing left to say -- while
    // the caption keeps telling the truth ("383% of ceiling"). A bar that grew
    // past its own track would be the lie.
    fill.style.width=Math.round(Math.min(Math.max(spec.frac,0),1)*100)+'%';
    pct.textContent=spec.pc;
    glyph.textContent=GLYPH[spec.key]||GLYPH.off;
    stt.textContent=spec.st;
    sub.innerHTML=spec.sub;
    return true;
  }
  function commit(id,spec,doSweep){
    // doSweep is kept in the signature: every caller passes it, and the meter's
    // CSS width transition is now the whole of the "first paint" animation.
    apply(id,spec);
  }
  function tryOwed(first){
    if(!(st.briefDone && st.snapDone)) return;
    if(st.totalAR==null || st.pastDue==null){ commit('owed',{connected:false,sub:'Receivables source unavailable'},first); }
    else {
      var share=st.totalAR>0? st.pastDue/st.totalAR*100 : 0;
      var key=band('owed',share,true);
      commit('owed',{connected:true,key:key,frac:Math.min(Math.max(share/100,0),1),value:pgK(st.totalAR),pc:Math.round(share)+'% PAST DUE',
        st:share<PG_CFG.owed.green?'HEALTHY':((st.pastDueCount||st.overdueCount||0)+' OVERDUE · CHASE'),
        sub:'<b>'+pgK(st.pastDue)+' past due</b> of '+pgK(st.totalAR)+' outstanding · Jobber'},first);
    }
    st.briefDone=st.snapDone=false;
  }
  function tryAttn(first){
    if(!(st.unschDone && st.jobsDone)) return;
    if(st.unsch==null || st.active==null){ commit('attn',{connected:false,sub:'Jobs source unavailable'},first); }
    else {
      var share=st.active>0? st.unsch/st.active*100 : 0;
      var key=band('attn',share,true);
      commit('attn',{connected:true,key:key,frac:Math.min(Math.max(share/100,0),1),value:st.unsch+'/'+st.active,pc:Math.round(share)+'% UNSCHED',
        // The label follows the SAME band as the colour. It used to be a bare
        // "is the count zero?", so 7 unscheduled out of 2774 jobs -- 0.25%, well
        // inside the green band -- showed a green tick next to the words "NEEDS
        // SCHEDULING". The tile told you it was fine and that you had work to do,
        // in the same breath. Three-way ladder like every other gauge here.
        st:st.unsch===0?'ALL SCHEDULED'
          :key==='green'?'ON TRACK'
          :key==='amber'?'NEEDS SCHEDULING'
          :'FALLING BEHIND',
        sub:st.unsch+' of '+st.active+' active jobs <b>unscheduled</b>'},first);
    }
    st.unschDone=st.jobsDone=false;
  }
  function J(u){ return fetch(u).then(function(r){ return r.json(); }); }
  function load(first){
    // CASH — dailybrief (existing runway calc)
    J('/api/track1?resource=dailybrief').then(function(d){
      if(!d||!d.ok) throw 0;
      if(d.cashRunway && d.cashRunway.runwayWeeks!=null && d.cash && d.cash.bankBalance!=null){
        var wk=d.cashRunway.runwayWeeks, key=band('cash',wk,false);
        var word=key==='green'?'HEALTHY':key==='amber'?'WATCH':'LOW';
        commit('cash',{connected:true,key:key,frac:Math.min(Math.max(wk/PG_CFG.cash.runwayTargetWeeks,0),1),value:pgK(d.cash.bankBalance),
          pc:Math.round(wk/PG_CFG.cash.runwayTargetWeeks*100)+'% OF TARGET',st:wk.toFixed(1)+' WK · '+word,
          sub:'Cash vs <b>8-wk overhead target</b> · QuickBooks'},first);
      } else commit('cash',{connected:false,sub:'Cash runway not available'},first);
      st.pastDue=d.pastDueInvoices?d.pastDueInvoices.sum:null; st.pastDueCount=d.pastDueInvoices?d.pastDueInvoices.count:0; st.briefDone=true; tryOwed(first);
    }).catch(function(){ commit('cash',{connected:false,sub:'Cash source unavailable'},first); st.pastDue=null; st.briefDone=true; tryOwed(first); });

    // PROFIT — qbo summary
    J('/api/qbo?resource=financials&kind=summary').then(function(d){
      if(!d||d.error) throw 0;
      var pnl=d.pnl_ytd||{}, margin=(pnl.gross_profit!=null&&pnl.total_income)?(pnl.gross_profit/pnl.total_income*100):null;
      if(margin!=null){ var key=band('profit',margin,false); var word=key==='green'?'ON TARGET':key==='amber'?'SLIPPING':'BELOW TARGET';
        commit('profit',{connected:true,key:key,frac:Math.min(Math.max(margin/PG_CFG.profit.marginGoalPct,0),1),value:margin.toFixed(1)+'%',
          pc:Math.round(margin/PG_CFG.profit.marginGoalPct*100)+'% OF GOAL',st:word,sub:'Gross margin vs <b>45% goal</b> · QuickBooks'},first);
      } else commit('profit',{connected:false,sub:'QuickBooks P&L unavailable'},first);
    }).catch(function(){ commit('profit',{connected:false,sub:'QuickBooks unavailable'},first); });

    // OWED total — snapshot (past-due share needs dailybrief too, see tryOwed)
    J('/api/snapshot').then(function(d){
      if(!d||!d.ok) throw 0;
      // The HTTP endpoint wraps the aggregate in `snapshot`; accepting the
      // direct aggregate too keeps this tile compatible with in-process/test
      // callers. Validate the AR object before dereferencing so a partial
      // response becomes an honest unavailable state, not a broken tile.
      var snapshot=d.snapshot||d;
      if(!snapshot.ar || snapshot.ar.outstanding==null) throw 0;
      st.totalAR=Number(snapshot.ar.outstanding);
      st.overdueCount=Number(snapshot.ar.overdueCount)||0;
      st.snapDone=true;
      tryOwed(first);
    }).catch(function(){ st.totalAR=null; st.snapDone=true; tryOwed(first); });

    // WORK COMING IN — quotes
    J('/api/track1?resource=quotes&limit=2000').then(function(d){
      if(!d||!d.ok) throw 0;
      var open=d.quotes.filter(function(q){ return q.status==='draft'||q.status==='awaiting_response'; });
      var sum=open.reduce(function(s,q){ return s+(Number(q.total)||0); },0);
      var pct=sum/PG_CFG.incoming.pipelineGoal*100, key=band('incoming',pct,false);
      var word=key==='green'?'PIPELINE HEALTHY':key==='amber'?'PIPELINE OK':'PIPELINE THIN';
      commit('incoming',{connected:true,key:key,frac:Math.min(Math.max(sum/PG_CFG.incoming.pipelineGoal,0),1),value:pgK(sum),
        pc:Math.round(pct)+'% OF GOAL',st:word,sub:open.length+' open quotes vs <b>$450K pipeline goal</b>'},first);
    }).catch(function(){ commit('incoming',{connected:false,sub:'Jobber quotes unavailable'},first); });

    // OVERDUE TO VENDORS — bills (cap dial at 100%, center % may exceed)
    J('/api/qbo?resource=financials&kind=bills_due_range&start_date=2000-01-01&end_date='+new Date().toISOString().slice(0,10)).then(function(d){
      if(!d||d.error) throw 0;
      var bills=d.bills||[], bal=d.total_balance||0, pct=bal/PG_CFG.ap.comfortCeiling*100, key=band('ap',pct,true);
      var word=key==='green'?'OK':key==='amber'?'ELEVATED':'HIGH';
      commit('ap',{connected:true,key:key,frac:Math.min(Math.max(bal/PG_CFG.ap.comfortCeiling,0),1),value:pgK(bal),
        pc:Math.round(pct)+'% OF CEILING',st:bills.length+' BILLS · '+word,sub:'Unpaid vendor bills vs <b>$100K comfort ceiling</b>'},first);
    }).catch(function(){ commit('ap',{connected:false,sub:'QuickBooks bills unavailable'},first); });

    // JOBS NEEDING ATTENTION — watching_unscheduled + jobs total
    J('/api/track1?resource=watching_unscheduled').then(function(d){ if(!d||!d.ok) throw 0; st.unsch=d.count; st.unschDone=true; tryAttn(first); })
      .catch(function(){ st.unsch=null; st.unschDone=true; tryAttn(first); });
    J('/api/jobs?limit=500').then(function(d){ if(!d||!d.ok) throw 0; st.active=(d.totalCount!=null?d.totalCount:(d.jobs?d.jobs.length:null)); st.jobsDone=true; tryAttn(first); })
      .catch(function(){ st.active=null; st.jobsDone=true; tryAttn(first); });
  }

  function boot(){
    build();
  }
  // Refresh cadence belongs to index.html's single Command Center poller.
  // This module only builds and exposes its loader; it owns no interval and
  // therefore cannot keep fetching after the user leaves Command Center.
  window.pgReload=function(){ load(false); };
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
