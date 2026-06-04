import { describe, expect, it, vi } from "vitest";
import { HandleDetectedGame } from "../../../src/application/use-cases/handle-detected-game.js";
import type { GameSession } from "../../../src/domain/entities/game-session.js";
import type { Match } from "../../../src/domain/entities/match.js";
import type { Opponent } from "../../../src/domain/entities/opponent.js";
import type { Sc2ClientPort } from "../../../src/domain/ports/sc2-client-port.js";
import type { MatchRepository } from "../../../src/domain/repositories/match-repository.js";
import type { OpponentRepository } from "../../../src/domain/repositories/opponent-repository.js";
import type { EntityId } from "../../../src/domain/value-objects/entity-id.js";
import { MonitoringController } from "../../../src/main/electron/monitoring-controller.js";

describe("MonitoringController", () => {
  it("starts and stops monitoring", () => {
    const controller = createController(activeSession());

    expect(controller.start().running).toBe(true);
    expect(controller.getStatus().running).toBe(true);
    expect(controller.stop().running).toBe(false);
  });

  it("stores detected game status after first poll", async () => {
    const controller = createController(activeSession());

    controller.start();
    await waitForMicrotasks();

    expect(controller.getStatus()).toMatchObject({
      running: true,
      currentSession: {
        active: true,
        mode: "ranked-1v1",
        players: [
          { name: "RetorieS", race: "Terran", isUser: true },
          { name: "RobbyG", race: "Terran" }
        ]
      },
      lastDetectedOpponent: "RobbyG",
      lastSavedMatchId: "match_retories-robbyg-2026-05-03t05-00-00-000z"
    });

    controller.stop();
  });

  it("stores polling errors", async () => {
    const controller = createControllerWithClient({
      async getCurrentGame() {
        throw new Error("SC2 offline");
      }
    });

    controller.start();
    await waitForMicrotasks();

    expect(controller.getStatus()).toMatchObject({
      running: true,
      lastError: "SC2 offline"
    });

    controller.stop();
  });

  it("does not save ambiguous live sessions until the player name is configured", async () => {
    const controller = createControllerWithUserName(activeSessionWithoutUserMarker(), undefined);

    controller.start();
    await waitForMicrotasks();

    expect(controller.getStatus()).toMatchObject({
      running: true,
      lastError: "Set SC2 name in Settings so the opponent can be identified."
    });
    expect(controller.getStatus().lastDetectedOpponent).toBeUndefined();
    expect(controller.getStatus().lastSavedMatchId).toBeUndefined();

    controller.stop();
  });

  it("does not register the same active session on every poll", async () => {
    const handleDetectedGame = {
      execute: vi.fn(async () => ({
        enrichedOpponent: { nickname: "RobbyG" },
        match: { id: "match_retories-robbyg-2026-05-03t05-00-00-000z" }
      }))
    };
    const controller = new MonitoringController({
      sc2Client: {
        async getCurrentGame() {
          return activeSession();
        }
      },
      userName: "RetorieS",
      intervalMs: 1,
      handleDetectedGame: handleDetectedGame as unknown as HandleDetectedGame
    });

    controller.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.stop();

    expect(handleDetectedGame.execute).toHaveBeenCalledTimes(1);
  });

});

function createController(session: GameSession): MonitoringController {
  return createControllerWithClient({
    async getCurrentGame() {
      return session;
    }
  });
}

function createControllerWithClient(sc2Client: Sc2ClientPort): MonitoringController {
  return createControllerWithUserName(sc2Client, "RetorieS");
}

function createControllerWithUserName(
  sc2ClientOrSession: Sc2ClientPort | GameSession,
  userName: string | undefined
): MonitoringController {
  const opponentRepository = new InMemoryOpponentRepository();
  const sc2Client = isSc2Client(sc2ClientOrSession)
    ? sc2ClientOrSession
    : {
      async getCurrentGame() {
        return sc2ClientOrSession;
      }
    };

  return new MonitoringController({
    sc2Client,
    userName,
    intervalMs: 60_000,
    handleDetectedGame: new HandleDetectedGame({
      opponentRepository,
      matchRepository: new InMemoryMatchRepository(),
      clock: () => "2026-05-03T05:00:00.000Z"
    })
  });
}

function activeSession(): GameSession {
  return {
    id: "RetorieS:Terran|RobbyG:Terran:0",
    isActive: true,
    mode: "ranked-1v1",
    detectedAt: "2026-05-03T05:00:00.000Z",
    players: [
      { name: "RetorieS", race: "Terran", result: "Undecided", isUser: true },
      { name: "RobbyG", race: "Terran", result: "Undecided" }
    ]
  };
}

function activeSessionWithoutUserMarker(): GameSession {
  return {
    ...activeSession(),
    players: activeSession().players.map((player) => ({
      name: player.name,
      race: player.race,
      result: player.result
    }))
  };
}

function isSc2Client(value: Sc2ClientPort | GameSession): value is Sc2ClientPort {
  return "getCurrentGame" in value;
}

async function waitForMicrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
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
