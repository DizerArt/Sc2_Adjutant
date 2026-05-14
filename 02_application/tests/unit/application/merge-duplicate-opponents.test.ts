import { describe, expect, it } from "vitest";
import { MergeDuplicateOpponents } from "../../../src/application/use-cases/merge-duplicate-opponents.js";
import { createMatch, type Match } from "../../../src/domain/entities/match.js";
import { createOpponent, type Opponent } from "../../../src/domain/entities/opponent.js";
import type { MatchRepository } from "../../../src/domain/repositories/match-repository.js";
import type { OpponentRepository } from "../../../src/domain/repositories/opponent-repository.js";
import type { EntityId } from "../../../src/domain/value-objects/entity-id.js";

describe("MergeDuplicateOpponents", () => {
  it("merges same-nickname race profiles and remaps their matches", async () => {
    const opponentRepository = new InMemoryOpponentRepository([
      {
        ...createOpponent({
          id: "opponent_silverpure-protoss",
          nickname: "SilverPure",
          race: "Protoss",
          notes: ["stargate"],
          strategyTags: ["air"],
          now: "2026-05-03T10:00:00.000Z"
        }),
        lastMatchDate: "2026-05-03T10:00:00.000Z"
      },
      {
        ...createOpponent({
          id: "opponent_silverpure-zerg",
          nickname: "SilverPure",
          race: "Zerg",
          notes: ["pool first"],
          strategyTags: ["rush"],
          now: "2026-05-03T11:00:00.000Z"
        }),
        lastMatchDate: "2026-05-03T11:00:00.000Z"
      }
    ]);
    const matchRepository = new InMemoryMatchRepository([
      match("match_001", "opponent_silverpure-protoss", "Protoss", "2026-05-03T10:00:00.000Z"),
      match("match_002", "opponent_silverpure-zerg", "Zerg", "2026-05-03T11:00:00.000Z")
    ]);
    const useCase = new MergeDuplicateOpponents({
      opponentRepository,
      matchRepository,
      clock: () => "2026-05-03T12:00:00.000Z"
    });

    await expect(useCase.execute()).resolves.toEqual({
      inspectedCount: 2,
      mergedCount: 1
    });

    const opponents = await opponentRepository.findAll();
    const matches = await matchRepository.findAll();

    expect(opponents).toHaveLength(1);
    expect(opponents[0]).toMatchObject({
      id: "opponent_silverpure",
      nickname: "SilverPure",
      race: "Zerg",
      notes: ["stargate", "pool first"],
      strategyTags: ["air", "rush"]
    });
    expect(matches.map((item) => item.opponentId)).toEqual(["opponent_silverpure", "opponent_silverpure"]);
  });

  it("never merges barcode-named opponents into a single record", async () => {
    const opponentRepository = new InMemoryOpponentRepository([
      {
        ...createOpponent({
          id: "opponent_barcode-game-1",
          nickname: "IIIIIIII",
          race: "Terran",
          now: "2026-05-03T10:00:00.000Z"
        }),
        lastMatchDate: "2026-05-03T10:00:00.000Z"
      },
      {
        ...createOpponent({
          id: "opponent_barcode-game-2",
          nickname: "IIIIIIII",
          race: "Protoss",
          now: "2026-05-03T11:00:00.000Z"
        }),
        lastMatchDate: "2026-05-03T11:00:00.000Z"
      }
    ]);
    const matchRepository = new InMemoryMatchRepository([
      match("match_b1", "opponent_barcode-game-1", "Terran", "2026-05-03T10:00:00.000Z"),
      match("match_b2", "opponent_barcode-game-2", "Protoss", "2026-05-03T11:00:00.000Z")
    ]);

    await new MergeDuplicateOpponents({
      opponentRepository,
      matchRepository,
      clock: () => "2026-05-03T12:00:00.000Z"
    }).execute();

    const opponents = await opponentRepository.findAll();
    expect(opponents).toHaveLength(2);
    expect(opponents.map((opponent) => opponent.id).sort()).toEqual([
      "opponent_barcode-game-1",
      "opponent_barcode-game-2"
    ]);
  });

  it("merges resolved barcode duplicates by BattleTag and remaps their matches", async () => {
    const opponentRepository = new InMemoryOpponentRepository([
      {
        ...createOpponent({
          id: "opponent_https-starcraft2-blizzard-com-profile-2-1-10540305",
          nickname: "llllllllllll",
          race: "Terran",
          battleTag: "llllllllilll#11313",
          mmrAtLastMatch: 4179,
          now: "2026-05-05T19:17:00.000Z"
        }),
        lastMatchDate: "2026-05-05T19:17:00.000Z"
      },
      {
        ...createOpponent({
          id: "opponent_legacy_barcode_duplicate",
          nickname: "IIIIIIIIIIII",
          race: "Terran",
          battleTag: "llllllllilll#11313",
          mmrAtLastMatch: 4179,
          now: "2026-05-05T01:15:00.000Z"
        }),
        lastMatchDate: "2026-05-05T01:15:00.000Z"
      }
    ]);
    const matchRepository = new InMemoryMatchRepository([
      match("match_b1", "opponent_https-starcraft2-blizzard-com-profile-2-1-10540305", "Terran", "2026-05-05T19:17:00.000Z"),
      match("match_b2", "opponent_legacy_barcode_duplicate", "Terran", "2026-05-05T01:15:00.000Z")
    ]);

    await new MergeDuplicateOpponents({
      opponentRepository,
      matchRepository,
      clock: () => "2026-05-05T20:00:00.000Z"
    }).execute();

    const opponents = await opponentRepository.findAll();
    const matches = await matchRepository.findAll();

    expect(opponents).toHaveLength(1);
    expect(opponents[0]).toMatchObject({
      id: "opponent_https-starcraft2-blizzard-com-profile-2-1-10540305",
      battleTag: "llllllllilll#11313"
    });
    expect(matches.map((item) => item.opponentId)).toEqual([
      "opponent_https-starcraft2-blizzard-com-profile-2-1-10540305",
      "opponent_https-starcraft2-blizzard-com-profile-2-1-10540305"
    ]);
  });
});

function match(id: EntityId, opponentId: EntityId, opponentRace: Match["opponentRace"], playedAt: string): Match {
  return createMatch({
    id,
    opponentId,
    playedAt,
    playerRace: "Terran",
    opponentRace,
    now: playedAt
  });
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

class InMemoryMatchRepository implements MatchRepository {
  private matches: Match[];

  constructor(matches: readonly Match[]) {
    this.matches = [...matches];
  }

  async findAll(): Promise<readonly Match[]> {
    return this.matches;
  }

  async findById(id: EntityId): Promise<Match | null> {
    return this.matches.find((match) => match.id === id) ?? null;
  }

  async findByOpponentId(opponentId: EntityId): Promise<readonly Match[]> {
    return this.matches.filter((match) => match.opponentId === opponentId);
  }

  async save(match: Match): Promise<void> {
    const index = this.matches.findIndex((candidate) => candidate.id === match.id);
    this.matches =
      index === -1
        ? [...this.matches, match]
        : this.matches.map((candidate) => (candidate.id === match.id ? match : candidate));
  }

  async clear(): Promise<void> {
    this.matches = [];
  }
}
