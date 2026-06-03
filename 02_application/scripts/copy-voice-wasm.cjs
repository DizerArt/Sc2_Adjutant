#!/usr/bin/env node
// Copies onnxruntime-web + piper-wasm runtime files from node_modules into
// resources/voice-wasm/. This lets the renderer fetch them via the
// `voice-model://` protocol instead of pulling them from cdnjs / jsdelivr
// at runtime, which fails for offline users and in environments where
// dynamic external imports are blocked.

"use strict";

const fs = require("node:fs");
const path = require("node:path");

const targetDir = path.resolve(__dirname, "..", "resources", "voice-wasm");
fs.mkdirSync(targetDir, { recursive: true });

const onnxDir = path.resolve(
  __dirname,
  "..",
  "node_modules",
  "onnxruntime-web",
  "dist"
);
const piperDir = path.resolve(
  __dirname,
  "..",
  "node_modules",
  "@diffusionstudio",
  "piper-wasm",
  "build"
);

// Match every ort-wasm-simd-threaded.* file the runtime might request based
// on the host browser's capabilities (jsep, jspi, asyncify, plain).
const onnxPattern = /^ort-wasm-simd-threaded\.(?:[a-z]+\.)?(?:mjs|wasm)$/;

const piperFiles = [
  "piper_phonemize.wasm",
  "piper_phonemize.data",
  "piper_phonemize.js"
];

let copied = 0;
let skipped = 0;

console.log(`Copying voice runtime assets into ${targetDir}`);

copyMany(onnxDir, (entry) => onnxPattern.test(entry));
for (const file of piperFiles) {
  copyOne(path.join(piperDir, file), path.join(targetDir, file));
}

console.log(`\nDone. Copied ${copied}, skipped ${skipped} (already up-to-date).`);

function copyMany(sourceDir, predicate) {
  if (!fs.existsSync(sourceDir)) {
    console.warn(`  WARN: source dir missing: ${sourceDir}`);
    return;
  }
  for (const entry of fs.readdirSync(sourceDir)) {
    if (!predicate(entry)) continue;
    copyOne(path.join(sourceDir, entry), path.join(targetDir, entry));
  }
}

function copyOne(sourcePath, destPath) {
  if (!fs.existsSync(sourcePath)) {
    console.warn(`  WARN: missing source: ${sourcePath}`);
    return;
  }
  const sourceStat = fs.statSync(sourcePath);
  if (fs.existsSync(destPath)) {
    const destStat = fs.statSync(destPath);
    if (destStat.size === sourceStat.size && destStat.mtimeMs >= sourceStat.mtimeMs) {
      skipped += 1;
      return;
    }
  }
  fs.copyFileSync(sourcePath, destPath);
  console.log(`  copied: ${path.basename(destPath)} (${sourceStat.size.toLocaleString()} bytes)`);
  copied += 1;
}
