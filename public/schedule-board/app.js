/* HiveLogic Schedule Lab — Day / Week / Month / Gantt (local-only, no network) */
(function () {
  const { techs, visits, projects, unassigned, demands, STATUS, KINDS, config, LENS, DIVCOLORS, DIVISIONS, WEEK, TODAY, SIM_NOW } = window.LAB;
  const RDY = { ready:{l:'READY',c:'ready'}, at_risk:{l:'AT RISK',c:'at_risk'}, blocked:{l:'BLOCKED',c:'blocked'} };
  const DAY_START = 6, DAY_END = 19, SPAN = DAY_END - DAY_START;
  const GANTT = ['2026-08-03','2026-08-04','2026-08-05','2026-08-06','2026-08-07','2026-08-08','2026-08-09','2026-08-10','2026-08-11','2026-08-12','2026-08-13'];

  const ME = 'dave'; // demo "my schedule" user
  const state = {
    view: 'day', date: TODAY, filter: 'all', division: 'all', scope: 'company', focusProject: null, hidden: new Set(),
    freezeOn: true, unOpen: true, peopleOpen: false, undo: null, role: 'dispatcher', filtersOpen: false, lensBarOpen: false,
    lenses: { materials:false, money:false, assets:false, compliance:false, weather:false, subs:false },
    layersOpen: false,
    controlMode: 'mirror',   // mirror | planning | live  (Rule 2)
    scenario: { changes: [] }, // staged plan (Rule 4)
    changeRequests: [],      // requests from non-dispatch roles → Dispatch queue
    mapTimer:null,           // live GPS poll handle (was the simulation's play clock)
    mapBg:true,              // live map behind the Day/Week calendar -- ON by default
    mbBg:  {map:null,markers:{},ready:false}, // Mapbox instance for the Day background
    mbView:{map:null,markers:{},ready:false}, // Mapbox instance for the full Map tab
    mlView:{map:null,markers:{},ready:false}, // keyless MapLibre — full Map tab
    mlBg:  {map:null,markers:{},ready:false}, // keyless MapLibre — Day backdrop
    mapPeriod:'day',         // what the Map tab plots: the viewed day, or its whole week
  };
  // restore view/date across a post-write reload
  try{ const _s=JSON.parse(sessionStorage.getItem('hl_bstate')||'null'); if(_s){ if(_s.date)state.date=_s.date; if(_s.view)state.view=_s.view; sessionStorage.removeItem('hl_bstate'); } }catch(e){}
  // reload the board after a native write (create/clock/chain), keeping where you are
  window.hlReload=()=>{ try{ sessionStorage.setItem('hl_bstate', JSON.stringify({date:state.date,view:state.view})); }catch(e){} location.reload(); };

  /* ---- durable view state (2026-08-15) ----------------------------------
     The sessionStorage hop above only survives one write-triggered reload and
     then deletes itself, so leaving the Schedule tab and coming back always
     dropped you on Day / all filters / no lenses. This keeps the DISPLAY state
     across sessions in localStorage.

     Stored: which view, the filters, role, which panels are open, which lenses
     are on, which people are hidden, the map's period, and the map camera.
     Deliberately NOT stored: state.date (coming back tomorrow to a board parked
     on last Thursday is worse than defaulting to today), and anything transient
     -- open modals, undo, the staged scenario, the map's play clock.

     Saving hangs off render(), which every state change already funnels
     through, rather than off twenty individual toggles that would drift. */
  const BSTATE_KEY = 'hl_board_view_state';
  const BSTATE_VIEWS = ['day','week','month','gantt','map'];
  function boardStateSnapshot(){
    var cam = null;
    try {
      var m = state.mbView.map || state.mlView.map;
      if(m){ var c=m.getCenter(); cam = { lng:+c.lng.toFixed(6), lat:+c.lat.toFixed(6), zoom:+m.getZoom().toFixed(2), bearing:+m.getBearing().toFixed(1), pitch:+m.getPitch().toFixed(1) }; LAST_CAM = cam; }
      else cam = LAST_CAM;   // map torn down (left the Map tab) -- keep what it last was
    } catch(e){}
    return {
      v: 1,
      view: state.view, filter: state.filter, division: state.division, scope: state.scope,
      role: state.role, controlMode: state.controlMode,
      filtersOpen: state.filtersOpen, lensBarOpen: state.lensBarOpen, layersOpen: state.layersOpen,
      lenses: state.lenses, hidden: Array.from(state.hidden || []),
      mapBg: state.mapBg, mapPeriod: state.mapPeriod,
      cam: cam || LAST_CAM || (BSTATE_BOOT && BSTATE_BOOT.cam) || null
    };
  }
  let _bstateTimer=null;
  function boardStateSave(immediate){
    if(_bstateTimer){ clearTimeout(_bstateTimer); _bstateTimer=null; }
    const write=()=>{ _bstateTimer=null; try{ localStorage.setItem(BSTATE_KEY, JSON.stringify(boardStateSnapshot())); }catch(e){} };
    if(immediate) write(); else _bstateTimer=setTimeout(write, 400);
  }
  // Last camera we saw, kept across a map teardown so leaving the Map tab does
  // not wipe the position the user just set.
  let LAST_CAM = null;
  const BSTATE_BOOT = (function(){ try{ const o=JSON.parse(localStorage.getItem(BSTATE_KEY)||'null'); return (o&&typeof o==='object')?o:null; }catch(e){ return null; } })();
  function boardStateRestore(){
    const b = BSTATE_BOOT; if(!b) return;
    if(b.cam) LAST_CAM = b.cam;
    try {
      if(b.view && BSTATE_VIEWS.indexOf(b.view)!==-1) state.view=b.view;
      ['filter','division','scope','controlMode'].forEach((k)=>{ if(typeof b[k]==='string') state[k]=b[k]; });
      if(typeof b.role==='string') state.role=b.role;
      ['filtersOpen','lensBarOpen','layersOpen','mapBg'].forEach((k)=>{ if(typeof b[k]==='boolean') state[k]=b[k]; });
      if(b.lenses && typeof b.lenses==='object'){ Object.keys(state.lenses).forEach((k)=>{ if(typeof b.lenses[k]==='boolean') state.lenses[k]=b.lenses[k]; }); }
      if(Array.isArray(b.hidden)) state.hidden=new Set(b.hidden);
      if(b.mapPeriod==='day'||b.mapPeriod==='week') state.mapPeriod=b.mapPeriod;
      // a post-write reload (hl_bstate) is more specific than the durable blob -- it wins
      const s2=JSON.parse(sessionStorage.getItem('hl_bstate')||'null');
      if(s2 && s2.view) state.view=s2.view;
    } catch(e){}
    // the filters panel is CSS-hidden by default; match it to the restored flag
    try{ const fw=document.getElementById('filtersWrap'); if(fw) fw.classList.toggle('hidden', !state.filtersOpen); }catch(e){}
  }
  // A pending debounced write must not be lost when the tab closes or backgrounds.
  window.addEventListener('pagehide', ()=>boardStateSave(true));
  document.addEventListener('visibilitychange', ()=>{ if(document.hidden) boardStateSave(true); });
  // Only these roles can change the schedule directly; everyone else must request it.
  const EDIT_ROLES=['owner','dispatcher'];
  const canEdit=()=>EDIT_ROLES.indexOf(state.role)!==-1;
  // inside vs outside work (per-event override, else outdoor divisions are outside)
  function exposureOf(v){ return v.exposure || (['Outdoor Spaces','Building'].indexOf(v.div)!==-1 ? 'outside' : 'inside'); }
  // Icon = the trade/division; color = the person (below). Icons chosen to read at a glance.
  const DIVICON={'Handyman':'🔨','Electric':'🔌','Plumbing':'🔧','HVAC':'🌡️','Outdoor Spaces':'🌲','Home Concierge':'🛎️','Design | Build':'📐','Building':'🏗️','GH Co.':'🏢'};
  function cardIcon(v){ const k=v.kind||'field'; const kd=KINDS[k]; if(!kd||k==='field'||k==='service') return DIVICON[v.div]||'🛠️'; return kd.ic; } // trade work → division icon; other appt kinds → kind icon
  function personColor(v){ const t=techById(effectiveTech(v))||techById(v.t); return t?t.pc:'#8b92a8'; }
  const outIcon = (v)=> exposureOf(v)==='outside' ? '🌦️' : '🏠';
  // Two weather-risk kinds: travel (ice/flood/slick → ALL jobs) and exposure (rain/snow/heat/cold/wind → OUTSIDE work in the window)
  function weatherRiskFor(v){
    const wx=LENS.weather[v.date]; if(!wx) return null;
    if(wx.travelRisk>=SETUP.wxTravel) return {kind:'travel', why:'Travel risk · '+wx.cond+' '+wx.travelRisk+'%'};
    const from=wx.riskFrom||0;
    if(exposureOf(v)==='outside' && wx.exposureRisk>=SETUP.wxExposure && v.e>from) return {kind:'exposure', why:wx.cond+' · '+wx.exposureRisk+'%'};
    return null;
  }
  function weatherAffected(date){ return visits.filter((v)=>v.date===date && v.status!=='done' && weatherRiskFor(v)); }
  // ---- SETUP / settings (what a real company configures) ----
  const SETUP = {
    colorBy:'person',            // person | division | status
    businessStart:6, businessEnd:19, weekStart:'Sun', tz:'America/New_York',
    freezeMin:60, overtimeH:8, defaultDur:2, travelBuffer:15,
    wxExposure:50, wxTravel:50, wxAutoNotify:true,
    conflicts:{ person:'block', travel:'warn', skill:'block', materials:'warn', overtime:'warn' },
    readiness:{ customer:true, permit:true, materials:true, sub:true, inspection:true, deposit:false, equipment:true, predecessor:true, weather:true },
    approval:{ aiCall:true, portal:true, sms:true, email:true },
    automation:'suggest',        // observe | suggest | stage | auto
    money:{ owner:true, dispatch:true, pm:false, sales:false, field:false }
  };
  function colorFor(v){
    if(SETUP.colorBy==='division') return DIVCOLORS[v.div]||personColor(v);
    if(SETUP.colorBy==='status') return (STATUS[v.status]?STATUS[v.status].c:personColor(v));
    return personColor(v);
  }
  // Rule 5: readiness — one status per event, strongest wins (blocked > at_risk > ready)
  function readinessOf(v){
    if(v.blockers && v.blockers.length) return {level:'blocked', why:v.blockers[0]};
    const risks=[];
    const wr=weatherRiskFor(v); if(wr) risks.push(wr.why);
    if(v.jobNo && LENS.materials[v.jobNo] && LENS.materials[v.jobNo].status==='awaiting') risks.push('Materials not received');
    const kd=KINDS[v.kind||'field'];
    if(kd&&kd.clientFacing && v.confirm==='unconfirmed' && v.source!=='jobber') risks.push('Customer not confirmed');
    if(risks.length) return {level:'at_risk', why:risks[0]};
    return {level:'ready', why:''};
  }
  // Explains the symbols actually present on THIS job (shown in the detail popup)
  function iconLegendFor(v){
    const rows=[]; const kd=KINDS[v.kind||'field']; const r=readinessOf(v); const t=techById(effectiveTech(v))||techById(v.t);
    rows.push(`<span class="ck" style="background:${personColor(v)}"></span> <b>Color = ${t?t.n:'crew'}</b> — colored by the assigned person`);
    rows.push(`${cardIcon(v)} <b>${v.div}</b> — the icon = the trade / division`);
    rows.push(exposureOf(v)==='outside'?'🌦️ <b>Outside</b> — weather-exposed work':'🏠 <b>Inside</b> work');
    rows.push(`<span class="rpill ${r.level}">${RDY[r.level].l}</span> ${r.why||'good to start'} <span style="color:var(--mut)">— readiness (bottom line)</span>`);
    rows.push(v.source==='jobber'?'🔒 <b>From Jobber</b> — read-only here (edit in Jobber, or make an override)':'⬡ <b>HiveLogic</b> — editable here');
    if(kd&&kd.clientFacing) rows.push(v.confirm==='confirmed'?'✓ <b>Confirmed</b> by the client':'⌛ <b>Awaiting</b> client confirmation');
    if(v.pinned) rows.push('📌 <b>Pinned</b> — do not move');
    if(v.override && isRemoved(v)) rows.push('🗑 <b>Proposed removal</b> — a HiveLogic plan to take this off the board, Jobber untouched until Live');
    else if(v.override) rows.push('▪ <b>Proposed change</b> — a HiveLogic override of the Jobber time');
    rows.push(`Status: <b>${STATUS[v.status]?STATUS[v.status].l:v.status}</b> · type: <b>${kd.l}</b>`);
    return `<div class="iconkey"><div class="ikh">What the marks on this job mean</div>${rows.map((x)=>'<div>'+x+'</div>').join('')}</div>`;
  }
  // Rule 1+2: the effective time of a Jobber event depends on control mode + any override
  function effectiveStart(v){ return (v.override && state.controlMode==='live') ? v.override.s : v.s; }
  function effectiveEnd(v){ return (v.override && state.controlMode==='live') ? v.override.e : v.e; }
  function effectiveTech(v){ return (v.override && state.controlMode==='live') ? v.override.t : v.t; }
  // 2026-08-25: "remove the schedule" for a Jobber-mirrored job -- same
  // proposed/effective duality as a time override (this file never writes to
  // Jobber, see the header comment), except there is no new time/tech to
  // show, the visit just stops existing once the crew is HiveLogic Live.
  // isRemoved(v) alone means "proposed" (still shown, flagged); combined
  // with controlMode==='live' it means "actually gone" (excluded from every
  // board computation via dayVisits below, the single choke point).
  function isRemoved(v){ return !!(v.override && v.override.removed); }
  function isEffectivelyRemoved(v){ return isRemoved(v) && state.controlMode==='live'; }
  // Rule 4: stage a change into the scenario plan instead of firing notifications per drag
  function stageChange(label, apply, undo){
    apply(); state.scenario.changes.push({label, undo}); render();
  }
  const LENS_META = {
    materials:{ic:'📦', l:'Materials'}, money:{ic:'💵', l:'Money'}, assets:{ic:'🚚', l:'Assets'},
    compliance:{ic:'📋', l:'Compliance'}, weather:{ic:'🌦️', l:'Weather'},
    subs:{ic:'🤝', l:'Subs'}
  };
  const anyLens = () => Object.keys(state.lenses).some((k)=>state.lenses[k]);

  // ---- date helpers ----
  const DOW = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'], MO = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  function parseYMD(s){ const p=s.split('-').map(Number); return new Date(p[0],p[1]-1,p[2]); }
  function ymd(d){ return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }
  function addDays(s,n){ const d=parseYMD(s); d.setDate(d.getDate()+n); return ymd(d); }
  function weekDaysOf(s){ const dow=(parseYMD(s).getDay()+6)%7; const mon=addDays(s,-dow); const out=[]; for(let i=0;i<7;i++)out.push(addDays(mon,i)); return out; } // Mon..Sun of s's week
  function dLabel(s){ const d=parseYMD(s); return DOW[d.getDay()]+', '+MO[d.getMonth()]+' '+d.getDate(); }

  // ---- misc helpers ----
  const cssVar = (n) => parseFloat(getComputedStyle(document.documentElement).getPropertyValue(n));
  const HRW = () => cssVar('--hr-w'), RAILW = () => cssVar('--rail-w');
  const snap = (h) => Math.round(h * 4) / 4;
  const clampHr = (h, dur) => Math.max(DAY_START, Math.min(h, DAY_END - dur));
  function fmt(h){ let hh=Math.floor(h),mm=Math.round((h-hh)*60); if(mm===60){mm=0;hh++;} const ap=hh<12?'a':'p'; let d=hh%12; if(d===0)d=12; return d+(mm?':'+String(mm).padStart(2,'0'):'')+ap; }
  const techById = (id) => techs.find((t) => t.id === id);
  function visibleTechs(){
    let list = techs.slice();
    // Subcontractor rows are the Subs layer. Off by default and gone entirely
    // when off -- not greyed, not collapsed -- because the whole reason this is
    // a layer is that a dispatcher looking at their own crews does not want
    // other companies' work in the way. The one exception is the Subs filter,
    // where hiding them would empty the board the user just asked for.
    if(!state.lenses.subs && state.filter!=='subs') list=list.filter((t)=>!t.external);
    if (state.filter==='crews') list=list.filter((t)=>t.lens==='crew');
    else if (state.filter==='office') list=list.filter((t)=>t.lens==='office');
    else if (state.filter==='subs') list=list.filter((t)=>t.lens==='sub');
    else if (state.filter==='equipment') list=[]; // no equipment resources seeded yet
    if (state.division!=='all') list=list.filter((t)=>t.div===state.division);
    if (state.scope==='mine') list=list.filter((t)=>t.id===ME);
    list = list.filter((t)=>!state.hidden.has(t.id));
    // Your people, then subs. Never interleaved: a sub row sitting between two
    // of your crews reads as one of your crews.
    const mine = list.filter((t)=>!t.external), theirs = list.filter((t)=>t.external);
    if(theirs.length) theirs[0].firstExternal = true;   // the divider hangs off this row
    mine.concat(theirs).forEach((t)=>{ if(!t.external) t.firstExternal = false; });
    return mine.concat(theirs);
  }
  const projectFor = (v) => v&&v.jobNo ? projects.find((p)=>p.id===String(v.jobNo)) : null;
  function visibleProjects(){ return state.division==='all' ? projects : projects.filter((p)=>p.division===state.division); }
  const dayVisits = (id, date) => visits.filter((v)=>v.date===(date||state.date) && effectiveTech(v)===id && !isEffectivelyRemoved(v));
  function conflictInfo(id, date){
    const vs=dayVisits(id,date).slice().sort((a,b)=>a.s-b.s); const bad=new Set(),zones=[];
    for(let i=0;i<vs.length;i++)for(let j=i+1;j<vs.length;j++)
      if(vs[i].s<vs[j].e&&vs[j].s<vs[i].e){bad.add(vs[i].id);bad.add(vs[j].id);zones.push({s:Math.max(vs[i].s,vs[j].s),e:Math.min(vs[i].e,vs[j].e)});}
    return {bad,zones};
  }
  const hoursFor = (id,date) => dayVisits(id,date).reduce((a,v)=>a+(v.e-v.s),0);

  // Field "My Day" execution state
  const MYDAY_TECH = 'sami';
  function execOf(v){ if(v.exec) return v.exec; if(v.status==='done')return 'completed'; if(v.status==='onsite')return 'on_site'; if(v.status==='traveling')return 'en_route'; return 'not_started'; }

  // ---- master render ----
  function render(){
    boardStateSave();   // every state change funnels through render(); debounced 400ms
    const field = state.role==='field';
    document.body.classList.toggle('fieldmode', field);
    document.getElementById('roleSel').value=state.role;
    if(field){ renderMyDay(); return; }
    document.querySelectorAll('#viewtabs .vt').forEach((b)=>b.classList.toggle('on', b.getAttribute('data-v')===state.view));
    document.getElementById('daynav').style.display = (state.view==='day' || state.view==='map') ? '' : 'none';
    renderDayLabel(); renderPeople(); renderUnassigned(); renderLensBar(); renderWeatherBanner(); renderAdvisor(); renderLayers(); renderScenarioBar(); renderWxWidget(); renderReinaBar(); renderReqBtn(); renderRechain();
    document.getElementById('modeSel').value=state.controlMode;
    document.getElementById('roleSel').value=state.role;
    document.getElementById('scopeFilter').value=state.scope;
    document.getElementById('divFilter').value=state.filter;
    document.getElementById('divisionFilter').value=state.division;
    const hint=document.getElementById('viewhint');
    const hints={ week:'📅 Week · crew rows × 7 days. Tap a chip to open it in Day view. (Replaces the old Operations week board.)',
      month:'🗓️ Month · roll-up of every dated job. Tap a day to open it. (Replaces the “Company · everything on one timeline” lens.)',
      gantt:'📊 Jobs · Gantt · renovation projects by phase (demo → rough-in → tile → final). The estimate’s schedule of values, now on the schedule.',
      map:'🗺 Map · real vehicle GPS, refreshed every 60s. Crews without a tracked vehicle (or without a recent fix) are not drawn rather than guessed at.' };
    hint.classList.toggle('hidden', !hints[state.view]); if(hints[state.view]) hint.textContent=hints[state.view];
    if(state.view!=='map'){
      ['mbView','mlView'].forEach((k)=>{ if(state[k].map){ try{ state[k].map.remove(); }catch(e){} state[k]={map:null,markers:{},ready:false}; } }); }
    if(state.view==='day') renderDay();
    else if(state.view==='week') renderWeek();
    else if(state.view==='month') renderMonth();
    else if(state.view==='map') renderMap();
    else renderGantt();
    sizeBoardViewport();
    const _bgBtn=document.getElementById('mapBgBtn');
    if(_bgBtn){ _bgBtn.classList.toggle('on', state.mapBg); _bgBtn.style.display=(state.view==='day'||state.view==='week')?'':'none'; }
    renderMapBg();   // live map behind the Day/Week calendar
    queueBoardViewport();   // re-measure once this render has actually laid out
    syncMapTimer();  // keep the shared clock running iff Play or the city background is on
    renderSummary();
  }

  // The board scrolls inside itself rather than scrolling the page -- that is what
  // makes the sticky hour/day header rows actually stick, since position:sticky
  // resolves against the nearest SCROLLING ancestor and .boardscroll previously
  // only scrolled horizontally. The height is measured from where the board
  // actually starts, so it tracks however tall the toolbars above it end up.
  let _sizeQueued = false;
  function queueBoardViewport(){
    if(_sizeQueued) return;
    _sizeQueued = true;
    requestAnimationFrame(()=>{ _sizeQueued = false; sizeBoardViewport(); });
  }
  function sizeBoardViewport(){
    const w=document.querySelector('.wrap'); if(!w) return;
    const top=w.getBoundingClientRect().top + (window.scrollY||0) - (window.scrollY||0);
    // Everything that still sits BELOW the board in the page flow (the legend,
    // for one) has to come out of the board's height, or the document ends up
    // taller than the window and the browser adds a second, outer scrollbar on
    // top of the board's own. Only the board should scroll.
    let below = 0;
    for (let el = w.nextElementSibling; el; el = el.nextElementSibling){
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.position === 'fixed' || cs.position === 'absolute') continue;
      below += el.offsetHeight;
    }
    // The mobile header wraps onto several lines. Keeping the desktop 260px
    // floor there can make the board taller than the space that is actually
    // left (and creates a second, document-level scrollbar). A 160px mobile
    // floor still leaves a useful scroll target while letting the board fit.
    const minH=window.matchMedia('(max-width:760px)').matches?160:260;
    const h=Math.max(minH, Math.round(window.innerHeight - top - below - 4));
    if(document.documentElement.style.getPropertyValue('--board-h') !== h+'px'){
      document.documentElement.style.setProperty('--board-h', h+'px');
    }

    // The Unscheduled / Layers panels are siblings inside .wrap, so the map
    // layer and its control cluster -- both absolutely positioned against .wrap
    // -- would sit underneath them. Reserve their width. On mobile they become
    // fixed overlays, which float above the map rather than taking layout space,
    // so those are excluded.
    let side = 0;
    ['unpanel', 'layerspanel'].forEach((id)=>{
      const el=document.getElementById(id); if(!el) return;
      const cs=getComputedStyle(el);
      if(cs.display === 'none' || cs.position === 'fixed') return;
      side += el.offsetWidth;
    });
    document.documentElement.style.setProperty('--side-w', side+'px');
  }
  window.addEventListener('resize', sizeBoardViewport);

  // A panel can open without a full render -- clicking the "unscheduled" stat
  // calls renderUnassigned() on its own -- and then nothing re-measured, so
  // --side-w stayed at 0 and the map controls drew straight over the panel.
  // Watch the panels themselves so every path that opens or closes one, now or
  // later, re-measures. Reserving their width doesn't resize them, so this
  // can't feed back on itself.
  if(window.ResizeObserver){
    const ro=new ResizeObserver(()=>queueBoardViewport());
    ['unpanel','layerspanel'].forEach((id)=>{ const el=document.getElementById(id); if(el) ro.observe(el); });
  }

  function renderDayLabel(){
    const el=document.getElementById('dayLabel');
    el.innerHTML = dLabel(state.date) + (state.date===TODAY ? ' <span class="today-pill">TODAY</span>' : '');
    document.getElementById('todayBtn').style.display = state.date===TODAY ? 'none' : '';
  }

  function renderSummary(){
    const strip=document.getElementById('sumstrip');
    if(state.view==='map'){
      const shown=visibleTechs();
      const moving=shown.filter((t)=>{ const p=liveTruckPos(t.id); return p && p.moving; }).length;
      // "crews tracked" used to count every visible crew, because the simulation
      // always had a position for all of them. It now counts real fixes.
      const c=gpsCounts();
      strip.innerHTML=`<div class="stat"><b>${c.live}</b><span class="lbl">crews tracked${c.live!==c.shown?` of ${c.shown}`:''}</span></div><div class="stat"><b>${moving}</b><span class="lbl">🚚 on the move</span></div><div class="stat"><b>${c.stale}</b><span class="lbl">stale fix</span></div><div class="stat click" onclick="LabUI.toggleUnassigned(true)"><b>${demands.length}</b><span class="lbl">unscheduled</span></div>`;
      return;
    }
    if(state.view==='gantt'){
      const projs=visibleProjects();
      const total=projs.reduce((a,p)=>a+p.value,0);
      strip.innerHTML=`<div class="stat"><b>${projs.length}</b><span class="lbl">active projects</span></div>`+
        `<div class="stat"><b>$${(total/1000).toFixed(0)}k</b><span class="lbl">contract value</span></div>`+
        `<div class="stat click" onclick="LabUI.toggleUnassigned(true)"><b>${unassigned.length}</b><span class="lbl">unassigned</span></div>`;
      return;
    }
    const shown=visibleTechs();
    if(state.view==='day'){
      let blocked=0,atrisk=0,unconf=0,cv=0; const seenJobs=new Set();
      shown.forEach((t)=>{ cv+=conflictInfo(t.id).bad.size?1:0; dayVisits(t.id).forEach((v)=>{ if(seenJobs.has(v.vid))return; seenJobs.add(v.vid); const r=readinessOf(v); if(r.level==='blocked')blocked++; else if(r.level==='at_risk')atrisk++; const kd=KINDS[v.kind||'field']; if(kd&&kd.clientFacing&&v.confirm==='unconfirmed'&&v.source!=='jobber')unconf++; }); });
      const jobs=seenJobs.size;
      const hrs=shown.reduce((a,t)=>a+hoursFor(t.id),0);
      const util=shown.length?Math.round(Math.min(hrs/(shown.length*8),1)*100):0;
      strip.innerHTML=
        `<div class="attnlabel">NEEDS ATTENTION</div>`+
        `<div class="stat click ${blocked?'warn':''}" onclick="LabUI.filterReadiness('blocked')"><b>${blocked}</b><span class="lbl">⛔ blocked</span></div>`+
        `<div class="stat click" onclick="LabUI.filterReadiness('at_risk')"><b>${atrisk}</b><span class="lbl">⚠ at&nbsp;risk</span></div>`+
        `<div class="stat click" onclick="LabUI.toggleUnassigned(true)"><b>${demands.length}</b><span class="lbl">📋 unscheduled</span></div>`+
        `<div class="stat click" onclick="LabUI.filterReadiness('unconf')"><b>${unconf}</b><span class="lbl">⌛ unconfirmed</span></div>`+
        `<div class="stat click ${cv?'warn':''}" onclick="LabUI.flashConflicts()"><b>${cv}</b><span class="lbl">conflicts</span></div>`+
        `<div class="stat sub"><b>${jobs}</b><span class="lbl">jobs</span></div>`+
        `<div class="stat sub"><b>${util}%</b><span class="lbl">util</span></div>`;
    } else {
      const wkDays=weekDaysOf(state.date);
      const wk=visits.filter((v)=>wkDays.indexOf(v.date)>=0 && shown.some((t)=>t.id===v.t));
      const jobsN=new Set(wk.map((v)=>v.vid)).size;
      const hrs=wk.reduce((a,v)=>a+(v.e-v.s),0);
      const util=shown.length?Math.round(Math.min(hrs/(shown.length*5*8),1)*100):0;
      strip.innerHTML=
        `<div class="stat"><b>${jobsN}</b><span class="lbl">jobs this week</span></div>`+
        `<div class="stat"><b>${util}%</b><span class="lbl">week utilization</span></div>`+
        `<div class="stat click" onclick="LabUI.toggleUnassigned(true)"><b>${unassigned.length}</b><span class="lbl">unassigned</span></div>`+
        `<div class="stat"><b>${shown.length}</b><span class="lbl">crew shown</span></div>`;
    }
  }

  function renderPeople(){
    const bar=document.getElementById('pplbar');
    bar.classList.toggle('hidden', !state.peopleOpen);
    if(!state.peopleOpen) return;
    bar.innerHTML=techs.map((t)=>`<span class="pchip ${state.hidden.has(t.id)?'off':''}" onclick="LabUI.togglePerson('${t.id}')"><span class="av" style="background:${t.pc}">${t.ini}</span>${t.n}<small>${t.crew}</small></span>`).join('')+`<span class="pchip" onclick="LabUI.showAll()">Show everyone</span>`;
  }

  // ---- LENS filter bar + layers ----
  function renderLensBar(){
    const bar=document.getElementById('lensbar');
    const counts={ materials:Object.keys(LENS.materials).length, money:Object.keys(LENS.money).length,
      assets:Object.values(LENS.assets).filter((v)=>v&&v!=='—').length, compliance:LENS.compliance.length, weather:7 };
    const active=Object.keys(state.lenses).filter((k)=>state.lenses[k]).length;
    if(!state.lensBarOpen){
      // Readiness leads; lenses are advanced, collapsed behind one button (Grok)
      bar.innerHTML=`<button class="lchip-t ${active?'on':''}" onclick="toggleLensBar()">▤ Layers${active?' · '+active+' on':''}</button>`
        +(active?Object.keys(state.lenses).filter((k)=>state.lenses[k]).map((k)=>`<button class="lchip-t on" onclick="toggleLens('${k}')">${LENS_META[k].ic} ${LENS_META[k].l} ✕</button>`).join(''):'<span class="ll" style="align-self:center">Cards already show READY / AT RISK / BLOCKED — add a layer only for detail</span>');
      return;
    }
    // A layer with no source behind it reads as "0 today" when the truth is
    // "nothing feeds this yet". Say which, rather than letting an empty layer
    // look like an empty day.
    const src=window.HL_LENS_SOURCES||{};
    bar.innerHTML='<button class="lchip-t on" onclick="toggleLensBar()">▤ Layers ▾</button>'+Object.keys(LENS_META).map((k)=>{
      const m=LENS_META[k];
      const wired=src[k]!=='not-wired';
      if(!wired) return `<button class="lchip-t" disabled title="No data source is connected for this layer yet — it is not that today is empty." style="opacity:.45;cursor:not-allowed">${m.ic} ${m.l}<span class="n">—</span></button>`;
      return `<button class="lchip-t ${state.lenses[k]?'on':''}" onclick="toggleLens('${k}')">${m.ic} ${m.l}<span class="n">${counts[k]}</span></button>`;
    }).join('')+(anyLens()?'<button class="lchip-t" onclick="clearLenses()" style="border-style:dashed">clear</button>':'');
  }
  // Advisory flags for the day on screen. Read-only by design (schedule plan,
  // design law 1): it says what looks wrong and why, and a human decides. It
  // never moves a visit, and the board behaves identically if advisor.js fails
  // to load -- hence the guard rather than an assumption it is there.
  function renderAdvisor(){
    const el=document.getElementById('advbanner'); if(!el) return;
    const adv=window.HLAdvisor;
    if(!adv || state.view!=='day'){ el.classList.add('hidden'); el.innerHTML=''; return; }
    const byTech={};
    visits.filter((v)=>v.date===state.date && v.status!=='done' && !v.chained)
      .forEach((v)=>{ (byTech[v.t]=byTech[v.t]||[]).push(v); });
    const all=[];
    Object.keys(byTech).forEach((tid)=>{
      const t=techById(tid);
      adv.flagsForDay(byTech[tid], { travelBuffer:SETUP.travelBuffer, overtimeH:SETUP.overtimeH })
        .forEach((f)=>all.push(Object.assign({ who: t?t.n:'Crew' }, f)));
    });
    if(!all.length){ el.classList.add('hidden'); el.innerHTML=''; return; }
    const rank={high:0,medium:1,low:2};
    all.sort((a,b)=>rank[a.severity]-rank[b.severity]);
    const esc=(s)=>String(s==null?'':s).replace(/[&<>"']/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    el.classList.remove('hidden');
    el.innerHTML='<span class="ll" style="align-self:center;font-size:9px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:var(--mut)">Worth a look</span>'
      +all.slice(0,6).map((f)=>`<div class="af ${f.severity}"><b>${esc(f.who)} — ${esc(f.title)}</b>${f.reasons.map((r)=>`<span>${esc(r)}</span>`).join('')}</div>`).join('');
  }
  function renderWeatherBanner(){
    const b=document.getElementById('wxbanner');
    const wx=LENS.weather[state.date];
    const show=state.lenses.weather && state.view==='day' && wx && wx.rain;
    b.classList.toggle('hidden', !show);
    if(show) b.innerHTML=`${wx.ic} <b>${dLabel(state.date)} · ${wx.t}</b> — ${wx.note||'Rain'} <span style="margin-left:auto;color:var(--mut);font-weight:600">Weather layer · consider pulling exterior work forward</span>`;
  }
  // Techs who took themselves off a job. Dispatch sees this until they either put
  // the person back on it or close the request; nothing auto-resolves.
  function renderRechain(){
    const el=document.getElementById('rechainbanner'); if(!el) return;
    const reqs=(window.HL_RECHAIN||[]);
    if(!canEdit() || !reqs.length){ el.innerHTML=''; return; }
    const esc=(s)=>String(s==null?'':s).replace(/[&<>"']/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const nameOf=(jid)=>{ const t=(LAB.techs||[]).find((x)=>x.jid&&String(x.jid)===String(jid)); return t?t.n:'Someone'; };
    const jobOf=(id)=>{ const v=visits.find((x)=>x.vid===id); return v?(v.client+' · '+v.type):('job '+String(id).slice(-6)); };
    el.innerHTML=`<div class="rechain"><b>⛓ ${reqs.length} rechain request${reqs.length===1?'':'s'} — a tech took themselves off a job</b>`
      + reqs.map((r)=>`<div class="rcrow"><span><b>${esc(nameOf(r.employee_jid))}</b> left ${esc(jobOf(r.target_id))}${r.reason?' — “'+esc(r.reason)+'”':''}</span>`
        + `<button class="labtn" style="margin-left:auto" onclick="hlResolveRechain('${esc(r.id)}','rechain')">Put back on</button>`
        + `<button class="labtn" onclick="hlResolveRechain('${esc(r.id)}','dismiss')">Leave off</button></div>`).join('')
      + `</div>`;
  }
  function renderLayers(){
    const open = anyLens() && state.layersOpen;
    document.getElementById('layerspanel').classList.toggle('open', open);
    if(!open) return;
    let h='';
    if(state.lenses.materials){
      const rows=visits.filter((v)=>v.date===state.date && v.jobNo && LENS.materials[v.jobNo]);
      h+=lsec('📦','Materials readiness', rows.map((v)=>{const m=LENS.materials[v.jobNo];return layrow(`#${v.jobNo} ${v.client}`, m.note, m.status==='ready'?'ok':'wait', m.status==='ready'?'Ready':'Awaiting');}).join('')||empty('No material jobs today'));
    }
    if(state.lenses.money){
      const rows=visits.filter((v)=>v.date===state.date && v.jobNo && LENS.money[v.jobNo]);
      const totOpen=rows.reduce((a,v)=>a+(LENS.money[v.jobNo].open||0),0);
      h+=lsec('💵',`Money · $${(totOpen/1000).toFixed(1)}k open today`, rows.map((v)=>{const m=LENS.money[v.jobNo];return layrow(`#${v.jobNo} ${v.client}`, `${m.margin}% margin`, m.open?'wait':'ok', m.open?('$'+(m.open/1000).toFixed(1)+'k open'):'Paid');}).join('')||empty('No billed jobs today'));
    }
    if(state.lenses.assets){
      h+=lsec('🚚','Assets · fleet', visibleTechs().filter((t)=>LENS.assets[t.id]&&LENS.assets[t.id]!=='—').map((t)=>layrow(t.n, LENS.assets[t.id], (t.live&&t.live.cls==='on_site')?'ok':((t.live&&t.live.cls==='en_route')?'wait':''), t.live?t.live.label:'—')).join('')||empty('No assigned vehicles'));
    }
    if(state.lenses.compliance){
      h+=lsec('📋','Compliance · deadlines', LENS.compliance.map((c)=>layrow(c.title, c.note, c.status, c.label)).join(''));
    }
    if(state.lenses.weather){
      h+=lsec('🌦️','Weather · this week', WEEK.map((d)=>{const w=LENS.weather[d];return layrow(dLabel(d), w.note||'—', w.rain?'wait':'ok', `${w.ic} ${w.t}`);}).join(''));
    }
    document.getElementById('layerslist').innerHTML=h;
  }
  const lsec=(ic,t,body)=>`<div class="laysec"><div class="lh">${ic} ${t}</div>${body}</div>`;
  const layrow=(title,sub,pill,pillTxt)=>`<div class="layrow"><span class="r">${pill?`<span class="pillx ${pill}">${pillTxt}</span>`:pillTxt||''}</span><b>${title}</b><div class="sub">${sub||''}</div></div>`;
  const empty=(m)=>`<div style="color:var(--mut);font-size:11px;padding:6px 2px">${m}</div>`;
  // on-board badges for a job block
  function lensBadges(v){
    let out='';
    if(state.lenses.materials && v.jobNo && LENS.materials[v.jobNo]){ const m=LENS.materials[v.jobNo]; out+=`<span class="lbadge">${m.status==='ready'?'📦 ✓':'📦 ⏳'}</span>`; }
    if(state.lenses.money && v.jobNo && LENS.money[v.jobNo] && LENS.money[v.jobNo].open){ out+=`<span class="lbadge">💵 $${(LENS.money[v.jobNo].open/1000).toFixed(1)}k</span>`; }
    return out?`<div class="lens-line">${out}</div>`:'';
  }
  // compact markers for Week/Month chips (kind · confirm · active lenses)
  function chipMarks(v){
    let m=''; const kd=KINDS[v.kind||'field'];
    if(v.kind&&v.kind!=='field') m+=kd.ic;
    if(kd&&kd.clientFacing&&v.confirm==='unconfirmed') m+='⌛';
    if(kd&&kd.clientFacing&&v.confirm==='confirmed') m+='✓';
    // Declined is the state the office most needs to see -- it means someone
    // has said they cannot make it and the slot needs rebooking.
    if(kd&&kd.clientFacing&&v.confirm==='declined') m+='✕';
    if(state.lenses.materials&&v.jobNo&&LENS.materials[v.jobNo]) m+=(LENS.materials[v.jobNo].status==='ready'?'📦':'📦⏳');
    if(state.lenses.money&&v.jobNo&&LENS.money[v.jobNo]&&LENS.money[v.jobNo].open) m+='💵';
    return m?m+' ':'';
  }

  // ---- SETUP modal: everything a company configures for the calendar ----
  const ROLE_LABELS={dispatcher:'Dispatcher',owner:'Owner',pm:'Project Manager',sales:'Sales',field:'Field',office:'Office'};
  const sec=(t,body)=>`<div class="setsec"><div class="seth">${t}</div>${body}</div>`;
  const tog=(on,fn)=>`<span class="toggle ${on?'on':''}" onclick="${fn}"><i></i></span>`;
  window.openSetup=()=>{
    const hrs=(sel)=>{let o='';for(let h=5;h<=21;h++)o+=`<option value="${h}" ${h===sel?'selected':''}>${fmt(h)}</option>`;return o;};
    // People & colors
    const people=techs.map((t)=>`<div class="setrow"><input type="color" value="${t.pc}" onchange="Setup.techColor('${t.id}',this.value)"><b>${t.n}</b><span style="color:var(--mut)">${t.crew} · ${t.div}</span><span class="setpill">${t.lens}</span></div>`).join('');
    // Default layouts by role
    const roles=Object.keys(ROLE_PRESETS).map((r)=>{const p=ROLE_PRESETS[r];return `<div class="setrow"><b>${ROLE_LABELS[r]}</b><span style="color:var(--mut)">opens ${p.view.charAt(0).toUpperCase()+p.view.slice(1)} · ${p.filter} · ${p.rail?'unscheduled rail':'no rail'}</span></div>`;}).join('');
    const rdy=Object.keys(SETUP.readiness).map((k)=>`<div class="setrow">${tog(SETUP.readiness[k],`Setup.rdy('${k}')`)}<span>${({customer:'Customer confirmed',permit:'Permit approved',materials:'Critical materials received',sub:'Sub COI valid',inspection:'Inspection scheduled',deposit:'Deposit / authorization',equipment:'Equipment available',predecessor:'Predecessor work complete',weather:'Weather compatible'})[k]}</span></div>`).join('');
    const conflicts=Object.keys(SETUP.conflicts).map((k)=>`<div class="setrow"><b style="text-transform:capitalize">${k}</b><select onchange="Setup.conflict('${k}',this.value)"><option ${SETUP.conflicts[k]==='block'?'selected':''}>block</option><option ${SETUP.conflicts[k]==='warn'?'selected':''}>warn</option><option ${SETUP.conflicts[k]==='off'?'selected':''}>off</option></select></div>`).join('');
    const body=
      sec('👤 People &amp; colors', `<div style="font-size:11px;color:var(--mut);margin-bottom:6px">Each person's color shows on their cards. (Skills/licenses, working hours, vehicles & territory would also live here.)</div>${people}`)+
      sec('🎨 Display &amp; defaults', `
        <div class="setrow"><span>Color cards by</span><select onchange="Setup.colorBy(this.value)"><option value="person" ${SETUP.colorBy==='person'?'selected':''}>Person</option><option value="division" ${SETUP.colorBy==='division'?'selected':''}>Trade / division</option><option value="status" ${SETUP.colorBy==='status'?'selected':''}>Status</option></select></div>
        <div class="setrow"><span>Business hours</span><select onchange="Setup.hours('start',this.value)">${hrs(SETUP.businessStart)}</select><span>to</span><select onchange="Setup.hours('end',this.value)">${hrs(SETUP.businessEnd)}</select></div>
        <div class="setrow"><span>Week starts</span><select onchange="Setup.set('weekStart',this.value)"><option ${SETUP.weekStart==='Sun'?'selected':''}>Sun</option><option ${SETUP.weekStart==='Mon'?'selected':''}>Mon</option></select></div>
        <div class="setrow"><span>Time zone</span><span style="color:var(--mut)">${SETUP.tz}</span></div>`)+
      sec('🧭 Default layout by role', roles)+
      sec('📏 Scheduling rules', `
        <div class="setrow"><span>Freeze window</span>${tog(state.freezeOn,'toggleFreeze();Setup.reopen()')}<select onchange="Setup.set('freezeMin',+this.value);Setup.reopen()"><option ${SETUP.freezeMin===30?'selected':''}>30</option><option ${SETUP.freezeMin===60?'selected':''}>60</option><option ${SETUP.freezeMin===90?'selected':''}>90</option></select><span>min</span></div>
        <div class="setrow"><span>Overtime after</span><select onchange="Setup.set('overtimeH',+this.value)"><option ${SETUP.overtimeH===8?'selected':''}>8</option><option ${SETUP.overtimeH===10?'selected':''}>10</option></select><span>h/day</span></div>
        <div class="setrow"><span>Default visit duration</span><select onchange="Setup.set('defaultDur',+this.value)"><option ${SETUP.defaultDur===1?'selected':''}>1</option><option ${SETUP.defaultDur===2?'selected':''}>2</option><option ${SETUP.defaultDur===3?'selected':''}>3</option></select><span>h</span></div>
        <div style="font-size:11px;color:var(--mut);margin:6px 0 3px">Conflicts — block, warn, or ignore</div>${conflicts}`)+
      sec('📅 Appointments &amp; approval', `
        <div style="font-size:11px;color:var(--mut);margin-bottom:4px">Reminder cadence</div>${config.reminders.map((r,i)=>`<div class="setrow">${tog(r.on,`Setup.reminder(${i})`)}<span>${r.l}</span></div>`).join('')}
        <div style="font-size:11px;color:var(--mut);margin:8px 0 4px">Approval ladder (in order, escalates on no-response)</div>
        <div class="setrow">${tog(SETUP.approval.aiCall,"Setup.appr('aiCall')")}<span>1. 🤖 AI phone call (Reina)</span></div>
        <div class="setrow">${tog(SETUP.approval.portal,"Setup.appr('portal')")}<span>2. 📱 Client portal</span></div>
        <div class="setrow">${tog(SETUP.approval.sms,"Setup.appr('sms')")}<span>3. 💬 SMS</span></div>
        <div class="setrow">${tog(SETUP.approval.email,"Setup.appr('email')")}<span>4. 📧 Email</span></div>`)+
      sec('🌦️ Weather', `
        <div class="setrow"><span>Outdoor-work risk ≥</span><input type="range" min="20" max="90" value="${SETUP.wxExposure}" oninput="Setup.wx('wxExposure',+this.value)"><b id="setWxE">${SETUP.wxExposure}%</b></div>
        <div class="setrow"><span>Travel risk ≥</span><input type="range" min="20" max="90" value="${SETUP.wxTravel}" oninput="Setup.wx('wxTravel',+this.value)"><b id="setWxT">${SETUP.wxTravel}%</b></div>
        <div class="setrow">${tog(SETUP.wxAutoNotify,"Setup.set('wxAutoNotify',!SETUP.wxAutoNotify);Setup.reopen()")}<span>Reina auto-notifies when work is at weather risk</span></div>`)+
      sec('✅ Readiness — what must be true to be "Ready"', rdy)+
      sec('🤖 Automation (Reina)', `<div class="setrow"><span>Level</span><select onchange="Setup.set('automation',this.value)">
        <option value="observe" ${SETUP.automation==='observe'?'selected':''}>Observe — just flags</option>
        <option value="suggest" ${SETUP.automation==='suggest'?'selected':''}>Suggest — recommends</option>
        <option value="stage" ${SETUP.automation==='stage'?'selected':''}>Stage — prepares a plan to approve</option>
        <option value="auto" ${SETUP.automation==='auto'?'selected':''}>Auto — moves within guardrails</option></select></div>
        <div style="font-size:11px;color:var(--mut)">Start at Suggest/Stage; Auto only after guardrails (what can move, $/OT limits) are set.</div>`)+
      sec('🔐 Permissions · money visible to', Object.keys(SETUP.money).map((r)=>`<div class="setrow">${tog(SETUP.money[r],`Setup.money('${r}')`)}<span>${ROLE_LABELS[r]}</span></div>`).join(''))+
      sec('🔌 Integrations', `<div class="setrow"><span>Jobber</span><span class="setpill" style="color:var(--ok)">connected · read-only mirror</span></div><div class="setrow"><span>QuickBooks</span><span class="setpill">money lens</span></div><div class="setrow"><span>Maps / routing</span><span class="setpill" style="color:var(--mut)">for travel & Schedule This</span></div><div class="setrow"><span>Email / SMS / Voice</span><span class="setpill" style="color:var(--mut)">reminders & approval</span></div>`);
    modal({k:'Schedule setup',title:'Calendar settings',body:`<div class="setup">${body}</div>`,actions:[{label:'Done',cls:'primary',fn:closeModal}]});
  };
  window.Setup={
    reopen(){ openSetup(); },
    techColor(id,c){ const t=techById(id); if(t){t.pc=c; render();} },
    colorBy(v){ SETUP.colorBy=v; render(); },
    hours(k,v){ if(k==='start')SETUP.businessStart=+v; else SETUP.businessEnd=+v; toast('Business hours set — applies to the board window in production (lab shows 6a–7p)',false); },
    set(k,v){ SETUP[k]=v; render(); },
    wx(k,v){ SETUP[k]=v; const el=document.getElementById(k==='wxExposure'?'setWxE':'setWxT'); if(el)el.textContent=v+'%'; render(); },
    rdy(k){ SETUP.readiness[k]=!SETUP.readiness[k]; openSetup(); },
    conflict(k,v){ SETUP.conflicts[k]=v; },
    reminder(i){ config.reminders[i].on=!config.reminders[i].on; openSetup(); },
    appr(k){ SETUP.approval[k]=!SETUP.approval[k]; openSetup(); },
    money(r){ SETUP.money[r]=!SETUP.money[r]; openSetup(); }
  };

  // ---- Legend / Key: explain every symbol on the board ----
  window.openKey=()=>{
    const divIcons=DIVISIONS.map((d)=>`<span class="keydemo">${DIVICON[d]} ${d}</span>`).join('');
    const kinds=Object.keys(KINDS).map((k)=>`<span class="keydemo">${KINDS[k].ic} ${KINDS[k].l}</span>`).join('');
    const body=`
      <div class="keysec"><b>🎨 Card COLOR = the person</b><div style="margin-top:5px">Each tech, sub &amp; salesperson has their own color. A card's color and left bar tell you <b>who</b> it's assigned to — matching their row and avatar.</div></div>
      <div class="keysec"><b>🔣 Card ICON = the trade / division</b><div style="margin-top:6px">${divIcons}</div></div>
      <div class="keysec"><b>Readiness — the bottom line of each card</b><div style="margin-top:6px"><span class="rpill ready">READY</span> good to start · <span class="rpill at_risk">AT&nbsp;RISK</span> a problem looming · <span class="rpill blocked">BLOCKED</span> can't start yet. The reason is shown right after it.</div></div>
      <div class="keysec"><b>🏠 Inside / 🌦️ Outside</b> = indoor work vs. weather-exposed outdoor work.</div>
      <div class="keysec"><b>Where it comes from & whether it's editable</b><div style="margin-top:5px">
        <span class="keydemo">🔒 + hatched = from Jobber (read-only)</span>
        <span class="keydemo" style="border-left:4px dashed var(--amb)">dashed edge = proposed / unconfirmed time</span>
        <span class="keydemo">PROPOSED CHANGE = a HiveLogic override of a Jobber job</span></div></div>
      <div class="keysec"><b>Corner marks</b><div style="margin-top:5px"><span class="keydemo">📌 pinned — don't move</span><span class="keydemo" style="color:var(--ok)">✓ customer confirmed</span><span class="keydemo" style="color:var(--amb)">⌛ awaiting confirmation</span></div></div>
      <div class="keysec"><b>Appointment types</b><div style="margin-top:5px">${kinds}</div></div>`;
    modal({k:'Key · what the symbols mean',title:'Reading the board',body,actions:[{label:'Got it',cls:'primary',fn:closeModal}]});
  };

  // ---- Weather: header widget + detail modal + Reina recommendation + notifications ----
  const riskClass = (r)=> r>=60?'hi':(r>=30?'md':'lo');
  const worstRisk = (w)=> Math.max(w.exposureRisk||0, w.travelRisk||0);
  function renderWxWidget(){
    const wx=LENS.weather[state.date]||LENS.weather[TODAY]; if(!wx)return;
    const wr=worstRisk(wx);
    document.getElementById('wxWidget').innerHTML=`${wx.ic} ${wx.t}${wr>=50?' · <b>'+wr+'%</b>':''}`;
  }
  function renderReinaBar(){
    const bar=document.getElementById('reinabar');
    const wx=LENS.weather[state.date]; const affected=weatherAffected(state.date);
    const show = state.view==='day' && wx && affected.length>0;
    bar.classList.toggle('hidden', !show);
    if(!show) return;
    const travel = wx.travelRisk>=50;
    bar.innerHTML=`<span class="hx">⬡ Reina</span> <span>${wx.ic} <b>${wx.cond}</b>${wx.note?' · '+wx.note:''} — `+
      (travel ? `<b>travel risk ${wx.travelRisk}%</b> affects <b>${affected.length}</b> job${affected.length>1?'s':''} (the drive). Delay starts & notify everyone.`
              : `<b>${affected.length}</b> exterior job${affected.length>1?'s':''} exposed. Pull them to the safe window.`)+
      `</span><span class="sp"><button class="btn sm" onclick="LabUI.reinaWeather()">Review &amp; notify</button></span>`;
  }
  // Deterministic hash so the hourly interpolation below is stable per day (not random).
  function hashStr(s){ let h=0; for(let i=0;i<s.length;i++) h=(h*31+s.charCodeAt(i))>>>0; return h; }
  // Daily weather comes from the real Open-Meteo feed via data.js (LENS.weather).
  // genWeather is only a neutral fallback for dates the feed didn't cover — return a
  // clear/zero-risk stub so we never fabricate risk (no false at-risk / Reina prompts).
  function genWeather(d){ return {ic:'☀️',t:'—',cond:'—',exposureRisk:0,travelRisk:0,riskFrom:0,hourly:'',generated:true}; }
  function weatherAt(d){ if(!LENS.weather[d]) LENS.weather[d]=genWeather(d); return LENS.weather[d]; }
  function hourlyFor(d){ const w=weatherAt(d); const from=w.riskFrom||0; const out=[];
    for(let hr=6;hr<=19;hr++){ const inWin=from&&hr>=from; const base=inWin?w.exposureRisk:Math.max(0,(w.exposureRisk||10)-30); const p=Math.max(0,Math.min(95,base+((hashStr(d+'-'+hr)%22)-11))); const temp=58+((hashStr(d)+hr)%24); out.push({hr,temp,p,ic:p>=60?(w.cond.indexOf('Thunder')>-1?'⛈️':'🌧️'):(p>=30?'🌦️':w.ic)}); }
    return out; }
  window.openWeather=()=>{
    let d=state.date; const days=[]; for(let i=0;i<25;i++){ days.push(d); d=addDays(d,1); }
    const rows=days.map((dd)=>{ const w=weatherAt(dd); const aff=weatherAffected(dd).length; const wr=worstRisk(w);
      return `<div class="wxrow ${dd===state.date?'today':''}" style="cursor:pointer" onclick="openWeatherDay('${dd}')"><span class="wxi">${w.ic}</span><div style="flex:1"><div class="wxd">${dLabel(dd)} · ${w.t}</div><div style="font-size:10.5px;color:var(--mut)">${w.cond}${w.travelRisk>=50?' · 🚗 travel '+w.travelRisk+'%':''}${aff?' · ⚠ '+aff+' job'+(aff>1?'s':''):''}</div></div><span class="wxr ${riskClass(wr)}">${wr}%</span><span style="color:var(--mut);font-weight:800">›</span></div>`;
    }).join('');
    modal({k:'Weather · 25-day forecast',title:'Extended forecast',body:`<div style="max-height:58vh;overflow-y:auto;margin:0 -2px">${rows}</div><div style="font-size:10.5px;color:var(--mut);margin-top:6px">Tap a day for the hourly forecast. <b>Exposure</b> risk = outdoor work; <b>travel</b> risk (ice/flooding) = all jobs. Reina acts at ≥ your set thresholds.</div>`,actions:[{label:'Close',cls:'',fn:closeModal}]});
  };
  window.openWeatherDay=(d)=>{
    const w=weatherAt(d); const hrs=hourlyFor(d);
    const bars=hrs.map((x)=>`<div class="hrrow"><span class="hrt">${fmt(x.hr)}</span><span class="hri">${x.ic}</span><span class="hrp"><span class="hrbar" style="width:${x.p}%;background:${x.p>=60?'var(--warn)':x.p>=30?'var(--amb)':'var(--ok)'}"></span></span><span class="hrv">${x.p}%</span><span class="hrtemp">${x.temp}°</span></div>`).join('');
    const body=`<div style="font-size:13px;margin-bottom:8px">${w.ic} <b>${w.cond}</b> · high ${w.t}${w.note?'<div style="font-size:11px;color:var(--mut);margin-top:3px">'+w.note+'</div>':''}</div>
      <div class="hrhead"><span class="hrt">Time</span><span></span><span style="flex:1">Chance of precip</span><span class="hrv">%</span><span class="hrtemp">Temp</span></div>
      <div class="hourly">${bars}</div>
      <div style="font-size:10.5px;color:var(--mut);margin-top:6px">${w.riskFrom?('⚠ Elevated risk from '+fmt(w.riskFrom)+' — schedule exterior/exposed work before then.'):'Low risk all day.'}</div>`;
    modal({k:'Hourly · '+dLabel(d),title:dLabel(d),body,actions:[{label:'‹ 25-day',cls:'',fn:()=>{closeModal();openWeather();}},{label:'Close',cls:'primary',fn:closeModal}]});
  };
  // Reina weather helpers (stage a plan + notify all three parties)
  function stageWeatherPlan(affected, wx){
    const from=wx.riskFrom||9;
    affected.forEach((v)=>{ const dur=v.e-v.s; const ns=Math.max(6, Math.min(from-dur, v.s));
      if(v.locked){ const prev=v.override; stageChange(`Weather: ${v.client} → override ${fmt(ns)} (before ${wx.cond.toLowerCase()})`, ()=>{v.override={t:v.t,s:ns,e:ns+dur,lifecycle:'proposed'};}, ()=>{v.override=prev;}); }
      else { const prev={s:v.s,e:v.e}; stageChange(`Weather: ${v.client} → ${fmt(ns)} (before ${wx.cond.toLowerCase()})`, ()=>{v.s=ns;v.e=ns+dur;}, ()=>{Object.assign(v,prev);}); }
    });
    toast('📋 Reina staged the weather reshuffle — review & publish to notify',false);
  }
  function stageTravelDelay(affected){
    affected.forEach((v)=>{ const dur=v.e-v.s; const ns=Math.min(18-dur, v.s+2);
      if(v.locked){ const prev=v.override; stageChange(`Travel delay: ${v.client} → ${fmt(ns)}`, ()=>{v.override={t:v.t,s:ns,e:ns+dur,lifecycle:'proposed'};}, ()=>{v.override=prev;}); }
      else { const prev={s:v.s,e:v.e}; stageChange(`Travel delay: ${v.client} → ${fmt(ns)}`, ()=>{v.s=ns;v.e=ns+dur;}, ()=>{Object.assign(v,prev);}); }
    });
    toast('📋 Staged a 2-hour delay for road safety — review & publish',false);
  }
  function notifyWeather(affected){
    const clients=affected.length; const techs=new Set(affected.map((v)=>effectiveTech(v))).size;
    toast(`📣 Weather advisory sent in one batch — ${clients} client${clients>1?'s':''}, ${techs} tech${techs>1?'s':''} & the office`,false);
  }

  // ---- Rule 4: scenario / review / publish bar ----
  function renderScenarioBar(){
    const bar=document.getElementById('scenariobar'); const n=state.scenario.changes.length;
    bar.classList.toggle('hidden', n===0);
    if(!n) return;
    bar.innerHTML=`📋 <b>Staged plan · ${n} change${n>1?'s':''}</b> <span style="opacity:.85;font-weight:600">nothing sent yet — review the impact, then publish once</span>
      <span class="sp"><button class="btn sm" onclick="LabUI.reviewScenario()">Review impact</button><button class="btn sm" onclick="LabUI.discardScenario()">Discard</button><button class="btn sm pub" onclick="LabUI.publishScenario()">Publish &amp; notify</button></span>`;
  }
  window.setMode=(m)=>{ state.controlMode=m; render();
    toast(m==='mirror'?'🪞 Mirror only — Jobber runs the schedule; HiveLogic can plan but not publish':(m==='planning'?'✎ HiveLogic planning — stage proposals, nobody is notified':'⚡ HiveLogic live — HiveLogic now owns the schedule; Jobber is history'),false); };

  // ---- Field "My Day" (execution assistant) ----
  function renderMyDay(){
    const board=document.getElementById('board'); board.className='board'; board.style.width='';
    const me=techById(MYDAY_TECH)||visibleTechs().find((t)=>t.lens==='crew')||visibleTechs()[0];
    if(!me){ board.innerHTML=emptyState('No crew to show for My Day'); return; }
    const stops=visits.filter((v)=>v.t===me.id && v.date===state.date).sort((a,b)=>a.s-b.s);
    const pending=stops.filter((v)=>execOf(v)!=='completed');
    const nextV=pending[0];
    const attn=stops.filter((v)=>readinessOf(v).level!=='ready').length;
    let h=`<div class="myday"><div class="md-hd">My Day</div><div class="md-sub">${me.n} · ${dLabel(state.date)} · ${stops.length} stops${attn?' · ⚠ '+attn+' need attention':''}</div>`;
    if(nextV){
      const r=readinessOf(nextV), ex=execOf(nextV);
      h+=`<div class="md-label">NEXT</div><div class="md-next"><div class="t">${fmt(nextV.s)}</div><div class="c">${nextV.client}</div><div class="a">${nextV.city}</div>
        <div class="ty">${nextV.type} · expected ${(nextV.e-nextV.s)}h</div>
        <div style="margin-top:10px"><span class="rpill ${r.level}">${RDY[r.level].l}${r.why?' · '+r.why:''}</span></div>
        <div class="md-act">`;
      if(ex==='not_started') h+=`<button class="md-btn" onclick="LabUI.mdAdvance('${nextV.id}')">🚚 Start route</button>`;
      else if(ex==='en_route') h+=`<button class="md-btn" onclick="LabUI.mdAdvance('${nextV.id}')">📍 I've arrived</button>`;
      else if(ex==='on_site'){
        h+=`<button class="md-btn" onclick="LabUI.mdAdvance('${nextV.id}')">✓ Complete work</button>
          <div class="md-row2"><button class="md-btn sec" onclick="LabUI.mdAction('photo')">📷 Photo</button><button class="md-btn sec" onclick="LabUI.mdAction('voice')">🎙 Voice note</button></div>
          <button class="md-btn sec" onclick="LabUI.mdAction('report')">⚠ Report a problem</button>`;
      }
      h+=`</div></div>`;
    } else {
      h+=`<div class="md-label">DONE</div><div class="md-next"><div class="c">🎉 All stops complete</div><div class="a">Nice work today.</div></div>`;
    }
    const rest=stops.filter((v)=>v!==nextV);
    if(rest.length){
      h+=`<div class="md-label">REST OF TODAY</div>`;
      rest.forEach((v)=>{ const done=execOf(v)==='completed'; const r=readinessOf(v);
        h+=`<div class="md-stop ${done?'done':''}"><span class="tm">${fmt(v.s)}</span><div><b style="font-size:13px">${v.client}</b><div style="font-size:11px;color:var(--mut)">${v.type} · ${v.city}</div></div><span class="st ${done?'':r.level}" style="${done?'color:var(--ok)':''}">${done?'✓ done':RDY[r.level].l}</span></div>`;
      });
    }
    h+=`<div style="margin-top:16px;font-size:11px;color:var(--mut);text-align:center">Field view · you see only the effective schedule — no dispatch board, no money, no other crews. Switch <b>Role</b> (top) to return.</div></div>`;
    board.innerHTML=h;
  }
  function mdComplete(vid){ const v=visits.find((z)=>z.id===vid);
    modal({k:'Work complete',title:v?v.client:'',body:`<div class="policybox"><b>HiveLogic detected</b>⏱ ${v?(v.e-v.s):3}h 12m labor · GPS-verified<br>📷 6 photos attached<br>💡 1 additional repair recommendation</div><div style="font-size:11px;color:var(--mut)">Review before it goes to the office + invoice.</div>`,
      actions:[{label:'Edit',cls:'',fn:()=>{ if(v)v.exec='on_site'; closeModal(); render(); }},{label:'Review & submit',cls:'primary',fn:()=>{ if(v)v.status='done'; closeModal(); render(); toast('✅ Submitted — office notified, time + photos on the job',false); }}]});
  }

  // ---- DAY (crew-row timeline) ----
  function renderDay(){
    const board=document.getElementById('board'); board.className='board';
    const HW=HRW(), RW=RAILW(); board.style.width=(RW+SPAN*HW)+'px';
    // 2026-08-15 (empty-day fix): board chrome — time grid + crew rows — renders
    // unconditionally. Only the job cards are conditional on job count (the per-lane
    // forEach below naturally draws nothing when a crew has no visits). Previously a
    // `if(!anyToday){ board.innerHTML=emptyState(...); return; }` early-return replaced
    // the ENTIRE board on a zero-job day, collapsing all layout to a bare message.
    const anyToday = visibleTechs().some((t)=>dayVisits(t.id).length);
    let h='<div class="timehdr"><div class="railhdr">Crew</div>';
    for(let hr=DAY_START;hr<DAY_END;hr++) h+=`<div class="hrslot" style="width:${HW}px;min-width:${HW}px">${fmt(hr)}</div>`;
    if(state.date===TODAY) h+=`<div class="nowflag" style="left:${RW+(SIM_NOW-DAY_START)*HW}px">${fmt(SIM_NOW)}</div>`;
    h+='</div>';
    // Empty-day: subtle inline note inside the still-visible board (not a replacement).
    if(!anyToday) h+=`<div class="dayempty">🗓️ No visits scheduled for ${dLabel(state.date)} — the crew board is clear. <span>Try Week, or press Today.</span></div>`;
    visibleTechs().forEach((t)=>{
      const ci=conflictInfo(t.id), hrs=hoursFor(t.id), util=Math.round(Math.min(hrs/8,1)*100), over=hrs>8;
      const live=(t.live&&t.live.cls)?`<span class="livep ${t.live.cls}"><span class="d"></span>${t.live.label}</span>`
        :`<span class="livep idle" title="No live GPS — schedule-based">${dayVisits(t.id).length} jobs</span>`;
      const asset=(state.lenses.assets && LENS.assets[t.id] && LENS.assets[t.id]!=='—')?`<span class="asset">🚚 ${LENS.assets[t.id]}</span>`:'';
      // The hard delineation: a labelled break, not just a thicker line, so it
      // is unmistakable where your people end and other companies begin.
      if(t.firstExternal) h+=`<div class="subsplit"><span>Subcontractors</span></div>`;
      h+=`<div class="row${t.external?' extrow':''}"><div class="rail" onclick="openTechSheet('${t.id}')" title="Live status, schedule & history"><span class="av" style="background:${t.pc}">${t.ini}</span>
        <div class="who"><b>${t.n}${asset}</b><span class="sub">${t.crew} · ${hrs}h ${live}</span><div class="utilbar ${over?'over':''}"><i style="width:${util}%"></i></div></div></div>
        <div class="lane" data-tech="${t.id}" style="width:${SPAN*HW}px">`;
      ci.zones.forEach((z)=>{h+=`<div class="confzone" style="left:${(z.s-DAY_START)*HW}px;width:${(z.e-z.s)*HW}px"></div>`;});
      if(state.date===TODAY) h+=`<div class="nowline" style="left:${(SIM_NOW-DAY_START)*HW}px"></div>`;
      dayVisits(t.id).forEach((v)=>{
        const pc=colorFor(v);                                  // card color (by person / division / status — a setting)
        const kd=KINDS[v.kind||'field'], clientFacing=kd&&kd.clientFacing;
        const unconf=clientFacing && v.confirm==='unconfirmed' && v.source!=='jobber';
        const cf = v.source==='jobber'?'':(v.confirm==='confirmed'?'<span class="cf" title="Confirmed" style="color:var(--ok)">✓</span>':(unconf?'<span class="cf" title="Awaiting confirmation" style="color:var(--amb)">⌛</span>':''));
        const r=readinessOf(v), es=effectiveStart(v), ee=effectiveEnd(v);
        const propText = isRemoved(v) ? 'PROPOSED REMOVAL' : ((v.override && state.controlMode!=='live') ? 'PROPOSED CHANGE' : (v.lifecycle==='proposed' ? 'PROPOSED' : ''));
        const L=Math.max(0,Math.min(SPAN-0.25,es-DAY_START)), R=Math.max(L+0.25,Math.min(SPAN,ee-DAY_START)); // clamp so early/late jobs stay on-canvas
        const offWin = es<DAY_START || ee>DAY_END;
        // Chained secondary: the job itself lives on the lead's row. All this row
        // needs is proof the person is spoken for, so nobody double-books them.
        if(v.chained){
          h+=`<div class="job chained" data-vid="${v.id}" title="Chained to ${v.chainedToName} · ${v.client} · ${fmt(es)}–${fmt(ee)}"
               style="left:${L*HW}px;width:${(R-L)*HW}px"><small>⛓ with ${v.chainedToName}</small></div>`;
          return;
        }
        h+=`<div class="job ${v.status==='done'?'done':''} ${ci.bad.has(v.id)?'conflict':''} ${unconf?'unconfirmed':''} ${v.source==='jobber'?'jobber':''} ${r.level!=='ready'?r.level:''}" draggable="${v.locked?'false':'true'}" data-vid="${v.id}" title="${isRemoved(v)?'Proposed removal — Jobber untouched until this crew is Live':(offWin?fmt(es)+'–'+fmt(ee)+' (outside board hours)':'')}"
             style="left:${L*HW}px;width:${(R-L)*HW}px;background:linear-gradient(0deg,${pc}2e,${pc}2e),var(--panel);border-left-color:${pc}${isRemoved(v)?';opacity:.5':''}">
             ${v.pinned?'<span class="pin">📌</span>':''}${cf}
             <b><span class="divi" title="${v.div}">${cardIcon(v)}</span>${v.jobNo?'#'+v.jobNo+' ':''}${isRemoved(v)?'<s>'+v.type+'</s>':v.type}</b>
             <small><span class="io" title="${exposureOf(v)==='outside'?'Outside work — weather-exposed':'Inside work'}">${outIcon(v)}</span> ${v.client} · ${fmt(es)}–${fmt(ee)}</small>
             <span class="rdy ${r.level}">${r.level==='ready'?'● Ready':(RDY[r.level].l+' — '+r.why)}</span>
             ${(v.crew&&v.crew.length>1)?`<span class="crewrow" title="${v.crew.map((c)=>c.n+(c.lead?' (lead)':'')).join(', ')}">${v.crew.map((c)=>`<span class="cwav${c.lead?' lead':''}" title="${c.n}${c.lead?' · lead':' · crew'}" style="background:${c.pc}">${c.ini}</span>`).join('')}<span class="cwn">+${v.crew.length-1}</span></span>`:''}
             ${lensBadges(v)}${propText?'<span class="propchip">'+propText+'</span>':''}</div>`;
      });
      h+='</div></div>';
    });
    board.innerHTML=h; wireDay();
  }

  // ---- WEEK (crew rows × 7 days) ----
  function renderWeek(){
    const board=document.getElementById('board'); board.className='board'; board.style.width='';
    const wk=weekDaysOf(state.date);
    let h='<div class="wk"><div class="wkhd"><div class="rc">Crew</div>';
    wk.forEach((d)=>{const dt=parseYMD(d);h+=`<div class="dc ${d===TODAY?'today':''}">${DOW[dt.getDay()]}<b>${dt.getDate()}</b></div>`;});
    h+='</div>';
    visibleTechs().forEach((t)=>{
      h+=`<div class="wkrow"><div class="rc"><span class="av" style="background:${t.pc}">${t.ini}</span><div><b style="font-size:12px">${t.n}</b><div style="font-size:9.5px;color:var(--mut)">${t.crew}</div></div></div>`;
      wk.forEach((d)=>{
        const dv=dayVisits(t.id,d);
        const rain=state.lenses.weather && LENS.weather[d] && LENS.weather[d].rain;
        h+=`<div class="wkcell ${d===TODAY?'today':''} ${rain?'rainday':''}" onclick="LabUI.addAt('${t.id}','${d}',event)" title="Click an empty spot to + Add">`+dv.map((v)=>{
          const pc=colorFor(v);
          const unc=(KINDS[v.kind||'field']||{}).clientFacing && v.confirm==='unconfirmed';
          return `<div class="wkchip ${unc?'unconf':''}" style="background:linear-gradient(0deg,${pc}2a,${pc}2a),var(--panel);border-left-color:${pc}" onclick="event.stopPropagation();LabUI.openVisitSheet('${v.id}')" title="${v.client} · ${v.type} · ${v.div}">${cardIcon(v)} ${v.jobNo?'#'+v.jobNo+' ':''}${v.type.replace(/^#\d+\s/,'')}<small>${outIcon(v)} ${fmt(v.s)} · ${v.client}</small></div>`;
        }).join('')+`</div>`;
      });
      h+='</div>';
    });
    board.innerHTML=h+'</div>';
  }

  // ---- MONTH (roll-up grid) ----
  function renderMonth(){
    const board=document.getElementById('board'); board.className='board'; board.style.width='';
    const dt0=parseYMD(state.date), y=dt0.getFullYear(), m=dt0.getMonth();
    const MONTHS=['January','February','March','April','May','June','July','August','September','October','November','December'];
    const first=new Date(y,m,1), lead=first.getDay(), days=new Date(y,m+1,0).getDate();
    const byDate={}; visits.forEach((v)=>{ if(state.hidden.has(v.t))return; if(isEffectivelyRemoved(v))return; (byDate[v.date]=byDate[v.date]||[]).push(v); });
    let h='<div class="mo"><div style="font-weight:800;margin:2px 0 8px">'+MONTHS[m]+' '+y+'</div><div class="modow">'+
      ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map((x)=>`<span>${x}</span>`).join('')+'</div><div class="mogrid">';
    const cells=Math.ceil((lead+days)/7)*7;
    for(let i=0;i<cells;i++){
      const dom=i-lead+1;
      if(dom<1||dom>days){ h+='<div class="mcell off"></div>'; continue; }
      const ds=ymd(new Date(y,m,dom)), evs=byDate[ds]||[];
      h+=`<div class="mcell ${ds===TODAY?'today':''}" onclick="LabUI.openDay('${ds}')"><div class="mn">${dom}</div>`+
        evs.slice(0,3).map((v)=>{const pc=colorFor(v);return `<div class="mchip" style="background:linear-gradient(0deg,${pc}2a,${pc}2a),var(--panel);border-left-color:${pc}" title="${v.client} · ${v.type} · ${v.div}" onclick="event.stopPropagation();LabUI.openVisitSheet('${v.id}')">${cardIcon(v)} ${v.jobNo?'#'+v.jobNo:''} ${v.client}</div>`;}).join('')+
        (evs.length>3?`<div class="mmore" onclick="event.stopPropagation();LabUI.openDay('${ds}')">+${evs.length-3} more</div>`:'')+`</div>`;
    }
    board.innerHTML=h+'</div></div>';
  }

  // ---- GANTT (renovation projects by phase) ----
  function renderGantt(){
    const board=document.getElementById('board'); board.className='board'; board.style.width='';
    const gcol=64; document.documentElement.style.setProperty('--gcol', gcol+'px');
    const idx=(d)=>GANTT.indexOf(d);
    let h='<div class="gt"><div class="gthd" style="grid-template-columns:230px repeat('+GANTT.length+',1fr)"><div class="glabel">Renovation project</div>';
    GANTT.forEach((d)=>{const dt=parseYMD(d);const we=dt.getDay()===0||dt.getDay()===6;h+=`<div class="gday ${we?'we':''}">${DOW[dt.getDay()]}<b>${dt.getDate()}</b></div>`;});
    h+='</div>';
    const projs=visibleProjects();
    // Keep the Gantt day-header visible and show an inline note (don't replace the view).
    if(!projs.length){ board.innerHTML=h+'<div class="dayempty" style="position:static;margin:12px">📊 No project timelines to show'+(state.division!=='all'?' in '+state.division:'')+' yet.</div></div>'; return; }
    projs.forEach((p)=>{
      const crew=techById(p.crew), dc=DIVCOLORS[p.division]||'#888';
      const nVisits=visits.filter((v)=>String(v.jobNo)===p.id).length;
      h+=`<div class="gtrow ${state.focusProject===p.id?'focus':''}"><div class="glabel" style="cursor:pointer" onclick="LabUI.openProject('${p.id}')"><b>${p.name}</b><small><span class="divdot" style="background:${dc}"></span>${p.division} · ${crew?crew.n:''} · $${(p.value/1000).toFixed(0)}k · ${nVisits} visit${nVisits!==1?'s':''}</small></div><div class="gtrack" style="width:${GANTT.length*gcol}px">`;
      // now line
      if(idx(TODAY)>=0) h+=`<div class="gtnow" style="left:${(idx(TODAY)+0.5)*gcol}px"></div>`;
      let stack=0, lastEnd=-1;
      p.phases.forEach((ph)=>{
        const a=idx(ph.start), b=idx(ph.end); if(a<0) return;
        const bb=b<0?a:b; const st=(a<=lastEnd)?1:0; lastEnd=Math.max(lastEnd,bb);
        const col=STATUS[ph.status]?STATUS[ph.status].c:'#8b92a8';
        h+=`<div class="gbar ${st?'stack2':''}" style="left:${a*gcol+2}px;width:${(bb-a+1)*gcol-4}px;background:${col}" title="${ph.name} · ${ph.status}">${ph.name}</div>`;
        if(ph.milestone) h+=`<div class="gms" style="left:${(bb+1)*gcol-6}px" title="Milestone: ${ph.name}"></div>`;
      });
      h+='</div></div>';
    });
    board.innerHTML=h+'</div>';
  }

  // ---- MAP / live-ops view ----
  /* What the map is allowed to plot. Day = the day being viewed (state.date --
     not "today"); Week = the Mon-Sun week that day falls in. Everything is
     filtered out of the already-loaded visit set, so changing period never
     costs a fetch. mapVisitIds() is what lets marker layers drop pins that
     have left the period instead of piling them up. */
  // scope 'board' = follow the calendar view (Day board -> that day, Week board
  // -> that week). Anything else = follow the Map tab's own Day/Week toggle.
  function mapPeriodRange(scope){
    const wantWeek = (scope==='board') ? (state.view==='week') : (state.mapPeriod==='week');
    if(wantWeek){
      const wk=weekDaysOf(state.date);          // same Mon..Sun week the Week board uses
      return { start:wk[0], end:wk[6] };
    }
    return { start:state.date, end:state.date };
  }
  function mapVisits(scope){
    const r=mapPeriodRange(scope);
    return visits.filter((v)=>v.lat && v.lng && v.date>=r.start && v.date<=r.end);
  }
  function mapVisitIds(scope){ const s={}; mapVisits(scope).forEach((v)=>{ s[v.id]=true; }); return s; }
  function mapPeriodLabel(){
    const r=mapPeriodRange();
    return state.mapPeriod==='week' ? (dLabel(r.start)+' – '+dLabel(r.end)) : dLabel(state.date);
  }
  window.setMapPeriod=(p)=>{ state.mapPeriod=(p==='week'?'week':'day'); render(); };
  function mapPeriodCtlHTML(){
    const n=mapVisits().length;
    return `<button class="${state.mapPeriod==='day'?'pri':''}" onclick="setMapPeriod('day')">Day</button>`+
           `<button class="${state.mapPeriod==='week'?'pri':''}" onclick="setMapPeriod('week')">Week</button>`+
           `<button id="map-gps-refresh" onclick="refreshLiveGps(this)" title="${GPS_REFRESH_TITLE}" aria-label="Refresh truck positions">↻</button>`+
           `<span style="opacity:.8">${mapPeriodLabel()} · ${n} mapped ${n===1?'job':'jobs'}</span>`;
  }

  // On-demand GPS re-read for the board.
  //
  // Same limit as the Command Center's button, and worth restating where the
  // code is rather than only in a commit message: the freshest fix arrives when
  // FleetSharp PUSHES to the app on the vendor's own schedule. Nothing here can
  // ask a truck to report. This re-reads what has already arrived.
  //
  // The 60s poll skips while the tab is hidden, so a dispatcher returning to the
  // board may be looking at positions much staler than a minute. That is the
  // case this button is for.
  //
  // The legend keeps telling the truth about age via gpsAgoLabel() -- "GPS
  // updated 14 min ago" stays 14 min ago after a successful refresh if no truck
  // has reported since. The button reports that the READ finished; the legend
  // reports how old the DATA is.
  const GPS_REFRESH_TITLE = 'Re-read truck positions now. Trucks report on their own schedule, '
    + 'so this picks up anything that has arrived since the last check — it cannot make a stale fix newer.';
  let gpsRefreshing = false;
  function refreshLiveGps(btn){
    if(gpsRefreshing) return;
    gpsRefreshing = true;
    const el = btn || document.getElementById('map-gps-refresh');
    if(el){ el.disabled = true; el.classList.add('spinning'); }
    loadLiveGps().finally(()=>{
      gpsRefreshing = false;
      // mapPeriodCtlHTML() may have re-rendered the bar underneath us, so find
      // the button again rather than trusting the reference we started with.
      const now = document.getElementById('map-gps-refresh');
      if(now){ now.disabled = false; now.classList.remove('spinning'); }
    });
  }
  window.refreshLiveGps = refreshLiveGps;

  var MAPB=null; // projection bounds {w,e,n,s}
  var PROJ=mapProject; // active lat/lng→screen projection (flat for Map view, iso for the city background)
  const MAP_W=1000, MAP_H=620, MAP_PAD=60;
  function mapProject(lat,lng){ if(!MAPB) return {x:0,y:0}; const x=MAP_PAD+(lng-MAPB.w)/(MAPB.e-MAPB.w||1)*(MAP_W-2*MAP_PAD); const y=MAP_PAD+(MAPB.n-lat)/(MAPB.n-MAPB.s||1)*(MAP_H-2*MAP_PAD); return {x,y}; }
  function techStops(id){ return dayVisits(id).filter((v)=>v.lat&&v.lng).sort((a,b)=>a.s-b.s); }
  /* ---- REAL vehicle positions (2026-08-15) -------------------------------
     This replaces truckPos(), which interpolated a position along the day's
     scheduled stops against a play clock. That produced trucks sliding around
     the map on a screen labelled "live vehicle positions" -- motion that was
     invented, not observed. The board's own view hint admitted it ("Real
     vehicle GPS in production").

     Positions now come from resource=crew_schedule: the same real vehicles
     table Command Center reads, already resolving Jobber's feed against
     FleetSharp's by whichever fix is fresher (api/track1.js). Note the Jobber
     column has been frozen since 2026-07-28; FleetSharp is what is actually
     carrying the fleet.

     A crew with no vehicle, or a vehicle with no fix, is NOT drawn. Parking
     them at the shop would be inventing a location just as much as the
     interpolation did. A fix older than 30 minutes is drawn greyed and
     labelled stale rather than presented as current. The legend states how
     many crews are genuinely tracked. */
  // The shop yard -- 23 Bedford-Banksville Rd, Bedford NY 10506 (window.LAB.office).
  // It anchors the outlier filter, is always forced into the fitted bounds, and is
  // the point rotate and tilt pivot around.
  function shopLngLat(){ const o=window.LAB.office; return [o.lng, o.lat]; }

  const GPS_STALE_MS = 30*60*1000;
  const LIVEGPS = { byTech:{}, at:0, error:null };
  const gpsNorm = (x) => String(x||'').trim().toLowerCase();
  function applyLiveGps(d){
    const byName={}; (d.vehicles||[]).forEach((v)=>{ if(v && v.name) byName[gpsNorm(v.name)]=v; });
    // roster gives us tech -> vehicleName; crew_schedule also ships an explicit
    // vehicle -> techName assignment list. Try the roster first, fall back to
    // the assignment list matched on full or first name.
    const techForVehicle={}; (d.vehicleAssignments||[]).forEach((a)=>{ if(a && a.vehicleName && a.techName) techForVehicle[gpsNorm(a.vehicleName)]=gpsNorm(a.techName); });
    const out={};
    techs.forEach((t)=>{
      let veh = t.vehicleName ? byName[gpsNorm(t.vehicleName)] : null;
      if(!veh){
        const keys=Object.keys(techForVehicle);
        for(let i=0;i<keys.length;i++){
          const who=techForVehicle[keys[i]];
          if(who && (who===gpsNorm(t.fullName) || who.split(/\s+/)[0]===gpsNorm(t.n))){ veh=byName[keys[i]]; break; }
        }
      }
      if(!veh || veh.lat==null || veh.lng==null) return;
      const age = veh.updatedAt ? (Date.now()-new Date(veh.updatedAt).getTime()) : Infinity;
      const isStale = !(age < GPS_STALE_MS);
      out[t.id] = { lat:Number(veh.lat), lng:Number(veh.lng),
        moving: !isStale && (veh.status==='DRIVING' || veh.status==='MOVING'),
        stale:isStale, status:veh.status||'', speed:veh.speed, updatedAt:veh.updatedAt, vehicleName:veh.name };
    });
    LIVEGPS.byTech=out; LIVEGPS.at=Date.now(); LIVEGPS.error=null;
  }
  // Counted over the crews actually on screen, at render time -- hiding someone
  // must not leave the legend claiming more tracked crews than are shown.
  function gpsCounts(){
    let live=0, stale=0; const shown=visibleTechs();
    shown.forEach((t)=>{ const p=LIVEGPS.byTech[t.id]; if(!p) return; if(p.stale) stale++; else live++; });
    return { live, stale, untracked: Math.max(0, shown.length-live-stale), shown: shown.length };
  }
  // This runs every 60 seconds for as long as the board is on screen, which is
  // what turned one expired token into a console full of 401s: the board is an
  // iframe, it does not inherit the app's authenticated-fetch shim, and the
  // token it was handed on load dies after an hour. So never fire this bare --
  // a request with no Authorization header is a guaranteed 401 that teaches us
  // nothing -- and on a rejected token, ask the parent for a live one and try
  // again. Once: a genuinely signed-out session must settle into "unavailable"
  // rather than doubling the request rate forever.
  function freshBoardToken(){
    return (typeof window.hlFreshToken === 'function')
      ? window.hlFreshToken()
      : Promise.resolve(window.HL_BOARD_TOKEN || '');
  }
  function fetchLiveGps(retried){
    const tok = window.HL_BOARD_TOKEN || '';
    if(!tok){
      if(retried) throw new Error('not signed in');
      return freshBoardToken().then(()=>fetchLiveGps(true));
    }
    return fetch('/api/track1?resource=crew_schedule', { headers:{ Authorization:'Bearer '+tok } })
      .then((r)=>{
        if(r.status !== 401 && r.status !== 403) return r.json();
        if(retried) throw new Error('not signed in');
        return freshBoardToken().then((t)=>{
          // The same token back means the parent has nothing better to give.
          // Retrying with it would just be the same 401 at twice the rate.
          if(!t || t === tok) throw new Error('not signed in');
          return fetchLiveGps(true);
        });
      });
  }
  function loadLiveGps(){
    return Promise.resolve().then(()=>fetchLiveGps(false))
      .then((d)=>{ if(!d || !d.ok) throw new Error((d && d.error) || 'unavailable'); applyLiveGps(d); updateTrucks(); renderMapLegend(); renderSummary(); })
      .catch((e)=>{ LIVEGPS.error=(e && e.message) || 'unavailable'; renderMapLegend(); renderSummary(); });
  }
  // null = we have no real position for this crew, and callers must draw nothing.
  function liveTruckPos(id){ return LIVEGPS.byTech[id] || null; }
  function gpsAgoLabel(){
    if(LIVEGPS.error) return 'GPS unavailable ('+LIVEGPS.error+')';
    if(!LIVEGPS.at) return 'GPS loading…';
    const mins=Math.round((Date.now()-LIVEGPS.at)/60000);
    return 'GPS updated '+(mins<1?'just now':(mins+' min ago'));
  }
  function renderMapLegend(){
    document.querySelectorAll('.mapwrap .maplegend').forEach((el)=>{ el.innerHTML=mapLegendHTML(); });
  }
  function mapLegendHTML(){
    const c=gpsCounts();
    return `<span><b>●</b> job (green/amber/red = readiness)</span>`+
      `<span>◉ = a crew truck at its real GPS position</span>`+
      `<span>${c.live} of ${c.shown} crews tracked`+
      (c.stale?` · ${c.stale} stale (>30 min)`:'')+
      (c.untracked?` · ${c.untracked} with no vehicle GPS`:'')+`</span>`+
      `<span>${gpsAgoLabel()}</span>`+
      (MAPNOTE?`<span style="color:var(--amb)">${MAPNOTE}</span>`:'');
  }
  function buildMapSVG(fit){
    PROJ=mapProject;
    const techs2=visibleTechs(); const jobs=mapVisits();
    const pts=jobs.map((v)=>[v.lat,v.lng]).concat([[window.LAB.office.lat,window.LAB.office.lng]]);
    if(!pts.length) return '';
    const lats=pts.map((p)=>p[0]), lngs=pts.map((p)=>p[1]);
    MAPB={w:Math.min.apply(0,lngs)-0.01,e:Math.max.apply(0,lngs)+0.01,n:Math.max.apply(0,lats)+0.01,s:Math.min.apply(0,lats)-0.02};
    const byCity={}; jobs.forEach((v)=>{ (byCity[v.city]=byCity[v.city]||[]).push(v); });
    let svg=`<svg viewBox="0 0 ${MAP_W} ${MAP_H}" style="width:100%;height:100%;display:block" preserveAspectRatio="xMidYMid ${fit||'meet'}">`;
    svg+=`<rect width="${MAP_W}" height="${MAP_H}" fill="var(--grid)"/>`;
    svg+=`<rect x="0" y="${MAP_H-70}" width="${MAP_W}" height="70" fill="rgba(43,140,192,.16)"/><text x="16" y="${MAP_H-46}" class="townlbl" style="opacity:.6">Long Island Sound</text>`;
    for(let gx=0;gx<=MAP_W;gx+=100) svg+=`<line x1="${gx}" y1="0" x2="${gx}" y2="${MAP_H}" stroke="var(--line)" stroke-width="1" opacity=".4"/>`;
    for(let gy=0;gy<=MAP_H;gy+=100) svg+=`<line x1="0" y1="${gy}" x2="${MAP_W}" y2="${gy}" stroke="var(--line)" stroke-width="1" opacity=".4"/>`;
    Object.keys(byCity).forEach((city)=>{ const arr=byCity[city]; const la=arr.reduce((a,v)=>a+v.lat,0)/arr.length, ln=arr.reduce((a,v)=>a+v.lng,0)/arr.length; const p=mapProject(la,ln); svg+=`<text x="${p.x}" y="${p.y-16}" class="townlbl">${city}</text>`; });
    const op=mapProject(window.LAB.office.lat,window.LAB.office.lng); svg+=`<g transform="translate(${op.x},${op.y})"><rect x="-9" y="-9" width="18" height="18" rx="3" fill="var(--mut)"/><text y="1" style="font-size:10px;text-anchor:middle;dominant-baseline:central">🏢</text><text y="22" class="townlbl" style="text-anchor:middle">Shop</text></g>`;
    techs2.forEach((t)=>{ const stops=techStops(t.id); if(stops.length<2) return; const pts2=stops.map((v)=>{const p=mapProject(v.lat,v.lng);return p.x+','+p.y;}).join(' '); svg+=`<polyline points="${pts2}" fill="none" stroke="${t.pc}" stroke-width="2" stroke-dasharray="4 4" opacity=".5"/>`; });
    jobs.forEach((v)=>{ const p=mapProject(v.lat,v.lng); const r=readinessOf(v); const c=r.level==='blocked'?'var(--warn)':(r.level==='at_risk'?'var(--amb)':'var(--ok)'); svg+=`<g class="jobpin" transform="translate(${p.x},${p.y})" onclick="LabUI.jumpVisit('${v.id}')"><circle r="5" fill="${c}" stroke="var(--panel)" stroke-width="1.5"/></g>`; });
    techs2.forEach((t)=>{ const pos=liveTruckPos(t.id); if(!pos) return; const p=mapProject(pos.lat,pos.lng); svg+=`<g class="truck ${pos.moving?'moving':''}" data-tech="${t.id}" opacity="${pos.stale?0.55:1}" transform="translate(${p.x},${p.y})"><title>${t.n} \u00b7 ${pos.vehicleName||''}${pos.stale?' \u00b7 stale fix':''}</title><circle class="ring" r="14" fill="${t.pc}" opacity="0"/><circle class="tbody" r="13" fill="${pos.stale?'#b6bfcc':t.pc}" stroke="var(--panel)" stroke-width="2"/><text class="tlabel">${t.ini}</text></g>`; });
    return svg+`</svg>`;
  }
  // Which engine backs a given store, and whether a real map is possible at all.
  function mapUseMapbox(){ return MAPENGINE==='mapbox' && !!mbToken() && typeof mapboxgl!=='undefined'; }
  function mapViewStore(){ return mapUseMapbox() ? state.mbView : state.mlView; }
  function mapBgStore(){ return mapUseMapbox() ? state.mbBg : state.mlBg; }
  function mapBuildInto(store, containerId, interactive){
    if(mapUseMapbox()) mbBuild(store, containerId, interactive);
    else mlBuild(store, containerId, interactive);
  }
  function renderMap(){
    const board=document.getElementById('board');
    // There is always a real map now: Mapbox if its token works, keyless
    // MapLibre otherwise. Only a total library outage falls through to the SVG,
    // and that is decided asynchronously inside mlBuild()'s catch.
    {
      if(!document.getElementById('mbboard')){
        board.className='board'; board.style.width='';
        board.innerHTML=`<div class="mapwrap">
          <div class="mapctl">${mapPeriodCtlHTML()}</div>
          <div id="mbboard" class="mbboard"><div id="maploading"><span class="sp"></span>Loading map…</div></div>
          <div class="maplegend">${mapLegendHTML()}</div>
        </div>`;
        mapBuildInto(mapViewStore(),'mbboard',true);
      } else {
        const ctl=document.querySelector('.mapwrap .mapctl'); if(ctl) ctl.innerHTML=mapPeriodCtlHTML();
        mapBuildInto(mapViewStore(),'mbboard',true);   // no-op once built
        mbUpdate(mapViewStore());
      }
      return;
    }
  }
  // Last resort, reached only if BOTH map libraries are unreachable: the flat
  // SVG, drawn into the map container so the tab is never just empty.
  function clearMapLoading(){ const el=document.getElementById('maploading'); if(el) el.remove(); }
  function mapSvgFallbackInto(containerId){
    clearMapLoading();
    const el=document.getElementById(containerId); if(!el) return;
    const svg=buildMapSVG('meet');
    el.innerHTML = svg || '<div class="dayempty" style="position:static;margin:16px">🗺️ No mapped jobs for '+mapPeriodLabel()+' — visits need coordinates to appear on the map.</div>';
  }
  // Isometric "SimCity of the service area" — stylized city built on the REAL town
  // positions (Greenwich / Cos Cob / Riverside / Old Greenwich / Stamford / the Sound),
  // roads wired shop→jobs, extruded buildings clustered by town, trucks driving as iso
  // vehicles. Used ONLY as the dimmed background behind the Day board.
  function shade(hex,f){ const n=parseInt(hex.slice(1),16); const r=Math.max(0,Math.min(255,Math.round(((n>>16)&255)*f))), g=Math.max(0,Math.min(255,Math.round(((n>>8)&255)*f))), b=Math.max(0,Math.min(255,Math.round((n&255)*f))); return '#'+((1<<24)+(r<<16)+(g<<8)+b).toString(16).slice(1); }
  function buildCitySVG(){
    const techs2=visibleTechs(); const jobs=mapVisits('board');
    const pts=jobs.map((v)=>[v.lat,v.lng]).concat([[window.LAB.office.lat,window.LAB.office.lng]]);
    if(!pts.length) return '';
    const lats=pts.map((p)=>p[0]), lngs=pts.map((p)=>p[1]);
    const B={w:Math.min.apply(0,lngs)-0.014,e:Math.max.apply(0,lngs)+0.014,n:Math.max.apply(0,lats)+0.014,s:Math.min.apply(0,lats)-0.03};
    const G=14, TW=64, TH=32, OX=MAP_W/2, OY=64;
    const hsh=(k)=>{ const x=Math.sin(k*127.13+311.7)*43758.5453; return x-Math.floor(x); };
    const gxy=(lat,lng)=>[ (lng-B.w)/((B.e-B.w)||1)*G, (B.n-lat)/((B.n-B.s)||1)*G ];
    const iso=(gx,gy)=>({ x: OX+(gx-gy)*TW/2, y: OY+(gx+gy)*TH/2 });
    PROJ=(lat,lng)=>{ const g=gxy(lat,lng); return iso(g[0],g[1]); };
    // town centroids in grid space (for building density)
    const byCity={}; jobs.forEach((v)=>{ (byCity[v.city]=byCity[v.city]||[]).push(v); });
    const cents=Object.keys(byCity).map((c)=>{ const a=byCity[c]; const la=a.reduce((s,v)=>s+v.lat,0)/a.length, ln=a.reduce((s,v)=>s+v.lng,0)/a.length; const g=gxy(la,ln); return {c,gx:g[0],gy:g[1]}; });
    const og=gxy(window.LAB.office.lat,window.LAB.office.lng); const shopC=Math.round(og[0]), shopR=Math.round(og[1]);
    // roads: shop → each stop in order, L-shaped Manhattan walk
    const road=new Set(); const rk=(c,r)=>c+','+r;
    const mark=(a,b)=>{ let c=Math.round(a[0]), r=Math.round(a[1]); const c1=Math.round(b[0]), r1=Math.round(b[1]); while(c!==c1){ road.add(rk(c,r)); c+=c1>c?1:-1; } road.add(rk(c,r)); while(r!==r1){ road.add(rk(c1,r)); r+=r1>r?1:-1; } road.add(rk(c1,r)); };
    techs2.forEach((t)=>{ const stops=techStops(t.id); if(!stops.length) return; let prev=og; stops.forEach((v)=>{ const g=gxy(v.lat,v.lng); mark(prev,g); prev=g; }); });
    const jobTiles=new Set(jobs.map((v)=>{ const g=gxy(v.lat,v.lng); return rk(Math.round(g[0]),Math.round(g[1])); }));
    const ROOFS=['#c66a45','#7f8a5f','#b98a49','#8b909a','#a86750','#6f7f8c','#b0743f'];
    let ground='', objs=[]; // objs: {d, s} depth-sorted
    for(let r=0;r<G;r++) for(let c=0;c<G;c++){
      const p=iso(c,r); const k=rk(c,r); const isRoad=road.has(k);
      const grass = ((r+c)%2===0)?'#3e6a3a':'#446f3e';
      const fill = isRoad ? '#54575d' : grass;
      ground+=`<polygon points="${p.x},${p.y-TH/2} ${p.x+TW/2},${p.y} ${p.x},${p.y+TH/2} ${p.x-TW/2},${p.y}" fill="${fill}" stroke="${isRoad?'#4a4d53':shade(fill,.9)}" stroke-width="1"/>`;
      if(isRoad){ ground+=`<line x1="${p.x-TW/4}" y1="${p.y-TH/4}" x2="${p.x+TW/4}" y2="${p.y+TH/4}" stroke="#c9cbb8" stroke-width="1.5" stroke-dasharray="3 5" opacity=".55"/>`; }
      if(isRoad || jobTiles.has(k) || (c===shopC&&r===shopR)) continue;
      // building density: denser near a town centroid
      let dmin=99; cents.forEach((ct)=>{ const d=Math.abs(ct.gx-c)+Math.abs(ct.gy-r); if(d<dmin)dmin=d; });
      const prob=Math.max(0.05, 0.9 - dmin*0.14);
      if(hsh(r*97+c*13+7) < prob){
        const roof=ROOFS[Math.floor(hsh(r*31+c*17)*ROOFS.length)%ROOFS.length];
        const H=12+Math.round(hsh(c*53+r*29)*44*Math.max(0.35,1-dmin*0.1));
        const hw=TW*0.30, hh=TH*0.30, cx=p.x, cy=p.y;
        const s=`<g><polygon points="${cx-hw},${cy} ${cx},${cy+hh} ${cx},${cy-H+hh} ${cx-hw},${cy-H}" fill="${shade(roof,.6)}"/>`+
          `<polygon points="${cx+hw},${cy} ${cx},${cy+hh} ${cx},${cy-H+hh} ${cx+hw},${cy-H}" fill="${shade(roof,.82)}"/>`+
          `<polygon points="${cx},${cy-H-hh} ${cx+hw},${cy-H} ${cx},${cy-H+hh} ${cx-hw},${cy-H}" fill="${roof}"/></g>`;
        objs.push({d:c+r, s});
      }
    }
    // Long Island Sound: water band across the southern (bottom) edge
    const sTop=OY+(G-1)*TH; let water=`<rect x="0" y="${sTop}" width="${MAP_W}" height="${MAP_H-sTop}" fill="#23506b"/>`;
    for(let i=0;i<5;i++) water+=`<line x1="0" y1="${sTop+14+i*22}" x2="${MAP_W}" y2="${sTop+8+i*22}" stroke="#3a6f8c" stroke-width="2" opacity=".5"/>`;
    // shop (civic building) + town labels + job beacons + trucks — depth sorted with buildings
    const sp=iso(shopC,shopR);
    objs.push({d:shopC+shopR, s:`<g><polygon points="${sp.x-24},${sp.y} ${sp.x},${sp.y+12} ${sp.x},${sp.y-30} ${sp.x-24},${sp.y-42}" fill="${shade('#8b909a',.6)}"/><polygon points="${sp.x+24},${sp.y} ${sp.x},${sp.y+12} ${sp.x},${sp.y-30} ${sp.x+24},${sp.y-42}" fill="${shade('#8b909a',.82)}"/><polygon points="${sp.x},${sp.y-54} ${sp.x+24},${sp.y-42} ${sp.x},${sp.y-30} ${sp.x-24},${sp.y-42}" fill="#9aa0aa"/><text x="${sp.x}" y="${sp.y-38}" style="font-size:15px;text-anchor:middle;dominant-baseline:central">🏢</text></g>`});
    cents.forEach((ct)=>{ const p=iso(ct.gx,ct.gy); objs.push({d:-99, s:`<text x="${p.x}" y="${p.y-46}" class="townlbl" style="text-anchor:middle;font-weight:700">${ct.c}</text>`}); });
    jobs.forEach((v)=>{ const g=gxy(v.lat,v.lng); const p=iso(g[0],g[1]); const rr=readinessOf(v); const cc=rr.level==='blocked'?'#e0564a':(rr.level==='at_risk'?'#e0a12e':'#39b174'); objs.push({d:g[0]+g[1]+0.5, s:`<g><line x1="${p.x}" y1="${p.y}" x2="${p.x}" y2="${p.y-26}" stroke="${cc}" stroke-width="2"/><circle cx="${p.x}" cy="${p.y-28}" r="5" fill="${cc}" stroke="#fff" stroke-width="1.2"/></g>`}); });
    objs.sort((a,b)=>a.d-b.d);
    let trucks='';
    techs2.forEach((t)=>{ const pos=liveTruckPos(t.id); if(!pos) return; const p=PROJ(pos.lat,pos.lng); trucks+=`<g class="truck ${pos.moving?'moving':''}" data-tech="${t.id}" transform="translate(${p.x},${p.y})"><ellipse class="ring" cx="0" cy="3" rx="16" ry="8" fill="${t.pc}" opacity="0"/><polygon points="-11,3 0,9 0,-4 -11,-2" fill="${shade(t.pc,.62)}"/><polygon points="11,3 0,9 0,-4 11,-2" fill="${shade(t.pc,.84)}"/><polygon points="0,-11 11,-2 0,4 -11,-2" fill="${t.pc}" stroke="#fff" stroke-width="1"/><text class="tlabel" y="-2">${t.ini}</text></g>`; });
    return `<svg viewBox="0 0 ${MAP_W} ${MAP_H}" style="width:100%;height:100%;display:block" preserveAspectRatio="xMidYMid slice">`+
      `<rect width="${MAP_W}" height="${MAP_H}" fill="#2c4a2b"/>`+water+ground+objs.map((o)=>o.s).join('')+trucks+`</svg>`;
  }
  /* ---- map engine: Mapbox when its token works, MapLibre when it doesn't ----
     A shared Mapbox token is baked into index.html, so this was never a
     per-user setup step. What it IS is a single point of failure: the token
     can expire, hit its quota, or be URL-restricted to the production domain,
     and a preview deploy runs on a different host. The old error handler
     removed the map and nulled the store on any auth-shaped error, which left
     an empty container and NO explanation -- the map simply wasn't there.

     Now a Mapbox failure falls back to MapLibre GL over keyless OpenStreetMap
     raster tiles: no token, no account, nothing to configure, so there is
     always a map. What is lost in the fallback is Mapbox's 3D buildings and
     terrain, and the legend says so rather than pretending nothing happened.
     Rotate and tilt work in both -- MapLibre renders raster tiles in
     perspective the same way. */
  let MAPENGINE = 'mapbox';   // flips to 'maplibre' if Mapbox can't authenticate
  let MAPNOTE = '';           // why we fell back, shown in the legend
  let _mlPromise = null;
  const ML_CDN = { js:'https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js',
                   css:'https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css' };
  function loadMapLibre(){
    if(window.maplibregl) return Promise.resolve(window.maplibregl);
    if(_mlPromise) return _mlPromise;
    _mlPromise = new Promise((resolve, reject)=>{
      const css=document.createElement('link'); css.rel='stylesheet'; css.href=ML_CDN.css; document.head.appendChild(css);
      const s=document.createElement('script'); s.src=ML_CDN.js; s.async=true;
      s.onload=()=>{ window.maplibregl ? resolve(window.maplibregl) : reject(new Error('library did not initialise')); };
      s.onerror=()=>reject(new Error('library unreachable'));
      document.head.appendChild(s);
    });
    return _mlPromise;
  }
  function mapFallback(why){
    if(MAPENGINE==='maplibre') return;
    MAPENGINE='maplibre'; MAPNOTE=why||'Mapbox unavailable';
    try{ if(state.mbView.map) state.mbView.map.remove(); }catch(e){}
    try{ if(state.mbBg.map) state.mbBg.map.remove(); }catch(e){}
    state.mbView={map:null,markers:{},ready:false}; state.mbBg={map:null,markers:{},ready:false};
    const b=document.getElementById('mbboard'); if(b) b.innerHTML='';
    const bg=document.getElementById('mapbg'); if(bg) bg.innerHTML='';
    render();
  }
  // Keyless OSM raster. Rotate/tilt behave exactly as they do on a vector style.
  function mlStyle(){
    return { version:8,
      sources:{ osm:{ type:'raster', tileSize:256, maxzoom:19,
        tiles:['https://a.tile.openstreetmap.org/{z}/{x}/{y}.png',
               'https://b.tile.openstreetmap.org/{z}/{x}/{y}.png',
               'https://c.tile.openstreetmap.org/{z}/{x}/{y}.png'],
        attribution:'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' } },
      layers:[{ id:'osm', type:'raster', source:'osm' }] };
  }
  function mapStartCamera(interactive){
    const off=window.LAB.office;
    const cam=(BSTATE_BOOT && BSTATE_BOOT.cam) || null;
    if(cam && interactive) return { center:[cam.lng,cam.lat], zoom:cam.zoom, bearing:cam.bearing, pitch:cam.pitch };
    // Open on the shop. This used to be the plain average of the day's job
    // coordinates -- unguarded, so a single far-off geocode dragged the centre
    // with it, and at zoom 13.2 the board opened on a neighbourhood miles from
    // anywhere anyone works. mapFitStore() widens this to frame the period.
    // A configured service area carries its own zoom, derived from the radius,
    // so a 5-mile division and a 40-mile one no longer open at the same scale.
    // The literals stay as the fallback for an unconfigured company.
    const z = (off && Number.isFinite(off.zoom)) ? (interactive ? off.zoom : off.zoom + 0.6)
                                                 : (interactive ? 12.6 : 13.2);
    return { center:[off.lng, off.lat], zoom: z, bearing:-20, pitch:62 };
  }
  function mlBuild(store, containerId, interactive){
    if(store.map || store.building) return;
    store.building=true;
    loadMapLibre().then((gl)=>{
      store.building=false;
      if(store.map) return;
      const el=document.getElementById(containerId); if(!el) return;
      const cam=mapStartCamera(interactive);
      let map;
      try{ map=new gl.Map({ container:el, style:mlStyle(), center:cam.center, zoom:cam.zoom,
        bearing:cam.bearing, pitch:cam.pitch, maxPitch:75, interactive:!!interactive,
        attributionControl:{compact:true} }); }
      catch(e){ MAPNOTE='Map failed to start ('+e.message+')'; renderMapLegend(); return; }
      store.map=map; store.gl=gl; store.ready=false; store.markers={}; store.jobMarkers={};
      mapAutoResize(map, el);
      if(interactive){
        map.addControl(new gl.NavigationControl({ showZoom:true, showCompass:true, visualizePitch:true }), 'top-right');
        map.addControl(new gl.ScaleControl({ unit:'imperial' }), 'bottom-right');
        try{ map.touchZoomRotate.enable(); map.touchPitch.enable(); map.dragRotate.enable(); }catch(e){}
        addTiltControl(map);
        mapWireCamera(map);
      }
      map.on('load',()=>{ store.ready=true; clearMapLoading(); mbAddJobs(store, interactive); mbAddMarkers(store);
        mapFitStore(store, interactive?null:'board');   // fit on build, not only on period change
        // In an iframe the container is often not laid out yet when the map mounts.
        try{ map.resize(); }catch(e){}
        setTimeout(()=>{ try{ map.resize(); }catch(e){} }, 80);
        setTimeout(()=>{ try{ map.resize(); }catch(e){} }, 320); });
    }).catch((e)=>{ store.building=false;
      MAPNOTE='Map library unreachable ('+e.message+') — showing the simple map.';
      mapSvgFallbackInto(containerId); renderMapLegend(); });
  }
  // Tilt slider. Neither library's NavigationControl ships a pitch control, and
  // right-drag is not discoverable, so this is the visible one.
  function addTiltControl(map){
    const wrap=document.querySelector('.mapwrap'); if(!wrap || wrap.querySelector('.maptilt')) return;
    const box=document.createElement('div');
    box.className='maptilt';
    box.innerHTML='<span>TILT</span><input type="range" min="0" max="75" step="1" aria-label="Map tilt angle"><b>0&deg;</b>';
    const sl=box.querySelector('input'), lbl=box.querySelector('b');
    const sync=()=>{ const p=Math.round(map.getPitch()); sl.value=String(p); lbl.textContent=p+'°'; };
    sl.addEventListener('input',()=>{ const v=Number(sl.value)||0; try{ map.easeTo({pitch:v, around:shopLngLat(), duration:0}); }catch(e){} lbl.textContent=Math.round(v)+'°'; });
    map.on('pitch', sync);
    wrap.appendChild(box); sync();
  }
  // Persist the camera as the user moves it (render() debounces the write).
  function mapWireCamera(map){
    ['moveend','zoomend','rotateend','pitchend'].forEach((ev)=>map.on(ev, ()=>boardStateSave()));
  }


  /* ---- Preferences follow the user, not this browser (CLAUDE.md) ----------
   *
   * This board is a same-origin iframe inside HiveLogic -- it already asks the
   * parent for its auth token and its theme by postMessage -- so the parent's
   * hlUserSettings, backed by profiles.settings, is reachable from here.
   *
   * Before this, pasting a Mapbox or Google key set it up on ONE browser.
   * Open the board on the laptop and the map is a grey box asking for a key
   * he already gave it.
   *
   * localStorage stays as the cache and is still written, so the map does not
   * wait on a round trip before it can draw.
   *
   * NOTE: sl_theme is NOT migrated and is not a violation. This board's own
   * theme toggle is hidden (#themeBtn{display:none!important}); the theme is
   * pushed down from HiveLogic, and sl_theme is only a local mirror so
   * applyTheme can restore it before the parent's message arrives. The
   * preference it mirrors already follows the user, one level up.
   */
  function parentSettings(){
    try { return (window.parent && window.parent !== window && window.parent.hlUserSettings) || null; }
    catch(e){ return null; }   // cross-origin, which should not happen here
  }
  function boardPref(key, legacyKey){
    var ps = parentSettings();
    if(ps){ try{ var v = ps.get(key, undefined); if(v !== undefined) return v; }catch(e){} }
    try{ return localStorage.getItem(legacyKey) || ''; }catch(e){ return ''; }
  }
  function boardPrefSet(key, legacyKey, value){
    try{ if(value === null) localStorage.removeItem(legacyKey); else localStorage.setItem(legacyKey, value); }catch(e){}
    var ps = parentSettings();
    if(ps){ try{ ps.set(key, value).catch(function(){}); }catch(e){} }
  }

  // ---- Real 3D map behind the Day board (Mapbox GL) ----
  // The user's free public token is stored ONLY in their browser (localStorage);
  // it is never sent to HiveLogic. buildCitySVG() above remains as an offline fallback.
  function mbToken(){ try{ return (window.HL_MAPBOX_TOKEN||boardPref('mapboxToken','hl_mapbox_token')||'').trim(); }catch(e){ return (window.HL_MAPBOX_TOKEN||'').trim(); } }
  function mbResetStores(){ ['mbBg','mbView','mlView','mlBg'].forEach((k)=>{ if(state[k] && state[k].map){ try{ state[k].map.remove(); }catch(e){} } state[k]={map:null,markers:{},ready:false}; }); }
  window.saveMbToken=(v)=>{ v=(v||'').trim(); if(!/^pk\./.test(v)){ const inp=document.getElementById('mbTokIn'); if(inp){ inp.classList.add('bad'); inp.placeholder='That doesn’t look like a pk. token — paste the Default public token'; } return; }
    boardPrefSet('mapboxToken','hl_mapbox_token',v);
    MAPENGINE='mapbox'; MAPNOTE='';
    mbResetStores(); const bg=document.getElementById('mapbg'); if(bg) bg.innerHTML=''; render(); syncMapTimer(); };
  window.clearMbToken=()=>{ boardPrefSet('mapboxToken','hl_mapbox_token',null); mbResetStores(); const bg=document.getElementById('mapbg'); if(bg) bg.innerHTML=''; render(); };
  function mbTokenPrompt(bg,err){
    bg.innerHTML=`<div class="tokprompt"><div class="tp-card">
      <div class="tp-h">🗺 Real 3D map — one-time setup</div>
      <p>Paste your free <b>Mapbox public token</b> (starts with <code>pk.</code>) to load a real 3D map of your service area behind the schedule.</p>
      ${err?`<div class="tp-err">⚠ ${err}</div>`:''}
      <input id="mbTokIn" type="text" spellcheck="false" autocomplete="off" placeholder="pk.eyJ1Ijoi…">
      <div class="tp-row"><button class="pri" onclick="saveMbToken(document.getElementById('mbTokIn').value)">Load map</button>
        <a href="https://account.mapbox.com/auth/signup/" target="_blank" rel="noopener">Get a free token →</a></div>
      <div class="tp-note">Stored only in this browser (localStorage). Never sent to HiveLogic. Free tier ≈ 50k loads/mo, no credit card.</div>
    </div></div>`;
    const inp=document.getElementById('mbTokIn'); if(inp) inp.addEventListener('keydown',(e)=>{ if(e.key==='Enter') saveMbToken(inp.value); });
  }
  // Build one Mapbox instance into `containerId`. `interactive` = pannable (Map tab)
  // vs a static dimmed backdrop (Day background). Both use the real service-area bounds.
  // Exaggerate real building footprints into a SimCity-style toy skyline: pump heights
  // ~4.5×, tilt hard, color by height. Turns low-rise suburbia into a game-ish cityscape.
  function mbAdd3D(map){
    try{
      if(map.getLayer('hl-3d-buildings')) return;
      const layers=(map.getStyle()&&map.getStyle().layers)||[];
      const lbl=layers.find((l)=>l.type==='symbol'&&l.layout&&l.layout['text-field']);
      const H=['*',['coalesce',['to-number',['get','height']],9],4.5];
      map.addLayer({ id:'hl-3d-buildings', source:'composite','source-layer':'building', type:'fill-extrusion', minzoom:9.5,
        paint:{
          'fill-extrusion-color':['interpolate',['linear'],H, 0,'#f0e2c0', 60,'#e8b374', 130,'#dd8452', 260,'#c65b4e'],
          'fill-extrusion-height':H,
          'fill-extrusion-base':['coalesce',['to-number',['get','min_height']],0],
          'fill-extrusion-opacity':0.92
        } }, lbl && lbl.id);
    }catch(e){}
  }
  // A fixed-timeout nudge cannot know when the container actually gets its size.
  // Restoring straight into the Map tab -- which persisted view state now does on
  // every return visit -- mounts the map before the layout has settled, and the
  // 60/300ms nudges both fire too early. The canvas then stays blank (no tiles, no
  // pins, no trucks) until something else happens to trigger a resize; it does not
  // recover on its own. Watch the container and resize when its size really changes.
  // Self-disconnecting: the store is replaced wholesale on teardown, so there is no
  // reference left to clean up by hand.
  function mapAutoResize(map, el){
    if(!el || typeof ResizeObserver!=='function') return;
    let ro;
    const stop=()=>{ try{ ro.disconnect(); }catch(_){} };
    try{
      ro=new ResizeObserver(()=>{
        if(!el.isConnected) return stop();       // container dropped from the DOM
        try{ map.resize(); }catch(_){ stop(); }  // map already removed
      });
      ro.observe(el);
    }catch(_){}
  }
  function mbBuild(store, containerId, interactive){
    if(store.map || typeof mapboxgl==='undefined') return;
    try{ mapboxgl.accessToken=mbToken(); }catch(e){}
    const cam0=mapStartCamera(interactive);
    let map;
    try{ map=new mapboxgl.Map({container:containerId, style:'mapbox://styles/mapbox/standard', center:cam0.center, zoom:cam0.zoom, pitch:cam0.pitch, bearing:cam0.bearing, interactive:!!interactive, attributionControl:false, fadeDuration:0, antialias:!!interactive, preserveDrawingBuffer:false, refreshExpiredTiles:false}); }
    catch(e){ return; }
    store.map=map; store.gl=mapboxgl; store.ready=false; store.markers={};
    mapAutoResize(map, document.getElementById(containerId));
    map.on('error',(e)=>{ const m=(e&&e.error&&e.error.message)||'';
      // Previously this removed the map and nulled the store, leaving an empty
      // box with no explanation. Hand over to the keyless engine instead.
      if(/access token|401|403|Unauthorized|not authorized|quota|rate limit/i.test(m)){
        mapFallback('Mapbox rejected this token — showing the keyless map (no 3D buildings). '+m);
      } });
    map.on('style.load',()=>{ try{ map.setConfigProperty('basemap','lightPreset','day'); map.setConfigProperty('basemap','show3dObjects',true); }catch(_){}
      // Terrain is GPU-heavy — only on the full interactive Map tab, not the dimmed background.
      if(interactive){ try{ if(!map.getSource('mapbox-dem')) map.addSource('mapbox-dem',{type:'raster-dem',url:'mapbox://mapbox.mapbox-terrain-dem-v1',tileSize:512,maxzoom:14}); map.setTerrain({source:'mapbox-dem',exaggeration:1.6}); }catch(_){} } });
    if(interactive){
      try{ map.addControl(new mapboxgl.NavigationControl({ showZoom:true, showCompass:true, visualizePitch:true }), 'top-right'); }catch(e){}
      try{ map.addControl(new mapboxgl.ScaleControl({ unit:'imperial' }), 'bottom-right'); }catch(e){}
      addTiltControl(map); mapWireCamera(map);
    }
    map.on('load',()=>{
      store.ready=true;
      const cam=(BSTATE_BOOT && BSTATE_BOOT.cam) || null;
      try{ if(cam && interactive){ map.setPitch(cam.pitch); map.setBearing(cam.bearing); } else { map.setPitch(62); map.setBearing(-20); } }catch(_){}
      clearMapLoading();
      mbAddJobs(store, interactive);
      mbAddMarkers(store);
      mapFitStore(store, interactive?null:'board');   // fit on build, not only on period change
      // In an iframe the container often isn't fully laid out when the map mounts →
      // blank canvas until a resize. Nudge it a few times.
      try{ map.resize(); setTimeout(()=>{try{map.resize();}catch(_){}},60); setTimeout(()=>{try{map.resize();}catch(_){}},300); }catch(_){}
    });
  }
  /* ---- hover detail on a map pin ------------------------------------------
     Same discipline the Command Center map arrived at: the popup opens on hover
     and, crucially, lets go of the pointer again. It tracks where the mouse
     actually is rather than trusting a mouseleave, because the popup's own
     container is a fresh DOM node every time it opens -- a node dropped under a
     cursor that is already still never gets the hover state mouseleave needs,
     and the popup ends up stranded with no way to dismiss it.
     Only the interactive Map tab uses this. The Day backdrop is
     pointer-events:none by design, so nothing there can be hovered at all. */
  const mapEsc=(s)=>String(s==null?'':s).replace(/[&<>"']/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function mapHoverPopup(store, el, mk, htmlFn){
    const gl = store.gl || window.mapboxgl;
    if(!gl || !gl.Popup || !store.map) return null;
    const pop = new gl.Popup({ offset:16, maxWidth:'280px', closeButton:false, closeOnClick:false, className:'mbpop' });
    let hideTimer=null;
    const overIt=(node)=>{
      if(!node || !node.nodeType) return false;
      if(el.contains(node)) return true;
      const pe=pop.getElement();
      return !!(pe && pe.contains(node));
    };
    const onDocMove=(ev)=>{
      if(overIt(ev.target)){ if(hideTimer){ clearTimeout(hideTimer); hideTimer=null; } return; }
      hide();
    };
    const close=()=>{
      if(hideTimer){ clearTimeout(hideTimer); hideTimer=null; }
      document.removeEventListener('mousemove', onDocMove, true);
      try{ pop.remove(); }catch(e){}
    };
    // A grace period so crossing the gap from the pin to the popup does not
    // dismiss it. The countdown is never restarted once running, or a pointer
    // moving steadily across the map would push it out forever.
    const hide=()=>{
      if(hideTimer) return;
      hideTimer=setTimeout(()=>{ hideTimer=null; close(); }, 180);
    };
    const show=()=>{
      if(hideTimer){ clearTimeout(hideTimer); hideTimer=null; }
      if(el.style.display==='none') return;
      const html=htmlFn(); if(!html) return;
      pop.setHTML(html);                       // re-read on every hover: a truck moves and its status changes
      if(pop.isOpen && pop.isOpen()) return;   // re-adding would rebuild the container under the cursor
      try{ pop.setLngLat(mk.getLngLat()); }catch(e){}
      pop.addTo(store.map);
      document.addEventListener('mousemove', onDocMove, true);
    };
    el.addEventListener('mouseenter', show);
    el.addEventListener('mouseleave', hide);
    pop.on('open',()=>{
      const pe=pop.getElement(); if(!pe) return;
      pe.addEventListener('mouseenter', show);
      pe.addEventListener('mouseleave', hide);
    });
    // Panning or leaving the map means the reader has moved on, and the pointer
    // may never cross the popup again to say so.
    try{
      store.map.on('movestart', close);
      const c=store.map.getContainer && store.map.getContainer();
      if(c) c.addEventListener('mouseleave', close);
    }catch(e){}
    return close;
  }
  // What a job pin says. Real fields only. The street address is the client's
  // own, from client_locations via schedule_range -- until that was wired up
  // the pin's tooltip showed an address invented from a hash of the client's
  // name, and a pin is no use if it names a house that does not exist.
  function jobPinHTML(v){
    const t=techById(effectiveTech(v))||techById(v.t);
    const r=readinessOf(v);
    const crew=(v.crew&&v.crew.length)
      ? v.crew.map((c)=>mapEsc(c.n)+(c.lead?' <span style="color:var(--mut)">(lead)</span>':'')).join(', ')
      : (t?mapEsc(t.n):'<span style="color:var(--warn)">No crew assigned</span>');
    return '<div class="mbpop-b">'
      + '<b>'+mapEsc(v.client||v.type||'Visit')+'</b>'
      + ((v.clientAddr||v.city)?('<div class="mbpop-s">'+mapEsc(v.clientAddr||v.city)+'</div>'):'')
      + '<hr>'
      + '<div>'+cardIcon(v)+' '+(v.jobNo?('#'+mapEsc(v.jobNo)+' '):'')+mapEsc(v.type||'')+'</div>'
      + '<div class="mbpop-s">'+mapEsc(dLabel(v.date))+' · '+mapEsc(fmt(effectiveStart(v)))+'–'+mapEsc(fmt(effectiveEnd(v)))+'</div>'
      + '<div class="mbpop-s">'+crew+'</div>'
      + '<div style="margin-top:5px"><span class="rpill '+r.level+'">'+RDY[r.level].l+'</span> '
      + mapEsc(r.why||'good to start')+'</div>'
      + '<div class="mbpop-h">Click the pin to look around this address →</div>'
      + '</div>';
  }
  function truckPinHTML(t){
    const pos=liveTruckPos(t.id);
    if(!pos) return '';
    const now=dayVisits(t.id).filter((v)=>v.date===state.date);
    const mins=pos.updatedAt ? Math.round((Date.now()-new Date(pos.updatedAt).getTime())/60000) : null;
    return '<div class="mbpop-b">'
      + '<b>'+mapEsc(t.n)+'</b>'
      + (pos.vehicleName?('<div class="mbpop-s">'+mapEsc(pos.vehicleName)+'</div>'):'')
      + '<hr>'
      + '<div>'+mapEsc(pos.status||'Unknown')
      + (pos.speed!=null?(' · '+Math.round(pos.speed)+' mph'):'')+'</div>'
      + '<div class="mbpop-s"'+(pos.stale?' style="color:var(--warn)"':'')+'>'
      + (mins==null?'No timestamp on this fix':('Position '+(mins<1?'just now':(mins+' min ago'))+(pos.stale?' — stale':'')))
      + '</div>'
      + '<div class="mbpop-s">'+(now.length?(now.length+' job'+(now.length===1?'':'s')+' today'):'Nothing scheduled today')+'</div>'
      + '</div>';
  }
  function mbAddMarkers(store){
    if(!store.map) return;
    // Reconcile, don't just add: a crew that loses its GPS fix must lose its
    // truck rather than freeze at its last known spot.
    const shown={}; visibleTechs().forEach((t)=>{ if(liveTruckPos(t.id)) shown[t.id]=t; });
    Object.keys(store.markers).forEach((id)=>{ if(shown[id]) return; const m=store.markers[id];
      try{ if(m.closePop) m.closePop(); }catch(e){}   // a pin's popup must not outlive the pin
      try{ m.mk.remove(); }catch(e){} delete store.markers[id]; });
    Object.keys(shown).forEach((id)=>{ if(store.markers[id]) return; const t=shown[id]; const pos=liveTruckPos(id);
      const el=document.createElement('div'); el.className='mbtruck'; el.style.background=t.pc; el.textContent=t.ini;
      try{ const mk=new (store.gl||window.mapboxgl).Marker({element:el}).setLngLat([pos.lng,pos.lat]).addTo(store.map); store.markers[id]={mk,el};
        if(store===state.mbView || store===state.mlView) store.markers[id].closePop=mapHoverPopup(store, el, mk, ()=>truckPinHTML(t)); }
      catch(e){ console.warn('truck marker failed for '+id, e); } });
  }
  // Every active job pinned at its address, readiness-colored. On the interactive Map
  // tab, clicking a pin opens Street View "Look around" for that house.
  /* The camera is set once when a map is built. Without this, building the
     backdrop on a day with no jobs (centred on the shop at zoom 13.2) and then
     switching to Week left the week's pins outside the viewport -- the map
     looked empty while actually holding every pin. Refit whenever the period
     changes, and only then, so it never fights a user who has panned. */
  function mapFitStore(store, scope){
    const map=store.map, gl=store.gl; if(!map||!gl) return;
    const off=window.LAB.office;
    const pts=mapVisits(scope).map((v)=>[v.lng,v.lat]);
    // Same outlier guard Command Center needed: one bad-geocoded job must not
    // drag the zoom out to uselessness.
    const near=pts.filter((p)=>Math.abs(p[1]-off.lat)<1.2 && Math.abs(p[0]-off.lng)<1.5);
    if(!near.length){ try{ map.easeTo({center:[off.lng,off.lat], zoom:12.4, duration:400}); }catch(e){} return; }
    try{
      // The shop is the fixed point of this map: it is the pivot for rotate and
      // tilt, and the work reads as "how far out from the yard". Fitting the raw
      // pin bounds put the yard wherever the day's jobs happened to average out.
      // Extending every pin with its mirror image through the shop makes the
      // bounds symmetric about it, so fitBounds centres on the shop and still
      // frames each pin.
      const b=new gl.LngLatBounds([off.lng,off.lat], [off.lng,off.lat]);
      near.forEach((p)=>{ b.extend(p); b.extend([2*off.lng - p[0], 2*off.lat - p[1]]); });
      map.fitBounds(b, { padding:60, maxZoom:14, duration:400 });
    }catch(e){}
  }
  function mbAddJobs(store, interactive){
    if(!store.map) return; store.jobMarkers=store.jobMarkers||{};
    const scope = interactive ? null : 'board';
    const jobs=mapVisits(scope);
    const r=mapPeriodRange(scope), fitKey=r.start+'|'+r.end;
    const firstBuild = store.fitKey === undefined;
    const periodChanged = !firstBuild && store.fitKey !== fitKey;
    store.fitKey = fitKey;
    // Drop pins that have left the visible period FIRST. Without this the layer
    // only ever grew: every day you navigated through kept its pins on the map,
    // so the map showed a union of everywhere you'd looked rather than the
    // period you were actually on.
    const want=mapVisitIds(interactive?null:'board');
    Object.keys(store.jobMarkers).forEach((id)=>{ if(want[id]) return; const m=store.jobMarkers[id];
      try{ if(m.closePop) m.closePop(); }catch(e){}   // a pin's popup must not outlive the pin
      try{ m.mk.remove(); }catch(e){} delete store.jobMarkers[id]; });
    // spread pins that share the exact same synthetic coord so they don't fully stack
    const seen={};
    jobs.forEach((v)=>{ if(store.jobMarkers[v.id]) return;
      const key=v.lat.toFixed(3)+','+v.lng.toFixed(3); const n=(seen[key]=(seen[key]||0)+1)-1;
      const ang=n*2.399, rad=n?0.0006*Math.ceil(n/6):0; const jlng=v.lng+Math.cos(ang)*rad, jlat=v.lat+Math.sin(ang)*rad;
      const r=readinessOf(v); const cc=r.level==='blocked'?'#e0564a':(r.level==='at_risk'?'#e0a12e':'#39b174');
      const el=document.createElement('div'); el.className='mbjob'; el.style.background=cc;
      // No title attribute on the interactive map: the hover popup says all of
      // this and more, and the browser's own tooltip would sit on top of it.
      if(!interactive) el.title=[v.client,v.type,v.clientAddr||v.city].filter(Boolean).join(' · ');
      if(interactive){ el.style.cursor='pointer'; el.addEventListener('click',()=>{ openLookAround(v.lat,v.lng,v.clientAddr||[v.client,v.city].filter(Boolean).join(', ')); }); }
      try{ const mk=new (store.gl||window.mapboxgl).Marker({element:el}).setLngLat([jlng,jlat]).addTo(store.map); store.jobMarkers[v.id]={mk,el};
        if(interactive) store.jobMarkers[v.id].closePop=mapHoverPopup(store, el, mk, ()=>jobPinHTML(v)); }
      catch(e){ console.warn('job pin failed for '+v.id, e); }
    });
    // Fit on the first build too, not only when the period changes. Without it
    // the backdrop kept whatever mapStartCamera() guessed and never framed the
    // day's work at all -- the first fit only ever arrived after a day-nav.
    // The Map tab is excluded: its first camera is the one restored from the
    // user's last visit, and a fit would throw that away.
    if(periodChanged || (firstBuild && !interactive)){ mapFitStore(store, scope); store.__refit = !interactive; }
  }
  function mbUpdate(store){
    if(!store.map||!store.ready) return;
    mbAddJobs(store, store===state.mbView);   // keeps pins in step with the period / day nav
    mbAddMarkers(store);   // a crew may have gained or lost a fix since the last poll
    visibleTechs().forEach((t)=>{ const m=store.markers[t.id]; if(!m) return; const pos=liveTruckPos(t.id); if(!pos) return;
      try{ m.mk.setLngLat([pos.lng,pos.lat]); }catch(e){}
      m.el.classList.toggle('moving',pos.moving);
      m.el.style.opacity = pos.stale ? '0.55' : '1';
      if(!m.closePop) m.el.title = t.n+' \u00b7 '+(pos.vehicleName||'')+' \u00b7 '+(pos.status||'')+(pos.stale?' (stale fix)':'');
    });
  }
  // Controls for the BACKGROUND map. The map surface stays pointer-events:none so
  // it can never swallow a click meant for a calendar card; only this cluster is
  // clickable. A non-interactive map still responds to programmatic camera calls.
  function wireBackdropControls(map){
    const host=document.getElementById('mapbgctl');
    const tilt=document.getElementById('mapbgtilt');
    if(!host||!tilt) return;
    if(host.__wired && host.__map===map) return;
    host.__wired=true; host.__map=map;
    host.innerHTML='';
    [['+', 'Zoom in', ()=>map.zoomIn()],
     ['\u2212', 'Zoom out', ()=>map.zoomOut()],
     ['\u21bb', 'Rotate 45\u00b0 around the shop', ()=>{ try{ map.easeTo({bearing:(map.getBearing()+45)%360, around:shopLngLat()}); }catch(e){} }],
     ['\u25b2', 'Reset north & tilt', ()=>{ try{ map.easeTo({bearing:0, pitch:0, around:shopLngLat()}); }catch(e){} }],
     ['\u2316', "Fit this period's jobs", ()=>mapFitStore(mapBgStore(),'board')]
    ].forEach(([label,title,fn])=>{
      const b=document.createElement('button');
      b.type='button'; b.title=title; b.setAttribute('aria-label',title); b.textContent=label;
      b.onclick=(e)=>{ e.stopPropagation(); fn(); boardStateSave(); };
      host.appendChild(b);
    });
    const sl=tilt.querySelector('input'), lbl=tilt.querySelector('b');
    const sync=()=>{ const p=Math.round(map.getPitch()); sl.value=String(p); lbl.textContent=p+'\u00b0'; };
    sl.oninput=()=>{ const v=Number(sl.value)||0; try{ map.easeTo({pitch:v, around:shopLngLat(), duration:0}); }catch(e){} lbl.textContent=Math.round(v)+'\u00b0'; boardStateSave(); };
    map.on('pitch', sync); sync();
  }

  function renderMapBg(){
    const bg=document.getElementById('mapbg'); if(!bg) return;
    // Automatic: the live map sits behind BOTH calendar views unless the user
    // turns it off. It used to be off by default and Day-only.
    const wantOn = state.mapBg && (state.view==='day' || state.view==='week');
    bg.classList.toggle('on', wantOn);
    document.body.classList.toggle('map-under', wantOn);
    bg.classList.remove('prompt');    // no token gate any more -- the keyless engine always has a map
    if(!wantOn) return;               // keep the instance alive, just hidden
    if(!document.getElementById('mbcanvas')){ bg.innerHTML='<div id="mbcanvas" style="position:absolute;inset:0"></div>'; }
    mapBuildInto(mapBgStore(),'mbcanvas',false); mbUpdate(mapBgStore());
    const st=mapBgStore();
    if(st.map){
      wireBackdropControls(st.map);
      // mapAutoResize() already watches the container for both engines, so the
      // size itself is handled. What it cannot know is that a resize invalidates
      // the FIT: fitBounds picked a zoom for the old dimensions, so the pins are
      // framed wrong even once the canvas is correct. Re-fit after the new size
      // has settled, only when the period actually changed.
      try{ st.map.resize(); }catch(e){}
      setTimeout(()=>{ try{ st.map.resize(); if(st.__refit){ st.__refit=false; mapFitStore(st,'board'); } }catch(e){} }, 80);
    }
  }
  function updateTrucks(){
    const svgTrucks=()=>document.querySelectorAll('.truck[data-tech]').forEach((g)=>{ const id=g.getAttribute('data-tech'); const pos=liveTruckPos(id); if(!pos){ g.setAttribute('opacity','0'); return; } const p=PROJ(pos.lat,pos.lng); g.setAttribute('opacity',pos.stale?'0.55':'1'); g.setAttribute('transform',`translate(${p.x},${p.y})`); g.classList.toggle('moving',pos.moving); });
    if(state.view==='map'){ const st=mapViewStore(); if(st.map) mbUpdate(st); else svgTrucks(); }
    else if(state.mapBg && (state.view==='day' || state.view==='week') && mapBgStore().map){ mbUpdate(mapBgStore()); }
    else svgTrucks();
    renderMapLegend();   // keep the tracked/stale counts and the fix age honest
  }
  // The clock only ticks for the Map tab's "Play". The background map is static (trucks
  // sit at their current positions) so nothing repaints behind the scrolling board.
  // Was the play-clock ticker for the simulation; now it is the live GPS poll.
  // 60s matches Command Center's cadence. Runs only while a map is actually on
  // screen, and pauses with the tab.
  function syncMapTimer(){
    const want = (state.view==='map') || (state.mapBg && (state.view==='day' || state.view==='week'));
    if(want && !state.mapTimer){ loadLiveGps(); state.mapTimer=setInterval(()=>{ if(document.hidden) return; loadLiveGps(); }, 60000); }
    else if(!want && state.mapTimer){ clearInterval(state.mapTimer); state.mapTimer=null; }
  }
  window.toggleMapBg=()=>{ state.mapBg=!state.mapBg; const b=document.getElementById('mapBgBtn'); if(b)b.classList.toggle('on',state.mapBg); renderMapBg(); syncMapTimer(); };

  // ---- "Look around" (Google Street View) — identify a house at street level ----
  // Google Maps key lives ONLY in the user's browser (localStorage); never sent to HiveLogic.
  var __gmapsLoading=false, __gmapsQueue=[];
  function googKey(){ try{ return (window.HL_GOOGLE_KEY||boardPref('googleMapsKey','hl_google_key')||'').trim(); }catch(e){ return (window.HL_GOOGLE_KEY||'').trim(); } }
  function loadGoogleMaps(cb){
    if(window.google&&window.google.maps&&window.google.maps.StreetViewPanorama){ cb(); return true; }
    __gmapsQueue.push(cb);
    if(__gmapsLoading) return true;
    const key=googKey(); if(!key) return false;
    __gmapsLoading=true;
    window.__gmapsReady=function(){ const q=__gmapsQueue.splice(0); q.forEach((f)=>{ try{ f(); }catch(e){} }); };
    const s=document.createElement('script'); s.async=true;
    s.src='https://maps.googleapis.com/maps/api/js?key='+encodeURIComponent(key)+'&v=weekly&loading=async&libraries=geometry&callback=__gmapsReady';
    s.onerror=function(){ __gmapsLoading=false; const b=document.getElementById('laBody'); if(b) b.innerHTML='<div class="lamsg">Couldn’t load Google Maps — check the key is valid and billing is enabled on the project.</div>'; };
    document.head.appendChild(s); return true;
  }
  function gkPrompt(body){
    body.innerHTML=`<div class="tokprompt" style="position:relative;background:transparent"><div class="tp-card">
      <div class="tp-h">🏠 Look around — one-time Google setup</div>
      <p>Paste your <b>Google Maps API key</b> (starts with <code>AIza</code>) to turn on Street View for identifying houses.</p>
      <input id="gkIn" type="text" spellcheck="false" autocomplete="off" placeholder="AIzaSy…">
      <div class="tp-row"><button class="pri" onclick="saveGoogKey(document.getElementById('gkIn').value)">Enable Street View</button>
        <a href="https://console.cloud.google.com/google/maps-apis/credentials" target="_blank" rel="noopener">Get a key →</a></div>
      <div class="tp-note">Needs <b>Maps JavaScript API</b> enabled + billing on the Google Cloud project. Stored only in this browser; never sent to HiveLogic.</div>
    </div></div>`;
    const inp=document.getElementById('gkIn'); if(inp) inp.addEventListener('keydown',(e)=>{ if(e.key==='Enter') saveGoogKey(inp.value); });
  }
  window.saveGoogKey=(v)=>{ v=(v||'').trim(); if(v.length<20 || !/^AIza/.test(v)){ const i=document.getElementById('gkIn'); if(i){ i.classList.add('bad'); i.placeholder='That doesn’t look like a Google key (starts with AIza)'; } return; }
    boardPrefSet('googleMapsKey','hl_google_key',v);
    const p=window.__laPending; if(p) openLookAround(p.lat,p.lng,p.label); };
  // Free, no-key Street View: open Google Maps' public Street View for the address in
  // a new tab. (An embedded/in-app panorama would require a Google key with billing;
  // this route needs neither.) If a Google key IS present, use the richer in-app modal.
  window.openLookAround=(lat,lng,label)=>{
    if(!googKey()){
      const url='https://www.google.com/maps/@?api=1&map_action=pano&viewpoint='+lat+','+lng;
      window.open(url,'_blank','noopener'); return;
    }
    const modal=document.getElementById('lookaround'), body=document.getElementById('laBody'), title=document.getElementById('laTitle');
    if(!modal||!body){ window.open('https://www.google.com/maps/@?api=1&map_action=pano&viewpoint='+lat+','+lng,'_blank','noopener'); return; }
    modal.classList.remove('hidden'); if(title) title.textContent='🏠 Look around'+(label?' · '+label:''); window.__laPending={lat,lng,label};
    body.innerHTML='<div class="lamsg">Loading Street View…</div>';
    loadGoogleMaps(function(){
      try{
        const sv=new google.maps.StreetViewService();
        sv.getPanorama({location:{lat,lng},radius:80,source:google.maps.StreetViewSource.OUTDOOR},function(data,status){
          if(status==='OK'&&data&&data.location){
            body.innerHTML='<div id="laPano" style="position:absolute;inset:0"></div>';
            let heading=0; try{ heading=google.maps.geometry.spherical.computeHeading(data.location.latLng,new google.maps.LatLng(lat,lng)); }catch(e){}
            new google.maps.StreetViewPanorama(document.getElementById('laPano'),{pano:data.location.pano,pov:{heading,pitch:2},zoom:0,addressControl:true,motionTracking:false,fullscreenControl:true,linksControl:true});
          } else { body.innerHTML='<div class="lamsg">No Street View imagery within ~80m of this address.</div>'; }
        });
      }catch(e){ body.innerHTML='<div class="lamsg">Street View error: '+((e&&e.message)||e)+'</div>'; }
    });
  };
  window.closeLookAround=()=>{ const m=document.getElementById('lookaround'); if(m) m.classList.add('hidden'); const b=document.getElementById('laBody'); if(b) b.innerHTML=''; };
  function emptyState(msg){
    return `<div style="padding:56px 20px;text-align:center;color:var(--mut)"><div style="font-size:32px">🗓️</div><b style="font-size:15px">${msg}</b>
      <div style="margin-top:6px;font-size:12px">Try <b>Week</b> to see the whole week, or press <b>Today</b>.</div></div>`;
  }

  // ---- unassigned ----
  let drag=null, ghostEl=null;
  // Rule 3: the rail holds DEMANDS (what needs doing), each with a "Schedule this" action
  function renderUnassigned(){
    document.getElementById('unpanel').classList.toggle('open', state.unOpen);
    document.getElementById('unCount').textContent=demands.length;
    // Every field here is optional, because these are real JOBS now and a job
    // row carries no required skill, no promised window, no priority and no
    // readiness. The old markup printed all five unconditionally, so with real
    // data it would have read "undefined · undefined" under every title --
    // and inventing values to fill them would put made-up urgency on a
    // dispatch board.
    const esc=(v)=>String(v==null?'':v).replace(/[&<>"]/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
    document.getElementById('unlist').innerHTML=demands.map((u)=>{
      const col=DIVCOLORS[u.div]||'#8b92a8';
      const who=[u.client,u.city].filter(Boolean).map(esc).join(' · ');
      const tags=[];
      if(u.jobNo) tags.push(`<span class="dtag">#${esc(u.jobNo)}</span>`);
      if(u.div) tags.push(`<span class="dtag">${esc(u.div)}</span>`);
      if(u.dur) tags.push(`<span class="dtag">⏱ ${esc(u.dur)}h</span>`);
      if(u.skill) tags.push(`<span class="dtag">🎓 ${esc(u.skill)}</span>`);
      if(u.window) tags.push(`<span class="dtag">📅 ${esc(u.window)}</span>`);
      if(u.total) tags.push(`<span class="dtag">$${Math.round(u.total).toLocaleString()}</span>`);
      const rl=u.ready&&RDY[u.ready]?u.ready:null;
      return `<div class="uncard demandcard" data-uid="${esc(u.id)}" style="border-left-color:${col}">
        <div style="display:flex;justify-content:space-between;gap:8px;align-items:start"><b>${esc(u.title)}</b>${u.priority?`<span class="pri">${esc(u.priority)}</span>`:''}</div>
        ${who?`<div class="meta">${who}</div>`:''}
        ${tags.length?`<div class="dmeta">${tags.join('')}</div>`:''}
        ${rl?`<div style="margin-bottom:7px"><span class="rpill ${rl}">${RDY[rl].l}${u.readyWhy?' · '+esc(u.readyWhy):''}</span></div>`:''}
        <button class="btn sm primary" style="width:100%" onclick="LabUI.scheduleThis('${esc(u.id)}')">⚡ Schedule this</button></div>`;
    }).join('')||'<div style="color:var(--mut);font-size:12px;padding:12px">No unscheduled work 🎉</div>';
    queueBoardViewport();   // the panel just changed width -- the map has to give way
  }

  // ---- day drag/drop ----
  function wireDay(){
    document.querySelectorAll('.job').forEach((el)=>{
      const vid=el.getAttribute('data-vid'); const ev=visits.find((z)=>z.id===vid);
      if(ev && !ev.locked){
        el.addEventListener('dragstart',(e)=>{drag={kind:'job',id:vid};el.classList.add('dragging');e.dataTransfer.effectAllowed='move';});
        el.addEventListener('dragend',()=>{el.classList.remove('dragging');clearGhost();});
      }
      el.addEventListener('click',()=>{ if(drag) return; (ev&&ev.locked)?openLockedSheet(vid):openJobSheet(vid); });
    });
    document.querySelectorAll('.lane').forEach((lane)=>{
      // Click an empty slot → open "+ Add" (job / task / onsite assessment…) prefilled
      // with this crew + the clicked time.
      lane.addEventListener('click',(e)=>{ if(drag) return; if(e.target!==lane) return; if(!canEdit()) return;
        const techId=lane.getAttribute('data-tech'); const HW=HRW(); const x=e.clientX-lane.getBoundingClientRect().left;
        const start=clampHr(snap(DAY_START+x/HW),2); openCreate(techId,start); });
      lane.addEventListener('dragover',(e)=>{ if(!drag)return; e.preventDefault(); e.dataTransfer.dropEffect='move'; lane.classList.add('drop'); showGhost(lane,e); });
      lane.addEventListener('dragleave',(e)=>{ if(e.target===lane){lane.classList.remove('drop');clearGhost();} });
      lane.addEventListener('drop',(e)=>{ e.preventDefault(); lane.classList.remove('drop'); clearGhost();
        const techId=lane.getAttribute('data-tech'); const start=dropStart(lane,e); if(!drag)return;
        if(drag.kind==='job'){ const dv=visits.find((z)=>z.id===drag.id);
          if(dv && dv.native){ hlMoveNative(dv,techId,start); }
          else canEdit()?openImpact(drag.id,techId,start):openChangeRequest(drag.id,techId,start); }
        else { canEdit()?openAssignConfirm(drag.id,techId,start):toast('Only Dispatch schedules unassigned work — ask them to assign it',false); }
        drag=null; });
    });
  }
  // Drag a HiveLogic-native appointment → persist the new time + assignee (never Jobber).
  function hlMoveNative(v, techId, start){
    drag=null;
    if(!canEdit()){ toast('Only Dispatch can move this',false); return; }
    const tech=techById(techId); const dur=v.e-v.s;
    const startISO=window.hlEtToUTC(v.date,start), endISO=window.hlEtToUTC(v.date,start+dur);
    const crewJids = (tech&&tech.jid) ? [tech.jid] : (v.crew||[]).map((c)=>{const t=techById(c.id);return t&&t.jid;}).filter(Boolean);
    window.hlPost('move_appointment', { id:v.apptId, start_at:startISO, end_at:endISO, crew_jids:crewJids, lead_jid:(tech&&tech.jid)?tech.jid:v.lead_jid })
      .then((r)=>{ if(r&&r.ok){ toast(`✅ Moved to ${tech?tech.n:'crew'} · ${fmt(start)}`,false); window.hlReload(); } else toast('⚠ Move failed: '+((r&&r.error)||'error'),false); });
  }
  function dropStart(lane,e){ const HW=HRW(); const x=e.clientX-lane.getBoundingClientRect().left;
    let dur=2; if(drag&&drag.kind==='job'){const v=visits.find((z)=>z.id===drag.id);dur=v.e-v.s;} else if(drag&&drag.kind==='un'){const u=unassigned.find((z)=>z.id===drag.id);dur=(u&&u.s)||2;}
    return clampHr(snap(DAY_START+x/HW),dur); }
  function showGhost(lane,e){ clearGhost(); const HW=HRW(); const start=dropStart(lane,e);
    let dur=2; if(drag.kind==='job'){const v=visits.find((z)=>z.id===drag.id);dur=v.e-v.s;} else {const u=unassigned.find((z)=>z.id===drag.id);dur=(u&&u.s)||2;}
    const techId=lane.getAttribute('data-tech');
    const bad=visits.some((v)=>v.t===techId&&v.date===state.date&&v.id!==(drag.kind==='job'?drag.id:null)&&start<v.e&&(start+dur)>v.s);
    ghostEl=document.createElement('div'); ghostEl.className='ghost'+(bad?' bad':''); ghostEl.style.left=(start-DAY_START)*HW+'px'; ghostEl.style.width=dur*HW+'px'; ghostEl.textContent=fmt(start)+(bad?' · conflict':''); lane.appendChild(ghostEl); }
  function clearGhost(){ if(ghostEl&&ghostEl.parentNode)ghostEl.parentNode.removeChild(ghostEl); ghostEl=null; }

  // ---- Change requests (non-dispatch roles → Dispatch) ----
  function openChangeRequest(vid,prefT,prefS){
    const v=visits.find((z)=>z.id===vid); if(!v)return; const dur=v.e-v.s;
    const body=`<div class="policybox"><b>${ROLE_LABELS[state.role]||state.role} — view / request only.</b>Propose the change below and send it to Dispatch to approve.</div>
      <div style="font-size:11px;color:var(--mut);margin-top:4px">Now: ${fmt(v.s)}–${fmt(v.e)} · ${techById(v.t)?techById(v.t).n:''} · ${v.client}${v.source==='jobber'?' · 🔒 Jobber':''}</div>
      <div style="display:flex;gap:8px;margin-top:8px"><div class="field" style="flex:1;margin:0"><label>New start</label><select id="cr_time">${timeOptions(prefS!=null?prefS:v.s)}</select></div><div class="field" style="flex:1;margin:0"><label>Crew</label><select id="cr_tech">${techOptions(prefT||v.t)}</select></div></div>
      <div class="field"><label>Reason for Dispatch (optional)</label><input id="cr_reason" placeholder="e.g. customer asked to move to the afternoon"/></div>`;
    modal({k:'Request a schedule change',title:`${v.jobNo?'#'+v.jobNo+' ':''}${v.type} · ${v.client}`,body,actions:[
      {label:'Cancel',cls:'',fn:()=>{closeModal();render();}},
      {label:'📨 Send to Dispatch',cls:'primary',fn:()=>{
        const nt=document.getElementById('cr_tech').value, ns=clampHr(parseFloat(document.getElementById('cr_time').value),dur);
        const toT=techById(nt), reason=(document.getElementById('cr_reason')||{}).value||'';
        state.changeRequests.push({id:'cr'+state.changeRequests.length+Date.now(),vid,techId:nt,start:ns,dur,by:state.role,byName:ROLE_LABELS[state.role]||state.role,reason,client:v.client,type:v.type,jobNo:v.jobNo,fromLabel:fmt(v.s)+'–'+fmt(v.e)+(techById(v.t)?' · '+techById(v.t).n:''),toLabel:fmt(ns)+'–'+fmt(ns+dur)+(toT?' · '+toT.n:''),status:'pending'});
        closeModal(); render(); toast('📨 Change request sent to Dispatch',false);
      }}]});
  }
  function renderReqBtn(){
    const b=document.getElementById('reqBtn'); if(!b) return;
    const pend=state.changeRequests.filter((r)=>r.status==='pending').length;
    if(canEdit()){ b.style.display=''; b.innerHTML=`📨 Requests${pend?' <span class="reqn">'+pend+'</span>':''}`; b.classList.toggle('has',pend>0); }
    else { const mine=state.changeRequests.filter((r)=>r.by===state.role); b.style.display=mine.length?'':'none'; b.innerHTML=`📨 My requests (${mine.length})`; b.classList.remove('has'); }
  }
  window.openRequests=()=>{
    const list = canEdit() ? state.changeRequests : state.changeRequests.filter((r)=>r.by===state.role);
    const pend=list.filter((r)=>r.status==='pending'), done=list.filter((r)=>r.status!=='pending');
    const card=(r)=>`<div class="layrow"><div style="display:flex;justify-content:space-between;gap:8px"><b>${r.jobNo?'#'+r.jobNo+' ':''}${r.type} · ${r.client}</b><span class="setpill">${r.status}</span></div>
      <div class="sub"><span class="from">${r.fromLabel}</span> → <span class="to">${r.toLabel}</span></div>
      <div class="sub">from ${r.byName}${r.reason?' · "'+r.reason+'"':''}</div>
      ${(canEdit()&&r.status==='pending')?`<div class="actrow" style="margin-top:6px"><button class="btn sm primary" onclick="LabUI.approveReq('${r.id}')">✓ Approve &amp; stage</button><button class="btn sm danger" onclick="LabUI.declineReq('${r.id}')">Decline</button></div>`:''}</div>`;
    const body=`${pend.length?'<div class="dlabel">Pending</div>'+pend.map(card).join(''):'<div style="color:var(--mut);font-size:12px;padding:6px 0">No pending requests.</div>'}${done.length?'<div class="dlabel" style="margin-top:10px">Resolved</div>'+done.map(card).join(''):''}`;
    modal({k:canEdit()?'Dispatch · change requests':'My change requests',title:canEdit()?'Requests to Dispatch':'Your requests',body,actions:[{label:'Close',cls:'primary',fn:closeModal}]});
  };

  // ---- impact / commit ----
  const freezeBlocks=(v)=>{ const m=(v.s-SIM_NOW)*60; return state.freezeOn&&state.date===TODAY&&m>=0&&m<SETUP.freezeMin; };
  const destConflict=(techId,start,dur,exceptId)=>visits.filter((v)=>v.t===techId&&v.date===state.date&&v.id!==exceptId&&start<v.e&&(start+dur)>v.s);

  function openImpact(vid,techId,start){
    const v=visits.find((z)=>z.id===vid); if(!v)return;
    const dur=v.e-v.s,end=start+dur,fromT=techById(v.t),toT=techById(techId);
    if(v.t===techId&&Math.abs(start-v.s)<0.01)return;
    const conf=destConflict(techId,start,dur,vid),frozen=freezeBlocks(v),rows=[];
    if(v.t!==techId)rows.push(['Crew',fromT.n,toT.n]);
    if(Math.abs(start-v.s)>0.01)rows.push(['Time',fmt(v.s)+'–'+fmt(v.e),fmt(start)+'–'+fmt(end)]);
    let body=`<div class="diff">`+rows.map((r)=>`<div class="lab">${r[0]}</div><div><span class="from">${r[1]}</span> → <span class="to">${r[2]}</span></div>`).join('')+`</div>`;
    if(v.pinned)body+=`<div class="warnbox">📌 This visit is pinned (customer-confirmed). Moving it overrides that lock.</div>`;
    if(conf.length)body+=`<div class="warnbox">⚠ Overlaps ${conf.map((c)=>c.client).join(', ')} on ${toT.n}'s day.</div>`;
    if(frozen)body+=`<div class="warnbox">🧊 Freeze window: starts in ${Math.round((v.s-SIM_NOW)*60)} min (inside 60m). Production needs a logged override.</div>`;
    body+=`<div style="font-size:10.5px;color:var(--mut);margin-top:8px">Lab preview — mirrors the guarded <span class="mono">move-visit</span> flow. No real write.</div>`;
    modal({k:'Confirm move',title:`${v.jobNo?'#'+v.jobNo+' ':''}${v.type}`,body,actions:[
      {label:'Cancel',cls:'',fn:closeModal},
      {label:frozen?'Override & move':'Confirm move',cls:frozen?'danger':'primary',fn:()=>{commitMove(vid,techId,start);closeModal();}}]});
  }
  function commitMove(vid,techId,start){ const v=visits.find((z)=>z.id===vid); const prev={t:v.t,s:v.s,e:v.e}; const dur=v.e-v.s;
    stageChange(`Moved ${v.client} → ${techById(techId).n} @ ${fmt(start)}`, ()=>{v.t=techId;v.s=start;v.e=start+dur;}, ()=>{Object.assign(v,prev);});
    toast('📋 Staged — review & publish to notify',false);
    const kd=KINDS[v.kind||'field']; if(kd&&kd.clientFacing&&v.source!=='jobber') setTimeout(()=>askApproval(v),90); }

  function openAssignConfirm(uid,techId,start){
    const u=unassigned.find((z)=>z.id===uid); if(!u)return; const dur=u.s||2,toT=techById(techId),conf=destConflict(techId,start,dur,null);
    let body=`<div class="diff"><div class="lab">Assign to</div><div class="to">${toT.n} @ ${fmt(start)}–${fmt(start+dur)}</div></div>`;
    if(u.reqStop)body+=`<div class="warnbox">🧰 Requires a material stop: ${u.reqStop}.</div>`;
    if(conf.length)body+=`<div class="warnbox">⚠ Overlaps ${conf.map((c)=>c.client).join(', ')} on ${toT.n}'s day.</div>`;
    modal({k:'Assign unassigned job',title:u.title,body,actions:[{label:'Cancel',cls:'',fn:closeModal},{label:'Assign',cls:'primary',fn:()=>{commitAssign(uid,techId,start);closeModal();}}]});
  }
  function commitAssign(uid,techId,start){ const i=unassigned.findIndex((z)=>z.id===uid); if(i<0)return; const u=unassigned[i],dur=u.s||2;
    visits.push({id:'v_'+uid,t:techId,date:state.date,s:start,e:start+dur,client:u.client,city:u.city,type:u.title,jobNo:null,div:u.div,status:'scheduled',pinned:false,vid:'lab_'+uid});
    unassigned.splice(i,1); state.undo={type:'assign',id:'v_'+uid,u}; render(); toast(`✅ Assigned ${u.client} → ${techById(techId).n}`,true); }

  // ---- sheets ----
  const timeOptions=(sel)=>{let o='';for(let h=DAY_START;h<=DAY_END-0.5;h+=0.5)o+=`<option value="${h}" ${Math.abs(h-sel)<0.01?'selected':''}>${fmt(h)}</option>`;return o;};
  const techOptions=(sel)=>techs.map((t)=>`<option value="${t.id}" ${t.id===sel?'selected':''}>${t.n} · ${t.crew}</option>`).join('');
  function cfBadge(v){
    if(v.confirm==='confirmed') return '<span class="cfbadge ok">✓ Confirmed</span>';
    if(v.confirm==='cancelled') return '<span class="cfbadge cx">🚫 Cancelled</span>';
    return '<span class="cfbadge no">⌛ Awaiting confirmation</span>';
  }
  function reminderRows(v){
    // simulated cadence status relative to the demo "now"
    const stat={d3:'Sent',d1:'Sent',d0:'Sent · 7am','h1':'Scheduled'};
    if(v.date>TODAY){ stat.d3=stat.d1=stat.d0='Scheduled'; }
    if(v.confirm==='confirmed'){ /* keep */ }
    return '<div class="remind">'+config.reminders.map((r)=>
      `<div class="rr ${r.on?'':'off'}"><span class="dot"></span>${r.l}<span class="st">${r.on?(stat[r.id]||'Scheduled'):'off'}</span></div>`).join('')+'</div>';
  }
  // Client contact + Reina conflict resolutions, for the job detail sheet
  /* The client's REAL details, as carried on the visit row.
     What used to be here was synthClient(): a phone number built from
     "(203) 555-" plus a hash of the client's name, an email of
     theirname@example.com, and a street address picked out of a list of seven
     by the same hash. It was honest enough when this board was a synthetic
     lab. It has been running on real Jobber data since, so every job sheet has
     been showing a dispatcher a phone number to call that belongs to nobody.
     Anything missing now reads as missing. A blank is recoverable — someone
     looks the client up. A plausible wrong number is not: it gets dialled. */
  function clientOf(v){
    return {
      name: v.client || 'Client',
      phone: v.clientPhone || null,
      email: v.clientEmail || null,
      addr: v.clientAddr || null,
      city: v.city || '',
    };
  }
  // +12035550134 -> (203) 555-0134. Anything that is not a plain North American
  // number is left exactly as stored rather than reformatted into something the
  // dialler might not reach.
  function phoneLabel(raw){
    const s=String(raw||'').trim(); if(!s) return '';
    const d=s.replace(/\D/g,'');
    const ten = d.length===11 && d[0]==='1' ? d.slice(1) : (d.length===10 ? d : null);
    return ten ? '('+ten.slice(0,3)+') '+ten.slice(3,6)+'-'+ten.slice(6) : s;
  }
  // The Client card. Every line is either a real value or an explicit "none on
  // file" -- never a placeholder that reads like a value.
  function clientCardHTML(v){
    const c=clientOf(v);
    const none=(what)=>'<span style="color:var(--mut)">No '+what+' on file</span>';
    const lines=[];
    lines.push(c.phone
      ? '\u{1F4DE} <a href="tel:'+mapEsc(String(c.phone).replace(/[^+0-9]/g,''))+'">'+mapEsc(phoneLabel(c.phone))+'</a>'
      : '\u{1F4DE} '+none('phone'));
    lines.push(c.email
      ? '\u2709 <a href="mailto:'+mapEsc(c.email)+'">'+mapEsc(c.email)+'</a>'
      : '\u2709 '+none('email'));
    lines.push(c.addr
      ? '\u{1F4CD} '+mapEsc(c.addr)
      : '\u{1F4CD} '+(c.city ? mapEsc(c.city)+' <span style="color:var(--mut)">— no street address on file</span>' : none('address')));
    const look = (v.lat&&v.lng)
      ? '<button class="labtn" onclick="openLookAround('+v.lat+','+v.lng+',\''+String(c.addr||[c.name,c.city].filter(Boolean).join(', ')).replace(/['"\\]/g,'')+'\')">\u{1F3E0} Look around</button>'
      : '';
    return '<div class="dsec"><div class="dlabel">Client</div><div class="dval"><b>'+mapEsc(c.name)+'</b>'
      + '<div class="dsub">'+lines.join('<br>')+'</div>'+look+'</div></div>';
  }
  function reinaResolutions(v){
    const out=[]; const r=readinessOf(v);
    if(r.level==='blocked') out.push({issue:'🚫 '+r.why, fix:'Chase the permit/inspection; hold the crew on interior work until it clears.'});
    else if(r.level==='at_risk'){
      const w=r.why||''; const fix = /Weather|rain|Travel|storm/i.test(w) ? 'Pull to the safe window and notify the client (see the weather banner).' : (/Material/i.test(w) ? 'Confirm the delivery ETA with the vendor before dispatch.' : 'Send the client an approval request now.');
      out.push({issue:'⚠ '+w, fix});
    }
    const ci=conflictInfo(v.t); if(ci.bad.has(v.id)){ const o=dayVisits(v.t).find((x)=>x.id!==v.id && x.s<v.e && v.s<x.e); out.push({issue:'⛔ Double-booked — overlaps '+(o?o.client:'another job'), fix:'Move one to a free slot, or split the crew.'}); }
    return out;
  }
  function infoSections(v){
    const t=techById(effectiveTech(v))||techById(v.t), es=effectiveStart(v), ee=effectiveEnd(v), rez=reinaResolutions(v);
    let h='';
    h+=clientCardHTML(v);
    h+=`<div class="dsec"><div class="dlabel">Job</div><div class="dval">${v.jobNo?'<b>#'+v.jobNo+'</b> · ':''}${cardIcon(v)} ${v.div}${v.source==='jobber'?' · <span style="color:var(--mut)">🔒 Jobber</span>':''}</div></div>`;
    h+=`<div class="dsec"><div class="dlabel">Work</div><div class="dval">${v.type} · ${outIcon(v)} ${exposureOf(v)==='outside'?'outside (weather-exposed)':'inside'}</div></div>`;
    h+=`<div class="dsec"><div class="dlabel">When</div><div class="dval">${dLabel(v.date)} · ${fmt(es)}–${fmt(ee)} · ${(ee-es)}h</div></div>`;
    h+=`<div class="dsec"><div class="dlabel">Assigned</div><div class="dval"><span class="av2" style="background:${t?t.pc:'#888'}">${t?t.ini:'?'}</span> <b>${t?t.n:'Unassigned'}</b>${t?' · '+t.crew:''}</div></div>`;
    h+=`<div class="dsec"><div class="dlabel">Conflicts &amp; Reina</div><div class="dval">${rez.length?rez.map((x)=>`<div class="rez"><div class="ri">${x.issue}</div><div class="rf">⬡ Reina: ${x.fix}</div></div>`).join(''):'<span style="color:var(--ok)">✓ No conflicts — good to run.</span>'}</div></div>`;
    return h;
  }
  function openJobSheet(vid){ const v=visits.find((z)=>z.id===vid); if(!v)return; const dur=v.e-v.s;
    const kd=KINDS[v.kind||'field'], clientFacing=kd&&kd.clientFacing;
    let body=`<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap"><span class="kind" style="background:var(--chip)">${kd.ic} ${kd.l}</span><span class="srcpill hivelogic">HiveLogic</span>${v.lifecycle==='proposed'?'<span class="srcpill" style="background:rgba(183,121,31,.16);color:var(--amb)">PROPOSED</span>':''}${clientFacing?cfBadge(v):''}</div>`;
    body+=infoSections(v);
    const proj=projectFor(v);
    if(proj) body+=`<div style="margin-top:8px"><button class="btn sm" onclick="LabUI.openProject('${proj.id}')">📊 Part of ${proj.name} — open project</button></div>`;
    if(v.lifecycle==='proposed') body+=`<div class="policybox" style="margin-top:8px"><b>Proposed — not booked yet</b>Offer this slot; when the client agrees, Book it.<div style="margin-top:6px"><button class="btn sm primary" onclick="LabUI.bookProposed('${vid}')">✓ Book (confirm)</button></div></div>`;
    const editable=canEdit();
    body+=`<div class="dlabel" style="margin:12px 0 4px">${editable?'Reschedule / reassign':'Propose a change (goes to Dispatch)'}</div>
      <div style="display:flex;gap:8px"><div class="field" style="flex:1;margin:0"><label>Start</label><select id="f_time">${timeOptions(v.s)}</select></div><div class="field" style="flex:1;margin:0"><label>${kd.scope==='sub'?'Sub':'Crew'}</label><select id="f_tech">${techOptions(v.t)}</select></div></div>`;
    if(editable){
      body+=`<div class="actrow" style="margin-top:10px">`;
      if(clientFacing && v.confirm!=='confirmed') body+=`<button class="btn sm primary" onclick="LabUI.confirmAppt('${vid}')">✓ Confirm</button><button class="btn sm" onclick="LabUI.requestApproval('${vid}')">📲 Request approval</button>`;
      if(clientFacing) body+=`<button class="btn sm" onclick="LabUI.sendReminderNow('${vid}')">📧 Reminder</button>`;
      body+=`<button class="btn sm" onclick="LabUI.togglePin('${vid}')">${v.pinned?'📌 Unpin':'📌 Pin'}</button><button class="btn sm" onclick="LabUI.cycleStatus('${vid}')">↻ ${STATUS[v.status].l}</button>`;
      if(clientFacing) body+=`<button class="btn sm danger" onclick="LabUI.cancelAppt('${vid}')">Cancel…</button>`;
      // The whole point of a site visit is the estimate that follows it. The
      // path existed -- the lead card has a "Start estimate" button -- but from
      // here the estimator had to remember the client, leave the board, find
      // the same lead again and press it there. Chris, 2026-08-23: "lets do all
      // 3." Shown only once the visit is done, and only when the appointment
      // carries the lead it was booked from, because without that id the
      // estimate cannot record where it came from and the lead never advances.
      if(v.kind==='sitevisit' && v.sourceLeadId && v.status==='done'){
        body+=`<button class="btn sm primary" onclick="LabUI.estimateFromVisit('${vid}')">✎ Write the estimate</button>`;
      }
      body+=`</div>`;
    } else {
      body+=`<div class="policybox" style="margin-top:8px"><b>${ROLE_LABELS[state.role]||state.role} — view / request only</b>Set the new time/crew above, then send it to Dispatch to approve.</div>`;
    }
    body+=`<details class="iclps"><summary>❓ What the symbols mean</summary>${iconLegendFor(v)}</details>`;
    modal({k:'Appointment',title:`${v.jobNo?'#'+v.jobNo+' ':''}${v.type}`,body,actions:[
      {label:'Close',cls:'',fn:closeModal},
      editable
        // 2026-08-25: "when i click 'apply move' nothing happens" -- this
        // unconditionally routed through openImpact()->commitMove(), which
        // is a local-only lab preview (its own body text says so: "No real
        // write") -- the appointment reverted on the next reload with no
        // visible error. The drag-and-drop path onto this same appointment
        // already does this correctly (wireDay()'s drop handler, above):
        // hlMoveNative() for a real native appointment (v.native, backed by
        // a real hl_appointments row), openImpact() only for the
        // non-native/no-apptId-yet case (e.g. a still-proposed visit).
        ? {label:'Apply move',cls:'primary',fn:()=>{const nt=document.getElementById('f_tech').value,ns=parseFloat(document.getElementById('f_time').value);closeModal();if(state.date!==v.date)state.date=v.date;const clamped=clampHr(ns,dur);if(v.native)hlMoveNative(v,nt,clamped);else openImpact(vid,nt,clamped);}}
        : {label:'📨 Request change',cls:'primary',fn:()=>{const nt=document.getElementById('f_tech').value,ns=parseFloat(document.getElementById('f_time').value);closeModal();if(state.date!==v.date)state.date=v.date;openChangeRequest(vid,nt,clampHr(ns,dur));}}]});
  }
  // Crew + clock controls (HiveLogic-native; never writes to Jobber).
  function crewPanel(v){
    const target = v.vid || v.apptId || '';
    const crew = v.crew || [];
    const me = window.HL_ME ? String(window.HL_ME) : '';
    const mine = me && crew.find((c)=>c.jid && String(c.jid)===me);
    // Dispatch gets the full panel. A crew member who is ON this job gets just
    // enough to take themselves off it — they can never touch anyone else.
    if(!canEdit()){
      if(!mine || mine.lead || !v.vid) return '';
      return `<div class="dsec"><div class="dlabel">You on this job</div><div class="dval">`
        + `<div class="crewmgr"><span class="cmw">Chained to ${crew.find((c)=>c.lead)?.n||'lead'}</span></div>`
        + `<div class="clockrow"><button class="labtn" onclick="hlSelfUnchain('${v.vid}','${me}')">⛓ Unchain me from this job</button></div>`
        + `<div style="font-size:10px;color:var(--mut);margin-top:4px">This drops the job only, not your crew. Dispatch gets a request to put you back on or move you.</div>`
        + `</div></div>`;
    }
    const others = visibleTechs().filter((t)=>t.jid && !crew.some((c)=>c.id===t.id));
    let h=`<div class="dsec"><div class="dlabel">Crew &amp; clock</div><div class="dval">`;
    h+=`<div class="crewmgr">`+(crew.length?crew.map((c)=>{ const t=techById(c.id); const on=t&&t.clockedIn; return `<span class="cmw"><span class="cwav${c.lead?' lead':''}" style="background:${c.pc}">${c.ini}</span>${c.n}${c.lead?' · lead':''}${on?' <b style="color:var(--ok)">● in</b>':''}${(!c.lead && v.vid && t&&t.jid)?`<button class="cmx" title="Make lead of this job" onclick="hlSetLead('${v.vid}','${t.jid}')">★</button><button class="cmx" title="Peel off to another job" onclick="hlUnchain('${v.vid}','${t.jid}')">✕</button>`:''}</span>`;}).join(''):'<span style="color:var(--mut)">No matched crew</span>')+`</div>`;
    if(v.vid && others.length) h+=`<div class="crewadd"><select id="chainSel">${others.map((t)=>`<option value="${t.jid}">${t.n} · ${t.crew}</option>`).join('')}</select><button class="labtn" onclick="hlChain('${v.vid}',document.getElementById('chainSel').value)">＋ Chain crew</button></div>`;
    if(crew.length) h+=`<div class="clockrow"><button class="labtn" onclick="hlClockCrew('${target}','${(v.client||'').replace(/['"\\]/g,'')}','in')">🕒 Clock crew IN</button><button class="labtn" onclick="hlClockCrew('${target}','','out')">Clock crew OUT</button></div>`;
    return h+`</div></div>`;
  }
  window.hlChain=(visit,jid)=>{ if(!jid)return; window.hlPost('chain',{visit_jid:visit,employee_jid:jid}).then((r)=>{ if(r&&r.ok){toast('✅ Crew chained on',false);window.hlReload();}else toast('⚠ '+((r&&r.error)||'chain failed'),false); }); };
  window.hlUnchain=(visit,jid)=>{ if(!jid)return; window.hlPost('unchain',{visit_jid:visit,employee_jid:jid}).then((r)=>{ if(r&&r.ok){toast('✅ Peeled off',false);window.hlReload();}else toast('⚠ '+((r&&r.error)||'failed'),false); }); };
  window.hlSetLead=(visit,jid)=>{ if(!jid)return; window.hlPost('set_visit_lead',{visit_jid:visit,employee_jid:jid}).then((r)=>{ if(r&&r.ok){toast('✅ Lead set for this job',false);window.hlReload();}else toast('⚠ '+((r&&r.error)||'could not set lead'),false); }); };
  window.hlSelfUnchain=(visit,jid)=>{ if(!confirm('Take yourself off this job? Your crew stays the same — dispatch gets a request to put you back on or move you.'))return; window.hlPost('self_unchain',{visit_jid:visit,employee_jid:jid}).then((r)=>{ if(r&&r.ok){toast('⛓ You’re off this job — dispatch notified',false);window.hlReload();}else toast('⚠ '+((r&&r.error)||'could not unchain'),false); }); };
  window.hlResolveRechain=(id,how)=>{ window.hlPost('resolve_rechain',{id:id,resolution:how}).then((r)=>{ if(r&&r.ok){toast(how==='rechain'?'✅ Put back on the job':'Request closed',false);window.hlReload();}else toast('⚠ '+((r&&r.error)||'failed'),false); }); };
  window.hlClockCrew=(target,label,dir)=>{
    const v=visits.find((x)=>x.vid===target||x.apptId===target); const crew=(v&&v.crew)||[];
    const jids=crew.map((c)=>{const t=techById(c.id);return t&&t.jid;}).filter(Boolean);
    if(!jids.length){toast('No crew to clock',false);return;}
    const leadC=crew.find((c)=>c.lead); const leadJid=leadC?(techById(leadC.id)||{}).jid:null;
    window.hlPost(dir==='in'?'clock_in':'clock_out',{employees:jids,lead_jid:leadJid,source:'board',target_kind:(v&&v.source==='hivelogic')?'hl_appointment':'jobber_visit',target_id:target,label:label}).then((r)=>{
      if(!(r&&r.ok)){ toast('⚠ '+((r&&r.error)||'clock failed'),false); return; }
      if(dir==='in'){
        // Say plainly what the position check could and couldn't confirm — an
        // unverifiable helper (no truck of their own) is NOT an accusation.
        const flagged=(r.flagged||[]).length, unver=(r.unverified||[]).length;
        let msg='🟢 Crew clocked in — '+jids.length+' time record'+(jids.length===1?'':'s');
        if(flagged) msg+=' · ⚠ '+flagged+' away from the lead';
        else if(unver) msg+=' · '+unver+' not GPS-verifiable';
        toast(msg,false);
      } else toast('⚪ Crew clocked out',false);
      window.hlReload();
    });
  };
  function openLockedSheet(vid){
    const v=visits.find((z)=>z.id===vid); if(!v)return;
    const hasOv=!!v.override, live=state.controlMode==='live';
    const eff = (hasOv&&live) ? `${fmt(v.override.s)}–${fmt(v.override.e)}` : `${fmt(v.s)}–${fmt(v.e)}`;
    const r=readinessOf(v);
    let body=`<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap"><span class="srcpill jobber">🔒 Jobber source</span><span class="srcpill ${live?'hivelogic':'jobber'}">${live?'HiveLogic managed':'Jobber managed'}</span></div>`;
    body+=infoSections(v);
    body+=crewPanel(v);
    if(hasOv && isRemoved(v)) body+=`<div class="policybox" style="margin-top:8px"><b>Source history</b>Jobber: ${fmt(v.s)}–${fmt(v.e)}${live?' — removed':' — still effective'} · HiveLogic proposal: take this off the board${live?' — effective':' — proposed'}</div>`;
    else if(hasOv) body+=`<div class="policybox" style="margin-top:8px"><b>Source history</b>Jobber: ${fmt(v.s)}–${fmt(v.e)}${live?' — now history':' — still effective'} · HiveLogic proposal: ${fmt(v.override.s)}–${fmt(v.override.e)}${live?' — effective':' — proposed'}</div>`;
    const actions=[{label:'Close',cls:'',fn:closeModal}];
    if(!canEdit()){
      body+=`<div class="policybox" style="margin-top:8px"><b>${ROLE_LABELS[state.role]||state.role} — view / request only</b>Ask Dispatch to change this Jobber job.</div>`;
      actions.push({label:'📨 Request change',cls:'primary',fn:()=>{closeModal();openChangeRequest(vid);}});
    } else if(state.controlMode==='mirror'){
      body+=`<div class="policybox" style="margin-top:8px;color:var(--amb)"><b>Mirror-only mode</b>Jobber runs this. You can PLAN an override (scenario only) but can't publish it until this crew is HiveLogic Live.</div>`;
      if(isRemoved(v)){
        actions.push({label:'↩ Restore to schedule',cls:'',fn:()=>{closeModal();restoreVisitScenario(vid);}});
      } else {
        actions.push({label:hasOv?'Update plan':'Plan override (scenario)',cls:'',fn:()=>{closeModal();openOverrideCreate(vid);}});
        actions.push({label:'🗑 Remove from schedule (scenario)',cls:'',fn:()=>{closeModal();removeVisitScenario(vid);}});
      }
    } else if(isRemoved(v)){
      actions.push({label:'↩ Restore to schedule',cls:'primary',fn:()=>{closeModal();restoreVisitScenario(vid);}});
    } else {
      actions.push({label:hasOv?'Update override':'Create override',cls:'primary',fn:()=>{closeModal();openOverrideCreate(vid);}});
      actions.push({label:'🗑 Remove from schedule',cls:'',fn:()=>{closeModal();removeVisitScenario(vid);}});
    }
    body+=`<details class="iclps"><summary>❓ What the symbols mean</summary>${iconLegendFor(v)}</details>`;
    modal({k:'Jobber job · '+(live?'HiveLogic live':'read-only source'),title:`${v.jobNo?'#'+v.jobNo+' ':''}${v.type}`,body,actions});
  }
  function openOverrideCreate(vid){
    const v=visits.find((z)=>z.id===vid); if(!v)return; const dur=v.e-v.s;
    const body=`<div class="policybox"><b>Override — never touches Jobber</b>Creates a HiveLogic planned version at a new time/crew, shown beside the Jobber original as <b>proposed</b>. When Jobber is turned off, the override becomes the real one.</div>
      <div style="display:flex;gap:8px;margin-top:8px"><div class="field" style="flex:1"><label>New start</label><select id="o_time">${timeOptions(v.s)}</select></div>
      <div class="field" style="flex:1"><label>Crew</label><select id="o_tech">${techOptions(v.t)}</select></div></div>`;
    modal({k:'Create HiveLogic override',title:`Override · ${v.type}`,body,actions:[
      {label:'Cancel',cls:'',fn:closeModal},
      {label:'Create override',cls:'primary',fn:()=>{const nt=document.getElementById('o_tech').value,ns=parseFloat(document.getElementById('o_time').value);commitOverride(vid,nt,clampHr(ns,dur));closeModal();}}]});
  }
  function commitOverride(vid,techId,start){
    const v=visits.find((z)=>z.id===vid); const dur=v.e-v.s; const prev=v.override;
    stageChange(`Override ${v.client} → ${techById(techId).n} @ ${fmt(start)}`,
      ()=>{ v.override={t:techId,s:start,e:start+dur,lifecycle:'proposed'}; },
      ()=>{ v.override=prev; });
    toast(state.controlMode==='live'?'📋 Staged override — effective on publish':'✎ Override staged as a proposal — Jobber untouched, one card',false);
  }
  // 2026-08-25: "in schedule tab when clicking a job... there should be an
  // option or button to remove the schedule." Same shape as commitOverride
  // above (stageChange, undoable, never touches Jobber) -- removing a
  // Jobber-mirrored job supersedes any time/crew override on it, so this
  // replaces v.override outright rather than layering onto it.
  function removeVisitScenario(vid){
    const v=visits.find((z)=>z.id===vid); if(!v)return; const prev=v.override;
    stageChange(`Remove ${v.client} · ${v.type} from the board`,
      ()=>{ v.override={removed:true,lifecycle:'proposed'}; },
      ()=>{ v.override=prev; });
    toast(state.controlMode==='live'?'🗑 Staged removal — effective on publish':'🗑 Removal staged as a proposal — Jobber untouched, one card',false);
  }
  function restoreVisitScenario(vid){
    const v=visits.find((z)=>z.id===vid); if(!v)return; const prev=v.override;
    stageChange(`Restore ${v.client} · ${v.type} to the board`,
      ()=>{ v.override=null; },
      ()=>{ v.override=prev; });
    toast('↩ Restored — back on the board',false);
  }
  function openAssignSheet(uid){ const u=unassigned.find((z)=>z.id===uid); if(!u)return;
    const body=`<div style="font-size:12px;margin-bottom:8px">${u.client} · ${u.city} · ${u.div}</div>
      <div class="field"><label>Assign to crew</label><select id="a_tech">${techOptions(techs[0].id)}</select></div>
      <div class="field"><label>Start time</label><select id="a_time">${timeOptions(9)}</select></div>
      ${u.reqStop?`<div class="warnbox">🧰 Needs material stop: ${u.reqStop}</div>`:''}
      ${state.view!=='day'?`<div style="font-size:11px;color:var(--mut)">Will assign on ${dLabel(state.date)} — switch Day to pick another date.</div>`:''}`;
    modal({k:'Assign unassigned',title:u.title,body,actions:[{label:'Cancel',cls:'',fn:closeModal},
      {label:'Assign',cls:'primary',fn:()=>{const nt=document.getElementById('a_tech').value,ns=parseFloat(document.getElementById('a_time').value);closeModal();if(state.view!=='day')state.view='day';openAssignConfirm(uid,nt,ns);}}]});
  }

  // ---- Client approval on drop + escalation ladder (AI call → portal → SMS → email) ----
  const APPROVAL_STEPS=[
    {ic:'🤖', l:'AI phone call (Reina)', ok:'answered — approved', no:'no answer'},
    {ic:'📱', l:'Client portal notification', ok:'confirmed in portal', no:'not opened'},
    {ic:'💬', l:'SMS to client', ok:'replied YES', no:'no reply'},
    {ic:'📧', l:'Email to client', ok:'clicked confirm', no:'no reply'}
  ];
  var APPR={vid:null, step:0};
  function askApproval(v){
    modal({k:'Client approval',title:'Is this time approved by the client?',
      body:`<div class="policybox"><b>${v.client}</b> — ${fmt(v.s)}–${fmt(v.e)}, ${dLabel(v.date)}.<br>Is the new time already approved by the client?</div>`,
      actions:[
        {label:'✅ Yes, approved',cls:'primary',fn:()=>{ v.confirm='confirmed'; v.lifecycle='confirmed'; closeModal(); render(); toast('✅ Marked approved',false); }},
        {label:'No — request approval',cls:'',fn:()=>{ v.confirm='unconfirmed'; APPR={vid:v.id,step:0}; renderApproval(); }}]});
  }
  function renderApproval(){
    const v=visits.find((z)=>z.id===APPR.vid); if(!v)return; const done=APPR.step;
    let body=`<div style="font-size:12px;margin-bottom:8px">${v.client} · ${fmt(v.s)}–${fmt(v.e)} · ${dLabel(v.date)}</div>`;
    body+='<div class="remind">'+APPROVAL_STEPS.map((s,i)=>{
      const state = i<done?'done':(i===done?'active':'off');
      const stTxt = i<done?('☎ '+s.no+' → escalated'):(i===done?'▶ in progress':'waiting');
      return `<div class="rr ${state==='off'?'off':''}"><span class="dot" style="${state==='done'?'background:var(--amb)':(state==='active'?'background:var(--accent)':'')}"></span>${s.ic} ${s.l}<span class="st">${stTxt}</span></div>`;
    }).join('')+'</div>';
    body+=`<div class="policybox" style="margin-top:8px"><b>⬡ Reina auto-escalates</b>Tries the AI call first; only moves to the next channel if there's no response, and updates the calendar the instant the client approves.</div>`;
    const actions=[{label:'Close',cls:'',fn:closeModal},
      {label:'✅ '+(done<APPROVAL_STEPS.length?APPROVAL_STEPS[done].ok:'client approves'),cls:'primary',fn:()=>{ v.confirm='confirmed'; v.lifecycle='confirmed'; closeModal(); render(); toast(`✅ ${v.client} approved via ${APPROVAL_STEPS[Math.min(done,3)].l} — calendar updated`,false); }}];
    if(done<APPROVAL_STEPS.length-1) actions.splice(1,0,{label:'☎ No response — next channel',cls:'',fn:()=>{ APPR.step++; renderApproval(); }});
    modal({k:'Getting client approval',title:'Step '+(done+1)+' · '+APPROVAL_STEPS[Math.min(done,3)].l,body,actions});
  }

  // ---- modal + toast ----
  function modal({k,title,body,actions}){
    document.getElementById('modal').innerHTML=`<div class="mh"><div class="k">${k}</div><h3>${title}</h3></div><div class="mb">${body}</div><div class="mf">${actions.map((a,i)=>`<button class="btn ${a.cls}" data-i="${i}">${a.label}</button>`).join('')}</div>`;
    document.querySelectorAll('#modal .mf .btn').forEach((b,i)=>b.addEventListener('click',actions[i].fn));
    document.getElementById('scrim').classList.add('on');
  }
  function closeModal(){ document.getElementById('scrim').classList.remove('on'); }
  document.getElementById('scrim').addEventListener('click',(e)=>{ if(e.target.id==='scrim')closeModal(); });

  // ---- Tech status sheet (click a crew rail) ----
  window.openTechSheet=(id)=>{
    const t=techById(id); if(!t) return;
    const vs=dayVisits(id).slice().sort((a,b)=>effectiveStart(a)-effectiveStart(b));
    const hrs=hoursFor(id);
    let cur=null; vs.forEach((v)=>{ if(SIM_NOW>=effectiveStart(v)&&SIM_NOW<=effectiveEnd(v)) cur=v; });
    const next=vs.filter((v)=>effectiveStart(v)>SIM_NOW)[0];
    const STTCOL={on_site:'var(--ok)',en_route:'#3f7fd0',at_shop:'var(--mut)',clocked:'var(--accent)',idle:'var(--mut)'};
    const stt = (t.live&&t.live.label) ? [t.live.label, STTCOL[t.live.cls]||'var(--mut)'] : ['Scheduled','var(--mut)'];
    const doing = cur?`On site · ${cur.client}${cur.jobNo?' (#'+cur.jobNo+')':''}`
      : (next?`Next: ${next.client}${next.city?' · '+next.city:''} at ${fmt(effectiveStart(next))}`:'No more stops today');
    let body='';
    body+=`<div class="dsec"><div class="dlabel">Status now</div><div class="dval"><b style="color:${stt[1]}">● ${stt[0]}</b> · ${doing}</div></div>`;
    // Real data only: GPS state comes from tech_live_status (t.live); location from the
    // real schedule. No fabricated speed or mileage.
    body+=`<div class="dsec"><div class="dlabel">Location &amp; GPS</div><div class="dval">📍 ${cur?('On site · '+(cur.city||cur.client)):(next?('Heading to '+(next.city||next.client)):'—')}<div class="dsub">${t.vehicle?(t.live&&t.live.label?('Live GPS · '+t.live.label):'Vehicle GPS connected'):'No vehicle GPS — schedule-based only'}</div></div></div>`;
    const rows = vs.length?vs.map((v)=>{ const r=readinessOf(v); const dot=r.level==='blocked'?'🔴':(r.level==='at_risk'?'🟡':'🟢'); const isCur=v===cur; return `<div class="rez"${isCur?' style="outline:2px solid var(--accent);border-radius:8px"':''}><div class="ri">${dot} ${fmt(effectiveStart(v))}–${fmt(effectiveEnd(v))} · ${v.client} · ${v.type}</div><div class="rf">${v.city||''}${v.jobNo?' · #'+v.jobNo:''}${isCur?' · ◀ now':''}</div></div>`; }).join(''):'<span style="color:var(--mut)">No jobs today.</span>';
    body+=`<div class="dsec"><div class="dlabel">Today · ${vs.length} jobs · ${hrs}h</div><div class="dval">${rows}</div></div>`;
    body+=`<div class="dsec"><div class="dlabel">History</div><div class="dval"><span class="histchip" onclick="techHistory('${id}','today')">📆 Today’s timeline</span> <span class="histchip" onclick="techHistory('${id}','week')">🗓️ Last 7 days</span> <span class="histchip" onclick="techHistory('${id}','done')">✅ Completed jobs</span><div id="techHist" class="dsub" style="margin-top:8px"></div></div></div>`;
    const actions=[{label:'Close',cls:'',fn:closeModal},{label:'🗺 Show on map',cls:'',fn:()=>{ closeModal(); state.view='map'; render(); }}];
    modal({k:'Crew · live status',title:`${t.ini} · ${t.n} · ${t.crew}`,body,actions});
  };
  window.techHistory=(id,mode)=>{
    const el=document.getElementById('techHist'); if(!el) return;
    if(mode==='today'){ const n=dayVisits(id).length; el.innerHTML=n+' stop'+(n===1?'':'s')+' · '+hoursFor(id)+'h scheduled today.'; return; }
    if(mode==='week'){ el.innerHTML='Last-7-days history isn’t wired to live data yet.'; return; }
    const done=visits.filter((v)=>v.t===id && v.status==='done').slice(0,6);
    el.innerHTML=done.length?('Completed today: '+done.map((v)=>`${v.client}${v.jobNo?' (#'+v.jobNo+')':''}`).join(' · ')+'.'):'No completed jobs recorded for this crew yet.';
  };
  let toastTimer=null;
  function toast(msg,undoable){ const t=document.getElementById('toast'); t.innerHTML=msg+(undoable&&state.undo?' <a onclick="LabUI.undo()">Undo</a>':''); t.classList.add('on'); clearTimeout(toastTimer); toastTimer=setTimeout(()=>t.classList.remove('on'),6000); }

  // ---- public handlers ----
  window.LabUI={
    toggleUnassigned(open){ state.unOpen=open!=null?open:!state.unOpen; renderUnassigned(); },
    togglePerson(id){ state.hidden.has(id)?state.hidden.delete(id):state.hidden.add(id); render(); },
    showAll(){ state.hidden.clear(); render(); },
    openDay(ds){ state.date=ds; state.view='day'; render(); },
    openProject(id){
      const p=projects.find((x)=>x.id===id); if(!p)return; const crew=techById(p.crew);
      const linked=visits.filter((v)=>String(v.jobNo)===id).sort((a,b)=>a.date<b.date?-1:a.date>b.date?1:a.s-b.s);
      const dc=DIVCOLORS[p.division]||'#888';
      let body=`<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px"><span class="kind" style="background:var(--chip)"><span class="divdot" style="background:${dc}"></span> ${p.division}</span><span class="kind" style="background:var(--chip)">$${(p.value/1000).toFixed(0)}k</span><span class="kind" style="background:var(--chip)">Lead: ${crew?crew.n:'—'}</span></div>
        <div class="lh" style="font-size:10px;font-weight:800;text-transform:uppercase;color:var(--mut);margin:8px 0 4px">Phases (Gantt)</div>`;
      p.phases.forEach((ph)=>{ const col=STATUS[ph.status]?STATUS[ph.status].c:'#8b92a8'; body+=`<div class="layrow"><span class="r" style="color:${col};font-weight:800">${STATUS[ph.status]?STATUS[ph.status].l:ph.status}${ph.milestone?' ◆':''}</span><b>${ph.name}</b><div class="sub">${dLabel(ph.start)}${ph.end!==ph.start?' – '+dLabel(ph.end):''}</div></div>`; });
      body+=`<div class="lh" style="font-size:10px;font-weight:800;text-transform:uppercase;color:var(--mut);margin:10px 0 4px">Day-board visits on this job (${linked.length})</div>`;
      body+= linked.length? linked.map((v)=>`<div class="layrow" style="cursor:pointer" onclick="LabUI.jumpVisit('${v.id}')"><span class="r">${fmt(v.s)}</span><b>${v.type}</b><div class="sub">${dLabel(v.date)} · ${techById(v.t)?techById(v.t).n:''}</div></div>`).join('') : '<div style="color:var(--mut);font-size:11px">No short visits linked yet.</div>';
      body+=`<div class="policybox" style="margin-top:8px"><b>One job, two rhythms</b>This project owns both its multi-day <b>phases</b> (Gantt) and its short <b>visits</b> (Day board) — same job, one source of truth.</div>`;
      modal({k:'Project · '+p.division,title:p.name,body,actions:[
        {label:'Close',cls:'',fn:closeModal},
        {label:'📊 View phases in Gantt',cls:'',fn:()=>{state.focusProject=id;state.view='gantt';closeModal();render();}},
        {label:'📆 See visits on board',cls:'primary',fn:()=>{const f=linked[0];closeModal();if(f){state.date=f.date;state.view='day';state.focusProject=id;render();}}}]});
    },
    jumpVisit(vid){ const v=visits.find((z)=>z.id===vid); if(!v)return; closeModal(); state.date=v.date; state.view='day'; render(); setTimeout(()=>v.locked?openLockedSheet(vid):openJobSheet(vid),60); },
    // open a visit's detail WITHOUT leaving the current view (Week/Month stay put)
    openVisitSheet(vid){ const v=visits.find((z)=>z.id===vid); if(!v)return; v.locked?openLockedSheet(vid):openJobSheet(vid); },
    // The board is an iframe; the estimate builder lives in the parent page.
    // Ask it to open, the same way the board asks for a fresh token. If nobody
    // is listening -- the board opened standalone -- say so rather than
    // appearing to work.
    estimateFromVisit(vid){
      const v=visits.find((z)=>z.id===vid); if(!v)return;
      if(!v.sourceLeadId){ toast('⚠ This visit is not linked to a lead',true); return; }
      if(window.parent===window){ toast('⚠ Open the schedule inside HiveLogic to write an estimate',true); return; }
      closeModal();
      try{
        window.parent.postMessage({ type:'hl-estimate-from-lead',
          leadId:v.sourceLeadId, clientId:v.clientRef||null, title:v.type||v.client||'' }, location.origin);
        toast('✎ Opening the estimate…',false);
      }catch(e){ toast('⚠ Could not open the estimate',true); }
    },
    // click an empty Week cell → + Add for that crew + that day
    addAt(techId,date,ev){ if(ev&&ev.target&&ev.target.closest&&ev.target.closest('.wkchip'))return; if(!canEdit())return; openCreate(techId,9,date); },
    flashConflicts(){ document.querySelectorAll('.job.conflict').forEach((el)=>{ el.animate([{boxShadow:'0 0 0 0 rgba(198,91,78,.9)'},{boxShadow:'0 0 0 8px rgba(198,91,78,0)'}],{duration:900,iterations:2}); el.scrollIntoView({behavior:'smooth',inline:'center',block:'nearest'}); }); },
    filterReadiness(level){ if(state.view!=='day')return; const sel=level==='unconf'?'.job.unconfirmed':'.job.'+level; const els=document.querySelectorAll(sel); if(!els.length){ toast('Nothing '+(level==='unconf'?'unconfirmed':level.replace('_',' '))+' right now',false); return; } els.forEach((el,i)=>{ el.animate([{boxShadow:'0 0 0 0 rgba(43,63,140,.9)'},{boxShadow:'0 0 0 9px rgba(43,63,140,0)'}],{duration:900,iterations:2}); if(i===0)el.scrollIntoView({behavior:'smooth',inline:'center',block:'nearest'}); }); },
    togglePin(vid){ const v=visits.find((z)=>z.id===vid); if(v){v.pinned=!v.pinned;closeModal();render();toast(v.pinned?'📌 Pinned':'Unpinned',false);} },
    bookProposed(vid){ const v=visits.find((z)=>z.id===vid); if(!v)return; v.lifecycle='confirmed'; if(KINDS[v.kind]&&KINDS[v.kind].clientFacing)v.confirm='confirmed'; closeModal(); render(); toast('✅ Booked — proposed → confirmed',false); },
    // Field "My Day" execution actions
    mdAdvance(vid){ const v=visits.find((z)=>z.id===vid); if(!v)return; const order=['not_started','en_route','on_site','completed']; const next=order[Math.min(order.indexOf(execOf(v))+1,3)]; v.exec=next;
      if(next==='completed'){ mdComplete(vid); } else { render(); toast(next==='en_route'?'🚚 En route — customer auto-notified you\'re on the way':'📍 Arrived on site',false); } },
    mdAction(type){ toast(type==='photo'?'📷 Photo captured & attached':(type==='voice'?'🎙 Voice note saved':'⚠ Problem reported — dispatcher notified, recovery options ready'),false); },
    // Reina weather recommendation → notify all parties and/or stage a reviewable plan
    reinaWeather(){
      const wx=LENS.weather[state.date]; const affected=weatherAffected(state.date); const travel=wx.travelRisk>=50;
      const body=`<div class="policybox" style="background:rgba(21,144,163,.09);border-color:rgba(21,144,163,.35)"><b>⬡ Reina · ${wx.cond}</b>${wx.note?wx.note+'. ':''}${travel?('Travel risk '+wx.travelRisk+'% — this affects the drive to & from <b>every</b> job today.'):('Exposure risk '+wx.exposureRisk+'% for <b>outdoor</b> work.')}</div>`+
        affected.map((v)=>`<div class="layrow"><span class="r"><span class="rpill at_risk">${travel?'travel':'exposed'}</span></span><b>${v.client} · ${v.type}</b><div class="sub">${fmt(v.s)}–${fmt(v.e)} · ${techById(effectiveTech(v))?techById(effectiveTech(v)).n:''} · ${v.city}</div></div>`).join('')+
        `<div style="font-size:11.5px;color:var(--mut);margin-top:6px">Recommendation: ${travel?'delay starts until roads clear (or reschedule) and notify clients + techs now.':'pull exterior jobs to the safe window before the '+wx.cond.toLowerCase()+'.'} Publishing sends <b>one</b> coordinated batch to client, tech &amp; office.</div>`;
      const actions=[{label:'Dismiss',cls:'',fn:closeModal},
        {label:'📣 Notify everyone now',cls:'',fn:()=>{ closeModal(); notifyWeather(affected); }}];
      actions.push(travel
        ? {label:'Stage 2-hr delay',cls:'primary',fn:()=>{ closeModal(); stageTravelDelay(affected); }}
        : {label:'Stage Reina\'s plan',cls:'primary',fn:()=>{ closeModal(); stageWeatherPlan(affected, wx); }});
      modal({k:'Reina · weather impact',title:`${affected.length} job${affected.length>1?'s':''} at weather risk`,body,actions});
    },
    // Rule 3: Schedule This → 3 ranked options
    // Chris, 2026-08-24, on the unscheduled rail once it had real jobs in it:
    // "I like this feature, but you need the option to manually pick times and
    // techs yoursself. techs should be list by division seleted in job setup,
    // but an option to override to choose a tech from outside the listed
    // division's list of techs"
    //
    // What was here before was a mockup, and with real jobs in the rail it
    // showed him its seams: "★ Best overall — David @ 9a", "null qualified",
    // "~12-min drive from prior job", "No overtime", "Fits customer window
    // (null)". Every one of those was invented. There is no solver, no drive
    // time, no overtime model and no customer window -- a job row carries none
    // of it -- so the card recommended a person and an hour on the strength of
    // nothing at all, and the nulls were the real data showing through.
    //
    // Picking a crew and an hour on a dispatch board is a judgement, and the
    // person making it is the one who knows why. So this asks, rather than
    // recommending: a date, a time, a length, and a crew.
    scheduleThis(uid){
      const u=demands.find((z)=>z.id===uid); if(!u)return;
      const jobDiv=u.div||null;
      const field=techs.filter((t)=>t.lens==='crew'||t.lens==='sub');
      const inDiv=jobDiv?field.filter((t)=>t.div===jobDiv):[];
      // Default to the job's own division, because that is the answer nine
      // times in ten -- but never to an EMPTY picker. A division with nobody in
      // it silently offering no crews is a dead end with no explanation.
      const startAll=!jobDiv||inDiv.length===0;
      window._schedShowAll=startAll;

      const esc=(v)=>String(v==null?'':v).replace(/[&<>"]/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
      const who=[u.client,u.city].filter(Boolean).map(esc).join(' · ');
      // TODAY, not etTodayYmd() -- that one is declared inside data.js's IIFE
      // and is not reachable from this file. It would have thrown the first
      // time state.date was unset, which is rare enough to have shipped.
      const today=state.date||TODAY;

      const crewOpts=(all)=>{
        const list=all?field:inDiv;
        if(!list.length) return '<option value="">No crews available</option>';
        return list.map((t)=>`<option value="${esc(t.id)}">${esc(t.n)} · ${esc(t.crew)}${t.div&&t.div!==jobDiv?' · '+esc(t.div):''}</option>`).join('');
      };
      window._schedCrewOpts=crewOpts;

      const note=!jobDiv
        ? 'This job has no division set, so every crew is listed.'
        : (inDiv.length===0
            ? 'Nobody is set up in '+esc(jobDiv)+', so every crew is listed.'
            : 'Showing '+esc(jobDiv)+' crews. Tick the box to pick from any division.');

      modal({k:'Schedule this'+(u.jobNo?' · #'+esc(u.jobNo):''),title:u.title,
        body:`${who?`<div style="font-size:11px;color:var(--mut);margin-bottom:10px">${who}</div>`:''}
          <div style="display:flex;gap:8px">
            <div class="field" style="flex:1.4;margin:0"><label>Date</label><input type="date" id="sd_date" value="${esc(today)}"></div>
            <div class="field" style="flex:1;margin:0"><label>Start</label><select id="sd_time">${timeOptions(9)}</select></div>
            <div class="field" style="width:78px;margin:0"><label>Hours</label><select id="sd_dur"><option>1</option><option selected>2</option><option>3</option><option>4</option><option>6</option><option>8</option></select></div>
          </div>
          <div class="field" style="margin:10px 0 0"><label>Crew</label><select id="sd_tech">${crewOpts(startAll)}</select></div>
          <label style="display:flex;align-items:center;gap:7px;margin-top:8px;font-size:11.5px;cursor:pointer">
            <input type="checkbox" id="sd_all" ${startAll?'checked':''} ${(!jobDiv||inDiv.length===0)?'disabled':''} onchange="window.LabUI.schedToggleAll(this.checked)">
            Show crews from every division
          </label>
          <div id="sd_note" style="font-size:10.5px;color:var(--mut);margin-top:6px">${note}</div>`,
        actions:[
          {label:'Cancel',cls:'',fn:closeModal},
          {label:'Book it',cls:'primary',fn:()=>window.LabUI.schedBook(uid)}
        ]});
    },

    // The override. Re-renders the crew list in place rather than reopening the
    // modal, so the date and time he already picked survive the toggle.
    schedToggleAll(on){
      window._schedShowAll=!!on;
      const sel=document.getElementById('sd_tech');
      if(sel&&window._schedCrewOpts) sel.innerHTML=window._schedCrewOpts(!!on);
    },

    // Books it for real. The old pickOption pushed a fabricated visit into the
    // local array -- id 'd'+Date.now(), vid 'lab_d' -- and posted nothing, so
    // the job looked scheduled on screen and was on nobody's calendar.
    schedBook(uid){
      const i=demands.findIndex((z)=>z.id===uid); if(i<0)return;
      const u=demands[i];
      const date=(document.getElementById('sd_date')||{}).value||'';
      const s=parseFloat((document.getElementById('sd_time')||{}).value);
      const dur=parseFloat((document.getElementById('sd_dur')||{}).value)||2;
      const tid=(document.getElementById('sd_tech')||{}).value||'';
      const tech=tid?techById(tid):null;
      if(!date){ toast('Pick a date first',false); return; }
      if(!tech||!tech.jid){ toast('Pick a crew member first',false); return; }
      if(!window.hlPost||!window.hlEtToUTC){ toast('Cannot reach the schedule right now',false); return; }

      closeModal();
      window.hlPost('create_appointment',{ appointment:{
        kind:'field', title:u.title, client:u.client||null,
        crew_jids:[tech.jid], lead_jid:tech.jid,
        start_at:window.hlEtToUTC(date,s), end_at:window.hlEtToUTC(date,s+dur),
        division:u.div||tech.div||null, job_ref:u.jobRef||null
      }}).then((r)=>{
        if(!(r&&r.ok)){ toast('Not booked: '+((r&&r.error)||'the schedule rejected it'),false); return; }
        // Only now does it leave the rail. Removing it first would lose the job
        // off the one list that was showing it, on a failure he cannot see.
        const j=demands.findIndex((z)=>z.id===uid);
        if(j>=0) demands.splice(j,1);
        visits.push({ id:(r.appointment&&r.appointment.id)||('hl_'+Date.now()), apptId:r.appointment&&r.appointment.id,
          t:tech.id, date:date, s:s, e:s+dur, client:u.client||'-', city:u.city||'-',
          type:u.title, jobNo:u.jobNo||null, div:u.div||tech.div||'GH Co.',
          status:'scheduled', kind:'field', source:'hivelogic', locked:false,
          confirm:'confirmed', lifecycle:'confirmed', pinned:false, native:true,
          crew:[{id:tech.id,n:tech.n,ini:tech.ini,pc:tech.pc,lead:true}], lead:true });
        state.date=date; state.view='day';
        render();
        toast('Booked · '+u.title+' → '+tech.n+' @ '+fmt(s),false);
      }).catch((e)=>toast('Not booked: '+(e&&e.message||'network error'),false));
    },
    // Rule 4: publish / discard / review the staged plan
    publishScenario(){ const n=state.scenario.changes.length; if(!n)return; state.scenario.changes=[]; render(); toast(`📣 Published ${n} change${n>1?'s':''} — ONE batch sent to clients, techs & office`,false); },
    approveReq(id){ const r=state.changeRequests.find((x)=>x.id===id); if(!r)return; r.status='approved'; const v=visits.find((z)=>z.id===r.vid); if(v){ const prev={t:v.t,s:v.s,e:v.e}; stageChange(`Approved ${r.byName}'s request · ${r.client}`, ()=>{v.t=r.techId;v.s=r.start;v.e=r.start+r.dur;}, ()=>{Object.assign(v,prev);}); } closeModal(); render(); toast(`✅ Approved & staged — ${r.byName} notified`,false); },
    declineReq(id){ const r=state.changeRequests.find((x)=>x.id===id); if(!r)return; r.status='declined'; closeModal(); render(); toast(`Declined — ${r.byName} notified`,false); },
    discardScenario(){ state.scenario.changes.slice().reverse().forEach((c)=>c.undo&&c.undo()); state.scenario.changes=[]; render(); toast('↩️ Plan discarded — reverted',false); },
    reviewScenario(){ const items=state.scenario.changes;
      modal({k:'Schedule plan · review impact',title:`${items.length} staged change${items.length>1?'s':''}`,
        body:`<div class="policybox"><b>Impact — nothing sent yet</b>${items.length} change${items.length>1?'s':''} · customers & crews are notified in ONE batch on publish, not per drag.</div>`+items.map((c)=>`<div class="layrow"><b>${c.label}</b></div>`).join(''),
        actions:[{label:'Keep editing',cls:'',fn:closeModal},{label:'Discard',cls:'danger',fn:()=>{closeModal();window.LabUI.discardScenario();}},{label:'Publish & notify',cls:'primary',fn:()=>{closeModal();window.LabUI.publishScenario();}}]}); },
    cycleStatus(vid){ const order=['scheduled','traveling','onsite','materials','waiting','lunch','break','shop','problem','done']; const v=visits.find((z)=>z.id===vid); if(!v)return; v.status=order[(order.indexOf(v.status)+1)%order.length]; closeModal(); openJobSheet(vid); },
    confirmAppt(vid){ const v=visits.find((z)=>z.id===vid); if(!v)return; v.confirm='confirmed'; closeModal(); render(); toast(`✅ ${v.client} confirmed — ${v.type}`,false); },
    requestApproval(vid){ const v=visits.find((z)=>z.id===vid); if(!v)return; closeModal(); v.confirm='unconfirmed'; APPR={vid:vid,step:0}; renderApproval(); },
    cancelAppt(vid){ const v=visits.find((z)=>z.id===vid); if(!v)return;
      modal({k:'Cancel appointment',title:`${v.type} · ${v.client}`,
        body:`<div class="policybox"><b>Cancellation policy</b>${config.cancellationPolicy}</div>
          <div style="font-size:11.5px;color:var(--mut);margin-top:8px">Cancelling frees the slot and (in production) emails the client + notifies the crew. Any policy fee is flagged for the office.</div>`,
        actions:[{label:'Keep it',cls:'',fn:closeModal},{label:'Cancel appointment',cls:'danger',fn:()=>{ v.confirm='cancelled'; v.status='problem'; closeModal(); render(); toast(`🚫 Cancelled — ${v.client}. Policy applied.`,false); }}]}); },
    sendReminderNow(vid){ const v=visits.find((z)=>z.id===vid); closeModal(); toast(`📧 Reminder email queued to ${v?v.client:'client'} (lab — no real send)`,false); },
    undo(){ const u=state.undo; if(!u)return; if(u.type==='move'){const v=visits.find((z)=>z.id===u.id);Object.assign(v,u.prev);} else if(u.type==='assign'){const i=visits.findIndex((z)=>z.id===u.id);if(i>=0)visits.splice(i,1);unassigned.unshift(u.u);} state.undo=null; render(); toast('↩️ Undone',false); },
  };

  // ---- CREATE flow — each appointment type asks its own questions ----
  // Per-type extra fields (t: text|area|sel|div|check|num). Common fields (client,
  // assign, date/time/duration) are always shown; these layer on top per type.
  const CREATE_FIELDS = {
    field: { assignLabel:'Crew', extra:[
      {id:'jobref',l:'Job',t:'job',half:true},
      {id:'div',l:'Division / trade',t:'div',half:true},
      {id:'desc',l:'Work to be done',t:'area',ph:'Scope of this visit…'},
      {id:'access',l:'Site access (gate / code / parking)',t:'text',ph:'e.g. gate code 1234, park in driveway'},
      {id:'mats',l:'Materials already on the truck',t:'check'},
      {id:'expo',l:'🌳 Weather-exposed (outdoor work)',t:'check'} ]},
    service: { assignLabel:'Crew', extra:[
      {id:'div',l:'Division / trade',t:'div',half:true},
      {id:'urg',l:'Urgency',t:'sel',opts:['Routine','This week','Urgent','Emergency'],half:true},
      {id:'issue',l:'Reported issue / what’s wrong',t:'area',ph:'In the customer’s words…'},
      {id:'warr',l:'Warranty / callback',t:'check',half:true},
      {id:'parts',l:'Parts likely needed',t:'text',half:true} ]},
    sitevisit: { assignLabel:'Estimator', extra:[
      {id:'ptype',l:'Project type',t:'sel',opts:['Kitchen','Bathroom','Addition','Deck / outdoor','Basement','Whole-home','Roofing','Windows/Doors','Other'],half:true},
      {id:'budget',l:'Budget range',t:'sel',opts:['Unknown','Under $10k','$10–25k','$25–50k','$50–100k','$100k+'],half:true},
      {id:'scope',l:'What to assess on site',t:'area',ph:'Scope to look at, measure, photograph…'},
      {id:'addr',l:'Property address',t:'text',ph:'Street, town'},
      {id:'dm',l:'Decision-maker will be present',t:'check',half:true},
      {id:'meas',l:'Measurements + photos needed',t:'check',half:true},
      {id:'ref',l:'Referral source',t:'text',ph:'Website / referral / repeat client'} ]},
    lead: { assignLabel:'Owner', extra:[
      {id:'contact',l:'Contact',t:'text',ph:'phone / email',half:true},
      {id:'src',l:'Lead source',t:'sel',opts:['Website','Referral','Google','Repeat client','Social','Other'],half:true},
      {id:'interest',l:'Interested in',t:'div'},
      {id:'next',l:'Next step',t:'text',ph:'e.g. book estimate, send quote'},
      {id:'notes',l:'Notes',t:'area'} ]},
    sub: { assignLabel:'Sub', extra:[
      {id:'co',l:'Sub / company',t:'text',half:true},
      {id:'trade',l:'Trade',t:'sel',opts:['Plumbing','Electric','HVAC','Roofing','Masonry','Flooring','Painting','Other'],half:true},
      {id:'jobref',l:'Job',t:'job',half:true},
      {id:'po',l:'PO #',t:'text',half:true},
      {id:'scope',l:'Scope of work',t:'area'},
      {id:'coi',l:'COI on file & current',t:'check'} ]},
    internal: { assignLabel:'Owner', extra:[
      {id:'loc',l:'Location',t:'text',ph:'Shop / office / Zoom',half:true},
      {id:'who',l:'Attendees',t:'text',half:true},
      {id:'notes',l:'Agenda / notes',t:'area'} ]}
  };
  function cfField(f){
    var inner;
    if(f.t==='area') inner=`<textarea id="cf_${f.id}" style="width:100%;min-height:58px;border:1px solid var(--line);border-radius:8px;padding:8px;background:var(--panel);color:var(--ink);font:inherit;font-size:12.5px" placeholder="${f.ph||''}"></textarea>`;
    else if(f.t==='sel') inner=`<select id="cf_${f.id}">${f.opts.map((o)=>`<option>${o}</option>`).join('')}</select>`;
    else if(f.t==='div') inner=`<select id="cf_${f.id}">${DIVISIONS.map((d)=>`<option>${d}</option>`).join('')}</select>`;
    else if(f.t==='num') inner=`<input id="cf_${f.id}" type="number" placeholder="${f.ph||''}"/>`;
    // A real job, not a typed job number. Typing the number was the only thing
    // tying an appointment to a job, so a typo silently produced a visit that
    // belonged to nothing — no project number on the board, and nothing for job
    // costing to attribute the time to. Filled in by loadJobPicker().
    else if(f.t==='job') inner=`<select id="cf_${f.id}"><option value="">Loading jobs…</option></select>`;
    else if(f.t==='check') return `<label class="cf-check" style="display:flex;align-items:center;gap:9px;font-size:12.5px;font-weight:700;margin:2px;cursor:pointer;flex:1"><input type="checkbox" id="cf_${f.id}" style="width:17px;height:17px"/> ${f.l}</label>`;
    else inner=`<input id="cf_${f.id}" placeholder="${f.ph||''}"/>`;
    return `<div class="field" style="flex:1;margin:0"><label>${f.l}</label>${inner}</div>`;
  }
  // Fills any job picker currently on screen. Jobs are fetched once per board
  // session and reused, since the list runs to a few thousand and the dialog
  // can be reopened many times in a shift.
  let _jobPickerCache=null;
  // ---- auth: the board's token, the same one hlPost writes with ----
  // Every authenticated read from this file goes through here. It used to call
  // window.hlAuthHeaders(), which was referenced once and DEFINED NOWHERE -- so
  // /api/jobs was fetched with no Authorization header at all, answered 401,
  // and the picker rendered that 401 body as "No jobs found". A signed-out
  // answer and an empty answer must never look the same.
  function hlHeaders(){
    var t = window.HL_BOARD_TOKEN || '';
    return t ? { Authorization: 'Bearer ' + t } : {};
  }
  window.hlAuthHeaders = hlHeaders;   // the name the old call site used

  // ---- job picker ----
  // `forClient` narrows to one client's jobs. A dispatcher who has already said
  // WHO the visit is for should not then scroll 2,700 jobs to find WHICH.
  function loadJobPicker(forClient){
    const sel=document.getElementById('cf_jobref'); if(!sel) return;
    const paint=(jobs,failed)=>{
      const cur=document.getElementById('cf_jobref'); if(!cur) return;
      if(failed){ cur.innerHTML='<option value="">Could not load jobs - try again</option>'; return; }
      const scoped = forClient ? jobs.filter((j)=>String(j.clientId||'')===String(forClient)) : jobs;
      let h='<option value="">- no job (shop day, callback, estimate) -</option>';
      if(!scoped.length){
        // Say WHICH kind of empty this is. "No jobs found" for a client who
        // simply has none reads as a broken picker.
        h += forClient ? '<option value="" disabled>This client has no jobs yet</option>'
                       : '<option value="" disabled>No jobs found</option>';
      }
      scoped.forEach((j)=>{
        const num=j.projectRef||(j.jobNumber!=null?('#'+j.jobNumber):'');
        const label=[num,j.title||'Untitled',j.clientName?('- '+j.clientName):''].filter(Boolean).join(' ');
        h+=`<option value="${String(j.id).replace(/"/g,'&quot;')}">${label.replace(/</g,'&lt;')}</option>`;
      });
      cur.innerHTML=h;
    };
    if(_jobPickerCache){ paint(_jobPickerCache); return; }
    fetch('/api/jobs?limit=2000',{headers:hlHeaders()})
      .then((r)=>{ if(!r.ok) throw new Error('HTTP '+r.status); return r.json(); })
      .then((d)=>{
        const jobs=(d&&d.jobs)||[];
        // Active work first - a dispatcher is almost never scheduling a closed job.
        jobs.sort((a,b)=>((a.status==='active'?0:1)-(b.status==='active'?0:1)));
        _jobPickerCache=jobs; paint(jobs);
      })
      .catch(()=>paint([],true));
  }

  // ---- client picker: typeahead, because there are 8,600+ of them ----
  // A <select> of every client is not a picker, it is a scroll. The dispatcher
  // types, the server matches, and picking one fills in everything already
  // known about them so nothing is retyped.
  let _clientTimer=null, _clientChosen=null;

  function clientRowHtml(c){
    const bits=[c.phone||'', c.email||''].filter(Boolean).join(' . ');
    const safeId=String(c.id).replace(/\\/g,'\\\\').replace(/'/g,"\\'");
    return `<div class="cl-hit" onclick="window.hlPickClient('${safeId}')"
      style="padding:7px 9px;border-bottom:1px solid var(--line);cursor:pointer;font-size:12.5px">
      <b>${(c.name||'Unnamed').replace(/</g,'&lt;')}</b>${c.isLead?' <span style="color:var(--mut);font-weight:700">. lead</span>':''}
      ${bits?`<div style="color:var(--mut);font-size:11px">${bits.replace(/</g,'&lt;')}</div>`:''}
    </div>`;
  }

  window.hlClientSearch=(q)=>{
    const box=document.getElementById('c_clhits'); if(!box) return;
    const term=String(q||'').trim();
    if(_clientTimer) clearTimeout(_clientTimer);
    if(term.length<2){ box.innerHTML=''; box.style.display='none'; return; }
    box.style.display='';
    box.innerHTML='<div style="padding:8px 9px;color:var(--mut);font-size:12px">Searching...</div>';
    // Debounced: a dispatcher types faster than a round trip, and every
    // keystroke firing its own request means answers arrive out of order.
    _clientTimer=setTimeout(()=>{
      const mine=term;
      fetch('/api/clients?search='+encodeURIComponent(term)+'&limit=15&order=name',{headers:hlHeaders()})
        .then((r)=>{ if(!r.ok) throw new Error('HTTP '+r.status); return r.json(); })
        .then((d)=>{
          const cur=document.getElementById('c_cl');
          // A slower earlier request must not overwrite a later answer.
          if(!cur || cur.value.trim()!==mine) return;
          const box2=document.getElementById('c_clhits'); if(!box2) return;
          const list=(d&&d.clients)||[];
          window._clHits={}; list.forEach((c)=>{ window._clHits[c.id]=c; });
          box2.innerHTML = list.length
            ? list.map(clientRowHtml).join('')
            : `<div style="padding:8px 9px;color:var(--mut);font-size:12px">No client matches "${mine.replace(/</g,'&lt;')}" - use <b>+ New client</b></div>`;
        })
        .catch(()=>{ const b=document.getElementById('c_clhits'); if(b) b.innerHTML='<div style="padding:8px 9px;color:var(--mut);font-size:12px">Could not search clients</div>'; });
    },220);
  };

  // Everything known about the client, shown as a card and folded into the save.
  function paintClientCard(){
    const wrap=document.getElementById('c_clcard'); if(!wrap) return;
    const c=_clientChosen;
    if(!c){ wrap.innerHTML=''; wrap.style.display='none'; return; }
    wrap.style.display='';
    const lines=[c.phone,c.email,c.address].filter(Boolean);
    wrap.innerHTML=`<div style="border:1px solid var(--line);border-radius:9px;padding:9px 10px;background:var(--panel);display:flex;gap:10px;align-items:flex-start">
      <div style="flex:1;min-width:0">
        <div style="font-weight:800;font-size:13px">${(c.name||'').replace(/</g,'&lt;')}</div>
        ${lines.length?`<div style="color:var(--mut);font-size:11.5px;margin-top:2px">${lines.map((x)=>String(x).replace(/</g,'&lt;')).join(' . ')}</div>`
                      :'<div style="color:var(--mut);font-size:11.5px;margin-top:2px">No phone or address on file</div>'}
      </div>
      <button type="button" class="btn sm" onclick="window.hlClearClient()">Change</button>
    </div>`;
  }

  window.hlPickClient=(id)=>{
    const c=(window._clHits||{})[id]; if(!c) return;
    _clientChosen=Object.assign({},c);
    const box=document.getElementById('c_clhits'); if(box){ box.innerHTML=''; box.style.display='none'; }
    const inp=document.getElementById('c_cl'); if(inp){ inp.value=''; inp.style.display='none'; }
    const nb=document.getElementById('c_clnew'); if(nb) nb.style.display='none';
    paintClientCard();
    // Their jobs only, and their address - both already known, neither retyped.
    loadJobPicker(id);
    fetch('/api/track1?resource=client_location&clientId='+encodeURIComponent(id),{headers:hlHeaders()})
      .then((r)=>r.json())
      .then((d)=>{ if(d&&d.found&&d.address){ _clientChosen.address=d.address; _clientChosen.city=d.city||null; paintClientCard(); prefillAddress(d.address); } })
      .catch(()=>{});
  };

  // The save handler and the kind-switcher both need to know who was picked.
  window._hlChosenClient=()=>_clientChosen;

  window.hlClearClient=()=>{
    _clientChosen=null;
    const inp=document.getElementById('c_cl'); if(inp){ inp.style.display=''; inp.value=''; inp.focus(); }
    const nb=document.getElementById('c_clnew'); if(nb) nb.style.display='';
    paintClientCard(); loadJobPicker(null);
  };

  // The site-visit kind has its own address field; fill it rather than making
  // someone copy an address that is already on screen.
  function prefillAddress(addr){
    const el=document.getElementById('cf_addr');
    if(el && !el.value) el.value=addr;
  }

  // ---- new client, inline ----
  window.hlNewClient=()=>{
    const wrap=document.getElementById('c_clnewform'); if(!wrap) return;
    const open = wrap.style.display==='none' || !wrap.style.display;
    wrap.style.display = open ? '' : 'none';
    if(!open){ wrap.innerHTML=''; return; }
    wrap.innerHTML=`<div style="border:1px solid var(--line);border-radius:9px;padding:10px;background:var(--panel)">
      <div style="font-weight:800;font-size:12px;margin-bottom:8px">New client</div>
      <div style="display:flex;gap:8px;margin-bottom:8px">
        <div class="field" style="flex:1;margin:0"><label>First name</label><input id="nc_first"/></div>
        <div class="field" style="flex:1;margin:0"><label>Last name</label><input id="nc_last"/></div>
      </div>
      <div class="field" style="margin-bottom:8px"><label>Company (if it is a business)</label><input id="nc_company"/></div>
      <div style="display:flex;gap:8px;margin-bottom:8px">
        <div class="field" style="flex:1;margin:0"><label>Phone</label><input id="nc_phone" placeholder="203-555-0142"/></div>
        <div class="field" style="flex:1;margin:0"><label>Email</label><input id="nc_email" placeholder="name@example.com"/></div>
      </div>
      <div class="field" style="margin-bottom:8px"><label>Street</label><input id="nc_street" placeholder="12 Sound Beach Ave"/></div>
      <div style="display:flex;gap:8px;margin-bottom:8px">
        <div class="field" style="flex:2;margin:0"><label>Town</label><input id="nc_city" placeholder="Old Greenwich"/></div>
        <div class="field" style="width:64px;margin:0"><label>State</label><input id="nc_state" value="CT"/></div>
        <div class="field" style="width:82px;margin:0"><label>Zip</label><input id="nc_zip"/></div>
      </div>
      <div style="display:flex;gap:8px;align-items:center">
        <button type="button" class="btn primary sm" onclick="window.hlSaveNewClient()">Save client</button>
        <button type="button" class="btn sm" onclick="window.hlNewClient()">Cancel</button>
        <span id="nc_msg" style="font-size:11.5px;color:var(--mut)"></span>
      </div>
    </div>`;
    const f=document.getElementById('nc_first'); if(f) f.focus();
  };

  window.hlSaveNewClient=()=>{
    const g=(id)=>{const e=document.getElementById(id);return e?e.value.trim():'';};
    const msg=document.getElementById('nc_msg');
    const first=g('nc_first'), last=g('nc_last'), company=g('nc_company');
    if(!first && !last && !company){ if(msg) msg.textContent='Needs a name or a company.'; return; }
    if(msg) msg.textContent='Saving...';
    fetch('/api/track1?resource=create_client',{
      method:'POST',
      headers:Object.assign({'Content-Type':'application/json'},hlHeaders()),
      body:JSON.stringify({ firstName:first, lastName:last, companyName:company,
        phone:g('nc_phone'), email:g('nc_email'),
        street:g('nc_street'), city:g('nc_city'), province:g('nc_state'), postalCode:g('nc_zip') })
    })
      .then((r)=>r.json())
      .then((d)=>{
        if(!d||!d.ok||!d.client){ if(msg) msg.textContent='Could not save: '+((d&&d.error)||'error'); return; }
        const c=d.client;
        const addr=[g('nc_street'),g('nc_city'),g('nc_state')].filter(Boolean).join(', ');
        window._clHits=window._clHits||{};
        window._clHits[c.jobber_id]={ id:c.jobber_id, name:c.name, phone:g('nc_phone')||null,
          email:c.email||null, address:addr||null, isLead:true };
        const form=document.getElementById('c_clnewform'); if(form){ form.style.display='none'; form.innerHTML=''; }
        window.hlPickClient(c.jobber_id);
        toast('Client added . '+c.name+(d.locationSaved?' (address saved)':''),false);
      })
      .catch(()=>{ if(msg) msg.textContent='Could not save (network).'; });
  };

  function cfExtraHtml(kind){
    const spec=CREATE_FIELDS[kind]||CREATE_FIELDS.field; let h='', row=[];
    const flush=()=>{ if(!row.length)return; h+=`<div style="display:flex;gap:8px;margin-bottom:8px">${row.join('')}</div>`; row=[]; };
    spec.extra.filter((f)=>f.id!=='jobref'&&f.id!=='div').forEach((f)=>{ if(f.half){ row.push(cfField(f)); if(row.length===2) flush(); } else { flush(); h+=`<div style="margin-bottom:8px">${cfField(f)}</div>`; } });
    flush(); return h;
  }
  // ---- "+ Add": one pass, top to bottom, filling itself in as it goes ----
  // Order is the dispatcher's order (Chris, 2026-08-21): type, who it's for,
  // which job, when, who's going, division, notes. Each answer narrows or
  // fills the next, so the only things typed by hand are the ones the system
  // genuinely does not know.
  window.openCreate=(prefTech,prefStart,prefDate)=>{
    const dOpts=weekDaysOf(prefDate||state.date), dSel=prefDate||state.date;
    const kinds=Object.keys(KINDS);
    const defTech = prefTech || ((visibleTechs()[0]||{}).id) || '';
    window._cDefTech = defTech; window._clHits={}; window._cJobGeo=null;
    const k0 = 'field';
    const sect=(n,label)=>`<div style="display:flex;align-items:center;gap:8px;margin:14px 0 7px">
      <span style="width:18px;height:18px;border-radius:50%;background:var(--accent,#2B8CC0);color:#fff;font:800 10.5px system-ui;display:grid;place-items:center;flex:none">${n}</span>
      <span style="font:800 11px system-ui;letter-spacing:.06em;text-transform:uppercase;color:var(--mut)">${label}</span>
      <span style="flex:1;height:1px;background:var(--line)"></span></div>`;

    const body=`
      ${sect(1,'Type of visit')}
      <div class="field" style="margin:0"><select id="c_kind" onchange="window._ckind(this.value)">${kinds.map((k)=>`<option value="${k}" ${k===k0?'selected':''}>${KINDS[k].ic} ${KINDS[k].l}</option>`).join('')}</select></div>

      ${sect(2,'Client')}
      <div style="position:relative">
        <input id="c_cl" autocomplete="off" placeholder="Start typing a name, company or email..." oninput="window.hlClientSearch(this.value)"/>
        <div id="c_clhits" style="display:none;position:absolute;z-index:40;left:0;right:0;top:100%;margin-top:3px;max-height:210px;overflow:auto;border:1px solid var(--line);border-radius:9px;background:var(--panel);box-shadow:0 8px 24px rgba(0,0,0,.16)"></div>
      </div>
      <div id="c_clcard" style="display:none;margin-top:7px"></div>
      <div style="margin-top:7px"><button type="button" id="c_clnew" class="btn sm" onclick="window.hlNewClient()">+ New client</button></div>
      <div id="c_clnewform" style="display:none;margin-top:8px"></div>
      <div id="c_cltitle" style="margin-top:9px"><div class="field" style="margin:0"><label id="c_clientlbl">Or just a title, if there is no client yet</label><input id="c_client" placeholder="e.g. Winslow - bath reno"/></div></div>

      ${sect(3,'Job')}
      <div style="display:flex;gap:8px">
        <div class="field" style="flex:1;margin:0"><label>Job this visit belongs to</label><select id="cf_jobref" onchange="window._cjob(this.value)"><option value="">Loading jobs...</option></select></div>
      </div>
      <div id="c_jobnote" style="font-size:11px;color:var(--mut);margin-top:5px">Pick a job and the visit is tied to it - the board shows its number and the hours can be costed against it.</div>

      ${sect(4,'When')}
      <div style="display:flex;gap:8px">
        <div class="field" style="flex:1;margin:0"><label>Date</label><select id="c_date">${dOpts.map((d)=>`<option value="${d}" ${d===dSel?'selected':''}>${dLabel(d)}</option>`).join('')}</select></div>
        <div class="field" style="flex:1;margin:0"><label>Start</label><select id="c_time">${timeOptions(prefStart!=null?prefStart:9)}</select></div>
        <div class="field" style="width:78px;margin:0"><label>Hours</label><select id="c_dur"><option>1</option><option selected>2</option><option>3</option><option>4</option><option>6</option><option>8</option></select></div>
      </div>

      ${sect(5,'Who')}
      <div class="field" style="margin:0"><label id="c_assignlbl">Crew</label><select id="c_tech" onchange="window._ctech(this.value)">${techOptions(defTech)}</select></div>

      ${sect(6,'Division / trade')}
      <div class="field" style="margin:0"><select id="c_div">${DIVISIONS.map((d)=>`<option>${d}</option>`).join('')}</select></div>
      <div id="c_divnote" style="font-size:11px;color:var(--mut);margin-top:5px"></div>

      ${sect(7,'Notes & details')}
      <div id="c_extra">${cfExtraHtml(k0)}</div>

      <div id="c_clientwrap" style="margin-top:10px"></div>
      <div style="font-size:10.5px;color:var(--mut);margin-top:10px">Saved in HiveLogic, not in Jobber.</div>`;

    modal({k:'Add to the schedule',title:'+ Add',body,actions:[
      {label:'Cancel',cls:'',fn:closeModal},
      {label:'Add',cls:'primary',fn:()=>{
        const kind=document.getElementById('c_kind').value;
        const chosen=window._hlChosenClient?window._hlChosenClient():null;
        const typed=(document.getElementById('c_client')||{}).value||'';
        const client=(chosen&&chosen.name)||typed||('New '+KINDS[kind].l);
        const t=document.getElementById('c_tech').value, date=document.getElementById('c_date').value,
          s=parseFloat(document.getElementById('c_time').value), dur=parseFloat(document.getElementById('c_dur').value);
        const kd=KINDS[kind]; const g=(id)=>{const el=document.getElementById('cf_'+id);return el?(el.type==='checkbox'?el.checked:el.value):undefined;};
        const tech=techById(t);
        const div=(document.getElementById('c_div')||{}).value||(tech?tech.div:'GH Co.');
        const expo=g('expo')?'outside':'inside';
        const details={}; ((CREATE_FIELDS[kind]||CREATE_FIELDS.field).extra).forEach((f)=>{ if(f.id==='jobref'||f.id==='div') return; const val=g(f.id); if(val!==undefined&&val!=='') details[f.id]=val; });
        // Everything already known about the client rides along, so the field
        // has the address and phone without anyone retyping them.
        if(chosen){ if(chosen.phone) details.phone=chosen.phone; if(chosen.email) details.email=chosen.email; if(chosen.address) details.address=chosen.address; }
        const crew=tech?[{id:t,n:tech.n,ini:tech.ini,pc:tech.pc,lead:true}]:[];
        const jobSel=document.getElementById('cf_jobref');
        const jobRefVal=(jobSel&&jobSel.value)||null;
        const jobLabel=(jobSel&&jobSel.selectedIndex>0&&jobSel.value)?(jobSel.options[jobSel.selectedIndex].text.split(' ')[0]||null):null;
        const geo=window._cJobGeo||{};
        const nv={id:'hl_new'+Date.now(),t,date,s,e:s+dur,client,city:geo.city||(chosen&&chosen.city)||'-',type:g('desc')||g('scope')||g('issue')||kd.l,jobNo:jobLabel,div,status:'scheduled',kind,exposure:expo,source:'hivelogic',locked:false,confirm:'confirmed',pinned:false,vid:'new',crew:crew,lead:true,native:true,lat:geo.lat||null,lng:geo.lng||null};
        visits.push(nv); state.undo={type:'assign',id:nv.id,u:null}; state.date=date; state.view='day'; closeModal(); render();
        if(window.hlPost && tech && tech.jid){
          window.hlPost('create_appointment', { appointment:{ kind:kind, title:(g('desc')||g('scope')||g('issue')||client), client:client, client_ref:(chosen&&chosen.id)||null, crew_jids:[tech.jid], lead_jid:tech.jid, start_at:window.hlEtToUTC(date,s), end_at:window.hlEtToUTC(date,s+dur), division:div, job_ref:jobRefVal, lat:geo.lat||null, lng:geo.lng||null, details:details } })
            .then((r)=>{ if(r&&r.ok){ nv.apptId=r.appointment&&r.appointment.id; if(r.appointment&&r.appointment.job_no) nv.jobNo=r.appointment.job_no; render(); toast(`Added ${kd.l} . ${client}${(r.appointment&&r.appointment.job_no)?(' . '+r.appointment.job_no):''} - saved to HiveLogic`,false); } else { toast(`On screen, but save failed: ${(r&&r.error)||'error'}`,false); } })
            .catch(()=>toast('On screen, but save failed (network)',false));
        } else {
          toast(`Added ${kd.l} . ${client}${(tech&&tech.jid)?'':' - assign a crew member to save'}`,false);
        }
      }}]});

    loadJobPicker(null);
    window._cdivnote('Set from the job, or the crew you pick.');
    window._cconfirmnote(k0);

    // Picking a job fills in what the job record already knows: its division,
    // its title, and where it is. The job is the authority for all three, so a
    // dispatcher never retypes them and they cannot disagree.
    window._cjob=(val)=>{
      const jobs=_jobPickerCache||[]; const j=jobs.filter((x)=>String(x.id)===String(val))[0];
      if(!j){ window._cJobGeo=null; window._cdivnote('Set from the job, or the crew you pick.'); return; }
      window._cJobGeo={ lat:j.gpsLat||null, lng:j.gpsLng||null, city:j.city||null };
      const dv=document.getElementById('c_div');
      if(dv && j.divisionCode && DIVISIONS.indexOf(j.divisionCode)!==-1){ dv.value=j.divisionCode; window._cdivnote('From job '+(j.projectRef||('#'+j.jobNumber))+'.'); }
      const ti=document.getElementById('c_client');
      if(ti && !ti.value && j.title) ti.value=j.title;
      const desc=document.getElementById('cf_desc');
      if(desc && !desc.value && j.title) desc.placeholder='Scope of this visit on '+j.title+'...';
    };

    // No job picked? Then the crew member's own division is the best guess.
    window._ctech=(id)=>{
      const jobSel=document.getElementById('cf_jobref');
      if(jobSel && jobSel.value) return;              // the job already decided
      const t=techById(id), dv=document.getElementById('c_div');
      if(t && dv && t.div && DIVISIONS.indexOf(t.div)!==-1){ dv.value=t.div; window._cdivnote('From '+t.n+'. Pick a job and the job wins.'); }
    };
    window._ctech(defTech);

    window._ckind=(k)=>{
      const spec=CREATE_FIELDS[k]||CREATE_FIELDS.field;
      const ex=document.getElementById('c_extra'); if(ex) ex.innerHTML=cfExtraHtml(k);
      const al=document.getElementById('c_assignlbl'); if(al) al.textContent=spec.assignLabel||'Crew';
      const cl=document.getElementById('c_clientlbl'); if(cl) cl.textContent=(k==='lead'?'Or just a name, if there is no client record yet':(k==='internal'?'Meeting title':'Or just a title, if there is no client yet'));
      // Internal work has no customer. Hiding the picker is more honest than
      // showing one that must be left blank.
      const cw=document.getElementById('c_cltitle'); if(cw) cw.style.display='';
      window._cconfirmnote(k);
      const chosen=window._hlChosenClient?window._hlChosenClient():null;
      loadJobPicker(chosen?chosen.id:null);   // extras were re-rendered, so the picker is empty again
      const c2=window._hlChosenClient?window._hlChosenClient():null;
      if(c2 && c2.address) prefillAddress(c2.address);
    };
  };

  // The old copy said client-facing types "send the confirmation + reminder
  // cadence" full stop. With the master switch off that was simply untrue on
  // screen. It now says which of the two it is.
  window._cconfirmnote=(kind)=>{
    const box=document.getElementById('c_clientwrap'); if(!box) return;
    if(!KINDS[kind]||!KINDS[kind].clientFacing){ box.innerHTML=''; return; }
    const live=!!(window.HL_MSG&&window.HL_MSG.enabled);
    box.innerHTML=`<div class="policybox"><b>On confirm</b>${live
      ? 'Messaging is LIVE - saving this queues the confirmation and the reminder cadence, and the client will be emailed.'
      : 'Messaging is OFF - the confirmation and reminders are queued as a preview only. Nothing is sent to the client until you turn messaging on.'}</div>`;
  };
  window._cdivnote=(t)=>{ const n=document.getElementById('c_divnote'); if(n) n.textContent=t||''; };

  // ---- appointment settings: reminder cadence + cancellation policy ----
  window.openApptSettings=()=>{
    const M = window.HL_MSG || {enabled:false};
    const st = window._msgEdit || (window._msgEdit = {
      enabled: !!M.enabled,
      confirm_on_create: M.confirm_on_create!==false,
      reminders: (M.reminders && M.reminders.length ? M.reminders : config.reminders.map((r)=>({id:r.id,label:r.l,on:r.on}))).map((r)=>({id:r.id,label:r.label||r.l,on:r.on!==false})),
      channels: Object.assign({email:false,sms:false,call:false}, M.channels||{}),
      cancellation_policy: M.cancellation_policy || config.cancellationPolicy
    });
    const outbox = window.HL_OUTBOX || [];
    const rr=(on,click,label,extra)=>`<div class="rr" style="display:flex;align-items:center;gap:10px;padding:8px 4px;border-bottom:1px solid var(--line)"><div class="toggle ${on?'on':''}" onclick="${click}"><i></i></div><span style="font-weight:700">${label}</span>${extra?`<span style="margin-left:auto;font-size:10.5px;color:var(--mut)">${extra}</span>`:''}</div>`;
    const body=`
      <div class="policybox" style="${st.enabled?'border-color:var(--ok)':'border-color:var(--amb)'}"><b>${st.enabled?'🟢 Messaging is LIVE':'⚪ Messaging is OFF — preview only'}</b>${st.enabled?'Confirmations, reminders and approval messages are being <b>sent to clients</b>.':'Everything is queued and shown below, but <b>nothing is sent to any customer</b> while this is off. Flip it on when you go live.'}</div>
      ${rr(st.enabled,"window._msgT('enabled')",'<b style="font-weight:800">Send messages to clients — master switch</b>')}
      ${rr(st.confirm_on_create,"window._msgT('confirm_on_create')",'Send a confirmation when an appointment is booked')}
      <div style="font-weight:800;font-size:11px;color:var(--mut);margin:12px 2px 4px;letter-spacing:.05em">REMINDER CADENCE</div>
      ${st.reminders.map((r,i)=>rr(r.on,`window._msgR(${i})`,r.label)).join('')}
      <div style="font-weight:800;font-size:11px;color:var(--mut);margin:12px 2px 4px;letter-spacing:.05em">CHANNELS</div>
      ${rr(st.channels.email,"window._msgC('email')",'📧 Email','ready')}
      ${rr(st.channels.sms,"window._msgC('sms')",'💬 SMS text','needs a connected provider')}
      ${rr(st.channels.call,"window._msgC('call')",'📞 AI phone call','needs a connected provider')}
      <div class="field" style="margin-top:12px"><label>Cancellation policy (shown at booking + on reminders)</label><textarea id="s_policy" style="width:100%;min-height:60px;border:1px solid var(--line);border-radius:8px;padding:8px;background:var(--panel);color:var(--ink);font:inherit;font-size:12px">${st.cancellation_policy}</textarea></div>
      <div style="font-weight:800;font-size:11px;color:var(--mut);margin:14px 2px 4px;letter-spacing:.05em">QUEUED · WOULD SEND (${outbox.length})</div>
      <div style="max-height:150px;overflow:auto;border:1px solid var(--line);border-radius:8px">${outbox.length?outbox.slice(0,40).map((o)=>`<div style="padding:6px 9px;border-bottom:1px solid var(--line);font-size:11.5px"><b>${o.step}</b> · ${o.recipient_name||'—'} <span style="color:var(--mut)">· ${o.channel} · ${new Date(o.scheduled_for).toLocaleString('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})}</span><div style="color:var(--mut)">${o.subject||''}</div></div>`).join(''):'<div style="padding:14px;text-align:center;color:var(--mut);font-size:12px">Nothing queued yet — create a client-facing appointment and its confirmation + reminders appear here.</div>'}</div>`;
    modal({k:'Client messaging',title:'Messaging — confirmations, reminders & approvals',body,actions:[
      {label:'Cancel',cls:'',fn:()=>{ window._msgEdit=null; closeModal(); }},
      {label:'Save',cls:'primary',fn:()=>{ st.cancellation_policy=document.getElementById('s_policy').value;
        window.hlPost('set_messaging',{enabled:st.enabled,confirm_on_create:st.confirm_on_create,reminders:st.reminders,channels:st.channels,cancellation_policy:st.cancellation_policy})
          .then((r)=>{ window._msgEdit=null; if(r&&r.ok){ window.HL_MSG=r.settings||window.HL_MSG; toast(st.enabled?'🟢 Messaging LIVE — clients will be messaged':'⚪ Saved — messaging stays OFF (nothing sends)',false); closeModal(); } else toast('⚠ Save failed: '+((r&&r.error)||''),false); }); }}]});
    window._msgT=(k)=>{ st[k]=!st[k]; openApptSettings(); };
    window._msgR=(i)=>{ st.reminders[i].on=!st.reminders[i].on; openApptSettings(); };
    window._msgC=(c)=>{ st.channels[c]=!st.channels[c]; openApptSettings(); };
  };

  // ---- sub portal preview (what a sub sees; the two-way sync surface) ----
  window.openSubPortal=()=>{
    const sub=techById('joe')||techs.find((t)=>t.lens==='sub')||visibleTechs()[0];
    if(!sub){ toast('No subcontractor crews on the board',false); return; }
    const items=visits.filter((v)=>v.t===sub.id);
    const body=`<div style="font-size:12px;color:var(--mut);margin-bottom:10px">This is what <b>${sub.n}</b> (${sub.crew}) sees in the sub portal. In production these are the same assignments as the dispatch board — one source of truth, synced both ways, not a separate calendar.</div>
      <div class="subview">${items.length?items.map((v)=>`<div class="subcard"><div style="display:flex;justify-content:space-between;gap:8px"><b>${v.jobNo?'#'+v.jobNo+' ':''}${v.type}</b>${cfBadge(v)}</div>
        <div class="sd">${dLabel(v.date)} · ${fmt(v.s)}–${fmt(v.e)} · ${v.client} · ${v.city}</div>
        <div class="actrow">${v.confirm!=='confirmed'?`<button class="btn sm primary" onclick="LabUI.confirmAppt('${v.id}')">✓ Confirm</button>`:''}<button class="btn sm" onclick="closeApptModalThen('${v.id}')">Request change</button></div></div>`).join(''):'<div style="color:var(--mut)">No assignments.</div>'}</div>
      <div class="policybox" style="margin-top:10px"><b>Two-way sync</b>Sub confirms/declines here → the dispatch board's Subs lane updates, and the office is notified. Same data, two windows.</div>`;
    modal({k:'Sub portal · preview',title:`${sub.n}'s schedule`,body,actions:[{label:'Close',cls:'',fn:closeModal}]});
  };
  window.closeApptModalThen=(vid)=>{ closeModal(); toast('↔ Change request sent to office',false); };

  // ---- lens controls ----
  window.toggleLens=(k)=>{ state.lenses[k]=!state.lenses[k]; if(anyLens()) state.layersOpen=true; if(!anyLens()) state.layersOpen=false; render(); };
  window.clearLenses=()=>{ Object.keys(state.lenses).forEach((k)=>state.lenses[k]=false); state.layersOpen=false; render(); };
  window.LabUI.closeLayers=()=>{ state.layersOpen=false; document.getElementById('layerspanel').classList.remove('open'); queueBoardViewport(); };

  // ---- header controls ----
  window.setView=(v)=>{
    // Entering the Map tab from a calendar view inherits that view's period, so
    // the map opens on what you were just looking at rather than silently
    // resetting to a single day.
    if(v==='map' && (state.view==='day' || state.view==='week')) state.mapPeriod = (state.view==='week') ? 'week' : 'day';
    state.view=v; render(); if(v==='day') jumpToNow();
  };
  window.shiftDay=(d)=>{
    if(state.view==='map'){ state.date=addDays(state.date, state.mapPeriod==='week' ? d*7 : d); }
    else if(state.view==='week'){ state.date=addDays(state.date, d*7); }
    else if(state.view==='month'){ const dt=parseYMD(state.date); dt.setMonth(dt.getMonth()+d); state.date=ymd(dt); }
    else { state.date=addDays(state.date, d); }
    render();
  };
  window.goToday=()=>{ state.date=TODAY; render(); };
  window.setFilter=(v)=>{ state.filter=v; render(); };
  window.setScope=(v)=>{ state.scope=v; render(); };
  window.setDivision=(v)=>{ state.division=v; render(); };
  window.toggleFilters=()=>{ state.filtersOpen=!state.filtersOpen; document.getElementById('filtersWrap').classList.toggle('hidden',!state.filtersOpen); };
  window.toggleLensBar=()=>{ state.lensBarOpen=!state.lensBarOpen; renderLensBar(); };
  // Role presets — one dial that sets the sensible defaults for that person (Grok)
  const ROLE_PRESETS={
    dispatcher:{scope:'company',division:'all',filter:'crews',view:'day',rail:true},
    owner:{scope:'company',division:'all',filter:'all',view:'day',rail:false},
    pm:{scope:'company',division:'Design | Build',filter:'crews',view:'gantt',rail:false},
    sales:{scope:'company',division:'all',filter:'office',view:'day',rail:false},
    field:{scope:'mine',division:'all',filter:'crews',view:'day',rail:false},
    office:{scope:'company',division:'all',filter:'office',view:'day',rail:false}
  };
  window.setRole=(r)=>{ const p=ROLE_PRESETS[r]; if(!p)return; state.role=r; state.scope=p.scope; state.division=p.division; state.filter=p.filter; state.view=p.view; state.unOpen=p.rail; render(); };
  function fillDivisions(){
    const sel=document.getElementById('divisionFilter'); if(!sel)return;
    sel.innerHTML='<option value="all">All divisions</option>'+DIVISIONS.map((d)=>`<option value="${d}">${d}</option>`).join('');
    sel.value=state.division;
  }
  window.togglePeople=()=>{ state.peopleOpen=!state.peopleOpen; renderPeople(); };
  window.toggleUnassigned=(o)=>window.LabUI.toggleUnassigned(o);
  window.jumpToNow=()=>{ if(state.view!=='day')return; const sc=document.getElementById('boardscroll'); sc.scrollTo({left:Math.max(0,(SIM_NOW-DAY_START)*HRW()-sc.clientWidth/2),behavior:'smooth'}); };
  window.toggleFreeze=()=>{ state.freezeOn=!state.freezeOn; const b=document.getElementById('freezeBtn'); b.textContent=state.freezeOn?'✓ Freeze 60m: ON':'○ Freeze window: OFF'; b.className='btn sm '+(state.freezeOn?'freeze-on':'freeze-off'); };

  function effectiveTheme(){ const s=document.documentElement.getAttribute('data-theme'); if(s==='light'||s==='dark')return s; return matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light'; }
  function applyThemeLabel(){ document.getElementById('themeBtn').textContent=effectiveTheme()==='dark'?'☀️ Light':'🌙 Dark'; }
  window.toggleTheme=()=>{ const next=effectiveTheme()==='dark'?'light':'dark'; document.documentElement.setAttribute('data-theme',next); try{localStorage.setItem('sl_theme',next);}catch(e){} applyThemeLabel(); render(); };

  // init
  document.getElementById('freezeBtn').className='btn sm freeze-on';
  fillDivisions();
  try{ const saved=localStorage.getItem('sl_theme'); if(saved==='light'||saved==='dark')document.documentElement.setAttribute('data-theme',saved); }catch(e){}
  applyThemeLabel();
  matchMedia('(prefers-color-scheme:dark)').addEventListener('change',()=>{ if(!document.documentElement.getAttribute('data-theme')){applyThemeLabel();render();} });
  boardStateRestore();   // must precede the first render so the board paints straight into the saved view
  render();
  window.addEventListener('resize',()=>{ clearTimeout(window._rt); window._rt=setTimeout(render,150); });
})();
