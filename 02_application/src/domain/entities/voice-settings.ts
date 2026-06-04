export type VoiceProvider = "piper" | "off";

export const PIPER_VOICE_IDS = [
  "en_US-glados",
  "en_US-amy-medium"
] as const;

export const SILERO_RU_VOICE_IDS = [
  "ru_RU-silero-xenia",
  "ru_RU-silero-baya"
] as const;

export type PiperVoiceId = (typeof PIPER_VOICE_IDS)[number];
export type SileroRuVoiceId = (typeof SILERO_RU_VOICE_IDS)[number];
export type VoiceId = PiperVoiceId | SileroRuVoiceId;

export type VoiceSettings = {
  readonly enabled: boolean;
  readonly provider: VoiceProvider;
  readonly voiceEn: PiperVoiceId;
  readonly voiceRu: SileroRuVoiceId;
  readonly volume: number;
  readonly speakingRate: number;
  readonly announceOnLaunch: boolean;
  readonly announceOpponentCard: boolean;
  readonly announceMatchSummary: boolean;
};

export const DEFAULT_VOICE_EN: PiperVoiceId = "en_US-glados";
export const DEFAULT_VOICE_RU: SileroRuVoiceId = "ru_RU-silero-xenia";

export const VOICE_VOLUME_MIN = 0;
export const VOICE_VOLUME_MAX = 1;
export const VOICE_RATE_MIN = 0.5;
export const VOICE_RATE_MAX = 2;

export function defaultVoiceSettings(): VoiceSettings {
  return {
    enabled: false,
    provider: "piper",
    voiceEn: DEFAULT_VOICE_EN,
    voiceRu: DEFAULT_VOICE_RU,
    volume: 0.7,
    speakingRate: 1,
    announceOnLaunch: true,
    announceOpponentCard: true,
    announceMatchSummary: false
  };
}

export function normalizeVoiceProvider(value: unknown): VoiceProvider {
  return value === "off" ? "off" : "piper";
}

export function normalizePiperVoiceId(
  value: unknown,
  fallback: PiperVoiceId
): PiperVoiceId {
  if (typeof value !== "string") {
    return fallback;
  }
  return (PIPER_VOICE_IDS as readonly string[]).includes(value)
    ? (value as PiperVoiceId)
    : fallback;
}

export function normalizeSileroRuVoiceId(
  value: unknown,
  fallback: SileroRuVoiceId
): SileroRuVoiceId {
  if (typeof value !== "string") {
    return fallback;
  }
  return (SILERO_RU_VOICE_IDS as readonly string[]).includes(value)
    ? (value as SileroRuVoiceId)
    : fallback;
}

export function normalizeVolume(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return defaultVoiceSettings().volume;
  }
  return clamp(value, VOICE_VOLUME_MIN, VOICE_VOLUME_MAX);
}

export function normalizeSpeakingRate(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 1;
  }
  return clamp(value, VOICE_RATE_MIN, VOICE_RATE_MAX);
}

export function normalizeVoiceSettings(
  input: Partial<VoiceSettings> | undefined,
  defaults: VoiceSettings = defaultVoiceSettings()
): VoiceSettings {
  if (!input) {
    return defaults;
  }

  return {
    enabled: typeof input.enabled === "boolean" ? input.enabled : defaults.enabled,
    provider: normalizeVoiceProvider(input.provider ?? defaults.provider),
    voiceEn: normalizePiperVoiceId(input.voiceEn ?? defaults.voiceEn, defaults.voiceEn),
    voiceRu: normalizeSileroRuVoiceId(input.voiceRu ?? defaults.voiceRu, defaults.voiceRu),
    volume: normalizeVolume(input.volume ?? defaults.volume),
    speakingRate: normalizeSpeakingRate(input.speakingRate ?? defaults.speakingRate),
    announceOnLaunch:
      typeof input.announceOnLaunch === "boolean" ? input.announceOnLaunch : defaults.announceOnLaunch,
    announceOpponentCard:
      typeof input.announceOpponentCard === "boolean"
        ? input.announceOpponentCard
        : defaults.announceOpponentCard,
    announceMatchSummary:
      typeof input.announceMatchSummary === "boolean"
        ? input.announceMatchSummary
        : defaults.announceMatchSummary
  };
}

export function voiceIdLanguage(voiceId: VoiceId): "en" | "ru" {
  return (SILERO_RU_VOICE_IDS as readonly string[]).includes(voiceId) ? "ru" : "en";
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
