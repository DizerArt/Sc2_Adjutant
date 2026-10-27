import type { Sc2AssistantBridge } from "../../shared/ipc/contracts.js";
import { installDragRegions } from "./drag-regions.js";
import { installExternalLinks } from "./external-links.js";

export type DesktopTransport = {
  invoke<T>(command: string, payload: unknown): Promise<T>;
  listen<T>(event: string, listener: (payload: T) => void): Promise<() => void>;
  reportSubscriptionError?: (event: string, error: unknown) => void;
};

/** Keep asynchronous native registration safe when React disposes an effect first. */
function subscribe<T>(
  transport: DesktopTransport,
  event: string,
  listener: (payload: T) => void
): () => void {
  let disposed = false;
  let unlisten: (() => void) | undefined;
  void transport.listen<T>(event, (payload) => {
    if (!disposed) listener(payload);
  }).then((release) => {
    if (disposed) release();
    else unlisten = release;
  }).catch((error: unknown) => {
    if (!disposed) transport.reportSubscriptionError?.(event, error);
  });
  return () => {
    if (disposed) return;
    disposed = true;
    unlisten?.();
    unlisten = undefined;
  };
}

/** Preserve the incumbent renderer contract while moving its host to Rust. */
export function createTauriBridge(transport: DesktopTransport): Sc2AssistantBridge {
  const call = <T>(command: string, payload: unknown = null): Promise<T> =>
    transport.invoke<T>(command, payload);
  const bridge: Sc2AssistantBridge = {
    version: "0.1.0",
    getAppVersion: () => call("getAppVersion"),
    getDiagnostics: () => call("getDiagnostics"),
    getSettings: () => call("getSettings"),
    saveSettings: (request) => call("saveSettings", request),
    listOpponents: () => call("listOpponents"),
    addOpponentNote: (request) => call("addOpponentNote", request),
    removeOpponentNote: (request) => call("removeOpponentNote", request),
    updateOpponentProfile: (request) => call("updateOpponentProfile", request),
    listOpponentCandidates: (request) => call("listOpponentCandidates", request),
    listMatches: () => call("listMatches"),
    getMatchDetails: (request) => call("getMatchDetails", request),
    toggleMatchFavorite: (request) => call("toggleMatchFavorite", request),
    revealReplay: (request) => call("revealReplay", request),
    syncReplays: (request) => call("syncReplays", request),
    onReplaySyncProgress: (listener) => subscribe(transport, "replays-sync-progress", listener),
    openLocalStorage: () => call("openLocalStorage"),
    clearStats: () => call("clearStats"),
    rebuildStats: () => call("rebuildStats"),
    startMonitoring: () => call("startMonitoring"),
    stopMonitoring: () => call("stopMonitoring"),
    getMonitoringStatus: () => call("getMonitoringStatus"),
    startReplayWatcher: () => call("startReplayWatcher"),
    stopReplayWatcher: () => call("stopReplayWatcher"),
    getReplayWatcherStatus: () => call("getReplayWatcherStatus"),
    minimizeWindow: () => call("minimizeWindow"),
    closeWindow: () => call("closeWindow"),
    setCompactWindow: (request) => call("setCompactWindow", request),
    showOverlay: () => call("showOverlay"),
    hideOverlay: () => call("hideOverlay"),
    setOverlayPosition: (position) => call("setOverlayPosition", { position }),
    setOverlayPlacementMode: (enabled) => call("setOverlayPlacementMode", { enabled }),
    onVoiceSpeak: (listener) => subscribe(transport, "voice-speak", listener),
    listAvailableVoices: () => call("listAvailableVoices"),
    getObsOverlayInfo: () => call("getObsOverlayInfo"),
    configureObsOverlay: (request) => call("configureObsOverlay", request),
    openObsOverlayPreview: () => call("openObsOverlayPreview"),
    getSmartOverlaySettings: () => call("getSmartOverlaySettings"),
    saveSmartOverlayDraft: (request) => call("saveSmartOverlayDraft", request),
    applySmartOverlay: (request) => call("applySmartOverlay", request),
    chooseSmartOverlayImage: (request) => call("chooseSmartOverlayImage", request),
    getPostmatchStatus: () => call("getPostmatchStatus"),
    preparePostmatch: (request) => call("preparePostmatch", request),
    choosePostmatchReplay: () => call("choosePostmatchReplay")
  };
  return Object.freeze(bridge);
}

export function isTauriDesktop(target: object | undefined = typeof window === "undefined" ? undefined : window): boolean {
  return target !== undefined && "__TAURI_INTERNALS__" in target;
}

export function installBridge(
  target: { readonly sc2Assistant?: Sc2AssistantBridge },
  bridge: Sc2AssistantBridge
): boolean {
  if (target.sc2Assistant) return false;
  Object.defineProperty(target, "sc2Assistant", {
    value: bridge,
    enumerable: true,
    writable: false,
    configurable: false
  });
  return true;
}

/** Called before either React entry point mounts; Electron keeps its preload bridge. */
export async function initializeDesktopBridge(): Promise<void> {
  if (!isTauriDesktop() || window.sc2Assistant) return;
  const [{ invoke }, { listen }] = await Promise.all([
    import("@tauri-apps/api/core"),
    import("@tauri-apps/api/event")
  ]);
  installBridge(window, createTauriBridge({
    invoke: (command, payload) => invoke("dispatch", { command, payload }),
    listen: <T>(event: string, listener: (payload: T) => void) =>
      listen<T>(event, (nativeEvent) => listener(nativeEvent.payload)),
    reportSubscriptionError: (event, error) => console.error(`Desktop event ${event} could not be registered`, error)
  }));
  if (typeof document !== "undefined") {
    const disposeDragging = installDragRegions(document, () =>
      invoke("dispatch", { command: "startDragging", payload: null }));
    window.addEventListener("pagehide", disposeDragging, { once: true });
    const disposeLinks = installExternalLinks(document, (url) =>
      invoke("dispatch", { command: "openExternalUrl", payload: { url } }));
    window.addEventListener("pagehide", disposeLinks, { once: true });
  }
}
