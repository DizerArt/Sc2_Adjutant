import { describe, expect, it, vi } from "vitest";
import { BackfillReplayMetadata } from "../../../src/application/use-cases/backfill-replay-metadata.js";
import type { ProcessNewReplay } from "../../../src/application/use-cases/process-new-replay.js";
import { createMatch, type Match } from "../../../src/domain/entities/match.js";
import type { ReplayMetadataReaderPort } from "../../../src/domain/ports/replay-metadata-reader-port.js";
import type { MatchRepository } from "../../../src/domain/repositories/match-repository.js";
import type { EntityId } from "../../../src/domain/value-objects/entity-id.js";

describe("BackfillReplayMetadata", () => {
  it("reprocesses linked replay matches with unknown result or missing metadata", async () => {
    const replayPath = "A:\\Replays\\Mothership.SC2Replay";
    const targetMatch = {
      ...match("match_001"),
      result: "unknown" as const,
      replayPath
    };
    const repository = new InMemoryMatchRepository([
      targetMatch,
      { ...match("match_002"), result: "loss", replayPath: "A:\\Replays\\complete.SC2Replay", map: "Map", durationSeconds: 300 }
    ]);
    const reader: ReplayMetadataReaderPort = {
      readMetadata: vi.fn(async () => ({
        replayPath,
        playedAt: "2026-05-05T00:05:00.000Z",
        map: "Mothership LE",
        result: "loss" as const,
        durationSeconds: 384
      }))
    };
    const processNewReplay = {
      execute: vi.fn(async () => ({
        match: { ...targetMatch, result: "loss", map: "Mothership LE", durationSeconds: 384 }
      }))
    } as unknown as ProcessNewReplay;

    const result = await new BackfillReplayMetadata({
      matchRepository: repository,
      replayMetadataReader: reader,
      processNewReplay
    }).execute();

    expect(result).toEqual({ inspectedCount: 1, updatedCount: 1, failedCount: 0 });
    expect(reader.readMetadata).toHaveBeenCalledWith({
      path: replayPath,
      modifiedAt: targetMatch.playedAt
    });
  });
});

function match(id: EntityId): Match {
  return createMatch({
    id,
    opponentId: "opponent_001",
    playedAt: "2026-05-05T00:00:00.000Z",
    playerRace: "Terran",
    opponentRace: "Protoss",
    now: "2026-05-05T00:00:00.000Z"
  });
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

  async save(): Promise<void> {
    throw new Error("not implemented");
  }

  async clear(): Promise<void> {
    throw new Error("not implemented");
  }
}
