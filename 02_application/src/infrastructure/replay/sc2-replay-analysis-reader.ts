import { createRequire } from "node:module";
import sc2Reader from "@replaysremastered/sc2readerjs";
import type {
  ArmyValueSample,
  BuildCommand,
  EcoSample,
  LoadBuildCommandsOptions,
  LoadEcoTimelineOptions,
  LoadEngagementsOptions,
  LoadReplaySummaryOptions,
  ReplayBuildCommands,
  ReplayEcoTimeline,
  ReplayEngagements,
  ReplayPlayerSummary,
  ReplaySummary
} from "@replaysremastered/sc2readerjs";
import type {
  ReplayAnalysis,
  ReplayAnalysisGraph,
  ReplayAnalysisPlayer,
  ReplayAnalysisReaderPort,
  ReplayAnalysisSample,
  ReplayBuildOrderPlayer
} from "../../domain/ports/replay-analysis-reader-port.js";
import { normalizeRace, type Race } from "../../domain/value-objects/race.js";
import type { MatchResult } from "../../domain/entities/match.js";

const require = createRequire(import.meta.url);

export type Sc2ReplayAnalysisReaderOptions = {
  readonly loadReplaySummary?: (replayPath: string, options?: LoadReplaySummaryOptions) => Promise<ReplaySummary>;
  readonly loadReplayApm?: (replayPath: string) => Promise<readonly (number | undefined)[]>;
  readonly loadBuildCommands?: (replayPath: string, options?: LoadBuildCommandsOptions) => Promise<ReplayBuildCommands>;
  readonly loadEngagements?: (replayPath: string, options?: LoadEngagementsOptions) => Promise<ReplayEngagements>;
  readonly loadEcoTimeline?: (replayPath: string, options?: LoadEcoTimelineOptions) => Promise<ReplayEcoTimeline>;
  readonly loadResourceCollectionTimeline?: (replayPath: string) => Promise<ReplayResourceCollectionTimeline>;
};

const MAX_BUILD_ORDER_ENTRIES = 100;
const PLAYER_STATS_EVENT = "NNet.Replay.Tracker.SPlayerStatsEvent";

export class Sc2ReplayAnalysisReader implements ReplayAnalysisReaderPort {
  private readonly loadReplaySummary: NonNullable<Sc2ReplayAnalysisReaderOptions["loadReplaySummary"]>;
  private readonly loadReplayApm: NonNullable<Sc2ReplayAnalysisReaderOptions["loadReplayApm"]>;
  private readonly loadBuildCommands: NonNullable<Sc2ReplayAnalysisReaderOptions["loadBuildCommands"]>;
  private readonly loadEngagements: NonNullable<Sc2ReplayAnalysisReaderOptions["loadEngagements"]>;
  private readonly loadEcoTimeline: NonNullable<Sc2ReplayAnalysisReaderOptions["loadEcoTimeline"]>;
  private readonly loadResourceCollectionTimeline: NonNullable<
    Sc2ReplayAnalysisReaderOptions["loadResourceCollectionTimeline"]
  >;

  constructor(options: Sc2ReplayAnalysisReaderOptions = {}) {
    this.loadReplaySummary = options.loadReplaySummary ?? sc2Reader.loadReplaySummary;
    this.loadReplayApm = options.loadReplayApm ?? loadBlizzardApmByPlayerIndex;
    this.loadBuildCommands = options.loadBuildCommands ?? sc2Reader.loadBuildCommands;
    this.loadEngagements = options.loadEngagements ?? sc2Reader.loadEngagements;
    this.loadEcoTimeline = options.loadEcoTimeline ?? sc2Reader.loadEcoTimeline;
    this.loadResourceCollectionTimeline = options.loadResourceCollectionTimeline ?? loadResourceCollectionTimeline;
  }

  async readAnalysis(replayPath: string, opponentName?: string): Promise<ReplayAnalysis> {
    const failures: string[] = [];
    const [summary, apmByPlayerIndex] = await Promise.all([
      this.loadReplaySummary(replayPath, { includeApm: true }),
      this.loadReplayApm(replayPath).catch(() => [])
    ]);
    const players = replayPlayersFromSummary(summary.players, apmByPlayerIndex);
    const averageApm = averageApmForOpponent(players, opponentName);
    const [buildCommands, engagements, ecoTimeline, resourceCollectionTimeline] = await Promise.all([
      this.loadBuildCommands(replayPath).catch((error: unknown) => {
        failures.push(`Build order: ${messageFromError(error)}`);
        return null;
      }),
      this.loadEngagements(replayPath, { includeTimeline: true }).catch((error: unknown) => {
        failures.push(`Army value: ${messageFromError(error)}`);
        return null;
      }),
      this.loadEcoTimeline(replayPath).catch((error: unknown) => {
        failures.push(`Economy timeline: ${messageFromError(error)}`);
        return null;
      }),
      this.loadResourceCollectionTimeline(replayPath).catch((error: unknown) => {
        failures.push(`Resource collection rate: ${messageFromError(error)}`);
        return null;
      })
    ]);

    return {
      players,
      averageApm,
      graphs: [
        armyValueGraph(engagements),
        resourceCollectionRateGraph(resourceCollectionTimeline),
        workersActiveGraph(ecoTimeline)
      ],
      buildOrders: buildOrdersFromCommands(buildCommands),
      parseError: failures.length > 0 ? failures.join(" | ") : undefined
    };
  }
}

function replayPlayersFromSummary(
  players: readonly ReplayPlayerSummary[],
  apmByPlayerIndex: readonly (number | undefined)[]
): readonly ReplayAnalysisPlayer[] {
  return players
    .filter((player) => player.name !== null)
    .map((player, index) => ({
      name: normalizePlayerName(player.name ?? ""),
      race: normalizeRace(player.race),
      result: normalizeReplayResult(player.result),
      apm: normalizePositiveInteger(apmByPlayerIndex[index] ?? player.apm)
    }));
}

function averageApmForOpponent(
  players: readonly ReplayAnalysisPlayer[],
  opponentName: string | undefined
): number | undefined {
  const normalizedOpponentName = normalizePlayerName(opponentName ?? "").toLowerCase();
  const opponent = normalizedOpponentName
    ? players.find((player) => player.name.toLowerCase() === normalizedOpponentName)
    : undefined;

  if (opponent?.apm) {
    return opponent.apm;
  }

  const apmValues = players.map((player) => player.apm).filter((value): value is number => typeof value === "number");
  if (apmValues.length === 0) {
    return undefined;
  }

  return Math.round(apmValues.reduce((sum, value) => sum + value, 0) / apmValues.length);
}

function armyValueGraph(engagements: ReplayEngagements | null): ReplayAnalysisGraph {
  return {
    id: "armyValue",
    label: "Army Value",
    yLabel: "Army Value",
    xLabel: "Elapsed Game Time",
    series: engagements ? seriesFromArmyTimeline(engagements) : []
  };
}

function resourceCollectionRateGraph(ecoTimeline: ReplayResourceCollectionTimeline | null): ReplayAnalysisGraph {
  return {
    id: "resourceCollectionRate",
    label: "Resource Collection Rate",
    yLabel: "Resource Collection Rate",
    xLabel: "Elapsed Game Time",
    series: ecoTimeline ? seriesFromResourceCollectionTimeline(ecoTimeline) : []
  };
}

function workersActiveGraph(ecoTimeline: ReplayEcoTimeline | null): ReplayAnalysisGraph {
  return {
    id: "workersActive",
    label: "Workers Active",
    yLabel: "Workers Active",
    xLabel: "Elapsed Game Time",
    series: ecoTimeline ? seriesFromEcoTimeline(ecoTimeline, (sample) => sample.workers) : []
  };
}

function seriesFromArmyTimeline(engagements: ReplayEngagements): readonly ReplayAnalysisGraph["series"][number][] {
  return engagements.players
    .map((player, index) => {
      const timeline = engagements.armyValueTimeline?.[player.userId] ?? engagements.armyValueTimeline?.[index] ?? [];
      return {
        playerName: normalizePlayerName(player.name ?? `Player ${index + 1}`),
        race: normalizeRace(player.race),
        samples: samplesFromArmyValue(timeline)
      };
    })
    .filter((series) => series.samples.length > 0);
}

function seriesFromEcoTimeline(
  ecoTimeline: ReplayEcoTimeline,
  valueFromSample: (sample: EcoSample) => number
): readonly ReplayAnalysisGraph["series"][number][] {
  return ecoTimeline.players
    .map((player, index) => {
      const timeline = ecoTimeline.timeline[player.userId] ?? ecoTimeline.timeline[index] ?? [];
      return {
        playerName: normalizePlayerName(player.name ?? `Player ${index + 1}`),
        race: normalizeRace(player.race),
        samples: timeline.map((sample) => ({
          seconds: Math.round(sample.seconds),
          value: Math.round(valueFromSample(sample))
        }))
      };
    })
    .filter((series) => series.samples.length > 0);
}

function seriesFromResourceCollectionTimeline(
  ecoTimeline: ReplayResourceCollectionTimeline
): readonly ReplayAnalysisGraph["series"][number][] {
  return ecoTimeline.players
    .map((player, index) => {
      const timeline = ecoTimeline.timeline[player.userId] ?? ecoTimeline.timeline[index] ?? [];
      return {
        playerName: normalizePlayerName(player.name ?? `Player ${index + 1}`),
        race: normalizeRace(player.race),
        samples: timeline.map((sample) => ({
          seconds: Math.round(sample.seconds),
          value: Math.round(sample.value)
        }))
      };
    })
    .filter((series) => series.samples.length > 0);
}

function samplesFromArmyValue(samples: readonly ArmyValueSample[]): readonly ReplayAnalysisSample[] {
  return samples.map((sample) => ({
    seconds: Math.round(sample.seconds),
    value: Math.round(sample.total)
  }));
}

function buildOrdersFromCommands(buildCommands: ReplayBuildCommands | null): readonly ReplayBuildOrderPlayer[] {
  if (!buildCommands) {
    return [];
  }

  return buildCommands.players
    .map((player, index) => ({
      playerName: normalizePlayerName(player.name ?? `Player ${index + 1}`),
      race: normalizeRace(player.race),
      entries: player.commands
        .filter(isVisibleBuildCommand)
        .slice(0, MAX_BUILD_ORDER_ENTRIES)
        .map((command) => ({
          seconds: Math.round(command.seconds),
          action: command.product ?? command.commandName ?? command.abilityName ?? "Unknown action"
        }))
    }))
    .filter((player) => player.entries.length > 0);
}

function isVisibleBuildCommand(command: BuildCommand): boolean {
  return Boolean(command.product ?? command.commandName ?? command.abilityName);
}

function normalizePlayerName(value: string): string {
  return value.replace(/^(?:<[^>]+>\s*)+/, "").trim();
}

function normalizePositiveInteger(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : undefined;
}

function normalizeReplayResult(value: ReplayPlayerSummary["result"]): MatchResult | undefined {
  if (value === "win" || value === "loss") {
    return value;
  }

  return undefined;
}

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type ReplayResourceCollectionSample = {
  readonly gameloop: number;
  readonly seconds: number;
  readonly value: number;
};

type ReplayResourceCollectionTimeline = {
  readonly players: readonly { readonly userId: number; readonly name: string | null; readonly race: string | null }[];
  readonly timeline: readonly ReplayResourceCollectionSample[][];
};

type Sc2ReaderInternals = {
  readonly decodeReplay: (replayPath: string, options?: { readonly protocolDir?: string }) => Promise<ReplayDecodeContext>;
  readonly decodeBufferToUtf8String: (value: unknown) => string | null;
  readonly gameLoopsToSeconds: (gameloop: number, useScaledTime?: boolean) => number;
  readonly normalizeReaderPlayerName: (value: string | null) => string | null;
  readonly normalizeReaderRaceName: (value: string | null) => string | null;
};

type ReplayDecodeContext = {
  readonly header?: {
    readonly m_useScaledTime?: boolean;
  };
  readonly details?: {
    readonly m_playerList?: readonly unknown[] | null;
  };
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
  readonly gameloop: number;
  readonly payload?: {
    readonly m_playerId?: unknown;
    readonly m_stats?: RawPlayerStats | null;
  } | null;
};

type RawPlayerStats = {
  readonly m_scoreValueMineralsCollectionRate?: unknown;
  readonly m_scoreValueVespeneCollectionRate?: unknown;
};

function loadSc2ReaderInternals(): Sc2ReaderInternals {
  const { decodeReplay } = require("@replaysremastered/sc2readerjs/src/replay/decode") as {
    readonly decodeReplay: Sc2ReaderInternals["decodeReplay"];
  };
  const { decodeBufferToUtf8String } = require("@replaysremastered/sc2readerjs/src/util/text") as {
    readonly decodeBufferToUtf8String: Sc2ReaderInternals["decodeBufferToUtf8String"];
  };
  const { gameLoopsToSeconds } = require("@replaysremastered/sc2readerjs/src/replay/time") as {
    readonly gameLoopsToSeconds: Sc2ReaderInternals["gameLoopsToSeconds"];
  };
  const {
    normalizePlayerName: normalizeReaderPlayerName,
    normalizeRaceName: normalizeReaderRaceName
  } = require("@replaysremastered/sc2readerjs/src/replay/normalize") as {
    readonly normalizePlayerName: Sc2ReaderInternals["normalizeReaderPlayerName"];
    readonly normalizeRaceName: Sc2ReaderInternals["normalizeReaderRaceName"];
  };

  return {
    decodeReplay,
    decodeBufferToUtf8String,
    gameLoopsToSeconds,
    normalizeReaderPlayerName,
    normalizeReaderRaceName
  };
}

type Sc2MpqArchive = {
  readFile(path: string): Promise<Buffer>;
  close(): Promise<void>;
};

type ReplayGameMetadata = {
  readonly Players?: readonly ReplayGameMetadataPlayer[];
};

type ReplayGameMetadataPlayer = {
  readonly PlayerID?: unknown;
  readonly APM?: unknown;
};

async function loadBlizzardApmByPlayerIndex(replayPath: string): Promise<readonly (number | undefined)[]> {
  try {
    const { SC2MPQArchive } = require("@replaysremastered/sc2readerjs/src/sc2mpq/sc2mpq") as {
      readonly SC2MPQArchive: { open(replayPath: string): Promise<Sc2MpqArchive> };
    };
    const archive = await SC2MPQArchive.open(replayPath);

    try {
      const metadataBytes = await archive.readFile("replay.gamemetadata.json");
      const metadata = JSON.parse(metadataBytes.toString("utf8")) as ReplayGameMetadata;
      const players = Array.isArray(metadata.Players) ? metadata.Players : [];
      const apmByPlayerIndex: (number | undefined)[] = [];

      players.forEach((player, fallbackIndex) => {
        const playerIndex = metadataPlayerIndex(player.PlayerID, fallbackIndex);
        const apm = normalizePositiveInteger(Number(player.APM));

        if (apm !== undefined) {
          apmByPlayerIndex[playerIndex] = apm;
        }
      });

      return apmByPlayerIndex;
    } finally {
      await archive.close();
    }
  } catch {
    return [];
  }
}

function metadataPlayerIndex(playerId: unknown, fallbackIndex: number): number {
  const normalizedPlayerId = Number(playerId);
  return Number.isFinite(normalizedPlayerId) && normalizedPlayerId > 0 ? normalizedPlayerId - 1 : fallbackIndex;
}

async function loadResourceCollectionTimeline(replayPath: string): Promise<ReplayResourceCollectionTimeline> {
  const internals = loadSc2ReaderInternals();
  const ctx = await internals.decodeReplay(replayPath);

  try {
    const useScaledTime = Boolean(ctx.header?.m_useScaledTime);
    const players = replayResourcePlayersFromDetails(ctx.details?.m_playerList ?? [], internals);
    const timeline: ReplayResourceCollectionSample[][] = players.map(() => []);
    let trackerEvents: unknown;

    try {
      trackerEvents = await ctx.readFile("replay.tracker.events");
    } catch {
      return { players, timeline };
    }

    for (const ev of ctx.protocol.iterateTrackerEvents(trackerEvents, {
      decode: "full",
      eventTypes: [PLAYER_STATS_EVENT]
    })) {
      if (ev.eventType !== PLAYER_STATS_EVENT) {
        continue;
      }

      const playerId = Number(ev.payload?.m_playerId ?? -1);
      if (!Number.isFinite(playerId) || playerId <= 0) {
        continue;
      }

      const userId = playerId - 1;
      if (userId < 0 || userId >= players.length) {
        continue;
      }

      const value = resourceCollectionRateFromStats(ev.payload?.m_stats ?? null);
      if (value === null) {
        continue;
      }

      timeline[userId]?.push({
        gameloop: ev.gameloop,
        seconds: internals.gameLoopsToSeconds(ev.gameloop, useScaledTime),
        value
      });
    }

    for (const series of timeline) {
      series.sort((a, b) => a.gameloop - b.gameloop);
    }

    return { players, timeline };
  } finally {
    await ctx.close();
  }
}

function replayResourcePlayersFromDetails(
  rawPlayers: readonly unknown[],
  internals: Sc2ReaderInternals
): ReplayResourceCollectionTimeline["players"] {
  return rawPlayers.map((rawPlayer, index) => {
    const player = rawPlayer as { readonly m_name?: unknown; readonly m_race?: unknown };
    return {
      userId: index,
      name: internals.normalizeReaderPlayerName(internals.decodeBufferToUtf8String(player.m_name) ?? ""),
      race: internals.normalizeReaderRaceName(internals.decodeBufferToUtf8String(player.m_race) ?? "")
    };
  });
}

function resourceCollectionRateFromStats(stats: RawPlayerStats | null): number | null {
  if (!stats) {
    return null;
  }

  const minerals = finiteNumber(stats.m_scoreValueMineralsCollectionRate);
  const vespene = finiteNumber(stats.m_scoreValueVespeneCollectionRate);

  if (minerals === null && vespene === null) {
    return null;
  }

  return Math.max(0, (minerals ?? 0) + (vespene ?? 0));
}

function finiteNumber(value: unknown): number | null {
  const parsed = Number(value ?? NaN);
  return Number.isFinite(parsed) ? parsed : null;
}
