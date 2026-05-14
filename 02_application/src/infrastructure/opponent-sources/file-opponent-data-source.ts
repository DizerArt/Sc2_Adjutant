import type {
  OpponentDataCandidate,
  OpponentDataSourcePort,
  OpponentSearchQuery
} from "../../domain/ports/opponent-data-source-port.js";
import { normalizeRace } from "../../domain/value-objects/race.js";
import { readTextFileIfExists } from "../storage/atomic-file.js";

export class FileOpponentDataSource implements OpponentDataSourcePort {
  readonly sourceName = "Local Fixture Source";

  constructor(private readonly filePath: string) {}

  async searchOpponent(query: OpponentSearchQuery): Promise<readonly OpponentDataCandidate[]> {
    const candidates = await this.readCandidates();
    const normalizedQuery = query.nickname.trim().toLowerCase();

    if (!normalizedQuery) {
      return [];
    }

    return candidates
      .filter((candidate) => matchesQuery(candidate, normalizedQuery, query))
      .sort((first, second) => second.confidenceScore - first.confidenceScore);
  }

  private async readCandidates(): Promise<readonly OpponentDataCandidate[]> {
    const content = await readTextFileIfExists(this.filePath);

    if (!content) {
      return [];
    }

    const parsed = JSON.parse(content) as unknown;

    if (!Array.isArray(parsed)) {
      throw new Error("Opponent source fixture must be a JSON array.");
    }

    return parsed.map(candidateFromRecord);
  }
}

function matchesQuery(
  candidate: OpponentDataCandidate,
  normalizedQuery: string,
  query: OpponentSearchQuery
): boolean {
  const names = [candidate.nickname, ...candidate.aliases].map((value) => value.trim().toLowerCase());
  const nameMatches = names.some((name) => name === normalizedQuery || name.includes(normalizedQuery));
  const raceMatches = !query.race || candidate.race === "Unknown" || candidate.race === query.race;

  return nameMatches && raceMatches;
}

function candidateFromRecord(value: unknown): OpponentDataCandidate {
  const record = asRecord(value);

  return {
    source: stringValue(record.source) || "Local Fixture Source",
    nickname: stringValue(record.nickname),
    race: normalizeRace(record.race),
    battleTag: optionalString(record.battleTag),
    aliases: stringArray(record.aliases),
    mmr: optionalNumber(record.mmr),
    league: optionalString(record.league),
    totalGames: optionalNumber(record.totalGames),
    wins: optionalNumber(record.wins),
    losses: optionalNumber(record.losses),
    lastPlayedAt: optionalString(record.lastPlayedAt),
    profileUrl: optionalString(record.profileUrl),
    confidenceScore: normalizeConfidence(record.confidenceScore),
    raw: record
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function optionalString(value: unknown): string | undefined {
  const normalized = stringValue(value);
  return normalized ? normalized : undefined;
}

function stringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map(stringValue).filter(Boolean);
}

function optionalNumber(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeConfidence(value: unknown): number {
  const parsed = optionalNumber(value) ?? 0;
  return Math.min(Math.max(parsed, 0), 1);
}
