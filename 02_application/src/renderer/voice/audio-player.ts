import type { SynthesizedAudio } from "../../domain/ports/voice-synthesis-port.js";

/**
 * Priority tag describing whether a queued item can be preempted by a newer
 * incoming utterance. `protected` items (HEAD of opponent card) must finish;
 * `interruptable` items (tail, match summary) get dropped on preemption.
 */
export type AudioPriority = "protected" | "interruptable";

export type EnqueueOptions = {
  readonly priority: AudioPriority;
  readonly volume: number;
  readonly playbackRate: number;
};

type QueueItem = {
  readonly audio: SynthesizedAudio;
  readonly options: EnqueueOptions;
  readonly tag: number;
};

export class VoiceAudioPlayer {
  private readonly audioContext: AudioContext;
  private queue: QueueItem[] = [];
  private currentSource: AudioBufferSourceNode | null = null;
  private currentItem: QueueItem | null = null;
  private playing = false;
  private nextTag = 1;

  constructor(audioContext: AudioContext) {
    this.audioContext = audioContext;
  }

  /**
   * Schedule an audio chunk for playback. Returns the assigned tag so callers
   * can track or pre-empt their own utterances later.
   */
  enqueue(audio: SynthesizedAudio, options: EnqueueOptions): number {
    const tag = this.nextTag++;
    if (audio.samples.length === 0) {
      return tag;
    }
    this.queue.push({ audio, options, tag });
    void this.pump();
    return tag;
  }

  /**
   * Drop every interruptable item from the queue AND from the in-flight source.
   * Protected items (e.g. the nickname/MMR head of an opponent card) are kept.
   */
  preemptInterruptable(): void {
    this.queue = this.queue.filter((item) => item.options.priority === "protected");
    if (this.currentItem && this.currentItem.options.priority === "interruptable") {
      this.stopCurrent();
    }
  }

  /**
   * Flush everything regardless of priority. Used on app shutdown or when the
   * user disables the voice assistant.
   */
  stopAll(): void {
    this.queue = [];
    this.stopCurrent();
  }

  private stopCurrent(): void {
    if (this.currentSource) {
      try {
        this.currentSource.stop();
      } catch {
        // already stopped
      }
      this.currentSource.disconnect();
      this.currentSource = null;
    }
    this.currentItem = null;
    this.playing = false;
  }

  private async pump(): Promise<void> {
    if (this.playing) {
      return;
    }
    const next = this.queue.shift();
    if (!next) {
      return;
    }
    this.playing = true;
    this.currentItem = next;

    if (this.audioContext.state === "suspended") {
      try {
        await this.audioContext.resume();
      } catch {
        // ignore — playback may still succeed once a user gesture wakes it
      }
    }

    const buffer = this.audioContext.createBuffer(
      1,
      next.audio.samples.length,
      next.audio.sampleRate
    );
    buffer.getChannelData(0).set(next.audio.samples);

    const source = this.audioContext.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = clamp(next.options.playbackRate, 0.25, 4);

    const gain = this.audioContext.createGain();
    gain.gain.value = clamp(next.options.volume, 0, 1);

    source.connect(gain).connect(this.audioContext.destination);
    this.currentSource = source;

    source.onended = () => {
      if (this.currentSource === source) {
        source.disconnect();
        gain.disconnect();
        this.currentSource = null;
        this.currentItem = null;
        this.playing = false;
        void this.pump();
      }
    };

    source.start();
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
