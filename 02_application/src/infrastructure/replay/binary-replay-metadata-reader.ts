import sc2Reader from "@replaysremastered/sc2readerjs";
import type {
  LoadReplaySummaryOptions,
  ReplayPlayerSummary,
  ReplaySummary
} from "@replaysremastered/sc2readerjs";
import type { MatchResult, ReplayMetadata, ReplayMetadataPlayer } from "../../domain/entities/match.js";
import type { ReplayFile, ReplayMetadataReaderPort } from "../../domain/ports/replay-metadata-reader-port.js";
import { normalizeRace, type Race } from "../../domain/value-objects/race.js";
import { inferReplayPlayerRaces, type InferReplayPlayerRacesFn } from "./replay-race-inference.js";

export type LoadReplaySummaryFn = (
  replayPath: string,
  options?: LoadReplaySummaryOptions
) => Promise<ReplaySummary>;

export type BinaryReplayMetadataReaderOptions = {
  readonly loadReplaySummary?: LoadReplaySummaryFn;
  readonly fallback?: ReplayMetadataReaderPort;
  readonly resolveUserName?: () => Promise<string | undefined>;
  readonly inferReplayPlayerRaces?: InferReplayPlayerRacesFn;
};

export class BinaryReplayMetadataReader implements ReplayMetadataReaderPort {
  private readonly load: LoadReplaySummaryFn;
  private readonly fallback?: ReplayMetadataReaderPort;
  private readonly resolveUserName?: () => Promise<string | undefined>;
  private readonly inferReplayPlayerRaces: InferReplayPlayerRacesFn;

  constructor(options: BinaryReplayMetadataReaderOptions = {}) {
    this.load = options.loadReplaySummary ?? sc2Reader.loadReplaySummary;
    this.fallback = options.fallback;
    this.resolveUserName = options.resolveUserName;
    this.inferReplayPlayerRaces = options.inferReplayPlayerRaces ?? inferReplayPlayerRaces;
  }

  async readMetadata(file: ReplayFile): Promise<ReplayMetadata> {
    try {
      const summary = await this.load(file.path);
      const userName = (await this.resolveUserName?.())?.trim();
      const result = matchResultForUser(summary.players, userName);
      const inferredRaces = needsRaceInference(summary.players)
        ? await this.inferReplayPlayerRaces(file.path).catch(() => new Map<number, Race>())
        : new Map<number, Race>();

      return {
        replayPath: file.path,
        playedAt: summary.playedAt ?? file.modifiedAt,
        map: summary.mapTitle ?? undefined,
        result,
        players: replayPlayersFromSummary(summary.players, inferredRaces),
        durationSeconds: normalizeDuration(summary.durationSeconds)
      };
    } catch (error) {
      if (this.fallback) {
        return this.fallback.readMetadata(file);
      }

      throw error;
    }
  }
}

function replayPlayersFromSummary(
  players: readonly ReplayPlayerSummary[] | undefined,
  inferredRaces: ReadonlyMap<number, Race>
): readonly ReplayMetadataPlayer[] | undefined {
  if (!players || players.length === 0) {
    return undefined;
  }

  return players
    .filter((player) => player.name !== null)
    .map((player, index) => ({
      name: normalizeReplayPlayerName(player.name ?? ""),
      race: raceFromSummaryOrInference(player.race, inferredRaces.get(index)),
      result: normalizeReplayResult(player.result),
      toon: normalizeOptionalString(player.toon ?? undefined)
    }));
}

function raceFromSummaryOrInference(summaryRace: unknown, inferredRace: Race | undefined): Race {
  const race = normalizeRace(summaryRace);
  return race === "Unknown" ? inferredRace ?? race : race;
}

function needsRaceInference(players: readonly ReplayPlayerSummary[] | undefined): boolean {
  return Boolean(players?.some((player) => normalizeRace(player.race) === "Unknown"));
}

function normalizeReplayPlayerName(value: string): string {
  return value.replace(/^(?:<[^>]+>\s*)+/, "").trim();
}

function normalizeDuration(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function matchResultForUser(
  players: readonly ReplayPlayerSummary[] | undefined,
  userName: string | undefined
): MatchResult | undefined {
  if (!userName || !players || players.length === 0) {
    return undefined;
  }

  const normalizedUserName = normalizeReplayPlayerName(userName).toLowerCase();
  const userPlayer = players.find((player) =>
    player.name !== null && normalizeReplayPlayerName(player.name).toLowerCase() === normalizedUserName
  );

  if (!userPlayer) {
    return undefined;
  }

  if (userPlayer.result === "win" || userPlayer.result === "loss") {
    return userPlayer.result;
  }

  return "unknown";
}

function normalizeReplayResult(value: ReplayPlayerSummary["result"]): MatchResult | undefined {
  if (value === "win" || value === "loss") {
    return value;
  }

  if (value === "tie") {
    return "unknown";
  }

  return undefined;
}
