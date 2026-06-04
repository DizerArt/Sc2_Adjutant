import { app, protocol } from "electron";
import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { join, normalize } from "node:path";
import { Readable } from "node:stream";
import { SILERO_RU_VOICE_IDS } from "../../domain/entities/voice-settings.js";

export const VOICE_MODEL_SCHEME = "voice-model";

/**
 * Register the privileged characteristics of the `voice-model://` scheme.
 * Must be called BEFORE `app.whenReady()`.
 *
 * `corsEnabled: true` is critical — without it, Chromium blocks cross-origin
 * fetches from the renderer (running at http://127.0.0.1:5173 in dev or
 * file:// in prod) to our custom scheme, surfacing as a generic
 * "Failed to fetch" TypeError in the renderer.
 */
export function registerVoiceModelSchemePrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: VOICE_MODEL_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        bypassCSP: true,
        corsEnabled: true,
        stream: true
      }
    }
  ]);
}

/**
 * Resolve a resource directory under the voice-model:// scheme.
 *
 * `host` selects which subfolder to serve:
 *   - "local"  → bundled voice ONNX models
 *   - "wasm"   → onnxruntime-web + piper_phonemize WASM/data/.mjs files
 *
 * In dev mode Electron's `app.getAppPath()` returns the directory of the
 * launching script (e.g. `02_application/scripts/`) rather than the project
 * root, so we try several candidates and pick the first that exists. The
 * cached result is keyed per host and reused for subsequent calls.
 */
const cachedRoots = new Map<string, string>();

function resolveResourceDir(subdir: string): string {
  const cached = cachedRoots.get(subdir);
  if (cached && existsSync(cached)) {
    return cached;
  }

  if (app.isPackaged) {
    const packagedPath = join(process.resourcesPath, subdir);
    cachedRoots.set(subdir, packagedPath);
    return packagedPath;
  }

  const candidates = [
    join(process.cwd(), "resources", subdir),
    join(app.getAppPath(), "resources", subdir),
    join(app.getAppPath(), "..", "resources", subdir)
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      cachedRoots.set(subdir, candidate);
      return candidate;
    }
  }

  cachedRoots.set(subdir, candidates[0]);
  return candidates[0];
}

function resolveVoiceModelsRoot(): string {
  return resolveResourceDir("voice-models");
}

function resolveHostRoot(host: string): string | null {
  if (host === "local" || host === "models") {
    return resolveResourceDir("voice-models");
  }
  if (host === "wasm") {
    return resolveResourceDir("voice-wasm");
  }
  return null;
}

/**
 * List voice IDs whose `.onnx` + `.onnx.json` pair exists on disk.
 */
export function listAvailableVoiceIds(): readonly string[] {
  const root = resolveVoiceModelsRoot();
  if (!existsSync(root)) {
    return [];
  }
  let entries: readonly string[] = [];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  const onnxFiles = new Set(entries.filter((name) => name.endsWith(".onnx")));
  const configFiles = new Set(entries.filter((name) => name.endsWith(".onnx.json")));
  const piperVoices = [...onnxFiles]
    .map((name) => name.replace(/\.onnx$/, ""))
    .filter((voiceId) => configFiles.has(`${voiceId}.onnx.json`))
    .sort();
  const sileroVoices = existsSync(join(root, "silero-v5_5_ru.pt")) ? [...SILERO_RU_VOICE_IDS] : [];
  return [...piperVoices, ...sileroVoices].sort();
}

/**
 * Wire `voice-model://local/<filename>` to the bundled models directory.
 *
 * Streams files via `fs.createReadStream` instead of buffering the whole
 * voice model in memory. Large single allocations can be rejected by Chromium
 * with a generic "Failed to fetch".
 * CORS headers are explicit because the request originates from
 * `http://127.0.0.1:5173` (dev) or the renderer's `file://` (prod) which is
 * a different origin from `voice-model://`.
 */
export function registerVoiceModelProtocol(): void {
  console.log(`[voice-model] models root: ${resolveResourceDir("voice-models")}`);
  console.log(`[voice-model] wasm root:   ${resolveResourceDir("voice-wasm")}`);

  protocol.handle(VOICE_MODEL_SCHEME, async (request) => {
    try {
      const url = new URL(request.url);
      const root = resolveHostRoot(url.hostname);
      if (!root) {
        console.warn(`[voice-model] unknown host: ${url.hostname}`);
        return new Response(null, { status: 404, statusText: "Not Found" });
      }
      const requested = decodeURIComponent(url.pathname).replace(/^\/+/, "");
      const safe = normalize(requested).replace(/^([./\\])+/, "");
      const filePath = join(root, safe);

      console.log(`[voice-model] request ${request.url} -> ${filePath}`);

      if (!filePath.startsWith(root)) {
        console.warn(`[voice-model] rejected traversal: ${request.url}`);
        return new Response(null, { status: 403, statusText: "Forbidden" });
      }
      if (!existsSync(filePath)) {
        console.warn(`[voice-model] not found: ${filePath}`);
        return new Response(null, { status: 404, statusText: "Not Found" });
      }

      const stat = statSync(filePath);
      const contentType = resolveContentType(filePath);

      const nodeStream = createReadStream(filePath);
      nodeStream.on("error", (streamError) => {
        console.error(`[voice-model] stream error for ${filePath}:`, streamError);
      });
      const webStream = Readable.toWeb(nodeStream) as unknown as ReadableStream;

      return new Response(webStream, {
        status: 200,
        headers: {
          "Content-Type": contentType,
          "Content-Length": String(stat.size),
          "Cache-Control": "public, max-age=31536000, immutable",
          "Access-Control-Allow-Origin": "*"
        }
      });
    } catch (error) {
      console.error(`[voice-model] handler error for ${request.url}:`, error);
      return new Response(null, { status: 500, statusText: "Server Error" });
    }
  });
}

function resolveContentType(filePath: string): string {
  if (filePath.endsWith(".json")) return "application/json";
  if (filePath.endsWith(".mjs") || filePath.endsWith(".js")) {
    return "application/javascript";
  }
  if (filePath.endsWith(".wasm")) return "application/wasm";
  return "application/octet-stream";
}
