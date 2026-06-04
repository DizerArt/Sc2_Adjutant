import {
  defaultAppSettings,
  normalizeLanguage,
  normalizeRegion,
  updateAppSettings,
  type AppSettings
} from "../../domain/entities/app-settings.js";
import type { AppSettingsRepository } from "../../domain/repositories/app-settings-repository.js";
import { readTextFileIfExists, writeTextFileAtomically } from "./atomic-file.js";

export class FileAppSettingsRepository implements AppSettingsRepository {
  constructor(private readonly filePath: string) {}

  async read(): Promise<AppSettings> {
    const content = await readTextFileIfExists(this.filePath);

    if (content === null) {
      return defaultAppSettings();
    }

    const parsed = JSON.parse(content) as Partial<AppSettings>;

    return updateAppSettings(defaultAppSettings(parsed.updatedAt), {
      playerName: parsed.playerName,
      language: normalizeLanguage(parsed.language),
      region: parsed.region ? normalizeRegion(parsed.region) : "unknown",
      defaultRace: parsed.defaultRace,
      replayDirectory: parsed.replayDirectory,
      pollingIntervalMs: parsed.pollingIntervalMs,
      externalSourcesEnabled: parsed.externalSourcesEnabled,
      externalSources: parsed.externalSources,
      overlayEnabled: parsed.overlayEnabled,
      overlayPosition: parsed.overlayPosition,
      overlayPlacementMode: parsed.overlayPlacementMode,
      overlayCustomPosition: parsed.overlayCustomPosition
    }, parsed.updatedAt ?? new Date().toISOString());
  }

  async save(settings: AppSettings): Promise<void> {
    await writeTextFileAtomically(this.filePath, `${JSON.stringify(settings, null, 2)}\n`);
  }
}
