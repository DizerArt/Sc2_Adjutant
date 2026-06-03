import { describe, expect, it } from "vitest";
import type { MatchHistoryItem } from "../../../src/application/use-cases/list-match-history.js";
import { createMatch } from "../../../src/domain/entities/match.js";
import type { Opponent } from "../../../src/domain/entities/opponent.js";
import type { Race } from "../../../src/domain/value-objects/race.js";
import type { MonitoringStatus } from "../../../src/shared/ipc/contracts.js";
import {
  findCurrentMatchOpponent,
  mmrForRace,
  opponentRaceStats,
  resolveOverlayRace
} from "../../../src/renderer/components/OverlayShell.js";

describe("OverlayShell data selection", () => {
  it("prefers the active session opponent over a stale saved match", () => {
    const oldOpponent = opponent({
      id: "opponent_old",
      nickname: "OldEnemy",
      race: "Protoss",
      mmrAtLastMatch: 4200
    });
    const liveOpponent = opponent({
      id: "opponent_live",
      nickname: "LiveEnemy",
      race: "Zerg",
      mmrAtLastMatch: 4100
    });

    const monitoring = activeMonitoring({
      lastSavedMatchId: "match_old",
      opponentName: "LiveEnemy",
      opponentRace: "Zerg"
    });

    expect(
      findCurrentMatchOpponent(
        [oldOpponent, liveOpponent],
        [matchItem("match_old", oldOpponent, "Protoss")],
        monitoring,
        "Retories"
      )
    ).toBe(liveOpponent);
  });

  it("uses the active session race for overlay MMR and race stats", () => {
    const enemy = opponent({
      id: "opponent_multi_race",
      nickname: "Asyl",
      race: "Protoss",
      mmrAtLastMatch: 4200,
      raceProfiles: {
        Terran: { mmrAtLastMatch: 4075, updatedAt: "2026-05-01T00:00:00.000Z" },
        Protoss: { mmrAtLastMatch: 4415, updatedAt: "2026-05-01T00:00:00.000Z" }
      }
    });
    const monitoring = activeMonitoring({
      opponentName: "Asyl",
      opponentRace: "Terran"
    });
    const matches = [
      matchItem("match_terran", enemy, "Terran", "win"),
      matchItem("match_protoss", enemy, "Protoss", "loss")
    ];

    const race = resolveOverlayRace(enemy, matches, monitoring, "Retories");

    expect(race).toBe("Terran");
    expect(mmrForRace(enemy, race)).toBe("4075");
    expect(opponentRaceStats(enemy, matches, race)).toEqual({
      encounters: 1,
      wins: 1,
      losses: 0
    });
  });

  it("falls back from Unknown to Random like the main opponent card", () => {
    const enemy = opponent({
      id: "opponent_random",
      nickname: "RandomEnemy",
      race: "Unknown",
      mmrAtLastMatch: 4300,
      raceProfiles: {
        Random: { mmrAtLastMatch: 4450, updatedAt: "2026-05-01T00:00:00.000Z" }
      }
    });
    const matches = [matchItem("match_random", enemy, "Random", "loss")];

    const race = resolveOverlayRace(enemy, matches, null, "Retories");

    expect(race).toBe("Random");
    expect(mmrForRace(enemy, race)).toBe("4450");
    expect(opponentRaceStats(enemy, matches, race)).toEqual({
      encounters: 1,
      wins: 0,
      losses: 1
    });
  });

  it("does not use aggregate opponent stats when the selected race has no matches", () => {
    const enemy = opponent({
      id: "opponent_no_random_games",
      nickname: "NoRandomGames",
      race: "Random",
      encounters: 4,
      wins: 3,
      losses: 1
    });

    expect(opponentRaceStats(enemy, [], "Random")).toEqual({
      encounters: 0,
      wins: 0,
      losses: 0
    });
  });
});

function activeMonitoring(options: {
  readonly lastSavedMatchId?: string;
  readonly opponentName: string;
  readonly opponentRace: Race;
}): MonitoringStatus {
  return {
    running: true,
    lastSavedMatchId: options.lastSavedMatchId,
    currentSession: {
      active: true,
      mode: "ranked-1v1",
      detectedAt: "2026-05-01T00:00:00.000Z",
      players: [
        {
          name: "Retories",
          race: "Terran",
          isUser: true,
          result: "Undecided"
        },
        {
          name: options.opponentName,
          race: options.opponentRace,
          mmr: 4000,
          result: "Undecided"
        }
      ]
    }
  };
}

function matchItem(
  id: string,
  opponentRecord: Opponent,
  opponentRace: Race,
  result: "win" | "loss" | "unknown" = "unknown"
): MatchHistoryItem {
  return {
    match: createMatch({
      id,
      opponentId: opponentRecord.id,
      playedAt: "2026-05-01T00:00:00.000Z",
      playerRace: "Terran",
      opponentRace,
      result
    }),
    opponent: opponentRecord
  };
}

function opponent(overrides: Partial<Opponent>): Opponent {
  return {
    id: "opponent_base",
    nickname: "Base",
    race: "Unknown",
    aliases: [],
    encounters: 0,
    wins: 0,
    losses: 0,
    notes: [],
    strategyTags: [],
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z",
    ...overrides
  };
}
