import { describe, expect, it } from "vitest";
import { buildPostmatchFacts, collectTrackerSetup, postmatchIcon, postmatchRoster, trackerTag, type FactsInput, type TrackerEvent } from "../../../src/compose-compat/postmatch-facts.js";
import { executeCompatibility } from "../../../src/compose-compat/engine.js";

const event=(kind:string,tick:number,payload:Record<string,unknown>):TrackerEvent=>({eventType:`NNet.Replay.Tracker.${kind}`,gameloop:tick,payload});
const born=(index:number,owner:number,unit="Marine",tick=0,recycle=1)=>event("SUnitBornEvent",tick,{m_unitTagIndex:index,m_unitTagRecycle:recycle,m_unitTypeName:Buffer.from(unit),m_upkeepPlayerId:owner,m_controlPlayerId:99,m_x:10+index,m_y:20});
const died=(index:number,killer:number,tick:number,killerIndex?:number,recycle=1)=>event("SUnitDiedEvent",tick,{m_unitTagIndex:index,m_unitTagRecycle:recycle,m_killerPlayerId:killer,...(killerIndex===undefined?{}:{m_killerUnitTagIndex:killerIndex,m_killerUnitTagRecycle:1}),m_x:20,m_y:30});
const players=[{pid:3,name:"Один",team:7,color:"#aabbcc"},{pid:8,name:"Two",team:9,color:"#ccbbaa"}];
function facts(events:TrackerEvent[],change:Partial<FactsInput>={}) {return buildPostmatchFacts({elapsed:6720,gameSeconds:300,map:"Synthetic map",players,events,category:unit=>unit==="SCV"?"worker":unit==="Marine"||unit==="Marauder"?"army":"unknown",...change}) as any;}
const fullTag=(index:number,recycle=1)=>index*262144+recycle;
const values=(minerals:number,gas:number)=>Object.fromEntries(["Minerals","Vespene"].flatMap((r,i)=>["Army","Economy","Technology"].map((c,j)=>[`m_scoreValue${r}Lost${c}`,j===0?(i?gas:minerals):0])));

describe("portable postmatch tracker facts",()=>{
  it("preserves four FFA teams and enemy attribution instead of collapsing them to two sides",()=>{
    const roster=Array.from({length:4},(_,i)=>({pid:i+1,name:`Player${i+1}`,team:10+i*3,color:null}));
    const result=facts([...roster.map(p=>born(p.pid,p.pid)),died(3,4,100,4),died(1,2,200,2)],{players:roster});
    expect(result.teams.map((t:any)=>t.label)).toEqual(["Player1","Player2","Player3","Player4"]);
    expect(result.players.map((p:any)=>p.team)).toEqual([0,1,2,3]);
    expect(result.events.map((e:any)=>[e.owner_pid,e.team,e.killer_pid])).toEqual([[3,2,4],[1,0,2]]);
    expect(result.story.events.find((e:any)=>e.tag===fullTag(4))).toMatchObject({owner_pid:4,team:3});
  });
  it("keeps all eight 4v4 owners and excludes allied kills from loss candidates",()=>{
    const roster=Array.from({length:8},(_,i)=>({pid:i+1,name:`Player${i+1}`,team:i<4?7:9,color:null}));
    const result=facts([...roster.map(p=>born(p.pid,p.pid)),died(1,2,100,2),died(3,8,200,8),died(7,4,300,4)],{players:roster});
    expect(result.players).toHaveLength(8);expect(result.teams).toHaveLength(2);
    expect(result.events.map((e:any)=>[e.owner_pid,e.team])).toEqual([[3,0],[7,1]]);
  });
  it("filters the protocol's skipped-payload events without confusing them for setup records",()=>{
    const setup=event("SPlayerSetupEvent",0,{m_slotId:0,m_playerId:3});
    expect(collectTrackerSetup([setup,{eventType:"NNet.Replay.Tracker.SUnitBornEvent",gameloop:0,payload:null}])).toEqual([setup]);
    expect(()=>collectTrackerSetup(Array.from({length:129},()=>setup))).toThrow(/Too many tracker player setup/);
  });
  it("uses only bundled icon identities and aliases, preserving unknown labels as text",()=>{
    expect(postmatchIcon("Marine")).toBe("MARINE");
    expect(postmatchIcon("SiegeTankSieged")).toBe("SIEGETANK");
    expect(postmatchIcon("ModdedUnseenUnit")).toBeNull();
    expect(postmatchIcon("../../private")).toBeNull();
  });
  it("keeps full safe-integer tags and rejects malformed identity components",()=>{
    expect(trackerTag({m_unitTagIndex:20000,m_unitTagRecycle:17})).toBe(5_242_880_017);
    expect(trackerTag({m_unitTagIndex:2,m_unitTagRecycle:262144})).toBeNull();
    expect(trackerTag({m_unitTagIndex:-1,m_unitTagRecycle:1})).toBeNull();
  });
  it("joins noncontiguous authoritative PIDs through working-set and lobby slots",()=>{
    const details={m_playerList:[{m_name:Buffer.from("One"),m_workingSetSlotId:14,m_teamId:0,m_color:{m_r:12,m_g:34,m_b:56}},{m_name:"Observer",m_observe:2},{m_name:"Two",m_workingSetSlotId:4,m_teamId:1}]};
    const init={m_syncLobbyState:{m_lobbyState:{m_slots:[{m_workingSetSlotId:4,m_userId:7},{m_workingSetSlotId:14,m_userId:2}]}}};
    const setup=[event("SPlayerSetupEvent",0,{m_slotId:0,m_playerId:8,m_userId:7}),event("SPlayerSetupEvent",0,{m_slotId:1,m_playerId:3,m_userId:2})];
    expect(postmatchRoster(details,init,setup)).toEqual([{pid:3,name:"One",team:0,color:"#0c2238"},{pid:8,name:"Two",team:1,color:null}]);
    expect(()=>postmatchRoster(details,init,[])).toThrow(/authoritative tracker PID/);
    expect(()=>postmatchRoster(details,init,[...setup,event("SPlayerSetupEvent",0,{m_slotId:0,m_playerId:4,m_userId:7})])).toThrow(/Conflicting/);
  });
  it("uses upkeep owner, preserves construction/morph/owner chronology, and never later identity",()=>{
    const init={...born(1,3),eventType:"NNet.Replay.Tracker.SUnitInitEvent"};
    const result=facts([init,born(2,8),event("SUnitDoneEvent",100,{m_unitTagIndex:1,m_unitTagRecycle:1}),event("SUnitTypeChangeEvent",200,{m_unitTagIndex:1,m_unitTagRecycle:1,m_unitTypeName:"Marauder"}),died(1,8,300,2),born(1,8,"SCV",400,2)]);
    expect(result.story.events.map((e:any)=>[e.kind,e.unit,e.ready,e.owner_pid])).toEqual([["spawn","Marine",false,3],["spawn","Marine",true,8],["ready","Marine",true,3],["type","Marauder",true,3],["death","Marauder",true,3],["spawn","SCV",true,8]]);
    expect(result.events[0]).toMatchObject({unit:"Marauder",owner_pid:3,team:0,tag:fullTag(1),killer_tag:fullTag(2),killer_pid:8});
    expect(result.events[0].unit).not.toBe("SCV");
    const changed=facts([born(1,3),born(2,8),event("SUnitOwnerChangeEvent",100,{m_unitTagIndex:1,m_unitTagRecycle:1,m_upkeepPlayerId:8,m_controlPlayerId:3}),died(1,8,200,2)]);
    expect(changed.events).toEqual([]);expect(changed.excluded).toBe(1);
    expect(changed.story.events.find((e:any)=>e.kind==="owner")).toMatchObject({previous_owner_pid:3,owner_pid:8,team:1,position_epoch:1});
  });
  it("only credits already observed enemy killer units, including posthumous projectiles",()=>{
    const result=facts([born(1,3),born(2,8),died(2,3,100,1),died(1,8,100,2),born(3,3,"Marine",200),died(3,8,300,4),born(4,8,"Marine",400)]);
    expect(result.events[1].killer_tag).toBe(fullTag(2));
    expect(result.events[2].killer_tag).toBeNull();
    const unknown=facts([born(1,3),died(1,8,100)]);expect(unknown.events[0].killer_tag).toBeNull();
  });
  it("excludes friendly, neutral, unknown-killer and temporary deaths without inventing combat verification",()=>{
    const result=facts([born(1,3,"MULE"),born(2,3),born(3,0),born(4,3),died(1,8,10),died(2,3,20),died(3,8,30),died(4,0,40)]);
    expect(result.events).toEqual([]);expect(result.excluded).toBe(4);
    expect(result.policy).toBe("enemy_kill_candidates_not_verified_combat_losses");
    expect(result.story.events.some((e:any)=>e.unit==="MULE")).toBe(false);
  });
  it("decodes cumulative position triples and breaks continuity after a jump, owner change or recycled identity",()=>{
    const result=facts([born(100,3),born(102,8,"SCV"),event("SUnitPositionsEvent",10,{m_firstUnitIndex:99,m_items:[1,111,20,2,113,20]}),event("SUnitPositionsEvent",20,{m_firstUnitIndex:99,m_items:[1,300,400]}),event("SUnitOwnerChangeEvent",30,{m_unitTagIndex:100,m_unitTagRecycle:1,m_upkeepPlayerId:8}),event("SUnitPositionsEvent",40,{m_firstUnitIndex:99,m_items:[1,301,401]}),died(100,3,50),born(100,3,"Marine",60,2),event("SUnitPositionsEvent",70,{m_firstUnitIndex:99,m_items:[1,110,20]})]);
    const samples=result.story.movement.samples;
    expect(samples[0]).toMatchObject({tag:fullTag(100),x:111,can_connect:true});
    expect(samples[1]).toMatchObject({tag:fullTag(102),x:113,category:"worker"});
    expect(samples[2]).toMatchObject({can_connect:false,position_epoch:1});
    expect(samples[3]).toMatchObject({can_connect:false,position_epoch:2});
    expect(samples[4].tag).toBe(fullTag(100,2));
    expect(result.story.movement).toMatchObject({fresh_ticks:240,max_connect_ticks:480,max_connect_distance:16,cargo:"not_observed_by_tracker_no_route_inference"});
  });
  it("keeps malformed movement unavailable rather than filling gaps with fabricated routes",()=>{
    const result=facts([born(1,3),event("SUnitPositionsEvent",10,{m_firstUnitIndex:0,m_items:[1,20]})]);
    expect(result.story.movement.status).toBe("unavailable");expect(result.story.movement.samples).toEqual([]);
    expect(result.map_background.status).toBe("unavailable");expect(result.map_background.reason).toMatch(/схема/);
  });
  it("sums only actual complete PlayerStats losses for every allied member and preserves unknown resources",()=>{
    const allied=[...players,{pid:5,name:"Ally",team:7,color:null}];
    const result=facts([event("SPlayerStatsEvent",10,{m_playerId:3,m_stats:values(100,25)}),event("SPlayerStatsEvent",20,{m_playerId:8,m_stats:{m_scoreValueMineralsLostArmy:0}}),event("SPlayerStatsEvent",30,{m_playerId:5,m_stats:values(40,15)}),event("SPlayerStatsEvent",40,{m_playerId:8,m_stats:values(80,50)})],{players:allied});
    expect(result.resource_timeline.map((s:any)=>[s.tick,s.team,s.minerals,s.gas])).toEqual([[10,0,null,null],[20,1,null,null],[30,0,140,40],[40,1,80,50]]);
    expect(result.resource_timeline[2].at).toBeCloseTo(30/6720*result.timeline_seconds);
    expect(result.resource_basis).toMatch(/no interpolation/);
  });
  it("enforces ordered times, eligible game length and bounded browser event payloads",()=>{
    expect(()=>facts([],{gameSeconds:120})).toThrow(/two minutes/);
    expect(()=>facts([born(1,3,"Marine",100),born(2,8,"Marine",50)])).toThrow(/ordered/);
    expect(()=>facts([born(1,3,"Marine",7000)])).toThrow(/ordered/);
    expect(()=>facts(Array.from({length:10001},(_,i)=>died(i,8,0)))).toThrow(/Too many deaths/);
    expect(()=>facts([],{duration:2})).toThrow(/duration/);
    expect(()=>facts([],{players:[players[0]]})).toThrow(/two identified teams/);
  });
  it("routes postMatchFacts separately from domain snapshot commands and rejects unsupported source paths",async()=>{
    await expect(executeCompatibility("postMatchFacts",{})).rejects.toThrow(/Missing replay path/);
    await expect(executeCompatibility("postMatchFacts",{replayPath:"relative.SC2Replay"})).rejects.toThrow(/absolute local/);
  });
});
