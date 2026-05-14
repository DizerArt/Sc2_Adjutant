import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import type { Match } from "../../../../src/domain/entities/match.js";
import {
  compactMatches,
  compactMatchStorage
} from "../../../../src/infrastructure/storage/match-storage-maintenance.js";
import { matchesFromCsv, matchesToCsv } from "../../../../src/infrastructure/storage/storage-codecs.js";

describe("compactMatches", () => {
  it("merges repeated polling duplicates in a short time window", () => {
    const compacted = compactMatches(
      [
        match({ id: "match_1", playedAt: "2026-05-03T10:42:13.214Z", createdAt: "2026-05-03T10:42:13.214Z" }),
        match({ id: "match_2", playedAt: "2026-05-03T10:42:14.223Z", createdAt: "2026-05-03T10:42:14.223Z" }),
        match({
          id: "match_3",
          playedAt: "2026-05-03T10:42:15.236Z",
          createdAt: "2026-05-03T10:42:15.236Z",
          notes: ["observed proxy"]
        })
      ],
      15_000
    );

    expect(compacted).toHaveLength(1);
    expect(compacted[0]).toMatchObject({
      id: "match_1",
      playedAt: "2026-05-03T10:42:13.214Z",
      updatedAt: "2026-05-03T10:42:15.236Z",
      notes: ["observed proxy"]
    });
  });

  it("keeps rematches outside the duplicate time window", () => {
    const compacted = compactMatches(
      [
        match({ id: "match_1", playedAt: "2026-05-03T10:42:13.214Z", createdAt: "2026-05-03T10:42:13.214Z" }),
        match({ id: "match_2", playedAt: "2026-05-03T10:45:30.000Z", createdAt: "2026-05-03T10:45:30.000Z" })
      ],
      15_000
    );

    expect(compacted.map((item) => item.id)).toEqual(["match_1", "match_2"]);
  });

  it("does not merge nearby matches with different replay paths", () => {
    const compacted = compactMatches(
      [
        match({ id: "match_1", replayPath: "C:\\replays\\first.SC2Replay" }),
        match({ id: "match_2", replayPath: "C:\\replays\\second.SC2Replay" })
      ],
      15_000
    );

    expect(compacted).toHaveLength(2);
  });

  it("merges a stale replayless post-game sample after a completed replay match", () => {
    const compacted = compactMatches(
      [
        match({
          id: "match_replay",
          opponentId: "opponent_choigalaxy",
          playedAt: "2026-05-12T20:35:50.575Z",
          map: "Tourmaline LE",
          opponentRace: "Zerg",
          result: "loss",
          durationSeconds: 25,
          replayPath: "C:\\replays\\Tourmaline LE (31).SC2Replay"
        }),
        match({
          id: "match_stale",
          opponentId: "opponent_choigalaxy",
          playedAt: "2026-05-12T20:42:31.000Z",
          opponentRace: "Zerg",
          result: "loss",
          map: undefined,
          durationSeconds: undefined,
          replayPath: undefined
        })
      ]
    );

    expect(compacted).toHaveLength(1);
    expect(compacted[0]).toMatchObject({
      id: "match_replay",
      map: "Tourmaline LE",
      durationSeconds: 25,
      replayPath: "C:\\replays\\Tourmaline LE (31).SC2Replay"
    });
  });

  it("merges duplicate records that point to the same replay file", () => {
    const compacted = compactMatches(
      [
        match({
          id: "match_1",
          playedAt: "2026-05-03T10:42:13.214Z",
          replayPath: "C:\\replays\\same.SC2Replay",
          durationSeconds: 640
        }),
        match({
          id: "match_2",
          playedAt: "2026-05-03T11:15:00.000Z",
          replayPath: "C:\\replays\\same.SC2Replay"
        })
      ],
      15_000
    );

    expect(compacted).toHaveLength(1);
    expect(compacted[0]).toMatchObject({
      id: "match_1",
      replayPath: "C:\\replays\\same.SC2Replay",
      durationSeconds: 640
    });
  });
});

describe("compactMatchStorage", () => {
  it("rewrites CSV storage after removing duplicates", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sc2-match-maintenance-"));
    const filePath = join(dir, "matches.csv");

    await writeFile(
      filePath,
      matchesToCsv([
        match({ id: "match_1", playedAt: "2026-05-03T10:42:13.214Z", createdAt: "2026-05-03T10:42:13.214Z" }),
        match({ id: "match_2", playedAt: "2026-05-03T10:42:14.223Z", createdAt: "2026-05-03T10:42:14.223Z" })
      ]),
      "utf8"
    );

    const result = await compactMatchStorage({ filePath, format: "csv" });
    const after = matchesFromCsv(await readFile(filePath, "utf8"));

    expect(result).toEqual({ beforeCount: 2, afterCount: 1, removedCount: 1 });
    expect(after).toHaveLength(1);
    expect(after[0]?.id).toBe("match_1");
  });
});

function match(overrides: Partial<Match> = {}): Match {
  return {
    id: "match_1",
    opponentId: "opponent_leo-unknown",
    playedAt: "2026-05-03T10:42:13.214Z",
    map: "unknown map",
    playerRace: "Terran",
    opponentRace: "Unknown",
    result: "unknown",
    favorite: false,
    notes: [],
    createdAt: "2026-05-03T10:42:13.214Z",
    updatedAt: overrides.createdAt ?? "2026-05-03T10:42:13.214Z",
    ...overrides
  };
}
