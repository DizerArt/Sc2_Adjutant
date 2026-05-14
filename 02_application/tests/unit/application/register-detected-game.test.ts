import { describe, expect, it } from "vitest";
import { RegisterDetectedGame } from "../../../src/application/use-cases/register-detected-game.js";
import type { GameSession } from "../../../src/domain/entities/game-session.js";
import type { Match } from "../../../src/domain/entities/match.js";
import type { Opponent } from "../../../src/domain/entities/opponent.js";
import type { MatchRepository } from "../../../src/domain/repositories/match-repository.js";
import type { OpponentRepository } from "../../../src/domain/repositories/opponent-repository.js";
import type { EntityId } from "../../../src/domain/value-objects/entity-id.js";

describe("RegisterDetectedGame", () => {
  it("creates an opponent and match from an active ranked session", async () => {
    const opponentRepository = new InMemoryOpponentRepository();
    const matchRepository = new InMemoryMatchRepository();
    const useCase = new RegisterDetectedGame({
      opponentRepository,
      matchRepository,
      clock: () => "2026-05-03T01:00:00.000Z"
    });

    const result = await useCase.execute({
      session: activeSession(),
      userName: "RetorieS"
    });

    expect(result?.createdOpponent).toBe(true);
    expect(result?.opponent).toMatchObject({
      id: "opponent_silverpure",
      nickname: "SilverPure",
      race: "Protoss",
      encounters: 1,
      wins: 0,
      losses: 0,
      lastMatchDate: "2026-05-03T00:30:00.000Z"
    });
    expect(result?.match).toMatchObject({
      id: "match_silverpure-protoss-retories-terran-139",
      opponentId: "opponent_silverpure",
      playerRace: "Terran",
      opponentRace: "Protoss",
      result: "unknown"
    });
    expect(await opponentRepository.findAll()).toHaveLength(1);
    expect(await matchRepository.findAll()).toHaveLength(1);
  });

  it("keeps repeated registration of the same detected match idempotent", async () => {
    const opponentRepository = new InMemoryOpponentRepository();
    const matchRepository = new InMemoryMatchRepository();
    const useCase = new RegisterDetectedGame({
      opponentRepository,
      matchRepository,
      clock: () => "2026-05-03T01:00:00.000Z"
    });

    await useCase.execute({ session: activeSession(), userName: "RetorieS" });
    await useCase.execute({ session: activeSession(), userName: "RetorieS" });

    const opponents = await opponentRepository.findAll();
    const matches = await matchRepository.findAll();

    expect(opponents).toHaveLength(1);
    expect(opponents[0]?.encounters).toBe(1);
    expect(matches).toHaveLength(1);
  });

  it("reuses an unresolved live match after monitoring restarts during the same game", async () => {
    const opponentRepository = new InMemoryOpponentRepository();
    const matchRepository = new InMemoryMatchRepository();
    const useCase = new RegisterDetectedGame({
      opponentRepository,
      matchRepository,
      clock: () => "2026-05-03T01:00:00.000Z"
    });

    await useCase.execute({ session: activeSession(), userName: "RetorieS" });
    await useCase.execute({
      session: {
        ...activeSession(),
        id: "SilverPure:Protoss|RetorieS:Terran:restart",
        detectedAt: "2026-05-03T00:35:00.000Z"
      },
      userName: "RetorieS"
    });

    const opponents = await opponentRepository.findAll();
    const matches = await matchRepository.findAll();

    expect(opponents).toHaveLength(1);
    expect(opponents[0]?.encounters).toBe(1);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.playedAt).toBe("2026-05-03T00:30:00.000Z");
  });

  it("updates an existing active match when the final result becomes available", async () => {
    const opponentRepository = new InMemoryOpponentRepository();
    const matchRepository = new InMemoryMatchRepository();
    const useCase = new RegisterDetectedGame({
      opponentRepository,
      matchRepository,
      clock: () => "2026-05-03T01:00:00.000Z"
    });

    await useCase.execute({ session: activeSession(), userName: "RetorieS" });
    const result = await useCase.execute({
      session: {
        ...activeSession(),
        players: [
          { name: "SilverPure", race: "Protoss", result: "Defeat" },
          { name: "RetorieS", race: "Terran", result: "Victory", isUser: true }
        ]
      },
      userName: "RetorieS"
    });

    const opponents = await opponentRepository.findAll();
    const matches = await matchRepository.findAll();

    expect(result?.match.result).toBe("win");
    expect(matches).toHaveLength(1);
    expect(matches[0]?.result).toBe("win");
    expect(opponents[0]).toMatchObject({
      encounters: 1,
      wins: 1,
      losses: 0
    });
  });

  it("counts a quick rematch against the same opponent after the previous match was resolved", async () => {
    const opponentRepository = new InMemoryOpponentRepository();
    const matchRepository = new InMemoryMatchRepository();
    const useCase = new RegisterDetectedGame({
      opponentRepository,
      matchRepository,
      clock: () => "2026-05-03T01:00:00.000Z"
    });

    await useCase.execute({
      session: {
        ...activeSession(),
        id: "SilverPure:Protoss|RetorieS:Terran:2026-05-03T00:30:00.000Z",
        detectedAt: "2026-05-03T00:30:00.000Z",
        startedAt: "2026-05-03T00:30:00.000Z",
        players: [
          { name: "SilverPure", race: "Protoss", result: "Defeat" },
          { name: "RetorieS", race: "Terran", result: "Victory", isUser: true }
        ]
      },
      userName: "RetorieS"
    });
    await useCase.execute({
      session: {
        ...activeSession(),
        id: "SilverPure:Protoss|RetorieS:Terran:2026-05-03T00:33:00.000Z",
        detectedAt: "2026-05-03T00:33:00.000Z",
        startedAt: "2026-05-03T00:33:00.000Z",
        players: [
          { name: "SilverPure", race: "Protoss", result: "Defeat" },
          { name: "RetorieS", race: "Terran", result: "Victory", isUser: true }
        ]
      },
      userName: "RetorieS"
    });

    const opponents = await opponentRepository.findAll();
    const matches = await matchRepository.findAll();

    expect(matches).toHaveLength(2);
    expect(opponents).toHaveLength(1);
    expect(opponents[0]).toMatchObject({
      encounters: 2,
      wins: 2,
      losses: 0
    });
  });

  it("does not multiply a resolved match when repeated final samples get different ids", async () => {
    const opponentRepository = new InMemoryOpponentRepository();
    const matchRepository = new InMemoryMatchRepository();
    const useCase = new RegisterDetectedGame({
      opponentRepository,
      matchRepository,
      clock: () => "2026-05-03T01:00:00.000Z"
    });

    await useCase.execute({
      session: {
        ...activeSession(),
        id: "SilverPure:Protoss|RetorieS:Terran:final-a",
        detectedAt: "2026-05-03T00:35:00.000Z",
        startedAt: "2026-05-03T00:30:00.000Z",
        players: [
          { name: "SilverPure", race: "Protoss", result: "Defeat" },
          { name: "RetorieS", race: "Terran", result: "Victory", isUser: true }
        ]
      },
      userName: "RetorieS"
    });
    await useCase.execute({
      session: {
        ...activeSession(),
        id: "SilverPure:Protoss|RetorieS:Terran:final-b",
        detectedAt: "2026-05-03T00:35:04.000Z",
        startedAt: "2026-05-03T00:30:00.000Z",
        players: [
          { name: "SilverPure", race: "Protoss", result: "Defeat" },
          { name: "RetorieS", race: "Terran", result: "Victory", isUser: true }
        ]
      },
      userName: "RetorieS"
    });

    const opponents = await opponentRepository.findAll();
    const matches = await matchRepository.findAll();

    expect(matches).toHaveLength(1);
    expect(opponents).toHaveLength(1);
    expect(opponents[0]).toMatchObject({
      encounters: 1,
      wins: 1,
      losses: 0
    });
  });

  it("keeps the existing opponent when later samples reveal a previously unknown race", async () => {
    const opponentRepository = new InMemoryOpponentRepository();
    const matchRepository = new InMemoryMatchRepository();
    const useCase = new RegisterDetectedGame({
      opponentRepository,
      matchRepository,
      clock: () => "2026-05-03T01:00:00.000Z"
    });

    await useCase.execute({
      session: {
        ...activeSession(),
        players: [
          { name: "SilverPure", race: "Unknown", result: "Undecided" },
          { name: "RetorieS", race: "Terran", result: "Undecided", isUser: true }
        ]
      },
      userName: "RetorieS"
    });
    await useCase.execute({ session: activeSession(), userName: "RetorieS" });

    const opponents = await opponentRepository.findAll();
    const matches = await matchRepository.findAll();

    expect(opponents).toHaveLength(1);
    expect(opponents[0]?.id).toBe("opponent_silverpure");
    expect(opponents[0]?.race).toBe("Protoss");
    expect(matches).toHaveLength(1);
    expect(matches[0]?.opponentRace).toBe("Protoss");
  });

  it("keeps one local profile for the same nickname with different known races", async () => {
    const opponentRepository = new InMemoryOpponentRepository();
    const matchRepository = new InMemoryMatchRepository();
    const useCase = new RegisterDetectedGame({
      opponentRepository,
      matchRepository,
      clock: () => "2026-05-03T01:00:00.000Z"
    });

    await useCase.execute({ session: activeSession(), userName: "RetorieS" });
    await useCase.execute({
      session: {
        ...activeSession(),
        id: "SilverPure:Zerg|RetorieS:Terran:144",
        players: [
          { name: "SilverPure", race: "Zerg", result: "Undecided" },
          { name: "RetorieS", race: "Terran", result: "Undecided", isUser: true }
        ]
      },
      userName: "RetorieS"
    });

    const opponents = await opponentRepository.findAll();

    expect(opponents).toHaveLength(1);
    expect(opponents[0]).toMatchObject({
      id: "opponent_silverpure",
      nickname: "SilverPure",
      encounters: 2
    });
  });

  it("finds an existing opponent by alias when the enriched nickname differs from the SC2 name", async () => {
    const opponentRepository = new InMemoryOpponentRepository();
    const matchRepository = new InMemoryMatchRepository();
    const useCase = new RegisterDetectedGame({
      opponentRepository,
      matchRepository,
      clock: () => "2026-05-03T01:00:00.000Z"
    });

    await opponentRepository.save({
      id: "opponent_renamedprofile",
      nickname: "RenamedProfile",
      race: "Terran",
      aliases: ["SilverPure"],
      encounters: 0,
      wins: 0,
      losses: 0,
      notes: [],
      strategyTags: [],
      createdAt: "2026-05-03T00:00:00.000Z",
      updatedAt: "2026-05-03T00:00:00.000Z"
    });

    await useCase.execute({ session: activeSession(), userName: "RetorieS" });

    const opponents = await opponentRepository.findAll();
    const matches = await matchRepository.findAll();

    expect(opponents).toHaveLength(1);
    expect(matches[0]?.opponentId).toBe("opponent_renamedprofile");
    expect(opponents[0]).toMatchObject({
      nickname: "RenamedProfile",
      encounters: 1
    });
  });

  it("treats two barcode encounters with the same glyphs as separate opponents", async () => {
    const opponentRepository = new InMemoryOpponentRepository();
    const matchRepository = new InMemoryMatchRepository();
    const useCase = new RegisterDetectedGame({
      opponentRepository,
      matchRepository,
      clock: () => "2026-05-03T01:00:00.000Z"
    });

    const firstSession: GameSession = {
      id: "iiiiiii|retories:2026-05-03T00:30:00.000Z",
      isActive: true,
      mode: "ranked-1v1",
      detectedAt: "2026-05-03T00:30:00.000Z",
      startedAt: "2026-05-03T00:30:00.000Z",
      players: [
        { name: "IIIIIII", race: "Terran", result: "Undecided" },
        { name: "RetorieS", race: "Terran", result: "Undecided", isUser: true }
      ]
    };

    const secondSession: GameSession = {
      ...firstSession,
      id: "iiiiiii|retories:2026-05-03T01:30:00.000Z",
      detectedAt: "2026-05-03T01:30:00.000Z",
      startedAt: "2026-05-03T01:30:00.000Z"
    };

    await useCase.execute({ session: firstSession, userName: "RetorieS" });
    await useCase.execute({ session: secondSession, userName: "RetorieS" });

    const opponents = await opponentRepository.findAll();
    expect(opponents).toHaveLength(2);
    const ids = opponents.map((opponent) => opponent.id);
    expect(new Set(ids).size).toBe(2);
    for (const opponent of opponents) {
      expect(opponent).toMatchObject({ nickname: "IIIIIII", encounters: 1 });
    }
  });

  it("keeps a barcode opponent stable across repeated polls of the same active game", async () => {
    const opponentRepository = new InMemoryOpponentRepository();
    const matchRepository = new InMemoryMatchRepository();
    const useCase = new RegisterDetectedGame({
      opponentRepository,
      matchRepository,
      clock: () => "2026-05-03T01:00:00.000Z"
    });

    const session: GameSession = {
      id: "iiiiiii|retories:2026-05-03T00:30:00.000Z",
      isActive: true,
      mode: "ranked-1v1",
      detectedAt: "2026-05-03T00:30:00.000Z",
      startedAt: "2026-05-03T00:30:00.000Z",
      players: [
        { name: "IIIIIII", race: "Terran", result: "Undecided" },
        { name: "RetorieS", race: "Terran", result: "Undecided", isUser: true }
      ]
    };

    await useCase.execute({ session, userName: "RetorieS" });
    await useCase.execute({ session, userName: "RetorieS" });

    const opponents = await opponentRepository.findAll();
    expect(opponents).toHaveLength(1);
    expect(opponents[0]?.encounters).toBe(1);
  });

  it("uses the Battle.net profile link as the stable barcode opponent identity when available", async () => {
    const opponentRepository = new InMemoryOpponentRepository();
    const matchRepository = new InMemoryMatchRepository();
    const useCase = new RegisterDetectedGame({
      opponentRepository,
      matchRepository,
      clock: () => "2026-05-03T01:00:00.000Z"
    });
    const profileLink = "battlenet:://starcraft/profile/2/10220887502839873536";

    await useCase.execute({
      session: {
        id: "barcode-first",
        isActive: true,
        mode: "ranked-1v1",
        detectedAt: "2026-05-03T00:30:00.000Z",
        startedAt: "2026-05-03T00:30:00.000Z",
        players: [
          { name: "IIIIIIIIII", race: "Unknown", result: "Undecided", profileLink },
          { name: "RetorieS", race: "Terran", result: "Undecided", isUser: true }
        ]
      },
      userName: "RetorieS"
    });
    await useCase.execute({
      session: {
        id: "barcode-second",
        isActive: true,
        mode: "ranked-1v1",
        detectedAt: "2026-05-03T01:30:00.000Z",
        startedAt: "2026-05-03T01:30:00.000Z",
        players: [
          { name: "IIIIIIIIII", race: "Zerg", result: "Defeat", mmr: 3872, profileLink },
          { name: "RetorieS", race: "Terran", result: "Victory", isUser: true }
        ]
      },
      userName: "RetorieS"
    });

    const opponents = await opponentRepository.findAll();
    const matches = await matchRepository.findAll();

    expect(opponents).toHaveLength(1);
    expect(matches).toHaveLength(2);
    expect(opponents[0]).toMatchObject({
      nickname: "IIIIIIIIII",
      race: "Zerg",
      encounters: 2,
      wins: 1,
      mmrAtLastMatch: 3872
    });
    expect(opponents[0]?.raceProfiles?.Zerg?.mmrAtLastMatch).toBe(3872);
  });

  it("reuses a barcode live match when the session anchor shifts during the same game", async () => {
    const opponentRepository = new InMemoryOpponentRepository();
    const matchRepository = new InMemoryMatchRepository();
    const useCase = new RegisterDetectedGame({
      opponentRepository,
      matchRepository,
      clock: () => "2026-05-03T01:00:00.000Z"
    });

    await useCase.execute({
      session: {
        id: "iiiiiiiiii|retories:2026-05-03T00:07:00.000Z",
        isActive: true,
        mode: "ranked-1v1",
        detectedAt: "2026-05-03T00:07:00.000Z",
        startedAt: "2026-05-03T00:07:00.000Z",
        players: [
          { name: "IIIIIIIIII", race: "Unknown", result: "Undecided" },
          { name: "RetorieS", race: "Terran", result: "Undecided", isUser: true }
        ]
      },
      userName: "RetorieS"
    });
    await useCase.execute({
      session: {
        id: "iiiiiiiiii|retories:2026-05-03T00:12:00.000Z",
        isActive: true,
        mode: "ranked-1v1",
        detectedAt: "2026-05-03T00:12:00.000Z",
        startedAt: "2026-05-03T00:12:00.000Z",
        players: [
          { name: "IIIIIIIIII", race: "Zerg", result: "Defeat", mmr: 4217 },
          { name: "RetorieS", race: "Terran", result: "Victory", isUser: true }
        ]
      },
      userName: "RetorieS"
    });

    const opponents = await opponentRepository.findAll();
    const matches = await matchRepository.findAll();

    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      playedAt: "2026-05-03T00:07:00.000Z",
      opponentRace: "Zerg",
      result: "win"
    });
    expect(opponents).toHaveLength(1);
    expect(opponents[0]).toMatchObject({
      encounters: 1,
      wins: 1,
      losses: 0,
      mmrAtLastMatch: 4217
    });
    expect(opponents[0]?.raceProfiles?.Zerg?.mmrAtLastMatch).toBe(4217);
  });

  it("matches the configured user name even when SC2 reports a BattleTag-like suffix", async () => {
    const opponentRepository = new InMemoryOpponentRepository();
    const matchRepository = new InMemoryMatchRepository();
    const useCase = new RegisterDetectedGame({
      opponentRepository,
      matchRepository,
      clock: () => "2026-05-03T01:00:00.000Z"
    });

    const result = await useCase.execute({
      session: {
        id: "RetorieS#2321:Terran|Neo:Protoss:139",
        isActive: true,
        mode: "ranked-1v1",
        detectedAt: "2026-05-03T00:30:00.000Z",
        players: [
          { name: "RetorieS#2321", race: "Terran", result: "Victory" },
          { name: "Neo", race: "Protoss", result: "Defeat" }
        ]
      },
      userName: "RetorieS"
    });

    expect(result?.opponent).toMatchObject({
      nickname: "Neo",
      race: "Protoss"
    });
    expect(result?.match).toMatchObject({
      playerRace: "Terran",
      opponentRace: "Protoss",
      result: "win"
    });
  });

  it("does not register a match when the configured user name does not match either player", async () => {
    const opponentRepository = new InMemoryOpponentRepository();
    const matchRepository = new InMemoryMatchRepository();
    const useCase = new RegisterDetectedGame({
      opponentRepository,
      matchRepository,
      clock: () => "2026-05-03T01:00:00.000Z"
    });

    const result = await useCase.execute({
      session: {
        ...activeSession(),
        players: activeSession().players.map((player) => ({
          name: player.name,
          race: player.race,
          result: player.result
        }))
      },
      userName: "WrongAccount"
    });

    expect(result).toBeNull();
    expect(await opponentRepository.findAll()).toHaveLength(0);
    expect(await matchRepository.findAll()).toHaveLength(0);
  });

  it("does not register a match when neither userName nor isUser identifies the local player", async () => {
    const opponentRepository = new InMemoryOpponentRepository();
    const matchRepository = new InMemoryMatchRepository();
    const useCase = new RegisterDetectedGame({
      opponentRepository,
      matchRepository,
      clock: () => "2026-05-03T01:00:00.000Z"
    });

    const result = await useCase.execute({
      session: {
        ...activeSession(),
        players: activeSession().players.map((player) => ({
          name: player.name,
          race: player.race,
          result: player.result
        }))
      }
    });

    expect(result).toBeNull();
    expect(await opponentRepository.findAll()).toHaveLength(0);
    expect(await matchRepository.findAll()).toHaveLength(0);
  });

  it("refuses to register the local player as the opponent even when passed explicitly", async () => {
    const useCase = new RegisterDetectedGame({
      opponentRepository: new InMemoryOpponentRepository(),
      matchRepository: new InMemoryMatchRepository(),
      clock: () => "2026-05-03T01:00:00.000Z"
    });
    const session = activeSession();

    const result = await useCase.execute({
      session,
      opponent: session.players[1],
      userName: "RetorieS"
    });

    expect(result).toBeNull();
  });

  it("ignores unsupported sessions", async () => {
    const useCase = new RegisterDetectedGame({
      opponentRepository: new InMemoryOpponentRepository(),
      matchRepository: new InMemoryMatchRepository()
    });

    const result = await useCase.execute({
      session: {
        ...activeSession(),
        mode: "unsupported"
      },
      userName: "RetorieS"
    });

    expect(result).toBeNull();
  });

  it("registers opponents whose nickname uses non-Latin characters (Cyrillic, CJK, ...)", async () => {
    // Regression test for the slugify bug: the old [^a-z0-9]+ replacement
    // collapsed Cyrillic / CJK / Greek nicknames to an empty slug so
    // createStableEntityId threw and the whole registration was lost.
    const opponentRepository = new InMemoryOpponentRepository();
    const matchRepository = new InMemoryMatchRepository();
    const useCase = new RegisterDetectedGame({
      opponentRepository,
      matchRepository,
      clock: () => "2026-05-03T01:00:00.000Z"
    });

    const result = await useCase.execute({
      session: {
        id: "Игорь:Zerg|RetorieS:Terran:139",
        isActive: true,
        mode: "ranked-1v1",
        detectedAt: "2026-05-03T00:30:00.000Z",
        players: [
          { name: "Игорь", race: "Zerg", result: "Undecided" },
          { name: "RetorieS", race: "Terran", result: "Undecided", isUser: true }
        ]
      },
      userName: "RetorieS"
    });

    expect(result?.opponent.nickname).toBe("Игорь");
    expect(result?.opponent.race).toBe("Zerg");
    expect(result?.opponent.id).toContain("игорь");
    expect(await opponentRepository.findAll()).toHaveLength(1);
    expect(await matchRepository.findAll()).toHaveLength(1);
  });
});

function activeSession(): GameSession {
  return {
    id: "SilverPure:Protoss|RetorieS:Terran:139",
    isActive: true,
    mode: "ranked-1v1",
    detectedAt: "2026-05-03T00:30:00.000Z",
    players: [
      { name: "SilverPure", race: "Protoss", result: "Undecided" },
      { name: "RetorieS", race: "Terran", result: "Undecided", isUser: true }
    ]
  };
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
