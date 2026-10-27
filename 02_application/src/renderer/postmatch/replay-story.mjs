// Causal replay state: no positions, kills or types from a future event.
import {teamCount} from './waterfall-model.mjs';
export const animationNames = Object.freeze({
  fountain: 'Фонтан потерь', battle_map: 'Карта сражений',
  armies: 'Армии и размены', heroes: 'Герои матча',
});

export function mapPoint(bounds, x, y, padding = .06, strict = false) {
  if (!bounds || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  const dx = bounds.max_x - bounds.min_x, dy = bounds.max_y - bounds.min_y;
  if (!(dx > 0) || !(dy > 0)) return null;
  if (strict && (x < bounds.min_x || x > bounds.max_x || y < bounds.min_y || y > bounds.max_y)) return null;
  return [padding + (1-2*padding) * Math.max(0, Math.min(1, (x - bounds.min_x) / dx)),
    padding + (1-2*padding) * (1 - Math.max(0, Math.min(1, (y - bounds.min_y) / dy)))];
}

export function containRect(width, height, imageWidth, imageHeight) {
  if (![width,height,imageWidth,imageHeight].every(v=>Number.isFinite(v)&&v>0)) return null;
  const scale=Math.min(width/imageWidth,height/imageHeight),w=imageWidth*scale,h=imageHeight*scale;
  return {x:(width-w)/2,y:(height-h)/2,width:w,height:h};
}

export function transferFrames(from, to) {
  // A shallow arc connects the loss location to its team's ledger.
  return Array.from({length: 17}, (_, i) => {
    const t = i / 16, u = 1 - t;
    const cx = (from[0] + to[0]) / 2, cy = Math.min(from[1], to[1]) - 50;
    const x = u*u*from[0] + 2*u*t*cx + t*t*to[0];
    const y = u*u*from[1] + 2*u*t*cy + t*t*to[1];
    return {offset: t, transform: `translate(${x}px,${y}px) scale(${1 - .25*t})`,
      opacity: Math.min(1, t / .1, (1 - t) / .15)};
  });
}

// Display smoothing uses two already observed samples, never a future position.
// Lifecycle state remains authoritative for death, owner, readiness and type.
export class TroopTracks {
  constructor(payload) {
    this.payload=payload;
    this.movement=payload.story?.movement;
    this.samples=this.movement?.schema_version===1 ? this.movement.samples || [] : [];
    this.cursor=0;this.positions=new Map();
    this.freshTicks=this.movement?.fresh_ticks || 240;
    this.connectTicks=this.movement?.max_connect_ticks || 480;
  }

  advance(elapsed) {
    while(this.cursor<this.samples.length && this.samples[this.cursor].at<=elapsed){
      const sample=this.samples[this.cursor++],old=this.positions.get(sample.tag)?.last;
      this.positions.set(sample.tag,{last:sample,previous:old});
    }
  }

  troops(units,elapsed,reduced=false) {
    const tickAt=elapsed/(this.payload.timeline_seconds||1)*this.payload.elapsed_gameloops;
    const result=[];
    for(const unit of units.values()){
      if(!unit.ready || !Number.isInteger(unit.team) || unit.team<0 || unit.team>=teamCount(this.payload) || !['army','worker'].includes(unit.category))continue;
      const track=this.positions.get(unit.tag);
      const positionTick=unit.position_tick ?? unit.tick;
      let last=track?.last,previous=track?.previous;
      if(!last || positionTick>last.tick){
        last={x:unit.x,y:unit.y,tick:positionTick,at:positionTick/this.payload.elapsed_gameloops*this.payload.timeline_seconds};
        previous=null;
      }
      if(!Number.isFinite(last.x)||!Number.isFinite(last.y)||!Number.isFinite(last.tick))continue;
      let x=last.x,y=last.y;
      if(!reduced && last.can_connect && previous && previous.position_epoch===last.position_epoch &&
          last.at>previous.at && last.tick-previous.tick<=this.connectTicks && Math.hypot(x-previous.x,y-previous.y)<=16){
        const duration=Math.min(.16,(last.at-previous.at)*.6),t=Math.min(1,Math.max(0,(elapsed-last.at)/duration));
        x=previous.x+(x-previous.x)*t;y=previous.y+(y-previous.y)*t;
      }
      result.push({...unit,x,y,stale:tickAt-last.tick>this.freshTicks});
    }
    // Dead tags can never receive a marker again; limit retained presentation data.
    for(const tag of this.positions.keys())if(!units.has(tag))this.positions.delete(tag);
    return result;
  }
}

export class ReplayStory {
  constructor(payload) {
    this.events = payload.story?.schema_version === 1 ? payload.story.events : [];
    this.cursor = 0; this.elapsed = -1; this.units = new Map(); this.unitHistory = new Map();
    this.teamCount=teamCount(payload);
    this.heroes = new Map(); this.losses = Array.from({length:this.teamCount},()=>new Map());
    this.upgrades = Array.from({length:this.teamCount},()=>[]); this.revision = 0;
  }

  advance(elapsed) {
    if (elapsed < this.elapsed) throw new RangeError('Story time must move forward');
    this.elapsed = elapsed;
    const deaths = [], arrivals = [];
    while (this.cursor < this.events.length && this.events[this.cursor].at <= elapsed) {
      const e = this.events[this.cursor++]; this.revision++;
      const previous = this.units.get(e.tag);
      if (e.kind === 'spawn') {
        const unit = {...e, ready: e.ready !== false, alive: true};
        this.units.set(e.tag, unit); this.unitHistory.set(e.tag, {...unit});
        arrivals.push(e);
      } else if (['type', 'owner', 'ready'].includes(e.kind) && (previous || e.eligible === true)) {
        const updated = {...previous, ...e, alive: true, ready: e.kind === 'ready' ? true : (previous?.ready ?? e.ready)};
        if (e.eligible === false) this.units.delete(e.tag);
        else this.units.set(e.tag, updated);
        this.unitHistory.set(e.tag, {...updated});
        if (this.heroes.has(e.tag)) this.heroes.get(e.tag).unit = {...updated};
        if (e.kind === 'ready') arrivals.push(updated);
      } else if (e.kind === 'death') {
        this.units.delete(e.tag);
        if (previous) this.unitHistory.set(e.tag, {...previous, alive: false});
        if (this.heroes.has(e.tag)) this.heroes.get(e.tag).unit.alive = false;
        if (!e.enemy_kill_candidate || !Number.isInteger(e.team) || e.team<0 || e.team>=this.teamCount) continue;
        deaths.push(e);
        const key = `${e.owner_pid}:${e.unit}`, losses = this.losses[e.team];
        const loss = losses.get(key) || {...e, count: 0};
        loss.count++; losses.set(key, loss);
        const killer = this.unitHistory.get(e.killer_tag);
        // Projectile/explosion credit can follow the killer's own death.
        if (e.killer_tag == null || !killer || killer.owner_pid !== e.killer_pid || killer.team === e.team) continue;
        const hero = this.heroes.get(e.killer_tag) || {tag: e.killer_tag, unit: {...killer}, kills: 0, victims: new Map(), firstAt: e.at, lastAt: e.at};
        hero.kills++; hero.lastAt = e.at;
        const victimKey = `${e.owner_pid}:${e.unit}`, victim = hero.victims.get(victimKey) || {...e, count: 0};
        victim.count++; hero.victims.set(victimKey, victim); this.heroes.set(e.killer_tag, hero);
      } else if (e.kind === 'upgrade' && Number.isInteger(e.team) && e.team>=0 && e.team<this.teamCount) {
        this.upgrades[e.team].push(e);
      }
    }
    return {deaths, arrivals};
  }

  composition(team) {
    const rows = new Map();
    for (const unit of this.units.values()) {
      if (unit.team !== team || !unit.ready || unit.temporary || unit.category === 'other') continue;
      const key = `${unit.owner_pid}:${unit.unit}`;
      const row = rows.get(key) || {...unit, count: 0};
      row.count++; rows.set(key, row);
    }
    const categoryOrder = {army: 0, worker: 1, building: 2, unknown: 3};
    return [...rows.values()].sort((a, b) => (categoryOrder[a.category]??3) - (categoryOrder[b.category]??3) || b.count - a.count || a.unit.localeCompare(b.unit) || a.owner_pid - b.owner_pid);
  }

  leaders(team, count = 3) {
    return [...this.heroes.values()].filter(h => h.unit.team === team)
      .sort((a, b) => b.kills - a.kills || a.firstAt - b.firstAt || a.tag - b.tag).slice(0, count);
  }
}
