import { describe, expect, it } from "vitest";
import {
  DEFAULT_VOICE_EN,
  defaultVoiceSettings,
  normalizePiperVoiceId,
  normalizeVoiceProvider,
  normalizeVoiceSettings,
  normalizeVolume,
  normalizeSpeakingRate,
  voiceIdLanguage,
  VOICE_RATE_MAX,
  VOICE_RATE_MIN,
  VOICE_VOLUME_MAX,
  VOICE_VOLUME_MIN
} from "../../../src/domain/entities/voice-settings.js";

describe("voice-settings", () => {
  describe("defaultVoiceSettings", () => {
    it("starts disabled with English-only defaults", () => {
      const defaults = defaultVoiceSettings();
      expect(defaults.enabled).toBe(false);
      expect(defaults.provider).toBe("piper");
      expect(defaults.voiceEn).toBe(DEFAULT_VOICE_EN);
      expect(defaults.voiceEn).toBe("en_US-glados");
      expect(defaults.speakingRate).toBe(1);
      expect(defaults.volume).toBeGreaterThan(0);
      expect(defaults.announceOnLaunch).toBe(true);
      expect(defaults.announceOpponentCard).toBe(true);
      expect(defaults.announceMatchSummary).toBe(false);
    });
  });

  describe("normalizeVoiceProvider", () => {
    it("recognizes piper and off", () => {
      expect(normalizeVoiceProvider("piper")).toBe("piper");
      expect(normalizeVoiceProvider("off")).toBe("off");
    });

    it("falls back to piper on garbage", () => {
      expect(normalizeVoiceProvider("aws")).toBe("piper");
      expect(normalizeVoiceProvider(undefined)).toBe("piper");
      expect(normalizeVoiceProvider(42)).toBe("piper");
    });
  });

  describe("normalizePiperVoiceId", () => {
    it("accepts known English voice ids", () => {
      expect(normalizePiperVoiceId("en_US-glados", DEFAULT_VOICE_EN)).toBe("en_US-glados");
      expect(normalizePiperVoiceId("en_US-amy-medium", DEFAULT_VOICE_EN)).toBe("en_US-amy-medium");
    });

    it("uses fallback for unknown or removed ids", () => {
      expect(normalizePiperVoiceId("ru_RU-irina-medium", DEFAULT_VOICE_EN)).toBe(DEFAULT_VOICE_EN);
      expect(normalizePiperVoiceId("ru_RU-unknown", DEFAULT_VOICE_EN)).toBe(DEFAULT_VOICE_EN);
      expect(normalizePiperVoiceId(null, DEFAULT_VOICE_EN)).toBe(DEFAULT_VOICE_EN);
    });

    it("migrates legacy LibriTTS ids to the current English default", () => {
      expect(normalizePiperVoiceId("en_US-libritts-high", DEFAULT_VOICE_EN)).toBe(DEFAULT_VOICE_EN);
    });
  });

  describe("normalizeVolume", () => {
    it("clamps to [0,1]", () => {
      expect(normalizeVolume(-1)).toBe(VOICE_VOLUME_MIN);
      expect(normalizeVolume(5)).toBe(VOICE_VOLUME_MAX);
      expect(normalizeVolume(0.42)).toBeCloseTo(0.42);
    });

    it("uses default on non-finite input", () => {
      expect(normalizeVolume("loud")).toBe(defaultVoiceSettings().volume);
      expect(normalizeVolume(Number.NaN)).toBe(defaultVoiceSettings().volume);
    });
  });

  describe("normalizeSpeakingRate", () => {
    it("clamps to allowed range", () => {
      expect(normalizeSpeakingRate(0.1)).toBe(VOICE_RATE_MIN);
      expect(normalizeSpeakingRate(10)).toBe(VOICE_RATE_MAX);
      expect(normalizeSpeakingRate(1.25)).toBeCloseTo(1.25);
    });

    it("falls back to 1.0 on garbage", () => {
      expect(normalizeSpeakingRate("fast")).toBe(1);
    });
  });

  describe("normalizeVoiceSettings", () => {
    it("returns defaults when input is undefined", () => {
      expect(normalizeVoiceSettings(undefined)).toEqual(defaultVoiceSettings());
    });

    it("merges partial input over current settings", () => {
      const current = defaultVoiceSettings();
      const next = normalizeVoiceSettings({ enabled: true, volume: 0.3 }, current);
      expect(next.enabled).toBe(true);
      expect(next.volume).toBeCloseTo(0.3);
      expect(next.voiceEn).toBe(current.voiceEn);
    });

    it("normalizes invalid nested fields", () => {
      const next = normalizeVoiceSettings({
        voiceEn: "garbage" as never,
        volume: 5,
        speakingRate: -1
      });
      expect(next.voiceEn).toBe(DEFAULT_VOICE_EN);
      expect(next.volume).toBe(VOICE_VOLUME_MAX);
      expect(next.speakingRate).toBe(VOICE_RATE_MIN);
    });
  });

  describe("voiceIdLanguage", () => {
    it("maps bundled voices to English", () => {
      expect(voiceIdLanguage("en_US-glados")).toBe("en");
      expect(voiceIdLanguage("en_US-amy-medium")).toBe("en");
    });
  });
});
