import { describe, expect, it, vi } from "vitest";
import type { AppLanguage } from "../../../src/domain/entities/app-settings.js";
import {
  defaultVoiceSettings,
  type VoiceSettings
} from "../../../src/domain/entities/voice-settings.js";
import type {
  SynthesizeRequest,
  SynthesizedAudio,
  VoiceSynthesisPort,
  VoiceRuntimeStatus
} from "../../../src/domain/ports/voice-synthesis-port.js";
import type { AudioPriority, VoiceAudioPlayer } from "../../../src/renderer/voice/audio-player.js";
import { registerLocalVoicePath } from "../../../src/renderer/voice/piper-runtime.js";
import { VoiceNarratorService } from "../../../src/renderer/voice/voice-narrator-service.js";
import { createTranslator } from "../../../src/renderer/i18n.js";
import { PATH_MAP } from "@mintplex-labs/piper-tts-web";

class RecordingTts implements VoiceSynthesisPort {
  readonly calls: SynthesizeRequest[] = [];
  getStatus(): VoiceRuntimeStatus {
    return { kind: "idle" };
  }
  async warmup(): Promise<void> {}
  async synthesize(request: SynthesizeRequest): Promise<SynthesizedAudio> {
    this.calls.push(request);
    return { samples: new Float32Array([0.1, -0.1]), sampleRate: 22050 };
  }
}

class RecordingPlayer {
  readonly enqueued: Array<{ priority: AudioPriority }> = [];
  preemptInterruptableCalls = 0;

  enqueue(_audio: SynthesizedAudio, options: { priority: AudioPriority }): number {
    this.enqueued.push({ priority: options.priority });
    return this.enqueued.length;
  }
  preemptInterruptable(): void {
    this.preemptInterruptableCalls += 1;
  }
  stopAll(): void {}
}

function makeNarrator(overrides: Partial<VoiceSettings> = {}, language: AppLanguage = "en") {
  const tts = new RecordingTts();
  const player = new RecordingPlayer();
  const settings: VoiceSettings = { ...defaultVoiceSettings(), enabled: true, ...overrides };
  const narrator = new VoiceNarratorService({
    tts,
    player: player as unknown as VoiceAudioPlayer,
    getSettings: () => settings,
    getUiLanguage: () => language,
    getTranslator: (requestedLanguage) => createTranslator(requestedLanguage)
  });
  return { narrator, tts, player };
}

describe("VoiceNarratorService", () => {
  it("registers bundled custom Piper voices before creating sessions", () => {
    delete PATH_MAP["en_US-glados"];
    registerLocalVoicePath("en_US-glados");
    expect(PATH_MAP["en_US-glados"]).toBe("en_US-glados.onnx");
  });

  it("stays silent while disabled", async () => {
    const { narrator, tts } = makeNarrator({ enabled: false });
    await narrator.announceLaunch();
    await narrator.announceOpponentCard({
      nickname: "X",
      race: "Terran",
      encounters: 1,
      wins: 1,
      losses: 0,
      strategyTags: [],
      notes: []
    });
    expect(tts.calls.length).toBe(0);
  });

  it("speaks greeting in English when UI language is English", async () => {
    const { narrator, tts } = makeNarrator({}, "en");
    await narrator.announceLaunch();
    expect(tts.calls.length).toBe(1);
    expect(tts.calls[0].language).toBe("en");
    expect(tts.calls[0].voiceId).toBe("en_US-glados");
    expect(tts.calls[0].text).toMatch(/commander/i);
  });

  it("speaks greeting in Russian with the Silero voice when UI language is Russian", async () => {
    const { narrator, tts } = makeNarrator({}, "ru");
    await narrator.announceLaunch();
    expect(tts.calls.length).toBe(1);
    expect(tts.calls[0].language).toBe("ru");
    expect(tts.calls[0].voiceId).toBe("ru_RU-silero-xenia");
    expect(tts.calls[0].text).toContain("командир");
  });

  it("emits opponent HEAD as protected and TAIL as interruptable", async () => {
    const { narrator, tts, player } = makeNarrator();
    await narrator.announceOpponentCard({
      nickname: "Aggressor",
      race: "Zerg",
      mmr: 4250,
      encounters: 5,
      wins: 3,
      losses: 2,
      strategyTags: ["cheese", "macro"],
      notes: ["watches reps"]
    });
    expect(tts.calls.length).toBe(2);
    expect(player.enqueued.map((item) => item.priority)).toEqual([
      "protected",
      "interruptable"
    ]);
    expect(player.preemptInterruptableCalls).toBe(1);
    expect(tts.calls[0].text).toMatch(/Aggressor/);
    expect(tts.calls[1].text).toMatch(/Win rate/i);
  });

  it("uses NoMmr template when MMR is missing", async () => {
    const { narrator, tts } = makeNarrator();
    await narrator.announceOpponentCard({
      nickname: "Mystery",
      race: "Protoss",
      encounters: 1,
      wins: 0,
      losses: 1,
      strategyTags: [],
      notes: []
    });
    expect(tts.calls[0].text).not.toMatch(/MMR/);
  });

  it("spells barcode nickname repeats in English", async () => {
    const { narrator, tts } = makeNarrator();
    await narrator.announceOpponentCard({
      nickname: "||||||||||",
      race: "Protoss",
      encounters: 1,
      wins: 1,
      losses: 0,
      strategyTags: [],
      notes: []
    });
    expect(tts.calls[0].text).toContain("vertical bar 10 times");
  });

  it("speaks first encounter line on zero encounters and skips tail", async () => {
    const { narrator, tts } = makeNarrator();
    await narrator.announceOpponentCard({
      nickname: "Newbie",
      race: "Random",
      encounters: 0,
      wins: 0,
      losses: 0,
      strategyTags: [],
      notes: []
    });
    expect(tts.calls.length).toBe(2);
    expect(tts.calls[1].text).toMatch(/first encounter/i);
  });

  it("respects per-event toggles", async () => {
    const { narrator, tts } = makeNarrator({
      announceOnLaunch: false,
      announceOpponentCard: true,
      announceMatchSummary: false
    });
    await narrator.announceLaunch();
    await narrator.announceMatchSummary({
      result: "win",
      durationSeconds: 120,
      opponentRace: "Terran"
    });
    expect(tts.calls.length).toBe(0);
    await narrator.announceOpponentCard({
      nickname: "X",
      race: "Terran",
      encounters: 2,
      wins: 1,
      losses: 1,
      strategyTags: [],
      notes: []
    });
    expect(tts.calls.length).toBe(2);
  });

  it("speaks Victory / Defeat for match summary", async () => {
    const { narrator, tts } = makeNarrator({ announceMatchSummary: true });
    await narrator.announceMatchSummary({
      result: "win",
      durationSeconds: 605,
      opponentRace: "Terran"
    });
    await narrator.announceMatchSummary({
      result: "loss",
      durationSeconds: 60,
      opponentRace: "Zerg"
    });
    expect(tts.calls[0].text).toMatch(/Victory/i);
    expect(tts.calls[1].text).toMatch(/Defeat/i);
  });

  it("preview phrase uses explicit English voice parameters", async () => {
    const { narrator, tts, player } = makeNarrator();
    await narrator.previewPhrase({
      language: "en",
      voiceId: "en_US-amy-medium",
      volume: 0.4,
      speakingRate: 1.2,
      kind: "opponent"
    });
    expect(player.preemptInterruptableCalls).toBe(1);
    expect(tts.calls[0].language).toBe("en");
    expect(tts.calls[0].voiceId).toBe("en_US-amy-medium");
  });

  it("preview phrase can use explicit Russian Silero voice parameters", async () => {
    const { narrator, tts, player } = makeNarrator({}, "ru");
    await narrator.previewPhrase({
      language: "ru",
      voiceId: "ru_RU-silero-baya",
      volume: 0.4,
      speakingRate: 1.2,
      kind: "opponent"
    });
    expect(player.preemptInterruptableCalls).toBe(1);
    expect(tts.calls[0].language).toBe("ru");
    expect(tts.calls[0].voiceId).toBe("ru_RU-silero-baya");
  });

  it("manual opponent card preview bypasses event toggle but keeps English speech", async () => {
    const { narrator, tts } = makeNarrator({ announceOpponentCard: false });
    await narrator.previewOpponentCard({
      nickname: "Preview",
      race: "Terran",
      mmr: 4000,
      encounters: 1,
      wins: 1,
      losses: 0,
      strategyTags: [],
      notes: []
    });
    expect(tts.calls[0].language).toBe("en");
    expect(tts.calls[0].text).toMatch(/Preview/);
  });

  it("swallows synthesize failure without crashing the queue", async () => {
    const { player } = makeNarrator();
    const failingTts = {
      getStatus: () => ({ kind: "idle" }) as const,
      warmup: vi.fn().mockResolvedValue(undefined),
      synthesize: vi.fn().mockRejectedValue(new Error("boom"))
    };
    const broken = new VoiceNarratorService({
      tts: failingTts as unknown as VoiceSynthesisPort,
      player: player as unknown as VoiceAudioPlayer,
      getSettings: () => ({ ...defaultVoiceSettings(), enabled: true }),
      getUiLanguage: () => "ru",
      getTranslator: (lang) => createTranslator(lang)
    });
    await expect(broken.announceLaunch()).resolves.toBeUndefined();
    expect(player.enqueued.length).toBe(0);
  });
});
