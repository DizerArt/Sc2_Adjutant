import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { createMatch } from "../../../../src/domain/entities/match.js";
import { createOpponent } from "../../../../src/domain/entities/opponent.js";
import { FileMatchRepository } from "../../../../src/infrastructure/storage/file-match-repository.js";
import { FileOpponentRepository, type FileStorageFormat } from "../../../../src/infrastructure/storage/file-opponent-repository.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe.each<FileStorageFormat>(["csv", "xml"])("file repositories using %s", (format) => {
  it("saves and reads opponents without creating duplicates", async () => {
    const dir = await createTempDir();
    const filePath = join(dir, `opponents.${format}`);
    const repository = new FileOpponentRepository(filePath, format);

    const opponent = createOpponent({
      id: "opponent_001",
      nickname: "HiveMindX",
      race: "Zerg",
      aliases: ["HiveMind"],
      mmrAtLastMatch: 3912,
      league: "Diamond",
      notes: ["Roach pressure at 5:00"],
      strategyTags: ["roach-pressure"],
      confidenceScore: 0.82,
      now: "2026-05-03T00:00:00.000Z"
    });

    await repository.save(opponent);
    await repository.save({ ...opponent, notes: [...opponent.notes, "Weak third base defense"] });

    const opponents = await repository.findAll();
    const found = await repository.findById("opponent_001");

    expect(opponents).toHaveLength(1);
    expect(found).toMatchObject({
      id: "opponent_001",
      nickname: "HiveMindX",
      race: "Zerg",
      mmrAtLastMatch: 3912,
      league: "Diamond",
      confidenceScore: 0.82
    });
    expect(found?.raceProfiles?.Zerg).toMatchObject({
      mmrAtLastMatch: 3912,
      league: "Diamond",
      strategyTags: ["roach-pressure"],
      confidenceScore: 0.82
    });
    expect(found?.notes).toEqual(["Roach pressure at 5:00", "Weak third base defense"]);
  });

  it("saves and reads matches by opponent id", async () => {
    const dir = await createTempDir();
    const filePath = join(dir, `matches.${format}`);
    const repository = new FileMatchRepository(filePath, format);

    const firstMatch = createMatch({
      id: "match_001",
      opponentId: "opponent_001",
      playedAt: "2026-05-03T00:10:00.000Z",
      map: "Amphion LE",
      playerRace: "Terran",
      opponentRace: "Zerg",
      result: "win",
      mmrBefore: 3900,
      mmrAfter: 3924,
      favorite: true,
      notes: ["Held early pressure"],
      now: "2026-05-03T00:20:00.000Z"
    });

    const secondMatch = createMatch({
      id: "match_002",
      opponentId: "opponent_002",
      playedAt: "2026-05-03T00:40:00.000Z",
      playerRace: "Terran",
      opponentRace: "Protoss",
      result: "loss",
      now: "2026-05-03T00:50:00.000Z"
    });

    await repository.save(firstMatch);
    await repository.save(secondMatch);

    const matches = await repository.findByOpponentId("opponent_001");

    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      id: "match_001",
      opponentId: "opponent_001",
      map: "Amphion LE",
      result: "win",
      mmrBefore: 3900,
      mmrAfter: 3924,
      favorite: true
    });
  });
});

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sc2-assistant-storage-"));
  tempDirs.push(dir);
  return dir;
}
