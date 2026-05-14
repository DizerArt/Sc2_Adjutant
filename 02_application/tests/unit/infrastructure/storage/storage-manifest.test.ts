import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CURRENT_STORAGE_SCHEMA_VERSION,
  ensureStorageManifest,
  readStorageManifest
} from "../../../../src/infrastructure/storage/storage-manifest.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("storage manifest", () => {
  it("creates a manifest for CSV storage", async () => {
    const dir = await createTempDir();

    const manifest = await ensureStorageManifest({
      directory: dir,
      storageFormat: "csv",
      clock: () => "2026-05-03T02:30:00.000Z"
    });

    expect(manifest).toEqual({
      appName: "SC2 Assistant",
      schemaVersion: CURRENT_STORAGE_SCHEMA_VERSION,
      storageFormat: "csv",
      files: {
        opponents: "opponents.csv",
        matches: "matches.csv",
        settings: "settings.json",
        enrichmentCandidates: "enrichment-candidates.json",
        opponentSourceFixtures: "opponent-source-fixtures.json"
      },
      createdAt: "2026-05-03T02:30:00.000Z",
      updatedAt: "2026-05-03T02:30:00.000Z"
    });

    await expect(readStorageManifest(dir)).resolves.toEqual(manifest);
  });

  it("updates an existing manifest while preserving createdAt", async () => {
    const dir = await createTempDir();

    await ensureStorageManifest({
      directory: dir,
      storageFormat: "csv",
      clock: () => "2026-05-03T02:30:00.000Z"
    });

    const manifest = await ensureStorageManifest({
      directory: dir,
      storageFormat: "xml",
      clock: () => "2026-05-03T02:45:00.000Z"
    });

    expect(manifest.createdAt).toBe("2026-05-03T02:30:00.000Z");
    expect(manifest.updatedAt).toBe("2026-05-03T02:45:00.000Z");
    expect(manifest.storageFormat).toBe("xml");
    expect(manifest.files).toEqual({
      opponents: "opponents.xml",
      matches: "matches.xml",
      settings: "settings.json",
      enrichmentCandidates: "enrichment-candidates.json",
      opponentSourceFixtures: "opponent-source-fixtures.json"
    });
  });
});

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sc2-assistant-manifest-"));
  tempDirs.push(dir);
  return dir;
}
