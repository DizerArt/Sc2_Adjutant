import { describe, expect, it, vi } from "vitest";
import { ClearAllStats } from "../../../src/application/use-cases/clear-all-stats.js";
import type { EnrichmentCandidateSnapshot } from "../../../src/domain/entities/enrichment-candidate-snapshot.js";
import type { Match } from "../../../src/domain/entities/match.js";
import type { Opponent } from "../../../src/domain/entities/opponent.js";
import type { EnrichmentCandidateRepository } from "../../../src/domain/repositories/enrichment-candidate-repository.js";
import type { MatchRepository } from "../../../src/domain/repositories/match-repository.js";
import type { OpponentRepository } from "../../../src/domain/repositories/opponent-repository.js";
import type { EntityId } from "../../../src/domain/value-objects/entity-id.js";

describe("ClearAllStats", () => {
  it("calls clear() on every repository and reports the timestamp", async () => {
    const opponentRepository = makeOpponentRepository();
    const matchRepository = makeMatchRepository();
    const enrichmentRepository = makeEnrichmentRepository();

    const result = await new ClearAllStats({
      opponentRepository,
      matchRepository,
      enrichmentCandidateRepository: enrichmentRepository,
      clock: () => "2026-05-03T20:00:00.000Z"
    }).execute();

    expect(opponentRepository.clear).toHaveBeenCalledTimes(1);
    expect(matchRepository.clear).toHaveBeenCalledTimes(1);
    expect(enrichmentRepository.clear).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      clearedAt: "2026-05-03T20:00:00.000Z",
      cleared: { opponents: true, matches: true, enrichmentCandidates: true }
    });
  });
});

function makeOpponentRepository(): OpponentRepository & { clear: ReturnType<typeof vi.fn> } {
  return {
    findAll: vi.fn(async (): Promise<readonly Opponent[]> => []),
    findById: vi.fn(async (_id: EntityId): Promise<Opponent | null> => null),
    save: vi.fn(async (_opponent: Opponent): Promise<void> => {}),
    clear: vi.fn(async (): Promise<void> => {})
  };
}

function makeMatchRepository(): MatchRepository & { clear: ReturnType<typeof vi.fn> } {
  return {
    findAll: vi.fn(async (): Promise<readonly Match[]> => []),
    findById: vi.fn(async (_id: EntityId): Promise<Match | null> => null),
    findByOpponentId: vi.fn(async (_id: EntityId): Promise<readonly Match[]> => []),
    save: vi.fn(async (_match: Match): Promise<void> => {}),
    clear: vi.fn(async (): Promise<void> => {})
  };
}

function makeEnrichmentRepository(): EnrichmentCandidateRepository & { clear: ReturnType<typeof vi.fn> } {
  return {
    findByOpponentId: vi.fn(async (_id: EntityId): Promise<readonly EnrichmentCandidateSnapshot[]> => []),
    replaceForOpponent: vi.fn(async (): Promise<void> => {}),
    clear: vi.fn(async (): Promise<void> => {})
  };
}
