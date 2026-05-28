import { createRequire } from "node:module";
import type { Race } from "../../domain/value-objects/race.js";

const require = createRequire(import.meta.url);

const UNIT_BORN = "NNet.Replay.Tracker.SUnitBornEvent";
const UNIT_INIT = "NNet.Replay.Tracker.SUnitInitEvent";
const UNIT_DONE = "NNet.Replay.Tracker.SUnitDoneEvent";
const UNIT_TYPE_CHANGE = "NNet.Replay.Tracker.SUnitTypeChangeEvent";

const TRACKER_RACE_EVENTS = [UNIT_BORN, UNIT_INIT, UNIT_DONE, UNIT_TYPE_CHANGE] as const;
const PLAYABLE_RACES = ["Terran", "Zerg", "Protoss"] as const satisfies readonly Race[];

type PlayableRace = (typeof PLAYABLE_RACES)[number];
let cachedRaceByUnitType: ReadonlyMap<string, PlayableRace> | null = null;

type ReplayDecodeContext = {
  readonly protocol: {
    iterateTrackerEvents(
      buffer: unknown,
      options: { readonly decode: "full"; readonly eventTypes: readonly string[] }
    ): Iterable<RawTrackerEvent>;
  };
  readFile(path: string): Promise<unknown>;
  close(): Promise<void>;
};

type RawTrackerEvent = {
  readonly eventType: string;
  readonly payload?: {
    readonly m_unitTypeName?: unknown;
    readonly m_controlPlayerId?: unknown;
    readonly m_upkeepPlayerId?: unknown;
  } | null;
};

type Sc2ReaderRaceInternals = {
  readonly decodeReplay: (replayPath: string, options?: { readonly protocolDir?: string }) => Promise<ReplayDecodeContext>;
  readonly decodeBufferToUtf8String: (value: unknown) => string | null;
};

type UnitInfoByRace = Record<string, Record<string, unknown>>;

export type InferReplayPlayerRacesFn = (replayPath: string) => Promise<ReadonlyMap<number, Race>>;

export async function inferReplayPlayerRaces(replayPath: string): Promise<ReadonlyMap<number, Race>> {
  const internals = loadRaceInternals();
  const ctx = await internals.decodeReplay(replayPath);

  try {
    let trackerEvents: unknown;
    try {
      trackerEvents = await ctx.readFile("replay.tracker.events");
    } catch {
      return new Map();
    }

    const raceByUnitType = loadRaceByUnitType();
    const votesByPlayerIndex = new Map<number, Map<PlayableRace, number>>();

    for (const ev of ctx.protocol.iterateTrackerEvents(trackerEvents, {
      decode: "full",
      eventTypes: TRACKER_RACE_EVENTS
    })) {
      const payload = ev.payload;
      if (!payload) {
        continue;
      }

      const unitTypeName = internals.decodeBufferToUtf8String(payload.m_unitTypeName);
      const race = raceByUnitType.get(normalizeUnitTypeName(unitTypeName ?? ""));
      if (!race) {
        continue;
      }

      const playerIndex = playerIndexFromTrackerPayload(payload);
      if (playerIndex === null) {
        continue;
      }

      const votes = votesByPlayerIndex.get(playerIndex) ?? new Map<PlayableRace, number>();
      votes.set(race, (votes.get(race) ?? 0) + 1);
      votesByPlayerIndex.set(playerIndex, votes);
    }

    return strongestRaceByPlayerIndex(votesByPlayerIndex);
  } finally {
    await ctx.close();
  }
}

function loadRaceInternals(): Sc2ReaderRaceInternals {
  const { decodeReplay } = require("@replaysremastered/sc2readerjs/src/replay/decode") as {
    readonly decodeReplay: Sc2ReaderRaceInternals["decodeReplay"];
  };
  const { decodeBufferToUtf8String } = require("@replaysremastered/sc2readerjs/src/util/text") as {
    readonly decodeBufferToUtf8String: Sc2ReaderRaceInternals["decodeBufferToUtf8String"];
  };

  return { decodeReplay, decodeBufferToUtf8String };
}

function loadRaceByUnitType(): ReadonlyMap<string, PlayableRace> {
  if (cachedRaceByUnitType) {
    return cachedRaceByUnitType;
  }

  const unitInfo = require("@replaysremastered/sc2readerjs/src/data/units/unit_info.json") as UnitInfoByRace;
  const raceByUnitType = new Map<string, PlayableRace>();

  for (const race of PLAYABLE_RACES) {
    const units = unitInfo[race];
    if (!units || typeof units !== "object") {
      continue;
    }

    for (const unitType of Object.keys(units)) {
      raceByUnitType.set(normalizeUnitTypeName(unitType), race);
    }
  }

  cachedRaceByUnitType = raceByUnitType;
  return raceByUnitType;
}

function normalizeUnitTypeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function playerIndexFromTrackerPayload(payload: NonNullable<RawTrackerEvent["payload"]>): number | null {
  const playerId = finitePositiveInteger(payload.m_upkeepPlayerId) ?? finitePositiveInteger(payload.m_controlPlayerId);
  if (playerId === null) {
    return null;
  }

  return playerId - 1;
}

function finitePositiveInteger(value: unknown): number | null {
  const parsed = Number(value ?? NaN);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function strongestRaceByPlayerIndex(votesByPlayerIndex: ReadonlyMap<number, ReadonlyMap<PlayableRace, number>>): Map<number, Race> {
  const raceByPlayerIndex = new Map<number, Race>();

  for (const [playerIndex, votes] of votesByPlayerIndex) {
    let bestRace: Race = "Unknown";
    let bestVotes = 0;

    for (const race of PLAYABLE_RACES) {
      const count = votes.get(race) ?? 0;
      if (count > bestVotes) {
        bestRace = race;
        bestVotes = count;
      }
    }

    if (bestRace !== "Unknown") {
      raceByPlayerIndex.set(playerIndex, bestRace);
    }
  }

  return raceByPlayerIndex;
}
