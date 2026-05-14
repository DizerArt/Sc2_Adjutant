import { join } from "node:path";

export const APP_DATA_DIR_ENV = "SC2_ASSISTANT_DATA_DIR";

export function resolveAppDataDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const explicitPath = env[APP_DATA_DIR_ENV]?.trim();

  if (explicitPath) {
    return explicitPath;
  }

  const windowsAppData = env.APPDATA?.trim();

  if (windowsAppData) {
    return join(windowsAppData, "SC2 Assistant", "data");
  }

  const home = env.HOME?.trim() || env.USERPROFILE?.trim();

  if (home) {
    return join(home, ".sc2-assistant", "data");
  }

  return join(process.cwd(), "local-data");
}

