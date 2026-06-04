import type { VoiceId } from "../../domain/entities/voice-settings.js";
import type {
  SynthesizeRequest,
  SynthesizedAudio,
  VoiceRuntimeStatus,
  VoiceSynthesisPort
} from "../../domain/ports/voice-synthesis-port.js";

/**
 * Last-resort fallback that uses the browser's built-in speechSynthesis. The
 * voice fidelity is far worse than Piper but it requires zero installation
 * and works on every Electron/Chromium build, which makes it a useful safety
 * net when ONNX-runtime WASM or bundled models fail to load.
 *
 * The returned audio is a one-sample of silence — the actual speech is fired
 * out-of-band through `speechSynthesis.speak()`. Callers should still enqueue
 * the dummy buffer so the priority/queue semantics in VoiceAudioPlayer keep
 * working, but the audible output comes from the SpeechSynthesis API.
 */
export class WebSpeechFallbackAdapter implements VoiceSynthesisPort {
  private readonly speechSynthesis: SpeechSynthesis;
  private status: VoiceRuntimeStatus = { kind: "ready", loadedVoices: [] };

  constructor(speechSynthesis: SpeechSynthesis = window.speechSynthesis) {
    this.speechSynthesis = speechSynthesis;
  }

  getStatus(): VoiceRuntimeStatus {
    return this.status;
  }

  async warmup(_voiceId: VoiceId): Promise<void> {
    // The Web Speech API doesn't need warmup; system voices are always ready.
  }

  async synthesize(request: SynthesizeRequest): Promise<SynthesizedAudio> {
    // Cancel anything currently in the browser's speech queue so we never
    // accumulate utterances on repeated calls.
    this.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(request.text);
    utterance.lang = request.language === "ru" ? "ru-RU" : "en-US";
    utterance.rate = clamp(request.speakingRate, 0.5, 2);
    const voice = pickSystemVoice(this.speechSynthesis, utterance.lang);
    if (voice) {
      utterance.voice = voice;
    }
    this.speechSynthesis.speak(utterance);
    return { samples: new Float32Array(1), sampleRate: 22050 };
  }
}

function pickSystemVoice(synth: SpeechSynthesis, lang: string): SpeechSynthesisVoice | null {
  const voices = synth.getVoices();
  return voices.find((voice) => voice.lang === lang) ?? voices.find((voice) => voice.lang.startsWith(lang.slice(0, 2))) ?? null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
