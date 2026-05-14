import type { OpponentDataCandidate } from "../ports/opponent-data-source-port.js";
import { createStableEntityId, type EntityId } from "../value-objects/entity-id.js";
import type { Race } from "../value-objects/race.js";

export type EnrichmentCandidateSnapshot = {
  readonly id: EntityId;
  readonly opponentId: EntityId;
  readonly source: string;
  readonly nickname: string;
  readonly race: Race;
  readonly region?: "US" | "EU" | "KR" | "CN" | "Unknown";
  readonly battleTag?: string;
  readonly aliases: readonly string[];
  readonly mmr?: number;
  readonly league?: string;
  readonly totalGames?: number;
  readonly wins?: number;
  readonly losses?: number;
  readonly lastPlayedAt?: string;
  readonly profileUrl?: string;
  readonly confidenceScore: number;
  readonly selected: boolean;
  readonly capturedAt: string;
};

export function createEnrichmentCandidateSnapshot(
  opponentId: EntityId,
  candidate: OpponentDataCandidate,
  selected: boolean,
  capturedAt = new Date().toISOString()
): EnrichmentCandidateSnapshot {
  return {
    id: createStableEntityId("candidate", `${opponentId}-${candidate.source}-${candidate.nickname}-${candidate.race}`),
    opponentId,
    source: candidate.source,
    nickname: candidate.nickname,
    race: candidate.race,
    region: candidate.region,
    battleTag: normalizeOptionalString(candidate.battleTag),
    aliases: normalizeStringArray(candidate.aliases),
    mmr: normalizeOptionalNumber(candidate.mmr),
    league: normalizeOptionalString(candidate.league),
    totalGames: normalizeOptionalNumber(candidate.totalGames),
    wins: normalizeOptionalNumber(candidate.wins),
    losses: normalizeOptionalNumber(candidate.losses),
    lastPlayedAt: normalizeOptionalString(candidate.lastPlayedAt),
    profileUrl: normalizeOptionalString(candidate.profileUrl),
    confidenceScore: Math.min(Math.max(candidate.confidenceScore, 0), 1),
    selected,
    capturedAt
  };
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function normalizeStringArray(values: readonly string[]): readonly string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function normalizeOptionalNumber(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
