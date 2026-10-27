/** Explicit synthetic review fixture generator. Never imported by application runtime. */
import { writeFile } from "node:fs/promises";
import { buildPostmatchFacts, type TrackerEvent } from "../../src/compose-compat/postmatch-facts.js";
const event=(kind:string,tick:number,payload:Record<string,unknown>):TrackerEvent=>({eventType:`NNet.Replay.Tracker.${kind}`,gameloop:tick,payload});
const events:TrackerEvent[]=[];
const units=[{index:1,owner:3,type:"Marine"},{index:2,owner:3,type:"Marine"},{index:3,owner:3,type:"Marine"},{index:4,owner:3,type:"SCV"},{index:11,owner:8,type:"Stalker"},{index:12,owner:8,type:"Stalker"},{index:13,owner:8,type:"Stalker"},{index:14,owner:8,type:"Probe"}];
for(const u of units)events.push(event("SUnitBornEvent",0,{m_unitTagIndex:u.index,m_unitTagRecycle:1,m_unitTypeName:u.type,m_upkeepPlayerId:u.owner,m_controlPlayerId:u.owner,m_x:u.owner===3?12:82,m_y:16+(u.index%10)*7}));
for(let tick=240;tick<=13440;tick+=240){
  const items:number[]=[];let previous=0;
  for(const u of units){const progress=tick/13440,x=u.owner===3?12+progress*52:82-progress*52,y=16+(u.index%10)*7+Math.sin(progress*6)*3;items.push(u.index-previous,x,y);previous=u.index;}
  events.push(event("SUnitPositionsEvent",tick,{m_firstUnitIndex:0,m_items:items}));
}
for(const [tick,index,killer,killerIndex] of [[4800,1,8,11],[6000,12,3,2],[7200,2,8,11],[9000,3,8,11],[10560,13,3,3],[12000,4,8,11]])events.push(event("SUnitDiedEvent",tick,{m_unitTagIndex:index,m_unitTagRecycle:1,m_killerPlayerId:killer,m_killerUnitTagIndex:killerIndex,m_killerUnitTagRecycle:1,m_x:45+(index%5)*4,m_y:30+(index%3)*5}));
for(const tick of [0,3000,6000,9000,12000,13440])for(const pid of [3,8]){
  const raw=Object.fromEntries(["Minerals","Vespene"].flatMap((r,resource)=>["Army","Economy","Technology"].map((category,i)=>[`m_scoreValue${r}Lost${category}`,i?0:Math.floor(Math.floor(tick/3000)*(pid===3?100:75)*(resource?0.5:1))])));
  events.push(event("SPlayerStatsEvent",tick,{m_playerId:pid,m_stats:raw}));
}
events.push(event("SUpgradeEvent",7000,{m_playerId:3,m_upgradeTypeName:"Stimpack",m_count:1}));
events.sort((a,b)=>a.gameloop-b.gameloop);
const payload=buildPostmatchFacts({id:"synthetic-review-postmatch-v1",elapsed:13440,gameSeconds:600,map:"Синтетическая схема — не настоящая карта",players:[{pid:3,name:"Синие (тест)",team:0,color:"#4e9cff"},{pid:8,name:"Красные (тест)",team:1,color:"#ff735d"}],duration:20,events,category:unit=>["SCV","Probe"].includes(unit)?"worker":["Marine","Stalker"].includes(unit)?"army":"unknown"});
await writeFile(new URL("postmatch-review.json",import.meta.url),JSON.stringify({source:"synthetic fixture; not production",payload},null,2)+"\n","utf8");

const extra=events.map(e=>{const p={...e.payload};
  for(const key of ["m_upkeepPlayerId","m_controlPlayerId","m_killerPlayerId","m_playerId"])if(typeof p[key]==="number")p[key]=Number(p[key])+10;
  for(const key of ["m_unitTagIndex","m_killerUnitTagIndex","m_firstUnitIndex"])if(typeof p[key]==="number")p[key]=Number(p[key])+100;
  if(typeof p.m_y==="number")p.m_y+=80;
  return {...e,payload:p};});
const ffa=buildPostmatchFacts({id:"synthetic-review-ffa-v2",elapsed:13440,gameSeconds:600,map:"Синтетический FFA — не настоящая карта",players:[{pid:3,name:"Синий (тест)",team:0,color:"#4e9cff"},{pid:8,name:"Красный (тест)",team:1,color:"#ff735d"},{pid:13,name:"Зелёный (тест)",team:2,color:"#79db78"},{pid:18,name:"Фиолетовый (тест)",team:3,color:"#c18cff"}],duration:20,events:[...events,...extra].sort((a,b)=>a.gameloop-b.gameloop),category:unit=>["SCV","Probe"].includes(unit)?"worker":["Marine","Stalker"].includes(unit)?"army":"unknown"});
await writeFile(new URL("postmatch-review-ffa.json",import.meta.url),JSON.stringify({source:"synthetic four-team fixture; not production",payload:ffa},null,2)+"\n","utf8");
