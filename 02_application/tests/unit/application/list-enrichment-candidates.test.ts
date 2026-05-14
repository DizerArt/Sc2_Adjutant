import { describe, expect, it } from "vitest";
import { ListEnrichmentCandidates } from "../../../src/application/use-cases/list-enrichment-candidates.js";
import type { EnrichmentCandidateSnapshot } from "../../../src/domain/entities/enrichment-candidate-snapshot.js";
import type { EnrichmentCandidateRepository } from "../../../src/domain/repositories/enrichment-candidate-repository.js";
import type { EntityId } from "../../../src/domain/value-objects/entity-id.js";

describe("ListEnrichmentCandidates", () => {
  it("returns candidates for an opponent", async () => {
    const useCase = new ListEnrichmentCandidates(
      new InMemoryCandidateRepository([
        candidate({ opponentId: "opponent_001", nickname: "Alpha" }),
        candidate({ opponentId: "opponent_002", nickname: "Beta" })
      ])
    );

    await expect(useCase.execute({ opponentId: "opponent_001" })).resolves.toMatchObject({
      candidates: [{ nickname: "Alpha" }]
    });
  });
});

function candidate(overrides: Partial<EnrichmentCandidateSnapshot>): EnrichmentCandidateSnapshot {
  return {
    id: "candidate_001",
    opponentId: "opponent_001",
    source: "Fixture",
    nickname: "Base",
    race: "Terran",
    aliases: [],
    confidenceScore: 0.5,
    selected: false,
    capturedAt: "2026-05-03T12:00:00.000Z",
    ...overrides
  };
}

class InMemoryCandidateRepository implements EnrichmentCandidateRepository {
  constructor(private readonly candidates: readonly EnrichmentCandidateSnapshot[]) {}

  async findByOpponentId(opponentId: EntityId): Promise<readonly EnrichmentCandidateSnapshot[]> {
    return this.candidates.filter((candidate) => candidate.opponentId === opponentId);
  }

  async replaceForOpponent(): Promise<void> {}

  async clear(): Promise<void> {}
}
