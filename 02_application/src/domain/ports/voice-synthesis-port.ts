import type { PiperVoiceId } from "../entities/voice-settings.js";

export type SynthesizeRequest = {
  readonly text: string;
  readonly language: "ru" | "en";
  readonly voiceId: PiperVoiceId;
  readonly speakingRate: number;
};

export type SynthesizedAudio = {
  readonly samples: Float32Array;
  readonly sampleRate: number;
};

export type VoiceRuntimeStatus =
  | { readonly kind: "idle" }
  | { readonly kind: "loading"; readonly voiceId: PiperVoiceId }
  | { readonly kind: "ready"; readonly loadedVoices: readonly PiperVoiceId[] }
  | { readonly kind: "error"; readonly message: string };

export interface VoiceSynthesisPort {
  getStatus(): VoiceRuntimeStatus;
  warmup(voiceId: PiperVoiceId): Promise<void>;
  synthesize(request: SynthesizeRequest): Promise<SynthesizedAudio>;
}
