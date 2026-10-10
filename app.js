// Webbläsaroberoende: Supabase-koden laddas först i produktionsläge.
// Demoläget fungerar även utan åtkomst till en extern JavaScript-CDN.
let createClient = null;

const $=s=>document.querySelector(s);
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const id=()=>crypto.randomUUID();
const dt=()=>new Date().toLocaleDateString('sv-SE');
const first=(xs,p)=>xs.find(p);
const config=window.GPE_CONFIG||{};
const live=Boolean(config.SUPABASE_URL && config.SUPABASE_ANON_KEY);
const publicTest=live&&config.PUBLIC_TEST===true;
let client=null;
const months=(s,n)=>{const d=new Date(s+'T12:00:00');const t=new Date(d.getFullYear(),d.getMonth()+n,1,12);t.setDate(Math.min(d.getDate(),new Date(t.getFullYear(),t.getMonth()+1,0).getDate()));return t.toISOString().slice(0,10)};
const sys={profile:null,user:null,view:'home',selectedCustomer:null,selectedJob:null,selectedJE:null,groupOpen:{},filter:'',banner:'',alertClass:'',modal:null,templates:[],tables:{},signedIn:false,busy:false,mailReady:live&&config.REPORT_EMAIL_ENABLED};
let items=[];
let deferredInstallPrompt=null;
window.addEventListener('beforeinstallprompt',event=>{event.preventDefault();deferredInstallPrompt=event;});
if('serviceWorker' in navigator && (location.protocol==='https:' || location.hostname==='localhost')) {
 window.addEventListener('load',()=>navigator.serviceWorker.register('./sw.js').catch(err=>console.warn('Service worker could not be registered',err)));
}
function installHelp(){
 const isIOS=/iPhone|iPad|iPod/i.test(navigator.userAgent);
 const isAndroid=/Android/i.test(navigator.userAgent);
 return `<h2>Lägg appen på hemskärmen</h2><p>${isIOS?'Öppna webbadressen i Safari, tryck på Dela och välj <strong>Lägg till på hemskärmen</strong>.':isAndroid?'Öppna webbadressen i Chrome, tryck på menyn ⋮ och välj <strong>Installera app</strong> eller <strong>Lägg till på startskärmen</strong>.':'Öppna sidan i Chrome, Edge eller Safari och använd webbläsarens installationsalternativ.'}</p><p class="muted small">Appen kräver internet för att synkronisera riktiga serviceuppdrag mellan montörer.</p><button type="button" class="action" data-action="close-modal">Stäng</button>`;
}

const DEMOKEY='gpe-portservice-open-test-v4';
const OLD_TEST_KEYS=['gpe-portservice-test-v3','gpe-portservice-v2-2-palladium-demo'];
const TECHKEY='gpe-selected-technician-v4';
const TECHNICIANS=[
 {user_id:'demo-martin',display_name:'Martin Olsson',role:'admin'},
 {user_id:'demo-patrik',display_name:'Patrik Karlsson',role:'technician'},
 {user_id:'demo-bubba',display_name:'Bubba Fahlstedt',role:'technician'},
 {user_id:'demo-jonathan',display_name:'Jonathan Hurtig',role:'technician'},
 {user_id:'demo-nicklas',display_name:'Nicklas Jansson',role:'technician'}
];
const sample=()=>{
 const org='demo-organization'; const customer='palladium-test-customer';
 const profiles=TECHNICIANS.map(p=>({...p,org_id:org,active:true}));
 const equipment=[1,2,3,4].map(n=>({id:'palladium-spu40-'+n,org_id:org,customer_id:customer,
  number:'Port '+n,template_id:'GE-IND-TAKSKJUT-MOTOR',subtype:'',manufacturer:'Hörmann',
  model:'SPU 40',controller:'Hörmann A445',serial_no:'',interval_months:null,
  next_service_on:null,responsible_user:null,active:true}));
 return {organizations:[{id:org,name:'GPE Finspång Service App',protocol_email:''}],profiles,
  customers:[{id:customer,org_id:org,customer_type:'Företag',name:'Palladium Fastigheter AB',
    address:'Skäggebyvägen 13, 612 44 Finspång',email:'Info@palladiumfastigheter.se',
    contact:'Martin O',phone:'0705297071'}],
  equipment,service_jobs:[],job_equipment:[],inspection_answers:[],issues:[]};
};
function persist(){if(!live)localStorage.setItem(DEMOKEY,JSON.stringify(sys.tables));}
function notify(message,bad=false){sys.banner=message;sys.alertClass=bad?'error':'success';render();}
async function prepareDueJobs(){
 if(!publicTest)return;
 const horizon=new Date();horizon.setDate(horizon.getDate()+10);
 const maxDate=horizon.toISOString().slice(0,10);
 const available=table('equipment').filter(e=>e.active!==false&&e.next_service_on&&e.next_service_on<=maxDate&&[3,6,12].includes(e.interval_months));
 let created=0;
 for(const e of available){
  const links=table('job_equipment').filter(je=>je.equipment_id===e.id);
  if(links.some(je=>{const j=jobBy(je.job_id);return j&&(j.status==='draft'||(j.status==='completed'&&j.service_date===e.next_service_on))}))continue;
  let job=table('service_jobs').find(j=>j.customer_id===e.customer_id&&j.service_date===e.next_service_on&&j.status==='draft');
  if(!job){const rows=await insertRows('service_jobs',[{org_id:e.org_id,customer_id:e.customer_id,service_date:e.next_service_on,started_by:e.responsible_user||sys.user.id,status:'draft'}]);job=rows[0];table('service_jobs').push(job);}
  const rows=await insertRows('job_equipment',[{org_id:e.org_id,job_id:job.id,equipment_id:e.id}]);table('job_equipment').push(rows[0]);created++;
 }
 if(created)await refresh();
}
async function init(){
 try{
   const res=await fetch('./checklists.json',{cache:'no-store'});if(!res.ok)throw Error('Checklistefilen kunde inte läsas');items=await res.json();
   sys.templates=[...new Map(items.map(p=>[p.template,p.template_name])).entries()].map(([id,name])=>({id,name})).sort((a,b)=>a.name.localeCompare(b.name,'sv'));
   if(live){
     const supabase=await import('https://esm.sh/@supabase/supabase-js@2.49.4');
     createClient=supabase.createClient;
     client=createClient(config.SUPABASE_URL,config.SUPABASE_ANON_KEY,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}});
     if(publicTest){
       sys.signedIn=true;
       sys.selectedCustomer='palladium-test-customer';
       await refresh();
       await prepareDueJobs();
     }else{
       const {data}=await client.auth.getSession();
       if(data?.session)await loadUser(data.session.user);else renderLogin();
       client.auth.onAuthStateChange(async(ev,session)=>{if(ev==='SIGNED_OUT'){sys.user=null;sys.signedIn=false;renderLogin()}else if(ev==='SIGNED_IN'&&!sys.signedIn&&session)await loadUser(session.user)});
     }
   }else{
     let cached=null;
     for(const key of [DEMOKEY,...OLD_TEST_KEYS]){
       try{cached=JSON.parse(localStorage.getItem(key)||'null');if(cached?.customers?.length)break}catch(e){}
     }
     sys.tables=cached||sample();
     for(const original of sample().profiles){const p=sys.tables.profiles.find(x=>x.user_id===original.user_id);if(p)p.display_name=original.display_name;}
     const oldCustomer=sys.tables.customers.find(x=>x.id==='palladium-test-customer');
     if(oldCustomer&&oldCustomer.address==='Finspång (testanläggning)')Object.assign(oldCustomer,{address:'Skäggebyvägen 13, 612 44 Finspång',email:'Info@palladiumfastigheter.se',contact:'Martin O',phone:'0705297071'});
     const techId=localStorage.getItem(TECHKEY);
     sys.profile=sys.tables.profiles.find(p=>p.user_id===techId)||sys.tables.profiles[0];
     sys.user={id:sys.profile.user_id,email:''};sys.signedIn=true;
     sys.selectedCustomer='palladium-test-customer';persist();render();
   }
 }catch(e){$('#app').innerHTML=`<main class="boot"><h1>Det gick inte att starta appen</h1><p>${esc(e.message)}</p><p>Öppna webbappen från en HTTPS-adress, inte som en lokal fil.</p></main>`}
}
async function loadUser(user){
 const {data,error}=await client.from('profiles').select('*').eq('user_id',user.id).eq('active',true).maybeSingle();
 if(error||!data){sys.user=null;sys.signedIn=false;$('#app').innerHTML='<main class="boot"><h1>Åtkomst saknas</h1><p>Din användare måste läggas till av administratören. Kontakta appens administratör.</p><button id="logout" class="action">Logga ut</button></main>';return;}
 sys.user=user;sys.profile=data;sys.signedIn=true;await refresh();
}
const demoQuery=(table,filter={})=>sys.tables[table].filter(r=>Object.entries(filter).every(([k,v])=>r[k]===v));
async function getRows(table,filter={}){
 if(!live)return demoQuery(table,filter);
 let query=client.from(table).select('*');for(const [k,v] of Object.entries(filter))query=query.eq(k,v);
 const all=[];let offset=0;while(true){const {data,error}=await query.range(offset,offset+999);if(error)throw error;all.push(...data);if(data.length<1000)break;offset+=1000;}return all;
}
async function insertRows(table,rows){
 if(!Array.isArray(rows))rows=[rows];if(!rows.length)return[];
 if(!live){const entries=rows.map(row=>({id:id(),...row}));sys.tables[table].push(...entries);persist();return entries;}
 const {data,error}=await client.from(table).insert(rows).select('*');if(error)throw error;return data;
}
async function updateRow(table,rowid,patch){
 if(!live){const row=first(sys.tables[table],r=>r.id===rowid);if(!row)throw Error('Posten saknas');Object.assign(row,patch);persist();return row;}
 const {data,error}=await client.from(table).update(patch).eq('id',rowid).select('*').single();if(error)throw error;return data;
}
async function refresh(){
 const names=['organizations','profiles','customers','equipment','service_jobs','job_equipment','inspection_answers','issues'];
 const rows=await Promise.all(names.map(t=>getRows(t,{})));
 names.forEach((name,i)=>sys.tables[name]=rows[i]);
 if(publicTest){
   const preferred=localStorage.getItem(TECHKEY);
   sys.profile=table('profiles').find(x=>x.user_id===preferred)||table('profiles')[0];
   if(!sys.profile)throw Error('Montörerna saknas i projektets databas. Installera startdata.sql.');
   sys.user={id:sys.profile.user_id,email:''};sys.signedIn=true;
 }
 render();
}
const table=t=>sys.tables[t]||[];
const org=()=>sys.profile.org_id;
const customerBy=id=>first(table('customers'),x=>x.id===id);
const equipBy=id=>first(table('equipment'),x=>x.id===id);
const jobBy=id=>first(table('service_jobs'),x=>x.id===id);
const jeBy=id=>first(table('job_equipment'),x=>x.id===id);
const answersFor=jeid=>table('inspection_answers').filter(x=>x.job_equipment_id===jeid);
const ansFor=(jeid,itemid)=>first(table('inspection_answers'),x=>x.job_equipment_id===jeid&&x.item_id===itemid);
const templateTitle=id=>first(sys.templates,t=>t.id===id)?.name||id;
const equipmentFor=custId=>table('equipment').filter(x=>x.customer_id===custId&&x.active!==false).sort((a,b)=>a.number.localeCompare(b.number,'sv',{numeric:true}));
const jobsFor=custId=>table('service_jobs').filter(x=>!custId||x.customer_id===custId).sort((a,b)=>b.service_date.localeCompare(a.service_date));
const jesFor=jobId=>table('job_equipment').filter(x=>x.job_id===jobId).sort((a,b)=>(equipBy(a.equipment_id)?.number||'').localeCompare(equipBy(b.equipment_id)?.number||'', 'sv',{numeric:true}));
const itemsFor=e=>items.filter(p=>p.template===e.template_id&&!((p.condition||'').startsWith('Brandporttyp = ')&&p.condition!=='Brandporttyp = '+e.subtype)).sort((a,b)=>a.order-b.order);
const issuesFor=eid=>table('issues').filter(i=>i.equipment_id===eid&&i.state==='open');
const jobProgress=jobId=>{const jes=jesFor(jobId);let total=0,done=0,brists=0;
 for(const je of jes){const e=equipBy(je.equipment_id);if(!e)continue;const points=itemsFor(e);total+=points.length;for(const p of points){const a=ansFor(je.id,p.id);if(a&&(a.answer!=='Brist'||a.description?.trim()))done++;if(a?.answer==='Brist')brists++}}
 return {total,done,brists,n:jes.length};};
const labelStatus=jeid=>{const je=jeBy(jeid),e=equipBy(je?.equipment_id);if(!e)return'–';const pts=itemsFor(e),ans=answersFor(jeid);const d=pts.filter(p=>{const a=first(ans,x=>x.item_id===p.id);return a&&(a.answer!=='Brist'||a.description?.trim())}).length;if(d<pts.length)return `${d}/${pts.length}`;return ans.some(a=>a.answer==='Brist')?'Brist':'OK'};
function shell(title,subtitle,content){
 const nav=[['home','⌂','Startsida'],['customers','▦','Kunder'],['jobs','☷','Serviceuppdrag'],['checklist','☑','Checklista'],['issues','!','Öppna brister'],['reminders','▤','Påminnelser']];
 const n=nav.map(([k,ico,lab])=>`<button class="${sys.view===k?'active':''}" data-nav="${k}">${ico} &nbsp; ${lab}</button>`).join('');
 const inner=`<div class="shell"><aside class="side" id="sidebar"><div class="brand gpe-menu-brand"><img src="./assets/gpe-app-icon-192.png?v=6" alt="GPE Finspång Service App" class="gpe-menu-logo" /></div><div class="nav">${n}</div><div class="sidefoot">${live&&!publicTest?`${esc(sys.profile.display_name)}<br>${esc(sys.profile.role==='admin'?'Administratör':'Montör')}`:`<strong>${esc(sys.profile.display_name)}</strong><div class="muted small">Aktiv testmontör – byt längst upp i appen</div>`}</div></aside><div class="main">${sys.view==='home'?'<div class="gpe-top-brand"><img src="./assets/gpe-mascot-banner.webp?v=6" alt="GPE Finspång Service App" /></div>':''}<header class="topbar"><button class="mobilemenu" data-action="menu" aria-label="Öppna meny">☰ <span>Meny</span></button></header>${(publicTest||!live)?`<div class="technician-bar"><label for="active-technician">Aktiv montör</label><select id="active-technician" aria-label="Välj aktiv montör">${optionList(table('profiles').filter(p=>p.active!==false).map(p=>[p.user_id,p.display_name]),sys.profile.user_id)}</select><span class="technician-hint">Nya kontrollsvar registreras på vald montör. Ingen inloggning i testläget.</span></div>`:``}<main class="content"><h1>${esc(title)}</h1>${subtitle?`<p class="subhead">${esc(subtitle)}</p>`:''}${sys.banner?`<div class="notify ${sys.alertClass}">${esc(sys.banner)}</div>`:''}${content}<p class="footer">GPE Finspång Service App v5.7 ${publicTest?'· ÖPPEN TESTMILJÖ – uppgifter delas mellan alla besökare. Inga mejl skickas.':live?'· Företagsdatabas':'· LOKALT TEST – inga e-postutskick'}</p></main></div></div>`;
 $('#app').innerHTML=inner+(sys.modal?`<div class="modalback"><div class="modal" role="dialog" aria-modal="true">${sys.modal}</div></div>`:'');
}
function render(){if(!sys.signedIn)return renderLogin();let title='',sub='',body='';
 switch(sys.view){case'home':title='Startsida';sub='Dina serviceuppdrag och kommande service';body=renderHome();break;
 case'customers':title='Kunder';sub='Företag, BRF och samfälligheter';body=renderCustomers();break;
 case'equipment':title='Serviceobjekt';sub='Portar, lastbryggor, grindar och brandportar';body=renderEquipments();break;
 case'jobs':title='Serviceuppdrag';sub='Ett servicebesök kan omfatta flera objekt';body=renderJobs();break;
 case'checklist':title='Servicechecklista';sub='Alla punkter måste aktivt kontrolleras';body=renderChecklist();break;
 case'issues':title='Öppna brister';sub='Tidigare brister följer med till nästa service';body=renderIssues();break;
 case'reminders':title='Servicepåminnelser';sub='Servicebevakning i appen 10 dagar före – inga mejl i testläget';body=renderReminders();break;}
 shell(title,sub,body);
}
function renderLogin(){
 $('#app').innerHTML=`<div class="login"><div class="brand smallbrand"><img src="./assets/gpe-app-icon-192.png?v=6" alt="GPE Finspång Service App" class="gpe-menu-logo" /></div><div class="loginbody"><h2>Portservice – logga in</h2><form id="loginform"><div class="field"><label>E-post</label><input type="email" name="email" required autocomplete="username" /></div><div class="field"><label>Lösenord</label><input name="password" type="password" required autocomplete="current-password"/></div><button class="action" type="submit">Logga in</button></form><p class="small muted">Alla montörer har egna konton. Nya användare läggs till av administratören.</p></div></div>`;
}
function renderHome(){
 const homeBrand='<div class="gpe-home-brand"><img src="./assets/gpe-mascot-banner.webp?v=6" alt="GPE Finspång Service App – apa med verktyg" /></div>';
 const today=new Date().toISOString().slice(0,10),soon=new Date(Date.now()+10*86400000).toISOString().slice(0,10);
 const due=table('equipment').filter(e=>e.active&&e.next_service_on&&e.next_service_on<=soon&&(sys.profile.role==='admin'||!e.responsible_user||e.responsible_user===sys.user.id));
 const pending=jobsFor().filter(j=>j.status==='draft');
 return `<div class="grid"><div class="card"><h3>Service inom 10 dagar</h3><div class="big-num">${due.length}</div><div class="muted small">Tilldelade objekt inklusive försenade</div></div></div><div class="card"><div class="toolbar"><h2>Pågående serviceuppdrag</h2><button data-action="new-job" class="action">+ Ny service</button></div>${pending.length?pending.slice(0,20).map(j=>`<div class="listrow"><div><strong>${esc(customerBy(j.customer_id)?.name)}</strong><div class="muted small">${esc(j.service_date)} · ${jobProgress(j.id).n} objekt</div></div><button class="action secondary" data-job="${esc(j.id)}">Fortsätt</button></div>`).join(''):'<p class="muted">Inga pågående serviceuppdrag.</p>'}</div><div class="card"><h2>Kommande påminnelser</h2>${due.length?due.slice(0,12).map(e=>`<div class="listrow"><div><strong>${esc(customerBy(e.customer_id)?.name)} – ${esc(e.number)}</strong><div class="muted small">Nästa service ${esc(e.next_service_on)}</div></div><span class="badge ${e.next_service_on<today?'bad':'warn'}">${e.next_service_on<today?'Försenad':'Snart'}</span></div>`).join(''):'<p class="muted">Inga objekt att påminna om de närmaste 10 dagarna.</p>'}</div>`;
}
function renderCustomers(){let list=table('customers');if(sys.filter)list=list.filter(c=>(c.name+' '+c.address).toLowerCase().includes(sys.filter.toLowerCase()));
 return `<div class="toolbar"><input class="search" id="filter" placeholder="Sök kund eller adress" value="${esc(sys.filter)}" aria-label="Sök kund"><button class="action" data-action="new-customer">+ Ny kund</button></div><div class="card">${list.length?list.sort((a,b)=>a.name.localeCompare(b.name,'sv')).map(c=>`<div class="listrow"><div><strong>${esc(c.name)}</strong><div class="small muted">${esc(c.customer_type)} · ${esc(c.address)} · ${equipmentFor(c.id).length} objekt</div><div class="small muted">${esc(c.email)}</div></div><button class="action secondary" data-customer="${esc(c.id)}">Öppna</button></div>`).join(''):'<p>Ingen kund hittades.</p>'}</div>${sys.selectedCustomer&&sys.customerDetailOpen?renderCustomerDetail():''}`;
}
function renderCustomerDetail(){const c=customerBy(sys.selectedCustomer);if(!c)return'';
 return `<div class="card"><div class="toolbar"><h2>${esc(c.name)}</h2><div class="right"><button class="action secondary" data-action="edit-customer">Redigera</button><button class="action" data-action="new-equipment">+ Objekt</button><button class="action yellow" data-action="create-job">Starta service</button></div></div><p class="small muted">${esc(c.address)} · Kontakt: ${esc(c.contact)} · ${esc(c.phone)} · ${esc(c.email)}</p><h3>Registrerade objekt</h3>${equipmentFor(c.id).map(e=>`<div class="listrow"><div><strong>${esc(e.number)}</strong><div class="small muted">${esc(templateTitle(e.template_id))} ${e.manufacturer? '· '+esc(e.manufacturer):''} ${e.model?' '+esc(e.model):''} ${e.controller?'· Styrning '+esc(e.controller):''} · ${e.interval_months?e.interval_months+' mån':'Intervall ej valt'}</div></div><button class="action secondary" data-edit-equipment="${esc(e.id)}">Redigera</button></div>`).join('')||'<p>Inga objekt ännu.</p>'}</div>`;
}
function renderEquipments(){let xs=table('equipment').filter(e=>e.active!==false);if(sys.filter)xs=xs.filter(e=>(e.number+' '+customerBy(e.customer_id)?.name+' '+e.manufacturer).toLowerCase().includes(sys.filter.toLowerCase()));return `<div class="toolbar"><input class="search" id="filter" placeholder="Sök portnummer, kund, fabrikat" value="${esc(sys.filter)}"><button class="action" data-action="new-equipment">+ Nytt objekt</button></div><div class="card">${xs.slice(0,300).map(e=>`<div class="listrow"><div><strong>${esc(e.number)}</strong> <span class="badge">${esc(templateTitle(e.template_id))}</span><div class="small muted">${esc(customerBy(e.customer_id)?.name)} · nästa ${esc(e.next_service_on||'Ej planerad')}</div></div><button class="action secondary" data-edit-equipment="${esc(e.id)}">Ändra</button></div>`).join('')||'<p>Inga serviceobjekt registrerade ännu.</p>'}</div>`;}
function renderJobs(){return `<div class="toolbar"><div class="muted small">Ett uppdrag kan fortsätta flera dagar.</div><button class="action" data-action="new-job">+ Nytt serviceuppdrag</button></div><div class="card">${jobsFor().map(j=>`<div class="listrow"><div><strong>${esc(customerBy(j.customer_id)?.name)}</strong><div class="muted small">${esc(j.service_date)} · ${jobProgress(j.id).n} objekt</div></div><div class="right"><span class="badge ${j.status==='completed'?'good':'warn'}">${j.status==='completed'?'Avslutad':'Pågår'}</span><button class="action secondary" data-job="${esc(j.id)}">Öppna</button></div></div>`).join('')||'<p>Inga uppdrag finns ännu.</p>'}</div>`;}
function intervalPanel(job){if(job.status!=='draft')return '';const es=jesFor(job.id).map(x=>equipBy(x.equipment_id)).filter(Boolean);return `<div class="card"><h2>Serviceintervall</h2><p class="small muted">Välj ett intervall för alla portar eller ändra en port separat.</p><div class="toolbar">${[3,6,12].map(n=>`<button class="action secondary" data-interval-all="${n}">${n} månader – alla</button>`).join('')}</div>${es.map(e=>`<div class="listrow"><strong>${esc(e.number)}</strong><select style="max-width:165px" data-interval-object="${esc(e.id)}">${optionList([['','Välj intervall'],['3','3 månader'],['6','6 månader'],['12','12 månader']],String(e.interval_months||''))}</select></div>`).join('')}</div>`;}
function renderChecklist(){const job=jobBy(sys.selectedJob);if(!job)return `<div class="card"><p>Välj först ett serviceuppdrag.</p><button class="action" data-nav="jobs">Visa serviceuppdrag</button></div>`;
 const customer=customerBy(job.customer_id),jes=jesFor(job.id),p=jobProgress(job.id);if(!sys.selectedJE||!jes.some(x=>x.id===sys.selectedJE))sys.selectedJE=jes[0]?.id;
 const je=jeBy(sys.selectedJE),eq=equipBy(je?.equipment_id);
 return `<div class="card"><div class="toolbar"><div><h2>${esc(customer?.name)}</h2><div class="muted small">${esc(job.service_date)} · ${esc(job.status==='completed'?'Avslutad service':'Pågående service')}</div></div><button class="action secondary" data-nav="jobs">Alla uppdrag</button></div><div class="row small"><span>${p.done} / ${p.total} kontrollpunkter</span><span>${p.brists} registrerade brister</span></div><div class="progress" style="margin:9px 0 15px"><div style="width:${p.total?100*p.done/p.total:0}%"></div></div><div class="field"><label for="equips">Välj serviceobjekt (${jes.length} st)</label><select id="equips">${jes.map((j,i)=>{const e=equipBy(j.equipment_id);return`<option value="${esc(j.id)}" ${j.id===sys.selectedJE?'selected':''}>${esc(e?.number||'Okänt objekt')} – ${esc(labelStatus(j.id))}</option>`}).join('')}</select></div>${eq?renderIndividual(je,eq,job):'<p>Inga objekt kopplade.</p>'}</div>${intervalPanel(job)}${job.status==='draft'?`<div class="card"><div class="toolbar"><div><h2>Färdigställ kundens service</h2><p class="small muted">Alla obligatoriska kontroller och bristbeskrivningar måste vara klara.</p></div><button class="action yellow" data-action="finalize">Avsluta service</button></div></div>`:`<div class="card"><h2>Service avslutad</h2><div class="toolbar"><button class="action" data-action="pdf">Hämta gemensamt PDF-protokoll</button>${live&&sys.mailReady&&job.email_status!=='sent'?'<button class="action yellow" data-action="resend">Skicka protokoll</button>':''}</div><p class="small muted">E-post: ${esc(job.email_status==='sent'?'Skickat till kund och Garageportexperten':job.email_status==='failed'?'Utskick misslyckades':'Ännu inte skickat')}</p></div>`}`;
}
function renderIndividual(je,e,job){const pts=itemsFor(e);const cats=[...new Set(pts.map(x=>x.group))];const done=pts.filter(p=>{const a=ansFor(je.id,p.id);return a&&(a.answer!=='Brist'||a.description.trim())}).length;
 const open=issuesFor(e.id),openHtml=open.length?`<div class="warning"><strong><span aria-hidden="true">⚠️ </span>Kontrollera tidigare brister (${open.length})</strong><p class="small">Dessa brister är fortfarande öppna från tidigare service. Kontrollera på nytt att de kvarstår eller markera Åtgärdad och ange vad som gjorts.</p>${open.map(i=>`<div class="listrow"><div class="small">${esc(i.description)}</div>${job.status==='draft'?`<button class="action secondary" data-resolve="${esc(i.id)}">Åtgärdad</button>`:''}</div>`).join('')}</div>`:'';
 return `<div class="row" style="margin:10px 0 13px"><div><strong>${esc(e.number)}</strong><div class="small muted">${esc(templateTitle(e.template_id))} · ${esc(e.manufacturer||'')} ${esc(e.model||'')} ${e.controller?'· Styrning '+esc(e.controller):''}</div></div><span class="badge ${done===pts.length?'good':'warn'}">${done} / ${pts.length} klara</span></div>${openHtml}${cats.map((cat,idx)=>renderGroup(je,e,job,cat,idx,pts.filter(p=>p.group===cat))).join('')}<div class="toolbar"><button class="action secondary" data-action="prev-equipment">← Föregående</button><button class="action" data-action="next-equipment">Nästa objekt →</button></div>`;
}
function renderGroup(je,e,job,cat,idx,pts){const key=je.id+'|'+cat;const expanded=sys.groupOpen[key]??(idx===0);const completed=pts.filter(p=>{const a=ansFor(je.id,p.id);return a&&(a.answer!=='Brist'||a.description.trim())}).length;
 const bulk=pts.filter(p=>p.bulk&&!p.individual&&p.condition==='Alltid'&&!ansFor(je.id,p.id));const hasBrist=pts.some(p=>ansFor(je.id,p.id)?.answer==='Brist');
 return `<section class="group"><div class="grouphead"><button class="linkbtn grouptitle" data-toggle-group="${esc(key)}">${expanded?'▾':'▸'} ${esc(cat)}</button><span class="counter">${completed}/${pts.length}</span>${job.status==='draft'?`<button class="action yellow" data-bulk="${esc(key)}" ${hasBrist||!bulk.length?'disabled':''} title="Markera endast tillämpliga vanliga punkter som OK">Godkänn kategorin (${bulk.length})</button>`:''}</div>${expanded?`<div class="groupbody"><ul class="questions">${pts.map(p=>renderQuestion(je,job,p)).join('')}</ul></div>`:''}</section>`;
}
function renderQuestion(je,job,p){const a=ansFor(je.id,p.id),w=job.status==='draft';const canNA=p.condition!=='Alltid'&&p.condition!=='Alltid – motordriven port';
 return `<li class="question"><div class="qtitle">${esc(p.label)} ${p.individual?'<span class="badge">Enskild kontroll</span>':''}</div>${p.instruction?`<div class="qinfo">${esc(p.instruction)}</div>`:''}${canNA?`<div class="qinfo">Gäller: ${esc(p.condition)}</div>`:''}<div class="radios">${['OK','Brist',...(canNA?['Ej aktuellt']:[])].map(choice=>`<button ${w?'':'disabled'} class="pick ${a?.answer===choice?'selected '+(choice==='OK'?'good':choice==='Brist'?'bad':'na'):''}" data-answer="${esc(je.id)}|${esc(p.id)}|${esc(choice)}">${esc(choice)}</button>`).join('')}</div>${a?.answer==='Brist'?`<div class="issuebox"><label class="small" for="desc-${esc(p.id)}"><strong>Beskriv bristen *</strong></label><textarea id="desc-${esc(p.id)}" data-description="${esc(je.id)}|${esc(p.id)}" ${w?'':'disabled'} placeholder="Vad är fel och vad behöver åtgärdas?">${esc(a.description)}</textarea>${!a.description?.trim()?'<div class="small" style="color:#a33">Beskrivningen krävs innan service kan avslutas.</div>':''}</div>`:''}</li>`;
}
function renderIssues(){const unresolved=table('issues').filter(i=>i.state==='open');return `<div class="card"><h2>Alla öppna brister (${unresolved.length})</h2>${unresolved.length?unresolved.map(i=>`<div class="listrow"><div><strong>${esc(customerBy(equipBy(i.equipment_id)?.customer_id)?.name)} – ${esc(equipBy(i.equipment_id)?.number)}</strong><div class="small">${esc(i.description)}</div></div><button class="action secondary" data-resolve="${esc(i.id)}">Markera åtgärdad</button></div>`).join(''):'<p>Inga öppna brister registrerade.</p>'}</div>`;}
function renderReminders(){const now=new Date().toISOString().slice(0,10),to=new Date(Date.now()+10*86400000).toISOString().slice(0,10);const rs=table('equipment').filter(e=>e.active&&e.next_service_on&&e.next_service_on<=to&&(sys.profile.role==='admin'||!e.responsible_user||e.responsible_user===sys.user.id)).sort((a,b)=>a.next_service_on.localeCompare(b.next_service_on));
 return `<div class="notify">Servicepåminnelserna ska gå till ansvarig montör, inte till kunden. Här visas objekt inom 10 dagar och försenade serviceobjekt. Automatiska påminnelsemejl aktiveras vid produktionssättning.</div><div class="card">${rs.map(e=>`<div class="listrow"><div><strong>${esc(customerBy(e.customer_id)?.name)} – ${esc(e.number)}</strong><div class="muted small">Nästa service ${esc(e.next_service_on)} · ${e.interval_months} månader</div></div><span class="badge ${e.next_service_on<now?'bad':'warn'}">${e.next_service_on<now?'Försenad':'Inom 10 dagar'}</span></div>`).join('')||'<p>Inga aktuella servicepåminnelser.</p>'}</div>`;
}
function optionList(data,current){return data.map(([value,label])=>`<option value="${esc(value)}" ${value===current?'selected':''}>${esc(label)}</option>`).join('')}
function customerForm(c){const isEdit=!!c;return `<h2>${isEdit?'Ändra kund':'Ny kund'}</h2><form id="customerform"><input type="hidden" name="id" value="${esc(c?.id||'')}"><div class="field"><label>Kundtyp</label><select name="customer_type">${optionList(['Företag','BRF','Samfällighet'].map(x=>[x,x]),c?.customer_type||'Företag')}</select></div><div class="field"><label>Namn *</label><input name="name" required value="${esc(c?.name||'')}"></div><div class="field"><label>Serviceintervall för alla kundens portar</label><select name="service_interval_months" required>${optionList([['','Välj intervall'],['3','3 månader'],['6','6 månader'],['12','12 månader']],String(c?.service_interval_months||''))}</select><p class="small muted">Gäller alla portar hos kunden och ärvs av nya portar.</p></div><div class="field"><label>Adress</label><input name="address" value="${esc(c?.address||'')}"></div><div class="fieldgroup"><div class="field"><label>Kontaktperson</label><input name="contact" value="${esc(c?.contact||'')}"></div><div class="field"><label>Telefon</label><input name="phone" value="${esc(c?.phone||'')}"></div></div><div class="field"><label>E-post för serviceprotokoll</label><input type="email" name="email" value="${esc(c?.email||'')}"></div><div class="toolbar"><button type="button" class="action secondary" data-action="close-modal">Avbryt</button><button class="action" type="button" data-save-customer="yes">Spara kund</button></div></form>`;}
function serviceTemplateOptions(selected){
 const groups=[
  ['Industriservice',[
   ['GE-LBH-01','Hydraulisk lastbrygga'],
   ['GE-LBM-01','Mekanisk lastbrygga'],
   ['GE-GSK-01','Motordriven skjutgrind'],
   ['GE-GSL-01','Motordriven slaggrind'],
   ['GE-RUL-01','Rullport'],
   ['GE-SNR-01','Snabbrullport'],
   ['GE-IND-TAKSKJUT-MOTOR','Takskjutsport'],
   ['GE-VIK-01','Vikport'],
   ['GE-VIP-01','Vipp port']]],
  ['Villaportservice',[
   ['GE-VILLA-TAK-MAN','Takskjutsport manuell'],
   ['GE-VILLA-TAK-MOTOR','Takskjutsport motor'],
   ['GE-VILLA-VIPP-MAN','Vipp port manuell'],
   ['GE-VILLA-VIPP-MOTOR','Vipp port motor'],
   ['GE-VILLA-SLAG-MAN','Slagport manuell'],
   ['GE-VILLA-SLAG-MOTOR','Slagport motor'],
   ['GE-VILLA-VIK-MAN','Vikport manuell'],
   ['GE-VILLA-VIK-MOTOR','Vikport motor']]],
  ['Övriga befintliga servicemallar',[
   ['GE-SLP-01','Slagport – industri'],
   ['GE-BRANDPORT-01','Brandport']]]];
 const known=new Set(sys.templates.map(t=>t.id));
 return '<option value="" '+(!selected?'selected':'')+' disabled>Välj porttyp</option>'+groups.map(([heading,options])=>
  '<optgroup label="'+esc(heading)+'">'+options.filter(([id])=>known.has(id)).map(([id,label])=>
   '<option value="'+esc(id)+'" '+(id===selected?'selected':'')+'>'+esc(label)+'</option>').join('')+'</optgroup>').join('');
}
function equipmentForm(e){let cid=e?.customer_id||sys.selectedCustomer||table('customers')[0]?.id;return `<h2>${e?'Ändra':'Lägg till'} serviceobjekt</h2><form id="equipmentform"><input type="hidden" name="id" value="${esc(e?.id||'')}"><div class="field"><label>Kund *</label><select name="customer_id" required>${optionList(table('customers').map(c=>[c.id,c.name]),cid)}</select></div><div class="field"><label>Portnummer / objektnummer *</label><input name="number" required value="${esc(e?.number||'')}"></div><div class="field"><label>Porttyp / servicemall</label><select name="template_id" id="obj-template">${serviceTemplateOptions(e?.template_id)}</select></div><div class="field"><label>Brandportsutförande (om brandport)</label><select name="subtype">${optionList([['','Ej brandport / välj senare'],['Skjutbrandport','Skjutbrandport'],['Vikbrandport','Vikbrandport'],['Brandjalusi','Brandjalusi']],e?.subtype||'')}</select></div><div class="fieldgroup"><div class="field"><label>Fabrikat</label><input name="manufacturer" value="${esc(e?.manufacturer||'')}"></div><div class="field"><label>Modell</label><input name="model" value="${esc(e?.model||'')}"></div></div><div class="field"><label>Styrning</label><input name="controller" value="${esc(e?.controller||'')}" placeholder="t.ex. Hörmann A445"></div><div class="field"><label>Serienummer</label><input name="serial_no" value="${esc(e?.serial_no||'')}"></div><div class="fieldgroup"><div class="field"><label>Serviceintervall</label><select name="interval_months">${optionList([['','Välj intervall'],[3,'3 månader'],[6,'6 månader'],[12,'12 månader']].map(([a,b])=>[String(a),b]),String(e?.interval_months||customerBy(cid)?.service_interval_months||''))}</select></div><div class="field"><label>Nästa service</label><input type="date" name="next_service_on" value="${esc(e?.next_service_on||'')}"></div></div><div class="field"><label>Ansvarig montör (påminnelse)</label><select name="responsible_user">${optionList([['','Ej tilldelad'],...table('profiles').filter(p=>p.active).map(p=>[p.user_id,p.display_name])],e?.responsible_user||'')}</select></div><div class="toolbar"><button type="button" class="action secondary" data-action="close-modal">Avbryt</button><button type="submit" class="action">Spara objekt</button></div></form>`;}
function newJobForm(){return `<h2>Starta serviceuppdrag</h2><form id="jobform"><div class="field"><label>Välj kund</label><select name="customer_id" id="newjobcustomer" required>${optionList(table('customers').map(c=>[c.id,c.name]),sys.selectedCustomer||table('customers')[0]?.id)}</select></div><div class="field"><label>Servicedatum</label><input type="date" name="service_date" value="${new Date().toISOString().slice(0,10)}"></div><div class="notify">Alla kundens registrerade objekt kopplas till uppdraget. De kan kontrolleras över flera dagar. Kontrollresultat börjar alltid tomma.</div><div class="toolbar"><button type="button" class="action secondary" data-action="close-modal">Avbryt</button><button class="action" type="submit">Starta service</button></div></form>`;}
function modal(html){sys.modal=html;render();}
async function saveAnswer(jeid,itemid,answer,description=''){
 const a=ansFor(jeid,itemid);if(!live){if(a)Object.assign(a,{answer,description,author_id:sys.user.id,updated_at:new Date().toISOString()});else sys.tables.inspection_answers.push({id:id(),org_id:org(),job_equipment_id:jeid,item_id:itemid,answer,description,author_id:sys.user.id});persist();return}
 if(answer==='Brist'&&!description.trim())return;
 const record={org_id:org(),job_equipment_id:jeid,item_id:itemid,answer,description,author_id:sys.user.id,updated_at:new Date().toISOString()};
 const {error}=await client.from('inspection_answers').upsert(record,{onConflict:'job_equipment_id,item_id'});if(error)throw error;
 if(a)Object.assign(a,record);else table('inspection_answers').push({id:id(),...record});
}
async function onAnswer(jeid,itemid,answer){
 const a=ansFor(jeid,itemid);if(answer==='Brist'){
   if(a)Object.assign(a,{answer,description:a.answer==='Brist'?a.description:''});else table('inspection_answers').push({id:id(),org_id:org(),job_equipment_id:jeid,item_id:itemid,answer,description:'',author_id:sys.user.id});persist();render();return;
 }
 await saveAnswer(jeid,itemid,answer,'');render();
}
async function onBulk(key){const [jeid,cat]=key.split('|'),e=equipBy(jeBy(jeid)?.equipment_id);
 const ps=itemsFor(e).filter(p=>p.group===cat);if(ps.some(p=>ansFor(jeid,p.id)?.answer==='Brist')){notify('Kategorin innehåller brister. Kontrollera punkterna individuellt.',true);return;}
 const allow=ps.filter(p=>p.bulk&&!p.individual&&p.condition==='Alltid'&&!ansFor(jeid,p.id));
 if(!allow.length){notify('Inga återstående punkter att godkänna. Befintliga svar, inklusive Ej aktuellt, är bevarade.');return;}
 if(!confirm(`Har du kontrollerat de ${allow.length} återstående punkterna i ”${cat}” utan att hitta någon brist? Tidigare Ej aktuellt och andra svar behålls.`))return;
 for(const p of allow)await saveAnswer(jeid,p.id,'OK');render();
}
function changeJE(delta){const jes=jesFor(sys.selectedJob),i=jes.findIndex(je=>je.id===sys.selectedJE);if(jes[i+delta]){sys.selectedJE=jes[i+delta].id;sys.groupOpen={};window.scrollTo(0,0);render()}}
async function doFinalize(){const j=jobBy(sys.selectedJob),jes=jesFor(j.id),progress=jobProgress(j.id);
 if(progress.done!==progress.total){notify(`Det saknas ${progress.total-progress.done} kontrollresultat eller bristbeskrivningar. Slutför kontrollerna innan avslut.`,true);return;}
 const unplanned=jes.map(x=>equipBy(x.equipment_id)).filter(e=>![3,6,12].includes(e.interval_months));
 if(unplanned.length){notify('Välj serviceintervall för: '+unplanned.map(e=>e.number).join(', ')+'.',true);return;}
 const c=customerBy(j.customer_id);if(!confirm(`Avsluta service för ${c.name}? Alla ${jes.length} objekt blir låsta i servicehistoriken.`))return;
 try{
   if(live){const {error}=await client.rpc('finalize_service_job',{p_job:j.id,p_technician:sys.user.id});if(error)throw error;await refresh();}
   else{Object.assign(j,{status:'completed',finished_at:new Date().toISOString(),finished_by:sys.user.id});for(const je of jes){const e=equipBy(je.equipment_id);e.next_service_on=months(j.service_date,e.interval_months);for(const a of answersFor(je.id).filter(a=>a.answer==='Brist')){sys.tables.issues.push({id:id(),org_id:org(),equipment_id:e.id,item_id:a.item_id,description:a.description,state:'open',opened_by:a.author_id,opened_job_id:j.id})}}persist();}
   await generateProtocol(j.id,true);sys.banner='Servicen är avslutad och PDF-protokollet framtaget.';sys.alertClass='success';render();
 }catch(e){notify('Kunde inte avsluta service: '+e.message,true)}
}
function pdfLines(jobId){const j=jobBy(jobId),c=customerBy(j.customer_id),jes=jesFor(jobId),good=[],bad=[],details=[];
 for(const je of jes){const e=equipBy(je.equipment_id),a=answersFor(je.id),failed=a.filter(x=>x.answer==='Brist');if(failed.length)bad.push({e,failed});else good.push(e);details.push({e,points:itemsFor(e),answers:a});}
 return {job:j,customer:c,good,bad,details,all:jes.length};
}
function protocolCategories(detail){
 const groups=[...new Set(detail.points.map(q=>q.group))];
 return groups.map(name=>{
  const questions=detail.points.filter(q=>q.group===name);
  const answers=questions.map(q=>({q,a:first(detail.answers,x=>x.item_id===q.id)}));
  const faults=answers.filter(x=>x.a?.answer==='Brist');
  const pending=answers.some(x=>!x.a?.answer);
  return {name,status:faults.length?'Brist':pending?'Ej kontrollerad':'OK',faults};
 });
}
function buildPrint(jobId){const p=pdfLines(jobId),line=(a)=>a.map(x=>esc(x.number)).join(', ');
 let html=`<div class="printpage"><h1>GARAGEPORTEXPERTEN – SERVICEPROTOKOLL</h1><p><strong>${esc(p.customer.name)}</strong><br>${esc(p.customer.address)}<br>Service ${esc(p.job.service_date)} · ${p.all} objekt · montör ${esc(first(table('profiles'),x=>x.user_id===p.job.finished_by)?.display_name||sys.profile.display_name)}</p><h2>Utan anmärkning (${p.good.length})</h2><p>${line(p.good)||'Inga'}</p><h2>Objekt med brister (${p.bad.length})</h2>`;
 for(const z of p.bad){html+=`<section><h3>${esc(z.e.number)}</h3>`;for(const b of z.failed){const q=first(items,x=>x.id===b.item_id);html+=`<div class="item bad">${esc(q?.label)}: ${esc(b.description)}</div>`}html+='</section>'}
 if(p.customer.customer_type==='Företag'){html+='<h2>Detaljerade kontrollresultat</h2>';for(const d of p.details){html+=`<section><h3>${esc(d.e.number)} – ${esc(templateTitle(d.e.template_id))} – ${esc(d.e.manufacturer)} ${esc(d.e.model)} / ${esc(d.e.controller)}</h3>`;for(const group of protocolCategories(d)){html+=`<div class="item">${esc(group.name)}: <strong>${esc(group.status)}</strong></div>`}html+='</section>'}}
 return html+'</div>';
}
async function generateProtocol(jobId,send){
 const p=pdfLines(jobId);
 const {PDFDocument,StandardFonts,rgb}=await import('https://esm.sh/pdf-lib@1.17.1');
 const doc=await PDFDocument.create();
 const regular=await doc.embedFont(StandardFonts.Helvetica),bold=await doc.embedFont(StandardFonts.HelveticaBold);
 const pg={w:595,h:842,left:42,right:42,top:38,bottom:43};
 const navy=rgb(.04,.26,.39),blue=rgb(.14,.39,.52),gray=rgb(.86,.88,.89);
 let page,y;
 function safe(v){return String(v??'').replace(/[\u2013\u2014]/g,'-').replace(/[\u2022]/g,'-').replace(/[^\u000a-\u00ff]/g,'?')}
 function wrap(v,font,size,width){const lines=[];for(const para of safe(v).split('\n')){let cur='';for(const word of para.split(/\s+/)){const next=cur?cur+' '+word:word;if(font.widthOfTextAtSize(next,size)>width&&cur){lines.push(cur);cur=word}else cur=next}lines.push(cur)}return lines}
 function textBlock(value,x,top,width,font=regular,size=10,color=navy,leading=14){let h=0;for(const line of wrap(value,font,size,width)){page.drawText(line||' ',{x,y:top-h,font,size,color});h+=leading}return h}
 function newPage(){page=doc.addPage([pg.w,pg.h]);y=pg.h-pg.top;
  const n=doc.getPageCount();
  if(n>1){page.drawRectangle({x:0,y:pg.h-13,width:pg.w,height:13,color:blue});page.drawText('GARAGEPORTEXPERTEN  |  SERVICEPROTOKOLL',{x:pg.left,y:pg.h-33,size:9,font:bold,color:blue});y-=28}
  page.drawText('Sida '+n,{x:pg.w-76,y:25,font:regular,size:9,color:blue});
 }
 function add(value,opt={}){const font=opt.bold?bold:regular,size=opt.size||10,lead=opt.leading||size+4,space=opt.after||0;
  for(const line of wrap(value,font,size,pg.w-pg.left-pg.right-(opt.indent||0))){if(y<pg.bottom+size+6)newPage();page.drawText(line||' ',{x:pg.left+(opt.indent||0),y,font,size,color:opt.color||navy});y-=lead}
  y-=space;
 }
 function heading(v){if(y<pg.bottom+65)newPage();y-=8;add(v,{bold:true,size:12,after:5})}
 newPage();
 // Corporate header modeled on the offer: Garageportexperten left; protocol and customer right.
 const logoY=pg.h-69;
 for(let i=0;i<3;i++)page.drawRectangle({x:48,y:logoY-i*21,width:66,height:16,color:blue});
 page.drawText('GARAGEPORT',{x:124,y:logoY-4,size:17,font:regular,color:blue});
 page.drawText('EXPERTEN',{x:124,y:logoY-28,size:21,font:bold,color:blue});
 page.drawText('PROTOKOLL',{x:329,y:pg.h-48,size:16,font:bold,color:navy});
 page.drawRectangle({x:326,y:pg.h-158,width:224,height:89,borderWidth:1,borderColor:gray});
 textBlock('Kund',339,pg.h-90,190,bold,9,navy,11);
 textBlock(p.customer.name,339,pg.h-108,198,bold,11,navy,13);
 page.drawText('Servicedatum: '+safe(p.job.service_date),{x:338,y:pg.h-144,size:9,font:regular,color:navy});
 y=pg.h-188;
 add('SERVICEUPPGIFTER',{bold:true,size:12,after:7});
 add('Kund: '+p.customer.name,{bold:true,size:11});
 add('Adress: '+p.customer.address);
 const technician=first(table('profiles'),x=>x.user_id===p.job.finished_by)?.display_name||sys.profile.display_name;
 add('Montör: '+technician);
 add('Antal portar/objekt: '+p.all+'   Utan brister: '+p.good.length+'   Med brister: '+p.bad.length,{after:13});
 heading('OBJEKT UTAN ANMÄRKNING ('+p.good.length+')');
 add(p.good.map(x=>x.number).join(', ')||'Inga',{after:11});
 heading('OBJEKT MED BRISTER ('+p.bad.length+')');
 if(!p.bad.length)add('Inga registrerade brister.',{after:7});
 for(const item of p.bad){add(item.e.number,{bold:true,size:11,after:3});
  for(const fault of item.failed){const point=first(items,x=>x.id===fault.item_id);add((point?.label||'Kontrollpunkt')+' - Brist',{bold:true,size:10});add(fault.description||'Bristbeskrivning saknas',{indent:12,after:4})}
  y-=5;
 }
 heading('KONTROLLRESULTAT PER KATEGORI');
 for(const d of p.details){
  if(y<pg.bottom+85)newPage();
  add(d.e.number+' - '+templateTitle(d.e.template_id),{bold:true,size:11});
  add([d.e.manufacturer,d.e.model,d.e.controller].filter(Boolean).join(' / '),{size:9,after:4});
  for(const group of protocolCategories(d)){
   add(group.name+' : '+group.status,{size:9,bold:group.status==='Brist',leading:12});
  }
  y-=10;
 }
 // Company information belongs at the bottom of the LAST page only.
 const footerHeight=106;
 if(y<pg.bottom+footerHeight)newPage();
 const footerTop=pg.bottom+footerHeight;
 page.drawLine({start:{x:pg.left,y:footerTop},end:{x:pg.w-pg.right,y:footerTop},thickness:0.9,color:gray});
 const fy=footerTop-19;
 textBlock('Port & Dörrexperten i Östergötland AB',pg.left,fy,205,bold,9,navy,12);
 textBlock('Skäggebyvägen 13\n612 44 Finspång\nOrg.nr 556963-1103',pg.left,fy-15,165,regular,8.5,navy,12);
 textBlock('Telefon 010-601 58 00\nMomsreg.nr SE556963110301\nBankgiro 5134-4521',239,fy,166,regular,8.5,navy,12);
 textBlock('www.garageportexperten.se\nfinspang@garageportexperten.se\nGodkänd för F-skatt',416,fy,145,regular,8.2,navy,12);
 const bytes=await doc.save();const blob=new Blob([bytes],{type:'application/pdf'});
 if(!live){const u=URL.createObjectURL(blob);const a=document.createElement('a');a.href=u;a.download='GPE_protokoll_ny_layout_'+p.job.service_date+'.pdf';a.click();setTimeout(()=>URL.revokeObjectURL(u),30000);return;}
 const path=org()+'/'+jobId+'/serviceprotokoll-'+new Date().toISOString().replaceAll(':','-')+'-'+id()+'.pdf';
 const {error}=await client.storage.from('service-protocols').upload(path,blob,{contentType:'application/pdf',upsert:false});if(error)throw error;
 await updateRow('service_jobs',jobId,{pdf_path:path});
 if(send&&sys.mailReady){const {error}=await client.functions.invoke('send-protocol',{body:{job_id:jobId}});if(error)throw new Error('PDF sparad men e-post gick inte iväg: '+error.message);}
 else{const u=URL.createObjectURL(blob);const a=document.createElement('a');a.href=u;a.download='GPE_protokoll_ny_layout_'+p.job.service_date+'.pdf';a.click();setTimeout(()=>URL.revokeObjectURL(u),30000)}
}
async function handleAction(a,btn){
 if(a==='export-demo'&&!live){
  const dump={version:3,exported_at:new Date().toISOString(),data:sys.tables};
  const blob=new Blob([JSON.stringify(dump,null,2)],{type:'application/json'});
  const u=URL.createObjectURL(blob);const link=document.createElement('a');link.href=u;
  link.download='GPE_Finspang_ServiceApp_testkopia_'+new Date().toISOString().slice(0,10)+'.json';
  document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(u),1000);
  notify('Testkopia hämtad till din enhet.');return;
 }
 if(a==='menu'){$('#sidebar')?.classList.toggle('open');return}
 if(a==='install'){
  if(deferredInstallPrompt){const prompt=deferredInstallPrompt;deferredInstallPrompt=null;await prompt.prompt();return;}
  modal(installHelp());return;
 }
 if(a==='close-modal'){sys.modal=null;render();return}
 if(a==='logout'){if(live)await client.auth.signOut();else notify('Demoläget saknar riktig inloggning.');return}
 if(a==='save-customer'){
  const form=document.querySelector('#customerform');
  if(!form)return;
  if(!form.reportValidity())return;
  const saveButton=form.querySelector('[data-action="save-customer"]');
  if(saveButton){saveButton.disabled=true;saveButton.textContent='Sparar kund…';}
  try {await handleSubmit({target:form,preventDefault(){}});}
  finally {
    const current=document.querySelector('#customerform [data-action="save-customer"]');
    if(current){current.disabled=false;current.textContent='Spara kund';}
  }
  return;
 }
 if(a==='new-customer'){modal(customerForm(null));return}
 if(a==='edit-customer'){modal(customerForm(customerBy(sys.selectedCustomer)));return}
 if(a==='new-equipment'){if(!table('customers').length){notify('Lägg upp en kund först.',true);return}modal(equipmentForm(null));return}
 if(a==='new-job'){if(!table('customers').length){notify('Lägg upp en kund först.',true);return}modal(newJobForm());return}
 if(a==='create-job'){modal(newJobForm());return}
 if(a==='next-equipment'){changeJE(1);return}
 if(a==='prev-equipment'){changeJE(-1);return}
 if(a==='finalize'){await doFinalize();return}
 if(a==='pdf'){try{await generateProtocol(sys.selectedJob,false)}catch(e){notify(e.message,true)}return}
 if(a==='resend'){try{const {error}=await client.functions.invoke('send-protocol',{body:{job_id:sys.selectedJob}});if(error)throw error;await refresh();notify('Serviceprotokollet har skickats.')}catch(e){notify(e.message,true)}return}
}
async function handleSubmit(ev){const form=ev.target;if(!['loginform','customerform','equipmentform','jobform'].includes(form.id))return;ev.preventDefault();if(form.dataset.saving==='1')return;form.dataset.saving='1';const status=document.createElement('p');status.className='small muted save-status';status.textContent='Sparar, vänta…';form.append(status);const f=new FormData(form);const v=key=>String(f.get(key)||'').trim();
 try{
  if(form.id==='loginform'){const {error}=await client.auth.signInWithPassword({email:v('email'),password:v('password')});if(error)throw error;return;}
  if(form.id==='customerform'){
   if(![3,6,12].includes(Number(v('service_interval_months'))))throw Error('Välj 3, 6 eller 12 månaders serviceintervall för kunden.');
   const rec={customer_type:v('customer_type'),name:v('name'),address:v('address'),contact:v('contact'),phone:v('phone'),email:v('email'),service_interval_months:Number(v('service_interval_months'))};
   if(v('id')){await updateRow('customers',v('id'),rec);for(const e of equipmentFor(v('id')))await updateRow('equipment',e.id,{interval_months:rec.service_interval_months});}else{
    const added=await insertRows('customers',[{org_id:org(),...rec}]);
    if(!added?.[0]?.id)throw Error('Databasen bekräftade inte att kunden skapades.');
    sys.selectedCustomer=added[0].id;
   }
   sys.view='customers';sys.customerDetailOpen=true;sys.filter='';await refresh();
   if(!customerBy(sys.selectedCustomer))throw Error('Kunden gick inte att hitta efter sparning.');
   sys.modal=null;sys.banner='Kunden har sparats: '+rec.name;sys.alertClass='success';render();return;
  }
  if(form.id==='equipmentform'){
   const rec={customer_id:v('customer_id'),number:v('number'),template_id:v('template_id'),subtype:v('subtype'),manufacturer:v('manufacturer'),model:v('model'),controller:v('controller'),serial_no:v('serial_no'),interval_months:v('interval_months')?Number(v('interval_months')):(customerBy(v('customer_id'))?.service_interval_months||null),next_service_on:v('next_service_on')||null,responsible_user:v('responsible_user')||null};
   if(rec.template_id==='GE-BRANDPORT-01'&&!rec.subtype)throw Error('Välj brandportstyp innan du sparar');
   if(v('id'))await updateRow('equipment',v('id'),rec);else await insertRows('equipment',[{org_id:org(),...rec}]);
   sys.modal=null;await refresh();return;
  }
  if(form.id==='jobform'){
   const es=equipmentFor(v('customer_id'));if(!es.length)throw Error('Kunden saknar serviceobjekt. Lägg till ett först.');
   const [job]=await insertRows('service_jobs',[{org_id:org(),customer_id:v('customer_id'),service_date:v('service_date'),started_by:sys.user.id,status:'draft'}]);
   await insertRows('job_equipment',es.map(e=>({org_id:org(),job_id:job.id,equipment_id:e.id})));
   sys.modal=null;sys.selectedJob=job.id;sys.selectedJE=null;sys.view='checklist';await refresh();return;
  }
 }catch(e){
  console.error('Sparfel i formulär',form.id,e);
  const msg='Kunde inte spara: '+(e?.message||String(e))+(e?.code?' (felkod '+e.code+')':'');
  let area=form.querySelector('.form-save-error');
  if(!area){area=document.createElement('div');area.className='form-save-error warning';area.setAttribute('role','alert');form.prepend(area);}
  area.textContent=msg;
  area.style.cssText='padding:16px;background:#fff1f0;color:#9b1717;font-size:18px;font-weight:700;border:2px solid #a22;border-radius:10px;';
  sys.banner=msg;sys.alertClass='error';
  area.scrollIntoView({behavior:'smooth',block:'nearest'});
 }finally{form.dataset.saving='0';status.remove();}
}
// Event delegation works with all views and Safari touch interactions.
document.addEventListener('click',async ev=>{
 const el=ev.target.closest('[data-interval-all],[data-action],[data-nav],[data-customer],[data-job],[data-edit-equipment],[data-resolve],[data-toggle-group],[data-bulk],[data-answer]');if(!el)return;
 if(el.dataset.action==='close-modal'&&el.classList.contains('modalback')&&ev.target!==el)return;
 try{
  if(el.dataset.intervalAll){
   const j=jobBy(sys.selectedJob);if(!j||j.status!=='draft')return;
   const n=Number(el.dataset.intervalAll),es=jesFor(j.id).map(x=>equipBy(x.equipment_id)).filter(Boolean);
   if(!confirm('Sätt '+n+' månader på '+es.length+' serviceobjekt?'))return;
   for(const e of es)await updateRow('equipment',e.id,{interval_months:n,responsible_user:e.responsible_user||sys.user.id});
   await refresh();notify('Serviceintervall sparade för alla objekt.');return;
  }
  if(el.dataset.nav){sys.view=el.dataset.nav;if(sys.view==='customers')sys.customerDetailOpen=false;sys.banner='';sys.filter='';render();return;}
  if(el.dataset.customer){sys.selectedCustomer=el.dataset.customer;sys.customerDetailOpen=true;sys.view='customers';render();return;}
  if(el.dataset.job){sys.selectedJob=el.dataset.job;sys.selectedJE=null;sys.groupOpen={};sys.view='checklist';render();return;}
  if(el.dataset.editEquipment){modal(equipmentForm(equipBy(el.dataset.editEquipment)));return;}
  if(el.dataset.resolve){const description=prompt('Beskriv hur bristen har åtgärdats:');if(!description)return;if(description.trim().length<3){notify('Beskriv åtgärden mer noggrant.',true);return;}
   if(live&&!publicTest){const {error}=await client.rpc('resolve_issue',{p_issue:el.dataset.resolve,p_resolution:description});if(error)throw error;await refresh();}
   else if(publicTest){await updateRow('issues',el.dataset.resolve,{state:'resolved',resolution:description,resolved_by:sys.user.id,resolved_at:new Date().toISOString()});await refresh();}
   else {const issue=first(table('issues'),x=>x.id===el.dataset.resolve);Object.assign(issue,{state:'resolved',resolution:description,resolved_by:sys.user.id,resolved_at:new Date().toISOString()});persist();render();}return;}
  if(el.dataset.toggleGroup){sys.groupOpen[el.dataset.toggleGroup]=!(sys.groupOpen[el.dataset.toggleGroup]??(el.dataset.toggleGroup.endsWith(itemsFor(equipBy(jeBy(sys.selectedJE)?.equipment_id))[0]?.group)));render();return;}
  if(el.dataset.bulk){await onBulk(el.dataset.bulk);return;}
  if(el.dataset.answer){const [jeid,itemid,answer]=el.dataset.answer.split('|');await onAnswer(jeid,itemid,answer);return;}
  if(el.dataset.action)await handleAction(el.dataset.action,el);
 }catch(e){notify('Ett fel uppstod: '+e.message,true)}
});
document.addEventListener('click',async function saveCustomerFromTap(event){
 const button=event.target.closest('[data-save-customer]');
 if(!button)return;
 event.preventDefault();
 event.stopPropagation();
 const form=button.closest('form');
 if(!form)return;
 if(!form.reportValidity()){const invalid=form.querySelector(':invalid');if(invalid){invalid.focus();invalid.scrollIntoView({block:'center'});}return;}
 button.disabled=true;
 button.textContent='Sparar kund...';
 try{await handleSubmit({target:form,preventDefault(){}});}
 catch(err){
  let area=form.querySelector('.form-save-error');
  if(!area){area=document.createElement('div');area.className='form-save-error';form.prepend(area);}
  area.textContent='Sparfel: '+(err?.message||String(err));
  area.style.cssText='padding:15px;background:#fff0f0;color:#a00;font-weight:bold';
 }finally{
  const still=document.querySelector('#customerform [data-save-customer]');
  if(still){still.disabled=false;still.textContent='Spara kund';}
 }
},true);
document.addEventListener('submit',handleSubmit);
document.addEventListener('change',async ev=>{if(ev.target.dataset.intervalObject){
 const n=Number(ev.target.value);if(![3,6,12].includes(n))return;
 try{const e=equipBy(ev.target.dataset.intervalObject);await updateRow('equipment',e.id,{interval_months:n,responsible_user:e.responsible_user||sys.user.id});await refresh();notify('Serviceintervall sparat.')}catch(err){notify(err.message,true)}return;
 }if(ev.target.id==='equips'){sys.selectedJE=ev.target.value;sys.groupOpen={};render()} if((ev.target.id==='active-technician'||ev.target.id==='demo-technician')&&(!live||publicTest)){const p=first(table('profiles'),p=>p.user_id===ev.target.value&&p.active!==false);if(p){sys.profile=p;sys.user={id:p.user_id,email:''};localStorage.setItem(TECHKEY,p.user_id);sys.banner='Aktiv montör: '+p.display_name+'. Nya kontroller registreras på denna montör.';sys.alertClass='success';render()}}});
document.addEventListener('input',ev=>{if(ev.target.id==='filter'){const start=ev.target.selectionStart;sys.filter=ev.target.value;render();const inp=$('#filter');inp?.focus();inp?.setSelectionRange(start,start)}});
document.addEventListener('focusout',async ev=>{
 const text=ev.target;if(!text.matches('[data-description]'))return;
 const [jeid,itemid]=text.dataset.description.split('|'),value=text.value.trim();if(!value)return;const a=ansFor(jeid,itemid);if(a?.answer==='Brist'){try{await saveAnswer(jeid,itemid,'Brist',value);render()}catch(e){notify('Bristen kunde inte sparas: '+e.message,true)}}
});
init();