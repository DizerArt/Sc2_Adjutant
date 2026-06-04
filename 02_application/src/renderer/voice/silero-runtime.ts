import type { SileroRuVoiceId, VoiceId } from "../../domain/entities/voice-settings.js";
import type {
  SynthesizeRequest,
  SynthesizedAudio,
  VoiceRuntimeStatus,
  VoiceSynthesisPort
} from "../../domain/ports/voice-synthesis-port.js";

type StatusListener = (status: VoiceRuntimeStatus) => void;

export class SileroRuntime implements VoiceSynthesisPort {
  private status: VoiceRuntimeStatus = { kind: "idle" };
  private readonly statusListeners = new Set<StatusListener>();

  constructor(private readonly audioContext: AudioContext) {}

  getStatus(): VoiceRuntimeStatus {
    return this.status;
  }

  onStatusChange(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    listener(this.status);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  async warmup(voiceId: VoiceId): Promise<void> {
    if (!isSileroRuVoiceId(voiceId)) {
      throw new Error(`Silero runtime cannot load voice: ${voiceId}`);
    }
    const bridge = window.sc2Assistant;
    if (!bridge?.synthesizeSilero) {
      this.setStatus({ kind: "error", message: "Silero IPC bridge is unavailable." });
      return;
    }
    this.setStatus({ kind: "ready", loadedVoices: [voiceId] });
  }

  async synthesize(request: SynthesizeRequest): Promise<SynthesizedAudio> {
    if (!isSileroRuVoiceId(request.voiceId)) {
      throw new Error(`Silero runtime cannot synthesize voice: ${request.voiceId}`);
    }
    await this.warmup(request.voiceId);
    const text = request.text.trim();
    if (!text) {
      return { samples: new Float32Array(), sampleRate: this.audioContext.sampleRate };
    }

    try {
      this.setStatus({ kind: "loading", voiceId: request.voiceId });
      const bridge = window.sc2Assistant;
      if (!bridge?.synthesizeSilero) {
        throw new Error("Silero IPC bridge is unavailable.");
      }
      const response = await bridge.synthesizeSilero({
        text,
        voiceId: request.voiceId,
        speakingRate: request.speakingRate
      });
      this.setStatus({ kind: "ready", loadedVoices: [request.voiceId] });
      if (!response.wavBase64) {
        return { samples: new Float32Array(), sampleRate: this.audioContext.sampleRate };
      }
      return decodeBase64Wav(response.wavBase64, this.audioContext);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.setStatus({ kind: "error", message });
      throw error;
    }
  }

  private setStatus(status: VoiceRuntimeStatus): void {
    this.status = status;
    for (const listener of this.statusListeners) {
      listener(status);
    }
  }
}

function isSileroRuVoiceId(voiceId: VoiceId): voiceId is SileroRuVoiceId {
  return voiceId === "ru_RU-silero-xenia" || voiceId === "ru_RU-silero-baya";
}

async function decodeBase64Wav(base64: string, ctx: AudioContext): Promise<SynthesizedAudio> {
  const bytes = base64ToBytes(base64);
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  const audioBuffer = await ctx.decodeAudioData(buffer);
  return {
    samples: audioBuffer.getChannelData(0).slice(),
    sampleRate: audioBuffer.sampleRate
  };
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = window.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
