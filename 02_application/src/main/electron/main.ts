import { app, BrowserWindow, ipcMain, Menu, screen } from "electron";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { registerIpcHandlers } from "./ipc-handlers.js";
import { FileAppSettingsRepository } from "../../infrastructure/storage/file-app-settings-repository.js";
import { resolveAppDataDirectory } from "../../infrastructure/storage/app-data-directory.js";
import {
  normalizeOverlayPosition,
  type OverlayPosition
} from "../../domain/entities/app-settings.js";

const rendererDevUrl = process.env.SC2_ASSISTANT_RENDERER_URL ?? "http://127.0.0.1:5173";
const currentDir = fileURLToPath(new URL(".", import.meta.url));
const WINDOW_WIDTH = 1469;
const WINDOW_HEIGHT = 860;
const OVERLAY_WIDTH = 360;
const OVERLAY_HEIGHT = 128;
const OVERLAY_MARGIN = 16;

let mainWindowRef: BrowserWindow | null = null;
let overlayWindowRef: BrowserWindow | null = null;

async function createMainWindow(): Promise<void> {
  const mainWindow = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    minWidth: WINDOW_WIDTH,
    minHeight: WINDOW_HEIGHT,
    maxWidth: WINDOW_WIDTH,
    maxHeight: WINDOW_HEIGHT,
    resizable: false,
    frame: false,
    title: "SC2 Adjutant",
    backgroundColor: "#080b10",
    webPreferences: {
      preload: join(currentDir, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWindowRef = mainWindow;
  attachSmokeLifecycleIfRequested(mainWindow);
  registerWindowControlHandlers(mainWindow);

  mainWindow.on("closed", () => {
    mainWindowRef = null;
    if (overlayWindowRef && !overlayWindowRef.isDestroyed()) {
      overlayWindowRef.close();
    }
    overlayWindowRef = null;
  });

  if (app.isPackaged) {
    await mainWindow.loadFile(join(currentDir, "../../../dist-renderer/index.html"));
  } else {
    await mainWindow.loadURL(rendererDevUrl);
  }
}

function overlaySettingsRepository(): FileAppSettingsRepository {
  const dataDir = resolveAppDataDirectory();
  return new FileAppSettingsRepository(join(dataDir, "settings.json"));
}

async function readOverlaySettings(): Promise<{
  readonly overlayEnabled: boolean;
  readonly overlayPosition: OverlayPosition;
}> {
  const repository = overlaySettingsRepository();
  const settings = await repository.read();
  return {
    overlayEnabled: settings.overlayEnabled,
    overlayPosition: settings.overlayPosition
  };
}

async function persistOverlayEnabled(enabled: boolean): Promise<void> {
  try {
    const repository = overlaySettingsRepository();
    const current = await repository.read();
    if (current.overlayEnabled === enabled) {
      return;
    }
    await repository.save({
      ...current,
      overlayEnabled: enabled,
      updatedAt: new Date().toISOString()
    });
  } catch (error) {
    console.error("Failed to persist overlay setting:", error);
  }
}

async function persistOverlayPosition(position: OverlayPosition): Promise<void> {
  try {
    const repository = overlaySettingsRepository();
    const current = await repository.read();
    if (current.overlayPosition === position) {
      return;
    }
    await repository.save({
      ...current,
      overlayPosition: position,
      updatedAt: new Date().toISOString()
    });
  } catch (error) {
    console.error("Failed to persist overlay position:", error);
  }
}

async function restoreOverlayFromSettings(): Promise<void> {
  try {
    const settings = await readOverlaySettings();
    if (settings.overlayEnabled) {
      await ensureOverlayWindow(settings.overlayPosition);
    }
  } catch (error) {
    console.error("Failed to restore overlay state:", error);
  }
}

const BOTTOM_SLOT_COUNT = 6;

function computeOverlayCoords(
  position: OverlayPosition,
  width: number,
  height: number
): { x: number; y: number } {
  const display = screen.getPrimaryDisplay();
  const { x: baseX, y: baseY, width: areaWidth, height: areaHeight } = display.workArea;

  if (position.startsWith("bottom-")) {
    const slot = Number.parseInt(position.slice("bottom-".length), 10);
    const normalizedSlot = Number.isFinite(slot)
      ? Math.min(Math.max(slot - 1, 0), BOTTOM_SLOT_COUNT - 1)
      : 0;
    const xMin = baseX + OVERLAY_MARGIN;
    const xMax = baseX + areaWidth - width - OVERLAY_MARGIN;
    const span = Math.max(0, xMax - xMin);
    const x = xMin + Math.round(span * (normalizedSlot / (BOTTOM_SLOT_COUNT - 1)));
    const y = baseY + areaHeight - height - OVERLAY_MARGIN;
    return { x, y };
  }

  let x = baseX + OVERLAY_MARGIN;
  let y = baseY + OVERLAY_MARGIN;

  if (position.endsWith("-center")) {
    x = baseX + Math.round((areaWidth - width) / 2);
  } else if (position.endsWith("-right")) {
    x = baseX + areaWidth - width - OVERLAY_MARGIN;
  }

  if (position.startsWith("middle-")) {
    y = baseY + Math.round((areaHeight - height) / 2);
  }

  return { x, y };
}

async function ensureOverlayWindow(positionOverride?: OverlayPosition): Promise<BrowserWindow> {
  const position = positionOverride ?? (await readOverlaySettings()).overlayPosition;

  if (overlayWindowRef && !overlayWindowRef.isDestroyed()) {
    repositionOverlay(overlayWindowRef, position);
    if (!overlayWindowRef.isVisible()) {
      overlayWindowRef.showInactive();
    }
    return overlayWindowRef;
  }

  const { x, y } = computeOverlayCoords(position, OVERLAY_WIDTH, OVERLAY_HEIGHT);

  const overlay = new BrowserWindow({
    width: OVERLAY_WIDTH,
    height: OVERLAY_HEIGHT,
    x,
    y,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    focusable: false,
    hasShadow: false,
    show: false,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: join(currentDir, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });

  // Discord-style: overlay never receives mouse input — every click falls
  // through to whatever is behind it (the SC2 client in fullscreen).
  overlay.setIgnoreMouseEvents(true, { forward: false });
  overlay.setAlwaysOnTop(true, "screen-saver");
  overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  overlay.on("closed", () => {
    overlayWindowRef = null;
  });

  const overlayUrl = app.isPackaged
    ? `file://${join(currentDir, "../../../dist-renderer/overlay.html")}`
    : `${rendererDevUrl}/overlay.html`;

  overlay
    .loadURL(overlayUrl)
    .then(() => {
      overlay.showInactive();
    })
    .catch((error: unknown) => {
      console.error("Failed to load overlay URL:", error);
      if (!overlay.isDestroyed()) {
        overlay.showInactive();
      }
    });

  if (!app.isPackaged) {
    overlay.webContents.openDevTools({ mode: "detach" });
  }

  overlayWindowRef = overlay;
  return overlay;
}

function repositionOverlay(overlay: BrowserWindow, position: OverlayPosition): void {
  if (overlay.isDestroyed()) {
    return;
  }
  const [width, height] = overlay.getSize();
  const { x, y } = computeOverlayCoords(position, width, height);
  overlay.setBounds({ x, y, width, height });
}

function hideOverlay(): void {
  if (!overlayWindowRef || overlayWindowRef.isDestroyed()) {
    return;
  }
  if (overlayWindowRef.isVisible()) {
    overlayWindowRef.hide();
  }
}

function registerWindowControlHandlers(window: BrowserWindow): void {
  ipcMain.removeHandler("window:minimize");
  ipcMain.removeHandler("window:close");
  ipcMain.removeHandler("overlay:show");
  ipcMain.removeHandler("overlay:hide");
  ipcMain.removeHandler("overlay:set-position");
  ipcMain.handle("window:minimize", () => {
    if (!window.isDestroyed()) {
      window.minimize();
    }
  });
  ipcMain.handle("window:close", () => {
    if (!window.isDestroyed()) {
      window.close();
    }
  });
  ipcMain.handle("overlay:show", async () => {
    await persistOverlayEnabled(true);
    await ensureOverlayWindow();
  });
  ipcMain.handle("overlay:hide", async () => {
    hideOverlay();
    await persistOverlayEnabled(false);
  });
  ipcMain.handle("overlay:set-position", async (_event, rawPosition: unknown) => {
    const position = normalizeOverlayPosition(rawPosition);
    await persistOverlayPosition(position);
    if (overlayWindowRef && !overlayWindowRef.isDestroyed()) {
      repositionOverlay(overlayWindowRef, position);
    }
  });
}

function attachSmokeLifecycleIfRequested(mainWindow: BrowserWindow): void {
  const smokeExitMs = Number.parseInt(process.env.SC2_ASSISTANT_SMOKE_EXIT_MS ?? smokeExitArg() ?? "", 10);

  if (!Number.isFinite(smokeExitMs) || smokeExitMs <= 0) {
    return;
  }

  const timeout = setTimeout(() => {
    console.error("SC2 Assistant smoke timed out before renderer load.");
    app.exit(1);
  }, 10_000);

  mainWindow.webContents.once("did-finish-load", () => {
    clearTimeout(timeout);
    console.log("SC2 Assistant smoke window loaded.");
    setTimeout(() => app.quit(), smokeExitMs);
  });

  mainWindow.webContents.once("did-fail-load", (_event, errorCode, errorDescription) => {
    clearTimeout(timeout);
    console.error(`SC2 Assistant smoke renderer failed: ${errorCode} ${errorDescription}`);
    app.exit(1);
  });
}

function smokeExitArg(): string | undefined {
  return process.argv.find((argument) => argument.startsWith("--smoke-exit-ms="))?.split("=")[1];
}

app
  .whenReady()
  .then(async () => {
    await registerIpcHandlers();
    Menu.setApplicationMenu(null);
    await createMainWindow();
    await restoreOverlayFromSettings();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        void createMainWindow();
      }
    });
  })
  .catch((error: unknown) => {
    console.error(error);
    app.quit();
  });

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
