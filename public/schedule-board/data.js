/* HiveLogic crew-row board — LIVE data adapter.
 * Replaces the lab's synthetic data.js. Builds window.LAB from the REAL
 * Jobber-mirrored feeds (employee_roster + schedule_range), then boots app.js.
 * Runs same-origin inside the app (iframe under /schedule-board/), so it reuses
 * the signed-in Supabase session. NOTHING here writes to Jobber (mirror-only).
 */
(function () {
  'use strict';
  var SUPA_REF = 'sqhusuuhlmcmkeowdrga';

  // ---- static catalogs (identical to the lab; not data, just labels/colors) ----
  var DIVCOLORS = {
    'Handyman':'#C46A2E','Electric':'#2B8CC0','Plumbing':'#159AA0','HVAC':'#8A6D5A',
    'Outdoor Spaces':'#4E7C8C','Home Concierge':'#C85C7E',
    'Design | Build':'#2E6BD6','Building':'#B4610E','GH Co.':'#5D657B'
  };
  var DIVISIONS = ['Handyman','Electric','Plumbing','HVAC','Outdoor Spaces','Home Concierge','Design | Build','Building'];
  var STATUS = {
    scheduled:{l:'Scheduled',c:'#8b92a8',grp:'plan'}, traveling:{l:'Traveling',c:'#2f5d8a',grp:'live'},
    onsite:{l:'On site',c:'#1B7A50',grp:'live'}, materials:{l:'Getting materials',c:'#A9772E',grp:'wait'},
    waiting:{l:'Waiting',c:'#B7791F',grp:'wait'}, lunch:{l:'Lunch',c:'#C08A3E',grp:'off'},
    break:{l:'Break',c:'#A88A5C',grp:'off'}, shop:{l:'Shop / office',c:'#5D657B',grp:'off'},
    problem:{l:'Running over',c:'#C65B4E',grp:'problem'}, done:{l:'Complete',c:'#59718a',grp:'done'}
  };
  var KINDS = {
    field:{l:'Field / job visit',ic:'🛠️',scope:'crew',clientFacing:true},
    service:{l:'Service visit',ic:'🔧',scope:'crew',clientFacing:true},
    sitevisit:{l:'Estimate site visit',ic:'📋',scope:'office',clientFacing:true},
    lead:{l:'Lead follow-up',ic:'📞',scope:'office',clientFacing:true},
    sub:{l:'Sub assignment',ic:'🤝',scope:'sub',clientFacing:false},
    internal:{l:'Internal / office',ic:'🏢',scope:'office',clientFacing:false}
  };
  var config = {
    reminders:[{id:'d3',l:'3 days before',on:true},{id:'d1',l:'1 day before',on:true},{id:'d0',l:'Same day (7am)',on:true},{id:'h1',l:'1 hour before',on:true}],
    channel:'email',
    cancellationPolicy:'24-hour notice required. Cancellations inside 24 hours may incur a $95 trip fee; no-shows are billed at the visit minimum.'
  };
  var PALETTE = ['#1FA0C4','#3E7BDD','#2FA37E','#D95C8A','#E0912E','#2B8CC0','#159AA0','#4E7C8C','#6C7A93','#5C86B0','#5A7D8C','#8A6D5A','#B4610E','#C85C7E'];

  // ---- helpers ----
  function firstName(n){ return (n||'').trim().split(/\s+/)[0] || (n||''); }
  function initials(n){ var p=(n||'').trim().split(/\s+/); return ((p[0]||'')[0]||'').toUpperCase() + ((p[1]||'')[0]||'').toUpperCase() || (n||'?').slice(0,2).toUpperCase(); }
  function slug(s){ return String(s||'').toLowerCase().split('@')[0].replace(/[^a-z0-9]+/g,'_').replace(/^_+|_+$/g,'') || ('t'+Math.abs(hash(String(s)))); }
  function hash(s){ var h=0; for(var i=0;i<s.length;i++){ h=(h*31+s.charCodeAt(i))|0; } return h; }
  var ET = { tz:'America/New_York' };
  function etParts(iso){ // {date:'YYYY-MM-DD', dec: decimal hour ET}
    try {
      var d = new Date(iso);
      var f = new Intl.DateTimeFormat('en-US',{timeZone:ET.tz,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false});
      var o = {}; f.formatToParts(d).forEach(function(p){ o[p.type]=p.value; });
      var hr = parseInt(o.hour,10); if(hr===24) hr=0;
      return { date:o.year+'-'+o.month+'-'+o.day, dec: hr + (parseInt(o.minute,10)||0)/60 };
    } catch(e){ return { date:null, dec:0 }; }
  }
  function etTodayYmd(){ try { return new Intl.DateTimeFormat('en-CA',{timeZone:ET.tz}).format(new Date()); } catch(e){ return new Date().toISOString().slice(0,10); } }
  function ymdAdd(ymd,days){ var a=ymd.split('-'); var dt=new Date(Date.UTC(+a[0],+a[1]-1,+a[2],12)); dt.setUTCDate(dt.getUTCDate()+days); return dt.toISOString().slice(0,10); }
  function ymdDow(ymd){ var a=ymd.split('-'); return new Date(Date.UTC(+a[0],+a[1]-1,+a[2],12)).getUTCDay(); } // 0=Sun
  function mapStatus(vs){ var s=String(vs||'').toUpperCase(); if(s.indexOf('COMPLET')>-1||s.indexOf('DONE')>-1) return 'done'; if(s==='LATE') return 'problem'; return 'scheduled'; }
  // WMO weather code → icon/label + base risk. exposure = threat to OUTSIDE work; travel = threat to ALL driving.
  function wxCode(c){
    if(c===0) return {ic:'☀️',cond:'Clear',ex:0,tv:0};
    if(c<=2) return {ic:'🌤️',cond:'Mostly sunny',ex:5,tv:0};
    if(c===3) return {ic:'☁️',cond:'Overcast',ex:10,tv:0};
    if(c===45||c===48) return {ic:'🌫️',cond:'Fog',ex:15,tv:30};
    if(c>=51&&c<=57) return {ic:'🌦️',cond:'Drizzle',ex:35,tv:10,rain:true};
    if(c>=61&&c<=67) return {ic:'🌧️',cond:'Rain',ex:55,tv:(c>=65?35:15),rain:true};
    if(c>=71&&c<=77) return {ic:'🌨️',cond:'Snow',ex:60,tv:70};
    if(c>=80&&c<=82) return {ic:'🌧️',cond:'Rain showers',ex:55,tv:(c===82?40:20),rain:true};
    if(c>=85&&c<=86) return {ic:'🌨️',cond:'Snow showers',ex:60,tv:65};
    if(c>=95) return {ic:'⛈️',cond:'Thunderstorms',ex:70,tv:30,rain:true};
    return {ic:'⛅',cond:'Mixed',ex:10,tv:0};
  }
  function wxBuild(wx){
    var out={}; if(!wx||!wx.daily||!wx.daily.time) return out; var d=wx.daily;
    d.time.forEach(function(day,i){
      var c=d.weather_code[i], tmax=Math.round(d.temperature_2m_max[i]), pp=d.precipitation_probability_max[i]||0, wind=Math.round(d.wind_speed_10m_max[i]||0);
      var m=wxCode(c);
      var exposure=Math.min(95, Math.max(m.ex, pp, wind>=35?45:wind>=25?22:0, tmax>=95?35:tmax<=25?28:0));
      var travel=Math.min(90, Math.max(m.tv, wind>=40?25:0));
      out[day]={ ic:m.ic, t:tmax+'°', cond:m.cond, exposureRisk:exposure, travelRisk:travel, riskFrom: exposure>=50?12:0,
        rain: (pp>=50||!!m.rain), hourly: m.cond+(pp?(' · '+pp+'% precip'):''),
        note: m.cond+(pp>=40?(' · '+pp+'% precip'):'')+(wind>=25?(' · wind '+wind+'mph'):'')+(tmax>=95?' · heat':(tmax<=25?' · cold':'')) };
    });
    return out;
  }
  // ET wall-clock (date + decimal hour) → UTC ISO, DST-correct (offset from Intl).
  function etToUTC(ymd, dec){
    var h=Math.floor(dec), mi=Math.round((dec-h)*60);
    var probe=new Date(ymd+'T12:00:00Z');
    var etHour=parseInt(new Intl.DateTimeFormat('en-US',{timeZone:ET.tz,hour:'2-digit',hour12:false}).format(probe),10);
    var offset=12-etHour; // +4 EDT, +5 EST
    var d=new Date(ymd+'T00:00:00Z'); d.setUTCHours(h+offset, mi, 0, 0); return d.toISOString();
  }
  window.hlEtToUTC = etToUTC;
  // Write to the HiveLogic-native scheduling endpoint (never Jobber).
  window.hlPost = function(action, payload){
    return fetch('/api/schedule/hl', { method:'POST', headers:{ 'Content-Type':'application/json', Authorization:'Bearer '+(window.HL_BOARD_TOKEN||'') }, body:JSON.stringify(Object.assign({action:action}, payload||{})) })
      .then(function(r){ return r.json().catch(function(){ return { ok:false, error:'bad response' }; }); });
  };

  // ---- auth token: from parent (postMessage) or the shared Supabase session ----
  function tokenFromStorage(){
    try {
      var raw = localStorage.getItem('sb-'+SUPA_REF+'-auth-token'); if(!raw) return '';
      var o = JSON.parse(raw);
      return (o && (o.access_token || (o.currentSession && o.currentSession.access_token))) || '';
    } catch(e){ return ''; }
  }

  function fetchJSON(url, token){
    return fetch(url, { headers: token ? { Authorization:'Bearer '+token } : {} }).then(function(r){
      if(!r.ok) throw new Error(url.split('resource=')[1]+' → HTTP '+r.status);
      return r.json();
    });
  }

  function showMsg(html){ var b=document.getElementById('board'); if(b){ b.innerHTML='<div style="padding:48px 24px;text-align:center;color:var(--mut,#69748a);font:14px system-ui">'+html+'</div>'; } }

  // ---- build window.LAB from real feeds, then load the board ----
  function boot(token){
    if (boot._done) return; boot._done = true;
    window.HL_BOARD_TOKEN = token;   // for write actions (create / clock / chain)
    showMsg('Loading your live schedule…');

    var TODAY = etTodayYmd();
    var mon = ymdAdd(TODAY, -(((ymdDow(TODAY)+6)%7)));  // Monday of this week
    var WEEK = [0,1,2,3,4,5,6].map(function(i){ return ymdAdd(mon,i); });
    var nowET = etParts(new Date().toISOString());
    var SIM_NOW = Math.max(6, Math.min(19, nowET.dec || 11));
    // Fetch a wider window (prev week … +3 weeks) so navigating days/weeks has data.
    var FETCH_START = ymdAdd(mon, -7), FETCH_END = ymdAdd(mon, 27);

    Promise.all([
      fetchJSON('/api/track1?resource=employee_roster', token).catch(function(e){ throw new Error('roster: '+e.message); }),
      fetchJSON('/api/track1?resource=schedule_range&start='+FETCH_START+'&end='+FETCH_END, token).catch(function(e){ throw new Error('schedule: '+e.message); }),
      fetchJSON('/api/track1?resource=tech_live_status', token).catch(function(){ return null; }), // live GPS overlay — optional
      fetchJSON('/api/schedule/hl?start='+FETCH_START+'&end='+FETCH_END, token).catch(function(){ return null; }), // HiveLogic-native: appointments, clock, crew overrides
      // Real weather for the service area (office). Open-Meteo = free, no key, CORS-ok.
      // NOTE: plain fetch — never send the session token to a third party.
      fetch('https://api.open-meteo.com/v1/forecast?latitude=41.1444&longitude=-73.6418&daily=weather_code,temperature_2m_max,precipitation_probability_max,wind_speed_10m_max&timezone=America%2FNew_York&forecast_days=16&temperature_unit=fahrenheit&wind_speed_unit=mph').then(function(r){ return r.ok?r.json():null; }).catch(function(){ return null; }),
      // Real materials status per job. Optional: the lens degrades to empty
      // rather than taking the board down with it.
      fetchJSON('/api/track1?resource=materials_overview', token).catch(function(){ return null; }),
      // Service areas, for the map's opening camera. Optional in the strongest
      // sense: if this fails the board still loads and the map falls back to
      // the shop coordinate below.
      fetchJSON('/api/company?resource=get', token).catch(function(){ return null; }),
      // Open jobs with nowhere to be. This is what the unscheduled rail
      // renders; before it existed the rail's `demands` array was the literal
      // [] a few hundred lines below, so the panel said "No unscheduled work"
      // to a company with 18 jobs waiting for a slot. Optional like the rest:
      // a failure leaves the rail empty rather than taking the board down.
      fetchJSON('/api/track1?resource=schedule_unscheduled', token).catch(function(){ return null; })
    ]).then(function(res){
      var roster = (res[0] && res[0].roster) || [];
      var rawVisits = (res[1] && res[1].visits) || [];
      var liveRows = (res[2] && res[2].techs) || [];
      var native = res[3] || {};
      var wx = res[4] || null;
      var matsRes = res[5] || null;
      var companyRes = res[6] || null;
      var hlAppts = native.appointments || [];
      var hlClock = native.clock || [];
      var hlOverrides = native.overrides || [];
      var hlSubs = native.subs || [];
      window.HL_OUTBOX = native.outbox || [];                 // queued client messages (preview of what would send)
      window.HL_MSG = native.messaging || { enabled:false };  // master messaging switch + config
      window.HL_RECHAIN = native.rechainRequests || [];       // techs who peeled themselves off a job
      window.HL_ME = native.viewerJid || null;                // the signed-in person's jobber id
      var overrideByVisit = {}; hlOverrides.forEach(function(o){ overrideByVisit[o.visit_jid] = o; });
      var clockedByJid = {}; hlClock.forEach(function(c){ if(c.clock_out==null) clockedByJid[String(c.employee_jid)] = c; });

      // ---- techs (columns) ----
      var techs = [], byJid = {}, byFirst = {}, ci = 0;
      roster.forEach(function(p){
        // Dispatch calendar = people who go to the field. Office/admin/accounting/sales
        // (lens 'office') are hidden here; only field crew + subs get a row.
        var lens = p.lens; if(['crew','sub'].indexOf(lens)===-1) return;
        var div = p.division || 'GH Co.';
        var perm = p.permissionRoles || (p.permissionRole ? [p.permissionRole] : []);
        var t = {
          id: slug(p.email || p.name || p.jobberId),
          jid: p.jobberId || null,
          n: firstName(p.name), fullName: p.name || '',
          ini: initials(p.name),
          pc: p.color || DIVCOLORS[div] || PALETTE[ci++ % PALETTE.length],
          crew: p.crewLabel || (lens==='office'?'Office':lens==='sub'?'Sub':'Crew'),
          div: div, lens: lens, vehicle: !!p.hasVehicle,
          vehicleName: p.vehicleName || null,
          sales: perm.indexOf('design_sales')>-1 || perm.indexOf('marketing')>-1,
          isLead: !!p.isLead,          // crew lead, from user setup — drives job grouping
          live: null
        };
        techs.push(t);
        if(t.jid) byJid[String(t.jid)] = t.id;
        var fn = t.n.toLowerCase(); if(fn){ byFirst[fn] = (fn in byFirst) ? null : t.id; } // null = ambiguous (two same first names) → don't name-match
      });
      var techById = {}; techs.forEach(function(t){ techById[t.id]=t; });

      // ---- live status next to the name (from tech_live_status GPS state) ----
      var LIVE_MAP = { on_site:['on_site','Working'], near_job:['on_site','At job'], en_route:['en_route','Driving'],
        between_visits:['en_route','Traveling'], at_shop:['at_shop','At shop'], idle:['idle','Idle'], no_visits:[null,''] };
      var liveByJid = {}; liveRows.forEach(function(r){ if(r && r.jobberId!=null) liveByJid[String(r.jobberId)] = r; });
      techs.forEach(function(t){
        var r = t.jid ? liveByJid[String(t.jid)] : null; if(!r) return;
        var m = LIVE_MAP[r.state] || (r.label ? ['on_site', r.label] : null); if(!m || !m[0]) return;
        var lbl = m[1]; if(r.state==='en_route' && r.speedMph) lbl = 'Driving ' + Math.round(r.speedMph) + 'mph';
        t.live = { cls: m[0], label: lbl };
      });
      // clocked-in overrides the pill when there's no live GPS movement to show
      techs.forEach(function(t){ if(t.jid && clockedByJid[String(t.jid)]){ t.clockedIn = true; if(!t.live) t.live = { cls:'clocked', label:'Clocked in' }; } });

      function matchOne(a){
        if(!a) return null;
        if(a.jobberId && byJid[String(a.jobberId)]) return byJid[String(a.jobberId)];
        if(a.name){ var fn=firstName(a.name).toLowerCase(); if(byFirst[fn]) return byFirst[fn]; }
        return null;
      }
      // Jobs often carry a lead/supervisor first + the doer second. Prefer the field-CREW
      // row so a job lands on the person actually on site, not their manager.
      function matchTechBest(list){
        if(!list || !list.length) return null;
        var i, id;
        for(i=0;i<list.length;i++){ id=matchOne(list[i]); if(id && techById[id] && techById[id].lens==='crew') return id; }
        for(i=0;i<list.length;i++){ id=matchOne(list[i]); if(id) return id; }
        return null;
      }
      function cleanTitle(title, client){
        var t = (title || 'Visit').trim();
        if(client){ var pre=[client+' - ', client+' – ', client+' — ']; for(var i=0;i<pre.length;i++){ if(t.indexOf(pre[i])===0){ t=t.slice(pre[i].length).trim(); break; } } }
        return t || 'Visit';
      }

      // ---- who leads a job ----
      // Lead is a property of the PERSON (employee_roles.is_lead, set in user setup).
      // Dispatch can override it for one job when two leads land together or a lead
      // goes out sick — that election lives on the crew override row. Order:
      //   1. dispatch's per-job election   2. the one person flagged is_lead
      //   3. nobody flagged / two flagged → fall back to job order (crew lens first)
      function electLead(ids, explicitJid){
        if(explicitJid){ var byExp = byJid[String(explicitJid)]; if(byExp && ids.indexOf(byExp)>-1) return byExp; }
        var flagged = ids.filter(function(id){ return techById[id] && techById[id].isLead; });
        if(flagged.length===1) return flagged[0];
        return ids.filter(function(id){ return techById[id] && techById[id].lens==='crew'; })[0] || ids[0];
      }

      // ---- visits ----
      // A crew job lands on the LEAD's row only — the secondaries are chained to it
      // and show as avatars on the lead's card instead of repeating the job across
      // every row. Each secondary still gets a thin "chained" marker on their own
      // row so dispatch can't double-book someone who looks free but isn't.
      // Office/admin assignees are already excluded (no row), so they get no card.
      var visits = [], unmatched = 0;
      // clientId -> contact, so a HiveLogic-native appointment booked for a
      // client who also has a Jobber visit in view can show the same details
      // without a second round trip.
      var contactByClient = {};
      rawVisits.forEach(function(v){
        if(!v.startAt || !v.endAt) return;
        var matched = [];
        (v.assignedTechs || []).forEach(function(a){ var id = matchOne(a); if(id && matched.indexOf(id)===-1) matched.push(id); });
        // HiveLogic crew overrides (chain / peel-off) layered on the Jobber crew
        var ov = overrideByVisit[v.visitId];
        if(ov){
          (ov.remove_jids||[]).forEach(function(jid){ var id=byJid[String(jid)]; var ix=id?matched.indexOf(id):-1; if(ix>-1) matched.splice(ix,1); });
          (ov.add_jids||[]).forEach(function(jid){ var id=byJid[String(jid)]; if(id && matched.indexOf(id)===-1) matched.push(id); });
        }
        if(!matched.length){ unmatched++; return; }
        var es = etParts(v.startAt), ee = etParts(v.endAt);
        if(!es.date) return;
        var e = ee.dec > es.dec ? ee.dec : es.dec + 0.5;
        var ttl = cleanTitle(v.title, v.clientName);
        var leadId = electLead(matched, ov && ov.lead_jid);
        var crew = matched.map(function(id){ return { id:id, n: techById[id]?techById[id].n:'', ini: techById[id]?techById[id].ini:'', pc: techById[id]?techById[id].pc:'#888', jid: techById[id]?techById[id].jid:null, lead: id===leadId }; });
        var lat = (v.lat!=null ? Number(v.lat) : null), lng = (v.lng!=null ? Number(v.lng) : null);
        var leadTech = techById[leadId];
        // Real contact details, straight from the clients table via
        // schedule_range. Null where the client genuinely has none on file --
        // the job sheet says so rather than inventing one, which is what it
        // used to do.
        var contact = { clientId: v.clientId || null, clientPhone: v.clientPhone || null,
          clientEmail: v.clientEmail || null, clientAddr: v.clientAddress || null };
        if(contact.clientId) contactByClient[contact.clientId] = contact;
        visits.push(Object.assign({
          id: 'v_'+v.visitId+'_'+leadId, vid: v.visitId,
          t: leadId, date: es.date, s: es.dec, e: e,
          client: v.clientName || ttl, city: v.city || '', type: ttl,
          jobNo: v.jobNumber || null, div: leadTech ? leadTech.div : 'GH Co.',
          status: mapStatus(v.status),
          kind: 'field', source: 'jobber', locked: true,
          confirm: 'confirmed', lifecycle: 'confirmed', pinned: false,
          jid: v.jobberId || null, lat: lat, lng: lng,
          crew: crew, lead: true, crewSize: crew.length,
          assignedJid: (leadTech && leadTech.jid) || null
        }, contact));
        // chained secondaries: one muted marker each, on their own row
        matched.forEach(function(id){
          if(id===leadId) return;
          visits.push(Object.assign({
            id: 'v_'+v.visitId+'_'+id+'_chained', vid: v.visitId, t: id,
            date: es.date, s: es.dec, e: e,
            client: v.clientName || ttl, city: v.city || '', type: ttl,
            jobNo: v.jobNumber || null, div: leadTech ? leadTech.div : 'GH Co.',
            status: mapStatus(v.status), kind: 'field', source: 'jobber',
            locked: true, confirm: 'confirmed', lifecycle: 'confirmed', pinned: false,
            lat: lat, lng: lng, crew: crew, lead: false, crewSize: crew.length,
            chained: true, chainedTo: leadId,
            chainedToName: leadTech ? leadTech.n : 'lead',
            assignedJid: (techById[id] && techById[id].jid) || null
          }, contact));
        });
      });

      // ---- HiveLogic-native appointments (created on this board; not in Jobber) ----
      hlAppts.forEach(function(a){
        var es = etParts(a.start_at), ee = etParts(a.end_at); if(!es.date) return;
        var e = ee.dec > es.dec ? ee.dec : es.dec + 0.5;
        var jids = (a.crew_jids && a.crew_jids.length) ? a.crew_jids : (a.lead_jid ? [a.lead_jid] : []);
        var ids = jids.map(function(j){ return byJid[String(j)]; }).filter(Boolean);
        if(!ids.length) return;
        var leadId = electLead(ids, a.lead_jid);
        var crew = ids.map(function(id){ return { id:id, n:techById[id]?techById[id].n:'', ini:techById[id]?techById[id].ini:'', pc:techById[id]?techById[id].pc:'#888', jid:techById[id]?techById[id].jid:null, lead:id===leadId }; });
        var kindL = (KINDS[a.kind] && KINDS[a.kind].l) || 'Appointment';
        var leadTech = techById[leadId];
        // A native appointment carries whatever was typed on the booking form
        // in details{}; failing that, the client record it was booked against.
        var det = a.details || {};
        var known = (a.client_ref && contactByClient[a.client_ref]) || {};
        var base = {
          vid:'hl_'+a.id, apptId:a.id, date:es.date, s:es.dec, e:e,
          client:a.client || a.title || kindL, city:'', type:a.title || kindL,
          clientId: a.client_ref || null,
          clientPhone: det.phone || known.clientPhone || null,
          clientEmail: det.email || known.clientEmail || null,
          clientAddr: det.address || det.addr || known.clientAddr || null,
          jobNo:a.job_no || null,
          status:(a.status==='done'?'done':'scheduled'), kind:a.kind || 'field',
          // The real state, not a hardcoded 'confirmed'. This was pinned to
          // 'confirmed' when the board was ported from the lab, which meant the
          // ✓ badge on every native appointment was decoration -- it said the
          // customer had confirmed whether or not anyone had asked them.
          source:'hivelogic', locked:false,
          confirm:(a.confirm_state || 'unconfirmed'),
          lifecycle:(a.confirm_state || 'unconfirmed'), pinned:false,
          lat:(a.lat!=null?Number(a.lat):null), lng:(a.lng!=null?Number(a.lng):null),
          crew:crew, crewSize:crew.length, native:true,
          // Where this appointment came from. A site visit booked off a lead
          // keeps the link, which is what lets the board offer "write the
          // estimate" once the visit is done instead of sending the estimator
          // back to the Leads tab to find the same card again.
          sourceLeadId:a.source_lead_id || null,
          clientRef:a.client_ref || null
        };
        visits.push(Object.assign({}, base, {
          id:'hl_'+a.id+'_'+leadId, t:leadId, lead:true,
          div:a.division || (leadTech?leadTech.div:'GH Co.'),
          lead_jid: a.lead_jid || null
        }));
        ids.forEach(function(id){
          if(id===leadId) return;
          visits.push(Object.assign({}, base, {
            id:'hl_'+a.id+'_'+id+'_chained', t:id, lead:false,
            div:a.division || (leadTech?leadTech.div:'GH Co.'),
            chained:true, chainedTo:leadId, chainedToName: leadTech ? leadTech.n : 'lead'
          }));
        });
      });

      // ---- Subcontractor rows (the Subs layer) ----
      // A sub is not on the employee roster -- it is a row in `subs` with its
      // own portal login -- so it gets no crew row from the code above and its
      // appointments were being dropped entirely (the crew-id check below
      // returns early when nobody from the roster is assigned).
      //
      // Only subs with work in the window get a row. Otherwise the board grows
      // a permanent empty lane for every sub ever entered, which is exactly the
      // congestion this layer is supposed to avoid.
      var subById = {}; hlSubs.forEach(function(x){ subById[String(x.id)] = x; });
      var subsWithWork = {};
      hlAppts.forEach(function(a){ if(a.sub_id) subsWithWork[String(a.sub_id)] = true; });
      Object.keys(subsWithWork).forEach(function(sid){
        var meta = subById[sid] || {};
        techs.push({
          id: 'sub_' + sid, jid: null,
          n: meta.name || 'Subcontractor', fullName: meta.name || 'Subcontractor',
          ini: initials(meta.name || 'Sub'),
          pc: '#7a6ea8',                 // one deliberate colour for all subs
          crew: 'Sub', div: 'Subs', lens: 'sub',
          external: true,                // what the layer toggles, and what draws the divider
          vehicle: false, vehicleName: null, sales: false, isLead: false, live: null
        });
      });
      hlAppts.forEach(function(a){
        if(!a.sub_id) return;
        var es = etParts(a.start_at), ee = etParts(a.end_at); if(!es.date) return;
        var e = ee.dec > es.dec ? ee.dec : es.dec + 0.5;
        var rowId = 'sub_' + String(a.sub_id);
        var kindL = (KINDS[a.kind] && KINDS[a.kind].l) || 'Sub assignment';
        visits.push({
          vid:'hlsub_'+a.id, apptId:a.id, id:'hlsub_'+a.id, t:rowId, lead:true,
          date:es.date, s:es.dec, e:e,
          client:a.client || a.title || kindL, city:'', type:a.title || kindL,
          jobNo:a.job_no || null, div:'Subs',
          status:(a.status==='done'?'done':'scheduled'), kind:a.kind || 'sub',
          source:'hivelogic', locked:false,
          confirm:(a.confirm_state || 'unconfirmed'), lifecycle:(a.confirm_state || 'unconfirmed'),
          pinned:false, external:true,
          lat:(a.lat!=null?Number(a.lat):null), lng:(a.lng!=null?Number(a.lng):null),
          crew:[], crewSize:1, native:true
        });
      });

      // ---- LENS: neutral/real where available (weather stubbed clear so nothing errors) ----
      var weather = wxBuild(wx);   // REAL 16-day forecast for the service area (Open-Meteo)
      var assets = {}; techs.forEach(function(t){ assets[t.id] = t.vehicle ? (t.vehicleName || 'Vehicle') : '—'; });

      // ---- Materials lens: REAL, from materials_overview ----
      // Keyed by job NUMBER because that is what a card carries. The endpoint
      // is keyed by jobber_id and now returns jobNo alongside it; without that
      // shared key this lens could never join to a visit, which is why it was
      // an empty object and the toggle showed nothing.
      var materials = {};
      if (matsRes && matsRes.ok) {
        (matsRes.onSite || []).forEach(function(m){ if(m.jobNo) materials[m.jobNo] = { status:'ready', eta:m.materialsEta || null, title:m.title || null }; });
        (matsRes.ordered || []).forEach(function(m){ if(m.jobNo) materials[m.jobNo] = { status:'awaiting', eta:m.materialsEta || null, title:m.title || null }; });
      }

      // compliance stays [] on purpose. The plan gates it on a real source
      // (permits/inspections/renewals) that does not exist yet, and inventing
      // one would put fake deadlines on a dispatch board. money likewise has no
      // per-job open-invoice source wired yet.
      var LENS = { materials:materials, money:{}, compliance:[], assets:assets, weather:weather };

      // ---- unscheduled rail: REAL, from jobs with no slot ----
      var unsched = (res[7] && res[7].ok && res[7].jobs) || [];
      var unscheduledDemands = unsched.map(demandFromJob);
      window.HL_LENS_SOURCES = {
        materials: (matsRes && matsRes.ok) ? 'live' : 'unavailable',
        weather: wx ? 'live' : 'unavailable',
        assets: 'live', money: 'not-wired', compliance: 'not-wired'
      };

      window.LAB = {
        techs: techs, visits: visits, projects: [], unassigned: [],
        // REAL, from schedule_unscheduled. Only the fields a job actually has
        // are set: a job carries no required skill, no promised window and no
        // priority, and inventing those would put made-up urgency on a
        // dispatch board. The card renders whatever is present and skips the
        // rest.
        demands: unscheduledDemands,
        // Where the map opens. This used to be these coordinates hardcoded, with
        // a hardcoded zoom in app.js to match -- so the board opened on a fixed
        // point at a fixed scale regardless of where the company actually works.
        // It now comes from the division's service area (Company Setup), which
        // also supplies the zoom that frames the radius. The literal below is
        // the fallback for a company that has not set one yet, so nothing
        // regresses before sql/089 is applied.
        office: (function(){
          var cam = companyRes && companyRes.service_area && companyRes.service_area.camera;
          if (cam && cam.center && cam.center.lat != null) {
            return {
              name: cam.label || 'Service area',
              lat: cam.center.lat, lng: cam.center.lng,
              zoom: cam.zoom, radiusMiles: cam.radiusMiles, source: 'service-area'
            };
          }
          return { name:'GH Co. Shop', lat:41.14435668781, lng:-73.641778856887, source:'fallback' };
        })(),
        DIVCOLORS: DIVCOLORS, DIVISIONS: DIVISIONS, STATUS: STATUS, KINDS: KINDS,
        config: config, LENS: LENS, WEEK: WEEK, TODAY: TODAY, SIM_NOW: SIM_NOW,
        _meta: { unmatched: unmatched, techCount: techs.length, visitCount: visits.length, live: true }
      };

      // now boot the board (app.js reads window.LAB at load)
      var s = document.createElement('script'); s.src = './app.js';
      s.onerror = function(){ showMsg('Board engine failed to load.'); };
      document.body.appendChild(s);
    }).catch(function(err){
      showMsg('Could not load the live schedule.<br><span style="opacity:.7">'+(err && err.message ? err.message : err)+'</span><br><br>Make sure you\'re signed in, then reload.');
    });
  }

  // Follow HiveLogic's light/dark: parent sends 'theme' with the token and on toggle.
  // Setting data-theme swaps the CSS variables live; sl_theme keeps app.js's restore in sync.
  //
  // sl_theme is NOT a per-device setting that escaped the rule in CLAUDE.md.
  // This board's own theme toggle is hidden and the theme is pushed down from
  // HiveLogic by postMessage; sl_theme is only a local mirror of that, so the
  // board can paint before the parent's message arrives. The preference it
  // mirrors follows the user one level up.
  function applyTheme(th){ if(th!=='light'&&th!=='dark') return; try{ document.documentElement.setAttribute('data-theme', th); localStorage.setItem('sl_theme', th); }catch(e){} }
  // ---- asking the parent for a live token -----------------------------------
  // This board is an iframe, so it does not inherit HiveLogic's authenticated-
  // fetch shim and cannot heal its own 401s the way the parent page does. It
  // was handed a token once, on load, and Supabase access tokens die after an
  // hour -- so a HiveLogic session left open longer than that left this
  // document polling GPS every 60 seconds with a dead token and no path back
  // except navigating away and returning. Chris, 2026-08-23: his console was
  // filling with `GET /api/track1?resource=crew_schedule 401` on repeat.
  // The parent pushes each refreshed token down now; this is what asks when a
  // request 401s anyway. It resolves with whatever arrives, so a caller can
  // simply retry with window.HL_BOARD_TOKEN.
  var _tokenWaiters = [], _tokenPending = null;
  function deliverToken(t){
    var ws = _tokenWaiters; _tokenWaiters = []; _tokenPending = null;
    ws.forEach(function(fn){ try{ fn(t); }catch(e){} });
  }
  window.hlFreshToken = function(){
    if(_tokenPending) return _tokenPending;                       // one ask, however many callers
    if(window.parent === window) return Promise.resolve(window.HL_BOARD_TOKEN || '');
    var mine = new Promise(function(resolve){
      _tokenWaiters.push(resolve);
      // A parent that never answers must fail the request, not freeze the poll
      // loop that would have retried a minute later.
      setTimeout(function(){ if(_tokenPending === mine) deliverToken(window.HL_BOARD_TOKEN || ''); }, 4000);
      try { window.parent.postMessage({ type:'hl-crewboard-need-token' }, location.origin); }
      catch(e){ deliverToken(window.HL_BOARD_TOKEN || ''); }
    });
    _tokenPending = mine;
    return mine;
  };

  // One mapper for both the boot fetch and the refresh below, so the two
  // cannot drift into showing different cards for the same job.
  function demandFromJob(j){
    return {
      id: j.jobRef, jobRef: j.jobRef, jobNo: j.jobNo,
      title: j.title, client: j.client, city: j.city,
      div: j.division, total: j.total,
      // Deliberately absent rather than guessed: dur, skill, window, priority
      // and ready have no source on a job row, and made-up urgency on a
      // dispatch board is worse than a card with fewer chips.
      dur: null, skill: null, window: null, priority: null, ready: null
    };
  }

  // Re-read the rail. The board loads its data once at boot, so a job created
  // AFTER that -- which is exactly the case when HiveLogic sends you here
  // straight from the job form -- would not be in the list yet. Opening the
  // panel on stale data is how "it didn't show in the unassigned jobs layer"
  // happens a second time.
  //
  // Mutates the existing array rather than replacing it: app.js destructured
  // `demands` at load and holds a reference to that same array.
  window.hlRefreshUnscheduled = function(){
    var tok = window.HL_BOARD_TOKEN;
    return fetchJSON('/api/track1?resource=schedule_unscheduled', tok).then(function(r){
      if(!(r && r.ok && r.jobs) || !window.LAB || !window.LAB.demands) return false;
      var arr = window.LAB.demands;
      arr.length = 0;
      r.jobs.forEach(function(j){ arr.push(demandFromJob(j)); });
      return true;
    }).catch(function(){ return false; });
  };

  // token arrival: parent postMessage (preferred) OR shared session storage (fallback)
  window.addEventListener('message', function(ev){
    if(ev.origin !== location.origin) return;
    var d = ev.data || {};
    if(d.type === 'hl-crewboard-token'){ if(d.theme) applyTheme(d.theme); if(d.token){ window.HL_BOARD_TOKEN = d.token; deliverToken(d.token); boot(d.token); } } // always refresh the write token, even after boot
    else if(d.type === 'hl-crewboard-theme'){ applyTheme(d.theme); }
    // A job was just created from a lead and has no slot yet. HiveLogic sends
    // this as it switches to the Schedule tab, so he lands looking at the
    // unscheduled rail with the new job in it, ready to drag onto a crew --
    // rather than on a board that looks unchanged and leaves him hunting.
    //
    // Retried by the sender, because a board that is still booting has no
    // toggleUnassigned yet and dropping the request silently is how this
    // becomes "it did nothing again".
    else if(d.type === 'hl-crewboard-show-unscheduled'){
      if(typeof window.toggleUnassigned === 'function'){
        var after = function(){
          try{ window.toggleUnassigned(true); }catch(e){}
          try{ window.parent.postMessage({ type:'hl-crewboard-unscheduled-shown' }, location.origin); }catch(e){}
        };
        // Refresh FIRST. The job that sent us here was created seconds ago and
        // is not in the list the board loaded at boot.
        if(typeof window.hlRefreshUnscheduled === 'function') window.hlRefreshUnscheduled().then(after, after);
        else after();
      }
    }
  });
  // Ask straight away rather than only waiting to be told. The parent sends on
  // iframe load, but a board mounted from a cached frame gets no load event.
  try { if(window.parent !== window) window.parent.postMessage({ type:'hl-crewboard-need-token' }, location.origin); } catch(e){}
  // Prefer the parent's fresh (auto-refreshed) token; fall back to the shared session
  // token after a short wait, then a URL param, so we don't boot on a stale token.
  setTimeout(function(){ if(!boot._done){ var lt = tokenFromStorage(); if(lt) boot(lt); } }, 400);
  setTimeout(function(){ if(!boot._done){ var q = new URLSearchParams(location.search).get('t'); if(q) boot(q); else showMsg('Waiting for your session… if this sticks, reload the Schedule tab.'); } }, 1600);
})();
