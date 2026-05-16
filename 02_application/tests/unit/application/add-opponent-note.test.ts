import { describe, expect, it } from "vitest";
import { AddOpponentNote } from "../../../src/application/use-cases/add-opponent-note.js";
import {
  MAX_OPPONENT_NOTE_LENGTH,
  MAX_OPPONENT_NOTES,
  type Opponent
} from "../../../src/domain/entities/opponent.js";
import type { OpponentRepository } from "../../../src/domain/repositories/opponent-repository.js";
import type { EntityId } from "../../../src/domain/value-objects/entity-id.js";

describe("AddOpponentNote", () => {
  it("persists a trimmed note on an existing opponent", async () => {
    const repository = new InMemoryOpponentRepository([
      opponent({ id: "opponent_001", notes: ["Opens stargate"] })
    ]);
    const useCase = new AddOpponentNote(repository);

    const result = await useCase.execute({
      opponentId: "opponent_001",
      note: "  Cannon rush risk  "
    });

    expect(result.opponent.notes).toEqual(["Opens stargate", "Cannon rush risk"]);
    await expect(repository.findById("opponent_001")).resolves.toMatchObject({
      notes: ["Opens stargate", "Cannon rush risk"]
    });
  });

  it("persists a note on the selected race profile", async () => {
    const repository = new InMemoryOpponentRepository([
      opponent({
        id: "opponent_001",
        raceProfiles: {
          Protoss: {
            strategyTags: [],
            notes: ["Opens oracle"],
            updatedAt: "2026-05-01T00:00:00.000Z"
          }
        }
      })
    ]);
    const useCase = new AddOpponentNote(repository);

    const result = await useCase.execute({
      opponentId: "opponent_001",
      note: "  Delays third  ",
      race: "Protoss"
    });

    expect(result.opponent.notes).toEqual([]);
    expect(result.opponent.raceProfiles?.Protoss?.notes).toEqual([
      "Opens oracle",
      "Delays third"
    ]);
  });

  it("rejects unknown opponents", async () => {
    const useCase = new AddOpponentNote(new InMemoryOpponentRepository([]));

    await expect(useCase.execute({ opponentId: "missing", note: "test" })).rejects.toThrow(
      "Opponent missing was not found."
    );
  });

  it("caps notes to the fixed note count and character limits", async () => {
    const repository = new InMemoryOpponentRepository([
      opponent({
        id: "opponent_001",
        notes: ["one", "two", "three", "four", "five"]
      })
    ]);
    const useCase = new AddOpponentNote(repository);

    const result = await useCase.execute({
      opponentId: "opponent_001",
      note: "x".repeat(MAX_OPPONENT_NOTE_LENGTH + 20)
    });

    expect(result.opponent.notes).toHaveLength(MAX_OPPONENT_NOTES);
    expect(result.opponent.notes[0]).toBe("two");
    expect(result.opponent.notes[MAX_OPPONENT_NOTES - 1]).toHaveLength(MAX_OPPONENT_NOTE_LENGTH);
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
