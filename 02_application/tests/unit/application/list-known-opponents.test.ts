import { describe, expect, it } from "vitest";
import { ListKnownOpponents } from "../../../src/application/use-cases/list-known-opponents.js";
import type { Opponent } from "../../../src/domain/entities/opponent.js";
import type { OpponentRepository } from "../../../src/domain/repositories/opponent-repository.js";
import type { EntityId } from "../../../src/domain/value-objects/entity-id.js";

describe("ListKnownOpponents", () => {
  it("returns opponents sorted by latest match date", async () => {
    const useCase = new ListKnownOpponents(
      new InMemoryOpponentRepository([
        opponent({ id: "opponent_old", nickname: "Old", lastMatchDate: "2026-05-01T00:00:00.000Z" }),
        opponent({ id: "opponent_new", nickname: "New", lastMatchDate: "2026-05-03T00:00:00.000Z" })
      ])
    );

    await expect(useCase.execute()).resolves.toMatchObject({
      opponents: [
        { id: "opponent_new" },
        { id: "opponent_old" }
      ]
    });
  });
});

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

