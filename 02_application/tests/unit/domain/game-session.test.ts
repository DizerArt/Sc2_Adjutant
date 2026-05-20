import { describe, expect, it } from "vitest";
import activeRankedPayload from "../../fixtures/sc2-client/active-ranked-1v1.json" with { type: "json" };
import liveClientPayload from "../../fixtures/sc2-client/live-client-sample.json" with { type: "json" };
import replayPayload from "../../fixtures/sc2-client/replay-session.json" with { type: "json" };
import { findOpponent, toGameSession } from "../../../src/domain/entities/game-session.js";

describe("game session mapping", () => {
  it("maps a two-player active session as ranked 1v1", () => {
    const session = toGameSession(activeRankedPayload, "2026-05-03T00:00:00.000Z");

    expect(session.isActive).toBe(true);
    expect(session.mode).toBe("ranked-1v1");
    expect(session.players).toHaveLength(2);
    expect(session.players[1]).toMatchObject({
      name: "HiveMindX",
      race: "Zerg"
    });
  });

  it("finds the opponent by configured user name", () => {
    const session = toGameSession(activeRankedPayload);
    const opponent = findOpponent(session, "DizerArt");

    expect(opponent?.name).toBe("HiveMindX");
  });

  it("finds the opponent when SC2 appends the local player's clan tag", () => {
    const session = toGameSession({
      players: [
        { name: "RetorieS <RTS>", race: "Terran", result: "Victory" },
        { name: "Secret", race: "Random", result: "Defeat" }
      ]
    });

    const opponent = findOpponent(session, "RetorieS");

    expect(opponent?.name).toBe("Secret");
  });

  it("does not guess an opponent when the local player cannot be identified", () => {
    const session = toGameSession({
      players: [
        { name: "RetorieS", race: "Terran" },
        { name: "Neo", race: "Protoss" }
      ]
    });

    const opponent = findOpponent(session);
    expect(opponent).toBeNull();
  });

  it("marks replay sessions as unsupported", () => {
    const session = toGameSession(replayPayload);

    expect(session.mode).toBe("unsupported");
    expect(findOpponent(session, "PlayerOne")).toBeNull();
  });

  it("normalizes race abbreviations returned by the live SC2 Client API", () => {
    const session = toGameSession(liveClientPayload);

    expect(session.players.map((player) => player.race)).toEqual(["Protoss", "Terran"]);
  });

  it("maps player MMR when the live SC2 Client API provides it", () => {
    const session = toGameSession({
      players: [
        { name: "RetorieS", race: "Terr", mmr: "4304", isUser: true },
        { name: "IIIIIIIIII", race: "Zerg", rating: 4217 }
      ]
    });

    expect(session.players).toMatchObject([
      { name: "RetorieS", mmr: 4304 },
      { name: "IIIIIIIIII", mmr: 4217 }
    ]);
  });

  it("keeps the same id for multiple samples of the same live game", () => {
    const first = toGameSession(
      {
        ...activeRankedPayload,
        displayTime: 4
      },
      "2026-05-03T00:00:04.125Z"
    );
    const second = toGameSession(
      {
        ...activeRankedPayload,
        displayTime: 7
      },
      "2026-05-03T00:00:07.875Z"
    );

    expect(first.startedAt).toBe("2026-05-03T00:00:00.000Z");
    expect(second.startedAt).toBe("2026-05-03T00:00:00.000Z");
    expect(second.id).toBe(first.id);
  });
});
