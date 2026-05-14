import sc2Reader from "@replaysremastered/sc2readerjs";
import type {
  LoadReplaySummaryOptions,
  ReplayPlayerSummary,
  ReplaySummary
} from "@replaysremastered/sc2readerjs";
import type { MatchResult, ReplayMetadata, ReplayMetadataPlayer } from "../../domain/entities/match.js";
import type { ReplayFile, ReplayMetadataReaderPort } from "../../domain/ports/replay-metadata-reader-port.js";
import { normalizeRace } from "../../domain/value-objects/race.js";

export type LoadReplaySummaryFn = (
  replayPath: string,
  options?: LoadReplaySummaryOptions
) => Promise<ReplaySummary>;

export type BinaryReplayMetadataReaderOptions = {
  readonly loadReplaySummary?: LoadReplaySummaryFn;
  readonly fallback?: ReplayMetadataReaderPort;
  readonly resolveUserName?: () => Promise<string | undefined>;
};

export class BinaryReplayMetadataReader implements ReplayMetadataReaderPort {
  private readonly load: LoadReplaySummaryFn;
  private readonly fallback?: ReplayMetadataReaderPort;
  private readonly resolveUserName?: () => Promise<string | undefined>;

  constructor(options: BinaryReplayMetadataReaderOptions = {}) {
    this.load = options.loadReplaySummary ?? sc2Reader.loadReplaySummary;
    this.fallback = options.fallback;
    this.resolveUserName = options.resolveUserName;
  }

  async readMetadata(file: ReplayFile): Promise<ReplayMetadata> {
    try {
      const summary = await this.load(file.path);
      const userName = (await this.resolveUserName?.())?.trim();
      const result = matchResultForUser(summary.players, userName);

      return {
        replayPath: file.path,
        playedAt: summary.playedAt ?? file.modifiedAt,
        map: summary.mapTitle ?? undefined,
        result,
        players: replayPlayersFromSummary(summary.players),
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
  players: readonly ReplayPlayerSummary[] | undefined
): readonly ReplayMetadataPlayer[] | undefined {
  if (!players || players.length === 0) {
    return undefined;
  }

  return players
    .filter((player) => player.name !== null)
    .map((player) => ({
      name: normalizeReplayPlayerName(player.name ?? ""),
      race: normalizeRace(player.race),
      result: normalizeReplayResult(player.result),
      toon: normalizeOptionalString(player.toon ?? undefined)
    }));
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
