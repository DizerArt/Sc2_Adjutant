import { describe, expect, it, vi } from "vitest";
import {
  createTauriBridge,
  installBridge,
  isTauriDesktop,
  type DesktopTransport
} from "../../../src/renderer/platform/tauri-bridge.js";
import type { Sc2AssistantBridge } from "../../../src/shared/ipc/contracts.js";

function transportFor(invoke = vi.fn(async () => ({ ok: true }))) {
  return {
    invoke,
    listen: vi.fn(async () => vi.fn())
  } as unknown as DesktopTransport;
}

describe("Tauri renderer bridge", () => {
  it("opens replay selection without accepting or exposing a filesystem path", async () => {
    const invoke = vi.fn(async () => null);
    const bridge = createTauriBridge({ invoke, listen: vi.fn(async () => vi.fn()) } as unknown as DesktopTransport);
    expect(await bridge.choosePostmatchReplay!()).toBeNull();
    expect(invoke).toHaveBeenCalledExactlyOnceWith("choosePostmatchReplay", null);
  });
  it("preserves exact request DTOs and forwards each command through the bounded dispatcher", async () => {
    const invoke = vi.fn(async () => ({ ok: true }));
    const bridge = createTauriBridge(transportFor(invoke));
    const parameterless = [
      "getAppVersion", "getDiagnostics", "getSettings", "listOpponents", "listMatches",
      "openLocalStorage", "clearStats", "rebuildStats", "startMonitoring", "stopMonitoring",
      "getMonitoringStatus", "startReplayWatcher", "stopReplayWatcher", "getReplayWatcherStatus",
      "minimizeWindow", "closeWindow", "showOverlay", "hideOverlay", "listAvailableVoices"
    ] as const;
    for (const command of parameterless) {
      await bridge[command]();
      expect(invoke).toHaveBeenLastCalledWith(command, null);
    }
    const requests: Record<string, unknown> = {
      saveSettings: { playerName: "Игрок", language: "ru" },
      addOpponentNote: { opponentId: "opponent-1", note: "Замечание", race: "Terran" },
      removeOpponentNote: { opponentId: "opponent-1", noteIndex: 0 },
      updateOpponentProfile: { opponentId: "opponent-1", nickname: "new" },
      listOpponentCandidates: { opponentId: "opponent-1" },
      getMatchDetails: { matchId: "match-1" },
      toggleMatchFavorite: { matchId: "match-1" },
      revealReplay: { replayPath: "C:\\игры\\test.SC2Replay" },
      syncReplays: { mode: "partial", limit: 25 },
      setCompactWindow: { compact: true, offsetX: 3, offsetY: 5, width: 400, height: 220 }
    };
    for (const [command, payload] of Object.entries(requests)) {
      await (bridge[command as keyof Sc2AssistantBridge] as (request: unknown) => Promise<unknown>)(payload);
      expect(invoke).toHaveBeenLastCalledWith(command, payload);
    }
    await bridge.setOverlayPosition("bottom-1");
    expect(invoke).toHaveBeenLastCalledWith("setOverlayPosition", { position: "bottom-1" });
    await bridge.setOverlayPlacementMode(true);
    expect(invoke).toHaveBeenLastCalledWith("setOverlayPlacementMode", { enabled: true });
    expect(Object.isFrozen(bridge)).toBe(true);
  });

  it("delivers native command errors to existing renderer error handling", async () => {
    const transport = transportFor();
    transport.invoke = vi.fn().mockRejectedValue(new Error("Storage is read-only"));
    await expect(createTauriBridge(transport).saveSettings({ language: "ru" }))
      .rejects.toThrow("Storage is read-only");
  });

  it("releases a subscription that finishes registering after React cleanup", async () => {
    let register: ((release: () => void) => void) | undefined;
    let nativeListener: ((payload: unknown) => void) | undefined;
    const release = vi.fn();
    const listener = vi.fn();
    const transport = transportFor();
    transport.listen = <T>(_event: string, callback: (payload: T) => void) => {
      nativeListener = callback as (payload: unknown) => void;
      return new Promise<() => void>((resolve) => { register = resolve; });
    };
    const dispose = createTauriBridge(transport).onReplaySyncProgress(listener);
    dispose();
    register?.(release);
    await Promise.resolve();
    nativeListener?.({ processedCount: 1 });
    dispose();
    expect(release).toHaveBeenCalledTimes(1);
    expect(listener).not.toHaveBeenCalled();
  });

  it("uses separate event names and unregisters native listeners exactly once", async () => {
    const callbacks = new Map<string, (payload: unknown) => void>();
    const release = vi.fn();
    const transport = transportFor();
    transport.listen = async <T>(event: string, callback: (payload: T) => void) => {
      callbacks.set(event, callback as (payload: unknown) => void);
      return release;
    };
    const progress = vi.fn();
    const voice = vi.fn();
    const bridge = createTauriBridge(transport);
    const disposeProgress = bridge.onReplaySyncProgress(progress);
    const disposeVoice = bridge.onVoiceSpeak(voice);
    await Promise.resolve();
    callbacks.get("replays-sync-progress")?.({ processedCount: 2 });
    callbacks.get("voice-speak")?.({ kind: "launch" });
    expect(progress).toHaveBeenCalledWith({ processedCount: 2 });
    expect(voice).toHaveBeenCalledWith({ kind: "launch" });
    disposeProgress();
    disposeProgress();
    disposeVoice();
    expect(release).toHaveBeenCalledTimes(2);
    callbacks.get("voice-speak")?.({ kind: "launch" });
    expect(voice).toHaveBeenCalledTimes(1);
  });

  it("handles a failed native subscription without an unhandled rejection", async () => {
    const transport = transportFor();
    const error = new Error("Event permission denied");
    const report = vi.fn();
    transport.listen = vi.fn().mockRejectedValue(error);
    transport.reportSubscriptionError = report;
    createTauriBridge(transport).onVoiceSpeak(vi.fn());
    await Promise.resolve();
    await Promise.resolve();
    expect(report).toHaveBeenCalledWith("voice-speak", error);
  });

  it("keeps an incumbent Electron bridge intact", () => {
    const incumbent = createTauriBridge(transportFor());
    const target = { sc2Assistant: incumbent };
    expect(installBridge(target, createTauriBridge(transportFor()))).toBe(false);
    expect(target.sc2Assistant).toBe(incumbent);
    const empty = {};
    expect(installBridge(empty, incumbent)).toBe(true);
    expect(Object.getOwnPropertyDescriptor(empty, "sc2Assistant")?.writable).toBe(false);
  });

  it("does not mistake a normal browser or Electron for Tauri", () => {
    expect(isTauriDesktop({})).toBe(false);
    expect(isTauriDesktop({ sc2Assistant: {} })).toBe(false);
    expect(isTauriDesktop({ __TAURI_INTERNALS__: {} })).toBe(true);
  });
});
