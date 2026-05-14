import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEnrichmentCandidateSnapshot } from "../../../../src/domain/entities/enrichment-candidate-snapshot.js";
import { FileEnrichmentCandidateRepository } from "../../../../src/infrastructure/storage/file-enrichment-candidate-repository.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("FileEnrichmentCandidateRepository", () => {
  it("replaces candidates for one opponent without deleting other opponents", async () => {
    const dir = await createTempDir();
    const repository = new FileEnrichmentCandidateRepository(join(dir, "enrichment-candidates.json"));

    await repository.replaceForOpponent("opponent_001", [
      createEnrichmentCandidateSnapshot(
        "opponent_001",
        {
          source: "SourceA",
          nickname: "Alpha",
          race: "Terran",
          aliases: [],
          confidenceScore: 0.7
        },
        false,
        "2026-05-03T12:00:00.000Z"
      )
    ]);
    await repository.replaceForOpponent("opponent_002", [
      createEnrichmentCandidateSnapshot(
        "opponent_002",
        {
          source: "SourceB",
          nickname: "Beta",
          race: "Zerg",
          aliases: [],
          confidenceScore: 0.9
        },
        true,
        "2026-05-03T12:05:00.000Z"
      )
    ]);
    await repository.replaceForOpponent("opponent_001", [
      createEnrichmentCandidateSnapshot(
        "opponent_001",
        {
          source: "SourceC",
          nickname: "Gamma",
          race: "Protoss",
          aliases: [],
          confidenceScore: 0.8
        },
        true,
        "2026-05-03T12:10:00.000Z"
      )
    ]);

    await expect(repository.findByOpponentId("opponent_001")).resolves.toMatchObject([
      {
        source: "SourceC",
        nickname: "Gamma",
        selected: true
      }
    ]);
    await expect(repository.findByOpponentId("opponent_002")).resolves.toMatchObject([
      {
        source: "SourceB",
        nickname: "Beta",
        selected: true
      }
    ]);
  });
});

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sc2-assistant-candidates-"));
  tempDirs.push(dir);
  return dir;
}
