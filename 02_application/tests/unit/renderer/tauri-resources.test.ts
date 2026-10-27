import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string, protocol: string) => `http://${protocol}.localhost/${path}`,
  invoke: vi.fn().mockResolvedValue({ settings: { language: "ru" } })
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {})
}));
import { invoke } from "@tauri-apps/api/core";
import { voiceResourceBase } from "../../../src/renderer/platform/resources.js";
import { initializeDesktopBridge } from "../../../src/renderer/platform/tauri-bridge.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("local voice resource origins", () => {
  it("retains Electron custom protocol URLs", () => {
    vi.stubGlobal("window", {});
    expect(voiceResourceBase("local")).toBe("voice-model://local");
    expect(voiceResourceBase("wasm")).toBe("voice-model://wasm");
  });
  it("uses Tauri platform conversion for the same local resource paths", () => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    expect(voiceResourceBase("local")).toBe("http://voice-model.localhost/local");
    expect(voiceResourceBase("wasm")).toBe("http://voice-model.localhost/wasm");
  });
});

describe("desktop entry-point initialization", () => {
  it("routes the installed native bridge through dispatch before renderer calls", async () => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    await initializeDesktopBridge();
    expect(window.sc2Assistant).toBeDefined();
    await window.sc2Assistant?.getSettings();
    expect(invoke).toHaveBeenCalledWith("dispatch", { command: "getSettings", payload: null });
    await window.sc2Assistant?.setOverlayPlacementMode(true);
    expect(invoke).toHaveBeenLastCalledWith("dispatch", {
      command: "setOverlayPlacementMode", payload: { enabled: true }
    });
  });

  it("leaves the Electron preload and regular browser intact", async () => {
    const electron = { version: "preload" };
    vi.stubGlobal("window", { sc2Assistant: electron });
    await initializeDesktopBridge();
    expect(window.sc2Assistant).toBe(electron);
    vi.stubGlobal("window", {});
    await initializeDesktopBridge();
    expect(window.sc2Assistant).toBeUndefined();
    expect(invoke).not.toHaveBeenCalled();
  });
});
