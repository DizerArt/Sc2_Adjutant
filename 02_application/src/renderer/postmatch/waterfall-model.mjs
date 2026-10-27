export function burstEvents(payload){
  const groups=new Map();
  for(const e of payload.events){
  const key=Math.floor(e.at/.08)+':'+e.team+':'+(e.owner_pid??'unknown')+':'+e.unit;
    if(!groups.has(key))groups.set(key,{...e,count:0});
    groups.get(key).count++;
  }
  return [...groups.values()].sort((a,b)=>a.at-b.at || a.id.localeCompare(b.id));
}
export function teamCount(payload){return Math.max(2,Math.min(32,payload.teams?.length||2));}
export function teamColor(payload,team){return payload.players?.find(player=>player.team===team && /^#[0-9a-f]{6}$/i.test(player.color||''))?.color || ['#73dcc8','#f0c780','#c1a2f5','#80bfff','#f590b7','#c8df7a','#ffab78','#93cbd1'][team%8];}
export function lossTotals(payload,elapsed){
  const totals=Array(teamCount(payload)).fill(0);
  for(const e of payload.events)if(e.at<=elapsed)totals[e.team]++;
  return totals;
}

export function resourceTotals(payload,elapsed){
  const totals=Array.from({length:teamCount(payload)},()=>({minerals:null,gas:null,tick:null}));
  for(const sample of payload.resource_timeline||[]){
    if(sample.at>elapsed)break;
    totals[sample.team]={minerals:sample.minerals,gas:sample.gas,tick:sample.tick};
  }
  return totals;
}

export function fountainAngle(showId,eventId,team){
  // Stable within a show (OBS and preview agree); repeat gets a fresh show ID.
  let hash=2166136261;
  for(const c of String(showId)+':'+team+':'+eventId)hash=Math.imul(hash^c.charCodeAt(0),16777619);
  hash=Math.imul(hash^(hash>>>16),0x7feb352d);
  hash=Math.imul(hash^(hash>>>15),0x846ca68b);
  hash=(hash^(hash>>>16))>>>0;
  return 45+35*hash/4294967295;
}
export function fountainFlight(maximum,angle){return maximum*(.8+.2*(angle-45)/35);}

export function fountainMotion(width,height,size,team,index,seconds,angleDegrees=60+(index%5-2)*1.3,count=2){
  if(count>2){
    const laneWidth=Math.max(0,width-size)/count,offset=laneWidth*team;
    const local=fountainMotion(laneWidth+size,height,size,0,index,seconds,angleDegrees);
    const point=progress=>{const [x,y]=local.point(progress);return [x+offset,y];};
    return {...local,point,origin:[local.origin[0]+offset,local.origin[1]],apex:[local.apex[0]+offset,local.apex[1]],frames:local.frames.map(frame=>{const [x,y]=point(frame.offset);return {...frame,transform:`translate(${x.toFixed(3)}px,${y.toFixed(3)}px)`};})};
  }
  // Seconds are physical time; linear WAAPI interpolation samples gravity, not a UI easing.
  const lane=index%5-2,angle=angleDegrees*Math.PI/180,direction=team?-1:1;
  const pause=Math.min(.18,seconds*.08),ascent=(seconds-pause)/2;
  const floor=Math.max(0,height-size-6);
  // 4u(1-u)=1/2: meet on the descending branches at half the apex height.
  const crossingFraction=(1+Math.SQRT1_2)/2;
  const spread=Math.min(size*.55,(width-size)*.08);
  const availableRange=Math.max(0,((width-size)/2-2*spread)/crossingFraction);
  const rise=Math.max(0,Math.min(floor*(.77+lane*.025),availableRange*Math.tan(angle)/4));
  const gravity=2*rise/(ascent*ascent),vy=gravity*ascent,vx=vy/Math.tan(angle);
  const range=2*vx*ascent;
  const origin=[(width-size)/2-direction*range*crossingFraction+direction*lane*spread,floor];
  const apex=[origin[0]+direction*vx*ascent,floor-rise];
  function point(progress){
    const time=Math.max(0,Math.min(1,progress))*seconds;
    const moving=time<ascent?time:time<ascent+pause?ascent:time-pause;
    return [origin[0]+direction*vx*moving,floor-vy*moving+gravity*moving*moving/2];
  }
  const offsets=new Set(Array.from({length:61},(_,i)=>i/60));
  offsets.add(ascent/seconds);offsets.add((ascent+pause)/seconds);
  const frames=[...offsets].sort((a,b)=>a-b).map(offset=>{
    const [x,y]=point(offset),opacity=Math.min(1,offset/.06,(1-offset)/.12);
    return {offset,transform:'translate('+x.toFixed(3)+'px,'+y.toFixed(3)+'px)',opacity:Math.max(0,opacity)};
  });
  return {frames,point,origin,apex,ascent,pause,angle:angle*180/Math.PI};
}
