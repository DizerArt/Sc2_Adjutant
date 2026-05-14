import { describe, expect, it } from "vitest";
import { UpdateOpponentProfile } from "../../../src/application/use-cases/update-opponent-profile.js";
import {
  MAX_OPPONENT_STRATEGY_TAG_LENGTH,
  MAX_OPPONENT_STRATEGY_TAGS,
  type Opponent
} from "../../../src/domain/entities/opponent.js";
import type { OpponentRepository } from "../../../src/domain/repositories/opponent-repository.js";
import type { EntityId } from "../../../src/domain/value-objects/entity-id.js";

describe("UpdateOpponentProfile", () => {
  it("normalizes and persists manually edited profile fields", async () => {
    const repository = new InMemoryOpponentRepository([
      opponent({ id: "opponent_001", nickname: "Barcode", race: "Unknown" })
    ]);
    const useCase = new UpdateOpponentProfile(repository, () => "2026-05-03T12:00:00.000Z");

    const result = await useCase.execute({
      opponentId: "opponent_001",
      nickname: "  KnownProtoss  ",
      race: "Protoss",
      battleTag: " Known#123 ",
      aliases: ["Barcode", " KnownProtoss ", ""],
      mmrAtLastMatch: 4812,
      league: " Master ",
      strategyTags: ["proxy", "air", "proxy"],
      confidenceScore: 1.2
    });

    expect(result.opponent).toMatchObject({
      nickname: "KnownProtoss",
      race: "Protoss",
      battleTag: "Known#123",
      aliases: ["Barcode", "KnownProtoss"],
      mmrAtLastMatch: 4812,
      league: "Master",
      strategyTags: ["proxy", "air"],
      confidenceScore: 1,
      updatedAt: "2026-05-03T12:00:00.000Z"
    });
    expect(result.opponent.raceProfiles?.Protoss).toMatchObject({
      mmrAtLastMatch: 4812,
      league: "Master",
      strategyTags: ["proxy", "air"],
      confidenceScore: 1
    });
    await expect(repository.findById("opponent_001")).resolves.toMatchObject({
      nickname: "KnownProtoss"
    });
  });

  it("keeps manually edited tags separated by race", async () => {
    const repository = new InMemoryOpponentRepository([
      opponent({
        id: "opponent_001",
        nickname: "MultiRace",
        race: "Terran",
        strategyTags: ["macro"],
        raceProfiles: {
          Terran: {
            strategyTags: ["macro"],
            updatedAt: "2026-05-01T00:00:00.000Z"
          }
        }
      })
    ]);
    const useCase = new UpdateOpponentProfile(repository, () => "2026-05-03T12:00:00.000Z");

    const result = await useCase.execute({
      opponentId: "opponent_001",
      race: "Zerg",
      strategyTags: ["cheese", "aggressive"]
    });

    expect(result.opponent.raceProfiles?.Terran?.strategyTags).toEqual(["macro"]);
    expect(result.opponent.raceProfiles?.Zerg?.strategyTags).toEqual(["cheese", "aggressive"]);
  });

  it("caps manually edited strategy tags to the card limits", async () => {
    const repository = new InMemoryOpponentRepository([
      opponent({ id: "opponent_001", nickname: "Taggy", race: "Terran" })
    ]);
    const useCase = new UpdateOpponentProfile(repository);

    const result = await useCase.execute({
      opponentId: "opponent_001",
      race: "Terran",
      strategyTags: Array.from({ length: MAX_OPPONENT_STRATEGY_TAGS + 3 }, (_value, index) =>
        `very-long-tag-${index}-extra`
      )
    });

    expect(result.opponent.strategyTags).toHaveLength(MAX_OPPONENT_STRATEGY_TAGS);
    expect(result.opponent.strategyTags[0]).toHaveLength(MAX_OPPONENT_STRATEGY_TAG_LENGTH);
  });

  it("rejects unknown opponents", async () => {
    const useCase = new UpdateOpponentProfile(new InMemoryOpponentRepository([]));

    await expect(useCase.execute({ opponentId: "missing", nickname: "Nope" })).rejects.toThrow(
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
    this.opponents =
      index === -1
        ? [...this.opponents, opponent]
        : this.opponents.map((candidate) => (candidate.id === opponent.id ? opponent : candidate));
  }

  async clear(): Promise<void> {
    this.opponents = [];
  }
}
