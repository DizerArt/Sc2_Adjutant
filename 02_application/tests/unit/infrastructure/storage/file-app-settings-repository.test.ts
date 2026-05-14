import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultAppSettings, updateAppSettings } from "../../../../src/domain/entities/app-settings.js";
import { FileAppSettingsRepository } from "../../../../src/infrastructure/storage/file-app-settings-repository.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("FileAppSettingsRepository", () => {
  it("returns defaults when settings file does not exist", async () => {
    const dir = await createTempDir();
    const repository = new FileAppSettingsRepository(join(dir, "settings.json"));

    await expect(repository.read()).resolves.toMatchObject({
      region: "unknown",
      defaultRace: "Unknown",
      pollingIntervalMs: 1000,
      externalSourcesEnabled: true
    });
  });

  it("saves and reads settings from JSON", async () => {
    const dir = await createTempDir();
    const repository = new FileAppSettingsRepository(join(dir, "settings.json"));
    const settings = updateAppSettings(
      defaultAppSettings("2026-05-03T00:00:00.000Z"),
      {
        playerName: "DizerArt",
        region: "eu",
        defaultRace: "Protoss",
        replayDirectory: "A:\\Replays",
        pollingIntervalMs: 2000,
        externalSources: {
          sc2Pulse: true,
          localFixture: true
        }
      },
      "2026-05-03T00:30:00.000Z"
    );

    await repository.save(settings);

    await expect(repository.read()).resolves.toEqual(settings);
  });

  it("fills per-source defaults for older settings JSON", async () => {
    const dir = await createTempDir();
    const settingsPath = join(dir, "settings.json");
    await writeFile(
      settingsPath,
      JSON.stringify(
        {
          region: "eu",
          defaultRace: "Terran",
          pollingIntervalMs: 1000,
          externalSourcesEnabled: true,
          updatedAt: "2026-05-03T00:00:00.000Z"
        },
        null,
        2
      ),
      "utf8"
    );
    const repository = new FileAppSettingsRepository(settingsPath);

    await expect(repository.read()).resolves.toMatchObject({
      externalSources: {
        sc2Pulse: true,
        localFixture: true
      }
    });
  });
});

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sc2-assistant-settings-"));
  tempDirs.push(dir);
  return dir;
}
