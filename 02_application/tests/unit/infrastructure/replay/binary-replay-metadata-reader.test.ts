import { describe, expect, it, vi } from "vitest";
import type { ReplaySummary } from "@replaysremastered/sc2readerjs";
import { BinaryReplayMetadataReader } from "../../../../src/infrastructure/replay/binary-replay-metadata-reader.js";
import type { ReplayMetadata } from "../../../../src/domain/entities/match.js";
import type { ReplayFile, ReplayMetadataReaderPort } from "../../../../src/domain/ports/replay-metadata-reader-port.js";

const baseFile: ReplayFile = {
  path: "C:\\replays\\Match.SC2Replay",
  modifiedAt: "2026-05-03T18:00:00.000Z"
};

function buildSummary(overrides: Partial<ReplaySummary> = {}): ReplaySummary {
  return {
    replayId: "fake",
    patchVersion: "5.0.13",
    build: 95299,
    durationSeconds: 600,
    useScaledTime: true,
    playedAt: "2026-05-03T17:55:00.000Z",
    playedAtMs: Date.parse("2026-05-03T17:55:00.000Z"),
    gameType: "1v1",
    mapTitle: "Equilibrium LE",
    replayType: "multiplayer",
    players: [
      {
        name: "RetorieS",
        race: "Terran",
        result: "win",
        teamId: 0,
        toon: "1-S2-1-1",
        apm: 0
      },
      {
        name: "Opponent",
        race: "Zerg",
        result: "loss",
        teamId: 1,
        toon: "1-S2-1-2",
        apm: 0
      }
    ],
    ...overrides
  };
}

describe("BinaryReplayMetadataReader", () => {
  it("maps map title and playedAt from the replay summary", async () => {
    const reader = new BinaryReplayMetadataReader({
      loadReplaySummary: vi.fn(async () => buildSummary())
    });

    const metadata = await reader.readMetadata(baseFile);

    expect(metadata).toMatchObject({
      replayPath: baseFile.path,
      map: "Equilibrium LE",
      playedAt: "2026-05-03T17:55:00.000Z",
      durationSeconds: 600,
      players: [
        { name: "RetorieS", race: "Terran", result: "win" },
        { name: "Opponent", race: "Zerg", result: "loss" }
      ]
    });
  });

  it("resolves the user player's win/loss result when the user name is known", async () => {
    const reader = new BinaryReplayMetadataReader({
      loadReplaySummary: vi.fn(async () => buildSummary()),
      resolveUserName: async () => "RetorieS"
    });

    const metadata = await reader.readMetadata(baseFile);
    expect(metadata.result).toBe("win");
  });

  it("falls back to file modifiedAt when the summary has no playedAt", async () => {
    const reader = new BinaryReplayMetadataReader({
      loadReplaySummary: vi.fn(async () =>
        buildSummary({ playedAt: null, playedAtMs: null })
      )
    });

    const metadata = await reader.readMetadata(baseFile);
    expect(metadata.playedAt).toBe(baseFile.modifiedAt);
  });

  it("returns undefined result for tie/undecided/unknown", async () => {
    const reader = new BinaryReplayMetadataReader({
      loadReplaySummary: vi.fn(async () =>
        buildSummary({
          players: [
            { name: "RetorieS", race: "Terran", result: "tie", teamId: 0, toon: null, apm: 0 },
            { name: "Other", race: "Zerg", result: "tie", teamId: 1, toon: null, apm: 0 }
          ]
        })
      ),
      resolveUserName: async () => "RetorieS"
    });

    const metadata = await reader.readMetadata(baseFile);
    expect(metadata.result).toBe("unknown");
  });

  it("returns undefined result when the user name cannot be matched", async () => {
    const reader = new BinaryReplayMetadataReader({
      loadReplaySummary: vi.fn(async () => buildSummary()),
      resolveUserName: async () => "UnknownUser"
    });

    const metadata = await reader.readMetadata(baseFile);
    expect(metadata.result).toBeUndefined();
  });

  it("delegates to the fallback reader when binary parsing throws", async () => {
    const fallback: ReplayMetadataReaderPort = {
      readMetadata: vi.fn(
        async (file): Promise<ReplayMetadata> => ({
          replayPath: file.path,
          playedAt: "2026-05-03T17:00:00.000Z",
          map: "Sidecar Map",
          result: "loss"
        })
      )
    };

    const reader = new BinaryReplayMetadataReader({
      loadReplaySummary: vi.fn(async () => {
        throw new Error("MPQ archive corrupted");
      }),
      fallback
    });

    const metadata = await reader.readMetadata(baseFile);
    expect(metadata).toMatchObject({
      replayPath: baseFile.path,
      map: "Sidecar Map",
      result: "loss"
    });
    expect(fallback.readMetadata).toHaveBeenCalledTimes(1);
  });

  it("propagates the error when no fallback is configured", async () => {
    const reader = new BinaryReplayMetadataReader({
      loadReplaySummary: vi.fn(async () => {
        throw new Error("Bad magic");
      })
    });

    await expect(reader.readMetadata(baseFile)).rejects.toThrow("Bad magic");
  });

  it("matches the user name case-insensitively", async () => {
    const reader = new BinaryReplayMetadataReader({
      loadReplaySummary: vi.fn(async () => buildSummary()),
      resolveUserName: async () => "retories"
    });

    const metadata = await reader.readMetadata(baseFile);
    expect(metadata.result).toBe("win");
  });

  it("strips replay clan tags before matching and exposing player names", async () => {
    const reader = new BinaryReplayMetadataReader({
      loadReplaySummary: vi.fn(async () =>
        buildSummary({
          players: [
            { name: "<RTS> RetorieS", race: "Terran", result: "loss", teamId: 0, toon: "1-S2-1-1", apm: 0 },
            { name: "<ZENT> Milkaa", race: "Protoss", result: "win", teamId: 1, toon: "1-S2-1-2", apm: 0 }
          ]
        })
      ),
      resolveUserName: async () => "RetorieS"
    });

    const metadata = await reader.readMetadata(baseFile);

    expect(metadata.result).toBe("loss");
    expect(metadata.players).toEqual([
      { name: "RetorieS", race: "Terran", result: "loss", toon: "1-S2-1-1" },
      { name: "Milkaa", race: "Protoss", result: "win", toon: "1-S2-1-2" }
    ]);
  });
});
