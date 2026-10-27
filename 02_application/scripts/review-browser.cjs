// Development-only visual fixture host. It never connects to SC2, OBS or native IPC.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const PHASES = ['menu', 'loading', 'game', 'pause'];
const FAULTS = ['normal', 'stale', 'malformed', 'disconnect', 'image404', 'ipc-error', 'source-unavailable'];
const optionLabels={menu:'Меню',loading:'Загрузка',game:'Игра',pause:'Пауза',unknown:'Неизвестное состояние',normal:'Без сбоя',stale:'Устаревшие данные',malformed:'Повреждённый ответ',disconnect:'Связь прервана',image404:'Картинка недоступна','ipc-error':'Ошибка сохранения','source-unavailable':'Источник не запущен',png:'Тестовый PNG',gif:'Встроенный GIF',cancel:'Отмена выбора',error:'Ошибка изображения'};
const options=values=>values.map(value=>`<option value="${value}">${optionLabels[value]||value}</option>`).join('');
const METHODS = ['getAppVersion','getSettings','saveSettings','getDiagnostics','listOpponents','listMatches','getMatchDetails','addOpponentNote','removeOpponentNote','toggleMatchFavorite','listOpponentCandidates','updateOpponentProfile','getMonitoringStatus','startMonitoring','stopMonitoring','getReplayWatcherStatus','startReplayWatcher','stopReplayWatcher','listAvailableVoices','getObsOverlayInfo','configureObsOverlay','openObsOverlayPreview','getSmartOverlaySettings','saveSmartOverlayDraft','applySmartOverlay','chooseSmartOverlayImage','getPostmatchStatus','getPostmatchData','preparePostmatch','choosePostmatchReplay','minimizeWindow','closeWindow','setCompactWindow','showOverlay','hideOverlay','setOverlayPosition','setOverlayPlacementMode','openLocalStorage','revealReplay','syncReplays','clearStats','rebuildStats'];
const WIDGETS=['fountain','battle_map','armies','heroes'];
const defaultMenuLayout=()=>({columns:32,rows:64,widgets:Object.fromEntries(WIDGETS.map((k,i)=>[k,{enabled:false,x:(i%2)*16,y:Math.floor(i/2)*32,w:16,h:32}]))});
const clone = value => structuredClone(value);
function png() {
  function crc(bytes) { let v=0xffffffff; for (const b of bytes) { v^=b; for(let i=0;i<8;i++) v=(v>>>1)^((v&1)?0xedb88320:0); } return (v^0xffffffff)>>>0; }
  function chunk(type,bytes) { const data=Buffer.concat([Buffer.from(type),bytes]); const size=Buffer.alloc(4),sum=Buffer.alloc(4);size.writeUInt32BE(bytes.length);sum.writeUInt32BE(crc(data));return Buffer.concat([size,data,sum]); }
  const width=960,height=540,raw=Buffer.alloc((width*3+1)*height);
  for(let y=0;y<height;y++) for(let x=0;x<width;x++) { const i=y*(width*3+1)+1+x*3;raw[i]=x<width/2?35:170;raw[i+1]=y<height/2?160:65;raw[i+2]=((x%120)<3||(y%90)<3)?255:120; }
  const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=2;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',header),chunk('IDAT',zlib.deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);
}
function initialState(appRoot) {
  const fixture=JSON.parse(fs.readFileSync(path.join(appRoot,'src-tauri/tests/fixtures/storage-parity.json'),'utf8'));
  const appearance={enabled:true,modes:Object.fromEntries(PHASES.map(p=>[p,{enabled:true}])),menuLayout:defaultMenuLayout()};
  const postmatch=JSON.parse(fs.readFileSync(path.join(appRoot,'tests/fixtures/postmatch-review.json'),'utf8'));
  return {phase:'game',card:true,fault:'normal',nextImage:'png',monitoring:true,watching:false,
    settings:{language:'ru',playerName:'ReviewPlayer',region:'eu',defaultRace:'Protoss',pollingIntervalMs:1000,externalSourcesEnabled:false,externalSources:{sc2Pulse:false,localFixture:false},overlayEnabled:false,overlayPlacementMode:false,overlayPosition:'top-right',voice:{enabled:false,provider:'off',voiceEn:'en_US-glados',volume:0.7,speakingRate:1,announceOnLaunch:false,announceOpponentCard:false,announceMatchSummary:false}},
    obs:{enabled:true,position:'top-right',width:1920,height:1080},smart:{revision:0,appliedRevision:0,draft:clone(appearance),applied:clone(appearance)},postmatch:{matchId:"m1",id:postmatch.payload.id,startedAt:Date.now()/1000,payload:postmatch.payload,source:postmatch.source},opponents:clone(fixture.csv.expectedOpponents),matches:clone(fixture.csv.expectedMatches)};
}
function controlPage() { return `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Compose · визуальная проверка</title><style>body{margin:0;background:#101820;color:#edf3f7;font:16px/1.5 system-ui}main{max-width:1180px;margin:24px auto;padding:0 20px}h1{font-size:26px}a{color:#9cdcff}fieldset{border:1px solid #526475;margin:16px 0;padding:18px;border-radius:6px}label{display:inline-grid;gap:6px;margin:8px 18px 8px 0}button,input,select,textarea{font:inherit;padding:8px;background:#1c2d3d;color:inherit;border:1px solid #71889d;border-radius:4px}button,a{margin-right:10px}button{cursor:pointer}textarea{width:95%;height:70px}iframe{width:100%;aspect-ratio:16/9;border:1px solid #71889d;background:repeating-conic-gradient(#263746 0% 25%,#18242e 0% 50%) 0 0/28px 28px}pre{white-space:pre-wrap;overflow-wrap:anywhere}small{display:block;color:#b6c7d5}#message{min-height:1.5em;color:#a9e1cb}</style><main>
  <h1>Визуальная проверка Compose</h1><p><strong>Тестовые данные и имитация IPC.</strong> Здесь работает собранный интерфейс, но нет Rust, SQLite, настоящего выбора файла или подключения SC2/OBS. Их проверяет отдельный запуск <code>npm run review:compose</code>.</p>
  <p><a href="/app/" target="_blank">Открыть интерфейс приложения</a><a href="/widgets/" target="_blank">Открыть источник OBS</a><a href="/__review/session" target="_blank">Данные сборки и пути результатов</a></p>
  <fieldset><legend>Состояние источника</legend><label>Кадр<select id="phase">${options([...PHASES,'unknown'])}</select></label><label>Карточка<select id="card"><option value="true">Активный соперник</option><option value="false">Нет активного соперника</option></select></label><label>Сбой<select id="fault">${options(FAULTS)}</select></label><label>Язык<select id="language"><option>ru</option><option>en</option></select></label><label>Следующий выбор картинки<select id="nextImage">${options(['png','gif','cancel','error'])}</select></label><p><button id="set">Установить состояние</button><button id="reload">Обновить встроенный источник</button></p><small>Кадр меняет только состояние стенда. Для картинок/включателей/размера используйте интерфейс приложения и «Применить в OBS». При смене языка обновите его вкладку. «Выбрать изображение» возвращает выбранный здесь пример; диалог Windows проверяется отдельно.</small></fieldset>
  <p id="message" role="status"></p><iframe id="source" title="Источник OBS на тестовых данных" src="/widgets/"></iframe>
  <fieldset><legend>Результат проверки</legend><label>ID из инструкции<input id="caseId" value="S01" maxlength="80"></label><label>Результат<select id="status"><option>NOT_RUN</option><option>PASS</option><option>FAIL</option><option>BLOCKED</option></select></label><textarea id="note" aria-label="Что ожидалось, что произошло, имя скриншота" placeholder="Ожидалось / произошло / имя скриншота"></textarea><p><button id="record">Сохранить отметку</button><a href="/__review/results" target="_blank">Открыть результаты</a></p><small>Тест не считается пройденным автоматически. Скриншоты сохраните рядом с results.json в каталоге сеанса.</small></fieldset><details><summary>Данные сеанса и каталог результатов</summary><pre id="summary"></pre></details></main>
  <script>const byId=id=>document.getElementById(id);async function api(url,value){const r=await fetch(url,value?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(value)}:{});const data=await r.json();if(!r.ok)throw Error(data.error||r.status);return data;}async function load(){const s=await api('/__review/state');for(const k of ['phase','fault','nextImage'])byId(k).value=s[k];byId('card').value=String(s.card);byId('language').value=s.settings.language;const session=await api('/__review/session');byId('summary').textContent=JSON.stringify(session,null,2);}byId('set').onclick=async()=>{try{await api('/__review/control',{phase:byId('phase').value,card:byId('card').value==='true',fault:byId('fault').value,nextImage:byId('nextImage').value,language:byId('language').value});byId('message').textContent='Состояние установлено. Источник обновится при следующем опросе.';}catch(e){byId('message').textContent=e.message;}};byId('reload').onclick=()=>byId('source').contentWindow.location.reload();byId('record').onclick=async()=>{try{await api('/__review/results',{id:byId('caseId').value,status:byId('status').value,note:byId('note').value});byId('message').textContent='Результат сохранён.';}catch(e){byId('message').textContent=e.message;}};load().catch(e=>byId('message').textContent=e.message);</script></html>`; }

async function createReviewServer({appRoot=path.resolve(__dirname,'..'),mapFixture=null}={}) {
  const mainRoot=path.join(appRoot,'dist-renderer'),obsRoot=path.join(appRoot,'dist-obs');
  for(const file of [path.join(mainRoot,'index.html'),path.join(obsRoot,'obs.html')]) if(!fs.existsSync(file)) throw Error('Build current resources first: npm run build:compose-resources');
  const runDir=path.join(appRoot,'.compose-test-data',`visual-browser-${crypto.randomUUID()}`);fs.mkdirSync(runDir,{recursive:true});
  const state=initialState(appRoot),results={};let origin='';
  // Explicit developer fixture only: real terrain, synthetic players/positions.
  if(mapFixture){
    const b=clone(mapFixture.background),bytes=Buffer.from(mapFixture.bytes);
    if(b.status!=='ready'||! /^[0-9a-f]{64}$/.test(b.map_sha256)||! /^[0-9a-f]{64}$/.test(b.image_sha256)||bytes.length>16*1024*1024||crypto.createHash('sha256').update(bytes).digest('hex')!==b.image_sha256||!bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')))throw Error('Invalid explicit map fixture');
    b.url=`/api/overlay/maps/${b.image_sha256}/image`;
    state.postmatch.payload.map_sha256=b.map_sha256;state.postmatch.payload.map_background=b;
    state.postmatch.payload.map='Проверка рельефа · синтетические позиции';
    mapFixture={background:b,bytes};
  }
  const pngId=crypto.randomUUID(),gifId=crypto.randomUUID();fs.writeFileSync(path.join(runDir,'synthetic.png'),png());
  const findAsset=prefix=>{const names=fs.readdirSync(path.join(obsRoot,'assets')).filter(n=>n.startsWith(prefix));return names.length?path.join(obsRoot,'assets',names[0]):null;};
  const gifName=fs.readdirSync(path.join(obsRoot,'assets')).find(n=>n.startsWith('loading-')&&n.endsWith('.gif'));
  const media=new Map([[pngId,{file:path.join(runDir,'synthetic.png'),mime:'image/png',width:960,height:540,name:'Синтетическая сетка.png'}],[gifId,{file:gifName?path.join(obsRoot,'assets',gifName):null,poster:findAsset('loading-poster-'),mime:'image/gif',width:960,height:540,name:'Встроенный тестовый GIF.gif'}]]);
  const stamp=file=>({file:path.relative(appRoot,file),sha256:crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),modifiedAt:fs.statSync(file).mtime.toISOString()});
  const session={kind:'browser-fixture-only',createdAt:new Date().toISOString(),pid:process.pid,runDir,build:[stamp(path.join(mainRoot,'index.html')),stamp(path.join(obsRoot,'obs.html'))],coverage:'Real renderer; simulated data/IPC. Native/SC2/OBS checks are separate.'};
  const persist=()=>fs.writeFileSync(path.join(runDir,'state.json'),JSON.stringify(state,null,2));
  const log=(type,data)=>fs.appendFileSync(path.join(runDir,'events.ndjson'),JSON.stringify({at:new Date().toISOString(),type,data})+'\n');
  const info=()=>({...state.obs,running:state.fault!=='source-unavailable',...(state.fault==='source-unavailable'?{error:'Тест: источник недоступен'}:{url:origin+'/widgets/'})});
  const postmatchStatus=(preview=false)=>({status:'ready',id:state.postmatch.id,matchId:state.postmatch.matchId,startedAt:state.postmatch.startedAt,available:true,visible:preview||(state.phase==='menu'&&state.monitoring&&state.smart.applied.enabled&&state.smart.applied.modes.menu.enabled&&Object.values(state.smart.applied.menuLayout.widgets).some(w=>w.enabled))});
  const monitor=()=>({running:state.monitoring,...(state.card?{lastSavedMatchId:'m1',currentSession:{active:true,mode:'ranked-1v1',detectedAt:new Date().toISOString(),players:[{name:'ReviewPlayer',race:'Protoss',isUser:true},{name:state.opponents[0]?.nickname||'SyntheticOpponent',race:'Terran',isUser:false}]}}:{})});
  const revision=p=>{if(!p||p.revision!==state.smart.revision)throw Error('Тест: версия устарела; перечитайте настройки');};
  function rpc(command,p={}) {
    if(!METHODS.includes(command))throw Error('Unsupported fixture command');
    if(state.fault==='ipc-error'&&!command.startsWith('get')&&!command.startsWith('list'))throw Error('Тест: команда отклонена');
    switch(command){
      case'getAppVersion':return {version:'VISUAL FIXTURE'};
      case'getSettings':return {settings:state.settings};
      case'saveSettings':state.settings={...state.settings,...p,externalSourcesEnabled:false,voice:{...state.settings.voice,...p.voice,enabled:false}};return {settings:state.settings};
      case'getDiagnostics':return {checkedAt:new Date().toISOString(),overallStatus:'warning',items:[{name:'Visual fixture',status:'warning',message:'Данные имитируются. SC2, источники и модели не запускаются.'}]};
      case'listOpponents':return {opponents:state.opponents};
      case'listMatches':return {items:state.matches.map(match=>({match,opponent:state.opponents.find(o=>o.id===match.opponentId)||null}))};
      case'getMatchDetails':{const match=state.matches.find(m=>m.id===p.matchId);return {details:match?{match,opponent:state.opponents.find(o=>o.id===match.opponentId)||null,mapName:match.map,playedAt:match.playedAt,durationSeconds:match.durationSeconds,players:[],graphs:[],buildOrders:[],parseError:'Синтетический профиль: реальный реплей не загружался.'}:null};}
      case'toggleMatchFavorite':{const match=state.matches.find(m=>m.id===p.matchId);if(!match)throw Error('Missing synthetic match');match.favorite=!match.favorite;return {match};}
      case'addOpponentNote':case'removeOpponentNote':{const opponent=state.opponents.find(o=>o.id===p.opponentId);if(!opponent)throw Error('Missing synthetic opponent');if(p.race&&!['Terran','Zerg','Protoss','Random','Unknown'].includes(p.race))throw Error('Invalid race');const target=p.race?(opponent.raceProfiles[p.race]??={notes:[],strategyTags:[]}):opponent;target.notes??=[];if(command==='addOpponentNote')target.notes.push(String(p.note).slice(0,2000));else target.notes.splice(p.noteIndex,1);return {opponent};}
      case'updateOpponentProfile':throw Error('Профиль/идентичность проверяется в настоящем приложении.');
      case'listOpponentCandidates':return {candidates:[]};
      case'getMonitoringStatus':return monitor();
      case'startMonitoring':state.monitoring=true;return monitor();
      case'stopMonitoring':state.monitoring=false;return monitor();
      case'getReplayWatcherStatus':return {running:state.watching};
      case'startReplayWatcher':case'stopReplayWatcher':state.watching=command==='startReplayWatcher';return {running:state.watching};
      case'listAvailableVoices':return {available:[]};
      case'getObsOverlayInfo':return info();
      case'configureObsOverlay':{if(typeof p.enabled!=='boolean'||!['top-left','top-center','top-right','middle-left','middle-right','bottom-1','bottom-2','bottom-3','bottom-4','bottom-5','bottom-6'].includes(p.position))throw Error('Invalid fixture OBS settings');const width=p.width??state.obs.width,height=p.height??state.obs.height;if(!Number.isInteger(width)||width<640||width>7680||!Number.isInteger(height)||height<360||height>4320)throw Error('Invalid canvas');state.obs={enabled:p.enabled,position:p.position,width,height};return info();}
      case'getSmartOverlaySettings':return state.smart;
      case'saveSmartOverlayDraft':{revision(p);if(typeof p.enabled!=='boolean'||!p.modes||Object.keys(p.modes).length!==4||!PHASES.every(k=>typeof p.modes[k]?.enabled==='boolean'&&(!p.modes[k].image||media.has(p.modes[k].image.id))))throw Error('Invalid fixture appearance');const layout=p.menuLayout??state.smart.draft.menuLayout;if(layout.columns!==32||layout.rows!==64||Object.keys(layout.widgets??{}).length!==4||!WIDGETS.every(k=>{const w=layout.widgets[k];return w&&typeof w.enabled==='boolean'&&[w.x,w.y,w.w,w.h].every(Number.isInteger)&&w.x>=0&&w.y>=0&&w.w>=1&&w.h>=1&&w.x+w.w<=32&&w.y+w.h<=64;}))throw Error('Invalid fixture grid');state.smart.revision++;state.smart.draft=clone({enabled:p.enabled,modes:p.modes,menuLayout:layout});return state.smart;}
      case'applySmartOverlay':revision(p);state.smart.revision++;state.smart.appliedRevision=state.smart.revision;state.smart.applied=clone(state.smart.draft);return state.smart;
      case'chooseSmartOverlayImage':{revision(p);if(!PHASES.includes(p.mode))throw Error('Unknown mode');if(state.nextImage==='cancel')return null;if(state.nextImage==='error')throw Error('Тест: изображение не прошло проверку');const id=state.nextImage==='gif'?gifId:pngId,item=media.get(id);if(!item.file)throw Error('Built fixture asset unavailable');const image={id,mime:item.mime,width:item.width,height:item.height,name:item.name,animated:item.mime==='image/gif',url:`/widgets/media/${id}`,...(item.mime==='image/gif'?{posterUrl:`/widgets/media/${id}/poster`}:{})};state.smart.draft.modes[p.mode]={enabled:true,image};state.smart.revision++;return state.smart;}
      case'getPostmatchStatus':return postmatchStatus();
      case'getPostmatchData':return clone(state.postmatch.payload);
      case'preparePostmatch':if(p.matchId!=='m1')throw Error('Synthetic match missing');state.postmatch.startedAt=Date.now()/1000;return postmatchStatus();
      case'choosePostmatchReplay':{if(state.nextImage==='cancel')return null;const fixture=JSON.parse(fs.readFileSync(path.join(appRoot,'tests/fixtures/postmatch-review-ffa.json'),'utf8'));state.postmatch={matchId:null,id:fixture.payload.id,payload:fixture.payload,startedAt:Date.now()/1000,source:fixture.source};return postmatchStatus();}
      default:throw Error('Этот сценарий проверяется в настоящем Tauri-приложении, а не на браузерном стенде.');
    }
  }
  function snapshot(){const opponent=state.opponents[0];const mode=clone(state.smart.applied.modes[state.phase]||{enabled:false});if(mode.image)delete mode.image.name;const active=state.monitoring&&state.card&&!!opponent&&!['menu','loading','unknown'].includes(state.phase);return {schemaVersion:1,generatedAt:new Date(Date.now()-(state.fault==='stale'?15000:0)).toISOString(),...state.obs,active,language:state.settings.language,...(active?{opponent:{nickname:opponent.nickname,race:'Terran',mmr:5000,league:'Master',encounters:2,wins:1,losses:0}}:{}),smart:{enabled:state.monitoring&&state.smart.applied.enabled,loadingEnabled:state.smart.applied.enabled&&state.smart.applied.modes.loading.enabled,phase:state.phase,mode,...(state.phase==='menu'?{menuLayout:state.smart.applied.menuLayout}:{})}};}
  function bridgeScript(){return `<script>window.sc2Assistant={version:'visual-fixture',...Object.fromEntries(${JSON.stringify(METHODS)}.map(command=>[command,async(payload)=>{if(command==='openObsOverlayPreview'){window.open('/widgets/','_blank','noopener');return;}const response=await fetch('/__review/rpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({command,payload})});const result=await response.json();if(!response.ok)throw Error(result.error);return result.value;} ])),onReplaySyncProgress:()=>()=>{},onVoiceSpeak:()=>()=>{}};</script><div style="position:fixed;bottom:0;left:0;z-index:99999;background:#5c3210;color:white;font:12px system-ui;padding:3px 10px;pointer-events:none">ВИЗУАЛЬНЫЙ СТЕНД · данные и IPC имитируются</div>`;}
  async function body(req){let size=0;const chunks=[];for await(const part of req){size+=part.length;if(size>65536)throw Error('Review request too large');chunks.push(part);}return JSON.parse(Buffer.concat(chunks).toString('utf8'));}
  const server=http.createServer(async(req,res)=>{
    const send=(status,type,value)=>{res.writeHead(status,{'content-type':type,'cache-control':'no-store','x-content-type-options':'nosniff'});res.end(req.method==='HEAD'?undefined:value);};
    const json=(status,value)=>send(status,'application/json;charset=utf-8',JSON.stringify(value));
    try {
      if(!['GET','HEAD','POST'].includes(req.method))return json(405,{error:'Read/control only'});
      if(![`127.0.0.1:${server.address().port}`,`localhost:${server.address().port}`].includes(req.headers.host)||req.headers.origin&&req.headers.origin!==origin)return json(403,{error:'Own loopback origin only'});
      const url=new URL(req.url,origin);
      if(req.method==='POST'){
        if(req.headers['content-type']!=='application/json')return json(415,{error:'JSON required'});
        const p=await body(req);
        if(url.pathname==='/__review/rpc'){const value=clone(rpc(p.command,p.payload));if(!p.command.startsWith('get')&&!p.command.startsWith('list')){persist();log(p.command,p.payload);}return json(200,{value});}
        if(url.pathname==='/__review/control'){if(![...PHASES,'unknown'].includes(p.phase)||!FAULTS.includes(p.fault)||!['png','gif','cancel','error'].includes(p.nextImage)||typeof p.card!=='boolean'||!['ru','en'].includes(p.language))throw Error('Invalid scenario');Object.assign(state,{phase:p.phase,card:p.card,fault:p.fault,nextImage:p.nextImage});state.settings.language=p.language;persist();log('scenario',p);return json(200,{ok:true});}
        if(url.pathname==='/__review/results'){if(!/^[a-zA-Z0-9_.-]{1,80}$/.test(p.id)||!['NOT_RUN','PASS','FAIL','BLOCKED'].includes(p.status)||typeof p.note!=='string'||p.note.length>4000)throw Error('Invalid result');results[p.id]={status:p.status,note:p.note,at:new Date().toISOString(),scenario:{phase:state.phase,fault:state.fault,revision:state.smart.revision,appliedRevision:state.smart.appliedRevision}};fs.writeFileSync(path.join(runDir,'results.json'),JSON.stringify(results,null,2));return json(200,{ok:true});}
        return json(404,{error:'Unknown review action'});
      }
      if(url.pathname==='/')return send(200,'text/html;charset=utf-8',controlPage());
      if(url.pathname==='/__review/session')return json(200,session);
      if(url.pathname==='/__review/state')return json(200,state);
      if(url.pathname==='/__review/results')return json(200,results);
      if(url.pathname==='/api/overlay/state'){if(state.fault==='disconnect')return json(503,{error:'Synthetic disconnection'});return json(200,state.fault==='malformed'?{schemaVersion:999}:snapshot());}
      if(url.pathname==='/api/overlay/postmatch/status')return json(200,postmatchStatus(url.searchParams.get('preview')==='1'));
      if(url.pathname==='/api/overlay/postmatch/data'){const status=postmatchStatus(url.searchParams.get('preview')==='1');if(!status.visible||url.searchParams.get('id')&&url.searchParams.get('id')!==state.postmatch.id)return send(204,'application/json','');return json(200,{...state.postmatch.payload,startedAt:state.postmatch.startedAt});}
      if(mapFixture&&url.pathname===mapFixture.background.url)return send(200,'image/png',mapFixture.bytes);
      if(url.pathname.startsWith('/api/battle/icons/')){const key=url.pathname.slice('/api/battle/icons/'.length);if(!/^[A-Z0-9_]{1,80}$/.test(key))return json(404,{error:'Unknown icon'});const file=path.join(obsRoot,'assets/postmatch-icons',key+'.png');if(!fs.existsSync(file))return json(404,{error:'Unknown icon'});return send(200,'image/png',fs.readFileSync(file));}
      if(url.pathname.startsWith('/widgets/media/')){const match=/^\/widgets\/media\/([0-9a-f-]{36})(\/poster)?$/.exec(url.pathname),item=match&&media.get(match[1]);const file=item&&(match[2]?item.poster:item.file);if(state.fault==='image404'||!file)return json(404,{error:'Fixture image unavailable'});return send(200,match[2]?'image/png':item.mime,fs.readFileSync(file));}
      let root,relative;
      if(url.pathname.startsWith('/widgets/')){root=obsRoot;relative=url.pathname.slice(9)||'obs.html';}
      else if(url.pathname.startsWith('/app/')){root=mainRoot;relative=url.pathname.slice(5)||'index.html';}
      else if(url.pathname.startsWith('/assets/')){root=mainRoot;relative=url.pathname.slice(1);}
      else return json(404,{error:'Unknown fixture route'});
      const absolute=path.resolve(root,relative);if(!absolute.startsWith(root+path.sep))return json(404,{error:'Outside fixture assets'});
      const canonical=fs.realpathSync(absolute),canonicalRoot=fs.realpathSync(root);
      if(!canonical.startsWith(canonicalRoot+path.sep)||!fs.statSync(canonical).isFile())return json(404,{error:'Outside fixture assets'});
      const ext=path.extname(canonical),types={'.html':'text/html;charset=utf-8','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.png':'image/png','.gif':'image/gif','.svg':'image/svg+xml','.wasm':'application/wasm','.woff2':'font/woff2'};
      if(!types[ext])return json(404,{error:'Unsupported fixture asset'});
      let bytes=fs.readFileSync(canonical);if(canonical===path.join(canonicalRoot,'index.html'))bytes=Buffer.from(bytes.toString('utf8').replace('<head>','<head>'+bridgeScript()));
      return send(200,types[ext],bytes);
    }catch(error){return json(error.code==='ENOENT'?404:400,{error:error.code==='ENOENT'?'Fixture asset unavailable':String(error.message).slice(0,400)});}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});origin=`http://127.0.0.1:${server.address().port}`;
  Object.assign(session,{controlUrl:origin+'/',appUrl:origin+'/app/',obsUrl:origin+'/widgets/'});fs.writeFileSync(path.join(runDir,'session.json'),JSON.stringify(session,null,2));fs.writeFileSync(path.join(runDir,'results.json'),'{}');persist();
  return {server,origin,runDir,session,close:()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();})};
}
module.exports={createReviewServer};
if(require.main===module)createReviewServer().then(review=>{console.log(`BROWSER FIXTURE ONLY — no Rust/SC2/OBS\nCONTROL_URL=${review.session.controlUrl}\nAPP_URL=${review.session.appUrl}\nOBS_URL=${review.session.obsUrl}\nRESULTS=${review.runDir}\nStop this owned server with Ctrl+C.`);for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>review.close().then(()=>process.exit(0)));}).catch(error=>{console.error(error.message);process.exitCode=1;});
