import { describe, expect, it } from "vitest";
import { RemoveOpponentNote } from "../../../src/application/use-cases/remove-opponent-note.js";
import type { Opponent } from "../../../src/domain/entities/opponent.js";
import type { OpponentRepository } from "../../../src/domain/repositories/opponent-repository.js";
import type { EntityId } from "../../../src/domain/value-objects/entity-id.js";

describe("RemoveOpponentNote", () => {
  it("removes a note by index", async () => {
    const repository = new InMemoryOpponentRepository([
      opponent({ id: "opponent_001", notes: ["proxy", "air", "late expand"] })
    ]);
    const useCase = new RemoveOpponentNote(repository);

    const result = await useCase.execute({
      opponentId: "opponent_001",
      noteIndex: 1
    });

    expect(result.opponent.notes).toEqual(["proxy", "late expand"]);
    await expect(repository.findById("opponent_001")).resolves.toMatchObject({
      notes: ["proxy", "late expand"]
    });
  });

  it("removes a note from the selected race profile", async () => {
    const repository = new InMemoryOpponentRepository([
      opponent({
        id: "opponent_001",
        raceProfiles: {
          Zerg: {
            strategyTags: [],
            notes: ["pool first", "roach follow-up"],
            updatedAt: "2026-05-01T00:00:00.000Z"
          }
        }
      })
    ]);
    const useCase = new RemoveOpponentNote(repository);

    const result = await useCase.execute({
      opponentId: "opponent_001",
      noteIndex: 0,
      race: "Zerg"
    });

    expect(result.opponent.notes).toEqual([]);
    expect(result.opponent.raceProfiles?.Zerg?.notes).toEqual(["roach follow-up"]);
  });

  it("rejects unknown opponents", async () => {
    const useCase = new RemoveOpponentNote(new InMemoryOpponentRepository([]));

    await expect(useCase.execute({ opponentId: "missing", noteIndex: 0 })).rejects.toThrow(
      "Opponent missing was not found."
    );
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
    const index = this.opponents.findIndex((candidate) => candidate.id === opponent.id);

    if (index === -1) {
      this.opponents = [...this.opponents, opponent];
      return;
    }

    this.opponents = this.opponents.map((candidate, candidateIndex) =>
      candidateIndex === index ? opponent : candidate
    );
  }

  async clear(): Promise<void> {
    this.opponents = [];
  }
}
