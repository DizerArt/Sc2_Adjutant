import type { AppSettings } from "../entities/app-settings.js";

export interface AppSettingsRepository {
  read(): Promise<AppSettings>;
  save(settings: AppSettings): Promise<void>;
}
