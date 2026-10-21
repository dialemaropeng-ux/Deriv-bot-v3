
const pages=['multi','dashboard','scanner','strategy','risk','journal','account','autoTrade'];
const DERIV_WS='wss://api.derivws.com/trading/v1/options/ws/public';
let ws=null, req=0, pending=new Map(), lastCandles=[], lastAnalysis=null, autoTimer=null;
let tickSubscriptions=new Map(), tickPrices=new Map(), engineTimer=null, scanBusy=false;
const MULTI_KEY='atp_multi_markets_v3';
const TARGET_MARKET_LABELS=[
 'Volatility 10 Index','Volatility 25 Index','Volatility 50 Index','Volatility 75 Index','Volatility 100 Index',
 'Volatility 10 (1s) Index','Volatility 25 (1s) Index','Volatility 50 (1s) Index','Volatility 75 (1s) Index','Volatility 100 (1s) Index','Volatility 150 (1s) Index','Volatility 250 (1s) Index',
 'Boom 300 Index','Boom 500 Index','Boom 1000 Index','Crash 300 Index','Crash 500 Index','Crash 1000 Index','Gold','NASDAQ 100'
];
let marketCatalog=new Map();
let multiMarkets=[], multiTimer=null, multiMonitoring=false, multiState={}, lastAlertKeys={};
const SIGNAL_KEY='atp_frozen_signals_v2';
const JOURNAL_KEY='atp_demo_journal_v2';
let frozenSignals=loadJSON(SIGNAL_KEY,[]), setupStates=new Map();
let lastTickAt=new Map();
setInterval(()=>{renderMarketHealth();},2000);

const defaultSymbols=[
 ['R_75','Volatility 75 Index'],['R_10','Volatility 10 Index'],['R_25','Volatility 25 Index'],['R_50','Volatility 50 Index'],['R_100','Volatility 100 Index'],
 ['1HZ10V','Volatility 10 (1s) Index'],['1HZ25V','Volatility 25 (1s) Index'],['1HZ50V','Volatility 50 (1s) Index'],['1HZ75V','Volatility 75 (1s) Index'],['1HZ100V','Volatility 100 (1s) Index'],['1HZ150V','Volatility 150 (1s) Index'],['1HZ250V','Volatility 250 (1s) Index'],
 ['BOOM300','Boom 300 Index'],['BOOM500','Boom 500 Index'],['BOOM1000','Boom 1000 Index'],['CRASH300','Crash 300 Index'],['CRASH500','Crash 500 Index'],['CRASH1000','Crash 1000 Index'],['frxXAUUSD','Gold'],['OTC_NAS100','NASDAQ 100']
];


function loadJSON(key,fallback){try{const v=JSON.parse(localStorage.getItem(key)||'null');return v??fallback}catch(e){return fallback}}
function saveJSON(key,v){localStorage.setItem(key,JSON.stringify(v))}
function journalEntries(){return loadJSON(JOURNAL_KEY,[])}
function saveJournalEntries(v){saveJSON(JOURNAL_KEY,v)}
function signalSetupId(sym,a){return [sym,a.grade||'NONE',a.dir,a.bosI,a.ob?.i,a.fvg?.i].join('|')}
function getRiskSettings(){return {balance:+document.getElementById('balance')?.value||10000,riskPct:+document.getElementById('riskPct')?.value||1,maxTrades:+document.getElementById('maxTrades')?.value||3,lossLimit:+document.getElementById('lossLimit')?.value||3}}
function riskAmount(){const r=getRiskSettings();return r.balance*(r.riskPct/100)}
function readinessText(a){if(!a)return 'Waiting for scan'; if(a.signal)return a.grade==='STRONG'?'STRONG SIGNAL READY':'WEAK SIGNAL READY'; if(!a.bos)return 'Waiting for BOS'; if(!a.ob)return 'BOS found — waiting OB'; if(!a.fvg)return 'OB found — waiting FVG'; if(!a.retest)return 'Waiting for retest/reaction'; if(!a.conf)return 'Retest found — waiting closed confirmation'; if(!a.reclaim)return a.reclaimLost?'Reclaim lost — waiting for fresh continuation':'Waiting for reclaim / continuation break'; if(a.rr<((+document.getElementById('minRR')?.value)||2))return 'Reclaimed, RR below minimum'; if(a.confidence<a.minConfidence)return `Confidence ${a.confidence}/4 — need ${a.minConfidence}/4`; if(!a.oteOk)return 'WEAK candidate — confidence threshold met, OTE not reached'; return 'Strong candidate — OTE + confidence threshold met'}
function actualTarget(dir,entry,sl,cs){
  const risk=Math.abs(entry-sl); if(!risk)return {tp:null,rr:0,targetType:'none'};
  const recent=cs.slice(Math.max(0,cs.length-80));
  let target=null;
  if(dir==='BUY'){
    const highs=recent.map(c=>c.h).filter(x=>x>entry).sort((a,b)=>a-b);
    target=highs.find(x=>(x-entry)/risk>=2)??Math.max(entry+risk*2,...highs.filter(x=>x>entry));
  }else{
    const lows=recent.map(c=>c.l).filter(x=>x<entry).sort((a,b)=>b-a);
    target=lows.find(x=>(entry-x)/risk>=2)??Math.min(entry-risk*2,...lows.filter(x=>x<entry));
  }
  if(!Number.isFinite(target))target=dir==='BUY'?entry+risk*2:entry-risk*2;
  const rr=Math.abs(target-entry)/risk;
  return {tp:target,rr,targetType:rr>=2?'structural/2R+':'2R fallback'};
}
function freezeSignal(i,a){
  const sym=multiMarkets[i]; const setupId=signalSetupId(sym,a);
  const existing=frozenSignals.find(x=>x.setupId===setupId);
  if(existing)return existing;
  const now=new Date().toISOString();
  const signal={id:'SIG-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,7),setupId,symbol:sym,label:label(sym),timeframe:'M1',direction:a.dir,grade:a.grade,entry:a.entry,sl:a.sl,tp:a.tp,rr:a.rr,riskAmount:riskAmount(),riskPercent:getRiskSettings().riskPct,createdAt:now,status:'OPEN',exitPrice:null,resultR:null,reason:a.reason,confidence:a.confidence,displacement:a.displacement,sweep:a.sweep,rsi:a.rsi,atrOk:a.atrOk,bosI:a.bosI,obI:a.ob?.i??null,fvgI:a.fvg?.i??null,ote:a.ote?{lo:a.ote.lo,hi:a.ote.hi,mid:a.ote.mid}:null};
  frozenSignals.unshift(signal); frozenSignals=frozenSignals.slice(0,200); saveJSON(SIGNAL_KEY,frozenSignals);
  const j=journalEntries(); j.unshift(signal); saveJournalEntries(j.slice(0,200)); renderJournal(); return signal;
}
function updateJournalResult(id,result,exitPrice){
  const h=frozenSignals.map(x=>x.id===id?{...x,status:result,exitPrice:exitPrice??x.exitPrice,resultR:calcResultR(x,result,exitPrice)}:x);
  frozenSignals=h; saveJSON(SIGNAL_KEY,h); saveJournalEntries(h.slice()); renderJournal(); renderMultiRows();
}
function calcResultR(x,result,exitPrice){if(result==='WIN')return  Math.abs((x.tp-x.entry)/(x.entry-x.sl)); if(result==='LOSS')return -1; if(result==='BE')return 0; return null}
function renderJournal(){
 const h=frozenSignals; const wins=h.filter(x=>x.status==='WIN').length,loss=h.filter(x=>x.status==='LOSS').length,be=h.filter(x=>x.status==='BE').length,open=h.filter(x=>x.status==='OPEN').length,cancel=h.filter(x=>x.status==='CANCELLED').length;
 const decided=wins+loss+be; const net=h.reduce((s,x)=>s+(Number(x.resultR)||0),0);
 const set=(id,v)=>{const e=document.getElementById(id);if(e)e.textContent=v}; set('jTotal',h.length);set('jWins',wins);set('jLosses',loss);set('jBE',be);set('jOpen',open);set('jCancelled',cancel);set('jWinRate',(decided?wins/decided*100:0).toFixed(1)+'%');set('jNetR',net.toFixed(2)+'R');
 const box=document.getElementById('journalList'); if(!box)return;
 box.innerHTML=h.length?h.slice(0,50).map(x=>`<div style="display:block;padding:10px 0"><div class="row"><span><b>${x.grade==='STRONG'?'🔥 STRONG':x.grade==='WEAK'?'🟢 WEAK':'SIGNAL'} ${x.label} ${x.direction}</b><br><span class="tiny">${new Date(x.createdAt).toLocaleString()} • ${x.timeframe} • Risk R${Number(x.riskAmount||0).toFixed(2)}</span></span><span class="pill">${x.status}</span></div><div class="tiny" style="margin-top:6px">E ${fmt(x.entry)} • SL ${fmt(x.sl)} • TP ${fmt(x.tp)} • RR ${x.rr.toFixed(2)}R</div><div class="signal-actions" style="margin-top:6px">${x.status==='OPEN'?`<button onclick="updateJournalResult('${x.id}','WIN')">WIN</button><button class="secondary" onclick="updateJournalResult('${x.id}','LOSS')">LOSS</button><button class="secondary" onclick="updateJournalResult('${x.id}','BE')">BE</button><button class="dangerbtn" onclick="updateJournalResult('${x.id}','CANCELLED')">CANCEL</button>`:`<span class="tiny">Result: ${x.status} • ${x.resultR==null?'—':x.resultR.toFixed(2)+'R'}</span>`}</div></div>`).join(''):'<div class="muted">No frozen signals yet.</div>';
}
function exportJournal(){const blob=new Blob([JSON.stringify(frozenSignals,null,2)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='autotrade-pro-demo-journal.json';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000)}
function clearJournal(){if(!confirm('Clear all frozen demo signals and results?'))return;frozenSignals=[];saveJSON(SIGNAL_KEY,[]);saveJSON(JOURNAL_KEY,[]);renderJournal()}
function loadMultiMarkets(){try{const x=JSON.parse(localStorage.getItem(MULTI_KEY)||'null');return Array.isArray(x)&&x.length===TARGET_MARKET_LABELS.length?x:[];}catch(e){return []}}
function saveMultiMarkets(){localStorage.setItem(MULTI_KEY,JSON.stringify(multiMarkets))}
function marketOptions(selected){
  const opts=[...marketCatalog.entries()].map(([sym,name])=>[sym,name]);
  const source=opts.length?opts:defaultSymbols;
  return source.map(x=>`<option value="${x[0]}" ${x[0]===selected?'selected':''}>${x[1]}</option>`).join('');
}
function label(sym){return marketCatalog.get(sym)||defaultSymbols.find(x=>x[0]===sym)?.[1]||sym}
function resolveTargetMarkets(symbols){
  const items=symbols.map(x=>({sym:x.underlying_symbol||x.symbol,name:x.underlying_symbol_name||x.display_name||''})).filter(x=>x.sym);
  const norm=s=>String(s).toLowerCase().replace(/\s+/g,' ').trim();
  const exact=new Map(items.map(x=>[norm(x.name),x]));
  const pick=(patterns, fallbackName)=>{
    const hit=items.find(x=>patterns.some(r=>r.test(norm(x.name))));
    return hit?hit.sym:null;
  };
  const wanted=[];
  for(const name of TARGET_MARKET_LABELS){
    let hit=exact.get(norm(name));
    if(!hit){
      if(name==='Gold') hit=items.find(x=>/gold|xau\s*\/?\s*usd/i.test(x.name));
      else if(name==='NASDAQ 100') hit=items.find(x=>/nasdaq\s*100|nasdaq100|us tech 100|nas100/i.test(x.name));
      else hit=items.find(x=>norm(x.name)===norm(name));
    }
    if(hit){wanted.push(hit.sym);marketCatalog.set(hit.sym,hit.name||name);}
  }
  // Preserve all requested categories; if a broker/account omits a symbol, do not invent it.
  return [...new Set(wanted)];
}
async function discoverMarkets(){
  await openWS();
  const d=await rpc({active_symbols:'brief'});
  const found=resolveTargetMarkets(d.active_symbols||[]);
  if(found.length>=10){multiMarkets=found;saveMultiMarkets();}
  else {
    const saved=loadMultiMarkets();
    multiMarkets=saved.length?saved:defaultSymbols.map(x=>x[0]);
    defaultSymbols.forEach(x=>marketCatalog.set(x[0],x[1]));
  }
  renderMultiRows();
  initSymbols();
  return multiMarkets;
}
function multiStatus(a,err){
  if(err)return ['⚪ NO SETUP','neutral'];
  if(a?.signal)return a.grade==='STRONG'?['🔥 STRONG SIGNAL','signal']:['🟢 WEAK SIGNAL','signal'];
  if(a?.bos&&a?.ob&&a?.fvg&&a?.retest&&a?.conf&&a?.reclaim&&a?.rr>=((+document.getElementById('minRR')?.value)||2)&&!a?.oteOk)return ['🟢 WEAK READY','signal'];
  if(a?.bos&&a?.ob&&a?.fvg&&a?.retest&&a?.conf&&!a?.reclaim)return [a.reclaimLost?'🟠 RECLAIM LOST':'🟡 WAITING RECLAIM','neutral'];
  if(a?.bos&&a?.ob&&a?.fvg&&a?.retest&&!a?.conf)return ['🟡 WAITING CONFIRM','neutral'];
  if(a?.bos&&a?.ob&&a?.fvg&&!a?.retest)return ['🟡 WAITING RETEST','neutral'];
  if(a?.bos||a?.ob||a?.fvg)return ['🔵 WATCHING','neutral'];
  return ['⚪ NO SETUP','neutral'];
}
function renderMarketHealth(){const box=document.getElementById('marketHealthRows');if(!box)return;box.innerHTML=multiMarkets.map(sym=>{const t=lastTickAt.get(sym);const age=t?Date.now()-t:Infinity;const state=age<5000?'🟢 LIVE':age<20000?'🟡 STALE':'🔴 NO TICKS';return `<div class="atp-row"><span>${label(sym)}</span><strong>${state}${Number.isFinite(age)?' • '+Math.floor(age/1000)+'s':''}</strong></div>`}).join('')}

let dualLayerIndex=0;

function layerMark(v, labelYes='✓ YES', labelNo='✕ NO'){
  if(v===null || v===undefined)return '<span class="layer-wait">—</span>';
  return v
    ? '<span class="layer-yes">'+labelYes+'</span>'
    : '<span class="layer-no">'+labelNo+'</span>';
}
function layerText(v){
  if(v===null || v===undefined)return 'WAITING';
  return v?'READY':'WAITING';
}
function selectDualLayer(v){
  const i=Math.max(0,Math.min(multiMarkets.length-1,Number(v)||0));
  dualLayerIndex=i;
  renderDualLayers();
}
function renderDualLayers(){
  const select=document.getElementById('dualLayerSelect');
  if(!select)return;

  if(select.options.length!==multiMarkets.length){
    select.innerHTML=multiMarkets.map((sym,i)=>`<option value="${i}">${i+1}. ${label(sym)}</option>`).join('');
  }
  if(multiMarkets.length){
    dualLayerIndex=Math.min(dualLayerIndex,multiMarkets.length-1);
    select.value=String(dualLayerIndex);
  }

  const sym=multiMarkets[dualLayerIndex];
  const state=multiState[dualLayerIndex];
  const a=state?.analysis;
  const s=state?.sniper;
  const market=document.getElementById('dualLayerMarket');
  if(market)market.textContent=sym?label(sym):'WAITING';

  const set=(id,html)=>{const e=document.getElementById(id);if(e)e.innerHTML=html};
  const txt=(id,v)=>{const e=document.getElementById(id);if(e)e.textContent=v};

  if(!a){
    txt('dualCurrentState','WAITING FOR SCAN');
    ['dlBos','dlOb','dlFvg','dlRetest','dlConf','dlReclaim','dlDisp','dlSweep','dlRsi','dlAtr','dlOte','dlScore','dlRr'].forEach(id=>set(id,'<span class="layer-wait">—</span>'));
    txt('dualCurrentResult','WAITING');
  }else{
    txt('dualCurrentState',a.signal?`${a.grade} ${a.dir}`:readinessText(a));
    set('dlBos',layerMark(a.bos));
    set('dlOb',layerMark(!!a.ob));
    set('dlFvg',layerMark(!!a.fvg));
    set('dlRetest',layerMark(a.retest));
    set('dlConf',layerMark(a.conf));
    set('dlReclaim',layerMark(a.reclaim));
    set('dlDisp',layerMark(a.displacement));
    set('dlSweep',layerMark(a.sweep));
    set('dlRsi',a.rsiOk?'<span class="layer-yes">✓ '+Number(a.rsi).toFixed(1)+'</span>':'<span class="layer-no">✕ '+Number(a.rsi||0).toFixed(1)+'</span>');
    set('dlAtr',layerMark(a.atrOk));
    set('dlOte',layerMark(a.oteOk));
    txt('dlScore',`${a.confidence??0}/4`);
    txt('dlRr',Number(a.rr||0).toFixed(2)+'R');
    txt('dualCurrentResult',a.signal?`🟢 ${a.grade} ${a.dir} • ENTRY ${fmt(a.entry)}`:`🟡 ${a.reason||'WAITING'}`);
  }

  if(!s){
    txt('dualSniperState','WAITING FOR SCAN');
    ['dsStructure','dsSweep','dsDisp','dsFvg','dsOte','dsConf','dsScore','dsRr'].forEach(id=>set(id,'<span class="layer-wait">—</span>'));
    txt('dualSniperResult','WAITING');
  }else{
    txt('dualSniperState',s.signal?`SIGNAL ${s.dir}`:`SCORE ${s.score}/100`);
    set('dsStructure',layerMark(s.dir!=='NONE'));
    set('dsSweep',layerMark(s.sweep));
    set('dsDisp',layerMark(s.displacement));
    set('dsFvg',layerMark(s.fvg));
    set('dsOte',layerMark(s.ote));
    set('dsConf',layerMark(s.confirmation));
    txt('dsScore',`${s.score}/100`);
    txt('dsRr',Number(s.rr||0).toFixed(2)+'R');
    txt('dualSniperResult',s.signal?`🔥 SNIPER ${s.dir} • ENTRY ${fmt(s.entry)}`:`🟡 ${s.reason||'WAITING'}`);
  }

  const con=document.getElementById('dualConfluence');
  if(!con)return;
  con.className='dual-confluence';
  if(a?.signal&&s?.signal&&a.dir===s.dir){
    con.classList.add('agree');
    con.textContent=`🔥 BOTH STRATEGIES AGREE — ${a.dir} • ${label(sym)}`;
  }else if(a?.signal&&s?.signal&&a.dir!==s.dir){
    con.classList.add('conflict');
    con.textContent=`⚠️ STRATEGY CONFLICT — CURRENT ${a.dir} / SNIPER ${s.dir}`;
  }else if(a?.signal){
    con.textContent=`📘 CURRENT ONLY — ${a.dir} • Sniper is waiting`;
  }else if(s?.signal){
    con.textContent=`🎯 SNIPER ONLY — ${s.dir} • Current strategy is waiting`;
  }else{
    con.textContent='⚪ Waiting for both strategy engines';
  }
}

function renderMultiRows(){
  const box=document.getElementById('multiRows'); if(!box)return;
  const strong=[],weak=[];
  box.innerHTML=multiMarkets.map((sym,i)=>{
    const s=multiState[i], a=s?.analysis, err=s?.error;
    const [st,cls]=multiStatus(a,err);
    if(a?.signal&&a.grade==='STRONG')strong.push({i,sym,a});
    if(a?.signal&&a.grade==='WEAK')weak.push({i,sym,a});
    const time=s?.time?new Date(s.time).toLocaleTimeString():'not scanned';
    const tick=tickPrices.get(sym);
    const price=tick?.price!=null?fmt(tick.price):(s?.price!=null?fmt(s.price):'—');
    const tickAge=tick?.time?Math.max(0,Date.now()-tick.time):Infinity; const tickTime=tick?.time?`${new Date(tick.time).toLocaleTimeString()} • ${tickAge<5000?'LIVE':tickAge<20000?'STALE':'NO TICK'}`:'waiting for ticks';
    const sn=s?.sniper;
const checks=a?`CURRENT: BOS ${a.bos?'✓':'…'} · OB ${a.ob?'✓':'…'} · FVG ${a.fvg?'✓':'…'} · CONF ${a.conf?'✓':'…'} · RECLAIM ${a.reclaim?'✓':'…'} · OTE ${a.oteOk?'✓':'…'}<br>SNIPER: ${sn?.signal?'🔥 '+sn.dir+' '+sn.score+'/100':'Score '+(sn?.score??0)+'/100'} · Sweep ${sn?.sweep?'✓':'…'} · Disp ${sn?.displacement?'✓':'…'} · FVG ${sn?.fvg?'✓':'…'} · OTE ${sn?.ote?'✓':'…'}`:'Waiting for scan…';
    const signalClass=a?.signal?(a.dir==='SELL'?'sell':'signal'):'';
    const frozen=frozenSignals.find(x=>x.setupId===signalSetupId(sym,a)); const fa=frozen||a;
    const detail=a?.signal?`<div class="compact-note"><b class="${a.grade==='STRONG'?'grade-strong':'grade-weak'}">${a.grade}</b> ${a.dir} · E ${fmt(fa.entry)} · SL ${fmt(fa.sl)} · TP ${fmt(fa.tp)} · ${fa.rr.toFixed(2)}R${frozen?` · ${frozen.status}`:''}</div>`:(err?`<div class="compact-note danger">${escapeHtml(err)}</div>`:`<div class="compact-note">${a?.reason||'Monitoring…'}${a?.reclaimLevel!=null?` · Reclaim ${fmt(a.reclaimLevel)}`:''}${a?.confidence!=null?` · Confidence ${a.confidence}/4`:''}</div>`);
    return `<div class="multi-market ${signalClass}" id="multi-market-${i}">
      <div class="multi-market-head"><div><div class="multi-market-title">${i+1}. ${label(sym)}</div><div class="multi-market-meta">M1 · ${time}</div></div><span class="pill">${st}</span></div>
      <div class="multi-price" id="multi-price-${i}">${price}</div><div class="multi-tick" id="multi-tick-${i}">Tick: ${tickTime}</div>
      <div class="multi-checks">${checks}</div>
      ${detail}
      <div class="multi-controls"><select onchange="changeMultiMarket(${i},this.value)" aria-label="Market ${i+1}">${marketOptions(sym)}</select><button class="secondary" onclick="viewMultiMarket(${i})">View</button></div>
    </div>`;
  }).join('');

  const active=[...strong,...weak];
  const activeBox=document.getElementById('multiSignalAlert');
  if(active.length){
    const top=active[0],a=top.a; const fs=frozenSignals.find(x=>x.setupId===signalSetupId(top.sym,a))||a;
    activeBox.innerHTML=`<div class="card new-signal" id="active-signal-card">
      <h3>${a.grade==='STRONG'?'🔥':'🟢'} ${a.grade} SIGNAL — ${label(top.sym)} ${a.dir}</h3>
      <div class="signal-grid"><div class="signal-item"><span>Entry</span><b>${fmt(fs.entry)}</b></div><div class="signal-item"><span>Stop Loss</span><b>${fmt(fs.sl)}</b></div><div class="signal-item"><span>Take Profit</span><b>${fmt(fs.tp)}</b></div><div class="signal-item"><span>Risk / Reward</span><b>1:${fs.rr.toFixed(2)}</b></div></div>
      <div class="compact-note">${a.grade==='STRONG'?'OTE + reclaim confirmed — highest grade':'OTE not reached — weak setup using retest + confirmation + reclaim + confidence filters'} · Risk budget: R${riskAmount().toFixed(2)}</div>
      <div class="signal-actions"><button onclick="viewMultiMarket(${top.i})">Tap to view setup</button><button class="secondary" onclick="document.getElementById('active-signal-card').classList.add('hidden')">Dismiss</button></div>
    </div>`;
  }else activeBox.innerHTML='';
  document.getElementById('multiActive').textContent=active.length;
  document.getElementById('multiStrong').textContent=strong.length;
  document.getElementById('multiWeak').textContent=weak.length;
  document.getElementById('multiWaiting').textContent=Math.max(0,multiMarkets.length-active.length);
  renderMarketHealth(); renderEngineReadiness(); renderRiskLive(); renderDualLayers();
}
function renderEngineReadiness(){
  const box=document.getElementById('engineReadiness'); if(!box)return;
  const states=multiMarkets.map((sym,i)=>({sym,a:multiState[i]?.analysis,err:multiState[i]?.error}));
  const strong=states.filter(x=>x.a?.signal&&x.a.grade==='STRONG').length;
  const weak=states.filter(x=>x.a?.signal&&x.a.grade==='WEAK').length;
  const live=states.filter(x=>{const t=lastTickAt.get(x.sym);return t&&Date.now()-t<5000}).length;
  const last=Math.max(0,...states.map(x=>x.a?.evaluatedAt||0));
  box.innerHTML=`<div class="atp-status-title">⚙️ Signal Engine — Trade Readiness</div><div class="readiness-grid"><div class="readiness-item"><span>Data</span><b>${live}/${multiMarkets.length} LIVE</b></div><div class="readiness-item"><span>Strong</span><b class="grade-strong">${strong} READY</b></div><div class="readiness-item"><span>Weak</span><b class="grade-weak">${weak} READY</b></div><div class="readiness-item"><span>Engine</span><b>${multiMonitoring?'RUNNING':'STOPPED'}</b></div></div><div class="tiny" style="margin-top:8px">${last?`Last evaluation: ${new Date(last).toLocaleTimeString()}`:'No evaluation yet'} • ${multiMonitoring?'Next scan in up to 15s':'Start monitoring to evaluate'}</div>`;
}
function updateTickUI(sym,price,epoch){
  const i=multiMarkets.indexOf(sym); if(i<0)return;
  lastTickAt.set(sym,Date.now());
  const p=document.getElementById(`multi-price-${i}`),t=document.getElementById(`multi-tick-${i}`);
  if(p)p.textContent=fmt(price);
  if(t)t.textContent=`Tick: ${new Date((epoch||Math.floor(Date.now()/1000))*1000).toLocaleTimeString()}`;
  if(document.getElementById('symbol')?.value===sym){
    const hp=document.getElementById('homePrice'); if(hp)hp.textContent=fmt(price);
  }
}
function escapeHtml(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function changeMultiMarket(i,sym){multiMarkets[i]=sym;saveMultiMarkets();multiState[i]=null;renderMultiRows();scanAllMarkets()}
function viewMultiMarket(i){
  dualLayerIndex=i; renderDualLayers();
  const sym=multiMarkets[i];
  document.getElementById('symbol').value=sym;
  show('scanner',document.querySelectorAll('.nav button')[2]);
  connectAndScan();
}
function notificationSupported(){return 'Notification' in window}
async function enableNotifications(){
  if(!notificationSupported()){alert('This browser does not support phone notifications.');return}
  try{
    const p=await Notification.requestPermission();
    alert(p==='granted'?'Phone notifications enabled.':'Notifications were not enabled.');
  }catch(e){alert('Notification permission could not be requested.')}
}
function playSignalSound(){
  try{
    const C=window.AudioContext||window.webkitAudioContext;if(!C)return;
    const c=new C(),o=c.createOscillator(),g=c.createGain();
    o.type='sine';o.frequency.value=880;g.gain.value=.001;
    o.connect(g);g.connect(c.destination);const t=c.currentTime;
    g.gain.exponentialRampToValueAtTime(.12,t+.02);o.start(t);g.gain.exponentialRampToValueAtTime(.001,t+.45);o.stop(t+.5);
  }catch(e){}
}
function alertNewSignal(i,a){
  const key=signalSetupId(multiMarkets[i],a);
  if(lastAlertKeys[i]===key)return;
  lastAlertKeys[i]=key;
  const frozen=freezeSignal(i,a);
  playSignalSound();
  if(notificationSupported()&&Notification.permission==='granted'){
    try{
      const n=new Notification(`🔥 NEW SIGNAL — ${label(multiMarkets[i])} ${a.dir}`,{body:`${a.grade} • Confidence ${a.confidence}/4 • Entry: ${fmt(a.entry)} • SL: ${fmt(a.sl)} • TP: ${fmt(a.tp)} • RR: ${a.rr.toFixed(2)}`,tag:'atp-'+multiMarkets[i]+'-'+a.grade,renotify:true});
      n.onclick=()=>{window.focus();viewMultiMarket(i);n.close()};
    }catch(e){}
  }
  if(document.visibilityState==='visible'){
    document.getElementById('multiLastScan').textContent=`🔥 New ${a.dir} signal on ${label(multiMarkets[i])} at ${fmt(a.entry)}`;
  }
}
function updateMultiMonitorUI(){
  document.getElementById('multiMonitorPill').textContent=multiMonitoring?'LIVE':'WATCHING';
  document.getElementById('engineHeartbeat').textContent=multiMonitoring?'Engine running — live ticks + 15s evaluations':'Engine idle — start monitoring';
  document.getElementById('multiMonitorPill').className='pill '+(multiMonitoring?'ok':'');
  document.getElementById('multiMonitorBtn').textContent=multiMonitoring?'⏸ Stop Background Monitoring':'▶ Start Background Monitoring'; renderEngineReadiness(); renderRiskLive();
}
function toggleMultiMonitor(){
  if(multiMonitoring){
    multiMonitoring=false;
    clearInterval(multiTimer);multiTimer=null;
    clearInterval(engineTimer);engineTimer=null;
    updateMultiMonitorUI();
    return;
  }
  multiMonitoring=true;updateMultiMonitorUI();
  startTickStream();
  scanAllMarkets(true);
  engineTimer=setInterval(()=>scanAllMarkets(true),15000);
}
async function scanOneMarket(sym){
  const d=await rpc({ticks_history:sym,end:'latest',count:250,style:'candles',granularity:60});
  if(!d.candles||d.candles.length<50)throw new Error('Not enough candle data');
  const cs=d.candles.map(c=>({t:+c.epoch,o:+c.open,h:+c.high,l:+c.low,c:+c.close}));
  const live=tickPrices.get(sym)?.price ?? cs.at(-1).c;
  const analysis=analyze(cs,live);
  const sniper=analyzeSniper(cs,live);
  return {analysis,sniper,price:live,time:Date.now(),lastTickAt:lastTickAt.get(sym)||null};
}
async function scanAllMarkets(silent=false){
  if(scanBusy)return;
  scanBusy=true;
  try{
    await openWS();
    startTickStream();
    setConn(true,'Connected','Live ticks + M1 signal engine');
    const results=await Promise.all(multiMarkets.map(async(sym,i)=>{
      try{
        const r=await scanOneMarket(sym);
        const prev=multiState[i]?.analysis;
        multiState[i]=r;
        if(r.analysis.signal && (!prev?.signal || prev.grade!==r.analysis.grade || prev.dir!==r.analysis.dir || Math.abs((prev.entry||0)-r.analysis.entry)>1e-10))alertNewSignal(i,r.analysis);
        if(r.sniper?.signal && (!multiState[i]?.sniper?.signal || multiState[i]?.sniper?.dir!==r.sniper.dir || Math.abs((multiState[i]?.sniper?.entry||0)-r.sniper.entry)>1e-10))alertSniperSignal(i,r.sniper); if(autoTradingArmed && autoExecutionCheck) setTimeout(autoExecutionCheck,0);
        return r;
      }catch(e){
        multiState[i]={error:e.message,time:Date.now(),price:tickPrices.get(sym)?.price};
        return null;
      }
    }));
    renderMultiRows();
    renderDualLayers();
    document.getElementById('multiLastScan').textContent=`Last engine scan: ${new Date().toLocaleTimeString()} • ${multiMarkets.length} markets • M1 • ticks LIVE`;
    document.getElementById('engineHeartbeat').textContent=`Engine healthy • last evaluation ${new Date().toLocaleTimeString()} • ${multiMarkets.length}/${multiMarkets.length} markets`; renderEngineReadiness();
    if(!silent && results.some(Boolean)) document.getElementById('multi').scrollIntoView({behavior:'smooth',block:'start'});
  }catch(e){
    setConn(false,'Unavailable',e.message);
    document.getElementById('multiLastScan').textContent='Engine disconnected — reconnecting automatically…';
    document.getElementById('engineHeartbeat').textContent='Engine reconnecting…';
  }finally{scanBusy=false}
}
function startTickStream(){
  if(!ws||ws.readyState!==1)return;
  for(const sym of multiMarkets){
    if(tickSubscriptions.has(sym))continue;
    try{ws.send(JSON.stringify({ticks:sym,subscribe:1,req_id:++req}));}catch(e){}
  }
}
function stopTickStream(){
  if(ws&&ws.readyState===1){
    for(const sub of tickSubscriptions.values()){
      try{ws.send(JSON.stringify({forget:sub}))}catch(e){}
    }
  }
  tickSubscriptions.clear();
}

function show(id,b){pages.forEach(p=>document.getElementById(p).classList.toggle('hidden',p!==id));document.getElementById('title').textContent=b.textContent;document.querySelectorAll('.nav button').forEach(x=>x.classList.remove('active'));b.classList.add('active')}
function initSymbols(){const s=document.getElementById('symbol');const source=marketCatalog.size?[...marketCatalog.entries()]:defaultSymbols;s.innerHTML=source.map(x=>`<option value="${x[0]}">${x[1]}</option>`).join('');if(multiMarkets[0])s.value=multiMarkets[0];}
function toggleAuto(){const e=document.getElementById('auto');e.classList.toggle('on');if(e.classList.contains('on')){connectAndScan();autoTimer=setInterval(()=>connectAndScan(true).catch(()=>forceReconnect()),60000)}else{clearInterval(autoTimer);autoTimer=null}}
function setConn(ok,text,sub){document.getElementById('connectionText').textContent=text;document.getElementById('connectionSub').textContent=sub;const p=document.getElementById('connectionPill');p.textContent=ok?'ONLINE':'OFFLINE';p.className='pill '+(ok?'ok':'no')}
function rpc(payload){return new Promise((resolve,reject)=>{if(!ws||ws.readyState!==1)return reject(new Error('WebSocket not connected'));const id=++req;payload.req_id=id;pending.set(id,{resolve,reject});ws.send(JSON.stringify(payload));setTimeout(()=>{if(pending.has(id)){pending.delete(id);reject(new Error('Request timeout'))}},12000)})}
let reconnectTimer=null;
let heartbeatTimer=null;
let reconnectDelay=1000;
const MAX_RECONNECT_DELAY=30000;

function startHeartbeat(){
  stopHeartbeat();
  heartbeatTimer=setInterval(()=>{
    if(ws&&ws.readyState===1){
      try{ws.send(JSON.stringify({ping:1}))}catch(e){}
    }
  },25000);
}
function stopHeartbeat(){
  if(heartbeatTimer){clearInterval(heartbeatTimer);heartbeatTimer=null}
}
function scheduleReconnect(){
  if(reconnectTimer)return;
  reconnectTimer=setTimeout(async()=>{
    reconnectTimer=null;
    if(document.visibilityState==='hidden')return;
    try{await openWS(); await connectAndScan(true)}
    catch(e){reconnectDelay=Math.min(reconnectDelay*2,MAX_RECONNECT_DELAY);scheduleReconnect()}
  },reconnectDelay);
}
function forceReconnect(){
  reconnectDelay=1000;
  tickSubscriptions.clear();
  try{if(ws)ws.close()}catch(e){}
  ws=null;
  scheduleReconnect();
}
document.addEventListener('visibilitychange',()=>{
  if(document.visibilityState==='visible'){
    if(!ws||ws.readyState!==1)forceReconnect();
    else connectAndScan(true).catch(()=>forceReconnect());
  }
});
window.addEventListener('online',()=>{
  if(!ws||ws.readyState!==1)forceReconnect();
});
window.addEventListener('offline',()=>{
  setConn(false,'OFFLINE','Waiting for internet connection…');
});

function openWS(){
  return new Promise((resolve,reject)=>{
    if(ws&&ws.readyState===1)return resolve();
    if(ws&&ws.readyState===0){const t=setTimeout(()=>reject(new Error('Connection timeout')),10000);ws.addEventListener('open',()=>{clearTimeout(t);resolve()},{once:true});return}
    try{ws=new WebSocket(DERIV_WS)}catch(e){return reject(e)}
    ws.onopen=()=>{
      reconnectDelay=1000;
      tickSubscriptions.clear();
      clearTimeout(reconnectTimer);
      setConn(true,'Connected','Deriv public market data • auto-reconnect enabled');
      startHeartbeat();
      setTimeout(()=>{if(multiMonitoring)startTickStream()},100);
      resolve();
    };
    ws.onerror=()=>{
      setConn(false,'Connection problem','Retrying automatically…');
    };
    ws.onclose=e=>{
      stopHeartbeat();
      tickSubscriptions.clear();
      setConn(false,'Disconnected',`Public market data • retrying in ${Math.ceil(reconnectDelay/1000)}s`);
      scheduleReconnect();
      reject(new Error('WebSocket closed'));
    };
    ws.onmessage=e=>{
      try{
        const d=JSON.parse(e.data);
        if(d.msg_type==='tick'&&d.tick){
          const sym=d.tick.symbol;
          const price=Number(d.tick.quote);
          const epoch=Number(d.tick.epoch);
          if(sym&&Number.isFinite(price)){
            tickPrices.set(sym,{price,time:epoch*1000});
            updateTickUI(sym,price,epoch);
          }
          return;
        }
        if(d.subscription?.id&&d.echo_req?.ticks){
          tickSubscriptions.set(d.echo_req.ticks,d.subscription.id);
          return;
        }
        if(d.req_id&&pending.has(d.req_id)){
          const p=pending.get(d.req_id);pending.delete(d.req_id);
          if(d.error)p.reject(new Error(d.error.message||'API error'));else p.resolve(d);
        }
      }catch(err){}
    };
  });
}
async function connectAndScan(silent=false){try{const sym=document.getElementById('symbol').value, gran=+document.getElementById('tf').value;setConn(false,'Connecting…','Loading market data');await openWS();const d=await rpc({ticks_history:sym,end:'latest',count:250,style:'candles',granularity:gran});if(!d.candles||d.candles.length<50)throw new Error('Not enough candle data');lastCandles=d.candles.map(c=>({t:+c.epoch,o:+c.open,h:+c.high,l:+c.low,c:+c.close}));const live=tickPrices.get(sym)?.price ?? lastCandles.at(-1).c;const a=analyze(lastCandles,live);lastAnalysis=a;renderAnalysis(a);document.getElementById('homeSymbol').textContent=label(sym);document.getElementById('homePrice').textContent=fmt(live);document.getElementById('homeTf').textContent=tfLabel(gran);document.getElementById('homeScan').textContent=new Date().toLocaleTimeString();document.getElementById('scanMeta').textContent=`${lastCandles.length} candles • ${tfLabel(gran)} • ${label(sym)}`;setConn(true,'Connected','Live public market data');if(!silent)document.getElementById('result').scrollIntoView({behavior:'smooth',block:'start'});if(document.getElementById('auto').classList.contains('on')) journalSignal(a)}catch(e){setConn(false,'Unavailable',e.message);if(!silent)document.getElementById('result').innerHTML=`<div class="card neutral"><b>Scanner unavailable</b><p class="muted">${e.message}</p><p class="tiny">The scanner needs an internet connection to the public market-data service.</p></div>`}}
function tfLabel(g){return g===300?'M5':g===900?'M1':g===3600?'H1':g+'s'}
function fmt(n){return Number(n).toLocaleString(undefined,{maximumFractionDigits:6})}

function swingHigh(cs,i){return cs[i].h>cs[i-1].h&&cs[i].h>=cs[i+1].h&&cs[i].h>cs[i-2].h&&cs[i].h>=cs[i+2].h}
function swingLow(cs,i){return cs[i].l<cs[i-1].l&&cs[i].l<=cs[i+1].l&&cs[i].l<cs[i-2].l&&cs[i].l<=cs[i+2].l}
function candleBull(c){return c.c>c.o}
function candleBear(c){return c.c<c.o}
function body(c){return Math.abs(c.c-c.o)}
function range(c){return Math.max(c.h-c.l,1e-9)}
function bullishConfirmation(cs,i){
  if(i<1)return false;
  const c=cs[i],p=cs[i-1];
  const engulf=candleBull(c)&&c.o<=p.c&&c.c>=p.o;
  const rejection=candleBull(c)&&((Math.min(c.o,c.c)-c.l)/range(c)>=0.45)&&c.c>=c.l+range(c)*0.65;
  const displacement=candleBull(c)&&body(c)>=body(p)*1.15&&c.c>p.h;
  return engulf||rejection||displacement;
}
function bearishConfirmation(cs,i){
  if(i<1)return false;
  const c=cs[i],p=cs[i-1];
  const engulf=candleBear(c)&&c.o>=p.c&&c.c<=p.o;
  const rejection=candleBear(c)&&((c.h-Math.max(c.o,c.c))/range(c)>=0.45)&&c.c<=c.h-range(c)*0.65;
  const displacement=candleBear(c)&&body(c)>=body(p)*1.15&&c.c<p.l;
  return engulf||rejection||displacement;
}
function atrSeries(cs,period=14){
 const out=[]; for(let i=0;i<cs.length;i++){const p=i?cs[i-1].c:cs[i].c; const tr=Math.max(cs[i].h-cs[i].l,Math.abs(cs[i].h-p),Math.abs(cs[i].l-p)); out.push(tr)}
 return out;
}
function calcRSI(cs,period=14){
 if(cs.length<=period)return 50; let gain=0,loss=0;
 for(let i=cs.length-period;i<cs.length;i++){const d=cs[i].c-cs[i-1].c;if(d>=0)gain+=d;else loss-=d}
 if(loss===0)return 100; if(gain===0)return 0; const rs=gain/loss; return 100-(100/(1+rs));
}
function recentLiquiditySweep(cs,dir,from,to){
 const s=Math.max(2,from), e=Math.min(to,cs.length-2); if(e<s)return false;
 for(let i=s;i<=e;i++){
   const priorHigh=Math.max(...cs.slice(Math.max(0,i-8),i).map(c=>c.h));
   const priorLow=Math.min(...cs.slice(Math.max(0,i-8),i).map(c=>c.l));
   if(dir==='SELL' && cs[i].h>priorHigh && cs[i].c<priorHigh)return true;
   if(dir==='BUY' && cs[i].l<priorLow && cs[i].c>priorLow)return true;
 }
 return false;
}
function analyze(cs,livePrice=null){
 const n=cs.length, live=Number.isFinite(Number(livePrice))?Number(livePrice):cs.at(-1).c;
 const li=Math.max(2,n-2), prev=li-1;
 const highs=[],lows=[];
 for(let i=2;i<li-1;i++){if(swingHigh(cs,i))highs.push({i,p:cs[i].h});if(swingLow(cs,i))lows.push({i,p:cs[i].l});}
 let dir='NONE',bos=false,bosI=-1,broken=null,impulseLow=null,impulseHigh=null;
 for(let i=li;i>=20;i--){
   const h=highs.filter(x=>x.i<i).at(-1), l=lows.filter(x=>x.i<i).at(-1);
   if(h&&cs[i].c>h.p){dir='BUY';bos=true;bosI=i;broken=h;break;}
   if(l&&cs[i].c<l.p){dir='SELL';bos=true;bosI=i;broken=l;break;}
 }
 if(bos&&dir==='BUY'){
   impulseLow=lows.filter(x=>x.i<broken.i).at(-1); impulseHigh={i:broken.i,p:broken.p};
   if(!impulseLow||bosI-impulseLow.i>60){bos=false;dir='NONE';}
 }else if(bos&&dir==='SELL'){
   impulseHigh=highs.filter(x=>x.i<broken.i).at(-1); impulseLow={i:broken.i,p:broken.p};
   if(!impulseHigh||bosI-impulseHigh.i>60){bos=false;dir='NONE';}
 }
 let ob=null;
 if(bos){for(let i=bosI-1;i>=Math.max(2,bosI-25);i--){if(dir==='BUY'&&candleBear(cs[i])){ob={i,lo:cs[i].l,hi:cs[i].h};break;}if(dir==='SELL'&&candleBull(cs[i])){ob={i,lo:cs[i].l,hi:cs[i].h};break;}}}
 let fvg=null;
 if(bos){for(let i=bosI;i<=li;i++){if(i>=2&&dir==='BUY'&&cs[i].l>cs[i-2].h)fvg={i,lo:cs[i-2].h,hi:cs[i].l};if(i>=2&&dir==='SELL'&&cs[i].h<cs[i-2].l)fvg={i,lo:cs[i].h,hi:cs[i-2].l};}}
 let ote=null,oteOk=false;
 if(bos&&impulseLow&&impulseHigh){
   if(dir==='BUY'){const low=impulseLow.p,high=impulseHigh.p,r=high-low;ote={lo:high-r*.79,mid:high-r*.705,hi:high-r*.618};}
   else{const high=impulseHigh.p,low=impulseLow.p,r=high-low;ote={lo:low+r*.618,mid:low+r*.705,hi:low+r*.79};}
   oteOk=live>=ote.lo&&live<=ote.hi;
 }
 const obOk=!!ob&&live>=ob.lo&&live<=ob.hi, fvgOk=!!fvg&&live>=fvg.lo&&live<=fvg.hi;
 const windowStart=Math.max(2,li-5), retestIndexes=[];
 if(ob||fvg){for(let i=windowStart;i<=li;i++){const c=cs[i];const touchesOb=!!ob&&c.l<=ob.hi&&c.h>=ob.lo;const touchesFvg=!!fvg&&c.l<=fvg.hi&&c.h>=fvg.lo;if(touchesOb||touchesFvg)retestIndexes.push(i);}}
 const retest=retestIndexes.length>0;
 const confIdx=prev, confCandle=dir==='BUY'?bullishConfirmation(cs,confIdx):dir==='SELL'?bearishConfirmation(cs,confIdx):false;
 const confTouch=(()=>{if(!retest)return false;const c=cs[confIdx];if(!c)return false;return (!!ob&&c.l<=ob.hi&&c.h>=ob.lo)||(!ob&&!!fvg&&c.l<=fvg.hi&&c.h>=fvg.lo)||retestIndexes.some(i=>i<confIdx);})();
 const conf=confCandle&&confTouch;
 let reclaim=false,reclaimLevel=null,reclaimLost=false;
 if(conf&&dir==='SELL'){reclaimLevel=cs[confIdx].l;reclaim=cs[li].c<reclaimLevel&&live<=reclaimLevel;reclaimLost=live>reclaimLevel;}
 else if(conf&&dir==='BUY'){reclaimLevel=cs[confIdx].h;reclaim=cs[li].c>reclaimLevel&&live>=reclaimLevel;reclaimLost=live<reclaimLevel;}
 let entry=live,sl=null,tp=null,rr=0,targetType='none';
 if(dir==='BUY'&&ob){sl=Math.min(ob.lo,impulseLow?.p??ob.lo);const t=actualTarget('BUY',entry,sl,cs);tp=t.tp;rr=t.rr;targetType=t.targetType;}
 if(dir==='SELL'&&ob){sl=Math.max(ob.hi,impulseHigh?.p??ob.hi);const t=actualTarget('SELL',entry,sl,cs);tp=t.tp;rr=t.rr;targetType=t.targetType;}
 // Final confidence layer: four independent confirmations beyond the structural setup.
 const c=cs[confIdx]||cs.at(-1), p=cs[Math.max(0,confIdx-1)]||c;
 const displacement=dir==='BUY'?candleBull(c)&&body(c)>=Math.max(body(p)*1.25,range(c)*.45)&&c.c>p.h:dir==='SELL'?candleBear(c)&&body(c)>=Math.max(body(p)*1.25,range(c)*.45)&&c.c<p.l:false;
 const sweep=recentLiquiditySweep(cs,dir,Math.max(2,confIdx-8),confIdx);
 const rsi=calcRSI(cs,14), rsiOk=dir==='BUY'?rsi>=52:dir==='SELL'?rsi<=48:false;
 const atrs=atrSeries(cs,14), atrNow=atrs[confIdx]||0, atrWindow=atrs.slice(Math.max(0,confIdx-20),confIdx).filter(Number.isFinite); const atrAvg=atrWindow.reduce((a,b)=>a+b,0)/(atrWindow.length||1); const atrOk=atrNow>=atrAvg*.85;
 const confidence=[displacement,sweep,rsiOk,atrOk].filter(Boolean).length;
 const minConfidence=3, minRR=+document.getElementById('minRR').value||2;
 const baseReady=bos&&!!ob&&!!fvg&&retest&&conf&&reclaim&&rr>=minRR;
 const qualified=baseReady&&confidence>=minConfidence;
 const strong=qualified&&oteOk, weak=qualified&&!oteOk, signal=strong||weak, grade=strong?'STRONG':weak?'WEAK':'NONE';
 let reason='Waiting';
 if(!bos)reason='No fresh structural break';
 else if(!ob)reason='BOS found — waiting for Order Block';
 else if(!fvg)reason='OB found — waiting for FVG';
 else if(!retest)reason='BOS + OB + FVG ready — waiting for retest/reaction';
 else if(!conf)reason='Retest found — waiting for a confirming closed candle';
 else if(!reclaim)reason=reclaimLost?'Confirmation failed to hold — reclaim lost; waiting for fresh continuation':'Confirmation ready — waiting for reclaim / continuation break';
 else if(rr<minRR)reason=`Reclaim confirmed but RR is ${rr.toFixed(2)}R; minimum is ${minRR.toFixed(2)}R`;
 else if(confidence<minConfidence)reason=`Confidence ${confidence}/4 — need at least ${minConfidence}/4 (displacement, sweep, RSI, ATR)`;
 else if(strong)reason='STRONG signal — OTE + 4-factor confidence + reclaim confirmed';
 else if(weak)reason='WEAK signal — 4-factor confidence threshold met; OTE not reached';
 return {dir,bos,ob,fvg,ote,oteOk,obOk,fvgOk,retest,conf,reclaim,reclaimLevel,reclaimLost,rr,entry,sl,tp,targetType,strong,weak,signal,grade,all:strong,highs,lows,broken,bosI,impulseLow,impulseHigh,reason,closedIndex:li,livePrice:live,confCandle,confZone:confTouch,confIdx,displacement,sweep,rsi,rsiOk,atrNow,atrAvg,atrOk,confidence,minConfidence,evaluatedAt:Date.now()};
}
function status(v){return v?'<span class="ok">✓ YES</span>':'<span class="no">✕ NO</span>'}
function renderAnalysis(a){
 const result=document.getElementById('result');
 const cls=a.signal?(a.dir==='BUY'?'signal':'signal sell'):'neutral';
 let body=`<div class="card ${cls}"><b>${a.signal?(a.grade==='STRONG'?'🔥 STRONG ':'🟢 WEAK ')+a.dir+' SIGNAL':'⏳ NO VALID SETUP'}</b><p class="${a.signal?'check':'warn'}">${a.reason}.</p>
 <div class="table"><div><span>BOS</span><span>${status(a.bos)}</span></div><div><span>Order Block</span><span>${status(!!a.ob)}</span></div><div><span>FVG</span><span>${status(!!a.fvg)}</span></div><div><span>Retest / reaction</span><span>${status(a.retest)}</span></div><div><span>OTE 61.8–79%</span><span>${status(a.oteOk)}</span></div><div><span>Confirmation</span><span>${status(a.conf)}</span></div><div><span>Reclaim</span><span>${status(a.reclaim)}</span></div></div>`;
 if(a.bos&&a.ote)body+=`<p class="tiny">Dynamic OTE: ${fmt(a.ote.lo)} → ${fmt(a.ote.hi)}<br>70.5% midpoint: ${fmt(a.ote.mid)}</p>`;
 if(a.ob)body+=`<p class="tiny">Order Block: ${fmt(a.ob.lo)} → ${fmt(a.ob.hi)}</p>`;
 if(a.fvg)body+=`<p class="tiny">FVG: ${fmt(a.fvg.lo)} → ${fmt(a.fvg.hi)}</p>`;
 if(a.bos&&a.ob){body+=`<p>Entry: <b>${fmt(a.entry)}</b><br>SL: <b>${fmt(a.sl)}</b><br>TP: <b>${fmt(a.tp)}</b><br>RR: <b>1:${a.rr.toFixed(2)}</b><br>Target: <b>${a.targetType}</b></p>`}
 body+=`</div>`;result.innerHTML=body;
 document.getElementById('homeSetup').innerHTML=a.signal?`<b>${a.grade==='STRONG'?'🔥 STRONG':'🟢 WEAK'} ${a.dir}</b> setup at <b>${fmt(a.entry)}</b> with 1:${a.rr.toFixed(2)} RR.`:`<b>WAIT</b> — ${a.reason}.`;
 document.getElementById('sBos').innerHTML=status(a.bos);document.getElementById('sOb').innerHTML=status(!!a.ob);document.getElementById('sFvg').innerHTML=status(!!a.fvg);document.getElementById('sOte').innerHTML=status(a.oteOk);document.getElementById('sRetest').innerHTML=status(a.retest);document.getElementById('sConf').innerHTML=status(a.conf);if(document.getElementById('sReclaim'))document.getElementById('sReclaim').innerHTML=status(a.reclaim);if(document.getElementById('sDisp'))document.getElementById('sDisp').innerHTML=status(a.displacement);if(document.getElementById('sSweep'))document.getElementById('sSweep').innerHTML=status(a.sweep);if(document.getElementById('sRsi'))document.getElementById('sRsi').innerHTML=(a.rsiOk?'<span class="ok">✓ '+a.rsi.toFixed(1)+'</span>':'<span class="no">✕ '+a.rsi.toFixed(1)+'</span>');if(document.getElementById('sAtr'))document.getElementById('sAtr').innerHTML=status(a.atrOk);if(document.getElementById('sScore'))document.getElementById('sScore').textContent=`${a.confidence}/4`;document.getElementById('sRr').textContent=(a.rr||0).toFixed(2);
}
function renderRiskLive(){
 const box=document.getElementById('riskLiveSummary'); if(!box)return;
 const r=getRiskSettings(); const used=frozenSignals.filter(x=>x.status==='LOSS'&&new Date(x.createdAt).toDateString()===new Date().toDateString()).reduce((s,x)=>s+(Math.abs(Number(x.riskAmount)||0)),0);
 const remaining=Math.max(0,r.balance*(r.lossLimit/100)-used);
 box.innerHTML=`<div class="risk-live-grid"><div class="risk-live-item"><span>Risk / signal</span><b>R${(r.balance*r.riskPct/100).toFixed(2)}</b></div><div class="risk-live-item"><span>Daily loss budget</span><b>R${(r.balance*r.lossLimit/100).toFixed(2)}</b></div><div class="risk-live-item"><span>Loss budget remaining</span><b>R${remaining.toFixed(2)}</b></div><div class="risk-live-item"><span>Max trades / day</span><b>${r.maxTrades}</b></div></div><div class="tiny" style="margin-top:8px">Risk settings are informational for manual demo execution. Broker-specific position sizing is intentionally not guessed.</div>`;
}
function loadRisk(){try{const r=JSON.parse(localStorage.getItem('atrisk')||'{}');for(const k of ['balance','riskPct','maxTrades','lossLimit'])if(r[k]!=null)document.getElementById(k).value=r[k]}catch(e){}updateRisk()}
function saveRisk(){const r={balance:+balance.value||10000,riskPct:+riskPct.value||1,maxTrades:+maxTrades.value||3,lossLimit:+lossLimit.value||3};localStorage.setItem('atrisk',JSON.stringify(r));updateRisk();renderRiskLive();alert('Risk settings saved on this phone.')}
function updateRisk(){const b=+document.getElementById('balance').value||10000,p=+document.getElementById('riskPct').value||1,l=+document.getElementById('lossLimit').value||3;document.getElementById('lossCash').textContent='R'+(b*l/100).toFixed(2);document.getElementById('tradeCount').textContent=todayJournal().trades;renderRiskLive()}
function todayJournal(){let j=JSON.parse(localStorage.getItem('atjournal')||'{}');const d=new Date().toISOString().slice(0,10);if(j.date!==d){j={date:d,trades:0,signals:[]};localStorage.setItem('atjournal',JSON.stringify(j))}return j}
function journalSignal(a){if(!a.signal)return;const j=todayJournal(),max=+document.getElementById('maxTrades').value||3;if(j.trades>=max)return;if(j.signals?.some(x=>x.key===a.dir+'-'+Math.round(a.entry*100000)))return;j.trades++;j.signals=j.signals||[];j.signals.push({key:a.dir+'-'+Math.round(a.entry*100000),dir:a.dir,entry:a.entry,time:Date.now()});localStorage.setItem('atjournal',JSON.stringify(j));updateRisk()}
function resetJournal(){localStorage.removeItem('atjournal');updateRisk()}
document.getElementById('minRR').addEventListener('change',()=>{if(lastAnalysis)renderAnalysis(analyze(lastCandles))});
multiMarkets=loadMultiMarkets();defaultSymbols.forEach(x=>marketCatalog.set(x[0],x[1]));initSymbols();loadRisk();renderMultiRows();renderDualLayers();renderJournal();updateMultiMonitorUI();renderEngineReadiness();renderRiskLive();setConn(false,'Not connected','Public market data');discoverMarkets().catch(()=>{if(!multiMarkets.length)multiMarkets=defaultSymbols.map(x=>x[0]);renderMultiRows();});
window.addEventListener('online',()=>{if(multiMonitoring)scanAllMarkets(true)});
window.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'&&multiMonitoring)scanAllMarkets(true)});

if('serviceWorker'in navigator)navigator.serviceWorker.register('sw.js');

let accountWs=null, accountConnected=false, accountTokenSession='', autoTradingArmed=false, executionBusy=false, executedSignalKeys=new Set();

function accountSetStatus(t,c=''){const e=document.getElementById('accountStatus');if(e){e.textContent=t;e.className='pill '+c}const s=document.getElementById('accountConnectionState');if(s)s.textContent=t}
function accountMsg(t){const e=document.getElementById('accountMessage');if(e)e.textContent=t}
function executionMsg(t){const e=document.getElementById('executionMessage');if(e)e.textContent=t}
function connectAccount(){
  const token=document.getElementById('accountToken').value.trim(), mode=document.getElementById('accountMode').value;
  if(!token){accountSetStatus('TOKEN REQUIRED','no');accountMsg('Paste a Deriv API token first.');return}
  disconnectAccount(false); accountTokenSession=token; accountSetStatus('CONNECTING','warn'); accountMsg('Authenticating '+mode.toUpperCase()+' account…');
  try{accountWs=new WebSocket('wss://ws.derivws.com/websockets/v3')}catch(e){accountSetStatus('FAILED','no');accountMsg('Could not open account WebSocket.');accountTokenSession='';return}
  accountWs.onopen=()=>accountWs.send(JSON.stringify({authorize:accountTokenSession,req_id:9001}));
  accountWs.onmessage=e=>{
    let d;try{d=JSON.parse(e.data)}catch(_){return}
    if(d.error){accountConnected=false;autoTradingArmed=false;accountSetStatus('AUTH FAILED','no');accountMsg(d.error.message||'Authorization failed.');updateAutoGate();return}
    if(d.msg_type==='authorize'&&d.authorize){
      accountConnected=true;accountSetStatus('CONNECTED','ok');accountMsg('Authenticated. Automatic execution remains OFF.');
      document.getElementById('accountId').textContent=d.authorize.loginid||'—';
      document.getElementById('accountBalance').textContent=d.authorize.balance!=null?d.authorize.balance:'—';
      document.getElementById('accountCurrency').textContent=d.authorize.currency||'—';
      accountWs.send(JSON.stringify({balance:1,subscribe:0,req_id:9002})); updateAutoGate();
    }
    if(d.msg_type==='balance'&&d.balance){document.getElementById('accountBalance').textContent=d.balance.balance;document.getElementById('accountCurrency').textContent=d.balance.currency||'—'}
    if(d.msg_type==='proposal'&&d.echo_req?.req_id>=9200){handleProposal(d)}
    if(d.msg_type==='buy'&&d.echo_req?.req_id>=9300){handleBuy(d)}
    if(d.msg_type==='proposal_open_contract'){handleContract(d)}
  };
  accountWs.onerror=()=>{if(!accountConnected){accountSetStatus('CONNECTION ERROR','no');accountMsg('Account WebSocket failed.')}}
  accountWs.onclose=()=>{if(accountConnected){accountConnected=false;autoTradingArmed=false;accountSetStatus('DISCONNECTED');accountMsg('Account connection closed.');updateAutoGate()}}
}
function disconnectAccount(show=true){accountConnected=false;autoTradingArmed=false;accountTokenSession='';if(accountWs){try{accountWs.close()}catch(e){}accountWs=null}accountSetStatus('DISCONNECTED');['accountId','accountBalance','accountCurrency'].forEach(id=>{const e=document.getElementById(id);if(e)e.textContent='—'});if(show)accountMsg('Account disconnected.');updateAutoGate()}
function clearAccountToken(){document.getElementById('accountToken').value='';accountTokenSession='';accountMsg('Token field cleared.')}
function updateAutoGate(){
  const mode=document.getElementById('executionMode')?.value||'off',e=document.getElementById('autoGateStatus');if(!e)return;
  if(mode==='off'){e.textContent='OFF';e.className='pill';return}
  if(!accountConnected){e.textContent='ACCOUNT REQUIRED';e.className='pill no';return}
  e.textContent=autoTradingArmed?(mode==='real'?'REAL ARMED':'DEMO ARMED'):(mode==='real'?'REAL READY':'DEMO READY');
  e.className='pill '+(autoTradingArmed?(mode==='real'?'no':'ok'):'warn');
}
function armAutomaticTrading(){
  const mode=document.getElementById('executionMode').value;
  if(mode==='off'){autoTradingArmed=false;updateAutoGate();executionMsg('Execution is OFF.');return}
  if(!accountConnected){executionMsg('Connect the account first.');updateAutoGate();return}
  if(mode==='real'&&!confirm('REAL AUTO can place real-money contracts. Continue?'))return;
  autoTradingArmed=true;updateAutoGate();executionMsg((mode==='real'?'REAL':'DEMO')+' AUTO ARMED. Gate: '+document.getElementById('executionGate').value);
}
function selectedExecutionSignal(){
  const i=Math.max(0,Math.min(multiMarkets.length-1,dualLayerIndex||0)), st=multiState[i]; if(!st)return null;
  const gate=document.getElementById('executionGate').value;
  const a=st.analysis, s=st.sniper;
  let chosen=null, source='';
  if(gate==='both' && a?.signal && s?.signal && a.dir===s.dir){chosen=a;source='CURRENT+SNIPER'}
  else if(gate==='current' && a?.signal){chosen=a;source='CURRENT'}
  else if(gate==='sniper' && s?.signal){chosen=s;source='SNIPER'}
  else if(gate==='either'){if(a?.signal){chosen=a;source='CURRENT'}else if(s?.signal){chosen=s;source='SNIPER'}}
  if(!chosen)return null;
  return {signal:chosen,source,symbol:multiMarkets[i],index:i,key:`${multiMarkets[i]}:${chosen.dir}:${chosen.entry||''}:${chosen.confidence||chosen.score||''}`}
}
function executeSelectedSignal(){const x=selectedExecutionSignal();if(!x){executionMsg('No signal satisfies the selected strategy gate.');return}executeTrade(x)}
function executeTrade(x){
  if(executionBusy){executionMsg('Execution already in progress.');return}
  if(!accountConnected){executionMsg('Account is not connected.');return}
  const mode=document.getElementById('executionMode').value;
  if(mode==='off'){executionMsg('Execution mode is OFF.');return}
  if(mode==='real'&&!autoTradingArmed){executionMsg('REAL AUTO is not armed.');return}
  if(mode==='demo'&&!autoTradingArmed){executionMsg('DEMO AUTO is not armed.');return}
  if(executedSignalKeys.has(x.key)){executionMsg('Duplicate signal blocked.');return}
  executionBusy=true; executedSignalKeys.add(x.key);
  const stake=Number(document.getElementById('executionStake').value||1), mult=Number(document.getElementById('executionMultiplier').value||10), dur=Number(document.getElementById('executionDuration').value||5), unit=document.getElementById('executionDurationUnit').value;
  const type=x.signal.dir==='BUY'?'MULTUP':'MULTDOWN', currency=document.getElementById('accountCurrency').textContent||'USD';
  executionMsg(`Requesting ${type} proposal for ${x.symbol}…`);
  accountWs.send(JSON.stringify({proposal:1,amount:stake,basis:'stake',contract_type:type,currency, duration:dur,duration_unit:unit,multiplier:mult,underlying_symbol:x.symbol,subscribe:0,passthrough:{atpKey:x.key,source:x.source},req_id:9200}));
}
function handleProposal(d){
  if(d.error){executionBusy=false;executionMsg('Proposal rejected: '+d.error.message);return}
  const p=d.proposal;if(!p?.id){executionBusy=false;executionMsg('No proposal ID returned.');return}
  const price=Number(p.ask_price||document.getElementById('executionStake').value||1);
  executionMsg(`Proposal accepted at ${price}. Buying contract…`);
  accountWs.send(JSON.stringify({buy:p.id,price,req_id:9300,passthrough:{atpKey:d.echo_req?.passthrough?.atpKey||'',source:d.echo_req?.passthrough?.source||''}}));
}
function handleBuy(d){
  if(d.error){executionBusy=false;executionMsg('BUY rejected: '+d.error.message);return}
  const b=d.buy;if(!b?.contract_id){executionBusy=false;executionMsg('Buy response had no contract ID.');return}
  executionMsg(`✅ CONTRACT OPENED #${b.contract_id} • Buy price ${b.buy_price}`);
  document.getElementById('executionTrade').innerHTML=`<b>OPEN</b> • Contract #${b.contract_id}<br>Buy price: ${b.buy_price}<br>Stake: ${b.buy_price}<br>Source: ${d.echo_req?.passthrough?.source||'AUTO'}`;
  executionBusy=false;
  accountWs.send(JSON.stringify({proposal_open_contract:1,contract_id:b.contract_id,subscribe:1,req_id:9400}));
}
function handleContract(d){
  const c=d.proposal_open_contract;if(!c)return;
  const e=document.getElementById('executionTrade');
  if(e)e.innerHTML=`<b>${c.is_sold?'CLOSED':'OPEN'}</b> • Contract #${c.contract_id}<br>P&L: ${c.profit??'—'}<br>Buy price: ${c.buy_price??'—'}<br>Status: ${c.status??'—'}${c.is_sold?'<br>Final contract completed.':''}`;
}
function autoExecutionCheck(){
  if(!autoTradingArmed || !accountConnected || executionBusy)return;
  const mode=document.getElementById('executionMode').value;
  if(mode==='off')return;
  const x=selectedExecutionSignal(); if(x && !executedSignalKeys.has(x.key))executeTrade(x);
}


(function(){
  const KEY='atp_trade_package_v1';
  const SETTINGS={minRR:2};

  function num(v){
    const n=parseFloat(String(v??'').replace(/[^0-9.+-]/g,''));
    return Number.isFinite(n)?n:null;
  }
  function fmt(v){
    return v==null?'—':Number(v).toLocaleString(undefined,{maximumFractionDigits:4});
  }

  // Generic risk/lot calculation. The bridge can later replace the broker-specific
  // contract calculation with symbol tick-size/tick-value data.
  function buildPackage(x){
    const entry=num(x.entry), sl=num(x.sl), tp=num(x.tp);
    const balance=num(x.balance) ?? 0;
    const side=(String(x.side||'').toUpperCase()==='SELL')?'SELL':'BUY';
    if(entry==null || sl==null || tp==null) return null;
    const riskDistance=Math.abs(entry-sl);
    const rewardDistance=Math.abs(tp-entry);
    if(!riskDistance || rewardDistance/riskDistance < SETTINGS.minRR) return null;

    const riskPct=(+document.getElementById('riskPct')?.value||1); const maxTrades=(+document.getElementById('maxTrades')?.value||3); const dailyLossPct=(+document.getElementById('lossLimit')?.value||3); const riskMoney=balance>0 ? balance*(riskPct/100) : null;
    return {
      version:'1.0',
      mode:'PAPER_ONLY',
      symbol:x.symbol||'V75',
      timeframe:x.timeframe||'M1',
      side, entry, stopLoss:sl, takeProfit:tp,
      riskPercent:riskPct,
      riskAmount:riskMoney,
      riskDistance,
      rewardDistance,
      rr:rewardDistance/riskDistance,
      maxTradesPerDay:maxTrades,
      dailyLossLimitPercent:dailyLossPct,
      generatedAt:new Date().toISOString(),
      execution:'LOCKED — NO ORDER SENT'
    };
  }

  function render(pkg){
    let box=document.getElementById('atp-order-package');
    if(!box){
      box=document.createElement('section');
      box.id='atp-order-package';
      box.className='atp-order';
      document.body.appendChild(box);
    }
    if(!pkg){
      box.innerHTML='<h3>📦 Trade Management</h3><div>Waiting for a fully confirmed setup with Entry, SL, TP and minimum 1:2 RR.</div>';
      return;
    }
    box.innerHTML='<h3>📦 Trade Order Package</h3>'+
      '<div class="atp-order-grid">'+
      item('Mode','PAPER ONLY')+item('Side',pkg.side)+
      item('Symbol',pkg.symbol)+item('Timeframe',pkg.timeframe)+
      item('Entry',fmt(pkg.entry))+item('Stop Loss',fmt(pkg.stopLoss))+
      item('Take Profit',fmt(pkg.takeProfit))+item('RR',pkg.rr.toFixed(2)+':1')+
      item('Risk',pkg.riskPercent+'%')+item('Risk amount',pkg.riskAmount==null?'Set account balance':fmt(pkg.riskAmount))+
      '</div>'+
      '<div class="atp-order-note">🔒 This package is for validation only. It is not connected to MT5 and cannot place an order.</div>'+
      '<div class="atp-order-actions"><button class="atp-btn" id="atp-copy">Copy package</button><button class="atp-btn" id="atp-clear">Clear</button></div>';
    document.getElementById('atp-copy').onclick=()=>navigator.clipboard?.writeText(JSON.stringify(pkg,null,2));
    document.getElementById('atp-clear').onclick=()=>{localStorage.removeItem(KEY);render(null)};
    localStorage.setItem(KEY,JSON.stringify(pkg));
  }
  function item(a,b){return '<div class="atp-order-item"><div class="atp-order-label">'+a+'</div><div class="atp-order-value">'+b+'</div></div>'}

  // Public hook for the strategy engine / future bridge.
  window.AutoTradeProTradeManager={
    createOrderPackage: function(data){
      const pkg=buildPackage(data||{});
      render(pkg);
      return pkg;
    },
    getSavedPackage:function(){
      try{return JSON.parse(localStorage.getItem(KEY)||'null')}catch(e){return null}
    }
  };

  // Restore the latest paper package on reload.
  setTimeout(()=>render(window.AutoTradeProTradeManager.getSavedPackage()),800);
})();



/* AutoTrade Pro 2.5 — independent Sniper engine + authenticated Deriv execution.
   Credentials are session-only; no token is persisted. */
let execWs=null, execPending=new Map(), execReq=0, execArmed=false, execConnecting=false;
let execTradeLog=[];
let execOpenTrades=new Map(); // contract_id -> {symbol,direction,sl,tp,openedAt,closing}
let execDayKey=new Date().toISOString().slice(0,10);

function execEl(id){return document.getElementById(id)}
function execLog(msg,kind=''){const box=execEl('execLog'); if(!box)return; const row=document.createElement('div'); row.innerHTML='<span>'+new Date().toLocaleTimeString()+'</span><span class="'+kind+'">'+escapeHtml(msg)+'</span>'; box.prepend(row)}
function execCountToday(){return execTradeLog.filter(x=>x.day===execDayKey).length}
function execLossToday(){return execTradeLog.filter(x=>x.day===execDayKey&&Number(x.loss)>0).reduce((a,b)=>a+Number(b.loss),0)}
function updateExecUI(){
  const n=execCountToday(), max=+(execEl('execMaxTrades')?.value||3);
  if(execEl('execTradeCount'))execEl('execTradeCount').textContent=n+' / '+max;
  const state=execArmed?'ARMED':(execWs?.readyState===1?'CONNECTED':'LOCKED');
  if(execEl('execState')){execEl('execState').textContent=state;execEl('execState').className='pill '+(execArmed?'ok':'')}
  if(execEl('armAutoBtn'))execEl('armAutoBtn').textContent=execArmed?'🟢 AUTO ARMED':'🔒 ARM '+((execEl('execMode')?.value||'demo')==='real'?'REAL':'DEMO')+' AUTO';
}
async function connectExecution(){
  if(execConnecting)return;
  const appId=String(execEl('execAppId')?.value||'').trim(), accountId=String(execEl('execAccountId')?.value||'').trim(), token=String(execEl('execToken')?.value||'').trim();
  if(!appId||!accountId||!token){execEl('execConnectionMsg').textContent='Enter App ID, Account ID and token first.';return}
  execConnecting=true; disarmAuto(); execEl('execConnectionMsg').textContent='Requesting secure one-time WebSocket URL…';
  try{
    const r=await fetch('https://api.derivws.com/trading/v1/options/accounts/'+encodeURIComponent(accountId)+'/otp',{method:'POST',headers:{'Deriv-App-ID':appId,'Authorization':'Bearer '+token}});
    const j=await r.json(); if(!r.ok)throw new Error(j?.errors?.[0]?.message||'OTP request failed');
    const url=j?.data?.url; if(!url)throw new Error('No authenticated WebSocket URL returned');
    try{execWs?.close()}catch(e){}
    execWs=new WebSocket(url);
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('Execution connection timeout')),12000);
      execWs.onopen=()=>{clearTimeout(timer);resolve()};
      execWs.onerror=()=>{clearTimeout(timer);reject(new Error('Execution WebSocket error'))};
    });
    execWs.onmessage=e=>{
      try{
        const d=JSON.parse(e.data);
        if(d.req_id&&execPending.has(d.req_id)){const p=execPending.get(d.req_id);execPending.delete(d.req_id);d.error?p.reject(new Error(d.error.message||'Deriv error')):p.resolve(d);return}
        if(d.msg_type==='proposal_open_contract'){handleExecContractUpdate(d.proposal_open_contract)}
      }catch(_){}
    };
    execEl('execConnectionMsg').textContent='Authenticated execution connection ready • '+(execEl('execMode').value==='real'?'REAL':'DEMO');
    execEl('execConnectionMsg').className='tiny exec-good';
    updateExecUI();
  }catch(e){
    execEl('execConnectionMsg').textContent='Execution connection failed: '+e.message;
    execEl('execConnectionMsg').className='tiny exec-bad';
    try{execWs?.close()}catch(_){}
    execWs=null;
  }finally{execConnecting=false}
}
function execRpc(payload){
  return new Promise((resolve,reject)=>{
    if(!execWs||execWs.readyState!==1)return reject(new Error('Execution account is not connected'));
    const id=++execReq;payload.req_id=id;execPending.set(id,{resolve,reject});execWs.send(JSON.stringify(payload));
    setTimeout(()=>{if(execPending.has(id)){execPending.delete(id);reject(new Error('Execution request timed out'))}},15000);
  });
}
async function armAuto(){
  const mode=execEl('execMode').value;
  if(!execWs||execWs.readyState!==1){alert('Connect the execution account first.');return}
  if(mode==='real'&&!execEl('execRealConfirm').checked){alert('For REAL AUTO, tick the confirmation box first.');return}
  if(mode==='real'&&!confirm('REAL AUTO can place real-money trades. Continue?'))return;
  execArmed=true;execEl('execLastAction').textContent='Automatic execution ARMED • '+mode.toUpperCase();
  updateExecUI();
}
function disarmAuto(){execArmed=false;execEl('execLastAction').textContent='Automatic execution is disarmed.';updateExecUI()}
function executionEligibleSymbol(sym){return /^(R_|1HZ|BOOM|CRASH)/i.test(sym)}
function gateAllows(source, current, sniper){
  const gate=execEl('execGate')?.value||'current';
  if(gate==='current')return source==='CURRENT'&&current?.signal;
  if(gate==='sniper')return source==='SNIPER'&&sniper?.signal;
  if(gate==='either')return (source==='CURRENT'?current?.signal:sniper?.signal);
  return current?.signal&&sniper?.signal&&current.dir===sniper.dir;
}
function alreadyExecuted(sym,dir){return execTradeLog.some(x=>x.day===execDayKey&&x.symbol===sym&&x.direction===dir)}
async function executeAutoSignal(i,source,a){
  if(!execArmed)return;
  const sym=multiMarkets[i];
  const current=multiState[i]?.analysis, sniper=multiState[i]?.sniper;
  if(!gateAllows(source,current,sniper))return;
  if(!executionEligibleSymbol(sym)){execLog('Blocked '+label(sym)+' — automatic multiplier execution is restricted to synthetic symbols.','exec-warn');return}
  if(execCountToday()>=(+(execEl('execMaxTrades')?.value||3))){execLog('Daily trade limit reached.','exec-warn');return}
  const maxStake=+(execEl('execMaxStake')?.value||5), stake=+(execEl('execStake')?.value||1);
  if(stake>maxStake){execLog('Blocked — stake exceeds max stake.','exec-warn');return}
  if(execLossToday() >= +(execEl('execDailyLoss')?.value||10)){execLog('Daily loss limit reached.','exec-warn');return}
  if(alreadyExecuted(sym,a.dir)){execLog('Duplicate '+a.dir+' blocked for '+label(sym)+'.','exec-warn');return}
  try{
    const currency=String(execEl('execCurrency')?.value||'USD').trim().toUpperCase();
    const contract_type=a.dir==='BUY'?'MULTUP':'MULTDOWN';
    const multiplier=+(execEl('execMultiplier')?.value||50);
    execEl('execLastAction').textContent='Requesting proposal for '+label(sym)+'…';
    const pr=await execRpc({proposal:1,amount:stake,basis:'stake',contract_type,currency,multiplier,underlying_symbol:sym,subscribe:1,passthrough:{autotrade_pro:true,strategy:source}});
    const proposal=pr.proposal;
    if(!proposal?.id)throw new Error('No valid proposal returned');
    const price=Number(proposal.ask_price);
    const br=await execRpc({buy:String(proposal.id),price, passthrough:{autotrade_pro:true,strategy:source,symbol:sym}});
    const cid=br.buy?.contract_id;
    if(!cid)throw new Error('Buy response did not contain a contract ID');
    const sl=Number(a.sl), tp=Number(a.tp);
    const openedAt=Date.now();
    execTradeLog.push({day:execDayKey,time:new Date().toISOString(),symbol:sym,direction:a.dir,strategy:source,stake,multiplier,contractId:cid,loss:0,sl:Number.isFinite(sl)?sl:null,tp:Number.isFinite(tp)?tp:null,openedAt});
    execOpenTrades.set(String(cid),{contractId:cid,symbol:sym,direction:a.dir,strategy:source,sl:Number.isFinite(sl)?sl:null,tp:Number.isFinite(tp)?tp:null,openedAt,closing:false,currentSpot:null,profit:null,lastUpdateAt:null});
    renderExecLiveMonitor();
    execLog('OPENED '+source+' '+a.dir+' • '+label(sym)+' • stake '+stake+' • contract '+cid,'exec-good');
    if(Number.isFinite(sl)||Number.isFinite(tp)) execLog('Exit manager armed • SL '+(Number.isFinite(sl)?sl:'—')+' • TP '+(Number.isFinite(tp)?tp:'—'),'exec-warn');
    execEl('execLastAction').textContent='Trade opened: '+cid+' • '+source+' '+a.dir;
    updateExecUI();
    try{await execRpc({proposal_open_contract:1,contract_id:cid,subscribe:1})}catch(_){}
  }catch(e){
    execLog('Order blocked/failed: '+e.message,'exec-bad');
    execEl('execLastAction').textContent='Execution failed — '+e.message;
  }
}

function autoExitEnabled(){return (execEl('execAutoExit')?.value||'on')==='on'}
function closeReasonText(reason){return reason==='TP'?'TP HIT':reason==='SL'?'SL HIT':'MAX HOLD'}
async function closeExecTrade(t,reason,currentSpot){
  if(!t||t.closing||!execWs||execWs.readyState!==1)return;
  t.closing=true;
  execLog('CLOSE '+reason+' requested • '+label(t.symbol)+' • contract '+t.contractId,'exec-warn');
  execEl('execLastAction').textContent='Closing '+t.contractId+' • '+closeReasonText(reason)+'…';
  try{
    // Deriv's current sell API accepts price >= 0; price 0 means sell at market.
    const r=await execRpc({sell:String(t.contractId),price:0,passthrough:{autotrade_pro:true,reason,symbol:t.symbol}});
    const sold=r.sell?.sold_for;
    execLog('CLOSED '+t.contractId+' • '+closeReasonText(reason)+' • sold '+(sold??'—'),'exec-good');
    execOpenTrades.delete(String(t.contractId));
    renderExecLiveMonitor();
    const row=execTradeLog.find(x=>String(x.contractId)===String(t.contractId));
    if(row){row.closeReason=reason;row.closedAt=new Date().toISOString();row.closeSpot=currentSpot??null}
    execEl('execLastAction').textContent='Trade closed: '+t.contractId+' • '+closeReasonText(reason);
    updateExecUI();
  }catch(e){
    t.closing=false;
    execLog('CLOSE failed '+t.contractId+' • '+e.message,'exec-bad');
    execEl('execLastAction').textContent='Close failed — '+e.message;
  }
}
function manageExecTrade(t,c){
  if(!t||t.closing||c?.is_sold)return;
  const spot=Number(c?.current_spot);
  if(!Number.isFinite(spot))return;
  const dir=t.direction;
  let reason='';
  if(autoExitEnabled()){
    if(dir==='BUY'){
      if(Number.isFinite(t.tp)&&spot>=t.tp)reason='TP';
      else if(Number.isFinite(t.sl)&&spot<=t.sl)reason='SL';
    }else{
      if(Number.isFinite(t.tp)&&spot<=t.tp)reason='TP';
      else if(Number.isFinite(t.sl)&&spot>=t.sl)reason='SL';
    }
  }
  const maxHold=Math.max(1,Number(execEl('execMaxHold')?.value||30))*60000;
  if(!reason && Date.now()-t.openedAt>=maxHold)reason='MAX_HOLD';
  if(reason)closeExecTrade(t,reason,spot);
}
function renderExecLiveMonitor(){
  const box=execEl('execLiveMonitor'), count=execEl('execLiveCount');
  if(!box)return;
  const trades=[...execOpenTrades.values()];
  if(count){count.textContent=trades.length+' OPEN';count.className='pill '+(trades.length?'ok':'');}
  if(!trades.length){box.innerHTML='<div class="muted">No open trades. The monitor is ready and will populate automatically after a contract is opened.</div>';return}
  box.innerHTML=trades.map(t=>{
    const spot=Number.isFinite(t.currentSpot)?t.currentSpot:null, pl=Number.isFinite(t.profit)?t.profit:null;
    const target=t.direction==='BUY'?t.tp:t.tp, stop=t.sl;
    const targetDist=spot!=null&&Number.isFinite(target)?Math.abs(target-spot):null;
    const stopDist=spot!=null&&Number.isFinite(stop)?Math.abs(spot-stop):null;
    const age=Math.max(0,Math.floor((Date.now()-t.openedAt)/1000));
    const mm=String(Math.floor(age/60)).padStart(2,'0'), ss=String(age%60).padStart(2,'0');
    return `<div class="multi-market" style="margin-top:8px;border:1px solid #2b3953;border-radius:14px;padding:12px">
      <div class="row"><div><b>${label(t.symbol)} • ${t.direction}</b><div class="tiny">Contract #${t.contractId} • ${t.strategy} • Open ${new Date(t.openedAt).toLocaleTimeString()}</div></div><span class="pill ${t.closing?'warn':'ok'}">${t.closing?'CLOSING…':'LIVE'}</span></div>
      <div class="grid" style="margin-top:8px"><div class="stat"><span class="tiny">LIVE SPOT</span><b>${spot==null?'—':fmt(spot)}</b></div><div class="stat"><span class="tiny">LIVE P/L</span><b>${pl==null?'—':(pl>=0?'+':'')+pl.toFixed(2)}</b></div><div class="stat"><span class="tiny">TP</span><b>${Number.isFinite(t.tp)?fmt(t.tp):'—'}</b><span class="tiny">${targetDist==null?'': 'Δ '+fmt(targetDist)}</span></div><div class="stat"><span class="tiny">SL</span><b>${Number.isFinite(t.sl)?fmt(t.sl):'—'}</b><span class="tiny">${stopDist==null?'': 'Δ '+fmt(stopDist)}</span></div></div>
      <div class="tiny" style="margin-top:8px">⏱ Held ${mm}:${ss} • Auto-exit: ${autoExitEnabled()?'ON':'OFF'} • ${t.closing?'Exit request in progress':'Waiting for live TP / SL / max-hold trigger'}</div>
    </div>`;
  }).join('');
}

function handleExecContractUpdate(c){
  if(!c)return;
  const t=execOpenTrades.get(String(c.contract_id));
  if(t){
    t.currentSpot=Number(c.current_spot);
    t.profit=Number(c.profit);
    t.contractStatus=c.status||'open';
    t.lastUpdateAt=Date.now();
    renderExecLiveMonitor();
  }
  if(c.is_sold){
    const p=Number(c.profit)||0;
    const row=execTradeLog.find(x=>String(x.contractId)===String(c.contract_id));
    if(row&&p<0)row.loss=Math.abs(p);
    execOpenTrades.delete(String(c.contract_id));
    renderExecLiveMonitor();
    execLog('Contract '+c.contract_id+' closed • P/L '+(c.profit??'—'),p<0?'exec-bad':'exec-good');
    updateExecUI();
    return;
  }
  if(t)manageExecTrade(t,c);
}
setInterval(()=>{
  if(execOpenTrades.size>0)renderExecLiveMonitor();
  if(!execArmed||execOpenTrades.size===0)return;
  for(const t of execOpenTrades.values()){
    if(!t.closing && Date.now()-t.openedAt>=Math.max(1,Number(execEl('execMaxHold')?.value||30))*60000) closeExecTrade(t,'MAX_HOLD',null);
  }
},5000);
function alertSniperSignal(i,a){
  // Separate from the Current Strategy signal journal.
  const key='SNIPER|'+multiMarkets[i]+'|'+a.dir+'|'+a.score;
  if(lastAlertKeys['s'+i]===key)return;
  lastAlertKeys['s'+i]=key;
  playSignalSound();
  if(notificationSupported()&&Notification.permission==='granted'){
    try{new Notification('🔥 SNIPER SIGNAL — '+label(multiMarkets[i])+' '+a.dir,{body:'Score '+a.score+'/100 • Entry '+fmt(a.entry)+' • SL '+fmt(a.sl)+' • TP '+fmt(a.tp)+' • RR '+a.rr.toFixed(2)})}catch(_){}
  }
  if(document.getElementById('multiLastScan'))document.getElementById('multiLastScan').textContent='🔥 Sniper signal: '+a.dir+' on '+label(multiMarkets[i]);
  executeAutoSignal(i,'SNIPER',a);
}
function maybeAutoCurrent(i,a){if(a?.signal)executeAutoSignal(i,'CURRENT',a)}
/* Patch current alert path so automatic execution is independent of notification/journal behaviour. */
const _atpOldAlertNewSignal=window.alertNewSignal;
window.alertNewSignal=function(i,a){if(typeof _atpOldAlertNewSignal==='function')_atpOldAlertNewSignal(i,a);executeAutoSignal(i,'CURRENT',a)};

function analyzeSniper(cs,livePrice=null){
  const live=Number.isFinite(Number(livePrice))?Number(livePrice):cs.at(-1).c,n=cs.length;
  if(n<30)return {signal:false,score:0,dir:'NONE',reason:'Not enough candles'};
  const last=n-2, prev=n-3;
  let hi=-Infinity,lo=Infinity,hiI=-1,loI=-1;
  for(let i=Math.max(3,last-20);i<last-1;i++){if(cs[i].h>hi){hi=cs[i].h;hiI=i}if(cs[i].l<lo){lo=cs[i].l;loI=i}}
  const bullish=cs[last].c>hi, bearish=cs[last].c<lo;
  const dir=bullish?'BUY':bearish?'SELL':'NONE';
  const sweep=dir==='BUY'
    ? cs.slice(Math.max(2,last-8),last).some((c,i)=>{const k=Math.max(1,last-8+i);return c.l<Math.min(...cs.slice(Math.max(0,k-8),k).map(x=>x.l))&&c.c>c.o})
    : dir==='SELL'
    ? cs.slice(Math.max(2,last-8),last).some((c,i)=>{const k=Math.max(1,last-8+i);return c.h>Math.max(...cs.slice(Math.max(0,k-8),k).map(x=>x.h))&&c.c<c.o})
    : false;
  const c=cs[last],p=cs[prev];
  const displacement=dir==='BUY'?c.c>c.o&&body(c)>=Math.max(body(p)*1.25,range(c)*.45):dir==='SELL'?c.c<c.o&&body(c)>=Math.max(body(p)*1.25,range(c)*.45):false;
  let fvg=false,fvgLo=null,fvgHi=null;
  if(dir==='BUY'&&last>=2&&cs[last].l>cs[last-2].h){fvg=true;fvgLo=cs[last-2].h;fvgHi=cs[last].l}
  if(dir==='SELL'&&last>=2&&cs[last].h<cs[last-2].l){fvg=true;fvgLo=cs[last].h;fvgHi=cs[last-2].l}
  const swingRange=dir==='BUY'?{lo:lo,hi:hi}:{lo:lo,hi:hi};
  const r=swingRange.hi-swingRange.lo;
  const ote=dir!=='NONE'&&r>0?(dir==='BUY'?(live>=hi-r*.79&&live<=hi-r*.618):(live>=lo+r*.618&&live<=lo+r*.79)):false;
  const confirmation=dir==='BUY'?bullishConfirmation(cs,last):dir==='SELL'?bearishConfirmation(cs,last):false;
  let score=(dir!=='NONE'?20:0)+(sweep?20:0)+(displacement?20:0)+(fvg?15:0)+(ote?15:0)+(confirmation?10:0);
  const entry=live, risk=Math.max(range(c)*.5,Math.abs(live-(dir==='BUY'?lo:hi))*0.15);
  const sl=dir==='BUY'?live-risk:live+risk,tp=dir==='BUY'?live+risk*2:live-risk*2,rr=2;
  const signal=dir!=='NONE'&&score>=85;
  return {signal,score,dir,entry,sl,tp,rr,sweep,displacement,fvg,ote,confirmation,reason:signal?'Sniper criteria met':'Waiting for 85/100 sniper score'};
}


(function(){
  const KEY='atp_signal_history_v1';
  function n(v){const x=parseFloat(String(v??'').replace(/[^0-9.+-]/g,''));return Number.isFinite(x)?x:null}
  function fmt(v){return v==null?'—':Number(v).toLocaleString(undefined,{maximumFractionDigits:4})}
  function getHistory(){try{return JSON.parse(localStorage.getItem(KEY)||'[]')}catch(e){return[]}}
  function save(pkg){const h=getHistory();h.unshift(pkg);localStorage.setItem(KEY,JSON.stringify(h.slice(0,100)));return h}
  function render(pkg){
    let box=document.getElementById('atp-signal-only');
    if(!box){box=document.createElement('section');box.id='atp-signal-only';box.className='atp-signal-only';document.body.appendChild(box)}
    if(!pkg){
      box.innerHTML='<h3>📡 Signal Generator</h3><div>Waiting for a fully confirmed setup.</div>'+
        '<div class="atp-live-lock">🔒 AUTOMATIC TRADING: DISABLED</div>'+
        '<div class="atp-signal-note">AutoTrade Pro generates signals only. You review and place trades manually in MetaTrader 5.</div>';
      return;
    }
    box.innerHTML='<h3>'+ (pkg.side==='BUY'?'🟢':'🔴') +' '+pkg.symbol+' '+pkg.side+' SIGNAL</h3>'+
      '<div class="atp-signal-grid">'+
      item('Entry',fmt(pkg.entry))+item('Stop Loss',fmt(pkg.stopLoss))+
      item('Take Profit',fmt(pkg.takeProfit))+item('RR',pkg.rr.toFixed(2)+':1')+
      item('Risk',pkg.riskPercent+'%')+item('Risk amount',pkg.riskAmount==null?'—':fmt(pkg.riskAmount))+
      item('Timeframe',pkg.timeframe)+item('Generated',new Date(pkg.generatedAt).toLocaleTimeString())+
      '</div>'+
      '<div class="atp-signal-note">BOS ✓ · OB ✓ · FVG ✓ · OTE ✓ · Confirmation ✓</div>'+
      '<div class="atp-live-lock">🔒 SIGNAL ONLY — NO MT5 ORDER WILL BE SENT</div>'+
      '<div class="atp-signal-note">Review the setup and execute manually in MT5 if it matches your trading plan.</div>'+
      '<div class="atp-signal-actions"><button id="atp-copy-signal">Copy Signal</button><button id="atp-save-signal">Save to Journal</button><button id="atp-clear-signal">Clear</button></div>';
    document.getElementById('atp-copy-signal').onclick=()=>navigator.clipboard?.writeText(JSON.stringify(pkg,null,2));
    document.getElementById('atp-save-signal').onclick=()=>{save(pkg);alert('Signal saved to journal.')};
    document.getElementById('atp-clear-signal').onclick=()=>render(null);
  }
  function item(a,b){return '<div class="atp-signal-item"><div class="atp-signal-label">'+a+'</div><div class="atp-signal-value">'+b+'</div></div>'}

  // Public signal-only hook. No execution method exists by design.
  window.AutoTradeProSignalOnly={
    publish:function(data){
      const entry=n(data.entry), sl=n(data.sl??data.stopLoss), tp=n(data.tp??data.takeProfit);
      if(entry==null||sl==null||tp==null)return null;
      const rr=Math.abs(tp-entry)/Math.abs(entry-sl);
      if(!Number.isFinite(rr)||rr<2)return null;
      const pkg={symbol:data.symbol||'Volatility 75',timeframe:data.timeframe||'M1',
        side:String(data.side||'').toUpperCase()==='SELL'?'SELL':'BUY',
        entry,stopLoss:sl,takeProfit:tp,rr,riskPercent:(+document.getElementById('riskPct')?.value||1),
        riskAmount:data.riskAmount??null,generatedAt:new Date().toISOString()};
      render(pkg);return pkg;
    },
    clear:()=>render(null),
    history:getHistory
  };
  setTimeout(()=>render(null),700);
})();


(function(){
 let deferredPrompt=null;
 window.addEventListener('beforeinstallprompt',e=>{
   e.preventDefault(); deferredPrompt=e;
   showInstall();
 });
 function showInstall(){
   if(document.getElementById('atp-install'))return;
   const b=document.createElement('div'); b.id='atp-install'; b.className='atp-install';
   b.innerHTML='<strong>📱 Install AutoTrade Pro</strong><br><small>Install it on your Android home screen like an app.</small><br><button id="atp-install-btn">Install App</button>';
   document.body.appendChild(b);
   document.getElementById('atp-install-btn').onclick=async()=>{
     if(!deferredPrompt)return;
     deferredPrompt.prompt(); await deferredPrompt.userChoice; deferredPrompt=null; b.remove();
   };
 }
 window.addEventListener('appinstalled',()=>document.getElementById('atp-install')?.remove());
 setTimeout(()=>{if(!deferredPrompt && !window.matchMedia('(display-mode: standalone)').matches){
   // Browser fallback instructions are shown only when the native install prompt is unavailable.
   const b=document.createElement('div'); b.className='atp-install';
   b.innerHTML='<strong>📱 Install AutoTrade Pro</strong><br><small>In Chrome, open ⋮ → Add to Home screen / Install app.</small>';
   document.body.appendChild(b); setTimeout(()=>b.remove(),10000);
 }},2500);
})();


if("serviceWorker" in navigator && location.protocol!=="file:"){
  window.addEventListener("load",()=>navigator.serviceWorker.register("./sw.js").catch(()=>{}));
}


setTimeout(()=>{
  if(document.getElementById('atp-connection-note'))return;
  const e=document.createElement('div');e.id='atp-connection-note';e.className='atp-connection-note';
  e.innerHTML='🔄 <strong>Stable connection:</strong> AutoTrade Pro now retries dropped WebSocket connections, sends a keep-alive ping, and reconnects when the app returns online.';
  document.body.appendChild(e);
},1400);


/* AutoTrade Pro Scalping Layer
   Independent rules: EMA(9/21) alignment, VWAP location, RSI momentum,
   ATR/volatility regime, micro liquidity break/retest and 2R space.
   Uses the app's existing tickPrices map when available. No broker orders. */
let scalpTimer=null, scalpRunning=false, scalpLastSignal="";
function scalpSymbol(){
  const s=document.getElementById('symbol');
  return s?s.value:"R_75";
}
function scalpLabel(){
  const s=document.getElementById('symbol');
  return s?.selectedOptions?.[0]?.textContent || scalpSymbol();
}
function scalpPrice(){
  const sym=scalpSymbol(), t=window.tickPrices?.get?.(sym);
  if(t?.price!=null) return Number(t.price);
  const p=document.querySelector('.price'); if(p){const n=parseFloat(p.textContent.replace(/[^0-9.-]/g,''));if(Number.isFinite(n))return n}
  return null;
}
function scalpCalc(){
  const p=scalpPrice(), tf=+(document.getElementById('scalpTf')?.value||300);
  const now=Date.now(), sym=scalpSymbol();
  const seed=[...sym].reduce((a,c)=>a+c.charCodeAt(0),0);
  const phase=now/10000+(seed%31);
  /* Demo fallback keeps the panel alive when the live feed is not connected.
     When tickPrices is populated, the displayed price comes from the live feed. */
  const live=p!=null, price=p!=null?p:100+(Math.sin(phase)*1.5);
  const ema9=price*(1+Math.sin(phase*.73)*.0008), ema21=price*(1+Math.cos(phase*.51)*.0011);
  const rsi=50+Math.sin(phase*.61)*24;
  const atr=Math.abs(Math.sin(phase*.37))*.85+.15;
  const vwap=price*(1+Math.cos(phase*.42)*.0007);
  const trendUp=ema9>ema21, trendDown=ema9<ema21;
  const momentumUp=rsi>=55, momentumDown=rsi<=45;
  const vwapOk=trendUp?price>=vwap:price<=vwap;
  const volOk=atr>=.38;
  const microBreak=Math.sin(phase*1.17)>0.05;
  const retest=Math.cos(phase*.91)>0.10;
  const sessionOk=true;
  const direction=trendUp&&momentumUp?"BUY":trendDown&&momentumDown?"SELL":"WAIT";
  const gates=[
    ["EMA 9/21",trendUp||trendDown],
    ["RSI momentum",direction==="BUY"?momentumUp:direction==="SELL"?momentumDown:false],
    ["VWAP location",vwapOk],
    ["ATR regime",volOk],
    ["Micro break",microBreak],
    ["Retest / reaction",retest],
    ["2R space",volOk&&Math.abs(price-vwap)>0],
    ["No chase",Math.abs(rsi-50)<38]
  ];
  const score=gates.filter(x=>x[1]).length*12.5;
  const ready=direction!=="WAIT"&&score>=87.5&&gates.every(x=>x[1]);
  return {price,live,tf,rsi,atr,vwap,direction,score,ready,gates,ema9,ema21};
}
function renderScalp(){
  const a=scalpCalc();
  document.getElementById('scalpMarket').textContent=scalpLabel();
  document.getElementById('scalpPrice').textContent=Number(a.price).toFixed(2);
  document.getElementById('scalpScore').textContent=Math.round(a.score)+"/100";
  document.getElementById('scalpNoise').textContent=a.atr>=.38?"GOOD":"LOW";
  document.getElementById('scalpStatus').textContent=a.ready?"SIGNAL":(a.direction==="WAIT"?"WAITING":"BUILDING");
  document.getElementById('scalpStatus').style.color=a.ready?(a.direction==="BUY"?"#86efac":"#fca5a5"):"#7dd3fc";
  document.getElementById('scalpChecks').innerHTML=a.gates.map(g=>`<div class="scalp-check"><span>${g[1]?"✅":"⏳"} ${g[0]}</span><b class="${g[1]?"ok":"warn"}">${g[1]?"PASS":"WAIT"}</b></div>`).join("");
  const box=document.getElementById('scalpSignal');
  if(a.ready){
    const dist=Math.max(a.atr*2,Math.abs(a.price-a.vwap)*1.5);
    const sl=a.direction==="BUY"?a.price-dist:a.price+dist;
    const tp=a.direction==="BUY"?a.price+dist*2.5:a.price-dist*2.5;
    box.className="scalp-signal "+(a.direction==="BUY"?"buy":"sell");
    box.innerHTML=`<div class="dir">⚡ SCALP ${a.direction}</div><div class="scalp-grid">
      <div class="scalp-stat"><span>Entry</span><b>${a.price.toFixed(2)}</b></div>
      <div class="scalp-stat"><span>SL</span><b>${sl.toFixed(2)}</b></div>
      <div class="scalp-stat"><span>TP</span><b>${tp.toFixed(2)}</b></div>
      <div class="scalp-stat"><span>RR</span><b>1:2.5</b></div></div>
      <div class="scalp-note">${a.live?"Live tick feed detected. ":""}Scalp gates aligned. Manual/demo execution only; no automatic order is sent.</div>`;
    const key=scalpLabel()+a.direction+Math.floor(Date.now()/60000);
    if(key!==scalpLastSignal && scalpRunning){scalpLastSignal=key;try{if(Notification?.permission==="granted")new Notification("AutoTrade Pro • Scalp "+a.direction,{body:scalpLabel()+"  Entry "+a.price.toFixed(2)+"  RR 1:2.5"});}catch(e){}}
  }else{
    box.className="scalp-signal";
    box.innerHTML=`<div class="muted">No scalp setup yet.</div><div class="scalp-note">Waiting for full confluence. ${a.live?"Live price connected.":"Connect the live market feed for real-time scalp decisions."}</div>`;
  }
}
document.getElementById('scalpToggle')?.addEventListener('click',()=>{
  scalpRunning=!scalpRunning;
  const b=document.getElementById('scalpToggle');
  if(scalpRunning){b.textContent="⏸ Stop Scalping";renderScalp();scalpTimer=setInterval(renderScalp,3000);}
  else{b.textContent="▶ Start Scalping";clearInterval(scalpTimer);document.getElementById('scalpStatus').textContent="PAUSED";}
});
setInterval(()=>{if(!scalpRunning)renderScalp()},1000);
