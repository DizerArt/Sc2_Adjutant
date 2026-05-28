import { describe, expect, it } from "vitest";
import { Sc2ReplayAnalysisReader } from "../../../../src/infrastructure/replay/sc2-replay-analysis-reader.js";
import type {
  ReplayBuildCommands,
  ReplayEcoTimeline,
  ReplayEngagements,
  ReplaySummary
} from "@replaysremastered/sc2readerjs";

describe("Sc2ReplayAnalysisReader", () => {
  it("uses Blizzard metadata APM values instead of the summary approximation", async () => {
    const reader = new Sc2ReplayAnalysisReader({
      loadReplaySummary: async () => summary(),
      inferReplayPlayerRaces: async () => new Map(),
      loadReplayApm: async () => [170, 239],
      loadBuildCommands: async () => buildCommands(),
      loadEngagements: async () => engagements(),
      loadEcoTimeline: async () => ecoTimeline(),
      loadResourceCollectionTimeline: async () => ({
        players: [],
        timeline: []
      })
    });

    const analysis = await reader.readAnalysis("match.SC2Replay", "Opponent");

    expect(analysis.players).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "RetorieS", apm: 170 }),
        expect.objectContaining({ name: "Opponent", apm: 239 })
      ])
    );
    expect(analysis.averageApm).toBe(239);
  });

  it("uses replay resource collection rates instead of deriving that graph from workers", async () => {
    const reader = new Sc2ReplayAnalysisReader({
      loadReplaySummary: async () => summary(),
      inferReplayPlayerRaces: async () => new Map(),
      loadBuildCommands: async () => buildCommands(),
      loadEngagements: async () => engagements(),
      loadEcoTimeline: async () => ecoTimeline(),
      loadResourceCollectionTimeline: async () => ({
        players: [
          { userId: 0, name: "RetorieS", race: "Terran" },
          { userId: 1, name: "Opponent", race: "Zerg" }
        ],
        timeline: [
          [
            { gameloop: 16, seconds: 1, value: 530 },
            { gameloop: 32, seconds: 2, value: 610 }
          ],
          [
            { gameloop: 16, seconds: 1, value: 490 },
            { gameloop: 32, seconds: 2, value: 720 }
          ]
        ]
      })
    });

    const analysis = await reader.readAnalysis("match.SC2Replay", "Opponent");
    const resourceGraph = analysis.graphs.find((graph) => graph.id === "resourceCollectionRate");
    const workersGraph = analysis.graphs.find((graph) => graph.id === "workersActive");

    expect(resourceGraph?.series[0]?.samples).toEqual([
      { seconds: 1, value: 530 },
      { seconds: 2, value: 610 }
    ]);
    expect(workersGraph?.series[0]?.samples).toEqual([
      { seconds: 1, value: 12 },
      { seconds: 2, value: 14 }
    ]);
  });

  it("fills unknown summary races from replay tracker unit inference", async () => {
    const reader = new Sc2ReplayAnalysisReader({
      loadReplaySummary: async () =>
        summary({
          players: [
            { name: "RetorieS", race: "Unknown", result: "loss", teamId: 1, toon: null, apm: 96 },
            { name: "Kaiman", race: null, result: "win", teamId: 2, toon: null, apm: 149 }
          ]
        }),
      inferReplayPlayerRaces: async () =>
        new Map([
          [0, "Terran"],
          [1, "Protoss"]
        ]),
      loadReplayApm: async () => [216, 313],
      loadBuildCommands: async () => buildCommands(),
      loadEngagements: async () => engagements(),
      loadEcoTimeline: async () => ecoTimeline(),
      loadResourceCollectionTimeline: async () => ({
        players: [],
        timeline: []
      })
    });

    const analysis = await reader.readAnalysis("match.SC2Replay", "Kaiman");

    expect(analysis.players).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "RetorieS", race: "Terran", apm: 216 }),
        expect.objectContaining({ name: "Kaiman", race: "Protoss", apm: 313 })
      ])
    );
  });
});

function summary(overrides: Partial<ReplaySummary> = {}): ReplaySummary {
  return {
    replayId: "replay_001",
    patchVersion: "5.0.14.80949",
    build: 80949,
    durationSeconds: 120,
    useScaledTime: true,
    playedAt: "2026-05-09T10:00:00.000Z",
    playedAtMs: 1778320800000,
    gameType: "1v1",
    mapTitle: "Taito Citadel LE",
    replayType: "multiplayer",
    players: [
      { name: "RetorieS", race: "Terran", result: "loss", teamId: 1, toon: null, apm: 96 },
      { name: "Opponent", race: "Zerg", result: "win", teamId: 2, toon: null, apm: 149 }
    ],
    ...overrides
  };
}

function buildCommands(): ReplayBuildCommands {
  return {
    replayId: "replay_001",
    patchVersion: "5.0.14.80949",
    baseBuild: 80949,
    build: 80949,
    useScaledTime: true,
    players: []
  };
}

function engagements(): ReplayEngagements {
  return {
    replayId: "replay_001",
    patchVersion: "5.0.14.80949",
    baseBuild: 80949,
    build: 80949,
    useScaledTime: true,
    players: [],
    engagements: [],
    armyValueTimeline: []
  };
}

function ecoTimeline(): ReplayEcoTimeline {
  return {
    replayId: "replay_001",
    patchVersion: "5.0.14.80949",
    baseBuild: 80949,
    build: 80949,
    useScaledTime: true,
    players: [
      { userId: 0, name: "RetorieS", race: "Terran" },
      { userId: 1, name: "Opponent", race: "Zerg" }
    ],
    timeline: [
      [
        { gameloop: 16, seconds: 1, workers: 12, supplyUsed: 16, supplyCap: 23, bases: 1, expansions: 1 },
        { gameloop: 32, seconds: 2, workers: 14, supplyUsed: 18, supplyCap: 23, bases: 1, expansions: 1 }
      ],
      [
        { gameloop: 16, seconds: 1, workers: 11, supplyUsed: 15, supplyCap: 22, bases: 1, expansions: 1 },
        { gameloop: 32, seconds: 2, workers: 15, supplyUsed: 19, supplyCap: 22, bases: 1, expansions: 1 }
      ]
    ]
  };
}
