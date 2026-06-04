import { app, BrowserWindow, ipcMain, Menu, screen, shell } from "electron";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { registerIpcHandlers } from "./ipc-handlers.js";
import { FileAppSettingsRepository } from "../../infrastructure/storage/file-app-settings-repository.js";
import { resolveAppDataDirectory } from "../../infrastructure/storage/app-data-directory.js";
import {
  normalizeOverlayCustomPosition,
  normalizeOverlayPosition,
  type OverlayCustomPosition,
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
let overlayMoveSaveTimer: ReturnType<typeof setTimeout> | null = null;
let overlayPlacementModeActive = false;

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
  registerExternalNavigation(mainWindow);
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
  readonly overlayPlacementMode: boolean;
  readonly overlayCustomPosition?: OverlayCustomPosition;
}> {
  const repository = overlaySettingsRepository();
  const settings = await repository.read();
  return {
    overlayEnabled: settings.overlayEnabled,
    overlayPosition: settings.overlayPosition,
    overlayPlacementMode: settings.overlayPlacementMode,
    overlayCustomPosition: settings.overlayCustomPosition
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
    if (current.overlayPosition === position && !current.overlayCustomPosition) {
      return;
    }
    await repository.save({
      ...current,
      overlayPosition: position,
      overlayCustomPosition: undefined,
      updatedAt: new Date().toISOString()
    });
  } catch (error) {
    console.error("Failed to persist overlay position:", error);
  }
}

async function persistOverlayPlacementMode(enabled: boolean): Promise<void> {
  try {
    const repository = overlaySettingsRepository();
    const current = await repository.read();
    if (current.overlayPlacementMode === enabled) {
      return;
    }
    await repository.save({
      ...current,
      overlayPlacementMode: enabled,
      updatedAt: new Date().toISOString()
    });
  } catch (error) {
    console.error("Failed to persist overlay placement mode:", error);
  }
}

async function persistOverlayCustomPosition(position: OverlayCustomPosition): Promise<void> {
  try {
    const repository = overlaySettingsRepository();
    const current = await repository.read();
    const normalized = normalizeOverlayCustomPosition(position);
    if (!normalized) {
      return;
    }
    if (
      current.overlayCustomPosition?.x === normalized.x &&
      current.overlayCustomPosition?.y === normalized.y
    ) {
      return;
    }
    await repository.save({
      ...current,
      overlayCustomPosition: normalized,
      updatedAt: new Date().toISOString()
    });
  } catch (error) {
    console.error("Failed to persist overlay custom position:", error);
  }
}

async function restoreOverlayFromSettings(): Promise<void> {
  try {
    const settings = await readOverlaySettings();
    if (settings.overlayEnabled) {
      await ensureOverlayWindow();
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

function clampOverlayCoords(
  position: OverlayCustomPosition,
  width: number,
  height: number
): OverlayCustomPosition {
  const display = screen.getDisplayNearestPoint({ x: position.x, y: position.y });
  const { x: baseX, y: baseY, width: areaWidth, height: areaHeight } = display.workArea;
  const minX = baseX;
  const minY = baseY;
  const maxX = Math.max(minX, baseX + areaWidth - width);
  const maxY = Math.max(minY, baseY + areaHeight - height);

  return {
    x: Math.min(Math.max(position.x, minX), maxX),
    y: Math.min(Math.max(position.y, minY), maxY)
  };
}

function overlayInitialCoords(
  settings: Awaited<ReturnType<typeof readOverlaySettings>>,
  width: number,
  height: number
): OverlayCustomPosition {
  if (settings.overlayCustomPosition) {
    return clampOverlayCoords(settings.overlayCustomPosition, width, height);
  }
  return computeOverlayCoords(settings.overlayPosition, width, height);
}

async function ensureOverlayWindow(positionOverride?: OverlayPosition): Promise<BrowserWindow> {
  const settings = await readOverlaySettings();
  const position = positionOverride ?? settings.overlayPosition;
  const placementMode = settings.overlayPlacementMode;

  if (overlayWindowRef && !overlayWindowRef.isDestroyed()) {
    if (positionOverride) {
      repositionOverlay(overlayWindowRef, position);
    }
    applyOverlayPlacementMode(overlayWindowRef, placementMode);
    if (!overlayWindowRef.isVisible()) {
      overlayWindowRef.showInactive();
    }
    return overlayWindowRef;
  }

  const { x, y } = positionOverride
    ? computeOverlayCoords(position, OVERLAY_WIDTH, OVERLAY_HEIGHT)
    : overlayInitialCoords(settings, OVERLAY_WIDTH, OVERLAY_HEIGHT);

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
    movable: true,
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
  registerExternalNavigation(overlay);

  // Placement mode makes the card draggable; fixed mode lets clicks reach SC2.
  applyOverlayPlacementMode(overlay, placementMode);
  overlay.setAlwaysOnTop(true, "screen-saver");
  overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  overlay.on("move", () => {
    scheduleOverlayPositionSave(overlay);
  });

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

function applyOverlayPlacementMode(overlay: BrowserWindow, enabled: boolean): void {
  if (overlay.isDestroyed()) {
    return;
  }
  overlayPlacementModeActive = enabled;
  overlay.setFocusable(enabled);
  overlay.setIgnoreMouseEvents(!enabled, { forward: false });
}

function scheduleOverlayPositionSave(overlay: BrowserWindow): void {
  if (!overlayPlacementModeActive || overlay.isDestroyed()) {
    return;
  }
  if (overlayMoveSaveTimer) {
    clearTimeout(overlayMoveSaveTimer);
  }
  overlayMoveSaveTimer = setTimeout(() => {
    if (overlay.isDestroyed()) {
      return;
    }
    const [x, y] = overlay.getPosition();
    void persistOverlayCustomPosition({ x, y });
  }, 250);
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

type WindowBounds = { x: number; y: number; width: number; height: number };

function isEnterCompactRequest(
  value: unknown
): value is { compact: true; offsetX: number; offsetY: number; width: number; height: number } {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const request = value as Record<string, unknown>;
  return (
    request.compact === true &&
    typeof request.offsetX === "number" &&
    typeof request.offsetY === "number" &&
    typeof request.width === "number" &&
    typeof request.height === "number"
  );
}

function registerWindowControlHandlers(window: BrowserWindow): void {
  ipcMain.removeHandler("window:minimize");
  ipcMain.removeHandler("window:close");
  ipcMain.removeHandler("window:set-compact");
  ipcMain.removeHandler("overlay:show");
  ipcMain.removeHandler("overlay:hide");
  ipcMain.removeHandler("overlay:set-position");
  ipcMain.removeHandler("overlay:set-placement-mode");

  // Bounds captured before entering compact mode, restored on exit.
  let compactRestoreBounds: WindowBounds | null = null;

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
  ipcMain.handle("window:set-compact", (_event, request: unknown) => {
    if (window.isDestroyed()) {
      return;
    }

    if (isEnterCompactRequest(request)) {
      // Shrink the window to exactly the information block and shift it so the
      // block keeps its on-screen position — the chrome appears to melt away.
      const width = Math.max(320, Math.round(request.width));
      const height = Math.max(200, Math.round(request.height));
      const current = window.getBounds();
      compactRestoreBounds = {
        x: current.x,
        y: current.y,
        width: current.width,
        height: current.height
      };
      // The window is created non-resizable with a locked min/max size, and
      // Windows ignores programmatic resizes on a non-resizable window — so
      // re-enable resizing, relax min before max so the shrink is not clamped,
      // apply the compact bounds, then lock the window down again.
      window.setResizable(true);
      window.setMinimumSize(width, height);
      window.setMaximumSize(width, height);
      window.setBounds({
        x: Math.round(current.x + request.offsetX),
        y: Math.round(current.y + request.offsetY),
        width,
        height
      });
      window.setResizable(false);
      return;
    }

    // Exit compact mode: raise max before min, then restore the full window.
    window.setResizable(true);
    window.setMaximumSize(WINDOW_WIDTH, WINDOW_HEIGHT);
    window.setMinimumSize(WINDOW_WIDTH, WINDOW_HEIGHT);
    if (compactRestoreBounds) {
      window.setBounds(compactRestoreBounds);
    } else {
      window.setSize(WINDOW_WIDTH, WINDOW_HEIGHT);
    }
    window.setResizable(false);
    compactRestoreBounds = null;
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
  ipcMain.handle("overlay:set-placement-mode", async (_event, rawEnabled: unknown) => {
    const enabled = rawEnabled === true;
    await persistOverlayPlacementMode(enabled);
    if (enabled) {
      const overlay = await ensureOverlayWindow();
      applyOverlayPlacementMode(overlay, true);
      if (!overlay.isVisible()) {
        overlay.showInactive();
      }
      return;
    }
    if (overlayWindowRef && !overlayWindowRef.isDestroyed()) {
      applyOverlayPlacementMode(overlayWindowRef, false);
    }
  });
}

function registerExternalNavigation(window: BrowserWindow): void {
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalUrl(url)) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });

  window.webContents.on("will-navigate", (event, url) => {
    if (!isExternalUrl(url)) {
      return;
    }
    event.preventDefault();
    void shell.openExternal(url);
  });
}

function isExternalUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
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
