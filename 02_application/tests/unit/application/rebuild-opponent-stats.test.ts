import { describe, expect, it } from "vitest";
import { RebuildOpponentStats } from "../../../src/application/use-cases/rebuild-opponent-stats.js";
import type { Match } from "../../../src/domain/entities/match.js";
import type { Opponent } from "../../../src/domain/entities/opponent.js";
import type { MatchRepository } from "../../../src/domain/repositories/match-repository.js";
import type { OpponentRepository } from "../../../src/domain/repositories/opponent-repository.js";
import type { EntityId } from "../../../src/domain/value-objects/entity-id.js";

describe("RebuildOpponentStats", () => {
  it("recomputes inflated wins and encounters from the actual match log", async () => {
    const opponentRepository = new InMemoryOpponentRepository([
      buildOpponent({ id: "o-1", encounters: 17, wins: 14, losses: 0 })
    ]);
    const matchRepository = new InMemoryMatchRepository([
      buildMatch({ id: "m-1", opponentId: "o-1", result: "win", playedAt: "2026-05-03T17:00:00.000Z" })
    ]);

    const result = await new RebuildOpponentStats({
      opponentRepository,
      matchRepository,
      clock: () => "2026-05-03T20:00:00.000Z"
    }).execute();

    expect(result).toEqual({ inspectedCount: 1, rebuiltCount: 1 });
    const opponents = await opponentRepository.findAll();
    expect(opponents[0]).toMatchObject({
      encounters: 1,
      wins: 1,
      losses: 0,
      lastMatchDate: "2026-05-03T17:00:00.000Z",
      updatedAt: "2026-05-03T20:00:00.000Z"
    });
  });

  it("does not rewrite opponents whose stats already match", async () => {
    const opponentRepository = new InMemoryOpponentRepository([
      buildOpponent({
        id: "o-1",
        encounters: 2,
        wins: 1,
        losses: 1,
        lastMatchDate: "2026-05-03T17:00:00.000Z"
      })
    ]);
    const matchRepository = new InMemoryMatchRepository([
      buildMatch({ id: "m-1", opponentId: "o-1", result: "win", playedAt: "2026-05-03T16:00:00.000Z" }),
      buildMatch({ id: "m-2", opponentId: "o-1", result: "loss", playedAt: "2026-05-03T17:00:00.000Z" })
    ]);

    const result = await new RebuildOpponentStats({
      opponentRepository,
      matchRepository
    }).execute();

    expect(result).toEqual({ inspectedCount: 1, rebuiltCount: 0 });
  });

  it("zeroes counters for opponents with no matches", async () => {
    const opponentRepository = new InMemoryOpponentRepository([
      buildOpponent({ id: "o-1", encounters: 5, wins: 3, losses: 2 })
    ]);
    const matchRepository = new InMemoryMatchRepository([]);

    await new RebuildOpponentStats({ opponentRepository, matchRepository }).execute();
    const opponents = await opponentRepository.findAll();
    expect(opponents[0]).toMatchObject({ encounters: 0, wins: 0, losses: 0 });
  });

  it("ignores 'unknown' results when counting wins and losses", async () => {
    const opponentRepository = new InMemoryOpponentRepository([
      buildOpponent({ id: "o-1", encounters: 0, wins: 0, losses: 0 })
    ]);
    const matchRepository = new InMemoryMatchRepository([
      buildMatch({ id: "m-1", opponentId: "o-1", result: "win", playedAt: "2026-05-03T17:00:00.000Z" }),
      buildMatch({ id: "m-2", opponentId: "o-1", result: "unknown", playedAt: "2026-05-03T17:30:00.000Z" }),
      buildMatch({ id: "m-3", opponentId: "o-1", result: "loss", playedAt: "2026-05-03T18:00:00.000Z" })
    ]);

    await new RebuildOpponentStats({ opponentRepository, matchRepository }).execute();
    const opponents = await opponentRepository.findAll();
    expect(opponents[0]).toMatchObject({ encounters: 3, wins: 1, losses: 1 });
  });
});

function buildOpponent(overrides: Partial<Opponent> & { readonly id: string }): Opponent {
  return {
    nickname: "TomBombadill",
    race: "Protoss",
    aliases: [],
    encounters: 0,
    wins: 0,
    losses: 0,
    notes: [],
    strategyTags: [],
    createdAt: "2026-05-03T10:00:00.000Z",
    updatedAt: "2026-05-03T10:00:00.000Z",
    ...overrides
  };
}

function buildMatch(overrides: Partial<Match> & { readonly id: string; readonly opponentId: string }): Match {
  return {
    playedAt: "2026-05-03T17:00:00.000Z",
    playerRace: "Terran",
    opponentRace: "Protoss",
    result: "unknown",
    favorite: false,
    notes: [],
    createdAt: "2026-05-03T17:00:00.000Z",
    updatedAt: "2026-05-03T17:00:00.000Z",
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
