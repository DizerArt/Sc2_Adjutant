import {describe,expect,it} from 'vitest';
import {burstEvents,lossTotals,resourceTotals,fountainMotion} from '../../../src/renderer/postmatch/waterfall-model.mjs';
import {ReplayStory,TroopTracks} from '../../../src/renderer/postmatch/replay-story.mjs';

const spawn=(tag,team,owner=team+1)=>({kind:'spawn',id:`s${tag}`,at:0,tick:0,tag,team,owner_pid:owner,owner_name:`P${owner}`,unit:'Marine',category:'army',ready:true,x:tag,y:tag});
const death=(tag,team,killer)=>({kind:'death',id:`d${tag}`,at:1,tick:100,tag,team,owner_pid:team+1,owner_name:`P${team+1}`,unit:'Marine',enemy_kill_candidate:true,killer_tag:killer+1,killer_pid:killer+1,x:tag,y:tag});
function payload(count){return {id:'synthetic-ffa',teams:Array.from({length:count},(_,i)=>({label:`P${i+1}`})),timeline_seconds:17,elapsed_gameloops:1000,events:[],resource_timeline:[],story:{schema_version:1,events:[],movement:{schema_version:1,samples:[]}}};}

describe('postmatch multiplayer presentation models',()=>{
  it('keeps loss and resource counters for every FFA side, including unknown observations',()=>{
    const data=payload(4);data.events=[death(1,0,1),death(3,2,3),death(4,3,1)];data.resource_timeline=[{at:1,tick:100,team:2,minerals:50,gas:0}];
    expect(lossTotals(data,.5)).toEqual([0,0,0,0]);expect(lossTotals(data,1)).toEqual([1,0,1,1]);
    expect(resourceTotals(data,1)).toEqual([{minerals:null,gas:null,tick:null},{minerals:null,gas:null,tick:null},{minerals:50,gas:0,tick:100},{minerals:null,gas:null,tick:null}]);
  });
  it('records fourth-side casualties, hero credit and troop markers causally',()=>{
    const data=payload(4);data.story.events=[...Array.from({length:4},(_,i)=>spawn(i+1,i)),death(3,2,3),{kind:'upgrade',id:'u',at:2,tick:200,team:3}];
    const model=new ReplayStory(data),tracks=new TroopTracks(data);model.advance(0);
    expect(tracks.troops(model.units,0,true).map(t=>t.team)).toEqual([0,1,2,3]);
    const changes=model.advance(1);expect(changes.deaths).toHaveLength(1);expect(model.losses[2].get('3:Marine').count).toBe(1);
    expect(model.leaders(3)[0]).toMatchObject({kills:1,unit:{team:3,owner_pid:4}});
    expect(model.composition(3)).toMatchObject([{team:3,count:1}]);model.advance(2);expect(model.upgrades[3]).toHaveLength(1);
  });
  it('keeps allied owners separate within a 2v2 composition and simultaneous bursts',()=>{
    const data=payload(2);data.story.events=[spawn(1,0,1),spawn(2,0,2),spawn(3,1,3),spawn(4,1,4)];
    const model=new ReplayStory(data);model.advance(0);
    expect(model.composition(0).map(row=>row.owner_pid)).toEqual([1,2]);expect(model.composition(1).map(row=>row.owner_pid)).toEqual([3,4]);
    data.events=[{...death(1,0,1),owner_pid:1},{...death(2,0,1),owner_pid:2}];expect(burstEvents(data).map(row=>row.owner_pid)).toEqual([1,2]);
  });
  it('gives each FFA team its own bounded fountain lane and preserves two-team trajectories',()=>{
    const origins=[];for(let team=0;team<4;team++){const motion=fountainMotion(1200,500,50,team,2,2.4,60,4);origins.push(motion.origin[0]);for(let i=0;i<=60;i++){const [x,y]=motion.point(i/60);expect(x).toBeGreaterThanOrEqual(0);expect(x+50).toBeLessThanOrEqual(1200);expect(y).toBeGreaterThanOrEqual(0);expect(y+50).toBeLessThanOrEqual(500);}}
    expect(origins).toEqual([...origins].sort((a,b)=>a-b));expect(new Set(origins).size).toBe(4);
    expect(fountainMotion(1200,500,50,1,2,2.4,60,2).frames).toEqual(fountainMotion(1200,500,50,1,2,2.4,60).frames);
  });
});
