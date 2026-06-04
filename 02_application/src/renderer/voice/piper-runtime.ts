import { PATH_MAP, TtsSession } from "@mintplex-labs/piper-tts-web";
import type { PiperVoiceId, VoiceId } from "../../domain/entities/voice-settings.js";
import type {
  SynthesizeRequest,
  SynthesizedAudio,
  VoiceRuntimeStatus,
  VoiceSynthesisPort
} from "../../domain/ports/voice-synthesis-port.js";

const VOICE_MODEL_BASE = "voice-model://local";
const VOICE_WASM_BASE = "voice-model://wasm";
const OPFS_PIPER_DIR = "piper";

// Override the library's default CDN URLs to local resources. Without these,
// the renderer attempts to fetch onnxruntime-web WASM from cdnjs and the
// piper-phonemize binaries from jsdelivr at runtime — those fail in any
// offline environment and also when dynamic external imports are blocked.
const LOCAL_WASM_PATHS = {
  onnxWasm: `${VOICE_WASM_BASE}/`,
  piperData: `${VOICE_WASM_BASE}/piper_phonemize.data`,
  piperWasm: `${VOICE_WASM_BASE}/piper_phonemize.wasm`
};

type Logger = (message: string) => void;

type PiperRuntimeOptions = {
  readonly logger?: Logger;
};

// The library exports a `TtsSession` class that internally uses a singleton.
// We sidestep the singleton by clearing it before constructing each new
// session, then keep our own cache keyed by voiceId.
type SingletonGuard = { _instance: TtsSession | null };

type StatusListener = (status: VoiceRuntimeStatus) => void;

export class PiperRuntime implements VoiceSynthesisPort {
  private readonly sessions = new Map<PiperVoiceId, TtsSession>();
  private readonly audioContext: AudioContext;
  private status: VoiceRuntimeStatus = { kind: "idle" };
  private inflightWarmup: Map<PiperVoiceId, Promise<void>> = new Map();
  private readonly statusListeners = new Set<StatusListener>();

  constructor(audioContext: AudioContext, private readonly options: PiperRuntimeOptions = {}) {
    this.audioContext = audioContext;
  }

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

  private setStatus(status: VoiceRuntimeStatus): void {
    this.status = status;
    for (const listener of this.statusListeners) {
      listener(status);
    }
  }

  async warmup(voiceId: VoiceId): Promise<void> {
    if (!isPiperVoiceId(voiceId)) {
      throw new Error(`Piper runtime cannot load voice: ${voiceId}`);
    }
    if (this.sessions.has(voiceId)) {
      return;
    }
    const inflight = this.inflightWarmup.get(voiceId);
    if (inflight) {
      await inflight;
      return;
    }
    const task = this.loadSession(voiceId);
    this.inflightWarmup.set(voiceId, task);
    try {
      await task;
    } finally {
      this.inflightWarmup.delete(voiceId);
    }
  }

  async synthesize(request: SynthesizeRequest): Promise<SynthesizedAudio> {
    if (!isPiperVoiceId(request.voiceId)) {
      throw new Error(`Piper runtime cannot synthesize voice: ${request.voiceId}`);
    }
    await this.warmup(request.voiceId);
    const session = this.sessions.get(request.voiceId);
    if (!session) {
      throw new Error(`Voice not available: ${request.voiceId}`);
    }
    const text = request.text.trim();
    if (!text) {
      return { samples: new Float32Array(), sampleRate: this.audioContext.sampleRate };
    }
    const wavBlob = await session.predict(text);
    return decodeWavBlob(wavBlob, this.audioContext);
  }

  private async loadSession(voiceId: PiperVoiceId): Promise<void> {
    this.setStatus({ kind: "loading", voiceId });
    try {
      await ensureOpfsModel(voiceId, this.options.logger);
      registerLocalVoicePath(voiceId);
      // Clear singleton so the library actually creates a fresh, fully-initialised
      // session for this voice instead of recycling a previously-loaded one.
      (TtsSession as unknown as SingletonGuard)._instance = null;
      const session = await TtsSession.create({
        voiceId,
        logger: this.options.logger,
        wasmPaths: LOCAL_WASM_PATHS
      });
      this.sessions.set(voiceId, session);
      this.setStatus({
        kind: "ready",
        loadedVoices: [...this.sessions.keys()]
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.setStatus({ kind: "error", message });
      throw error;
    }
  }
}

export function registerLocalVoicePath(voiceId: PiperVoiceId): void {
  PATH_MAP[voiceId] ??= `${voiceId}.onnx`;
}

function isPiperVoiceId(voiceId: VoiceId): voiceId is PiperVoiceId {
  return voiceId.startsWith("en_");
}

/**
 * Pre-populate the library's OPFS cache from the bundled `voice-model://`
 * resources so the underlying TtsSession finds the model locally without ever
 * touching the network.
 */
async function ensureOpfsModel(voiceId: PiperVoiceId, logger?: Logger): Promise<void> {
  const navigatorStorage = navigator.storage as { getDirectory?: () => Promise<FileSystemDirectoryHandle> };
  if (typeof navigatorStorage.getDirectory !== "function") {
    throw new Error("OPFS is unavailable in this environment");
  }
  const root = await navigatorStorage.getDirectory();
  const dir = await root.getDirectoryHandle(OPFS_PIPER_DIR, { create: true });

  for (const filename of [`${voiceId}.onnx`, `${voiceId}.onnx.json`]) {
    const cached = await readExistingFile(dir, filename);
    if (cached && cached.size > 0) {
      logger?.(`Voice file already cached in OPFS: ${filename} (${cached.size} bytes)`);
      continue;
    }
    const url = `${VOICE_MODEL_BASE}/${filename}`;
    logger?.(`Fetching bundled voice file: ${url}`);
    let bundled: Response;
    try {
      bundled = await fetch(url);
    } catch (fetchError) {
      throw new Error(
        `Failed to fetch bundled voice file from ${url}: ${fetchError instanceof Error ? fetchError.message : String(fetchError)}`
      );
    }
    if (!bundled.ok) {
      throw new Error(
        `Bundled voice file ${filename} returned HTTP ${bundled.status} from ${url}. ` +
          `Make sure the model is downloaded into resources/voice-models/ ` +
          `(run 'npm run voice:download').`
      );
    }
    const data = await bundled.arrayBuffer();
    logger?.(`Writing ${data.byteLength} bytes to OPFS: ${filename}`);
    const handle = await dir.getFileHandle(filename, { create: true });
    const writable = await handle.createWritable();
    await writable.write(data);
    await writable.close();
  }
}

async function readExistingFile(
  dir: FileSystemDirectoryHandle,
  name: string
): Promise<File | null> {
  try {
    const handle = await dir.getFileHandle(name);
    return await handle.getFile();
  } catch {
    return null;
  }
}

async function decodeWavBlob(blob: Blob, ctx: AudioContext): Promise<SynthesizedAudio> {
  const buffer = await blob.arrayBuffer();
  const audioBuffer = await ctx.decodeAudioData(buffer);
  return {
    samples: audioBuffer.getChannelData(0).slice(),
    sampleRate: audioBuffer.sampleRate
  };
}
