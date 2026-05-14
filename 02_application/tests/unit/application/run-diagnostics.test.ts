import { describe, expect, it } from "vitest";
import { RunDiagnostics } from "../../../src/application/use-cases/run-diagnostics.js";
import type { GameSession } from "../../../src/domain/entities/game-session.js";
import type { Match } from "../../../src/domain/entities/match.js";
import type { Opponent } from "../../../src/domain/entities/opponent.js";
import type { Sc2ClientPort } from "../../../src/domain/ports/sc2-client-port.js";
import type { StorageHealthPort } from "../../../src/domain/ports/storage-health-port.js";
import type { MatchRepository } from "../../../src/domain/repositories/match-repository.js";
import type { OpponentRepository } from "../../../src/domain/repositories/opponent-repository.js";
import type { EntityId } from "../../../src/domain/value-objects/entity-id.js";

describe("RunDiagnostics", () => {
  it("returns ok when SC2 API and storage are healthy", async () => {
    const diagnostics = new RunDiagnostics({
      sc2Client: new FakeSc2Client(activeSession()),
      storageHealth: new FakeStorageHealth(true),
      externalSourceNames: ["Fixture Source"],
      clock: () => "2026-05-03T02:00:00.000Z"
    });

    const report = await diagnostics.execute();

    expect(report.overallStatus).toBe("ok");
    expect(report.items.map((item) => item.status)).toEqual(["ok", "ok", "ok"]);
  });

  it("returns warning when SC2 API is reachable without active game", async () => {
    const diagnostics = new RunDiagnostics({
      sc2Client: new FakeSc2Client({
        ...activeSession(),
        isActive: false,
        mode: "unknown",
        players: []
      }),
      storageHealth: new FakeStorageHealth(true)
    });

    const report = await diagnostics.execute();

    expect(report.overallStatus).toBe("warning");
    expect(report.items[0]).toMatchObject({
      name: "SC2 Client API",
      status: "warning"
    });
  });

  it("returns error when SC2 API is unavailable", async () => {
    const diagnostics = new RunDiagnostics({
      sc2Client: {
        async getCurrentGame() {
          throw new Error("offline");
        }
      },
      storageHealth: new FakeStorageHealth(true)
    });

    const report = await diagnostics.execute();

    expect(report.overallStatus).toBe("error");
    expect(report.items[0]).toMatchObject({
      name: "SC2 Client API",
      status: "error",
      message: "offline"
    });
  });

  it("returns warning when external source adapters are not configured", async () => {
    const diagnostics = new RunDiagnostics({
      sc2Client: new FakeSc2Client(activeSession()),
      storageHealth: new FakeStorageHealth(true)
    });

    const report = await diagnostics.execute();

    expect(report.overallStatus).toBe("warning");
    expect(report.items[2]).toMatchObject({
      name: "External Sources",
      status: "warning",
      message: "No external opponent source adapters are configured; local fallback profiles are used."
    });
  });

  it("flags inflated wins/losses as a stats-health warning", async () => {
    const diagnostics = new RunDiagnostics({
      sc2Client: new FakeSc2Client(activeSession()),
      storageHealth: new FakeStorageHealth(true),
      opponentRepository: new InMemoryOpponentRepository([
        buildOpponent({ id: "o-1", encounters: 1, wins: 14, losses: 0 })
      ]),
      matchRepository: new InMemoryMatchRepository([
        buildMatch({ id: "m-1", opponentId: "o-1", result: "win" })
      ]),
      externalSourceNames: ["Fixture"]
    });

    const report = await diagnostics.execute();
    const statsHealth = report.items.find((item) => item.name === "Stats Health");

    expect(report.overallStatus).toBe("warning");
    expect(statsHealth).toMatchObject({
      status: "warning"
    });
    expect(statsHealth?.message).toContain("inflated wins/losses");
  });

  it("flags orphan match records pointing at unknown opponents", async () => {
    const diagnostics = new RunDiagnostics({
      sc2Client: new FakeSc2Client(activeSession()),
      storageHealth: new FakeStorageHealth(true),
      opponentRepository: new InMemoryOpponentRepository([]),
      matchRepository: new InMemoryMatchRepository([
        buildMatch({ id: "m-1", opponentId: "missing-opponent", result: "win" })
      ]),
      externalSourceNames: ["Fixture"]
    });

    const report = await diagnostics.execute();
    const statsHealth = report.items.find((item) => item.name === "Stats Health");

    expect(statsHealth?.status).toBe("warning");
    expect(statsHealth?.message).toContain("orphan match");
  });

  it("reports stats health ok when opponents and matches are consistent", async () => {
    const diagnostics = new RunDiagnostics({
      sc2Client: new FakeSc2Client(activeSession()),
      storageHealth: new FakeStorageHealth(true),
      opponentRepository: new InMemoryOpponentRepository([
        buildOpponent({ id: "o-1", encounters: 2, wins: 1, losses: 1 })
      ]),
      matchRepository: new InMemoryMatchRepository([
        buildMatch({ id: "m-1", opponentId: "o-1", result: "win" }),
        buildMatch({ id: "m-2", opponentId: "o-1", result: "loss" })
      ]),
      externalSourceNames: ["Fixture"]
    });

    const report = await diagnostics.execute();
    const statsHealth = report.items.find((item) => item.name === "Stats Health");

    expect(statsHealth?.status).toBe("ok");
    expect(report.overallStatus).toBe("ok");
  });

  it("returns warning when an external source is cooling down", async () => {
    const diagnostics = new RunDiagnostics({
      sc2Client: new FakeSc2Client(activeSession()),
      storageHealth: new FakeStorageHealth(true),
      externalSourceNames: ["SC2Pulse"],
      externalSourceDiagnostics: [
        {
          name: "SC2Pulse",
          state: "cooling-down",
          cacheEntries: 1,
          consecutiveFailures: 3,
          cooldownUntil: "2026-05-03T03:00:00.000Z",
          lastFailureMessage: "HTTP 429"
        }
      ]
    });

    const report = await diagnostics.execute();

    expect(report.overallStatus).toBe("warning");
    expect(report.items[2]).toMatchObject({
      name: "External Sources",
      status: "warning",
      message: "1 external opponent source adapter(s) configured; 1 degraded.",
      details: {
        sourceDiagnostics: [
          {
            name: "SC2Pulse",
            state: "cooling-down"
          }
        ]
      }
    });
  });
});

function activeSession(): GameSession {
  return {
    id: "RetorieS:Terran|Cheoklate:Protoss:1",
    isActive: true,
    mode: "ranked-1v1",
    detectedAt: "2026-05-03T02:00:00.000Z",
    players: [
      { name: "RetorieS", race: "Terran" },
      { name: "Cheoklate", race: "Protoss" }
    ]
  };
}

class FakeSc2Client implements Sc2ClientPort {
  constructor(private readonly session: GameSession) {}

  async getCurrentGame(): Promise<GameSession> {
    return this.session;
  }
}

class FakeStorageHealth implements StorageHealthPort {
  constructor(private readonly writable: boolean) {}

  async verifyWritable() {
    return {
      directory: "D:\\SC2AssistantData",
      writable: this.writable
    };
  }
}

function buildOpponent(overrides: Partial<Opponent> & { readonly id: string }): Opponent {
  return {
    nickname: "Stub",
    race: "Terran",
    aliases: [],
    encounters: 0,
    wins: 0,
    losses: 0,
    notes: [],
    strategyTags: [],
    createdAt: "2026-05-03T00:00:00.000Z",
    updatedAt: "2026-05-03T00:00:00.000Z",
    ...overrides
  };
}

function buildMatch(overrides: Partial<Match> & { readonly id: string; readonly opponentId: string }): Match {
  return {
    playedAt: "2026-05-03T00:00:00.000Z",
    playerRace: "Terran",
    opponentRace: "Protoss",
    result: "unknown",
    favorite: false,
    notes: [],
    createdAt: "2026-05-03T00:00:00.000Z",
    updatedAt: "2026-05-03T00:00:00.000Z",
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
  async save(): Promise<void> {}
  async clear(): Promise<void> {}
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
  async save(): Promise<void> {}
  async clear(): Promise<void> {}
}
