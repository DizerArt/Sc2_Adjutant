import { describe, expect, it } from "vitest";
import { HandleDetectedGame } from "../../../src/application/use-cases/handle-detected-game.js";
import { OpponentEnrichmentService } from "../../../src/application/services/opponent-enrichment-service.js";
import type { EnrichmentCandidateSnapshot } from "../../../src/domain/entities/enrichment-candidate-snapshot.js";
import type { GameSession } from "../../../src/domain/entities/game-session.js";
import type { Match } from "../../../src/domain/entities/match.js";
import type { Opponent } from "../../../src/domain/entities/opponent.js";
import type {
  OpponentDataCandidate,
  OpponentDataSourcePort,
  OpponentSearchQuery
} from "../../../src/domain/ports/opponent-data-source-port.js";
import type { MatchRepository } from "../../../src/domain/repositories/match-repository.js";
import type { EnrichmentCandidateRepository } from "../../../src/domain/repositories/enrichment-candidate-repository.js";
import type { OpponentRepository } from "../../../src/domain/repositories/opponent-repository.js";
import type { EntityId } from "../../../src/domain/value-objects/entity-id.js";

describe("HandleDetectedGame", () => {
  it("registers a detected game without enrichment when no service is configured", async () => {
    const opponentRepository = new InMemoryOpponentRepository();
    const matchRepository = new InMemoryMatchRepository();
    const useCase = new HandleDetectedGame({
      opponentRepository,
      matchRepository,
      clock: () => "2026-05-03T04:00:00.000Z"
    });

    const result = await useCase.execute({
      session: activeSession(),
      userName: "RetorieS"
    });

    expect(result?.enrichmentApplied).toBe(false);
    expect(result?.enrichedOpponent.nickname).toBe("RobbyG");
    expect(await opponentRepository.findAll()).toHaveLength(1);
  });

  it("registers and persists enriched opponent data", async () => {
    const opponentRepository = new InMemoryOpponentRepository();
    const enrichmentCandidateRepository = new InMemoryEnrichmentCandidateRepository();
    const source = new FakeSource("GoodSource", [
      {
        source: "GoodSource",
        nickname: "RobbyG",
        race: "Terran",
        aliases: ["Robby"],
        mmr: 4300,
        league: "Master",
        confidenceScore: 0.88
      }
    ]);
    const useCase = new HandleDetectedGame({
      opponentRepository,
      matchRepository: new InMemoryMatchRepository(),
      enrichmentCandidateRepository,
      clock: () => "2026-05-03T04:00:00.000Z",
      enrichmentService: new OpponentEnrichmentService(
        [source],
        {
          clock: () => "2026-05-03T04:05:00.000Z"
        }
      )
    });

    const result = await useCase.execute({
      session: activeSession(),
      userName: "RetorieS",
      region: "EU"
    });

    const storedOpponent = await opponentRepository.findById("opponent_robbyg");
    const storedCandidates = await enrichmentCandidateRepository.findByOpponentId("opponent_robbyg");

    expect(result?.enrichmentApplied).toBe(true);
    expect(result?.enrichedOpponent).toMatchObject({
      mmrAtLastMatch: 4300,
      league: "Master",
      confidenceScore: 0.88
    });
    expect(storedOpponent?.mmrAtLastMatch).toBe(4300);
    expect(storedCandidates).toMatchObject([
      {
        source: "GoodSource",
        nickname: "RobbyG",
        selected: true,
        confidenceScore: 0.88
      }
    ]);
    expect(source.queries).toEqual([
      {
        nickname: "RobbyG",
        race: "Terran",
        region: "EU"
      }
    ]);
  });

  it("does not duplicate matches or wins across repeated polls of the same active game", async () => {
    const opponentRepository = new InMemoryOpponentRepository();
    const matchRepository = new InMemoryMatchRepository();
    const useCase = new HandleDetectedGame({
      opponentRepository,
      matchRepository,
      clock: () => "2026-05-03T04:00:00.000Z"
    });

    // Same stable session.id reused across polls (as Sc2GamePollingService now guarantees).
    // First three polls report "Undecided", later polls carry the final Victory result.
    for (let pollIndex = 0; pollIndex < 6; pollIndex += 1) {
      const undecided = pollIndex < 3;
      await useCase.execute({
        session: {
          id: "retories|robbyg:2026-05-03T04:00:00.000Z",
          isActive: true,
          mode: "ranked-1v1",
          detectedAt: "2026-05-03T04:00:00.000Z",
          startedAt: "2026-05-03T04:00:00.000Z",
          players: [
            {
              name: "RetorieS",
              race: "Terran",
              result: undecided ? "Undecided" : "Victory",
              isUser: true
            },
            {
              name: "RobbyG",
              race: "Terran",
              result: undecided ? "Undecided" : "Defeat"
            }
          ]
        },
        userName: "RetorieS"
      });
    }

    const matches = await matchRepository.findAll();
    expect(matches).toHaveLength(1);
    expect(matches[0]?.result).toBe("win");

    const opponents = await opponentRepository.findAll();
    expect(opponents).toHaveLength(1);
    expect(opponents[0]).toMatchObject({
      encounters: 1,
      wins: 1,
      losses: 0
    });
  });

  it("resolves barcode opponents through the configured enrichment sources", async () => {
    const opponentRepository = new InMemoryOpponentRepository();
    const enrichmentCandidateRepository = new InMemoryEnrichmentCandidateRepository();
    const sourceCalls: string[] = [];
    const source = new FakeSource("SC2Pulse", [
      {
        source: "SC2Pulse",
        nickname: "SuperMage",
        race: "Protoss",
        aliases: ["IIIIIIIII"],
        battleTag: "SuperMage#22387",
        mmr: 3872,
        league: "Master",
        confidenceScore: 0.92
      }
    ], sourceCalls);
    const useCase = new HandleDetectedGame({
      opponentRepository,
      matchRepository: new InMemoryMatchRepository(),
      enrichmentCandidateRepository,
      enrichmentService: new OpponentEnrichmentService(
        [source],
        {
          clock: () => "2026-05-03T04:05:00.000Z"
        }
      )
    });

    const result = await useCase.execute({
      session: {
        id: "iiiiiiiii|retories:2026-05-03T04:00:00.000Z",
        isActive: true,
        mode: "ranked-1v1",
        detectedAt: "2026-05-03T04:00:00.000Z",
        startedAt: "2026-05-03T04:00:00.000Z",
        players: [
          { name: "RetorieS", race: "Terran", result: "Undecided", isUser: true },
          {
            name: "IIIIIIIII",
            race: "Protoss",
            result: "Undecided",
            mmr: 4100,
            profileLink: "battlenet:://starcraft/profile/2/10220887502839873536"
          }
        ]
      },
      userName: "RetorieS"
    });

    expect(sourceCalls).toEqual(["SC2Pulse"]);
    expect(result?.enrichmentApplied).toBe(true);
    expect(result?.enrichmentWarnings).toEqual([]);
    expect(result?.enrichedOpponent.nickname).toBe("IIIIIIIII");
    expect(result?.enrichedOpponent.revealedNickname).toBe("SuperMage");
    expect(result?.enrichedOpponent.aliases).toEqual(["IIIIIIIII"]);
    expect(result?.enrichedOpponent.battleTag).toBe("SuperMage#22387");
    expect(result?.enrichedOpponent.mmrAtLastMatch).toBe(3872);
    expect(result?.enrichedOpponent.raceProfiles?.Protoss?.mmrAtLastMatch).toBe(3872);
    expect(source.queries).toMatchObject([
      {
        nickname: "IIIIIIIII",
        profileLink: "battlenet:://starcraft/profile/2/10220887502839873536",
        race: "Protoss",
        region: undefined
      }
    ]);
    const storedCandidates = await enrichmentCandidateRepository.findByOpponentId(result!.opponent.id);
    expect(storedCandidates).toMatchObject([
      {
        source: "SC2Pulse",
        nickname: "SuperMage",
        selected: true
      }
    ]);
  });

  it("keeps barcode opponents unchanged when enrichment has no match", async () => {
    const opponentRepository = new InMemoryOpponentRepository();
    const useCase = new HandleDetectedGame({
      opponentRepository,
      matchRepository: new InMemoryMatchRepository(),
      enrichmentService: new OpponentEnrichmentService([
        new FakeSource("SC2Pulse", [])
      ])
    });

    const result = await useCase.execute({
      session: {
        id: "iiiiiiiii|retories:2026-05-03T04:00:00.000Z",
        isActive: true,
        mode: "ranked-1v1",
        detectedAt: "2026-05-03T04:00:00.000Z",
        startedAt: "2026-05-03T04:00:00.000Z",
        players: [
          { name: "RetorieS", race: "Terran", result: "Undecided", isUser: true },
          {
            name: "IIIIIIIII",
            race: "Protoss",
            result: "Undecided",
            mmr: 4100,
            profileLink: "battlenet:://starcraft/profile/2/10220887502839873536"
          }
        ]
      },
      userName: "RetorieS"
    });

    expect(result?.enrichmentApplied).toBe(false);
    expect(result?.enrichedOpponent.nickname).toBe("IIIIIIIII");
    expect(result?.enrichedOpponent.mmrAtLastMatch).toBe(4100);
    expect(result?.enrichedOpponent.raceProfiles?.Protoss?.mmrAtLastMatch).toBe(4100);
  });

  it("keeps the observed match race when the external profile identifies a random player", async () => {
    const opponentRepository = new InMemoryOpponentRepository();
    const matchRepository = new InMemoryMatchRepository();
    const useCase = new HandleDetectedGame({
      opponentRepository,
      matchRepository,
      clock: () => "2026-05-03T04:00:00.000Z",
      enrichmentService: new OpponentEnrichmentService([
        new FakeSource("SC2Pulse", [
          {
            source: "SC2Pulse",
            nickname: "RandomMain",
            race: "Random",
            aliases: [],
            mmr: 4400,
            league: "Master",
            confidenceScore: 0.92
          }
        ])
      ])
    });

    const result = await useCase.execute({
      session: {
        id: "randommain|retories:2026-05-03T04:00:00.000Z",
        isActive: true,
        mode: "ranked-1v1",
        detectedAt: "2026-05-03T04:00:00.000Z",
        startedAt: "2026-05-03T04:00:00.000Z",
        players: [
          { name: "RetorieS", race: "Terran", result: "Undecided", isUser: true },
          { name: "RandomMain", race: "Zerg", result: "Undecided" }
        ]
      },
      userName: "RetorieS"
    });

    const matches = await matchRepository.findAll();
    const opponents = await opponentRepository.findAll();

    expect(result?.match.opponentRace).toBe("Zerg");
    expect(result?.enrichedOpponent.race).toBe("Zerg");
    expect(matches[0]?.opponentRace).toBe("Zerg");
    expect(opponents[0]?.race).toBe("Zerg");
    expect(opponents[0]?.raceProfiles?.Zerg?.mmrAtLastMatch).toBe(4400);
  });

  it("keeps registration successful when enrichment source fails", async () => {
    const useCase = new HandleDetectedGame({
      opponentRepository: new InMemoryOpponentRepository(),
      matchRepository: new InMemoryMatchRepository(),
      enrichmentService: new OpponentEnrichmentService([new ThrowingSource("BrokenSource")])
    });

    const result = await useCase.execute({
      session: activeSession(),
      userName: "RetorieS"
    });

    expect(result?.enrichmentApplied).toBe(false);
    expect(result?.enrichmentWarnings).toEqual([
      {
        source: "BrokenSource",
        message: "source unavailable"
      }
    ]);
    expect(result?.enrichedOpponent.nickname).toBe("RobbyG");
  });

  it("does not enrich an opponent with a candidate that matches the local player", async () => {
    const opponentRepository = new InMemoryOpponentRepository();
    const enrichmentCandidateRepository = new InMemoryEnrichmentCandidateRepository();
    const useCase = new HandleDetectedGame({
      opponentRepository,
      matchRepository: new InMemoryMatchRepository(),
      enrichmentCandidateRepository,
      clock: () => "2026-05-03T04:00:00.000Z",
      enrichmentService: new OpponentEnrichmentService([
        new FakeSource("SelfPollutedSource", [
          {
            source: "SelfPollutedSource",
            nickname: "RetorieS",
            race: "Terran",
            battleTag: "RetorieS#2321",
            aliases: [],
            mmr: 4577,
            league: "Master",
            confidenceScore: 0.99
          }
        ])
      ])
    });

    const result = await useCase.execute({
      session: {
        id: "RetorieS:Terran|Neo:Protoss:0",
        isActive: true,
        mode: "ranked-1v1",
        detectedAt: "2026-05-03T04:00:00.000Z",
        players: [
          { name: "RetorieS", race: "Terran", result: "Undecided", isUser: true },
          { name: "Neo", race: "Protoss", result: "Undecided" }
        ]
      },
      userName: "RetorieS"
    });

    const storedOpponent = await opponentRepository.findById("opponent_neo");
    const storedCandidates = await enrichmentCandidateRepository.findByOpponentId("opponent_neo");

    expect(result?.enrichmentApplied).toBe(false);
    expect(result?.enrichedOpponent).toMatchObject({
      nickname: "Neo",
      race: "Protoss"
    });
    expect(storedOpponent?.nickname).toBe("Neo");
    expect(storedCandidates).toEqual([]);
  });
});

function activeSession(): GameSession {
  return {
    id: "RetorieS:Terran|RobbyG:Terran:0",
    isActive: true,
    mode: "ranked-1v1",
    detectedAt: "2026-05-03T04:00:00.000Z",
    players: [
      { name: "RetorieS", race: "Terran", result: "Undecided", isUser: true },
      { name: "RobbyG", race: "Terran", result: "Undecided" }
    ]
  };
}

class FakeSource implements OpponentDataSourcePort {
  readonly queries: OpponentSearchQuery[] = [];

  constructor(
    readonly sourceName: string,
    private readonly candidates: readonly OpponentDataCandidate[],
    private readonly callLog?: string[]
  ) {}

  async searchOpponent(query: OpponentSearchQuery): Promise<readonly OpponentDataCandidate[]> {
    this.callLog?.push(this.sourceName);
    this.queries.push(query);
    return this.candidates;
  }
}

class ThrowingSource implements OpponentDataSourcePort {
  constructor(readonly sourceName: string) {}

  async searchOpponent(): Promise<readonly OpponentDataCandidate[]> {
    throw new Error("source unavailable");
  }
}

class InMemoryOpponentRepository implements OpponentRepository {
  private readonly opponents = new Map<EntityId, Opponent>();

  async findAll(): Promise<readonly Opponent[]> {
    return [...this.opponents.values()];
  }

  async findById(id: EntityId): Promise<Opponent | null> {
    return this.opponents.get(id) ?? null;
  }

  async save(opponent: Opponent): Promise<void> {
    this.opponents.set(opponent.id, opponent);
  }

  async clear(): Promise<void> {
    this.opponents.clear();
  }
}

class InMemoryMatchRepository implements MatchRepository {
  private readonly matches = new Map<EntityId, Match>();

  async findAll(): Promise<readonly Match[]> {
    return [...this.matches.values()];
  }

  async findById(id: EntityId): Promise<Match | null> {
    return this.matches.get(id) ?? null;
  }

  async findByOpponentId(opponentId: EntityId): Promise<readonly Match[]> {
    return [...this.matches.values()].filter((match) => match.opponentId === opponentId);
  }

  async save(match: Match): Promise<void> {
    this.matches.set(match.id, match);
  }

  async clear(): Promise<void> {
    this.matches.clear();
  }
}

class InMemoryEnrichmentCandidateRepository implements EnrichmentCandidateRepository {
  private readonly candidates = new Map<EntityId, readonly EnrichmentCandidateSnapshot[]>();

  async findByOpponentId(opponentId: EntityId): Promise<readonly EnrichmentCandidateSnapshot[]> {
    return this.candidates.get(opponentId) ?? [];
  }

  async replaceForOpponent(
    opponentId: EntityId,
    candidates: readonly EnrichmentCandidateSnapshot[]
  ): Promise<void> {
    this.candidates.set(opponentId, candidates);
  }

  async clear(): Promise<void> {
    this.candidates.clear();
  }
}
