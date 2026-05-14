import { describe, expect, it } from "vitest";
import { defaultAppSettings, type AppSettings } from "../../../../src/domain/entities/app-settings.js";
import type {
  OpponentDataCandidate,
  OpponentDataSourcePort,
  OpponentSearchQuery
} from "../../../../src/domain/ports/opponent-data-source-port.js";
import type { AppSettingsRepository } from "../../../../src/domain/repositories/app-settings-repository.js";
import { SettingsAwareOpponentDataSource } from "../../../../src/infrastructure/opponent-sources/settings-aware-opponent-data-source.js";

describe("SettingsAwareOpponentDataSource", () => {
  it("returns no candidates when external sources are disabled", async () => {
    const source = new SettingsAwareOpponentDataSource(
      new InMemorySettingsRepository({ ...defaultAppSettings(), externalSourcesEnabled: false }),
      new FakeSource()
    );

    await expect(source.searchOpponent({ nickname: "RobbyG" })).resolves.toEqual([]);
  });

  it("delegates to the wrapped source when external sources are enabled", async () => {
    const source = new SettingsAwareOpponentDataSource(
      new InMemorySettingsRepository({ ...defaultAppSettings(), externalSourcesEnabled: true }),
      new FakeSource()
    );

    await expect(source.searchOpponent({ nickname: "RobbyG" })).resolves.toHaveLength(1);
  });

  it("returns no candidates when the specific source is disabled", async () => {
    const source = new SettingsAwareOpponentDataSource(
      new InMemorySettingsRepository({
        ...defaultAppSettings(),
        externalSources: {
          ...defaultAppSettings().externalSources,
          sc2Pulse: false
        }
      }),
      new FakeSource(),
      (settings) => settings.externalSources.sc2Pulse
    );

    await expect(source.searchOpponent({ nickname: "RobbyG" })).resolves.toEqual([]);
  });
});

class InMemorySettingsRepository implements AppSettingsRepository {
  constructor(private readonly settings: AppSettings) {}

  async read(): Promise<AppSettings> {
    return this.settings;
  }

  async save(_settings: AppSettings): Promise<void> {}
}

class FakeSource implements OpponentDataSourcePort {
  readonly sourceName = "Fake";

  async searchOpponent(_query: OpponentSearchQuery): Promise<readonly OpponentDataCandidate[]> {
    return [
      {
        source: "Fake",
        nickname: "RobbyG",
        race: "Terran",
        aliases: [],
        confidenceScore: 0.8
      }
    ];
  }
}
