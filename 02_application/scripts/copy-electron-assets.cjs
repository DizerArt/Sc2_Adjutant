const { copyFileSync, mkdirSync } = require("node:fs");
const { join, resolve } = require("node:path");

const appDir = resolve(__dirname, "..");
const sourcePreload = join(appDir, "src", "main", "electron", "preload.cjs");
const targetDir = join(appDir, "dist-electron", "main", "electron");
const targetPreload = join(targetDir, "preload.cjs");

mkdirSync(targetDir, { recursive: true });
copyFileSync(sourcePreload, targetPreload);
