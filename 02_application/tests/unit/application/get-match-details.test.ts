import { describe, expect, it, vi } from "vitest";
import { GetMatchDetails } from "../../../src/application/use-cases/get-match-details.js";
import { createMatch, type Match } from "../../../src/domain/entities/match.js";
import type { Opponent } from "../../../src/domain/entities/opponent.js";
import type {
  ReplayAnalysis,
  ReplayAnalysisReaderPort
} from "../../../src/domain/ports/replay-analysis-reader-port.js";
import type { MatchRepository } from "../../../src/domain/repositories/match-repository.js";
import type { OpponentRepository } from "../../../src/domain/repositories/opponent-repository.js";
import type { EntityId } from "../../../src/domain/value-objects/entity-id.js";

describe("GetMatchDetails", () => {
  it("returns parsed replay analysis for a selected match", async () => {
    const analysis: ReplayAnalysis = {
      players: [{ name: "Enemy", race: "Zerg", apm: 180 }],
      averageApm: 180,
      graphs: [
        {
          id: "armyValue",
          label: "Army Value",
          yLabel: "Army Value",
          xLabel: "Elapsed Game Time",
          series: [{ playerName: "Enemy", race: "Zerg", samples: [{ seconds: 60, value: 1200 }] }]
        }
      ],
      buildOrders: [
        {
          playerName: "Enemy",
          race: "Zerg",
          entries: [{ seconds: 12, action: "Drone" }]
        }
      ]
    };
    const replayAnalysisReader: ReplayAnalysisReaderPort = {
      readAnalysis: vi.fn(async () => analysis)
    };
    const useCase = new GetMatchDetails(
      new InMemoryMatchRepository([
        match({ id: "match_001", opponentId: "opponent_001", replayPath: "A:\\Replays\\match.SC2Replay" })
      ]),
      new InMemoryOpponentRepository([opponent({ id: "opponent_001", nickname: "Enemy" })]),
      replayAnalysisReader
    );

    const result = await useCase.execute({ matchId: "match_001" });

    expect(result.details).toMatchObject({
      match: { id: "match_001" },
      opponent: { nickname: "Enemy" },
      averageApm: 180,
      graphs: [{ id: "armyValue" }],
      buildOrders: [{ playerName: "Enemy" }]
    });
    expect(replayAnalysisReader.readAnalysis).toHaveBeenCalledWith("A:\\Replays\\match.SC2Replay", "Enemy");
  });

  it("returns empty analysis when a match has no replay file", async () => {
    const replayAnalysisReader: ReplayAnalysisReaderPort = {
      readAnalysis: vi.fn()
    };
    const useCase = new GetMatchDetails(
      new InMemoryMatchRepository([match({ id: "match_001", opponentId: "opponent_001" })]),
      new InMemoryOpponentRepository([]),
      replayAnalysisReader
    );

    const result = await useCase.execute({ matchId: "match_001" });

    expect(result.details).toMatchObject({
      match: { id: "match_001" },
      replayPath: undefined,
      players: [],
      graphs: [],
      buildOrders: []
    });
    expect(replayAnalysisReader.readAnalysis).not.toHaveBeenCalled();
  });
});

function match(overrides: Partial<Match>): Match {
  return createMatch({
    id: "match_base",
    opponentId: "opponent_base",
    playedAt: "2026-05-09T10:00:00.000Z",
    map: "Taito Citadel LE",
    playerRace: "Terran",
    opponentRace: "Zerg",
    durationSeconds: 1220,
    now: "2026-05-09T10:00:00.000Z",
    ...overrides
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
