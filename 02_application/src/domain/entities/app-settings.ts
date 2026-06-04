import { normalizeRace, type Race } from "../value-objects/race.js";

export type AppRegion = "us" | "eu" | "kr" | "cn" | "unknown";
export type AppLanguage = "en" | "ru";

export const OVERLAY_POSITIONS = [
  "top-left",
  "top-center",
  "top-right",
  "middle-left",
  "middle-right",
  "bottom-1",
  "bottom-2",
  "bottom-3",
  "bottom-4",
  "bottom-5",
  "bottom-6"
] as const;

export type OverlayPosition = (typeof OVERLAY_POSITIONS)[number];

export type OverlayCustomPosition = {
  readonly x: number;
  readonly y: number;
};

const LEGACY_OVERLAY_POSITIONS: Record<string, OverlayPosition> = {
  "bottom-left": "bottom-1",
  "bottom-center": "bottom-4",
  "bottom-right": "bottom-6"
};

export type ExternalSourceSettings = {
  readonly sc2Pulse: boolean;
  readonly localFixture: boolean;
};

export type AppSettings = {
  readonly playerName?: string;
  readonly language: AppLanguage;
  readonly region: AppRegion;
  readonly defaultRace: Race;
  readonly replayDirectory?: string;
  readonly pollingIntervalMs: number;
  readonly externalSourcesEnabled: boolean;
  readonly externalSources: ExternalSourceSettings;
  readonly overlayEnabled: boolean;
  readonly overlayPosition: OverlayPosition;
  readonly overlayPlacementMode: boolean;
  readonly overlayCustomPosition?: OverlayCustomPosition;
  readonly updatedAt: string;
};

export type UpdateAppSettingsInput = Partial<
  Omit<AppSettings, "updatedAt" | "externalSources" | "overlayCustomPosition">
> & {
  readonly externalSources?: Partial<ExternalSourceSettings>;
  readonly overlayCustomPosition?: OverlayCustomPosition | null;
};

export function defaultAppSettings(now = new Date().toISOString()): AppSettings {
  return {
    language: "en",
    region: "unknown",
    defaultRace: "Unknown",
    pollingIntervalMs: 1000,
    externalSourcesEnabled: true,
    externalSources: defaultExternalSourceSettings(),
    overlayEnabled: false,
    overlayPosition: "top-right",
    overlayPlacementMode: false,
    updatedAt: now
  };
}

export function normalizeOverlayPosition(value: unknown): OverlayPosition {
  if (typeof value !== "string") {
    return "top-right";
  }
  if ((OVERLAY_POSITIONS as readonly string[]).includes(value)) {
    return value as OverlayPosition;
  }
  return LEGACY_OVERLAY_POSITIONS[value] ?? "top-right";
}

export function normalizeOverlayCustomPosition(value: unknown): OverlayCustomPosition | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.x !== "number" || typeof candidate.y !== "number") {
    return undefined;
  }
  if (!Number.isFinite(candidate.x) || !Number.isFinite(candidate.y)) {
    return undefined;
  }
  return {
    x: Math.round(candidate.x),
    y: Math.round(candidate.y)
  };
}

export function normalizeLanguage(value: unknown): AppLanguage {
  return value === "ru" ? "ru" : "en";
}

export function updateAppSettings(
  current: AppSettings,
  input: UpdateAppSettingsInput,
  now = new Date().toISOString()
): AppSettings {
  return {
    playerName: normalizeOptionalString(input.playerName ?? current.playerName),
    language: normalizeLanguage(input.language ?? current.language),
    region: normalizeRegion(input.region ?? current.region),
    defaultRace: normalizeRace(input.defaultRace ?? current.defaultRace),
    replayDirectory: normalizeOptionalString(input.replayDirectory ?? current.replayDirectory),
    pollingIntervalMs: normalizePollingInterval(input.pollingIntervalMs ?? current.pollingIntervalMs),
    externalSourcesEnabled: input.externalSourcesEnabled ?? current.externalSourcesEnabled,
    externalSources: normalizeExternalSourceSettings(current.externalSources, input.externalSources),
    overlayEnabled: input.overlayEnabled ?? current.overlayEnabled,
    overlayPosition: input.overlayPosition
      ? normalizeOverlayPosition(input.overlayPosition)
      : current.overlayPosition,
    overlayPlacementMode: input.overlayPlacementMode ?? current.overlayPlacementMode,
    overlayCustomPosition: Object.prototype.hasOwnProperty.call(input, "overlayCustomPosition")
      ? normalizeOverlayCustomPosition(input.overlayCustomPosition)
      : current.overlayCustomPosition,
    updatedAt: now
  };
}

export function defaultExternalSourceSettings(): ExternalSourceSettings {
  return {
    sc2Pulse: true,
    localFixture: true
  };
}

export function normalizeRegion(value: string): AppRegion {
  const normalized = value.trim().toLowerCase();

  if (normalized === "us" || normalized === "eu" || normalized === "kr" || normalized === "cn") {
    return normalized;
  }

  return "unknown";
}

function normalizePollingInterval(value: number): number {
  if (!Number.isFinite(value)) {
    return 1000;
  }

  return Math.min(Math.max(Math.round(value), 500), 10_000);
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function normalizeExternalSourceSettings(
  current: ExternalSourceSettings | undefined,
  input: Partial<ExternalSourceSettings> | undefined
): ExternalSourceSettings {
  const defaults = current ?? defaultExternalSourceSettings();

  return {
    sc2Pulse: input?.sc2Pulse ?? defaults.sc2Pulse,
    localFixture: input?.localFixture ?? defaults.localFixture
  };
}
