import type { VoiceId } from "../entities/voice-settings.js";

export type SynthesizeRequest = {
  readonly text: string;
  readonly language: "ru" | "en";
  readonly voiceId: VoiceId;
  readonly speakingRate: number;
};

export type SynthesizedAudio = {
  readonly samples: Float32Array;
  readonly sampleRate: number;
};

export type VoiceRuntimeStatus =
  | { readonly kind: "idle" }
  | { readonly kind: "loading"; readonly voiceId: VoiceId }
  | { readonly kind: "ready"; readonly loadedVoices: readonly VoiceId[] }
  | { readonly kind: "error"; readonly message: string };

export interface VoiceSynthesisPort {
  getStatus(): VoiceRuntimeStatus;
  warmup(voiceId: VoiceId): Promise<void>;
  synthesize(request: SynthesizeRequest): Promise<SynthesizedAudio>;
}
