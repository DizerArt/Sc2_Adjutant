import { describe, expect, it } from "vitest";
import { SaveAppSettings } from "../../../src/application/use-cases/save-app-settings.js";
import type { AppSettings } from "../../../src/domain/entities/app-settings.js";
import { defaultAppSettings } from "../../../src/domain/entities/app-settings.js";
import type { AppSettingsRepository } from "../../../src/domain/repositories/app-settings-repository.js";

describe("SaveAppSettings", () => {
  it("normalizes and persists player detection settings", async () => {
    const repository = new InMemorySettingsRepository(defaultAppSettings("2026-05-03T00:00:00.000Z"));
    const useCase = new SaveAppSettings(repository, () => "2026-05-03T01:00:00.000Z");

    const result = await useCase.execute({
      playerName: " RetorieS ",
      region: "eu",
      defaultRace: "Terran",
      pollingIntervalMs: 100,
      externalSourcesEnabled: false,
      externalSources: {
        sc2Pulse: true,
        localFixture: false
      },
      overlayEnabled: true,
      overlayPosition: "bottom-3",
      overlayPlacementMode: true,
      overlayCustomPosition: { x: 123.4, y: 456.7 }
    });

    expect(result.settings).toMatchObject({
      playerName: "RetorieS",
      region: "eu",
      defaultRace: "Terran",
      pollingIntervalMs: 500,
      externalSourcesEnabled: false,
      externalSources: {
        sc2Pulse: true,
        localFixture: false
      },
      overlayEnabled: true,
      overlayPosition: "bottom-3",
      overlayPlacementMode: true,
      overlayCustomPosition: { x: 123, y: 457 },
      updatedAt: "2026-05-03T01:00:00.000Z"
    });
    await expect(repository.read()).resolves.toEqual(result.settings);
  });
});

class InMemorySettingsRepository implements AppSettingsRepository {
  constructor(private settings: AppSettings) {}

  async read(): Promise<AppSettings> {
    return this.settings;
  }

  async save(settings: AppSettings): Promise<void> {
    this.settings = settings;
  }
}
