import type { OpponentDataCandidate, OpponentDataSourcePort, OpponentSearchQuery } from "../../domain/ports/opponent-data-source-port.js";
import type { AppSettingsRepository } from "../../domain/repositories/app-settings-repository.js";
import type { AppSettings } from "../../domain/entities/app-settings.js";

export type SourceEnabledPredicate = (settings: AppSettings) => boolean;

export class SettingsAwareOpponentDataSource implements OpponentDataSourcePort {
  readonly sourceName: string;

  constructor(
    private readonly settingsRepository: AppSettingsRepository,
    private readonly source: OpponentDataSourcePort,
    private readonly sourceEnabled: SourceEnabledPredicate = () => true
  ) {
    this.sourceName = source.sourceName;
  }

  async searchOpponent(query: OpponentSearchQuery): Promise<readonly OpponentDataCandidate[]> {
    const settings = await this.settingsRepository.read();

    if (!settings.externalSourcesEnabled || !this.sourceEnabled(settings)) {
      return [];
    }

    return this.source.searchOpponent(query);
  }
}
