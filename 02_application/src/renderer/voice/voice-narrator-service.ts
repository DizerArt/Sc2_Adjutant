import type { AppLanguage } from "../../domain/entities/app-settings.js";
import type {
  PiperVoiceId,
  VoiceSettings
} from "../../domain/entities/voice-settings.js";
import type { Race } from "../../domain/value-objects/race.js";
import type {
  SynthesizedAudio,
  VoiceSynthesisPort
} from "../../domain/ports/voice-synthesis-port.js";
import type { AudioPriority, VoiceAudioPlayer } from "./audio-player.js";
import type { TranslationKey, Translator } from "../i18n.js";

export type OpponentSpeechData = {
  readonly nickname: string;
  readonly race: Race;
  readonly mmr?: number;
  readonly encounters: number;
  readonly wins: number;
  readonly losses: number;
  readonly strategyTags: readonly string[];
  readonly notes: readonly string[];
};

export type MatchSpeechData = {
  readonly result: "win" | "loss" | "unknown";
  readonly durationSeconds?: number;
  readonly opponentRace: Race;
};

export type NarratorDependencies = {
  readonly tts: VoiceSynthesisPort;
  readonly player: VoiceAudioPlayer;
  readonly getSettings: () => VoiceSettings;
  readonly getUiLanguage: () => AppLanguage;
  readonly getTranslator: (language: AppLanguage) => Translator;
};

const TOP_STRATEGY_TAGS = 3;
const TOP_NOTES = 2;

export class VoiceNarratorService {
  constructor(private readonly deps: NarratorDependencies) {}

  async announceLaunch(): Promise<void> {
    const settings = this.deps.getSettings();
    if (!settings.enabled || settings.provider === "off" || !settings.announceOnLaunch) {
      return;
    }
    const language = this.resolveSpeechLanguage();
    const translate = this.deps.getTranslator(language);
    await this.speak(translate("voice.speech.launch"), language, "protected");
  }

  async announceOpponentCard(data: OpponentSpeechData): Promise<void> {
    const settings = this.deps.getSettings();
    if (!settings.enabled || settings.provider === "off" || !settings.announceOpponentCard) {
      return;
    }
    await this.speakOpponentCard(data);
  }

  private async speakOpponentCard(data: OpponentSpeechData): Promise<void> {
    const language = this.resolveSpeechLanguage();
    const translate = this.deps.getTranslator(language);

    // New opponent preempts only interruptable tails — protected heads still play.
    this.deps.player.preemptInterruptable();

    const headTemplateKey: TranslationKey = data.mmr !== undefined
      ? "voice.speech.opponentHead"
      : "voice.speech.opponentHeadNoMmr";
    const head = interpolate(translate(headTemplateKey), {
      nickname: this.spellOutNickname(data.nickname, language),
      race: translate(`voice.speech.race.${data.race}` as TranslationKey),
      mmr: data.mmr !== undefined ? String(Math.round(data.mmr)) : ""
    });
    await this.speak(head, language, "protected");

    if (data.encounters === 0) {
      await this.speak(translate("voice.speech.opponentFirstMeeting"), language, "interruptable");
      return;
    }

    const winrate = computeWinratePercent(data.wins, data.losses);
    const style = data.strategyTags.slice(0, TOP_STRATEGY_TAGS).join(", ").trim();
    const notes = data.notes.slice(0, TOP_NOTES).join(". ").trim();
    const styleSpoken = style || translate("voice.speech.opponentNoStyle");

    const tailTemplateKey: TranslationKey = notes
      ? "voice.speech.opponentTailFull"
      : "voice.speech.opponentTailNoNotes";

    const tail = interpolate(translate(tailTemplateKey), {
      encounters: String(data.encounters),
      winrate: String(winrate),
      style: styleSpoken,
      notes
    });
    await this.speak(tail, language, "interruptable");
  }

  async announceMatchSummary(data: MatchSpeechData): Promise<void> {
    const settings = this.deps.getSettings();
    if (!settings.enabled || settings.provider === "off" || !settings.announceMatchSummary) {
      return;
    }
    const language = this.resolveSpeechLanguage();
    const translate = this.deps.getTranslator(language);

    const duration = formatDuration(data.durationSeconds, translate);
    const key: TranslationKey =
      data.result === "win"
        ? "voice.speech.matchVictory"
        : data.result === "loss"
          ? "voice.speech.matchDefeat"
          : "voice.speech.matchUnknown";
    await this.speak(interpolate(translate(key), { duration }), language, "interruptable");
  }

  async announceTestPhrase(_language: AppLanguage, kind: "greeting" | "opponent"): Promise<void> {
    const language: AppLanguage = "en";
    const translate = this.deps.getTranslator(language);
    const key: TranslationKey =
      kind === "greeting" ? "voice.speech.test.greeting" : "voice.speech.test.opponent";
    await this.speak(translate(key), language, "protected");
  }

  /**
   * Plays a test phrase using explicit voice/volume/rate parameters instead
   * of reading from the current settings. Used by the Voice Assistant settings
   * panel to preview an unsaved configuration. Previews are queued as
   * `interruptable` so clicking the same or another preview button (or the
   * Stop button) immediately replaces what is currently playing.
   */
  async previewPhrase(params: {
    readonly language?: AppLanguage;
    readonly voiceId: PiperVoiceId;
    readonly volume: number;
    readonly speakingRate: number;
    readonly kind: "greeting" | "opponent";
  }): Promise<void> {
    // Cancel anything currently in-flight so the new preview starts immediately
    // instead of queueing behind the previous one.
    this.deps.player.preemptInterruptable();

    const language = "en";
    const translate = this.deps.getTranslator(language);
    const key: TranslationKey =
      params.kind === "greeting"
        ? "voice.speech.test.greeting"
        : "voice.speech.test.opponent";
    const text = translate(key);
    if (!text.trim()) {
      return;
    }

    let audio: SynthesizedAudio;
    try {
      audio = await this.deps.tts.synthesize({
        text,
        language,
        voiceId: params.voiceId,
        speakingRate: params.speakingRate
      });
    } catch (error) {
      console.error("[VoiceNarrator] preview synthesize failed:", error);
      return;
    }

    this.deps.player.enqueue(audio, {
      priority: "interruptable",
      volume: params.volume,
      playbackRate: params.speakingRate
    });
  }

  async previewOpponentCard(data: OpponentSpeechData): Promise<void> {
    const settings = this.deps.getSettings();
    if (!settings.enabled || settings.provider === "off") {
      return;
    }
    await this.speakOpponentCard(data);
  }

  stopAll(): void {
    this.deps.player.stopAll();
  }

  private resolveSpeechLanguage(): AppLanguage {
    return "en";
  }

  private resolveVoiceId(_language: AppLanguage): PiperVoiceId {
    const settings = this.deps.getSettings();
    return settings.voiceEn;
  }

  private async speak(text: string, language: AppLanguage, priority: AudioPriority): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }
    const settings = this.deps.getSettings();
    const voiceId = this.resolveVoiceId(language);

    let audio: SynthesizedAudio;
    try {
      audio = await this.deps.tts.synthesize({
        text: trimmed,
        language,
        voiceId,
        speakingRate: settings.speakingRate
      });
    } catch (error) {
      console.error("[VoiceNarrator] synthesize failed:", error);
      return;
    }

    this.deps.player.enqueue(audio, {
      priority,
      volume: settings.volume,
      playbackRate: settings.speakingRate
    });
  }

  /**
   * Some nicknames contain symbols that confuse TTS (barcodes, mixed casing).
   * Light pre-processing: collapse repeats of `I` / `l` / `|` since most
   * barcode names tile those characters at the start. We let the engine read
   * the rest unmodified.
   */
  private spellOutNickname(nickname: string, language: AppLanguage): string {
    return nickname.replace(/([Il|])\1{2,}/g, (match) => {
      const symbol = match[0] === "|"
        ? language === "ru" ? "вертикальная черта" : "vertical bar"
        : match[0];
      return language === "ru" ? `${symbol}, ${match.length} раз` : `${symbol} ${match.length} times`;
    });
  }
}

function computeWinratePercent(wins: number, losses: number): number {
  const total = wins + losses;
  if (total === 0) {
    return 0;
  }
  return Math.round((wins / total) * 100);
}

function formatDuration(seconds: number | undefined, translate: Translator): string {
  if (!seconds || !Number.isFinite(seconds) || seconds <= 0) {
    return translate("voice.speech.duration.unknown");
  }
  const minutes = Math.floor(seconds / 60);
  const remaining = Math.round(seconds % 60);

  if (minutes > 0 && remaining > 0) {
    return interpolate(translate("voice.speech.duration.minutesSeconds"), {
      minutes: String(minutes),
      seconds: String(remaining)
    });
  }
  if (minutes > 0) {
    return interpolate(translate("voice.speech.duration.minutes"), {
      minutes: String(minutes)
    });
  }
  return interpolate(translate("voice.speech.duration.seconds"), {
    seconds: String(remaining)
  });
}

function interpolate(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_match, key: string) => values[key] ?? "");
}
