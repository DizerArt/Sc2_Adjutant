import type { AppSettings } from "../../domain/entities/app-settings.js";
import type { AppSettingsRepository } from "../../domain/repositories/app-settings-repository.js";

export type GetAppSettingsResult = {
  readonly settings: AppSettings;
};

export class GetAppSettings {
  constructor(private readonly settingsRepository: AppSettingsRepository) {}

  async execute(): Promise<GetAppSettingsResult> {
    return {
      settings: await this.settingsRepository.read()
    };
  }
}
