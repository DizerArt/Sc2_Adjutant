import { createRequire } from "node:module";
import type {
  ReplayAnalysisPlayer,
  ReplaySuspicionAnalysis,
  ReplaySuspicionEvidence,
  ReplaySuspicionEvidenceType,
  ReplaySuspicionLevel,
  ReplaySuspicionPlayer
} from "../../domain/ports/replay-analysis-reader-port.js";

const require = createRequire(import.meta.url);

const CAMERA_EVENT = "NNet.Game.SCameraUpdateEvent";
const TARGET_POINT_EVENT = "NNet.Game.SCmdUpdateTargetPointEvent";
const TARGET_UNIT_EVENT = "NNet.Game.SCmdUpdateTargetUnitEvent";
const UNIT_BORN_EVENT = "NNet.Replay.Tracker.SUnitBornEvent";
const UNIT_INIT_EVENT = "NNet.Replay.Tracker.SUnitInitEvent";
const UNIT_DONE_EVENT = "NNet.Replay.Tracker.SUnitDoneEvent";
const UNIT_DIED_EVENT = "NNet.Replay.Tracker.SUnitDiedEvent";
const UNIT_POSITIONS_EVENT = "NNet.Replay.Tracker.SUnitPositionsEvent";

const GAME_EVENT_TYPES = [CAMERA_EVENT, TARGET_POINT_EVENT, TARGET_UNIT_EVENT] as const;
const TRACKER_EVENT_TYPES = [
  UNIT_BORN_EVENT,
  UNIT_INIT_EVENT,
  UNIT_DONE_EVENT,
  UNIT_DIED_EVENT,
  UNIT_POSITIONS_EVENT
] as const;

const MIN_ANALYSIS_SECONDS = 120;
const CAMERA_TARGET_SCALE = 256;
const COMMAND_TARGET_SCALE = 4096;
const CAMERA_RADIUS = 14;
const COMMAND_RADIUS = 9;
const ENEMY_CAMERA_RADIUS = 10;
const ENEMY_COMMAND_RADIUS = 8;
const FRIENDLY_VISION_RADIUS = 18;
const RECENT_SCOUT_MEMORY_SECONDS = 75;
const MAX_EVIDENCE_PER_PLAYER = 12;

export type ReplaySuspicionAnalyzerFn = (
  replayPath: string,
  players: readonly ReplayAnalysisPlayer[]
) => Promise<ReplaySuspicionAnalysis>;

export async function analyzeReplaySuspicion(
  replayPath: string,
  players: readonly ReplayAnalysisPlayer[]
): Promise<ReplaySuspicionAnalysis> {
  if (players.length < 2) {
    return { players: [] };
  }

  const internals = loadSc2ReaderSuspicionInternals();
  const ctx = await internals.decodeReplay(replayPath);

  try {
    const useScaledTime = Boolean(ctx.header?.m_useScaledTime);
    const trackerEvents = await readOptionalReplayFile(ctx, "replay.tracker.events");
    const gameEvents = await readOptionalReplayFile(ctx, "replay.game.events");

    if (!trackerEvents || !gameEvents) {
      return {
        players: emptySuspicionPlayers(players),
        parseError: "Replay event streams are not available."
      };
    }

    const units = readUnitObservations(ctx, trackerEvents, internals, useScaledTime, players.length);
    const interactions = readSuspiciousInteractions(ctx, gameEvents, internals, useScaledTime, players, units);

    return scoreSuspicion(players, interactions);
  } finally {
    await ctx.close();
  }
}

export function scoreSuspicion(
  players: readonly ReplayAnalysisPlayer[],
  evidence: readonly ReplaySuspicionEvidence[]
): ReplaySuspicionAnalysis {
  return {
    players: players.map((player) => scorePlayerSuspicion(player, evidence))
  };
}

function scorePlayerSuspicion(
  player: ReplayAnalysisPlayer,
  evidence: readonly ReplaySuspicionEvidence[]
): ReplaySuspicionPlayer {
  const playerEvidence = evidence
    .filter((item) => normalizeName(item.playerName) === normalizeName(player.name))
    .sort((first, second) => second.weight - first.weight || first.seconds - second.seconds)
    .slice(0, MAX_EVIDENCE_PER_PLAYER);
  const hiddenCameraCount = playerEvidence.filter((item) => item.type === "hiddenCamera").length;
  const hiddenTargetCount = playerEvidence.filter((item) => item.type === "hiddenTarget").length;
  const broadCameraCount = playerEvidence.filter((item) => item.type === "hiddenEnemyCamera").length;
  const broadCommandCount = playerEvidence.filter((item) => item.type === "hiddenEnemyCommand").length;
  const uniqueTargetCount = new Set(playerEvidence.map((item) => item.details)).size;
  const rawWeight = groupedEvidenceWeight(playerEvidence);
  const patternBonus =
    uniqueTargetCount >= 3
      ? Math.min(
          24,
          Math.max(0, hiddenCameraCount - 2) +
            hiddenTargetCount * 3 +
            Math.floor(broadCameraCount / 2) +
            broadCommandCount * 2
        )
      : Math.min(10, hiddenTargetCount * 2 + broadCommandCount + Math.floor(broadCameraCount / 3));
  const score = clampInteger(rawWeight + patternBonus, 0, 100);
  const confidence = clampInteger(
    28 + uniqueTargetCount * 9 + hiddenTargetCount * 4 + broadCommandCount * 2,
    25,
    78
  );

  return {
    playerName: player.name,
    race: player.race,
    score,
    confidence,
    level: suspicionLevel(score),
    evidence: playerEvidence.sort((first, second) => first.seconds - second.seconds)
  };
}

function groupedEvidenceWeight(evidence: readonly ReplaySuspicionEvidence[]): number {
  const groups = new Map<string, ReplaySuspicionEvidence[]>();
  for (const item of evidence) {
    const key = item.details.toLowerCase();
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }

  return [...groups.values()].reduce((sum, group) => {
    const strongest = Math.max(...group.map((item) => item.weight));
    const repetitionBonus = Math.min(6, Math.max(0, group.length - 1) * 2);
    return sum + strongest + repetitionBonus;
  }, 0);
}

function readUnitObservations(
  ctx: ReplayDecodeContext,
  trackerEvents: unknown,
  internals: Sc2ReaderSuspicionInternals,
  useScaledTime: boolean,
  playerCount: number
): readonly UnitObservation[] {
  const units = new Map<string, MutableUnitObservation>();
  const unitsByIndex = new Map<number, MutableUnitObservation[]>();

  for (const ev of ctx.protocol.iterateTrackerEvents(trackerEvents, {
    decode: "full",
    eventTypes: TRACKER_EVENT_TYPES
  })) {
    const payload = ev.payload;
    if (!payload) {
      continue;
    }

    const seconds = internals.gameLoopsToSeconds(ev.gameloop, useScaledTime);
    if (ev.eventType === UNIT_POSITIONS_EVENT) {
      applyUnitPositionUpdates(unitsByIndex, payload, seconds);
      continue;
    }

    const unitKey = unitKeyFromPayload(payload);
    if (!unitKey) {
      continue;
    }

    if (ev.eventType === UNIT_DIED_EVENT) {
      const existing = units.get(unitKey);
      if (existing) {
        existing.deathSeconds = seconds;
      }
      continue;
    }

    const ownerPlayerIndex = trackerOwnerToPlayerIndex(payload.m_controlPlayerId, playerCount);
    const x = finiteNumber(payload.m_x);
    const y = finiteNumber(payload.m_y);
    if (ownerPlayerIndex === null || x === null || y === null) {
      continue;
    }

    const unitType = internals.decodeBufferToUtf8String(payload.m_unitTypeName) ?? "Unknown";
    if (!isTrackableUnit(unitType)) {
      continue;
    }

    const unitIndex = finiteNumber(payload.m_unitTagIndex);
    const unitRecycle = finiteNumber(payload.m_unitTagRecycle);
    if (unitIndex === null || unitRecycle === null) {
      continue;
    }

    const existing = units.get(unitKey);
    const nextUnit = existing ?? {
      unitKey,
      unitIndex,
      unitRecycle,
      unitType,
      ownerPlayerIndex,
      birthSeconds: seconds,
      deathSeconds: undefined,
      positions: []
    };
    nextUnit.positions = mergePositionSamples(nextUnit.positions, { seconds, x, y });
    units.set(unitKey, nextUnit);

    const indexedUnits = unitsByIndex.get(unitIndex) ?? [];
    if (!indexedUnits.some((unit) => unit.unitKey === unitKey)) {
      indexedUnits.push(nextUnit);
      unitsByIndex.set(unitIndex, indexedUnits);
    }
  }

  return [...units.values()];
}

function applyUnitPositionUpdates(
  unitsByIndex: ReadonlyMap<number, readonly MutableUnitObservation[]>,
  payload: RawTrackerPayload,
  seconds: number
): void {
  const firstUnitIndex = finiteNumber(payload.m_firstUnitIndex);
  const items = Array.isArray(payload.m_items) ? payload.m_items : [];
  if (firstUnitIndex === null || items.length < 3) {
    return;
  }

  for (let index = 0; index + 2 < items.length; index += 3) {
    const unitIndexDelta = finiteNumber(items[index]);
    const x = finiteNumber(items[index + 1]);
    const y = finiteNumber(items[index + 2]);
    if (unitIndexDelta === null || x === null || y === null) {
      continue;
    }

    const unitIndex = firstUnitIndex + unitIndexDelta;
    const unit = latestKnownUnitForIndex(unitsByIndex.get(unitIndex), seconds);
    if (!unit) {
      continue;
    }

    unit.positions = mergePositionSamples(unit.positions, { seconds, x, y });
  }
}

function latestKnownUnitForIndex(
  units: readonly MutableUnitObservation[] | undefined,
  seconds: number
): MutableUnitObservation | null {
  if (!units || units.length === 0) {
    return null;
  }

  return (
    units
      .filter((unit) => unit.birthSeconds <= seconds && (unit.deathSeconds === undefined || unit.deathSeconds >= seconds))
      .sort((first, second) => second.birthSeconds - first.birthSeconds)[0] ?? null
  );
}

function mergePositionSamples(
  samples: readonly PositionSample[] | undefined,
  sample: PositionSample
): readonly PositionSample[] {
  const existing = samples ?? [];
  const last = existing[existing.length - 1];
  if (last && last.seconds === sample.seconds && last.x === sample.x && last.y === sample.y) {
    return existing;
  }

  return [...existing, sample];
}

function readSuspiciousInteractions(
  ctx: ReplayDecodeContext,
  gameEvents: unknown,
  internals: Sc2ReaderSuspicionInternals,
  useScaledTime: boolean,
  players: readonly ReplayAnalysisPlayer[],
  units: readonly UnitObservation[]
): readonly ReplaySuspicionEvidence[] {
  const evidence: ReplaySuspicionEvidence[] = [];
  const recentCameraFinds = new Set<string>();
  const recentTargetFinds = new Set<string>();

  for (const ev of ctx.protocol.iterateGameEvents(gameEvents, {
    decode: "full",
    eventTypes: GAME_EVENT_TYPES
  })) {
    const playerIndex = gameUserIdToPlayerIndex(ev.userId, players.length);
    if (playerIndex === null || !ev.payload) {
      continue;
    }

    const seconds = internals.gameLoopsToSeconds(ev.gameloop, useScaledTime);
    if (seconds < MIN_ANALYSIS_SECONDS) {
      continue;
    }

    if (ev.eventType === CAMERA_EVENT) {
      const point = cameraPointFromPayload(ev.payload);
      if (!point) {
        continue;
      }

      const target = nearestEnemyImportantUnit(units, playerIndex, seconds, point, CAMERA_RADIUS);
      if (target && !hasFriendlyKnowledge(units, playerIndex, seconds, point, FRIENDLY_VISION_RADIUS)) {
        const dedupeKey = `${playerIndex}:${target.unitKey}:${Math.floor(seconds / 35)}`;
        if (recentCameraFinds.has(dedupeKey)) {
          continue;
        }
        recentCameraFinds.add(dedupeKey);

        evidence.push(
          makeEvidence(
            players[playerIndex],
            seconds,
            "hiddenCamera",
            "Hidden camera focus",
            `Camera focused near hidden ${target.unitType}.`,
            8
          )
        );
        continue;
      }

      const broadTarget = nearestEnemySuspicionTarget(units, playerIndex, seconds, point, ENEMY_CAMERA_RADIUS);
      if (!broadTarget || hasFriendlyKnowledge(units, playerIndex, seconds, point, FRIENDLY_VISION_RADIUS)) {
        continue;
      }

      const dedupeKey = `${playerIndex}:broad-camera:${broadTarget.unit.unitKey}:${Math.floor(seconds / 45)}`;
      if (recentCameraFinds.has(dedupeKey)) {
        continue;
      }
      recentCameraFinds.add(dedupeKey);
      evidence.push(
        makeEvidence(
          players[playerIndex],
          seconds,
          "hiddenEnemyCamera",
          broadTarget.category === "combat" ? "Hidden army camera" : "Hidden enemy camera",
          `Camera inspected ${suspicionTargetDescription(broadTarget)}.`,
          broadCameraWeight(broadTarget.category)
        )
      );
      continue;
    }

    const commandPoint = commandPointFromPayload(ev.payload, ev.eventType);
    if (!commandPoint) {
      continue;
    }

    const target = nearestEnemyImportantUnit(units, playerIndex, seconds, commandPoint, COMMAND_RADIUS);
    if (target && !hasFriendlyKnowledge(units, playerIndex, seconds, commandPoint, FRIENDLY_VISION_RADIUS)) {
      const dedupeKey = `${playerIndex}:${target.unitKey}:${Math.floor(seconds / 45)}`;
      if (recentTargetFinds.has(dedupeKey)) {
        continue;
      }
      recentTargetFinds.add(dedupeKey);

      evidence.push(
        makeEvidence(
          players[playerIndex],
          seconds,
          "hiddenTarget",
          ev.eventType === TARGET_UNIT_EVENT ? "Hidden target command" : "Hidden point command",
          `Command landed near hidden ${target.unitType}.`,
          ev.eventType === TARGET_UNIT_EVENT ? 12 : 8
        )
      );
      continue;
    }

    const broadTarget = nearestEnemySuspicionTarget(units, playerIndex, seconds, commandPoint, ENEMY_COMMAND_RADIUS);
    if (!broadTarget || hasFriendlyKnowledge(units, playerIndex, seconds, commandPoint, FRIENDLY_VISION_RADIUS)) {
      continue;
    }

    const dedupeKey = `${playerIndex}:broad-command:${broadTarget.unit.unitKey}:${Math.floor(seconds / 45)}`;
    if (recentTargetFinds.has(dedupeKey)) {
      continue;
    }
    recentTargetFinds.add(dedupeKey);

    evidence.push(
      makeEvidence(
        players[playerIndex],
        seconds,
        "hiddenEnemyCommand",
        broadTarget.category === "combat" ? "Hidden army command" : "Hidden enemy command",
        `Command landed near ${suspicionTargetDescription(broadTarget)}.`,
        broadCommandWeight(broadTarget.category)
      )
    );
  }

  return evidence;
}

function makeEvidence(
  player: ReplayAnalysisPlayer | undefined,
  seconds: number,
  type: ReplaySuspicionEvidenceType,
  label: string,
  details: string,
  weight: number
): ReplaySuspicionEvidence {
  return {
    seconds: Math.round(seconds),
    playerName: player?.name ?? "Unknown player",
    type,
    label,
    details,
    weight
  };
}

function nearestEnemyImportantUnit(
  units: readonly UnitObservation[],
  playerIndex: number,
  seconds: number,
  point: Point,
  radius: number
): UnitObservation | null {
  let best: { unit: UnitObservation; distance: number } | null = null;

  for (const unit of units) {
    if (
      unit.ownerPlayerIndex === playerIndex ||
      !isTechOrProxyTarget(unit.unitType) ||
      !isUnitAliveAt(unit, seconds)
    ) {
      continue;
    }

    const unitPoint = unitPointAt(unit, seconds);
    const distance = unitPoint ? distanceBetween(point, unitPoint) : Number.POSITIVE_INFINITY;
    if (distance > radius) {
      continue;
    }

    if (!best || distance < best.distance) {
      best = { unit, distance };
    }
  }

  return best?.unit ?? null;
}

function nearestEnemySuspicionTarget(
  units: readonly UnitObservation[],
  playerIndex: number,
  seconds: number,
  point: Point,
  radius: number
): SuspicionTarget | null {
  let best: { target: SuspicionTarget; distance: number } | null = null;

  for (const unit of units) {
    if (unit.ownerPlayerIndex === playerIndex || !isUnitAliveAt(unit, seconds)) {
      continue;
    }

    const category = suspicionTargetCategory(unit.unitType);
    if (!category) {
      continue;
    }

    const unitPoint = unitPointAt(unit, seconds);
    const distance = unitPoint ? distanceBetween(point, unitPoint) : Number.POSITIVE_INFINITY;
    if (distance > radius) {
      continue;
    }

    if (!best || distance < best.distance) {
      best = { target: { unit, category }, distance };
    }
  }

  return best?.target ?? null;
}

function hasFriendlyKnowledge(
  units: readonly UnitObservation[],
  playerIndex: number,
  seconds: number,
  point: Point,
  radius: number
): boolean {
  return units.some(
    (unit) =>
      unit.ownerPlayerIndex === playerIndex &&
      isUnitAliveAt(unit, seconds) &&
      isMobileUnit(unit.unitType) &&
      (distanceToUnitAt(point, unit, seconds) <= radius ||
        hadRecentUnitVision(point, unit, seconds, radius, RECENT_SCOUT_MEMORY_SECONDS))
  );
}

function hadRecentUnitVision(
  point: Point,
  unit: UnitObservation,
  seconds: number,
  radius: number,
  memorySeconds: number
): boolean {
  const fromSeconds = Math.max(unit.birthSeconds, seconds - memorySeconds);
  return unit.positions.some(
    (sample) =>
      sample.seconds >= fromSeconds &&
      sample.seconds <= seconds &&
      distanceBetween(point, sample) <= radius
  );
}

function isUnitAliveAt(unit: UnitObservation, seconds: number): boolean {
  return unit.birthSeconds <= seconds && (unit.deathSeconds === undefined || unit.deathSeconds >= seconds);
}

function cameraPointFromPayload(payload: RawGamePayload): Point | null {
  const target = asRecord(payload.m_target);
  const x = finiteNumber(target?.x);
  const y = finiteNumber(target?.y);
  if (x === null || y === null) {
    return null;
  }

  return {
    x: x / CAMERA_TARGET_SCALE,
    y: y / CAMERA_TARGET_SCALE
  };
}

function commandPointFromPayload(payload: RawGamePayload, eventType: string): Point | null {
  if (eventType === TARGET_POINT_EVENT) {
    const target = asRecord(payload.m_target);
    return scaledPoint(target, COMMAND_TARGET_SCALE);
  }

  const target = asRecord(payload.m_target);
  const snapshotPoint = asRecord(target?.m_snapshotPoint);
  return scaledPoint(snapshotPoint, COMMAND_TARGET_SCALE);
}

function scaledPoint(value: Record<string, unknown> | null | undefined, scale: number): Point | null {
  const x = finiteNumber(value?.x);
  const y = finiteNumber(value?.y);
  if (x === null || y === null) {
    return null;
  }

  return { x: x / scale, y: y / scale };
}

function unitKeyFromPayload(payload: RawTrackerPayload): string | null {
  const index = finiteNumber(payload.m_unitTagIndex);
  const recycle = finiteNumber(payload.m_unitTagRecycle);
  return index === null || recycle === null ? null : `${index}:${recycle}`;
}

function unitPointAt(unit: UnitObservation, seconds: number): Point | null {
  let latest: PositionSample | undefined;
  for (const sample of unit.positions) {
    if (sample.seconds > seconds) {
      break;
    }
    latest = sample;
  }

  return latest ? { x: latest.x, y: latest.y } : null;
}

function distanceToUnitAt(point: Point, unit: UnitObservation, seconds: number): number {
  const unitPoint = unitPointAt(unit, seconds);
  return unitPoint ? distanceBetween(point, unitPoint) : Number.POSITIVE_INFINITY;
}

function trackerOwnerToPlayerIndex(value: unknown, playerCount: number): number | null {
  const playerId = finiteNumber(value);
  if (playerId === null || playerId <= 0) {
    return null;
  }

  const playerIndex = playerId - 1;
  return playerIndex >= 0 && playerIndex < playerCount ? playerIndex : null;
}

function gameUserIdToPlayerIndex(value: unknown, playerCount: number): number | null {
  const userId = finiteNumber(value);
  if (userId === null || userId < 0 || userId >= playerCount) {
    return null;
  }

  return userId;
}

function isTrackableUnit(unitType: string): boolean {
  if (
    /mineral|vespene|beacon|destructible|critter|debris|rocks|rich/i.test(unitType) ||
    /^(larva|egg)$/i.test(unitType)
  ) {
    return false;
  }

  return true;
}

function isTechOrProxyTarget(unitType: string): boolean {
  return /banelingnest|roachwarren|hydraliskden|spire|greaterspire|nydus|infestationpit|ultraliskcavern|lurkerden|darkshrine|templararchive|roboticsbay|fleetbeacon|fusioncore|ghostacademy|armory/i.test(
    unitType
  );
}

function suspicionTargetCategory(unitType: string): SuspicionTargetCategory | null {
  if (isCombatUnit(unitType)) {
    return "combat";
  }

  if (isBaseStructure(unitType)) {
    return "base";
  }

  if (isSuspiciousStructure(unitType)) {
    return "structure";
  }

  return null;
}

function suspicionTargetDescription(target: SuspicionTarget): string {
  if (target.category === "base") {
    return "hidden enemy base";
  }

  if (target.category === "combat") {
    return `hidden enemy ${target.unit.unitType}`;
  }

  return `hidden enemy ${target.unit.unitType}`;
}

function broadCameraWeight(category: SuspicionTargetCategory): number {
  if (category === "combat") {
    return 5;
  }

  return category === "base" ? 2 : 4;
}

function broadCommandWeight(category: SuspicionTargetCategory): number {
  if (category === "combat") {
    return 8;
  }

  return category === "base" ? 4 : 6;
}

function isBaseStructure(unitType: string): boolean {
  return /command|orbital|planetary|nexus|hatchery|lair|hive/i.test(unitType);
}

function isSuspiciousStructure(unitType: string): boolean {
  return /command|orbital|planetary|nexus|hatchery|lair|hive|barracks|factory|starport|gateway|stargate|robotics|twilight|templararchive|darkshrine|fleetbeacon|forge|cybernetics|engineering|armory|fusion|ghostacademy|spawningpool|roachwarren|banelingnest|hydraliskden|spire|infestationpit|ultraliskcavern|lurkerden|nydus/i.test(
    unitType
  );
}

function isCombatUnit(unitType: string): boolean {
  return (
    isMobileUnit(unitType) &&
    !/scv|probe|drone|mule|overlord|overseer|observer|changeling|broodling|interceptor|larva|egg/i.test(unitType)
  );
}

function isMobileUnit(unitType: string): boolean {
  return !/command|orbital|planetary|nexus|hatchery|lair|hive|pool|warren|nest|den|spire|nydus|ultraliskcavern|evolution|extractor|gateway|cybernetics|stargate|robotics|twilight|templararchive|shrine|fleet|forge|cannon|pylon|barracks|factory|starport|engineering|armory|fusion|academy|bunker|turret|crawler|sensor|depot|refinery|assimilator/i.test(
    unitType
  );
}

function emptySuspicionPlayers(players: readonly ReplayAnalysisPlayer[]): readonly ReplaySuspicionPlayer[] {
  return players.map((player) => ({
    playerName: player.name,
    race: player.race,
    score: 0,
    confidence: 25,
    level: "low",
    evidence: []
  }));
}

function suspicionLevel(score: number): ReplaySuspicionLevel {
  if (score >= 65) {
    return "high";
  }

  if (score >= 35) {
    return "medium";
  }

  return "low";
}

function distanceBetween(first: Point, second: Point): number {
  return Math.hypot(first.x - second.x, first.y - second.y);
}

function normalizeName(value: string): string {
  return value.replace(/^(?:<[^>]+>\s*)+/, "").trim().toLowerCase();
}

function clampInteger(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}

function finiteNumber(value: unknown): number | null {
  const parsed = Number(value ?? NaN);
  return Number.isFinite(parsed) ? parsed : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

async function readOptionalReplayFile(ctx: ReplayDecodeContext, path: string): Promise<unknown | null> {
  try {
    return await ctx.readFile(path);
  } catch {
    return null;
  }
}

function loadSc2ReaderSuspicionInternals(): Sc2ReaderSuspicionInternals {
  const { decodeReplay } = require("@replaysremastered/sc2readerjs/src/replay/decode") as {
    readonly decodeReplay: Sc2ReaderSuspicionInternals["decodeReplay"];
  };
  const { decodeBufferToUtf8String } = require("@replaysremastered/sc2readerjs/src/util/text") as {
    readonly decodeBufferToUtf8String: Sc2ReaderSuspicionInternals["decodeBufferToUtf8String"];
  };
  const { gameLoopsToSeconds } = require("@replaysremastered/sc2readerjs/src/replay/time") as {
    readonly gameLoopsToSeconds: Sc2ReaderSuspicionInternals["gameLoopsToSeconds"];
  };

  return { decodeReplay, decodeBufferToUtf8String, gameLoopsToSeconds };
}

type Point = {
  readonly x: number;
  readonly y: number;
};

type PositionSample = Point & {
  readonly seconds: number;
};

type UnitObservation = {
  readonly unitKey: string;
  readonly unitIndex: number;
  readonly unitRecycle: number;
  readonly unitType: string;
  readonly ownerPlayerIndex: number;
  readonly birthSeconds: number;
  readonly deathSeconds?: number;
  readonly positions: readonly PositionSample[];
};

type SuspicionTargetCategory = "base" | "combat" | "structure";

type SuspicionTarget = {
  readonly unit: UnitObservation;
  readonly category: SuspicionTargetCategory;
};

type MutableUnitObservation = {
  unitKey: string;
  unitIndex: number;
  unitRecycle: number;
  unitType: string;
  ownerPlayerIndex: number;
  birthSeconds: number;
  deathSeconds?: number;
  positions: readonly PositionSample[];
};

type RawGamePayload = {
  readonly m_target?: unknown;
};

type RawTrackerPayload = {
  readonly m_unitTagIndex?: unknown;
  readonly m_unitTagRecycle?: unknown;
  readonly m_unitTypeName?: unknown;
  readonly m_controlPlayerId?: unknown;
  readonly m_x?: unknown;
  readonly m_y?: unknown;
  readonly m_firstUnitIndex?: unknown;
  readonly m_items?: unknown;
};

type RawGameEvent = {
  readonly userId: unknown;
  readonly gameloop: number;
  readonly eventType: string;
  readonly payload?: RawGamePayload | null;
};

type RawTrackerEvent = {
  readonly gameloop: number;
  readonly eventType: string;
  readonly payload?: RawTrackerPayload | null;
};

type ReplayDecodeContext = {
  readonly header?: {
    readonly m_useScaledTime?: boolean;
  };
  readonly protocol: {
    iterateGameEvents(
      buffer: unknown,
      options: { readonly decode: "full"; readonly eventTypes: readonly string[] }
    ): Iterable<RawGameEvent>;
    iterateTrackerEvents(
      buffer: unknown,
      options: { readonly decode: "full"; readonly eventTypes: readonly string[] }
    ): Iterable<RawTrackerEvent>;
  };
  readFile(path: string): Promise<unknown>;
  close(): Promise<void>;
};

type Sc2ReaderSuspicionInternals = {
  readonly decodeReplay: (replayPath: string, options?: { readonly protocolDir?: string }) => Promise<ReplayDecodeContext>;
  readonly decodeBufferToUtf8String: (value: unknown) => string | null;
  readonly gameLoopsToSeconds: (gameloop: number, useScaledTime?: boolean) => number;
};
