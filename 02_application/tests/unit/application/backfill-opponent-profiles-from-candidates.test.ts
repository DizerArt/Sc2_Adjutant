import { describe, expect, it } from "vitest";
import { BackfillOpponentProfilesFromCandidates } from "../../../src/application/use-cases/backfill-opponent-profiles-from-candidates.js";
import type { EnrichmentCandidateSnapshot } from "../../../src/domain/entities/enrichment-candidate-snapshot.js";
import { createOpponent, type Opponent } from "../../../src/domain/entities/opponent.js";
import type { EnrichmentCandidateRepository } from "../../../src/domain/repositories/enrichment-candidate-repository.js";
import type { OpponentRepository } from "../../../src/domain/repositories/opponent-repository.js";
import type { EntityId } from "../../../src/domain/value-objects/entity-id.js";

describe("BackfillOpponentProfilesFromCandidates", () => {
  it("fills missing BattleTag and MMR from exact stored source candidates", async () => {
    const opponent = createOpponent({
      id: "opponent_aliveps",
      nickname: "aLivePS",
      race: "Protoss",
      now: "2026-05-04T20:00:00.000Z"
    });
    const opponentRepository = new InMemoryOpponentRepository([opponent]);
    const candidateRepository = new InMemoryCandidateRepository([
      candidate({
        opponentId: opponent.id,
        nickname: "aLivePS",
        race: "Protoss",
        battleTag: "WoongBear#31876",
        mmr: 4629,
        league: "Grandmaster",
        confidenceScore: 0.4
      })
    ]);

    const result = await new BackfillOpponentProfilesFromCandidates({
      opponentRepository,
      enrichmentCandidateRepository: candidateRepository,
      clock: () => "2026-05-05T00:00:00.000Z"
    }).execute();

    expect(result).toEqual({ inspectedCount: 1, updatedCount: 1 });
    await expect(opponentRepository.findById(opponent.id)).resolves.toMatchObject({
      battleTag: "WoongBear#31876",
      mmrAtLastMatch: 4629,
      league: "Grandmaster",
      confidenceScore: 0.4,
      updatedAt: "2026-05-05T00:00:00.000Z"
    });
  });

  it("does not overwrite existing manually curated profile fields", async () => {
    const opponent = {
      ...createOpponent({
        id: "opponent_existing",
        nickname: "Known",
        race: "Terran",
        battleTag: "Manual#1111",
        mmrAtLastMatch: 4000,
        league: "Master",
        now: "2026-05-04T20:00:00.000Z"
      }),
      confidenceScore: 0.9
    };
    const opponentRepository = new InMemoryOpponentRepository([opponent]);
    const candidateRepository = new InMemoryCandidateRepository([
      candidate({
        opponentId: opponent.id,
        nickname: "Known",
        battleTag: "Source#2222",
        mmr: 4500,
        league: "Grandmaster",
        confidenceScore: 0.6
      })
    ]);

    const result = await new BackfillOpponentProfilesFromCandidates({
      opponentRepository,
      enrichmentCandidateRepository: candidateRepository
    }).execute();

    expect(result.updatedCount).toBe(0);
    await expect(opponentRepository.findById(opponent.id)).resolves.toMatchObject({
      battleTag: "Manual#1111",
      mmrAtLastMatch: 4000,
      league: "Master",
      confidenceScore: 0.9
    });
  });
});

function candidate(overrides: Partial<EnrichmentCandidateSnapshot>): EnrichmentCandidateSnapshot {
  return {
    id: "candidate_1",
    opponentId: "opponent_base",
    source: "SC2Pulse",
    nickname: "Player",
    race: "Unknown",
    aliases: [],
    confidenceScore: 0.5,
    selected: false,
    capturedAt: "2026-05-04T20:05:00.000Z",
    ...overrides
  };
}

class InMemoryOpponentRepository implements OpponentRepository {
  private opponents: Opponent[];

  constructor(opponents: readonly Opponent[]) {
    this.opponents = [...opponents];
  }

  async findAll(): Promise<readonly Opponent[]> {
    return this.opponents;
  }

  async findById(id: EntityId): Promise<Opponent | null> {
    return this.opponents.find((opponent) => opponent.id === id) ?? null;
  }

  async save(opponent: Opponent): Promise<void> {
    this.opponents = this.opponents.map((candidate) => (candidate.id === opponent.id ? opponent : candidate));
  }

  async clear(): Promise<void> {
    this.opponents = [];
  }
}

class InMemoryCandidateRepository implements EnrichmentCandidateRepository {
  constructor(private readonly candidates: readonly EnrichmentCandidateSnapshot[]) {}

  async findByOpponentId(opponentId: EntityId): Promise<readonly EnrichmentCandidateSnapshot[]> {
    return this.candidates.filter((candidate) => candidate.opponentId === opponentId);
  }

  async replaceForOpponent(): Promise<void> {
    throw new Error("not implemented");
  }

  async clear(): Promise<void> {
    throw new Error("not implemented");
  }
}
