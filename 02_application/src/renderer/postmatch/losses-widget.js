import {startPostmatchPolling} from './postmatch-session.js';
import {burstEvents,lossTotals,resourceTotals,fountainMotion,fountainAngle,fountainFlight,teamCount,teamColor} from './waterfall-model.mjs?v=resource-losses-1';
import {resourceCounters} from './battle-resources.mjs';
import {animationNames} from './replay-story.mjs?v=post-match-2';
import {StoryScene} from './replay-story-scene.mjs?v=post-match-2';
const $=id=>document.getElementById(id),reduce=matchMedia('(prefers-reduced-motion: reduce)');
let current=null,start=0,frame=0,groups=[],next=0,animations=[],scene=null,teamViews=[];
const fmt=t=>String(Math.floor(t/60)).padStart(2,'0')+':'+String(Math.floor(t%60)).padStart(2,'0');
// Reuse the mineral/vespene vectors already used by the short renderer.
for(const resource of resourceCounters({minerals:0,gas:0,unknown:0},{x:-42,y:-78,w:48})){
  for(const row of document.querySelectorAll('.resource.'+resource.key)){
    const ns='http://www.w3.org/2000/svg',svg=document.createElementNS(ns,'svg');
    svg.setAttribute('viewBox','-24 -26 48 48');svg.setAttribute('aria-hidden','true');
    for(const shape of resource.shapes){
      const node=document.createElementNS(ns,shape.kind);node.setAttribute('fill',shape.fill);
      if(shape.kind==='polygon')node.setAttribute('points',shape.points.map(p=>p.join(',')).join(' '));
      else{const [x1,y1,x2,y2]=shape.bounds;for(const [key,v] of Object.entries({cx:(x1+x2)/2,cy:(y1+y2)/2,rx:(x2-x1)/2,ry:(y2-y1)/2}))node.setAttribute(key,String(v));}
      svg.append(node);
    }
    row.prepend(svg);
  }
}
const teamTemplates=[document.querySelector('.team-a').cloneNode(true),document.querySelector('.team-b').cloneNode(true)],clock=document.querySelector('.match-clock');
function prepareTeams(payload){
  const header=document.querySelector('header'),count=teamCount(payload);
  header.classList.toggle('multi-team-header',count>2);
  header.style.setProperty('--team-columns',Math.min(count,4));
  header.replaceChildren();if(count>2)header.append(clock);
  teamViews=payload.teams.map((team,index)=>{
    const element=teamTemplates[index===1?1:0].cloneNode(true);
    element.className='team team-'+(index===1?'b':'a');element.style.color=teamColor(payload,index);
    element.querySelectorAll('[id]').forEach(child=>child.removeAttribute('id'));
    const label=element.querySelector(':scope > span');label.textContent=team.label;label.title=team.label;
    element.querySelector('small').textContent=english?'LOSSES':'ПОТЕРИ';
    const resources=element.querySelector('.resources');resources.setAttribute('aria-label',(english?'Resource losses: ':'Потери ресурсов: ')+team.label);
    header.append(element);if(count===2&&index===0)header.append(clock);
    return {element,count:element.querySelector(':scope > strong'),minerals:element.querySelector('.minerals > span'),gas:element.querySelector('.gas > span')};
  });
}
function hide(){cancelAnimationFrame(frame);for(const a of animations)a.cancel();animations=[];scene?.dispose();scene=null;current=null;$('stream').querySelectorAll('.loss-icon').forEach(e=>e.remove());$('waterfall').hidden=true;}
function fly(event,index,age=0){
  if(animations.length>=128)return;
  const stream=$('stream'),w=stream.clientWidth,h=stream.clientHeight;
  const tile=document.createElement('div');tile.className='loss-icon'+(event.team?' other':'');
  tile.style.borderColor=/^#[0-9a-f]{6}$/i.test(event.owner_color||'')?event.owner_color:teamColor(current,event.team);
  tile.title=event.unit+' · '+(event.owner_name||current.teams[event.team].label);
  const fallback=document.createElement('span');fallback.className='fallback';fallback.textContent=event.unit;tile.append(fallback);
  if(event.icon){const img=document.createElement('img');img.src='/api/battle/icons/'+encodeURIComponent(event.icon);img.alt='';img.onload=()=>fallback.remove();img.onerror=()=>img.remove();tile.prepend(img);}
  if(event.count>1){const badge=document.createElement('b');badge.textContent=event.count;tile.append(badge);}
  stream.append(tile);const size=tile.offsetWidth,angle=fountainAngle(current.id,event.id,event.team);
  const seconds=fountainFlight(current.flight_seconds||Math.min(4.8,current.duration*.24),angle);
  const motion=fountainMotion(w,h,size,event.team,index,seconds,angle,teamCount(current));
  const positions=reduce.matches?[{opacity:0},{opacity:1,offset:.12},{opacity:1,offset:.8},{opacity:0}]:motion.frames;
  if(reduce.matches)tile.style.transform='translate('+motion.apex[0]+'px,'+motion.apex[1]+'px)';
  const anim=tile.animate(positions,{duration:seconds*1000,easing:'linear',fill:'forwards'});anim.currentTime=age*1000;animations.push(anim);
  anim.onfinish=()=>{tile.remove();animations=animations.filter(a=>a!==anim);};
}
function draw(){
  if(!current)return;const raw=(performance.now()-start)/1000,elapsed=reduce.matches?current.duration-.001:Math.min(raw,current.duration-.001);

  const totals=lossTotals(current,elapsed);teamViews.forEach((view,team)=>view.count.textContent=totals[team]);
  const resources=resourceTotals(current,elapsed);
  resources.forEach((r,team)=>{for(const key of ['minerals','gas']){
    const counter=teamViews[team][key];counter.textContent=r[key]===null?'—':r[key].toLocaleString(document.documentElement.lang==='en'?'en-US':'ru-RU');
    counter.parentElement.title=(key==='minerals'?'Потерянные минералы':'Потерянный веспен')+(r.tick===null||r[key]===null?' · нет данных': ' · снимок на '+fmt(current.game_seconds*r.tick/current.elapsed_gameloops));
  }});
  const timeline=current.timeline_seconds||current.duration-1.5;
  $('game-clock').textContent=fmt(current.game_seconds*Math.min(1,elapsed/timeline));
  $('progress').style.transform='scaleX('+Math.min(1,elapsed/timeline)+')';
  if(scene)scene.draw(elapsed);
  else while(next<groups.length && groups[next].at<=elapsed){const event=groups[next],age=elapsed-event.at,angle=fountainAngle(current.id,event.id,event.team);if(age<fountainFlight(current.flight_seconds||Math.min(4.8,current.duration*.24),angle))fly(event,next,age);next++;}
  if(!reduce.matches && raw<current.duration)frame=requestAnimationFrame(draw);
}

const parameters=new URLSearchParams(location.search),kind=['fountain','battle_map','armies','heroes'].includes(parameters.get('kind'))?parameters.get('kind'):'fountain';
const english=parameters.get('lang')==='en';document.documentElement.lang=english?'en':'ru';
const names=english?{fountain:'Loss fountain',battle_map:'Battle map',armies:'Armies and trades',heroes:'Match heroes'}:animationNames;
for(const small of document.querySelectorAll('.team small'))small.textContent=english?'LOSSES':'ПОТЕРИ';
$('waterfall').setAttribute('aria-label',names[kind]);
function present(payload,published){
  hide();$('postmatch-empty').hidden=true;current=payload;groups=burstEvents(current);next=0;
  start=performance.now()-Math.max(0,Date.now()/1000-published)*1000;
  prepareTeams(current);$('map').textContent=current.map;$('game-end').textContent=fmt(current.game_seconds);
  $('mode').textContent=names[kind];$('waterfall').hidden=false;
  const isStory=kind!=='fountain';$('waterfall').classList.toggle('map-presentation',kind==='battle_map');
  $('story-scene').hidden=!isStory;$('stream').querySelector('.paths').style.display=isStory?'none':'';
  if(isStory)scene=new StoryScene($('story-scene'),current,reduce.matches);
  const stream=$('stream'),size=innerWidth<=600?38:innerWidth<=1000?58:74;
  const svg=stream.querySelector('.paths');svg.setAttribute('viewBox','0 0 '+stream.clientWidth+' '+stream.clientHeight);
  svg.replaceChildren(...current.teams.map((_,team)=>{const path=document.createElementNS('http://www.w3.org/2000/svg','path');path.style.stroke=teamColor(current,team);return path;}));
  stream.querySelectorAll('.paths path').forEach((path,team)=>{
    const motion=fountainMotion(stream.clientWidth,stream.clientHeight,size,team,2,current.flight_seconds||2.4,undefined,teamCount(current));
    const points=Array.from({length:41},(_,i)=>motion.point(i/40).map(v=>v+size/2));
    path.setAttribute('d',points.map((point,i)=>(i?'L':'M')+point[0].toFixed(1)+' '+point[1].toFixed(1)).join(' '));
  });
  draw();
}
function empty(status){hide();$('postmatch-empty').hidden=status==='hidden';$('postmatch-empty').textContent=english?(status==='processing'?'Analyzing replay…':status==='error'?'Match analysis unavailable. Check the smart overlay settings.':'Choose a replay in Smart overlay → Menu and prepare analysis.'):(status==='processing'?'Разбираем реплей…':status==='error'?'Анализ матча недоступен. Проверьте настройки умного оверлея.':'Откройте реплей в настройках умного оверлея → Меню и подготовьте анализ.');}
const options={kind,preview:parameters.get('preview')==='1',onPayload:present,onEmpty:empty};
let stopPolling=startPostmatchPolling(options);
reduce.onchange=()=>{stopPolling();hide();stopPolling=startPostmatchPolling(options);};
window.addEventListener('pagehide',()=>{stopPolling();hide();},{once:true});
