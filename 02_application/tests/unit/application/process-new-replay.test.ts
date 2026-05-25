import { describe, expect, it } from "vitest";
import { OpponentEnrichmentService } from "../../../src/application/services/opponent-enrichment-service.js";
import { ProcessNewReplay } from "../../../src/application/use-cases/process-new-replay.js";
import type { EnrichmentCandidateSnapshot } from "../../../src/domain/entities/enrichment-candidate-snapshot.js";
import { createMatch, type Match } from "../../../src/domain/entities/match.js";
import {
  createOpponent,
  type Opponent,
} from "../../../src/domain/entities/opponent.js";
import type {
  OpponentDataCandidate,
  OpponentDataSourcePort,
  OpponentSearchQuery,
} from "../../../src/domain/ports/opponent-data-source-port.js";
import type { EnrichmentCandidateRepository } from "../../../src/domain/repositories/enrichment-candidate-repository.js";
import type { MatchRepository } from "../../../src/domain/repositories/match-repository.js";
import type { OpponentRepository } from "../../../src/domain/repositories/opponent-repository.js";
import type { EntityId } from "../../../src/domain/value-objects/entity-id.js";

describe("ProcessNewReplay", () => {
  it("links replay metadata to the latest match without a replay path", async () => {
    const repository = new InMemoryMatchRepository([
      match("match_old", "2026-05-03T10:00:00.000Z"),
      match("match_new", "2026-05-03T10:30:00.000Z"),
    ]);
    const useCase = new ProcessNewReplay(
      repository,
      undefined,
      () => "2026-05-03T11:00:00.000Z",
    );

    const result = await useCase.execute({
      replayPath: "A:\\Replays\\match.SC2Replay",
      playedAt: "2026-05-03T10:35:00.000Z",
      map: "Ghost River LE",
      result: "win",
      durationSeconds: 720,
    });

    expect(result?.match).toMatchObject({
      id: "match_new",
      replayPath: "A:\\Replays\\match.SC2Replay",
      map: "Ghost River LE",
      result: "win",
      durationSeconds: 720,
      updatedAt: "2026-05-03T11:00:00.000Z",
    });
    await expect(repository.findById("match_new")).resolves.toMatchObject({
      replayPath: "A:\\Replays\\match.SC2Replay",
    });
  });

  it("updates opponent win/loss counters when replay resolves the final result", async () => {
    const matchRepository = new InMemoryMatchRepository([
      match("match_001", "2026-05-03T10:00:00.000Z"),
    ]);
    const opponentRepository = new InMemoryOpponentRepository([
      {
        ...createOpponent({
          id: "opponent_001",
          nickname: "SilverPure",
          race: "Zerg",
          now: "2026-05-03T10:00:00.000Z",
        }),
        encounters: 1,
      },
    ]);
    const useCase = new ProcessNewReplay(
      matchRepository,
      opponentRepository,
      () => "2026-05-03T11:00:00.000Z",
    );

    await useCase.execute({
      replayPath: "A:\\Replays\\loss.SC2Replay",
      playedAt: "2026-05-03T10:05:00.000Z",
      result: "loss",
    });

    await expect(
      opponentRepository.findById("opponent_001"),
    ).resolves.toMatchObject({
      encounters: 1,
      wins: 0,
      losses: 1,
    });
  });

  it("infers a user loss when replay metadata shows that the matched opponent won", async () => {
    const matchRepository = new InMemoryMatchRepository([
      match("match_001", "2026-05-03T10:00:00.000Z"),
    ]);
    const opponentRepository = new InMemoryOpponentRepository([
      {
        ...createOpponent({
          id: "opponent_001",
          nickname: "SilverPure",
          race: "Zerg",
          now: "2026-05-03T10:00:00.000Z",
        }),
        encounters: 1,
      },
    ]);
    const useCase = new ProcessNewReplay(
      matchRepository,
      opponentRepository,
      () => "2026-05-03T11:00:00.000Z",
    );

    const result = await useCase.execute({
      replayPath: "A:\\Replays\\loss.SC2Replay",
      playedAt: "2026-05-03T10:05:00.000Z",
      players: [
        { name: "RetorieS", race: "Terran", result: "loss" },
        { name: "SilverPure", race: "Zerg", result: "win" },
      ],
    });

    expect(result?.match.result).toBe("loss");
    await expect(
      opponentRepository.findById("opponent_001"),
    ).resolves.toMatchObject({
      wins: 0,
      losses: 1,
    });
  });

  it("infers a disconnect loss from the local replay player when live result stayed unknown", async () => {
    const matchRepository = new InMemoryMatchRepository([
      {
        ...match("match_001", "2026-05-23T03:04:00.000Z"),
        result: "unknown",
      },
    ]);
    const opponentRepository = new InMemoryOpponentRepository([
      {
        ...createOpponent({
          id: "opponent_001",
          nickname: "DrDre",
          race: "Zerg",
          now: "2026-05-23T03:04:00.000Z",
        }),
        encounters: 1,
      },
    ]);
    const useCase = new ProcessNewReplay(
      matchRepository,
      opponentRepository,
      () => "2026-05-23T03:30:00.000Z",
      {
        resolveLocalPlayerNames: () => ["RetorieS"],
      },
    );

    const result = await useCase.execute({
      replayPath: "A:\\Replays\\disconnect-loss.SC2Replay",
      playedAt: "2026-05-23T03:04:00.000Z",
      map: "Tourmaline LE",
      players: [
        { name: "RetorieS", race: "Terran", result: "loss" },
        { name: "DrDre", race: "Zerg" },
      ],
    });

    expect(result?.match).toMatchObject({
      id: "match_001",
      result: "loss",
      map: "Tourmaline LE",
    });
    await expect(
      opponentRepository.findById("opponent_001"),
    ).resolves.toMatchObject({
      wins: 0,
      losses: 1,
    });
  });

  it("repairs a match that already has the same replay path but missing result metadata", async () => {
    const replayPath = "A:\\Replays\\Mothership.SC2Replay";
    const matchRepository = new InMemoryMatchRepository([
      {
        ...match("match_001", "2026-05-03T10:00:00.000Z"),
        opponentRace: "Protoss",
        replayPath,
      },
    ]);
    const opponentRepository = new InMemoryOpponentRepository([
      {
        ...createOpponent({
          id: "opponent_001",
          nickname: "Milkaa",
          race: "Protoss",
          now: "2026-05-03T10:00:00.000Z",
        }),
        encounters: 1,
      },
    ]);
    const useCase = new ProcessNewReplay(
      matchRepository,
      opponentRepository,
      () => "2026-05-03T11:00:00.000Z",
    );

    const result = await useCase.execute({
      replayPath,
      playedAt: "2026-05-03T10:05:00.000Z",
      map: "Mothership LE",
      durationSeconds: 384,
      players: [
        { name: "RetorieS", race: "Terran", result: "loss" },
        { name: "Milkaa", race: "Protoss", result: "win" },
      ],
    });

    expect(result?.match).toMatchObject({
      id: "match_001",
      map: "Mothership LE",
      result: "loss",
      durationSeconds: 384,
    });
    await expect(
      opponentRepository.findById("opponent_001"),
    ).resolves.toMatchObject({
      wins: 0,
      losses: 1,
    });
  });

  it("strips replay clan tags when inferring the result from the opponent entry", async () => {
    const matchRepository = new InMemoryMatchRepository([
      {
        ...match("match_001", "2026-05-03T10:00:00.000Z"),
        opponentRace: "Protoss",
      },
    ]);
    const opponentRepository = new InMemoryOpponentRepository([
      {
        ...createOpponent({
          id: "opponent_001",
          nickname: "Milkaa",
          race: "Protoss",
          now: "2026-05-03T10:00:00.000Z",
        }),
        encounters: 1,
      },
    ]);
    const useCase = new ProcessNewReplay(matchRepository, opponentRepository);

    const result = await useCase.execute({
      replayPath: "A:\\Replays\\Mothership.SC2Replay",
      playedAt: "2026-05-03T10:05:00.000Z",
      players: [
        { name: "<RTS> RetorieS", race: "Terran", result: "loss" },
        { name: "<ZENT> Milkaa", race: "Protoss", result: "win" },
      ],
    });

    expect(result?.match.result).toBe("loss");
  });

  it("resolves barcode opponents through the replay profile toon after the replay is linked", async () => {
    const matchRepository = new InMemoryMatchRepository([
      {
        ...match("match_001", "2026-05-03T10:00:00.000Z"),
        opponentRace: "Terran",
      },
    ]);
    const opponentRepository = new InMemoryOpponentRepository([
      {
        ...createOpponent({
          id: "opponent_001",
          nickname: "llllllllll",
          race: "Terran",
          now: "2026-05-03T10:00:00.000Z",
        }),
        encounters: 1,
      },
    ]);
    const candidateRepository = new InMemoryEnrichmentCandidateRepository();
    const source = new FakeOpponentDataSource([
      {
        source: "SC2Pulse",
        nickname: "Oliveira",
        race: "Terran",
        battleTag: "forte#11934",
        aliases: ["llllllllll", "forte"],
        mmr: 6566,
        league: "Grandmaster",
        totalGames: 285,
        confidenceScore: 0.95,
      },
    ]);
    const useCase = new ProcessNewReplay(
      matchRepository,
      opponentRepository,
      () => "2026-05-03T11:00:00.000Z",
      {
        enrichmentService: new OpponentEnrichmentService([source], {
          clock: () => "2026-05-03T11:00:00.000Z",
        }),
        enrichmentCandidateRepository: candidateRepository,
      },
    );

    await useCase.execute({
      replayPath: "A:\\Replays\\barcode.SC2Replay",
      playedAt: "2026-05-03T10:05:00.000Z",
      result: "loss",
      players: [
        { name: "RetorieS", race: "Terran", result: "loss", toon: "1-S2-1-111" },
        { name: "llllllllll", race: "Terran", result: "win", toon: "2-S2-1-5501280" },
      ],
    });

    expect(source.queries).toEqual([
      {
        nickname: "llllllllll",
        profileLink: "https://starcraft2.blizzard.com/profile/2/1/5501280",
        race: "Terran",
        region: undefined,
        season: undefined,
      },
    ]);
    await expect(opponentRepository.findById("opponent_001")).resolves.toMatchObject({
      nickname: "llllllllll",
      revealedNickname: "Oliveira",
      battleTag: "forte#11934",
      aliases: ["llllllllll", "forte"],
      mmrAtLastMatch: 6566,
      league: "Grandmaster",
      confidenceScore: 0.95,
    });
    await expect(candidateRepository.findByOpponentId("opponent_001")).resolves.toMatchObject([
      {
        source: "SC2Pulse",
        nickname: "Oliveira",
        selected: true,
        capturedAt: "2026-05-03T11:00:00.000Z",
      },
    ]);
  });

  it("does not enrich a barcode opponent from a non-barcode replay player", async () => {
    const matchRepository = new InMemoryMatchRepository([
      {
        ...match("match_001", "2026-05-03T10:00:00.000Z"),
        opponentRace: "Unknown",
        result: "loss",
      },
    ]);
    const opponentRepository = new InMemoryOpponentRepository([
      {
        ...createOpponent({
          id: "opponent_001",
          nickname: "llllllllll",
          race: "Unknown",
          mmrAtLastMatch: 4723,
          now: "2026-05-03T10:00:00.000Z",
        }),
        encounters: 1,
      },
    ]);
    const source = new FakeOpponentDataSource([
      {
        source: "SC2Pulse",
        nickname: "LifeForAiur",
        race: "Zerg",
        battleTag: "LifeForAiur#1234",
        aliases: ["LifeForAiur"],
        mmr: 4723,
        league: "Grandmaster",
        confidenceScore: 0.99,
      },
    ]);
    const useCase = new ProcessNewReplay(
      matchRepository,
      opponentRepository,
      () => "2026-05-03T11:00:00.000Z",
      {
        enrichmentService: new OpponentEnrichmentService([source]),
        resolveLocalPlayerNames: () => ["LifeForAiur"],
      },
    );

    await useCase.execute({
      replayPath: "A:\\Replays\\wrong-local.SC2Replay",
      playedAt: "2026-05-03T10:05:00.000Z",
      players: [
        { name: "LifeForAiur", race: "Zerg", result: "win", toon: "2-S2-1-999" },
        { name: "UnknownOpponent", race: "Protoss", result: "loss" },
      ],
    });

    expect(source.queries).toEqual([]);
    const storedOpponent = await opponentRepository.findById("opponent_001");
    expect(storedOpponent).toMatchObject({
      nickname: "llllllllll",
      mmrAtLastMatch: 4723,
    });
    expect(storedOpponent?.revealedNickname).toBeUndefined();
    expect(storedOpponent?.battleTag).toBeUndefined();
  });

  it("filters local player candidates when barcode replay enrichment queries SC2 Pulse", async () => {
    const matchRepository = new InMemoryMatchRepository([
      {
        ...match("match_001", "2026-05-03T10:00:00.000Z"),
        opponentRace: "Zerg",
      },
    ]);
    const opponentRepository = new InMemoryOpponentRepository([
      {
        ...createOpponent({
          id: "opponent_001",
          nickname: "llllllllll",
          race: "Zerg",
          mmrAtLastMatch: 4723,
          now: "2026-05-03T10:00:00.000Z",
        }),
        encounters: 1,
      },
    ]);
    const source = new FakeOpponentDataSource([
      {
        source: "SC2Pulse",
        nickname: "LifeForAiur",
        race: "Zerg",
        battleTag: "LifeForAiur#1234",
        aliases: ["llllllllll"],
        mmr: 4723,
        league: "Grandmaster",
        confidenceScore: 0.99,
      },
    ]);
    const candidateRepository = new InMemoryEnrichmentCandidateRepository();
    const useCase = new ProcessNewReplay(
      matchRepository,
      opponentRepository,
      () => "2026-05-03T11:00:00.000Z",
      {
        enrichmentService: new OpponentEnrichmentService([source]),
        enrichmentCandidateRepository: candidateRepository,
        resolveLocalPlayerNames: () => ["LifeForAiur"],
      },
    );

    await useCase.execute({
      replayPath: "A:\\Replays\\local-candidate.SC2Replay",
      playedAt: "2026-05-03T10:05:00.000Z",
      players: [
        { name: "LifeForAiur", race: "Protoss", result: "loss", toon: "2-S2-1-999" },
        { name: "llllllllll", race: "Zerg", result: "win", toon: "2-S2-1-5501280" },
      ],
    });

    expect(source.queries).toHaveLength(1);
    const storedOpponent = await opponentRepository.findById("opponent_001");
    expect(storedOpponent).toMatchObject({
      nickname: "llllllllll",
      mmrAtLastMatch: 4723,
    });
    expect(storedOpponent?.revealedNickname).toBeUndefined();
    expect(storedOpponent?.battleTag).toBeUndefined();
    await expect(candidateRepository.findByOpponentId("opponent_001")).resolves.toEqual([]);
  });

  it("repairs unknown barcode race from replay and keeps client api mmr on the real race profile", async () => {
    const matchRepository = new InMemoryMatchRepository([
      {
        ...match("match_001", "2026-05-03T10:00:00.000Z"),
        opponentRace: "Unknown",
      },
    ]);
    const opponentRepository = new InMemoryOpponentRepository([
      {
        ...createOpponent({
          id: "opponent_001",
          nickname: "llllllllll",
          race: "Unknown",
          mmrAtLastMatch: 4662,
          now: "2026-05-03T10:00:00.000Z",
        }),
        encounters: 1,
      },
    ]);
    const useCase = new ProcessNewReplay(
      matchRepository,
      opponentRepository,
      () => "2026-05-03T11:00:00.000Z",
    );

    const result = await useCase.execute({
      replayPath: "A:\\Replays\\barcode-unknown.SC2Replay",
      playedAt: "2026-05-03T10:05:00.000Z",
      players: [
        { name: "RetorieS", race: "Terran", result: "loss" },
        { name: "llllllllll", race: "Protoss", result: "win" },
      ],
    });

    expect(result?.match).toMatchObject({
      opponentRace: "Protoss",
      playerRace: "Terran",
      result: "loss",
    });
    await expect(matchRepository.findById("match_001")).resolves.toMatchObject({
      opponentRace: "Protoss",
      playerRace: "Terran",
    });
    await expect(opponentRepository.findById("opponent_001")).resolves.toMatchObject({
      nickname: "llllllllll",
      race: "Protoss",
      mmrAtLastMatch: 4662,
      raceProfiles: {
        Protoss: {
          mmrAtLastMatch: 4662,
        },
      },
    });
  });

  it("returns null when all games already have replay paths", async () => {
    const repository = new InMemoryMatchRepository([
      {
        ...match("match_001", "2026-05-03T10:00:00.000Z"),
        replayPath: "A:\\Replays\\old.SC2Replay",
      },
    ]);
    const useCase = new ProcessNewReplay(repository);

    await expect(
      useCase.execute({ replayPath: "A:\\Replays\\new.SC2Replay" }),
    ).resolves.toBeNull();
  });
});

function match(id: EntityId, playedAt: string): Match {
  return createMatch({
    id,
    opponentId: "opponent_001",
    playedAt,
    playerRace: "Terran",
    opponentRace: "Zerg",
    now: playedAt,
  });
}

class FakeOpponentDataSource implements OpponentDataSourcePort {
  readonly sourceName = "SC2Pulse";
  readonly queries: OpponentSearchQuery[] = [];

  constructor(private readonly candidates: readonly OpponentDataCandidate[]) {}

  async searchOpponent(query: OpponentSearchQuery): Promise<readonly OpponentDataCandidate[]> {
    this.queries.push(query);
    return this.candidates;
  }
}

class InMemoryEnrichmentCandidateRepository implements EnrichmentCandidateRepository {
  private candidatesByOpponent = new Map<EntityId, readonly EnrichmentCandidateSnapshot[]>();

  async findByOpponentId(opponentId: EntityId): Promise<readonly EnrichmentCandidateSnapshot[]> {
    return this.candidatesByOpponent.get(opponentId) ?? [];
  }

  async replaceForOpponent(opponentId: EntityId, candidates: readonly EnrichmentCandidateSnapshot[]): Promise<void> {
    this.candidatesByOpponent.set(opponentId, [...candidates]);
  }

  async clear(): Promise<void> {
    this.candidatesByOpponent.clear();
  }
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
    this.opponents = this.opponents.map((candidate) =>
      candidate.id === opponent.id ? opponent : candidate,
    );
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
    this.matches = this.matches.map((candidate) =>
      candidate.id === match.id ? match : candidate,
    );
  }

  async clear(): Promise<void> {
    this.matches = [];
  }
}
