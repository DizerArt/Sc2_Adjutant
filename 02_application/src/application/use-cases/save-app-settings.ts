import { updateAppSettings, type AppSettings, type UpdateAppSettingsInput } from "../../domain/entities/app-settings.js";
import type { AppSettingsRepository } from "../../domain/repositories/app-settings-repository.js";

export type SaveAppSettingsInput = UpdateAppSettingsInput;

export type SaveAppSettingsResult = {
  readonly settings: AppSettings;
};

export class SaveAppSettings {
  private readonly clock: () => string;

  constructor(
    private readonly settingsRepository: AppSettingsRepository,
    clock: () => string = () => new Date().toISOString()
  ) {
    this.clock = clock;
  }

  async execute(input: SaveAppSettingsInput): Promise<SaveAppSettingsResult> {
    const current = await this.settingsRepository.read();
    const settings = updateAppSettings(current, input, this.clock());
    await this.settingsRepository.save(settings);

    return {
      settings
    };
  }
}
