import { describe, expect, it } from "vitest";
import { ListMatchHistory } from "../../../src/application/use-cases/list-match-history.js";
import { createMatch, type Match } from "../../../src/domain/entities/match.js";
import type { Opponent } from "../../../src/domain/entities/opponent.js";
import type { MatchRepository } from "../../../src/domain/repositories/match-repository.js";
import type { OpponentRepository } from "../../../src/domain/repositories/opponent-repository.js";
import type { EntityId } from "../../../src/domain/value-objects/entity-id.js";

describe("ListMatchHistory", () => {
  it("returns latest matches with opponent profiles", async () => {
    const useCase = new ListMatchHistory(
      new InMemoryMatchRepository([
        match("match_old", "opponent_001", "2026-05-03T10:00:00.000Z"),
        match("match_new", "opponent_002", "2026-05-03T11:00:00.000Z")
      ]),
      new InMemoryOpponentRepository([
        opponent({ id: "opponent_001", nickname: "OldEnemy" }),
        opponent({ id: "opponent_002", nickname: "NewEnemy" })
      ])
    );

    await expect(useCase.execute()).resolves.toMatchObject({
      items: [
        { match: { id: "match_new" }, opponent: { nickname: "NewEnemy" } },
        { match: { id: "match_old" }, opponent: { nickname: "OldEnemy" } }
      ]
    });
  });

  it("applies an optional limit", async () => {
    const useCase = new ListMatchHistory(
      new InMemoryMatchRepository([
        match("match_001", "opponent_001", "2026-05-03T10:00:00.000Z"),
        match("match_002", "opponent_001", "2026-05-03T11:00:00.000Z")
      ]),
      new InMemoryOpponentRepository([])
    );

    const result = await useCase.execute({ limit: 1 });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.match.id).toBe("match_002");
  });
});

function match(id: EntityId, opponentId: EntityId, playedAt: string): Match {
  return createMatch({
    id,
    opponentId,
    playedAt,
    playerRace: "Terran",
    opponentRace: "Zerg",
    now: playedAt
  });
}

function opponent(overrides: Partial<Opponent>): Opponent {
  return {
    id: "opponent_base",
    nickname: "Base",
    race: "Terran",
    aliases: [],
    encounters: 1,
    wins: 0,
    losses: 0,
    notes: [],
    strategyTags: [],
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z",
    ...overrides
  };
}

class InMemoryMatchRepository implements MatchRepository {
  constructor(private readonly matches: readonly Match[]) {}

  async findAll(): Promise<readonly Match[]> {
    return this.matches;
  }

  async findById(id: EntityId): Promise<Match | null> {
    return this.matches.find((match) => match.id === id) ?? null;
  }

  async findByOpponentId(opponentId: EntityId): Promise<readonly Match[]> {
    return this.matches.filter((match) => match.opponentId === opponentId);
  }

  async save(_match: Match): Promise<void> {}

  async clear(): Promise<void> {}
}

class InMemoryOpponentRepository implements OpponentRepository {
  constructor(private readonly opponents: readonly Opponent[]) {}

  async findAll(): Promise<readonly Opponent[]> {
    return this.opponents;
  }

  async findById(id: EntityId): Promise<Opponent | null> {
    return this.opponents.find((opponent) => opponent.id === id) ?? null;
  }

  async save(_opponent: Opponent): Promise<void> {}

  async clear(): Promise<void> {}
}
