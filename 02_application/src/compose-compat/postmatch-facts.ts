/** Portable tracker facts for the four post-match presentations. No inferred prices or routes. */
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { extname, isAbsolute } from "node:path";
import bundledIcons from "../../resources/postmatch-icons/registry.json" with { type: "json" };
import { primaryMapHash } from "./map-assets.js";

const require = createRequire(import.meta.url);
export const POSTMATCH_PARSER = "compose-postmatch-tracker-v3-map-identity";
const MAX_STORY = 50_000, MAX_MOVEMENT = 40_000, MAX_RESOURCES = 20_000, MAX_DEATHS = 10_000;
const TEMPORARY = new Set(["MULE", "KD8Charge", "AutoTurret", "AdeptPhaseShift", "LocustMP", "LocustMPFlying", "Broodling", "BroodlingEscort", "InfestedTerran", "ForceField", "DisruptorPhased"]);
const TRACKER_TYPES = ["SPlayerSetupEvent", "SUnitBornEvent", "SUnitInitEvent", "SUnitDoneEvent", "SUnitTypeChangeEvent", "SUnitOwnerChangeEvent", "SUnitDiedEvent", "SUpgradeEvent", "SUnitPositionsEvent", "SPlayerStatsEvent"].map(n => `NNet.Replay.Tracker.${n}`);
const iconRegistry = bundledIcons as {icons:Record<string,unknown>;aliases:Record<string,string>};
export function postmatchIcon(unit:unknown):string|null {if(typeof unit!=="string")return null;const raw=unit.toUpperCase(),key=iconRegistry.aliases[raw]??raw;return Object.hasOwn(iconRegistry.icons,key)?key:null;}
type Json = Record<string, unknown>;
export type TrackerEvent = { readonly eventType: string; readonly gameloop: number; readonly payload?: Json | null };
export type PostmatchPlayer = { readonly pid: number; readonly name: string; readonly team: number; readonly color: string | null };
type Category = "army" | "worker" | "building" | "other" | "unknown";
type Unit = { tag: number; unit: string; owner_pid: number | null; ready: boolean; x: number | null; y: number | null; position_tick: number; position_basis: string; position_epoch: number };
export type FactsInput = { readonly elapsed: number; readonly gameSeconds: number; readonly map: string; readonly players: readonly PostmatchPlayer[]; readonly events: Iterable<TrackerEvent>; readonly id?: string; readonly duration?: number; readonly category?: (unit: string) => Category };
const object = (v: unknown): Json => v && typeof v === "object" && !Array.isArray(v) ? v as Json : {};
const integer = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const coordinate = (v: unknown): number | null => typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= 1_000_000 ? v : null;
function text(v: unknown, limit = 128): string { return (Buffer.isBuffer(v) || v instanceof Uint8Array ? Buffer.from(v).toString("utf8") : typeof v === "string" ? v : "").slice(0, limit); }
function unitType(v: unknown): string { const name = text(v); if (!name) throw Error("Tracker unit type is missing"); return name; }
export function trackerTag(event: Json, prefix = "m_unitTag"): number | null {
  const index = event[`${prefix}Index`], recycle = event[`${prefix}Recycle`];
  if (!integer(index) || !integer(recycle) || recycle >= 262144) return null;
  const tag = index * 262144 + recycle;
  return Number.isSafeInteger(tag) ? tag : null;
}
function color(value: unknown): string | null {
  const rgb = object(value), channels = [rgb.m_r, rgb.m_g, rgb.m_b];
  return channels.every(v => integer(v) && v <= 255) ? "#" + channels.map(v => (v as number).toString(16).padStart(2, "0")).join("") : null;
}

/** Authoritative tracker PID joined via lobby working-set slots; never assume pid=index+1. */
export function postmatchRoster(details: Json, init: Json, setup: readonly TrackerEvent[]): PostmatchPlayer[] {
  if (!Array.isArray(details.m_playerList) || details.m_playerList.length > 32) throw Error("Unsupported replay roster");
  const sync = object(init.m_syncLobbyState), lobby = object(sync.m_lobbyState), slots = Array.isArray(lobby.m_slots) ? lobby.m_slots.map(object) : [];
  const bySlot = new Map<number, Json>();
  for (const event of setup) {
    const p = event.payload ?? {}, slot = p.m_slotId;
    if (!integer(slot) || !integer(p.m_playerId) || p.m_playerId === 0) throw Error("Invalid tracker player setup");
    const old = bySlot.get(slot);
    if (old && (old.m_playerId !== p.m_playerId || old.m_userId !== p.m_userId)) throw Error("Conflicting tracker player setup");
    bySlot.set(slot, p);
  }
  const players: PostmatchPlayer[] = [];
  for (const raw of details.m_playerList) {
    const item = object(raw);
    if (item.m_observe !== undefined && item.m_observe !== 0) continue;
    const working = item.m_workingSetSlotId;
    if (!integer(working) || !integer(item.m_teamId)) throw Error("Replay player slot/team is missing");
    const matching = slots.map((slot, index) => ({slot, index})).filter(({slot}) => slot.m_workingSetSlotId === working);
    if (slots.length && matching.length !== 1) throw Error("Working-set slot is ambiguous");
    const matched = matching[0], setupPlayer = bySlot.get(matched ? matched.index : working);
    if (!setupPlayer || !integer(setupPlayer.m_playerId)) throw Error("Replay player has no authoritative tracker PID");
    if (matched && matched.slot.m_userId != null && setupPlayer.m_userId != null && matched.slot.m_userId !== setupPlayer.m_userId) throw Error("Lobby and tracker player identities disagree");
    const name = text(item.m_name);
    if (!name) throw Error("Replay player name is missing");
    players.push({pid: setupPlayer.m_playerId, name, team: item.m_teamId, color: color(item.m_color)});
  }
  if (players.length < 2 || new Set(players.map(p => p.pid)).size !== players.length || new Set(players.map(p => p.team)).size < 2) throw Error("Post-match widgets require at least two identified teams");
  return players;
}

/** Pure causal projection, also used with synthetic tracker streams in tests. */
export function buildPostmatchFacts(input: FactsInput): Json {
  const { elapsed, gameSeconds } = input, duration = input.duration ?? 20;
  if (!integer(elapsed) || elapsed === 0 || !Number.isFinite(gameSeconds) || gameSeconds <= 120) throw Error("Post-match widgets require a replay longer than two minutes with a supported clock");
  if (!Number.isFinite(duration) || duration < 3 || duration > 120) throw Error("Post-match duration must be 3–120 seconds");
  const teamIds = [...new Set(input.players.map(p => p.team))].sort((a,b) => a-b);
  if (input.players.length < 2 || input.players.length > 32 || teamIds.length < 2 || new Set(input.players.map(p => p.pid)).size !== input.players.length || input.players.some(p => !integer(p.pid) || p.pid === 0 || p.pid > 32 || !integer(p.team) || !p.name)) throw Error("Post-match widgets require at least two identified teams (up to 32 players)");
  const players = input.players.map(p => ({...p, name: text(p.name), team: teamIds.indexOf(p.team), color: typeof p.color === "string" && /^#[0-9a-f]{6}$/i.test(p.color) ? p.color : null}));
  const palette = new Map(players.map(p => [p.pid,p])), owners = new Map(players.map(p => [p.pid,p.team]));
  const classify = input.category ?? (() => "unknown" as const);
  const units = new Map<number,Unit>(), retired = new Map<number,Unit>(), active = new Map<number,number>(), sampleEpoch = new Map<number,number>();
  const story: Json[] = [], movement: Json[] = [], deaths: Json[] = [], stats: Json[] = [], sampled = new Set<number>();
  let sequence = 0, previousTick = -1, movementError: string | null = null, unknownSamples = 0, minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const point = (x: number | null,y: number | null) => {if (x !== null && y !== null) { minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y); }};
  const eligible = (unit: Unit) => unit.owner_pid !== null && owners.has(unit.owner_pid) && !TEMPORARY.has(unit.unit);
  const append = (event: Json) => { if (story.length >= MAX_STORY) throw Error("Too many lifecycle events for the post-match widget"); story.push(event); };
  for (const event of input.events) {
    if (++sequence > 1_000_000) throw Error("Replay exceeds the tracker event limit");
    const tick = event.gameloop, p = event.payload ?? {}, kind = event.eventType.split(".").at(-1);
    if (!integer(tick) || tick > elapsed || tick < previousTick) throw Error("Tracker event is outside the ordered game timeline"); previousTick=tick;
    const base = {tick,sequence:sequence-1}, tag = trackerTag(p);
    if (kind === "SUnitBornEvent" || kind === "SUnitInitEvent") {
      if (tag === null || !integer(p.m_unitTagIndex)) throw Error("Invalid tracker unit identity");
      const unit: Unit={tag,unit:unitType(p.m_unitTypeName),owner_pid:integer(p.m_upkeepPlayerId)?p.m_upkeepPlayerId:null,ready:kind === "SUnitBornEvent",x:coordinate(p.m_x),y:coordinate(p.m_y),position_tick:tick,position_basis:"birth",position_epoch:0};
      point(unit.x,unit.y);
      const previous = active.get(p.m_unitTagIndex); if (previous !== undefined && previous !== tag) { const old = units.get(previous); if (old) retired.set(previous,old); units.delete(previous); }
      active.set(p.m_unitTagIndex,tag);units.set(tag,unit);sampleEpoch.set(tag,0);
      if (units.size + retired.size > 100_000) throw Error("Too many tracker unit identities");
      if (eligible(unit)) append({...base,...unit,kind:"spawn"});
    } else if (kind === "SUnitPositionsEvent") {
      let index = p.m_firstUnitIndex; const items = p.m_items;
      if (!integer(index) || !Array.isArray(items) || items.length % 3 || items.length > 120_000) {movementError="Invalid or oversized tracker position samples";continue;}
      for (let offset=0;offset<items.length;offset+=3) {
        const delta=items[offset],x=coordinate(items[offset+1]),y=coordinate(items[offset+2]);
        if (!integer(delta) || x === null || y === null || !Number.isSafeInteger(index+delta)) {movementError="Invalid tracker position samples";break;}
        index+=delta;const identity=active.get(index),unit=identity===undefined?undefined:units.get(identity);if (!unit) continue;
        const gap=tick-unit.position_tick, distance=unit.x===null||unit.y===null?Infinity:Math.hypot(x-unit.x,y-unit.y);
        const sameEpoch=unit.position_epoch===sampleEpoch.get(unit.tag),canConnect=sameEpoch&&gap>0&&gap<=480&&distance<=16;
        if (!canConnect&&sameEpoch) unit.position_epoch++;
        sampleEpoch.set(unit.tag,unit.position_epoch);Object.assign(unit,{x,y,position_tick:tick,position_basis:"tracker_sample"});
        if (!eligible(unit)) continue; const category=classify(unit.unit);if (category==="unknown") unknownSamples++;
        if (category!=="army"&&category!=="worker") continue;
        point(x,y);sampled.add(unit.tag);
        if (movement.length>=MAX_MOVEMENT) {movementError="Too many position samples for the battle map";continue;}
        movement.push({...base,sample_index:offset/3,tag:unit.tag,owner_pid:unit.owner_pid,unit:unit.unit,category,x,y,position_epoch:unit.position_epoch,gap_ticks:gap,can_connect:canConnect});
      }
    } else if (kind === "SUnitDoneEvent" && tag !== null && units.has(tag)) {
      const unit=units.get(tag)!;if (!unit.ready) {unit.ready=true;if(eligible(unit)) append({...base,...unit,kind:"ready"});}
    } else if ((kind === "SUnitTypeChangeEvent" || kind === "SUnitOwnerChangeEvent") && tag !== null && units.has(tag)) {
      const unit=units.get(tag)!,wasEligible=eligible(unit),previousOwner=unit.owner_pid;unit.position_epoch++;
      if (kind === "SUnitTypeChangeEvent") unit.unit=unitType(p.m_unitTypeName);else unit.owner_pid=integer(p.m_upkeepPlayerId)?p.m_upkeepPlayerId:null;
      if (wasEligible||eligible(unit)) append({...base,...unit,kind:kind === "SUnitTypeChangeEvent"?"type":"owner",previous_owner_pid:previousOwner,eligible:eligible(unit)});
    } else if (kind === "SUnitDiedEvent") {
      if (deaths.length >= MAX_DEATHS) throw Error("Too many deaths for the post-match widget");
      const unit=tag===null?undefined:units.get(tag),killerPid=integer(p.m_killerPlayerId)?p.m_killerPlayerId:null;
      const enemy=!!unit&&eligible(unit)&&killerPid!==null&&owners.has(killerPid)&&owners.get(unit.owner_pid!)!==owners.get(killerPid);
      let killerTag=trackerTag(p,"m_killerUnitTag"),killer=killerTag===null?undefined:units.get(killerTag)??retired.get(killerTag);
      if (!enemy||!killer||killer.owner_pid!==killerPid||!eligible(killer)) killerTag=null;
      const death={...base,kind:"death",tag,unit:unit?.unit??"Unknown",owner_pid:unit?.owner_pid??null,x:coordinate(p.m_x),y:coordinate(p.m_y),killer_pid:killerPid,killer_tag:killerTag,enemy_kill_candidate:enemy,combat_loss_verified:false};
      deaths.push(death);
      if (!unit||tag===null) continue;
      units.delete(tag);retired.set(tag,unit);if(integer(p.m_unitTagIndex)&&active.get(p.m_unitTagIndex)===tag) active.delete(p.m_unitTagIndex);
      if(eligible(unit)) append({...base,...unit,...death,position_tick:tick,position_basis:"death"});
    } else if (kind === "SUpgradeEvent" && integer(p.m_playerId) && owners.has(p.m_playerId)) {
      append({...base,kind:"upgrade",owner_pid:p.m_playerId,upgrade:unitType(p.m_upgradeTypeName),count:integer(p.m_count)?p.m_count:null});
    } else if (kind === "SPlayerStatsEvent") {
      if(stats.length>=MAX_RESOURCES) throw Error("Too many resource snapshots for the widget");
      if (!integer(p.m_playerId)) continue; const raw=object(p.m_stats);
      const values=["Minerals","Vespene"].flatMap(resource=>["Army","Economy","Technology"].map(category=>raw[`m_scoreValue${resource}Lost${category}`]));
      const valid=values.every(integer),minerals=valid?(values.slice(0,3) as number[]).reduce((a,b)=>a+b,0):null,gas=valid?(values.slice(3) as number[]).reduce((a,b)=>a+b,0):null;
      stats.push({tick,pid:p.m_playerId,minerals:integer(minerals)?minerals:null,gas:integer(gas)?gas:null});
    }
  }
  if (story.length+movement.length>MAX_STORY) movementError="Lifecycle and movement samples exceed the battle map limit";
  const flight=Math.min(4.8,duration*.24),timeline=duration-flight-.5;
  const mapped=(event:Json):Json=>{const owner=palette.get(event.owner_pid as number);return {...event,team:owner?.team??null,owner_name:owner?.name??null,owner_color:owner?.color??null,icon:postmatchIcon(event.unit),at:(event.tick as number)/elapsed*timeline};};
  const mappedStory=story.map(event=>({...mapped(event),category:classify(typeof event.unit==="string"?event.unit:"")}));
  const events=deaths.filter(d=>d.enemy_kill_candidate===true).map((d,index)=>({...mapped(d),id:String(index)}));
  const latest=new Map<number,[number,number]|null>(), resourceTimeline:Json[]=[];
  stats.sort((a,b)=>(a.tick as number)-(b.tick as number)||(a.pid as number)-(b.pid as number));
  for(const sample of stats) {const pid=sample.pid as number,team=owners.get(pid);if(team===undefined)continue;latest.set(pid,integer(sample.minerals)&&integer(sample.gas)?[sample.minerals,sample.gas]:null);const members=players.filter(p=>p.team===team);const complete=members.every(p=>latest.get(p.pid)!=null);const totals=complete?[0,1].map(i=>members.reduce((sum,p)=>sum+latest.get(p.pid)![i],0)):[null,null];const valid=totals.every(integer);resourceTimeline.push({tick:sample.tick,at:(sample.tick as number)/elapsed*timeline,team,minerals:valid?totals[0]:null,gas:valid?totals[1]:null});}
  return {id:input.id??createHash("sha256").update(JSON.stringify({elapsed,gameSeconds,players,story:mappedStory,events,resourceTimeline})).digest("hex"),animation:"fountain",duration,flight_seconds:flight,timeline_seconds:timeline,game_seconds:gameSeconds,elapsed_gameloops:elapsed,map:text(input.map,256),players,teams:teamIds.map((_,team)=>({label:players.filter(p=>p.team===team).map(p=>p.name).join(" + ").slice(0,512)})),events,resource_timeline:resourceTimeline,resource_basis:"PlayerStats Lost Army+Economy+Technology; latest snapshot, no interpolation",excluded:deaths.length-events.length,policy:"enemy_kill_candidates_not_verified_combat_losses",map_background:{status:"unavailable",basis:"tracker_events_not_continuous_positions",reason:"Локальная карта недоступна; показана схема"},story:{schema_version:1,events:mappedStory,bounds:Number.isFinite(minX)?{min_x:minX,max_x:maxX,min_y:minY,max_y:maxY}:null,basis:"tracker_events_not_continuous_positions",movement:{schema_version:1,status:movementError?"unavailable":"available",basis:"SUnitPositionsEvent_approximate_samples_not_continuous_paths",samples:movementError?[]:movement.map(mapped),sampled_units:sampled.size,unknown_samples:unknownSamples,game_clock_hz:22.4,max_connect_ticks:480,fresh_ticks:240,max_connect_distance:16,cargo:"not_observed_by_tracker_no_route_inference",...(movementError?{reason:movementError}:{})}}};
}

type DecodeContext = {header:Json;details:Json;protocol:{decodeReplayInitData(bytes:unknown):Json;iterateTrackerEvents(bytes:unknown,options:{decode:"full";eventTypes:readonly string[]}):Iterable<TrackerEvent>};readFile(name:string):Promise<Buffer>;close():Promise<void>};
export function collectTrackerSetup(events:Iterable<TrackerEvent>):TrackerEvent[] {
  const setup:TrackerEvent[]=[];let rawCount=0;
  for(const event of events) {
    if(++rawCount>1_000_000)throw Error("Replay exceeds the tracker event limit");
    // Selection skips unselected payloads, not the events themselves.
    if(event.eventType!==TRACKER_TYPES[0])continue;
    if(setup.length>=128)throw Error("Too many tracker player setup events");
    setup.push(event);
  }
  return setup;
}
export async function readPostmatchFacts(replayPath: string, duration = 20): Promise<Json> {
  if (!isAbsolute(replayPath)||extname(replayPath).toLowerCase()!==".sc2replay") throw Error("Choose an absolute local .SC2Replay path");
  const before=await lstat(replayPath);
  if (!before.isFile()||before.isSymbolicLink()||before.size<=0||before.size>64*1024*1024) throw Error("Replay exceeds supported size or is not a regular file");
  const {decodeReplay}=require("@replaysremastered/sc2readerjs/src/replay/decode") as {decodeReplay(path:string):Promise<DecodeContext>};
  const ctx=await decodeReplay(replayPath);
  try {
    if (ctx.header.m_useScaledTime!==true||ctx.details.m_gameSpeed!==4) throw Error("Post-match widgets require a supported modern scaled Faster game clock");
    const elapsed=ctx.header.m_elapsedGameLoops;
    if(!integer(elapsed)) throw Error("Replay game duration is missing");
    const tracker=await ctx.readFile("replay.tracker.events");if(tracker.length>128*1024*1024)throw Error("Tracker stream exceeds supported size");
    const init=ctx.protocol.decodeReplayInitData(await ctx.readFile("replay.initData"));
    const setup=collectTrackerSetup(ctx.protocol.iterateTrackerEvents(tracker,{decode:"full",eventTypes:[TRACKER_TYPES[0]]}));
    const players=postmatchRoster(ctx.details,init,setup);
    const raw=JSON.parse(await readFile(require.resolve("@replaysremastered/sc2readerjs/src/data/units/unit_info.json"),"utf8")) as Record<string,Record<string,Json>>;
    const registry=new Map<string,Json>();for(const race of Object.values(raw))for(const [name,flags]of Object.entries(race))registry.set(name.toLowerCase(),flags);
    const category=(unit:string):Category=>{const flags=registry.get(unit.toLowerCase());return flags?flags.is_army===true?"army":flags.is_worker===true?"worker":flags.is_building===true?"building":"other":"unknown";};
    const digest=createHash("sha256");for await(const chunk of createReadStream(replayPath))digest.update(chunk);
    const id=createHash("sha256").update(digest.digest("hex")+":"+POSTMATCH_PARSER+":"+duration).digest("hex");
    const result=buildPostmatchFacts({id,elapsed,gameSeconds:elapsed/22.4,map:text(ctx.details.m_title,256),players,category,duration,events:ctx.protocol.iterateTrackerEvents(tracker,{decode:"full",eventTypes:TRACKER_TYPES})});
    result.map_sha256=primaryMapHash(ctx.details);
    const after=await lstat(replayPath);if(after.size!==before.size||after.mtimeMs!==before.mtimeMs||after.ino!==before.ino)throw Error("Replay changed during post-match analysis");
    if(Buffer.byteLength(JSON.stringify(result))>16*1024*1024)throw Error("Post-match facts exceed 16 MiB");
    return result;
  } finally {await ctx.close();}
}
