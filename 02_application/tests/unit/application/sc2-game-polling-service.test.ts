import { describe, expect, it } from "vitest";
import { Sc2GamePollingService } from "../../../src/application/services/sc2-game-polling-service.js";
import type { GameSession } from "../../../src/domain/entities/game-session.js";
import type { Sc2ClientPort } from "../../../src/domain/ports/sc2-client-port.js";

describe("Sc2GamePollingService", () => {
  it("emits newGameDetected only once for the same active session", async () => {
    const session: GameSession = {
      id: "raw:DizerArt:Terran|HiveMindX:Zerg:4",
      isActive: true,
      mode: "ranked-1v1",
      detectedAt: "2026-05-03T00:00:00.000Z",
      players: [
        { name: "DizerArt", race: "Terran", isUser: true },
        { name: "HiveMindX", race: "Zerg" }
      ]
    };

    const client: Sc2ClientPort = {
      async getCurrentGame() {
        return session;
      }
    };

    const service = new Sc2GamePollingService(client, {
      intervalMs: 1000,
      userName: "DizerArt"
    });

    const detected: string[] = [];
    service.on("newGameDetected", ({ opponent }) => {
      detected.push(`${opponent.name}/${opponent.race}`);
    });

    await service.pollOnce();
    await service.pollOnce();

    expect(detected).toEqual(["HiveMindX/Zerg"]);
  });

  it("stabilizes session.id across polls of the same active game even when the raw id changes", async () => {
    let pollIndex = 0;
    const client: Sc2ClientPort = {
      async getCurrentGame() {
        const detectedAt = nextDetectedAt(pollIndex);
        pollIndex += 1;
        return {
          id: `raw:DizerArt:Terran|HiveMindX:Zerg:${pollIndex}`,
          isActive: true,
          mode: "ranked-1v1",
          detectedAt,
          players: [
            { name: "DizerArt", race: "Terran", isUser: true },
            { name: "HiveMindX", race: "Zerg" }
          ]
        };
      }
    };

    const service = new Sc2GamePollingService(client, {
      intervalMs: 1000,
      userName: "DizerArt"
    });

    const detectedIds: string[] = [];
    const sessionIds: string[] = [];

    service.on("newGameDetected", ({ session }) => {
      detectedIds.push(session.id);
    });
    service.on("session", (session) => {
      sessionIds.push(session.id);
    });

    await service.pollOnce();
    await service.pollOnce();
    await service.pollOnce();

    expect(detectedIds).toHaveLength(1);
    expect(new Set(sessionIds).size).toBe(1);
    expect(sessionIds[0]).toBe("dizerart|hivemindx:2026-05-03T00:00:00.000Z");
  });

  it("emits a fresh stable id after the active game ends and a new one starts with the same players", async () => {
    const sessions: GameSession[] = [
      activeRankedSession("raw-1", true, "2026-05-03T00:00:00.000Z"),
      activeRankedSession("raw-idle", false, "2026-05-03T00:00:30.000Z"),
      activeRankedSession("raw-2", true, "2026-05-03T00:01:00.000Z")
    ];
    let index = 0;
    const client: Sc2ClientPort = {
      async getCurrentGame() {
        return sessions[index++] ?? sessions[sessions.length - 1]!;
      }
    };

    const service = new Sc2GamePollingService(client, {
      intervalMs: 1000,
      userName: "DizerArt"
    });

    const detected: string[] = [];
    service.on("newGameDetected", ({ session }) => {
      detected.push(session.id);
    });

    await service.pollOnce();
    await service.pollOnce();
    await service.pollOnce();

    expect(detected).toEqual([
      "dizerart|hivemindx:2026-05-03T00:00:00.000Z",
      "dizerart|hivemindx:2026-05-03T00:01:00.000Z"
    ]);
  });

  it("emits the same active game again when the final result appears", async () => {
    const sessions: GameSession[] = [
      activeRankedSession("raw-1", true, "2026-05-03T00:00:00.000Z"),
      {
        ...activeRankedSession("raw-1-final", true, "2026-05-03T00:10:00.000Z"),
        players: [
          { name: "DizerArt", race: "Terran", result: "Defeat", isUser: true },
          { name: "HiveMindX", race: "Zerg", result: "Victory" }
        ]
      }
    ];
    let index = 0;
    const client: Sc2ClientPort = {
      async getCurrentGame() {
        return sessions[index++] ?? sessions[sessions.length - 1]!;
      }
    };

    const service = new Sc2GamePollingService(client, {
      intervalMs: 1000,
      userName: "DizerArt"
    });

    const detectedResults: string[] = [];
    service.on("newGameDetected", ({ session }) => {
      const user = session.players.find((player) => player.isUser);
      detectedResults.push(user?.result ?? "Unknown");
    });

    await service.pollOnce();
    await service.pollOnce();
    await service.pollOnce();

    expect(detectedResults).toEqual(["Unknown", "Defeat"]);
  });

  it("emits a new stable id for a quick rematch against the same player without an idle sample", async () => {
    const sessions: GameSession[] = [
      activeRankedSession("raw-1", true, "2026-05-03T00:00:10.000Z", "2026-05-03T00:00:00.000Z"),
      {
        ...activeRankedSession("raw-1-final", true, "2026-05-03T00:02:30.000Z", "2026-05-03T00:00:00.000Z"),
        players: [
          { name: "DizerArt", race: "Terran", result: "Victory", isUser: true },
          { name: "HiveMindX", race: "Zerg", result: "Defeat" }
        ]
      },
      activeRankedSession("raw-2", true, "2026-05-03T00:03:05.000Z", "2026-05-03T00:03:00.000Z")
    ];
    let index = 0;
    const client: Sc2ClientPort = {
      async getCurrentGame() {
        return sessions[index++] ?? sessions[sessions.length - 1]!;
      }
    };

    const service = new Sc2GamePollingService(client, {
      intervalMs: 1000,
      userName: "DizerArt"
    });

    const detectedIds: string[] = [];
    service.on("newGameDetected", ({ session }) => {
      detectedIds.push(session.id);
    });

    await service.pollOnce();
    await service.pollOnce();
    await service.pollOnce();

    expect(detectedIds).toEqual([
      "dizerart|hivemindx:2026-05-03T00:00:00.000Z",
      "dizerart|hivemindx:2026-05-03T00:00:00.000Z",
      "dizerart|hivemindx:2026-05-03T00:03:00.000Z"
    ]);
  });

  it("does not emit duplicate final samples when the post-game startedAt jitters", async () => {
    const sessions: GameSession[] = [
      activeRankedSession("raw-1", true, "2026-05-03T00:00:10.000Z", "2026-05-03T00:00:00.000Z"),
      {
        ...activeRankedSession("raw-final-a", true, "2026-05-03T00:02:30.000Z", "2026-05-03T00:00:00.000Z"),
        players: [
          { name: "DizerArt", race: "Terran", result: "Victory", isUser: true },
          { name: "HiveMindX", race: "Zerg", result: "Defeat" }
        ]
      },
      {
        ...activeRankedSession("raw-final-b", true, "2026-05-03T00:02:34.000Z", "2026-05-03T00:00:12.000Z"),
        players: [
          { name: "DizerArt", race: "Terran", result: "Victory", isUser: true },
          { name: "HiveMindX", race: "Zerg", result: "Defeat" }
        ]
      }
    ];
    let index = 0;
    const client: Sc2ClientPort = {
      async getCurrentGame() {
        return sessions[index++] ?? sessions[sessions.length - 1]!;
      }
    };

    const service = new Sc2GamePollingService(client, {
      intervalMs: 1000,
      userName: "DizerArt"
    });

    const detectedIds: string[] = [];
    service.on("newGameDetected", ({ session }) => {
      detectedIds.push(session.id);
    });

    await service.pollOnce();
    await service.pollOnce();
    await service.pollOnce();

    expect(detectedIds).toEqual([
      "dizerart|hivemindx:2026-05-03T00:00:00.000Z",
      "dizerart|hivemindx:2026-05-03T00:00:00.000Z"
    ]);
  });

  it("does not treat a stale post-game sample without a fresh start as a rematch", async () => {
    const sessions: GameSession[] = [
      activeRankedSession("raw-1", true, "2026-05-03T00:00:10.000Z", "2026-05-03T00:00:00.000Z"),
      {
        ...activeRankedSession("raw-final", true, "2026-05-03T00:02:30.000Z", "2026-05-03T00:00:00.000Z"),
        players: [
          { name: "DizerArt", race: "Terran", result: "Defeat", isUser: true },
          { name: "HiveMindX", race: "Zerg", result: "Victory" }
        ]
      },
      activeRankedSession("raw-stale", true, "2026-05-03T00:09:30.000Z")
    ];
    let index = 0;
    const client: Sc2ClientPort = {
      async getCurrentGame() {
        return sessions[index++] ?? sessions[sessions.length - 1]!;
      }
    };

    const service = new Sc2GamePollingService(client, {
      intervalMs: 1000,
      userName: "DizerArt"
    });

    const detectedIds: string[] = [];
    service.on("newGameDetected", ({ session }) => {
      detectedIds.push(session.id);
    });

    await service.pollOnce();
    await service.pollOnce();
    await service.pollOnce();

    expect(detectedIds).toEqual([
      "dizerart|hivemindx:2026-05-03T00:00:00.000Z",
      "dizerart|hivemindx:2026-05-03T00:00:00.000Z"
    ]);
  });
});

function nextDetectedAt(pollIndex: number): string {
  const baseMs = Date.parse("2026-05-03T00:00:00.000Z");
  return new Date(baseMs + pollIndex * 1000).toISOString();
}

function activeRankedSession(
  id: string,
  isActive: boolean,
  detectedAt: string,
  startedAt?: string
): GameSession {
  return {
    id,
    isActive,
    mode: isActive ? "ranked-1v1" : "unknown",
    detectedAt,
    startedAt,
    players: isActive
      ? [
          { name: "DizerArt", race: "Terran", isUser: true },
          { name: "HiveMindX", race: "Zerg" }
        ]
      : []
  };
}
