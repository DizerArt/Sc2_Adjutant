import { app } from "electron";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type {
  SileroSynthesizeRequest,
  SileroSynthesizeResponse
} from "../../shared/ipc/contracts.js";

const SILERO_MODEL_FILE = "silero-v5_5_ru.pt";
const SILERO_SCRIPT_FILE = "silero_tts.py";
const SILERO_MAX_TEXT_CHARS = 1200;
const SILERO_TIMEOUT_MS = 30000;

const SILERO_VOICE_CONFIG = {
  "ru_RU-silero-xenia": {
    speaker: "xenia",
    sampleRate: 48000
  },
  "ru_RU-silero-baya": {
    speaker: "baya",
    sampleRate: 48000
  }
} as const;

export function isSileroModelAvailable(): boolean {
  return existsSync(resolveVoiceModelPath());
}

export async function synthesizeSilero(
  request: SileroSynthesizeRequest
): Promise<SileroSynthesizeResponse> {
  const config = SILERO_VOICE_CONFIG[request.voiceId];
  if (!config) {
    throw new Error(`Unsupported Silero voice: ${request.voiceId}`);
  }

  const modelPath = resolveVoiceModelPath();
  const scriptPath = resolveSileroScriptPath();
  if (!existsSync(modelPath)) {
    throw new Error(`Silero model is missing: ${modelPath}`);
  }
  if (!existsSync(scriptPath)) {
    throw new Error(`Silero sidecar script is missing: ${scriptPath}`);
  }

  const text = request.text.trim().slice(0, SILERO_MAX_TEXT_CHARS);
  if (!text) {
    return { wavBase64: "" };
  }

  const python = process.env.SC2_ADJUTANT_PYTHON ?? process.env.PYTHON ?? "python";
  const args = [
    scriptPath,
    "--model",
    modelPath,
    "--speaker",
    config.speaker,
    "--sample-rate",
    String(config.sampleRate),
    "--rate",
    String(clamp(request.speakingRate, 0.5, 2))
  ];

  const wav = await runPythonTts(python, args, text);
  return { wavBase64: wav.toString("base64") };
}

function runPythonTts(python: string, args: readonly string[], text: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(python, args, {
      env: {
        ...process.env,
        PYTHONIOENCODING: "utf-8"
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("Silero synthesis timed out."));
    }, SILERO_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
      if (code !== 0) {
        reject(new Error(stderr || `Silero sidecar exited with code ${code ?? "unknown"}.`));
        return;
      }
      resolve(Buffer.concat(stdoutChunks));
    });

    child.stdin.end(text, "utf8");
  });
}

function resolveVoiceModelPath(): string {
  return join(resolveResourceDir("voice-models"), SILERO_MODEL_FILE);
}

function resolveSileroScriptPath(): string {
  return join(resolveResourceDir("silero"), SILERO_SCRIPT_FILE);
}

function resolveResourceDir(subdir: string): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, subdir);
  }

  const candidates = [
    join(process.cwd(), "resources", subdir),
    join(app.getAppPath(), "resources", subdir),
    join(app.getAppPath(), "..", "resources", subdir)
  ];

  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return 1;
  }
  return Math.min(Math.max(value, min), max);
}
