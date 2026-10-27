/** One bounded JSON request per owned process. stdout is reserved for the response. */
import { executeCompatibility, type CompatibilityPayload } from "./engine.js";
import { stat } from "node:fs/promises";
import { extname } from "node:path";

const MAX_REQUEST = 16 * 1024 * 1024;
const MAX_RESPONSE = 16 * 1024 * 1024;
console.log = (...args: unknown[]) => console.error(...args);

async function main(): Promise<void> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const data = Buffer.from(chunk);
    size += data.length;
    if (size > MAX_REQUEST) throw new Error("Compatibility request exceeds 16 MiB.");
    chunks.push(data);
  }
  const request = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { command: unknown; payload: CompatibilityPayload };
  if (typeof request.command !== "string" || !request.payload || typeof request.payload !== "object") throw new Error("Invalid compatibility request.");
  if (request.command === "metadata" || request.command === "analysis" || request.command === "postMatchFacts") {
    const path = request.payload.file?.path ?? request.payload.replayPath;
    if (typeof path !== "string" || extname(path).toLowerCase() !== ".sc2replay") throw new Error("Choose a .SC2Replay file.");
    const info = await stat(path);
    if (!info.isFile() || info.size === 0 || info.size > 64 * 1024 * 1024) throw new Error("Replay exceeds supported size.");
  }
  const result = await executeCompatibility(request.command, request.payload);
  const output = JSON.stringify({ ok: true, result });
  if (Buffer.byteLength(output) > MAX_RESPONSE) throw new Error("Compatibility response exceeds 16 MiB.");
  process.stdout.write(output);
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Compatibility worker failed.";
  process.stdout.write(JSON.stringify({ ok: false, error: message.slice(0, 2048) }));
  process.exitCode = 1;
});
