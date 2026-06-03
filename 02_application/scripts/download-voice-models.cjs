#!/usr/bin/env node
// Downloads default Piper TTS voice models into resources/voice-models.
// Usage: node scripts/download-voice-models.cjs [--all]
// By default fetches the English voice bundled in the installer (GLaDOS).
// Pass --all to also fetch optional English voices.

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const https = require("node:https");

const HF_BASE = "https://huggingface.co/diffusionstudio/piper-voices/resolve/main";
const GLADOS_RELEASE_BASE = "https://github.com/dnhkng/GLaDOS/releases/download/0.1";
const GLADOS_RAW_BASE = "https://raw.githubusercontent.com/dnhkng/GLaDOS/main";

const DEFAULT_VOICES = [
  {
    id: "en_US-glados",
    onnxUrl: `${GLADOS_RELEASE_BASE}/glados.onnx`,
    jsonUrl: `${GLADOS_RAW_BASE}/models/TTS/glados.json`
  }
];

const OPTIONAL_VOICES = [
  { id: "en_US-amy-medium", path: "en/en_US/amy/medium/en_US-amy-medium.onnx" }
];

const targetDir = path.resolve(__dirname, "..", "resources", "voice-models");
fs.mkdirSync(targetDir, { recursive: true });

const includeOptional = process.argv.includes("--all");
const voices = includeOptional ? [...DEFAULT_VOICES, ...OPTIONAL_VOICES] : DEFAULT_VOICES;

(async () => {
  for (const voice of voices) {
    await downloadVoice(voice);
  }
  console.log(`\nDone. Models live in: ${targetDir}`);
})().catch((error) => {
  console.error("\nFailed:", error);
  process.exit(1);
});

async function downloadVoice(voice) {
  const onnxUrl = voice.onnxUrl ?? `${HF_BASE}/${voice.path}`;
  const jsonUrl = voice.jsonUrl ?? `${onnxUrl}.json`;
  const onnxFile = path.join(targetDir, `${voice.id}.onnx`);
  const jsonFile = path.join(targetDir, `${voice.id}.onnx.json`);

  console.log(`\n[${voice.id}]`);
  await downloadFile(jsonUrl, jsonFile);
  await downloadFile(onnxUrl, onnxFile);
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
      console.log(`  skip (already present): ${path.basename(dest)}`);
      resolve();
      return;
    }
    const tempDest = `${dest}.partial`;
    const out = fs.createWriteStream(tempDest);
    request(url, out, (error) => {
      if (error) {
        fs.unlink(tempDest, () => reject(error));
        return;
      }
      fs.rename(tempDest, dest, (renameError) => {
        if (renameError) {
          reject(renameError);
          return;
        }
        console.log(`  saved: ${path.basename(dest)}`);
        resolve();
      });
    });
  });
}

function request(url, out, done, redirectsLeft = 5) {
  https
    .get(url, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        if (redirectsLeft <= 0) {
          done(new Error(`Too many redirects for ${url}`));
          return;
        }
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        request(next, out, done, redirectsLeft - 1);
        return;
      }
      if (res.statusCode !== 200) {
        done(new Error(`HTTP ${res.statusCode} for ${url}`));
        res.resume();
        return;
      }
      const total = Number.parseInt(res.headers["content-length"] || "0", 10);
      let loaded = 0;
      res.on("data", (chunk) => {
        loaded += chunk.length;
        if (total > 0 && loaded % (1024 * 1024 * 8) < chunk.length) {
          const percent = ((loaded / total) * 100).toFixed(0);
          process.stdout.write(`  downloading ${path.basename(out.path)}: ${percent}%\r`);
        }
      });
      res.pipe(out);
      out.on("finish", () => {
        out.close(done);
      });
      out.on("error", done);
    })
    .on("error", done);
}
