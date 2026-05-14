import type { EntityId } from "../value-objects/entity-id.js";
import type { Race } from "../value-objects/race.js";

export type MatchResult = "win" | "loss" | "unknown";

export type Match = {
  readonly id: EntityId;
  readonly opponentId: EntityId;
  readonly playedAt: string;
  readonly map?: string;
  readonly playerRace: Race;
  readonly opponentRace: Race;
  readonly result: MatchResult;
  readonly mmrBefore?: number;
  readonly mmrAfter?: number;
  readonly durationSeconds?: number;
  readonly replayPath?: string;
  readonly favorite: boolean;
  readonly notes: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type ReplayMetadata = {
  readonly replayPath: string;
  readonly playedAt?: string;
  readonly map?: string;
  readonly result?: MatchResult;
  readonly players?: readonly ReplayMetadataPlayer[];
  readonly durationSeconds?: number;
};

export type ReplayMetadataPlayer = {
  readonly name: string;
  readonly race: Race;
  readonly result?: MatchResult;
  readonly toon?: string;
};

export type CreateMatchInput = {
  readonly id: EntityId;
  readonly opponentId: EntityId;
  readonly playedAt: string;
  readonly map?: string;
  readonly playerRace: Race;
  readonly opponentRace: Race;
  readonly result?: MatchResult;
  readonly mmrBefore?: number;
  readonly mmrAfter?: number;
  readonly durationSeconds?: number;
  readonly replayPath?: string;
  readonly favorite?: boolean;
  readonly notes?: readonly string[];
  readonly now?: string;
};

export function createMatch(input: CreateMatchInput): Match {
  const now = input.now ?? new Date().toISOString();

  return {
    id: input.id,
    opponentId: input.opponentId,
    playedAt: input.playedAt,
    map: normalizeOptionalString(input.map),
    playerRace: input.playerRace,
    opponentRace: input.opponentRace,
    result: input.result ?? "unknown",
    mmrBefore: input.mmrBefore,
    mmrAfter: input.mmrAfter,
    durationSeconds: normalizeOptionalNumber(input.durationSeconds),
    replayPath: normalizeOptionalString(input.replayPath),
    favorite: input.favorite ?? false,
    notes: input.notes ?? [],
    createdAt: now,
    updatedAt: now
  };
}

export function getMmrDelta(match: Match): number | null {
  if (typeof match.mmrBefore !== "number" || typeof match.mmrAfter !== "number") {
    return null;
  }

  return match.mmrAfter - match.mmrBefore;
}

export function attachReplayMetadata(
  match: Match,
  metadata: ReplayMetadata,
  now = new Date().toISOString()
): Match {
  return {
    ...match,
    playedAt: metadata.playedAt ?? match.playedAt,
    map: normalizeOptionalString(metadata.map) ?? match.map,
    result: metadata.result && metadata.result !== "unknown" ? metadata.result : match.result,
    durationSeconds: normalizeOptionalNumber(metadata.durationSeconds) ?? match.durationSeconds,
    replayPath: normalizeOptionalString(metadata.replayPath) ?? match.replayPath,
    updatedAt: now
  };
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function normalizeOptionalNumber(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}
