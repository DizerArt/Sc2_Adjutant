const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const http=require('node:http');
const {createReviewServer}=require('./review-browser.cjs');
async function session(t){const review=await createReviewServer();t.after(()=>review.close());return review;}
async function request(review,url,body,headers={}){const response=await fetch(review.origin+url,{...(body?{method:'POST',body:JSON.stringify(body),headers:{'content-type':'application/json',...headers}}:{headers})});return {status:response.status,body:await response.json()};}
const rpc=(r,command,payload)=>request(r,'/__review/rpc',{command,payload});
const scenario=(r,change={})=>request(r,'/__review/control',{phase:'game',card:true,fault:'normal',nextImage:'png',language:'ru',...change});

test('direct replay fixture prepares all FFA teams without changing single-opponent history; cancel preserves facts',async t=>{
  const r=await session(t);const history=(await rpc(r,'listMatches')).body.value;
  const selected=(await rpc(r,'choosePostmatchReplay')).body.value;
  const data=(await request(r,'/api/overlay/postmatch/data?preview=1&id='+selected.id)).body;
  assert.equal(data.teams.length,4);assert.equal(data.players.length,4);
  assert.equal(selected.id,'synthetic-review-ffa-v2');
  assert.equal(selected.matchId,null);
  assert.deepEqual((await rpc(r,'listMatches')).body.value,history);
  await scenario(r,{nextImage:'cancel'});
  assert.equal((await rpc(r,'choosePostmatchReplay')).body.value,null);
  assert.equal((await rpc(r,'getPostmatchStatus')).body.value.id,selected.id);
});

test('four menu widgets share applied layout and immutable synthetic facts with local icons',async t=>{
  const r=await session(t);let current=(await rpc(r,'getSmartOverlaySettings')).body.value;
  const layout=structuredClone(current.draft.menuLayout);
  for(const place of Object.values(layout.widgets))place.enabled=true;
  layout.widgets.heroes={enabled:true,x:16,y:30,w:15,h:29};
  assert.equal((await fetch(r.origin+'/api/overlay/postmatch/data')).status,204);
  current=(await rpc(r,'saveSmartOverlayDraft',{revision:current.revision,...current.draft,menuLayout:layout})).body.value;
  await scenario(r,{phase:'menu'});
  assert.equal((await request(r,'/api/overlay/postmatch/status')).body.visible,false);
  await rpc(r,'applySmartOverlay',{revision:current.revision});
  assert.deepEqual((await request(r,'/api/overlay/state')).body.smart.menuLayout,layout);
  const status=(await request(r,'/api/overlay/postmatch/status')).body;
  assert.equal(status.visible,true);assert.equal(status.id,'synthetic-review-postmatch-v1');
  const facts=(await request(r,'/api/overlay/postmatch/data?id='+status.id)).body;
  assert.equal(facts.id,status.id);assert.equal(facts.startedAt,status.startedAt);
  assert.equal((await fetch(r.origin+'/api/overlay/postmatch/data?id=stale')).status,204);
  assert.match(await(await fetch(r.origin+'/widgets/postmatch.html?kind=heroes')).text(),/assets\/postmatch-/);
  const icon=await fetch(r.origin+'/api/battle/icons/MARINE');assert.equal(icon.status,200);assert.equal(icon.headers.get('content-type'),'image/png');
  await scenario(r,{phase:'game'});
  assert.equal((await fetch(r.origin+'/api/overlay/postmatch/data?id='+status.id)).status,204);
  assert.equal((await fetch(r.origin+'/api/overlay/postmatch/data?preview=1&id='+status.id)).status,200);
});

test('review host serves real built UI with explicit fixture boundary and rejects foreign origins/paths',async t=>{
  const r=await session(t);
  const html=await(await fetch(r.origin+'/app/')).text();
  assert.match(html,/window\.sc2Assistant=/);assert.match(html,/ВИЗУАЛЬНЫЙ СТЕНД/);assert.match(html,/assets\//);
  assert.equal((await request(r,'/__review/state',null,{origin:'https://attacker.example'})).status,403);
  const foreignHost=await new Promise((resolve,reject)=>{http.get(r.origin+'/__review/state',{headers:{host:'attacker.example'}},response=>{response.resume();resolve(response.statusCode);}).on('error',reject);});
  assert.equal(foreignHost,403);
  assert.equal((await fetch(r.origin+'/widgets/assets/%2e%2e%2f%2e%2e%2fpackage.json')).status,404);
  const publicState=(await request(r,'/api/overlay/state')).body;
  assert.equal(publicState.schemaVersion,1);assert.equal(publicState.opponent.mmr,5000);
  assert.doesNotMatch(JSON.stringify(publicState),/battleTag|replayPath|race note|Привет/);
});
test('draft edits, stale rejection and Apply are independently observable with logged build evidence',async t=>{
  const r=await session(t);const before=(await rpc(r,'getSmartOverlaySettings')).body.value;
  const modes=structuredClone(before.draft.modes);modes.game.enabled=false;
  const saved=(await rpc(r,'saveSmartOverlayDraft',{revision:before.revision,enabled:true,modes})).body.value;
  assert.equal((await request(r,'/api/overlay/state')).body.smart.mode.enabled,true);
  assert.equal((await rpc(r,'applySmartOverlay',{revision:before.revision})).status,400);
  const applied=(await rpc(r,'applySmartOverlay',{revision:saved.revision})).body.value;
  assert.equal(applied.appliedRevision,applied.revision);
  assert.equal((await request(r,'/api/overlay/state')).body.smart.mode.enabled,false);
  const disk=JSON.parse(fs.readFileSync(path.join(r.runDir,'state.json'),'utf8'));assert.equal(disk.smart.applied.modes.game.enabled,false);
  const stamp=JSON.parse(fs.readFileSync(path.join(r.runDir,'session.json'),'utf8'));assert.equal(stamp.kind,'browser-fixture-only');assert.equal(stamp.build.length,2);
});
test('image presets, cancellation and network/image faults are controlled without any user files',async t=>{
  const r=await session(t);let current=(await rpc(r,'getSmartOverlaySettings')).body.value;
  current=(await rpc(r,'chooseSmartOverlayImage',{revision:current.revision,mode:'menu'})).body.value;
  const image=current.draft.modes.menu.image;assert.equal(image.mime,'image/png');
  assert.equal((await fetch(r.origin+image.url)).headers.get('content-type'),'image/png');
  await scenario(r,{nextImage:'cancel'});
  assert.equal((await rpc(r,'chooseSmartOverlayImage',{revision:current.revision,mode:'menu'})).body.value,null);
  assert.equal((await rpc(r,'getSmartOverlaySettings')).body.value.revision,current.revision);
  await scenario(r,{fault:'image404'});assert.equal((await fetch(r.origin+image.url)).status,404);
  await scenario(r,{fault:'stale'});assert.ok(Date.now()-Date.parse((await request(r,'/api/overlay/state')).body.generatedAt)>14000);
  await scenario(r,{fault:'disconnect'});assert.equal((await request(r,'/api/overlay/state')).status,503);
  await scenario(r,{phase:'loading'});const loading=(await request(r,'/api/overlay/state')).body;assert.equal(loading.smart.phase,'loading');assert.equal(loading.active,false);
});
test('manual results default to unverified and persist notes with the exact scenario',async t=>{
  const r=await session(t);assert.deepEqual((await request(r,'/__review/results')).body,{});
  assert.equal((await request(r,'/__review/results',{id:'S01',status:'FAIL',note:'expected / actual / screenshot.png'})).status,200);
  const results=JSON.parse(fs.readFileSync(path.join(r.runDir,'results.json'),'utf8'));assert.equal(results.S01.status,'FAIL');assert.equal(results.S01.scenario.phase,'game');
  assert.equal((await request(r,'/__review/results',{id:'../../private',status:'PASS',note:''})).status,400);
});
