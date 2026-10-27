const translations={"Подтверждённые убийства": "Confirmed kills", "Состав на этом моменте": "Composition at this moment", "Потери": "Losses", "Первые герои появятся после подтверждённых убийств": "Heroes appear after confirmed kills", "Хронология начинается…": "Timeline begins…", "В этом реплее нет событий для выбранного представления": "No events in this replay for this view", "Схема мест потерь · изображение карты недоступно": "Loss locations schematic · map image unavailable", "Схема мест потерь": "Loss locations schematic", "Боевые юниты и рабочие по последним координатам реплея": "Army and workers at last replay coordinates", "Войска": "Army", "Рабочие": "Workers", "Контур — последняя позиция": "Outline: last known position", "Перемещения недоступны · только последние позиции": "Movement unavailable · last positions only", "Пока нет": "None yet", "Гибель не зарегистрирована": "Death not recorded", "Потерян": "Lost", "Убийства привязаны к конкретному юниту": "Kills attributed to a specific unit", "Реплей пока не указал конкретных убийц": "No specific killers recorded yet", "Реплей не содержит подтверждённых убийств с указанием юнита": "Replay contains no confirmed kills attributed to a unit"};
const localize=value=>document.documentElement.lang==='en'?(translations[value]||value):value;
import {ReplayStory, TroopTracks, mapPoint, containRect, transferFrames} from './replay-story.mjs?v=post-match-2';
import {teamColor} from './waterfall-model.mjs';

const node = (tag, cls, text) => {
  const e = document.createElement(tag); if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text; return e;
};
const svgNode = tag => document.createElementNS('http://www.w3.org/2000/svg', tag);

export function terrainCaption(background, english=false) {
  if(background?.source_kind==='minimap')return english?'Minimap terrain':'Подложка миникарты';
  const approximate=background?.registration?.accuracy!=='validated';
  return english?(approximate?'Map Editor export · approximate alignment':'Map Editor export'):(approximate?'Экспорт Map Editor · приблизительная привязка':'Экспорт Map Editor');
}

/** Same letterboxed rectangle for the image and world-coordinate markers. */
export function terrainGeometry(background, width, height) {
  const fit=containRect(width,height,...(background?.image_size||[]));
  return fit?{fit,bounds:background.bounds,padding:0,strict:true}:null;
}

export function unitTile(event, cls = '') {
  const tile = node('span', `story-unit ${cls}`);
  if (/^#[0-9a-f]{6}$/i.test(event.owner_color || '')) tile.style.borderColor = event.owner_color;
  tile.title = `${event.unit} · ${event.owner_name || ''}`;
  const label = node('span', 'unit-fallback', event.unit || '?'); tile.append(label);
  if (event.icon) {
    const img = node('img'); img.alt = ''; img.src = '/api/battle/icons/' + encodeURIComponent(event.icon);
    img.onload = () => label.remove(); img.onerror = () => img.remove(); tile.prepend(img);
  }
  if (event.count > 1) tile.append(node('b', '', event.count));
  return tile;
}

export class StoryScene {
  constructor(root, payload, reduced) {
    this.root = root; this.payload = payload; this.reduced = reduced;
    this.model = new ReplayStory(payload); this.tracks=new TroopTracks(payload); this.animations = new Set();
    this.revision = -1; this.columns = []; this.rowNodes = Array.from({length:this.model.teamCount},()=>new Map()); this.heroNodes = new Map();
    root.replaceChildren(); root.className = `story-scene ${payload.animation}`;
    if(this.model.teamCount>2){root.classList.add('multi-team');root.style.setProperty('--team-columns',Math.min(4,this.model.teamCount));root.style.setProperty('--team-rows',Math.ceil(this.model.teamCount/Math.min(4,this.model.teamCount)));}
    const ledgers=this.model.teamCount>2?node('div','multi-team-ledgers'):root;
    if(ledgers!==root)root.append(ledgers);
    for (let team = 0; team < this.model.teamCount; team++) {
      const column = node('div', `story-column side-${team}`);
      column.style.setProperty('--team-color',teamColor(payload,team));
      if(this.model.teamCount>2)column.append(node('div','column-team',payload.teams[team].label));
      column.append(node('div', 'column-label', payload.animation === 'heroes' ? localize('Подтверждённые убийства') : payload.animation === 'armies' ? localize('Состав на этом моменте') : localize('Потери')));
      const rows = node('div', 'story-rows'); column.append(rows);
      const note = node('div', 'column-note'); column.append(note);
      ledgers.append(column); this.columns.push({column, rows, note});
    }
    if (payload.animation === 'battle_map') this.buildMap();
    this.empty = node('p', 'story-empty'); root.append(this.empty);
    this.empty.textContent = payload.animation === 'heroes' ? localize('Первые герои появятся после подтверждённых убийств') : localize('Хронология начинается…');
    if (!this.model.events.length) this.empty.textContent = localize('В этом реплее нет событий для выбранного представления');
  }

  buildMap() {
    this.chart = node('div', 'battle-chart');
    const background=this.payload.map_background;
    if (background?.status==='ready' && /^\/api\/overlay\/maps\/[a-f0-9]{64}\/image$/.test(background.url||'') && containRect(1,1,...(background.image_size||[]))) {
      this.root.classList.add('terrain-map');
      this.terrain=node('img','terrain-image');this.terrain.alt='';this.terrain.src=background.url;
      const unavailable=()=>{this.terrainReady=false;this.terrain?.remove();this.terrain=null;this.root.classList.remove('terrain-map');this.caption.textContent=localize('Схема мест потерь · изображение карты недоступно');this.drawTroops(this.lastElapsed??0);};
      this.terrain.onload=()=>{
        if(this.terrain.naturalWidth!==background.image_size[0]||this.terrain.naturalHeight!==background.image_size[1]){unavailable();return;}
        this.terrainReady=true;this.caption.textContent=terrainCaption(background,document.documentElement.lang==='en');
        // A reopened source may already hold its final frame: redraw after the local image loads.
        this.drawTroops(this.lastElapsed??0);
      };
      this.terrain.onerror=unavailable;
      this.chart.append(this.terrain);
    }
    const svg = svgNode('svg'); svg.setAttribute('viewBox', '0 0 1000 600'); svg.setAttribute('preserveAspectRatio', 'none');
    for (let i = 1; i < 10; i++) {
      const path = svgNode('path'); path.setAttribute('d', `M${i*100},0V600 M0,${i*60}H1000`); svg.append(path);
    }
    this.caption=node('span','chart-caption',localize('Схема мест потерь'));
    this.chart.append(svg, this.caption);
    this.troopCanvas=node('canvas','troop-layer');this.troopCanvas.setAttribute('role','img');
    this.troopCanvas.setAttribute('aria-label',localize('Боевые юниты и рабочие по последним координатам реплея'));
    this.chart.append(this.troopCanvas);
    this.legend=node('div','troop-legend');
    this.legend.append(node('i','army-symbol'),node('span','',localize('Войска')),node('i','worker-symbol'),node('span','',localize('Рабочие')),node('span','stale-legend',localize('Контур — последняя позиция')));
    if(this.payload.story?.movement?.status==='unavailable')this.legend.append(node('span','stale-legend',localize('Перемещения недоступны · только последние позиции')));
    this.root.append(this.legend);
    this.root.append(this.chart);
  }

  mapGeometry() {
    if(this.terrain && !this.terrainReady)return null;
    const background=this.payload.map_background,terrain=!!this.terrainReady;
    const rect=this.chart.getBoundingClientRect(),root=this.root.getBoundingClientRect();
    const geometry=terrain?terrainGeometry(background,rect.width,rect.height):{fit:{x:0,y:0,width:rect.width,height:rect.height},bounds:this.payload.story?.bounds,padding:.06,strict:false};
    return geometry?{rect,root,...geometry}:null;
  }

  drawTroops(elapsed) {
    this.tracks.advance(elapsed);
    const ctx=this.troopCanvas.getContext('2d'),geometry=this.mapGeometry();
    if(!ctx || !geometry)return;
    const {rect,fit,bounds,padding,strict}=geometry,ratio=Math.min(devicePixelRatio||1,2);
    if(this.troopCanvas.width!==Math.round(rect.width*ratio)||this.troopCanvas.height!==Math.round(rect.height*ratio)){
      this.troopCanvas.width=Math.round(rect.width*ratio);this.troopCanvas.height=Math.round(rect.height*ratio);
    }
    ctx.setTransform(ratio,0,0,ratio,0,0);ctx.clearRect(0,0,rect.width,rect.height);
    let shown=0;
    for(const troop of this.tracks.troops(this.model.units,elapsed,this.reduced)){
      const point=mapPoint(bounds,troop.x,troop.y,padding,strict);if(!point)continue;
      const x=fit.x+point[0]*fit.width,y=fit.y+point[1]*fit.height;
      const radius=troop.category==='worker'?2.5:4;
      ctx.globalAlpha=troop.stale?.65:1;
      ctx.fillStyle=/^#[0-9a-f]{6}$/i.test(troop.owner_color||'')?troop.owner_color:teamColor(this.payload,troop.team);
      ctx.strokeStyle=ctx.fillStyle;ctx.lineWidth=1.4;ctx.beginPath();
      if(troop.category==='worker')ctx.rect(x-radius,y-radius,radius*2,radius*2);else ctx.arc(x,y,radius,0,Math.PI*2);
      const playerColor=ctx.fillStyle;
      ctx.strokeStyle='#eef3f2';ctx.lineWidth=troop.stale?2.8:1.8;ctx.stroke();
      if(!troop.stale)ctx.fill();
      ctx.strokeStyle=playerColor;ctx.lineWidth=troop.stale?1.3:.7;
      ctx.stroke();shown++;
    }
    ctx.globalAlpha=1;
    this.troopCanvas.dataset.markerCount=shown;
  }

  animate(tile, frames, age = 0, seconds = 1.1) {
    // A crowded battle never creates an unbounded number of compositor layers.
    if (this.animations.size >= 96 || age >= seconds) {tile.remove(); return;}
    this.root.append(tile);
    const a = tile.animate(frames, {duration: seconds*1000, easing: 'linear', fill: 'forwards'});
    a.currentTime = Math.max(0, age)*1000; this.animations.add(a);
    a.onfinish = () => {tile.remove(); this.animations.delete(a);};
  }

  emit(event, from, to, age) {
    const tile = unitTile(event, 'story-flight');
    const frames = this.reduced ? [{opacity: 0}, {opacity: 1, offset: .15}, {opacity: 1, offset: .7}, {opacity: 0}] : transferFrames(from, to);
    if (this.reduced) tile.style.transform = `translate(${from[0]}px,${from[1]}px)`;
    this.animate(tile, frames, age);
  }

  mapDeath(event, age) {
    const geometry=this.mapGeometry();if(!geometry)return;
    const {rect,root,fit,bounds,padding,strict}=geometry;
    const point = mapPoint(bounds, event.x, event.y, padding,strict);
    if (!point || !this.chart || age >= 1.1) return;
    const from = [rect.left - root.left + fit.x + point[0]*fit.width - 20, rect.top - root.top + fit.y + point[1]*fit.height - 20];
    const target = this.columns[event.team].column.getBoundingClientRect();
    const to = [target.left - root.left + target.width/2 - 20, Math.min(root.height - 40, target.top-root.top+target.height/2)];
    this.emit(event, from, to, age);
    const ring = node('span', `battle-pulse side-${event.team}`);
    ring.style.left = `${from[0]}px`; ring.style.top = `${from[1]}px`;
    if (/^#[0-9a-f]{6}$/i.test(event.owner_color || '')) ring.style.borderColor = event.owner_color;
    this.animate(ring, this.reduced ? [{opacity: .7}, {opacity: 0}] : [{transform: 'scale(.95)', opacity: .8}, {transform: 'scale(2.5)', opacity: 0}], age, 1.1);
  }

  rows(team, values, limit) {
    const {rows, note} = this.columns[team], wanted = new Set();
    for (const value of values.slice(0, limit)) {
      const key = `${value.owner_pid}:${value.unit}`; wanted.add(key);
      let entry = this.rowNodes[team].get(key);
      if (!entry) {
        const row = node('div', 'army-row'); row.append(unitTile({...value,count:1}));
        const name = node('span', 'army-name', value.unit), count = node('strong', 'army-count');
        row.append(name, count); entry = {row, count}; this.rowNodes[team].set(key, entry);
      }
      entry.count.textContent = value.count; rows.append(entry.row);
    }
    for (const [key, entry] of this.rowNodes[team]) if (!wanted.has(key)) {entry.row.remove(); this.rowNodes[team].delete(key);}
    const total = values.reduce((sum, r) => sum + r.count, 0), visible = values.slice(0, limit).reduce((sum, r) => sum + r.count, 0);
    note.textContent = values.length > limit ? (document.documentElement.lang==='en'?`More: ${values.length-limit} types · ${total-visible} units`:`Ещё ${values.length-limit} типов · ${total-visible} объектов`) : values.length ? (document.documentElement.lang==='en'?`${total} units`:`${total} объектов`) : localize('Пока нет');
  }

  heroes(team) {
    const count = Math.max(1, Math.min(3, Math.floor(this.columns[team].rows.clientHeight/(innerWidth<=600?82:112))));
    const {rows, note} = this.columns[team], leaders = this.model.leaders(team,count);
    const wanted = new Set(leaders.map(h => h.tag));
    for (const child of [...rows.children]) if (!wanted.has(Number(child.dataset.tag))) child.remove();
    for (const hero of leaders) {
      let entry = this.heroNodes.get(hero.tag), isNew = !entry;
      const signature = JSON.stringify([hero.unit.unit,hero.unit.team,hero.unit.owner_pid,hero.unit.owner_name,hero.unit.owner_color,hero.unit.alive,hero.kills,[...hero.victims].map(([key,v])=>[key,v.count])]);
      if (entry?.signature===signature) {rows.append(entry.card);continue;}
      const card = entry?.card || node('div', 'hero-card'); card.dataset.tag = hero.tag;
      card.replaceChildren(unitTile(hero.unit));
      const details = node('div', 'hero-details');
      details.append(node('strong', '', hero.unit.unit), node('span', 'hero-owner', hero.unit.owner_name));
      details.append(node('small', '', hero.unit.alive ? localize('Гибель не зарегистрирована') : localize('Потерян')));
      const score = node('strong', 'hero-score', hero.kills); score.title = localize('Подтверждённые убийства');
      card.append(details, score);
      const victims = node('div', 'hero-victims');
      const list = [...hero.victims.values()].sort((a,b) => b.count-a.count);
      list.slice(0,4).forEach(v => victims.append(unitTile(v)));
      if (list.length > 4) victims.append(node('span', '', (document.documentElement.lang==='en'?`+${list.length-4} types`:`+${list.length-4} типов`)));
      card.append(victims); rows.append(card);
      if (isNew && !this.reduced && this.animations.size < 96) {
        const a = card.animate([{transform:`translateX(${team?12:-12}px)`,opacity:.2},{transform:'translateX(0)',opacity:1}],{duration:200,easing:'cubic-bezier(0.23,1,0.32,1)'});
        this.animations.add(a); a.onfinish=()=>this.animations.delete(a);
      }
      entry = {card, team, signature}; this.heroNodes.set(hero.tag, entry);
    }
    note.textContent = leaders.length ? localize('Убийства привязаны к конкретному юниту') : localize('Реплей пока не указал конкретных убийц');
  }

  draw(elapsed) {
    this.lastElapsed=elapsed;
    const changes = this.model.advance(elapsed);
    if(this.payload.animation==='battle_map')this.drawTroops(elapsed);
    const layout = `${this.root.clientWidth}:${this.root.clientHeight}`;
    if (this.revision !== this.model.revision || this.layout !== layout) {
      this.layout = layout;
      this.revision = this.model.revision;
      const limit = Math.max(1, Math.min(8, Math.floor(this.columns[0].rows.clientHeight/(innerWidth<=600?34:44))));
      for (let team = 0; team < this.columns.length; team++) {
        if (this.payload.animation === 'heroes') this.heroes(team);
        else this.rows(team, this.payload.animation === 'armies' ? this.model.composition(team) : [...this.model.losses[team].values()].sort((a,b) => b.count-a.count), limit);
      }
      const any = this.payload.animation === 'heroes' ? this.model.heroes.size : ['armies','battle_map'].includes(this.payload.animation) ? this.model.units.size : this.model.losses.some(m=>m.size);
      this.empty.hidden = !!any;
    }
    if (!this.model.heroes.size && elapsed >= this.payload.timeline_seconds && this.payload.animation === 'heroes') this.empty.textContent = localize('Реплей не содержит подтверждённых убийств с указанием юнита');
    for (const death of changes.deaths) {
      if (this.payload.animation === 'battle_map') this.mapDeath(death, elapsed-death.at);
      else if (this.payload.animation === 'armies') {
        const root = this.root.getBoundingClientRect();
        const row = this.rowNodes[death.team].get(`${death.owner_pid}:${death.unit}`)?.row.getBoundingClientRect();
        const column=this.columns[death.team].column.getBoundingClientRect();
        const from = row ? [row.left-root.left, row.top-root.top] : [column.left-root.left+column.width*.5, column.top-root.top+column.height*.5];
        this.emit(death, from, [column.left-root.left+column.width*.5, column.bottom-root.top-40], elapsed-death.at);
      } else if (this.payload.animation === 'heroes' && death.killer_tag != null) {
        const hero = this.heroNodes.get(death.killer_tag)?.card;
        if (hero?.isConnected) {
          const root = this.root.getBoundingClientRect(), rect = hero.getBoundingClientRect();
          this.emit(death, [root.width/2-20, root.height*.75], [rect.left-root.left+rect.width*.6, rect.top-root.top+rect.height*.5], elapsed-death.at);
        }
      }
    }
    if (this.payload.animation === 'armies') for (const arrival of changes.arrivals) {
      const row = this.rowNodes[arrival.team]?.get(`${arrival.owner_pid}:${arrival.unit}`)?.row;
      if (row && arrival.ready !== false) {
        const root = this.root.getBoundingClientRect(), rect = row.getBoundingClientRect();
        this.emit(arrival, [root.width/2-20, root.height-40], [rect.left-root.left, rect.top-root.top], elapsed-arrival.at);
      }
    }
  }

  dispose() {
    if(this.terrain){this.terrain.onload=null;this.terrain.onerror=null;}
    for (const a of this.animations) a.cancel(); this.animations.clear(); this.root.replaceChildren();
  }
}
