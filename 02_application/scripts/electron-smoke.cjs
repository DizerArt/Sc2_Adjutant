const { spawn } = require("node:child_process");
const { mkdtempSync, rmSync } = require("node:fs");
const http = require("node:http");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");

const appDir = resolve(__dirname, "..");
const isWindows = process.platform === "win32";
const dataDir = mkdtempSync(join(tmpdir(), "sc2-assistant-smoke-"));
const rendererUrl = "http://127.0.0.1:5173";
const timeoutMs = 30_000;

let rendererProcess;
let electronProcess;
let finished = false;

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  cleanup();
  process.exitCode = 1;
});

async function main() {
  rendererProcess = spawn(process.execPath, [
    join(appDir, "node_modules", "vite", "bin", "vite.js"),
    "--host",
    "127.0.0.1",
    "--port",
    "5173",
    "--strictPort"
  ], {
    cwd: appDir,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"]
  });

  pipeOutput(rendererProcess, "smoke:renderer");
  rejectEarlyExit(rendererProcess, "renderer");
  await waitForUrl(rendererUrl, timeoutMs);

  electronProcess = spawn(electronExecutable(), ["scripts/electron-dev.cjs", "--smoke-exit-ms=500"], {
    cwd: appDir,
    env: {
      ...process.env,
      SC2_ASSISTANT_DATA_DIR: dataDir,
      SC2_ASSISTANT_RENDERER_URL: rendererUrl,
      SC2_ASSISTANT_SMOKE_EXIT_MS: "500"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  pipeOutput(electronProcess, "smoke:electron");
  const exitCode = await waitForExit(electronProcess, timeoutMs);

  if (exitCode !== 0) {
    throw new Error(`Electron smoke exited with code ${exitCode}.`);
  }

  finished = true;
  cleanup();
  console.log("Electron smoke passed.");
}

function rejectEarlyExit(childProcess, name) {
  childProcess.once("exit", (code) => {
    if (!finished && code !== null && code !== 0) {
      console.error(`${name} process exited early with code ${code}.`);
    }
  });
}

function waitForUrl(url, timeout) {
  const deadline = Date.now() + timeout;

  return new Promise((resolvePromise, rejectPromise) => {
    const poll = async () => {
      try {
        await requestUrl(url, 1000);
        resolvePromise();
      } catch {
        if (Date.now() >= deadline) {
          rejectPromise(new Error(`Timed out waiting for ${url}.`));
          return;
        }

        setTimeout(() => void poll(), 250);
      }
    };

    void poll();
  });
}

function requestUrl(url, timeout) {
  return new Promise((resolvePromise, rejectPromise) => {
    const request = http.get(url, (response) => {
      response.resume();
      resolvePromise();
    });

    const timer = setTimeout(() => {
      request.destroy(new Error("Request timed out."));
    }, timeout);

    request.on("error", rejectPromise);
    request.on("close", () => clearTimeout(timer));
  });
}

function waitForExit(childProcess, timeout) {
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      rejectPromise(new Error("Timed out waiting for Electron smoke exit."));
    }, timeout);

    childProcess.once("exit", (code) => {
      clearTimeout(timer);
      resolvePromise(code);
    });
  });
}

function pipeOutput(childProcess, prefix) {
  childProcess.stdout.on("data", (chunk) => process.stdout.write(`[${prefix}] ${chunk}`));
  childProcess.stderr.on("data", (chunk) => process.stderr.write(`[${prefix}] ${chunk}`));
}

function cleanup() {
  killProcess(electronProcess);
  killProcess(rendererProcess);
  rmSync(dataDir, { recursive: true, force: true });
}

function killProcess(childProcess) {
  if (!childProcess || childProcess.killed) {
    return;
  }

  childProcess.kill();
}

function electronExecutable() {
  return isWindows
    ? join(appDir, "node_modules", "electron", "dist", "electron.exe")
    : join(appDir, "node_modules", "electron", "dist", "electron");
}
