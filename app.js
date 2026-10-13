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
const sharedLoginPreview=live&&new URLSearchParams(location.search).get('test-login')==='1';
const publicTest=live&&config.PUBLIC_TEST===true&&!sharedLoginPreview;
const sharedLogin=live&&!publicTest&&(config.SHARED_LOGIN===true||sharedLoginPreview);
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
  equipment,service_jobs:[],job_equipment:[],inspection_answers:[],issues:[],issue_service_checks:[]};
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
     client=createClient(config.SUPABASE_URL,config.SUPABASE_ANON_KEY,{auth:{persistSession:sharedLogin,autoRefreshToken:sharedLogin,detectSessionInUrl:false}});
     if(publicTest){
       sys.signedIn=true;
       sys.selectedCustomer='palladium-test-customer';
       await refresh();
       await prepareDueJobs();
     }else{
       const {data}=await client.auth.getSession();
       if(data?.session){if(sharedLogin){sys.signedIn=true;await refresh();}else await loadUser(data.session.user);}else renderLogin();
       client.auth.onAuthStateChange(async(ev,session)=>{if(ev==='SIGNED_OUT'){sys.user=null;sys.signedIn=false;renderLogin()}else if(ev==='SIGNED_IN'&&!sys.signedIn&&session){if(sharedLogin){sys.signedIn=true;await refresh();}else await loadUser(session.user)}});
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
 const names=['organizations','profiles','customers','equipment','service_jobs','job_equipment','inspection_answers','issues','issue_service_checks','legacy_service_imports','legacy_service_issues','equipment_catalog'];
 const rows=await Promise.all(names.map(t=>getRows(t,{})));
 names.forEach((name,i)=>sys.tables[name]=rows[i]);
 if(publicTest||sharedLogin){
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
const itemsFor=e=>{const c=customerBy(e.customer_id);const isAssociation=['BRF','Samfällighet'].includes(c?.customer_type);const simplified=isAssociation&&(String(e.template_id||'').startsWith('GE-VILLA-')||e.template_id==='GE-BRF-PORT');const template=simplified?'GE-BRF-PORT':e.template_id;return items.filter(p=>p.template===template&&!((p.condition||'').startsWith('Brandporttyp = ')&&p.condition!=='Brandporttyp = '+e.subtype)).sort((a,b)=>a.order-b.order);};
const issuesFor=eid=>table('issues').filter(i=>i.equipment_id===eid&&i.state==='open');
const jobProgress=jobId=>{const jes=jesFor(jobId);let total=0,done=0,brists=0;
 for(const je of jes){const e=equipBy(je.equipment_id);if(!e)continue;const points=itemsFor(e);total+=points.length;for(const p of points){const a=ansFor(je.id,p.id);if(a&&(a.answer!=='Brist'||a.description?.trim()))done++;if(a?.answer==='Brist')brists++}}
 return {total,done,brists,n:jes.length};};
const labelStatus=jeid=>{const je=jeBy(jeid),e=equipBy(je?.equipment_id);if(!e)return'–';const pts=itemsFor(e),ans=answersFor(jeid);const d=pts.filter(p=>{const a=first(ans,x=>x.item_id===p.id);return a&&(a.answer!=='Brist'||a.description?.trim())}).length;if(d<pts.length)return `${d}/${pts.length}`;return ans.some(a=>a.answer==='Brist')?'Brist':'OK'};
function shell(title,subtitle,content){
 const nav=[['home','⌂','Startsida'],['customers','▦','Kunder'],['jobs','☷','Serviceuppdrag'],['issues','!','Öppna brister']];
 const n=nav.map(([k,ico,lab])=>`<button class="${sys.view===k?'active':''}" data-nav="${k}">${ico} &nbsp; ${lab}</button>`).join('');
 const inner=`<div class="shell"><aside class="side" id="sidebar"><div class="brand gpe-menu-brand"><img src="./assets/gpe-app-icon-192.png?v=6" alt="GPE Finspång Service App" class="gpe-menu-logo" /></div><div class="nav">${n}</div><div class="sidefoot">${live&&!publicTest&&!sharedLogin?`${esc(sys.profile.display_name)}<br>${esc(sys.profile.role==='admin'?'Administratör':'Montör')}`:`<strong>${esc(sys.profile.display_name)}</strong><div class="muted small">Aktiv montör – byt längst upp i appen</div>`}</div></aside><div class="main">${sys.view==='home'?'<div class="gpe-top-brand"><img src="./assets/gpe-mascot-banner.webp?v=6" alt="GPE Finspång Service App" /></div>':''}<header class="topbar"><button class="mobilemenu" data-action="menu" aria-label="Öppna meny">☰ <span>Meny</span></button></header>${(publicTest||sharedLogin||!live)?`<div class="technician-bar"><label for="active-technician">Aktiv montör</label><select id="active-technician" aria-label="Välj aktiv montör">${optionList(table('profiles').filter(p=>p.active!==false).map(p=>[p.user_id,p.display_name]),sys.profile.user_id)}</select><span class="technician-hint">Nya kontrollsvar registreras på vald montör.</span></div>`:``}<main class="content"><h1>${esc(title)}</h1>${subtitle?`<p class="subhead">${esc(subtitle)}</p>`:''}${sys.banner?`<div class="notify ${sys.alertClass}">${esc(sys.banner)}</div>`:''}${content}<p class="footer">GPE Finspång Service App v6.2 ${publicTest?'· ÖPPEN TESTMILJÖ – uppgifter delas mellan alla besökare. Inga mejl skickas.':live?'· Företagsdatabas':'· LOKALT TEST – inga e-postutskick'}</p></main></div></div>`;
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
 $('#app').innerHTML=`<div class="login"><div class="brand smallbrand"><img src="./assets/gpe-app-icon-192.png?v=6" alt="GPE Finspång Service App" class="gpe-menu-logo" /></div><div class="loginbody"><h2>Portservice – logga in</h2><form id="loginform"><div class="field"><label>${sharedLogin?'Användarnamn':'E-post'}</label><input type="text" name="email" required autocomplete="username" ${sharedLogin?'value="Balto"':''} /></div><div class="field"><label>Lösenord</label><input name="password" type="password" required autocomplete="current-password"/></div><button class="action" type="submit">Logga in</button></form><p class="small muted">${sharedLogin?'Alla använder samma inloggning och väljer sedan aktiv montör.':'Alla montörer har egna konton. Nya användare läggs till av administratören.'}</p></div></div>`;
}
function renderHome(){
 const homeBrand='<div class="gpe-home-brand"><img src="./assets/gpe-mascot-banner.webp?v=6" alt="GPE Finspång Service App – apa med verktyg" /></div>';
 const today=new Date().toISOString().slice(0,10),soon=new Date(Date.now()+10*86400000).toISOString().slice(0,10);
 const due=table('equipment').filter(e=>e.active&&e.next_service_on&&e.next_service_on<=soon&&(sys.profile.role==='admin'||!e.responsible_user||e.responsible_user===sys.user.id));
 const reminder30=new Date(Date.now()+30*86400000).toISOString().slice(0,10);
 const upcoming=table('equipment').filter(e=>e.active&&e.next_service_on&&e.next_service_on<=reminder30&&(sys.profile.role==='admin'||!e.responsible_user||e.responsible_user===sys.user.id)).sort((a,b)=>a.next_service_on.localeCompare(b.next_service_on));
 const pending=jobsFor().filter(j=>j.status==='draft');
 return `<div class="grid"><div class="card"><h3>Service inom 10 dagar</h3><div class="big-num">${due.length}</div><div class="muted small">Tilldelade objekt inklusive försenade</div></div></div><div class="card"><div class="toolbar"><h2>Pågående serviceuppdrag</h2><button data-action="new-job" class="action">+ Ny service</button></div>${pending.length?pending.slice(0,20).map(j=>`<div class="listrow"><div><strong>${esc(customerBy(j.customer_id)?.name)}</strong><div class="muted small">${esc(j.service_date)} · ${jobProgress(j.id).n} objekt</div></div><button class="action secondary" data-job="${esc(j.id)}">Fortsätt</button></div>`).join(''):'<p class="muted">Inga pågående serviceuppdrag.</p>'}</div><div class="card"><h2>Kommande påminnelser – 30 dagar</h2>${upcoming.length?upcoming.slice(0,30).map(e=>`<div class="listrow"><div><strong>${esc(customerBy(e.customer_id)?.name)} – ${esc(e.number)}</strong><div class="muted small">Nästa service ${esc(e.next_service_on)}</div></div><button class="action secondary" data-start-upcoming="${esc(e.id)}">Öppna service</button></div>`).join(''):'<p class="muted">Inga objekt att påminna om de närmaste 30 dagarna.</p>'}</div>`;
}
function renderCustomers(){let list=table('customers');if(sys.filter)list=list.filter(c=>(c.name+' '+c.address).toLowerCase().includes(sys.filter.toLowerCase()));
 return `<div class="toolbar"><input class="search" id="filter" placeholder="Sök kund eller adress" value="${esc(sys.filter)}" aria-label="Sök kund"><button class="action" data-action="new-customer">+ Ny kund</button></div><div class="card">${list.length?list.sort((a,b)=>a.name.localeCompare(b.name,'sv')).map(c=>`<div class="listrow"><div><strong>${esc(c.name)}</strong><div class="small muted">${esc(c.customer_type)} · ${esc(c.address)} · ${equipmentFor(c.id).length} objekt</div><div class="small muted">${esc(c.email)}</div></div><button class="action secondary" data-customer="${esc(c.id)}">Öppna</button></div>`).join(''):'<p>Ingen kund hittades.</p>'}</div>${sys.selectedCustomer&&sys.customerDetailOpen?renderCustomerDetail():''}`;
}
function renderCustomerDetail(){const c=customerBy(sys.selectedCustomer);if(!c)return'';
 return `<div class="card"><div class="toolbar"><h2>${esc(c.name)}</h2><div class="right"><button class="action secondary" data-action="edit-customer">Redigera</button><button class="action" data-action="new-equipment">+ Objekt</button><button class="action yellow" data-action="create-job">Starta service</button></div></div><p class="small muted">${esc(c.address)} · Kontakt: ${esc(c.contact)} · ${esc(c.phone)} · ${esc(c.email)}</p><h3>Registrerade objekt</h3>${equipmentFor(c.id).map(e=>`<div class="listrow"><div><strong>${esc(e.number)}</strong><div class="small muted">${esc(templateTitle(e.template_id))} ${e.manufacturer? '· '+esc(e.manufacturer):''} ${e.model?' '+esc(e.model):''} ${e.controller?'· Styrning '+esc(e.controller):''} · ${e.interval_months?e.interval_months+' mån':'Intervall ej valt'}${e.next_service_month?' · Nästa service '+esc(e.next_service_month):''}${e.order_number?' · Order '+esc(e.order_number):''}${e.inspection_registration_no?' · Bes.nr '+esc(e.inspection_registration_no):''}</div></div><div class="toolbar"><button class="action secondary" data-edit-equipment="${esc(e.id)}">Redigera</button><button class="action secondary" data-replace-equipment="${esc(e.id)}">Byt ut</button><button class="action secondary" data-retire-equipment="${esc(e.id)}">Ta ur drift</button></div></div>`).join('')||'<p>Inga objekt ännu.</p>'}<div style="margin-top:24px;padding-top:16px;border-top:1px solid #d7e0e7"><strong>Kundadministration</strong><p class="small muted">Permanent radering av kunden och hela dess servicehistorik.</p><button type="button" class="action secondary" style="color:#a52b2b;border-color:#c87979" data-action="delete-customer">Ta bort kund</button></div><div style="margin-top:16px"><h3>Importerad servicehistorik</h3><p class="small muted">Tidigare FU-service, separat från nya kontrollsvar.</p>${table('legacy_service_imports').filter(h=>h.customer_id===c.id).length?'<p class="small">Juli 2026 · Patrik · '+table('legacy_service_imports').filter(h=>h.customer_id===c.id).length+' objekt registrerade</p>':''}${table('legacy_service_issues').filter(i=>i.customer_id===c.id).length?'<p class="small">Tidigare anmärkningar: '+table('legacy_service_issues').filter(i=>i.customer_id===c.id).length+' objekt, status behöver kontrolleras vid nästa service.</p>':''}</div></div>`;
}
function renderEquipments(){let xs=table('equipment').filter(e=>e.active!==false);if(sys.filter)xs=xs.filter(e=>(e.number+' '+customerBy(e.customer_id)?.name+' '+e.manufacturer).toLowerCase().includes(sys.filter.toLowerCase()));return `<div class="toolbar"><input class="search" id="filter" placeholder="Sök portnummer, kund, fabrikat" value="${esc(sys.filter)}"><button class="action" data-action="new-equipment">+ Nytt objekt</button></div><div class="card">${xs.slice(0,300).map(e=>`<div class="listrow"><div><strong>${esc(e.number)}</strong> <span class="badge">${esc(templateTitle(e.template_id))}</span><div class="small muted">${esc(customerBy(e.customer_id)?.name)} · nästa ${esc(e.next_service_on||'Ej planerad')}</div></div><button class="action secondary" data-edit-equipment="${esc(e.id)}">Ändra</button></div>`).join('')||'<p>Inga serviceobjekt registrerade ännu.</p>'}</div>`;}
function renderJobs(){return `<div class="toolbar"><div class="muted small">Ett uppdrag kan fortsätta flera dagar.</div><button class="action" data-action="new-job">+ Nytt serviceuppdrag</button></div><div class="card">${jobsFor().map(j=>`<div class="listrow"><div><strong>${esc(customerBy(j.customer_id)?.name)}</strong><div class="muted small">${esc(j.service_date)} · ${jobProgress(j.id).n} objekt</div></div><div class="right"><span class="badge ${j.status==='completed'?'good':'warn'}">${j.status==='completed'?'Avslutad':'Pågår'}</span><button class="action secondary" data-job="${esc(j.id)}">Öppna</button></div></div>`).join('')||'<p>Inga uppdrag finns ännu.</p>'}</div>`;}
function intervalPanel(job){if(job.status!=='draft')return '';const es=jesFor(job.id).map(x=>equipBy(x.equipment_id)).filter(Boolean);return `<div class="card"><h2>Serviceintervall</h2><p class="small muted">Välj ett intervall för alla portar eller ändra en port separat.</p><div class="toolbar">${[3,6,12].map(n=>`<button class="action secondary" data-interval-all="${n}">${n} månader – alla</button>`).join('')}</div>${es.map(e=>`<div class="listrow"><strong>${esc(e.number)}</strong><select style="max-width:165px" data-interval-object="${esc(e.id)}">${optionList([['','Välj intervall'],['3','3 månader'],['6','6 månader'],['12','12 månader']],String(e.interval_months||''))}</select></div>`).join('')}</div>`;}
function renderChecklist(){const job=jobBy(sys.selectedJob);if(!job)return `<div class="card"><p>Välj först ett serviceuppdrag.</p><button class="action" data-nav="jobs">Visa serviceuppdrag</button></div>`;
 const customer=customerBy(job.customer_id),jes=jesFor(job.id),p=jobProgress(job.id);if(!sys.selectedJE||!jes.some(x=>x.id===sys.selectedJE))sys.selectedJE=jes[0]?.id;
 const je=jeBy(sys.selectedJE),eq=equipBy(je?.equipment_id);
 return `<div class="card"><div class="toolbar"><div><h2>${esc(customer?.name)}</h2>${['BRF','Samfällighet'].includes(customer?.customer_type)?'<p class="small muted">Förenklad service – kontrollera varje port separat och dokumentera brister.</p>':''}<div class="muted small">${esc(job.service_date)} · ${esc(job.status==='completed'?'Avslutad service':'Pågående service')}</div></div><button class="action secondary" data-nav="jobs">Alla uppdrag</button></div><div class="row small"><span>${p.done} / ${p.total} kontrollpunkter</span><span>${p.brists} registrerade brister</span></div><div class="progress" style="margin:9px 0 15px"><div style="width:${p.total?100*p.done/p.total:0}%"></div></div><div class="field"><label for="equips">Välj serviceobjekt (${jes.length} st)</label><select id="equips">${jes.map((j,i)=>{const e=equipBy(j.equipment_id);return`<option value="${esc(j.id)}" ${j.id===sys.selectedJE?'selected':''}>${esc(e?.number||'Okänt objekt')} – ${esc(labelStatus(j.id))}</option>`}).join('')}</select></div>${job.status==='completed'?'<p class="small muted">Arkiverat serviceuppdrag – endast läsning. Kontrollsvaren nedan är sparade från servicedatumet.</p>':''}${eq?renderIndividual(je,eq,job):'<p>Inga objekt kopplade.</p>'}</div>${intervalPanel(job)}${job.status==='draft'?`<div class="card"><div class="toolbar"><div><h2>Färdigställ kundens service</h2><p class="small muted">Alla obligatoriska kontroller och bristbeskrivningar måste vara klara.</p></div><button class="action secondary" data-action="cancel-draft">Avbryt / börja om</button><button class="action yellow" data-action="finalize">Avsluta service</button></div></div>`:`<div class="card"><h2>Service avslutad</h2><div class="toolbar"><button class="action" data-action="pdf">Hämta gemensamt PDF-protokoll</button>${live&&sys.mailReady&&job.email_status!=='sent'?'<button class="action yellow" data-action="resend">Skicka protokoll</button>':''}</div><p class="small muted">E-post: ${esc(job.email_status==='sent'?'Skickat till kund och Garageportexperten':job.email_status==='failed'?'Utskick misslyckades':'Ännu inte skickat')}</p></div>`}`;
}
function renderIndividual(je,e,job){const pts=itemsFor(e);const cats=[...new Set(pts.map(x=>x.group))];const done=pts.filter(p=>{const a=ansFor(je.id,p.id);return a&&(a.answer!=='Brist'||a.description.trim())}).length;
 const open=job.status==='draft'?issuesFor(e.id):[],legacy=job.status==='draft'?table('legacy_service_issues').filter(i=>i.equipment_id===e.id&&i.state!=='resolved'):[],legacyHtml=legacy.length?'<div class="warning"><strong>Tidigare brister från juli 2026</strong>'+legacy.map(i=>'<div class="listrow" style="align-items:flex-start;gap:12px"><div><div class="small">'+esc(i.description)+'</div><div class="small muted">Status: '+(i.state==='remaining'?'Kvitterad – kvarstående':'Ej verifierad')+(i.review_comment?' · '+esc(i.review_comment):'')+'</div></div><div class="toolbar"><button class="action secondary" data-legacy-review="'+esc(i.id)+'" data-legacy-state="resolved">Åtgärdad</button><button class="action secondary" data-legacy-review="'+esc(i.id)+'" data-legacy-state="remaining">Kvarstående</button></div></div>').join('')+'</div>':'',openHtml=open.length?`<div class="warning"><strong><span aria-hidden="true">⚠️ </span>Kontrollera tidigare brister (${open.length})</strong><p class="small">Välj Åtgärdad eller Kvarstående för varje tidigare brist. Kvarstående brister följer med till nästa service.</p>${open.map(i=>{const check=first(table('issue_service_checks'),x=>x.issue_id===i.id&&x.job_id===job.id);return `<div class="listrow" style="align-items:flex-start"><div><div class="small">${esc(i.description)}</div>${check?.decision==='kvarstar'?`<div class="small" style="color:#805b00;font-weight:700">✓ Kontrollerad – kvarstående${check.comment?' · '+esc(check.comment):''}</div>`:''}</div>${job.status==='draft'?`<div class="toolbar"><button class="action secondary" data-resolve="${esc(i.id)}">Åtgärdad</button><button class="action secondary" data-persist-issue="${esc(i.id)}" data-check-job="${esc(job.id)}">${check?.decision==='kvarstar'?'✓ Kvarstående':'Kvarstående'}</button></div>`:''}</div>`}).join('')}</div>`:'';
 return `<div class="row" style="margin:10px 0 13px"><div><strong>${esc(e.number)}</strong><div class="small muted">${esc(templateTitle(e.template_id))} · ${esc(e.manufacturer||'')} ${esc(e.model||'')} ${e.controller?'· Styrning '+esc(e.controller):''}</div></div><span class="badge ${done===pts.length?'good':'warn'}">${done} / ${pts.length} klara</span></div>${job.status==='draft'&&['BRF','Samfällighet'].includes(customerBy(e.customer_id)?.customer_type)?`<div class="toolbar" style="margin:12px 0"><button class="action yellow" data-approve-port="${esc(je.id)}" ${pts.every(p=>ansFor(je.id,p.id))?'disabled':''}>✓ Godkänn hela porten (${pts.filter(p=>!ansFor(je.id,p.id)).length} kvar)</button></div>`:''}${legacyHtml}${openHtml}${cats.map((cat,idx)=>renderGroup(je,e,job,cat,idx,pts.filter(p=>p.group===cat))).join('')}<div class="toolbar"><button class="action secondary" data-action="prev-equipment">← Föregående</button><button class="action" data-action="next-equipment">Nästa objekt →</button></div>`;
}
function renderGroup(je,e,job,cat,idx,pts){const key=je.id+'|'+cat;const expanded=sys.groupOpen[key]??(idx===0);const completed=pts.filter(p=>{const a=ansFor(je.id,p.id);return a&&(a.answer!=='Brist'||a.description.trim())}).length;
 const simplified=['BRF','Samfällighet'].includes(customerBy(e.customer_id)?.customer_type);const bulk=pts.filter(p=>(simplified||p.bulk&&!p.individual)&&!ansFor(je.id,p.id));const hasBrist=pts.some(p=>ansFor(je.id,p.id)?.answer==='Brist');
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
function isDockTemplate(templateId){return /lastbrygga|GE-LBH|GE-LBM/i.test(String(templateId||'')+' '+templateTitle(templateId||''));}
function catalogDatalist(category,manufacturer='',templateId=''){
 const dock=isDockTemplate(templateId);
 const rows=table('equipment_catalog').filter(r=>r.category===category&&(!manufacturer||r.manufacturer===manufacturer)&&(category!=='model'||(dock?r.equipment_type==='lastbrygga':r.equipment_type!=='lastbrygga')));
 return [...new Set(rows.map(r=>r.name))].sort((a,b)=>a.localeCompare(b,'sv')).map(v=>'<option value="'+esc(v)+'"></option>').join('');
}
function catalogManufacturers(templateId=''){const dock=isDockTemplate(templateId);return [...new Set(table('equipment_catalog').filter(r=>r.category==='model'&&(dock?r.equipment_type==='lastbrygga':r.equipment_type!=='lastbrygga')).map(r=>r.manufacturer))].sort((a,b)=>a.localeCompare(b,'sv'));}
function refreshCatalogInputs(){
 const form=document.getElementById('equipmentform');if(!form)return;
 const brand=form.elements.manufacturer?.value.trim();
 const templateId=form.elements.template_id?.value;
 const brands=form.querySelector('#catalog-brand-options');
 if(brands)brands.innerHTML=catalogManufacturers(templateId).map(v=>'<option value="'+esc(v)+'"></option>').join('');
 const models=form.querySelector('#catalog-model-options');
 const controllers=form.querySelector('#catalog-controller-options');
 const motors=form.querySelector('#catalog-motor-options');
 if(models)models.innerHTML=catalogDatalist('model',brand,templateId);
 if(controllers)controllers.innerHTML=catalogDatalist('controller');
 if(motors)motors.innerHTML=catalogDatalist('motor');
}
function equipmentForm(e){let cid=e?.customer_id||sys.selectedCustomer||table('customers')[0]?.id;return `<h2>${e?'Ändra':'Lägg till'} serviceobjekt</h2><form id="equipmentform"><input type="hidden" name="replaces_id" value=""><input type="hidden" name="id" value="${esc(e?.id||'')}"><div class="field"><label>Kund *</label><select name="customer_id" required>${optionList(table('customers').map(c=>[c.id,c.name]),cid)}</select></div><div class="field"><label>Portnummer / objektnummer *</label><input name="number" required value="${esc(e?.number||'')}"></div><div class="field"><label>Porttyp / servicemall</label><select name="template_id" id="obj-template">${serviceTemplateOptions(e?.template_id||( ['BRF','Samfällighet'].includes(customerBy(cid)?.customer_type)?'GE-VILLA-TAK-MOTOR':undefined))}</select></div><div class="field"><label>Brandportsutförande (om brandport)</label><select name="subtype">${optionList([['','Ej brandport / välj senare'],['Skjutbrandport','Skjutbrandport'],['Vikbrandport','Vikbrandport'],['Brandjalusi','Brandjalusi']],e?.subtype||'')}</select></div><div class="fieldgroup"><div class="field"><label>Fabrikat</label><input name="manufacturer" list="catalog-brand-options" autocomplete="off" value="${esc(e?.manufacturer||'')}" placeholder="Sök eller skriv fabrikat"><datalist id="catalog-brand-options">${catalogManufacturers(e?.template_id||'').map(v=>`<option value="${esc(v)}"></option>`).join('')}</datalist></div><div class="field"><label>Portmodell</label><input name="model" list="catalog-model-options" autocomplete="off" value="${esc(e?.model||'')}" placeholder="Sök modell"><datalist id="catalog-model-options">${catalogDatalist('model',e?.manufacturer||'',e?.template_id||'')}</datalist></div></div><div class="fieldgroup"><div class="field"><label>Motor (valfritt)</label><input name="motor" list="catalog-motor-options" value="${esc(e?.motor||'')}" placeholder="Sök motor"><datalist id="catalog-motor-options">${catalogDatalist('motor')}</datalist></div><div class="field"><label>Styrning</label><input name="controller" list="catalog-controller-options" value="${esc(e?.controller||'')}" placeholder="Sök styrning"><datalist id="catalog-controller-options">${catalogDatalist('controller')}</datalist></div></div><p class="small muted">Förslagen är ett sökregister – bekräfta alltid faktisk modell och kompatibilitet på märkplåten. Egna uppgifter kan skrivas direkt.</p><div class="field"><label>Serienummer</label><input name="serial_no" value="${esc(e?.serial_no||'')}"></div><div class="fieldgroup"><div class="field"><label>Serviceintervall</label><select name="interval_months">${optionList([['','Välj intervall'],[3,'3 månader'],[6,'6 månader'],[12,'12 månader']].map(([a,b])=>[String(a),b]),String(e?.interval_months||customerBy(cid)?.service_interval_months||''))}</select></div><div class="field"><label>Nästa service</label><input type="date" name="next_service_on" value="${esc(e?.next_service_on||'')}"></div></div><div class="toolbar"><button type="button" class="action secondary" data-action="close-modal">Avbryt</button><button type="button" class="action" data-save-equipment="yes">Spara objekt</button></div></form>`;}
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
async function approveWholePort(jeid){const je=jeBy(jeid),e=equipBy(je?.equipment_id),job=jobBy(je?.job_id);if(!je||!e||!job||job.status!=='draft')return;const c=customerBy(e.customer_id);if(!['BRF','Samfällighet'].includes(c?.customer_type))return;const ps=itemsFor(e);if(ps.some(p=>ansFor(jeid,p.id)?.answer==='Brist')){notify('Porten har registrerade brister. Godkänn endast återstående punkter individuellt.',true);return;}const remaining=ps.filter(p=>!ansFor(jeid,p.id));if(!remaining.length){notify('Alla kontrollpunkter är redan besvarade.');return;}if(!confirm('Bekräftar du att alla '+remaining.length+' återstående kontrollpunkter på '+e.number+' har kontrollerats, är tillämpliga och godkända? Befintliga svar ändras inte.'))return;for(const p of remaining)await saveAnswer(jeid,p.id,'OK');render();}
async function onBulk(key){const [jeid,cat]=key.split('|'),e=equipBy(jeBy(jeid)?.equipment_id);
 const ps=itemsFor(e).filter(p=>p.group===cat);if(ps.some(p=>ansFor(jeid,p.id)?.answer==='Brist')){notify('Kategorin innehåller brister. Kontrollera punkterna individuellt.',true);return;}
 const simplified=['BRF','Samfällighet'].includes(customerBy(e.customer_id)?.customer_type);const allow=ps.filter(p=>(simplified||p.bulk&&!p.individual)&&!ansFor(jeid,p.id));
 if(!allow.length){notify('Inga återstående punkter att godkänna. Befintliga svar, inklusive Ej aktuellt, är bevarade.');return;}
 if(!confirm(`Har du kontrollerat de ${allow.length} återstående punkterna i ”${cat}” och är samtliga tillämpliga och utan brist? Markera eventuella Ej aktuellt individuellt först. Redan registrerade svar bevaras.`))return;
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
 // Use the compact A4 industrial report only for industrial equipment templates.
 const industrial=p.details.length>0&&p.details.every(d=>!String(d.e.template_id||'').startsWith('GE-VILLA-'));
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
 const technician=first(table('profiles'),x=>x.user_id===p.job.finished_by)?.display_name||sys.profile.display_name;
 if(['BRF','Samfällighet'].includes(p.customer.customer_type)||p.details.some(d=>String(d.e.template_id||'').startsWith('GE-VILLA-'))){
  const lineColor=rgb(.81,.86,.89),pale=rgb(.94,.97,.98),green=rgb(.08,.48,.27),red=rgb(.73,.19,.13);
  const isAssociation=['BRF','Samfällighet'].includes(p.customer.customer_type);
  const logoBinary=Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAANQAAAAxAgMAAADfOW+6AAAADFBMVEUAAAAAWZUAWZUAWpTK29hPAAAABHRSTlMA+pobCgs74AAAA/xJREFUeNq9lk9oHFUcxz/zZja7TSbJEhKMNuhCe2jdCCPm0EMqTyrowcNAs/EfBfFopSziUWSK0qMGEZpD0FiClZ1EViykB5UHVfAQZApp9SC4hxTEBFzZ2ZqwOzsedieZSWYVevB3mXnvzef9+f2+v98bbWSJA7vrgD729Bq/T+rX9y4gvrT1j37++A818MryFU/MvSErexcedzpGw41RLWBIhrBG4AJPLdBRIUW5fdwteCdCR7hQdEORi0GYQGN7C5SidUNCgZlX30Z365r7HH+uTzF0o3zx3E0Rh/ABQ/2Ibkj4e4rbbTz7DOB1+JB3/FlqezXp+KLNIbOAIOcAMzwKj0X9o2qDWdBMQFhxItqu2FEAfD1zMObpPkAAYHiFGBUtHJ4MFcBZqJNiIg6hR17RPEDx/q3kzqNPRGKuAECv4I8UYMTk5lmgoto68JkEYNAAhEqsDBC4Mvdem8Gr47o5BpqLdh4hLgPwyGI++m7fQgB9ifa30KragfEbiGXCNcLzE10dfGUDQiYwBQR5LDlL67YUNUsR5DECNHcOgKHvJCCcNB95pW9gVIUThWjSDt232l8cOVdviAI6bCoTnDQRYNxJ9HelLF88PQ5G3S9e3s7vJKkNxwHj7vzh2dQzBIzt4Hs5Z9jaigJFYCLBTA07GTJMksHGzihNZlSGSTgJLLIopHiNyUOeR0H7hZo6g6XQsaRWsBqj0Wlmf/oetDZglA5T2rG3Vl/Gk3bw/CU69V+uPftFUGptAk/a2xD4R6IM0PEmWCG4ZXEqg169L09xp2Q9BBzTHK3MAptoybWKqeE7qnkexP5PyjjSM7iMmK/MmZ+WKlzxBpcRry91Js9dB/FBmfuXPpkT7x6lii561iVYHXY54RVdWg2XVuhCdtsl21pF/zV9h0bItBZpOwcMJHMwldpthqpuRPm2C4Sd/6KyblXDqW8h1qmTdauE65RddXyFIXeFUKVSPgRKlxb4Th0fwHc88A5U18fz6mEWDqoZ2EmtHqobkaCsoPvcT6ZY2cyDcTF9sbZ4AG3k0AAK+V67WksIQ4QJU0BmXtHEAPRyjcy8Al11T9h8qasmI1k2ir2IaGxB+Pmq9QMhiGvV4n5J39PV1dQd9jwUrvZ8F1Y5cJqGTD+XImCKeGUekBFCIMtpVMuVDHeje7rbgmZ3aKgCSK+fD9tkQbhOtNV4atj5ftS0ESb+DXQSUe5D1TNh/AJoxufY6E/dS9wLWnwOsx+lyydU8uaNNRv9qIAFNZWIRT1x5adQmZI9rGH5+y1AdZOrWXoTApW+ltHWIBsvY3Yk461/0fy0Ri7h+rzZO1kOqKdQBhiM06Cp9Vpmmw1Akgdj18TI/wOTg2f8seORrQAAAABJRU5ErkJggg=='),c=>c.charCodeAt(0));
  const logo=await doc.embedPng(logoBinary);
  page.drawImage(logo,{x:pg.left,y:pg.h-132,width:243,height:243*49/212});
  const bx=310,bw=243,boxTop=pg.h-68,boxBottom=pg.h-151;
  page.drawText('PROTOKOLL',{x:bx,y:pg.h-46,size:16,font:bold,color:navy});
  page.drawRectangle({x:bx,y:boxBottom,width:bw,height:boxTop-boxBottom,borderWidth:.8,borderColor:lineColor});
  page.drawText('KUND',{x:bx+12,y:boxTop-15,font:bold,size:7,color:blue});
  textBlock(p.customer.name,bx+12,boxTop-28,bw-24,bold,10,navy,12);
  page.drawText('ADRESS',{x:bx+12,y:boxTop-49,font:bold,size:7,color:blue});
  textBlock(p.customer.address||'-',bx+12,boxTop-62,bw-24,regular,8,navy,10);
  y=pg.h-170;
  add('SERVICEPROTOKOLL',{bold:true,size:14,after:7});
  add('Montör: '+technician+'                         Datum: '+p.job.service_date,{size:9,after:4});
  const statusOf=d=>{
   const ans=d.points.map(q=>first(d.answers,a=>a.item_id===q.id));
   return ans.some(a=>a?.answer==='Brist')?'BRIST':ans.some(a=>!a?.answer)?'EJ KLAR':'OK';
  };
  const approved=p.details.filter(d=>statusOf(d)==='OK').length;
  const failed=p.details.filter(d=>statusOf(d)==='BRIST').length;
  add('Antal portar: '+p.all+'       Utan brister: '+approved+'       Med brister: '+failed,{size:9,after:10});
  page.drawLine({start:{x:pg.left,y},end:{x:pg.w-pg.right,y},color:lineColor,thickness:.8});y-=19;
  add('PORTAR UTAN ANMÄRKNING ('+approved+')',{bold:true,size:10,after:14});
  add('PORTAR MED BRISTER ('+failed+')',{bold:true,size:10,after:12});
  page.drawLine({start:{x:pg.left,y},end:{x:pg.w-pg.right,y},color:lineColor,thickness:.8});y-=20;
  add('SAMMANFATTNING',{bold:true,size:12,after:7});
  // A compact one-row-per-door summary, using the actual recorded inspection results.
  const allGroups=[...new Set(p.details.flatMap(d=>protocolCategories(d).map(g=>g.name)))];
  const columns=allGroups.length<=5?allGroups:[];
  const innerWidth=pg.w-pg.left-pg.right;
  const leftWidth=99,kindWidth=112,resultWidth=66;
  const categoryWidth=columns.length?(innerWidth-leftWidth-kindWidth-resultWidth)/columns.length:0;
  const headerH=23,rowH=21;
  const cells=[{name:'PORT',width:leftWidth},{name:'PORTTYP',width:kindWidth},...columns.map(name=>({name,width:categoryWidth})),{name:'RESULTAT',width:resultWidth}];
  const truncate=(value,width,font,size)=>{let str=safe(value);while(str&&font.widthOfTextAtSize(str,size)>width-8)str=str.slice(0,-1);return str};
  const tableHeader=()=>{if(y<pg.bottom+155)newPage();let x=pg.left;page.drawRectangle({x,y:y-headerH,width:innerWidth,height:headerH,color:blue});for(const cell of cells){page.drawText(truncate(cell.name,cell.width,bold,7.3),{x:x+5,y:y-15,font:bold,size:7.3,color:rgb(1,1,1)});x+=cell.width;}y-=headerH;};
  tableHeader();
  for(const [idx,d] of p.details.entries()){
   if(y-rowH<pg.bottom+122){newPage();tableHeader();}
   if(idx%2===0)page.drawRectangle({x:pg.left,y:y-rowH,width:innerWidth,height:rowH,color:pale});
   let x=pg.left;
   const status=statusOf(d);
   const title=templateTitle(d.e.template_id).replace(/ - .*/, '');
   const catMap=new Map(protocolCategories(d).map(g=>[g.name,g.status]));
   const values=[d.e.number,title,...columns.map(name=>catMap.get(name)||'-'),status];
   values.forEach((v,i)=>{const c=cells[i],size=i<2?8:7.4,font=i===0?bold:regular,color=v==='BRIST'?red:v==='OK'?green:navy;page.drawText(truncate(v,c.width,font,size),{x:x+5,y:y-14,font,size,color});x+=c.width;});
   y-=rowH;
   if(columns.length===0){
    const cats=protocolCategories(d).map(g=>g.name+': '+g.status).join('   |   ');
    add(cats,{size:7,leading:10,after:3});
   }
  }
  y-=18;page.drawLine({start:{x:pg.left,y},end:{x:pg.w-pg.right,y},color:lineColor,thickness:.8});y-=18;
  add('BRISTER OCH ANMÄRKNINGAR',{bold:true,size:11,after:8});
  const faults=p.details.flatMap(d=>d.answers.filter(a=>a.answer==='Brist').map(a=>({door:d.e.number,point:first(d.points,q=>q.id===a.item_id)?.label||'Kontrollpunkt',description:a.description||'Bristbeskrivning saknas'})));
  if(!faults.length)add('Inga registrerade brister.',{size:9,after:9});
  for(const fault of faults){if(y<pg.bottom+157)newPage();add(fault.door+' - '+fault.point,{bold:true,size:8.7,color:red,after:2});add(fault.description,{size:8.5,after:8});}
  y-=10;
 }else if(industrial){
  // Printable industrial A4 report: real customer, inspections, categories and faults.
  const lineColor=rgb(.81,.86,.89),pale=rgb(.94,.97,.98),green=rgb(.08,.48,.27),red=rgb(.73,.19,.13);
  const logoBinary=Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAANQAAAAxAgMAAADfOW+6AAAADFBMVEUAAAAAWZUAWZUAWpTK29hPAAAABHRSTlMA+pobCgs74AAAA/xJREFUeNq9lk9oHFUcxz/zZja7TSbJEhKMNuhCe2jdCCPm0EMqTyrowcNAs/EfBfFopSziUWSK0qMGEZpD0FiClZ1EViykB5UHVfAQZApp9SC4hxTEBFzZ2ZqwOzsedieZSWYVevB3mXnvzef9+f2+v98bbWSJA7vrgD729Bq/T+rX9y4gvrT1j37++A818MryFU/MvSErexcedzpGw41RLWBIhrBG4AJPLdBRIUW5fdwteCdCR7hQdEORi0GYQGN7C5SidUNCgZlX30Z365r7HH+uTzF0o3zx3E0Rh/ABQ/2Ibkj4e4rbbTz7DOB1+JB3/FlqezXp+KLNIbOAIOcAMzwKj0X9o2qDWdBMQFhxItqu2FEAfD1zMObpPkAAYHiFGBUtHJ4MFcBZqJNiIg6hR17RPEDx/q3kzqNPRGKuAECv4I8UYMTk5lmgoto68JkEYNAAhEqsDBC4Mvdem8Gr47o5BpqLdh4hLgPwyGI++m7fQgB9ifa30KragfEbiGXCNcLzE10dfGUDQiYwBQR5LDlL67YUNUsR5DECNHcOgKHvJCCcNB95pW9gVIUThWjSDt232l8cOVdviAI6bCoTnDQRYNxJ9HelLF88PQ5G3S9e3s7vJKkNxwHj7vzh2dQzBIzt4Hs5Z9jaigJFYCLBTA07GTJMksHGzihNZlSGSTgJLLIopHiNyUOeR0H7hZo6g6XQsaRWsBqj0Wlmf/oetDZglA5T2rG3Vl/Gk3bw/CU69V+uPftFUGptAk/a2xD4R6IM0PEmWCG4ZXEqg169L09xp2Q9BBzTHK3MAptoybWKqeE7qnkexP5PyjjSM7iMmK/MmZ+WKlzxBpcRry91Js9dB/FBmfuXPpkT7x6lii561iVYHXY54RVdWg2XVuhCdtsl21pF/zV9h0bItBZpOwcMJHMwldpthqpuRPm2C4Sd/6KyblXDqW8h1qmTdauE65RddXyFIXeFUKVSPgRKlxb4Th0fwHc88A5U18fz6mEWDqoZ2EmtHqobkaCsoPvcT6ZY2cyDcTF9sbZ4AG3k0AAK+V67WksIQ4QJU0BmXtHEAPRyjcy8Al11T9h8qasmI1k2ir2IaGxB+Pmq9QMhiGvV4n5J39PV1dQd9jwUrvZ8F1Y5cJqGTD+XImCKeGUekBFCIMtpVMuVDHeje7rbgmZ3aKgCSK+fD9tkQbhOtNV4atj5ftS0ESb+DXQSUe5D1TNh/AJoxufY6E/dS9wLWnwOsx+lyydU8uaNNRv9qIAFNZWIRT1x5adQmZI9rGH5+y1AdZOrWXoTApW+ltHWIBsvY3Yk461/0fy0Ri7h+rzZO1kOqKdQBhiM06Cp9Vpmmw1Akgdj18TI/wOTg2f8seORrQAAAABJRU5ErkJggg=='),c=>c.charCodeAt(0));
  const actualLogo=await doc.embedPng(logoBinary);
  // Preserve the exact proportions of the uploaded company logo (212 x 49).
  page.drawImage(actualLogo,{x:pg.left,y:pg.h-132,width:243,height:243*49/212});
  const bx=310,bw=243,top=pg.h-68,bottom=pg.h-151;
  page.drawText('PROTOKOLL',{x:bx,y:pg.h-46,size:16,font:bold,color:navy});
  page.drawRectangle({x:bx,y:bottom,width:bw,height:top-bottom,borderWidth:.8,borderColor:lineColor});
  const label=(name,value,x,yy,width)=>{
   page.drawText(name,{x,y:yy,size:7.5,font:bold,color:blue});
   const lines=wrap(value||'-',regular,9,width);
   lines.slice(0,2).forEach((line,k)=>page.drawText(line,{x,y:yy-13-k*11,size:9,font:regular,color:navy}));
  };
  label('KUND',safe(p.customer.name),bx+12,top-13,bw-24);
  label('ADRESS',safe(p.customer.address),bx+12,top-46,bw-24);
  page.drawText('Kontakt: '+safe(p.customer.contact||'-')+'   |   '+safe(p.job.service_date),{x:bx+12,y:bottom+10,font:regular,size:8,color:navy});
  y=bottom-35;
  add('SERVICEPROTOKOLL',{bold:true,size:14,after:8});
  page.drawText('Montör: '+safe(technician),{x:pg.left,y:y+4,font:regular,size:9,color:navy});
  const totals='Antal objekt: '+p.all+'   Utan brister: '+p.good.length+'   Med brister: '+p.bad.length;
  page.drawText(safe(totals),{x:299,y:y+4,font:regular,size:9,color:navy});
  y-=16;
  page.drawLine({start:{x:pg.left,y},end:{x:pg.w-pg.right,y},color:lineColor,thickness:.7});
  y-=16;
  add('OBJEKT UTAN ANMÄRKNING ('+p.good.length+')',{bold:true,size:10,after:4});
  y-=9; // Godkända objekt redovisas i sammanfattningen nedan.
  add('OBJEKT MED BRISTER ('+p.bad.length+')',{bold:true,size:10,after:4});
  if(!p.bad.length)add('Inga registrerade brister.',{size:9,after:9});
  for(const item of p.bad){
   add(item.e.number,{bold:true,size:9,after:2});
   for(const fault of item.failed){
    const point=first(items,x=>x.id===fault.item_id);
    add((point?.label||'Kontrollpunkt')+': '+(fault.description||'Beskrivning saknas'),{size:8.5,indent:8,after:3});
   }
  }
  y-=6;
  page.drawLine({start:{x:pg.left,y},end:{x:pg.w-pg.right,y},color:lineColor,thickness:.7});
  y-=21;
  add('SAMMANFATTNING',{bold:true,size:12,after:8});
  for(const d of p.details){
   const groups=protocolCategories(d);
   const failing=groups.some(g=>g.status==='Brist');
   const unresolved=groups.some(g=>g.status==='Ej kontrollerad');
   const state=failing?'BRISTER':unresolved?'EJ KLAR':'OK';
   const colW=(pg.w-pg.left-pg.right-20)/3;
   const pairs=[];for(let k=0;k<groups.length;k+=3)pairs.push(groups.slice(k,k+3));
   const lineRows=pairs.map(pair=>Math.max(...pair.map(g=>wrap(g.name+': '+g.status,regular,7.5,colW-14).length)));
   const contentHeight=lineRows.reduce((h,n)=>h+n*11+4,0);
   const equipmentLabel=[d.e.manufacturer,d.e.model,d.e.motor,d.e.controller].map(v=>String(v||'').trim()).filter((v,i,a)=>v&&a.indexOf(v)===i).join(' · ');
   const title=safe(d.e.number+' - '+templateTitle(d.e.template_id));
   const fullTitle=equipmentLabel?title+' · '+safe(equipmentLabel):title;
   const headerHeight=27,boxHeight=headerHeight+contentHeight+7;
   if(y-boxHeight<pg.bottom+119)newPage();
   const x=pg.left,w=pg.w-pg.left-pg.right;
   page.drawRectangle({x,y:y-headerHeight,width:w,height:headerHeight,color:pale,borderWidth:.6,borderColor:lineColor});
   const maxTitleWidth=w-(state==='BRISTER'?83:state==='EJ KLAR'?82:49)-18;
   let titleSize=9.2;
   while(titleSize>6.3&&bold.widthOfTextAtSize(fullTitle,titleSize)>maxTitleWidth)titleSize-=0.2;
   const truncateTitle=()=>{
    let t=fullTitle;
    while(t.length&&bold.widthOfTextAtSize(t,titleSize)>maxTitleWidth)t=t.slice(0,-1);
    return t.length<fullTitle.length?t.trimEnd()+'…':t;
   };
   page.drawText(truncateTitle(),{x:x+11,y:y-17,font:bold,size:titleSize,color:navy});
   page.drawText(state,{x:x+w-(state==='BRISTER'?61:state==='EJ KLAR'?58:27),y:y-17,font:bold,size:9,color:failing?red:unresolved?navy:green});
   let yy=y-headerHeight-16;
   pairs.forEach((pair,idx)=>{
    const h=lineRows[idx]*11+4;
    pair.forEach((g,j)=>{
     const xx=x+11+j*(colW+10),lines=wrap(g.name+': '+g.status,regular,7.5,colW-14);
     lines.forEach((line,k)=>page.drawText(line,{x:xx,y:yy-k*11,font:g.status==='Brist'?bold:regular,size:7.5,color:g.status==='Brist'?red:navy}));
    });
    yy-=h;
   });
   page.drawRectangle({x,y:y-boxHeight,width:w,height:boxHeight,borderWidth:.6,borderColor:lineColor});
   y-=boxHeight+13;
  }
 }else{
  const logoY=pg.h-69;
  for(let i=0;i<3;i++)page.drawRectangle({x:48,y:logoY-i*21,width:66,height:16,color:blue});
  page.drawText('GARAGEPORT',{x:124,y:logoY-4,size:17,font:regular,color:blue});
  page.drawText('EXPERTEN',{x:124,y:logoY-28,size:21,font:bold,color:blue});
  page.drawText('PROTOKOLL',{x:329,y:pg.h-48,size:16,font:bold,color:navy});
  const boxX=326,boxW=224,boxTop=pg.h-69,boxBottom=pg.h-338;
  page.drawRectangle({x:boxX,y:boxBottom,width:boxW,height:boxTop-boxBottom,borderWidth:1,borderColor:gray});
  let infoY=boxTop-19;
  for(const [name,value] of [['Kund',p.customer.name],['Adress',p.customer.address],['Kontaktperson',p.customer.contact],['Telefon',p.customer.phone],['E-post',p.customer.email],['Servicedatum',p.job.service_date],['Montör',technician]]){
   if(!value)continue;
   page.drawText(safe(name),{x:boxX+13,y:infoY,font:bold,size:8.5,color:navy});infoY-=13;
   for(const line of wrap(value,regular,9.1,boxW-28)){page.drawText(line,{x:boxX+13,y:infoY,font:regular,size:9.1,color:navy});infoY-=12}infoY-=5;
  }
  y=boxBottom-25;
  add('Antal objekt: '+p.all+'   Utan brister: '+p.good.length+'   Med brister: '+p.bad.length,{after:10});
  heading('OBJEKT UTAN ANMÄRKNING ('+p.good.length+')');
  y-=10;
  heading('OBJEKT MED BRISTER ('+p.bad.length+')');
  if(!p.bad.length)add('Inga registrerade brister.',{after:7});
  for(const item of p.bad){add(item.e.number,{bold:true,size:11,after:3});for(const fault of item.failed){const point=first(items,x=>x.id===fault.item_id);add((point?.label||'Kontrollpunkt')+' - Brist',{bold:true,size:10});add(fault.description||'Bristbeskrivning saknas',{indent:12,after:4})}}
  heading('KONTROLLRESULTAT PER KATEGORI');
  for(const d of p.details){if(y<pg.bottom+85)newPage();add([d.e.number+' - '+templateTitle(d.e.template_id),[d.e.manufacturer,d.e.model,d.e.motor,d.e.controller].filter(Boolean).join(' · ')].filter(Boolean).join(' | '),{bold:true,size:10});for(const group of protocolCategories(d))add(group.name+' : '+group.status,{size:9,leading:12});y-=10}
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
 textBlock('garageportexperten.se\nfinspang@garageportexperten.se\nGodkänd för F-skatt',414,fy,139,regular,7.6,navy,12);
 const bytes=await doc.save();const blob=new Blob([bytes],{type:'application/pdf'});
 // Downloading a historical protocol is read-only. No storage or database write.
 // Current production has no PDF storage bucket and protocol email is disabled.
 if(!send||!live||!sys.mailReady){
  const u=URL.createObjectURL(blob);
  const a=document.createElement('a');a.href=u;a.download='GPE_protokoll_ny_layout_'+p.job.service_date+'.pdf';
  document.body.append(a);a.click();a.remove();
  setTimeout(()=>URL.revokeObjectURL(u),30000);
  return;
 }
 const path=org()+'/'+jobId+'/serviceprotokoll-'+new Date().toISOString().replaceAll(':','-')+'-'+id()+'.pdf';
 const {error}=await client.storage.from('service-protocols').upload(path,blob,{contentType:'application/pdf',upsert:false});if(error)throw error;
 await updateRow('service_jobs',jobId,{pdf_path:path});
 const {error:mailError}=await client.functions.invoke('send-protocol',{body:{job_id:jobId}});
 if(mailError)throw new Error('PDF sparad men e-post gick inte iväg: '+mailError.message);
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
 if(a==='logout'){if(live){sys.signedIn=false;sys.user=null;sys.profile=null;await client.auth.signOut();renderLogin();}else notify('Demoläget saknar riktig inloggning.');return}
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
 if(a==='delete-customer'){
  const c=customerBy(sys.selectedCustomer);if(!c)return;
  const n=table('equipment').filter(e=>e.customer_id===c.id).length;
  const jobs=jobsFor(c.id).length;
  modal('<h2>Ta bort kund permanent</h2><p><strong>'+esc(c.name)+'</strong></p><p>Detta raderar kunden, samtliga '+n+' objekt, '+jobs+' serviceuppdrag, kontrollsvar och brister. Det går inte att ångra.</p><p class="small muted">Skriv RADERA för att bekräfta. Radering kräver att du är inloggad i montörskontot.</p><input type="text" id="delete-customer-confirmation" autocomplete="off" placeholder="Skriv RADERA" aria-label="Bekräfta permanent radering"><div class="toolbar" style="margin-top:18px"><button type="button" class="action secondary" data-action="close-modal">Avbryt</button><button type="button" class="action" style="background:#ae2727;color:white" data-action="confirm-delete-customer">Radera permanent</button></div>');
  return;
 }
 if(a==='confirm-delete-customer'){
  const c=customerBy(sys.selectedCustomer);if(!c)return;
  const confirmation=$('#delete-customer-confirmation')?.value.trim();
  if(confirmation!=='RADERA'){notify('Skriv RADERA exakt för att bekräfta.',true);return;}
  if(!live){notify('Permanent radering stöds bara mot den riktiga databasen.',true);return;}
  const btn=document.querySelector('[data-action="confirm-delete-customer"]');if(btn){btn.disabled=true;btn.textContent='Raderar…';}
  try{
   const {data,error}=await client.rpc('delete_customer_permanently',{p_customer_id:c.id,p_confirmation:confirmation});
   if(error)throw error;
   sys.selectedCustomer=null;sys.customerDetailOpen=false;sys.modal=null;sys.filter='';
   await refresh();notify('Kunden och tillhörande servicedata har raderats permanent.');
  }catch(err){notify('Radering misslyckades: '+(err.message||err),true);if(btn?.isConnected){btn.disabled=false;btn.textContent='Radera permanent';}}
  return;
 }

 if(a==='new-equipment'){if(!table('customers').length){notify('Lägg upp en kund först.',true);return}modal(equipmentForm(null));return}
 if(a==='new-job'){if(!table('customers').length){notify('Lägg upp en kund först.',true);return}modal(newJobForm());return}
 if(a==='create-job'){modal(newJobForm());return}
 if(a==='next-equipment'){changeJE(1);return}
 if(a==='prev-equipment'){changeJE(-1);return}
 if(a==='cancel-draft'){
  const j=jobBy(sys.selectedJob);
  if(!j||j.status!=='draft'){notify('Bara pågående service kan avbrytas.',true);return;}
  const answers=jesFor(j.id).reduce((sum,je)=>sum+answersFor(je.id).length,0);
  const customer=customerBy(j.customer_id);
  if(!confirm('Avbryt service för '+(customer?.name||'kunden')+'? '+answers+' kontrollsvar från DETTA testtillfälle raderas. Kundens objekt och äldre importerade brister behålls.'))return;
  try{
   if(!live){const ids=jesFor(j.id).map(x=>x.id);sys.tables.inspection_answers=sys.tables.inspection_answers.filter(x=>!ids.includes(x.job_equipment_id));sys.tables.issue_service_checks=sys.tables.issue_service_checks.filter(x=>x.job_id!==j.id);sys.tables.job_equipment=sys.tables.job_equipment.filter(x=>x.job_id!==j.id);sys.tables.service_jobs=sys.tables.service_jobs.filter(x=>x.id!==j.id);persist();}
   else{const {error}=await client.rpc('cancel_service_draft',{p_job_id:j.id});if(error)throw error;}
   sys.selectedJob=null;sys.selectedJE=null;sys.view='jobs';sys.banner='Serviceutkast avbrutet. Du kan starta om med samma portar.';sys.alertClass='success';await refresh();notify('Serviceutkast borttaget – kunden och historiken är kvar.');
  }catch(e){notify('Kunde inte avbryta service: '+e.message,true)}
  return;
 }
 if(a==='finalize'){await doFinalize();return}
 if(a==='pdf'){try{await generateProtocol(sys.selectedJob,false)}catch(e){notify(e.message,true)}return}
 if(a==='resend'){try{const {error}=await client.functions.invoke('send-protocol',{body:{job_id:sys.selectedJob}});if(error)throw error;await refresh();notify('Serviceprotokollet har skickats.')}catch(e){notify(e.message,true)}return}
}
async function handleSubmit(ev){const form=ev.target;if(!['loginform','customerform','equipmentform','jobform'].includes(form.id))return;ev.preventDefault();if(form.dataset.saving==='1')return;form.dataset.saving='1';const status=document.createElement('p');status.className='small muted save-status';status.textContent='Sparar, vänta…';form.append(status);const f=new FormData(form);const v=key=>String(f.get(key)||'').trim();
 try{
  if(form.id==='loginform'){const {error}=await client.auth.signInWithPassword({email:sharedLogin?'martin.olsson@garageportexperten.se':v('email'),password:v('password')});if(error)throw error;return;}
  if(form.id==='customerform'){
   if(![3,6,12].includes(Number(v('service_interval_months'))))throw Error('Välj 3, 6 eller 12 månaders serviceintervall för kunden.');
   const rec={customer_type:v('customer_type'),name:v('name'),address:v('address'),contact:v('contact'),phone:v('phone'),email:v('email'),service_interval_months:Number(v('service_interval_months'))};
   if(v('id')){await updateRow('customers',v('id'),rec);for(const e of equipmentFor(v('id')))await updateRow('equipment',e.id,{interval_months:rec.service_interval_months});}else{
    let added;
    if(live){
     const chosenId=form.dataset.newCustomerId||(form.dataset.newCustomerId=id());
     const controller=new AbortController();
     const timer=setTimeout(()=>controller.abort(),12000);
     try {
      const endpoint=config.SUPABASE_URL.replace(/\/$/,'')+'/rest/v1/customers?on_conflict=id';
      const response=await fetch(endpoint,{
       method:'POST',
       mode:'cors',
       cache:'no-store',
       signal:controller.signal,
       headers:{
        'apikey':config.SUPABASE_ANON_KEY,
        'Authorization':'Bearer '+(sharedLogin?(await client.auth.getSession()).data.session?.access_token:config.SUPABASE_ANON_KEY),
        'Content-Type':'application/json',
        'Prefer':'resolution=merge-duplicates,return=representation'
       },
       body:JSON.stringify([{id:chosenId,org_id:org(),...rec}])
      });
      const responseText=await response.text();
      if(!response.ok)throw Error('Databasfel '+response.status+': '+responseText.slice(0,350));
      added=JSON.parse(responseText);
     }catch(error){
      if(error.name==='AbortError')throw Error('Kundsparningen fick inget svar inom 12 sekunder. Försök igen.');
      throw error;
     }finally{clearTimeout(timer);}
    }else{added=await insertRows('customers',[{org_id:org(),...rec}]);}
    if(!added?.[0]?.id)throw Error('Databasen bekräftade inte att kunden skapades.');
    sys.selectedCustomer=added[0].id;
   }
   sys.view='customers';sys.customerDetailOpen=true;sys.filter='';
   const feedback=form.querySelector('.save-feedback');if(feedback)feedback.textContent='Kunden sparad i databasen. Läser in kundlistan…';
   await Promise.race([refresh(),new Promise((_,reject)=>setTimeout(()=>reject(Error('Kunden sparades men kundlistan kunde inte laddas inom 12 sekunder.')),12000))]);
   if(!customerBy(sys.selectedCustomer))throw Error('Kunden gick inte att hitta efter sparning.');
   sys.modal=null;sys.banner='Kunden har sparats: '+rec.name;sys.alertClass='success';render();return;
  }
  if(form.id==='equipmentform'){
   const rec={customer_id:v('customer_id'),number:v('number'),template_id:v('template_id'),subtype:v('subtype'),manufacturer:v('manufacturer'),model:v('model'),motor:v('motor'),controller:v('controller'),serial_no:v('serial_no'),interval_months:v('interval_months')?Number(v('interval_months')):(customerBy(v('customer_id'))?.service_interval_months||null),next_service_on:v('next_service_on')||null};
   if(rec.template_id==='GE-BRANDPORT-01'&&!rec.subtype)throw Error('Välj brandportstyp innan du sparar');
   if(v('id'))await updateRow('equipment',v('id'),rec);else await insertRows('equipment',[{org_id:org(),...rec}]);
   if(live&&!publicTest){
    const existing=table('equipment_catalog');
    const entries=[['model',rec.manufacturer,rec.model],['motor',rec.manufacturer,rec.motor],['controller',rec.manufacturer,rec.controller]];
    for(const [category,manufacturer,name] of entries){
     if(!manufacturer||!name||existing.some(x=>x.category===category&&x.manufacturer.toLowerCase()===manufacturer.toLowerCase()&&x.name.toLowerCase()===name.toLowerCase()))continue;
     const {error}=await client.from('equipment_catalog').upsert({category,manufacturer,name},{onConflict:'category,manufacturer,name'});
     if(error)console.warn('Kunde inte lägga till i förslagsregistret',error.message);
    }
   }
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
  const feedback=form.querySelector('.save-feedback');if(feedback)feedback.textContent=msg;
  sys.banner=msg;sys.alertClass='error';
  area.scrollIntoView({behavior:'smooth',block:'nearest'});
 }finally{form.dataset.saving='0';status.remove();}
}
// Event delegation works with all views and Safari touch interactions.
document.addEventListener('click',async ev=>{
 const el=ev.target.closest('[data-legacy-review],[data-interval-all],[data-action],[data-nav],[data-customer],[data-job],[data-edit-equipment],[data-replace-equipment],[data-retire-equipment],[data-start-upcoming],[data-resolve],[data-persist-issue],[data-toggle-group],[data-bulk],[data-answer]');if(!el)return;
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
  if(el.dataset.job){sys.selectedJob=el.dataset.job;sys.selectedJE=null;sys.groupOpen={};sys.banner='';sys.alertClass='';sys.view='checklist';render();return;}
  if(el.dataset.startUpcoming){
   const eq=equipBy(el.dataset.startUpcoming);
   if(!eq||eq.active===false){notify('Serviceobjektet är inte längre aktivt.',true);return;}
   const customer=customerBy(eq.customer_id);
   if(!customer){notify('Kunden saknas för detta serviceobjekt.',true);return;}
   const activeEquipment=equipmentFor(customer.id).filter(e=>e.active!==false);
   if(!activeEquipment.length){notify('Kunden har inga aktiva serviceobjekt.',true);return;}
   const existing=table('service_jobs').find(j=>j.customer_id===customer.id&&j.status==='draft');
   if(existing){
    // Complete any older automatically generated partial draft with all active customer ports.
    const linked=new Set(jesFor(existing.id).map(je=>je.equipment_id));
    const missing=activeEquipment.filter(e=>!linked.has(e.id));
    if(missing.length){
     await insertRows('job_equipment',missing.map(e=>({org_id:org(),job_id:existing.id,equipment_id:e.id})));
     await refresh();
    }
    sys.selectedJob=existing.id;sys.selectedJE=jesFor(existing.id)[0]?.id||null;
    sys.groupOpen={};sys.view='checklist';render();return;
   }
   if(!confirm('Starta service för '+customer.name+' med alla '+activeEquipment.length+' aktiva objekt?'))return;
   const date=new Date().toISOString().slice(0,10);
   const [job]=await insertRows('service_jobs',[{org_id:org(),customer_id:customer.id,service_date:date,started_by:sys.user.id,status:'draft'}]);
   if(!job?.id)throw Error('Serviceuppdraget kunde inte skapas.');
   const links=await insertRows('job_equipment',activeEquipment.map(e=>({org_id:org(),job_id:job.id,equipment_id:e.id})));
   if(links.length!==activeEquipment.length)throw Error('Alla serviceobjekt kunde inte kopplas till uppdraget.');
   await refresh();sys.selectedJob=job.id;sys.selectedJE=links[0]?.id||null;
   sys.groupOpen={};sys.view='checklist';render();return;
  }
  if(el.dataset.editEquipment){modal(equipmentForm(equipBy(el.dataset.editEquipment)));return;}
  if(el.dataset.retireEquipment){
   const e=equipBy(el.dataset.retireEquipment);if(!e||e.active===false)return;
   if(!confirm('Ta '+e.number+' ur drift? Objektet tas bort från aktiva portar, men all servicehistorik och tidigare brister behålls.'))return;
   await updateRow('equipment',e.id,{active:false,next_service_on:null});
   await refresh();sys.banner=e.number+' har tagits ur drift. Historiken finns kvar.';sys.alertClass='success';render();return;
  }
  if(el.dataset.replaceEquipment){
   const old=equipBy(el.dataset.replaceEquipment);if(!old||old.active===false)return;
   if(!confirm('Byt ut '+old.number+'? Först registreras den nya porten. Den gamla tas ur drift först när den nya har sparats.'))return;
   const html=equipmentForm(null);
   modal(html);
   const form=document.querySelector('#equipmentform');
   if(form){
    form.elements.namedItem('replaces_id').value=old.id;
    form.elements.namedItem('customer_id').value=old.customer_id;
    form.elements.namedItem('number').value=old.number;
    form.elements.namedItem('interval_months').value=String(old.interval_months||customerBy(old.customer_id)?.service_interval_months||'');
    form.querySelector('h2')?.remove();
   }
   return;
  }
  if(el.dataset.legacyReview){
   const issue=first(table('legacy_service_issues'),x=>x.id===el.dataset.legacyReview);
   if(!issue)return;
   const state=el.dataset.legacyState;
   if(!['resolved','remaining'].includes(state))return;
   const question=state==='resolved'?'Beskriv hur bristen åtgärdats:':'Kommentar till kvarstående brist (valfritt):';
   const comment=prompt(question,issue.review_comment||'');
   if(comment===null)return;
   if(state==='resolved'&&comment.trim().length<3){notify('Ange en beskrivning av åtgärden.',true);return;}
   if(!confirm('Bekräfta att bristen markeras som '+(state==='resolved'?'ÅTGÄRDAD':'KVARSTÅENDE')+'?'))return;
   try{
    await updateRow('legacy_service_issues',issue.id,{state,review_comment:comment.trim(),reviewed_at:new Date().toISOString(),reviewed_by:sys.profile?.display_name||sys.user?.id||'Montör'});
    await refresh();
    notify(state==='resolved'?'Historisk brist kvitterad som åtgärdad.':'Historisk brist kvitterad som kvarstående.');
   }catch(err){notify('Kunde inte spara kvitteringen: '+(err.message||err),true);}
   return;
  }
  if(el.dataset.persistIssue){
   const issue=first(table('issues'),x=>x.id===el.dataset.persistIssue),job=jobBy(el.dataset.checkJob);
   if(!issue||!job||job.status!=='draft')return;
   const comment=prompt('Kommentar om kvarstående brist (valfritt):','');
   if(comment===null)return;
   const existing=first(table('issue_service_checks'),x=>x.issue_id===issue.id&&x.job_id===job.id);
   const record={org_id:org(),issue_id:issue.id,job_id:job.id,decision:'kvarstar',comment:comment.trim(),checked_by:sys.user.id,checked_at:new Date().toISOString()};
   if(existing)await updateRow('issue_service_checks',existing.id,record);
   else await insertRows('issue_service_checks',[record]);
   await refresh();sys.banner='Brist kontrollerad och markerad som kvarstående.';sys.alertClass='success';render();return;
  }
  if(el.dataset.resolve){const description=prompt('Beskriv hur bristen har åtgärdats:');if(!description)return;if(description.trim().length<3){notify('Beskriv åtgärden mer noggrant.',true);return;}
   if(live&&!publicTest){const {error}=await client.rpc('resolve_issue',{p_issue:el.dataset.resolve,p_resolution:description});if(error)throw error;await refresh();}
   else if(publicTest){
    const current=jobBy(sys.selectedJob);
    if(current?.status==='draft'){
     const existing=first(table('issue_service_checks'),x=>x.issue_id===el.dataset.resolve&&x.job_id===current.id);
     const record={org_id:org(),issue_id:el.dataset.resolve,job_id:current.id,decision:'atgardad',comment:description,checked_by:sys.user.id,checked_at:new Date().toISOString()};
     if(existing)await updateRow('issue_service_checks',existing.id,record);else await insertRows('issue_service_checks',[record]);
    }
    await updateRow('issues',el.dataset.resolve,{state:'resolved',resolution:description,resolved_by:sys.user.id,resolved_at:new Date().toISOString()});await refresh();}
   else {const issue=first(table('issues'),x=>x.id===el.dataset.resolve);Object.assign(issue,{state:'resolved',resolution:description,resolved_by:sys.user.id,resolved_at:new Date().toISOString()});persist();render();}return;}
  if(el.dataset.toggleGroup){sys.groupOpen[el.dataset.toggleGroup]=!(sys.groupOpen[el.dataset.toggleGroup]??(el.dataset.toggleGroup.endsWith(itemsFor(equipBy(jeBy(sys.selectedJE)?.equipment_id))[0]?.group)));render();return;}
  if(el.dataset.approvePort){await approveWholePort(el.dataset.approvePort);return;}
  if(el.dataset.bulk){await onBulk(el.dataset.bulk);return;}
  if(el.dataset.answer){const [jeid,itemid,answer]=el.dataset.answer.split('|');await onAnswer(jeid,itemid,answer);return;}
  if(el.dataset.action)await handleAction(el.dataset.action,el);
 }catch(e){notify('Ett fel uppstod: '+e.message,true)}
});
// Standalone customer save: no modal rerender, no nested form handler, one REST request.
document.addEventListener('click',async function saveCustomerDirect(event){
 const button=event.target.closest('[data-save-customer]');
 if(!button)return;
 event.preventDefault();event.stopPropagation();
 const form=button.closest('#customerform');
 if(!form || button.disabled)return;
 if(!form.reportValidity())return;
 const data=new FormData(form),value=k=>String(data.get(k)||'').trim();
 const monthsValue=Number(value('service_interval_months'));
 if(!value('name')||![3,6,12].includes(monthsValue))return;
 const record={customer_type:value('customer_type'),name:value('name'),address:value('address'),contact:value('contact'),phone:value('phone'),email:value('email'),service_interval_months:monthsValue};
 let notice=form.querySelector('.save-feedback');
 if(!notice){notice=document.createElement('div');notice.className='save-feedback';notice.setAttribute('role','status');form.prepend(notice);}
 const show=(message,bad=false)=>{notice.textContent=message;notice.style.cssText='padding:14px;border-radius:9px;font-weight:700;background:'+(bad?'#ffdddd':'#fff0a6')+';color:#18334c';};
 button.disabled=true;button.textContent='Sparar kund…';show('1/3 Kontrollerar kunduppgifter…');
 try{
  let customer;
  if(live){
   const isNew=!value('id');
   const chosenId=value('id')||(form.dataset.customerSaveId||(form.dataset.customerSaveId=id()));
   const request={id:chosenId,org_id:org(),...record};
   const abort=new AbortController();
   const timer=setTimeout(()=>abort.abort(),13000);
   try{
    show('2/3 Skickar kunden till databasen…');
    const url=config.SUPABASE_URL.replace(/\/$/,'')+'/rest/v1/customers?on_conflict=id';
    const res=await fetch(url,{method:'POST',mode:'cors',cache:'no-store',signal:abort.signal,headers:{'apikey':config.SUPABASE_ANON_KEY,'Authorization':'Bearer '+(await client.auth.getSession()).data.session?.access_token,'Content-Type':'application/json','Prefer':'resolution=merge-duplicates,return=representation'},body:JSON.stringify([request])});
    const body=await res.text();
    if(!res.ok)throw Error('Databasen svarade '+res.status+': '+body.slice(0,280));
    const rows=JSON.parse(body);customer=rows[0];
    if(!customer?.id)throw Error('Ingen kund returnerades från databasen.');
   }finally{clearTimeout(timer);}
   if(!isNew){
    for(const e of equipmentFor(chosenId))await updateRow('equipment',e.id,{interval_months:monthsValue});
   }
  }else{
   if(value('id'))customer=await updateRow('customers',value('id'),record);
   else customer=(await insertRows('customers',[{org_id:org(),...record}]))[0];
  }
  if(!customer?.id)throw Error('Kunden kunde inte bekräftas.');
  show('3/3 Kund sparad. Uppdaterar listan…');
  sys.selectedCustomer=customer.id;sys.customerDetailOpen=true;sys.filter='';sys.view='customers';
  // Update the local customer list immediately; do not wait for a full eight-table refresh.
  const existing=table('customers').findIndex(c=>c.id===customer.id);
  if(existing>=0)table('customers')[existing]=customer;else table('customers').push(customer);
  sys.modal=null;sys.banner='Kund sparad: '+customer.name;sys.alertClass='success';render();
 }catch(err){
  const message=err.name==='AbortError'?'Databasen svarade inte inom 13 sekunder.':err.message||String(err);
  show('Kunde inte spara: '+message,true);console.error('Customer save failed',err);
 }finally{const still=document.querySelector('#customerform [data-save-customer]');if(still){still.disabled=false;still.textContent='Spara kund';}}
},true);
// Independent object save, matching the tested customer save flow.
document.addEventListener('click',async function saveEquipmentDirect(event){
 const button=event.target.closest('[data-save-equipment]');
 if(!button)return;
 event.preventDefault();event.stopPropagation();
 const form=button.closest('#equipmentform');
 if(!form||button.disabled)return;
 if(!form.reportValidity())return;
 const data=new FormData(form),value=k=>String(data.get(k)||'').trim();
 const customerId=value('customer_id'),templateId=value('template_id');
 const customer=customerBy(customerId);
 const interval=value('interval_months')?Number(value('interval_months')):(customer?.service_interval_months||null);
 const record={customer_id:customerId,number:value('number'),template_id:templateId,subtype:value('subtype'),manufacturer:value('manufacturer'),model:value('model'),controller:value('controller'),serial_no:value('serial_no'),interval_months:interval,next_service_on:value('next_service_on')||null};
 let notice=form.querySelector('.save-feedback');
 if(!notice){notice=document.createElement('div');notice.className='save-feedback';notice.setAttribute('role','status');form.prepend(notice);}
 const show=(message,bad=false)=>{notice.textContent=message;notice.style.cssText='padding:14px;border-radius:9px;font-weight:700;background:'+(bad?'#ffdddd':'#fff0a6')+';color:#18334c';};
 if(!customer||!record.number||!sys.templates.some(t=>t.id===templateId)){show('Välj kund, objektnummer och en giltig porttyp.',true);return;}
 if(templateId==='GE-BRANDPORT-01'&&!record.subtype){show('Välj brandportsutförande.',true);return;}
 button.disabled=true;button.textContent='Sparar objekt…';show('Skickar objektet till databasen…');
 try{
  let equipment;
  if(live){
   const chosenId=value('id')||(form.dataset.objectSaveId||(form.dataset.objectSaveId=id()));
   const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),13000);
   try{
    const endpoint=config.SUPABASE_URL.replace(/\/$/,'')+'/rest/v1/equipment?on_conflict=id';
    const payload={id:chosenId,org_id:org(),...record};
    const response=await fetch(endpoint,{method:'POST',mode:'cors',cache:'no-store',signal:controller.signal,headers:{apikey:config.SUPABASE_ANON_KEY,Authorization:'Bearer '+(await client.auth.getSession()).data.session?.access_token,'Content-Type':'application/json',Prefer:'resolution=merge-duplicates,return=representation'},body:JSON.stringify([payload])});
    const body=await response.text();
    if(!response.ok)throw Error('Databasfel '+response.status+': '+body.slice(0,350));
    equipment=JSON.parse(body)[0];
   }finally{clearTimeout(timer);}
  }else{
   if(value('id'))equipment=await updateRow('equipment',value('id'),record);
   else equipment=(await insertRows('equipment',[{org_id:org(),...record}]))[0];
  }
  if(!equipment?.id)throw Error('Objektet kunde inte bekräftas av databasen.');
  if(value('replaces_id')){
   // The replacement has already been created; retain old equipment and all historical jobs.
   try{
    await updateRow('equipment',value('replaces_id'),{active:false,next_service_on:null});
    const retired=equipBy(value('replaces_id'));if(retired)Object.assign(retired,{active:false,next_service_on:null});
   }catch(err){
    show('Nya objektet sparades, men det gamla kunde inte tas ur drift: '+err.message,true);
    console.error('Replacement retirement failed',err);
    button.disabled=false;button.textContent='Spara objekt';
    return;
   }
  }
  const existing=table('equipment').findIndex(x=>x.id===equipment.id);
  if(existing>=0)table('equipment')[existing]=equipment;else table('equipment').push(equipment);
  sys.selectedCustomer=customerId;sys.customerDetailOpen=true;sys.view='customers';sys.filter='';
  sys.modal=null;sys.banner='Objekt sparat: '+equipment.number;sys.alertClass='success';render();
 }catch(error){
  show('Kunde inte spara objekt: '+(error.name==='AbortError'?'Tidsgränsen 13 sekunder passerades.':error.message||String(error)),true);
  console.error('Object save failed',error);
 }finally{
  const current=document.querySelector('#equipmentform [data-save-equipment]');
  if(current){current.disabled=false;current.textContent='Spara objekt';}
 }
},true);
document.addEventListener('submit',handleSubmit);
document.addEventListener('change',async ev=>{if(ev.target.dataset.intervalObject){
 const n=Number(ev.target.value);if(![3,6,12].includes(n))return;
 try{const e=equipBy(ev.target.dataset.intervalObject);await updateRow('equipment',e.id,{interval_months:n,responsible_user:e.responsible_user||sys.user.id});await refresh();notify('Serviceintervall sparat.')}catch(err){notify(err.message,true)}return;
 }if(ev.target.id==='equips'){sys.selectedJE=ev.target.value;sys.groupOpen={};render()} if((ev.target.id==='active-technician'||ev.target.id==='demo-technician')&&(!live||publicTest||sharedLogin)){const p=first(table('profiles'),p=>p.user_id===ev.target.value&&p.active!==false);if(p){sys.profile=p;sys.user={id:p.user_id,email:''};localStorage.setItem(TECHKEY,p.user_id);sys.banner='Aktiv montör: '+p.display_name+'. Nya kontroller registreras på denna montör.';sys.alertClass='success';render()}}});
document.addEventListener('change',ev=>{if(ev.target.name==='template_id'&&ev.target.closest('#equipmentform'))refreshCatalogInputs()});
document.addEventListener('input',ev=>{if(['manufacturer','template_id'].includes(ev.target.name)&&ev.target.closest('#equipmentform'))refreshCatalogInputs();if(ev.target.id==='filter'){const start=ev.target.selectionStart;sys.filter=ev.target.value;render();const inp=$('#filter');inp?.focus();inp?.setSelectionRange(start,start)}});
document.addEventListener('focusout',async ev=>{
 const text=ev.target;if(!text.matches('[data-description]'))return;
 const [jeid,itemid]=text.dataset.description.split('|'),value=text.value.trim();if(!value)return;const a=ansFor(jeid,itemid);if(a?.answer==='Brist'){try{await saveAnswer(jeid,itemid,'Brist',value);render()}catch(e){notify('Bristen kunde inte sparas: '+e.message,true)}}
});
init();