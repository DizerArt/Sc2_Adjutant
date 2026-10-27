import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { ObsOpponentCard, obsCardPosition, parseObsOverlayState, visibleObsState, type ObsOverlayState } from "../../../src/renderer/components/ObsOverlayCanvas.js";
import { createTauriBridge, type DesktopTransport } from "../../../src/renderer/platform/tauri-bridge.js";

const now = Date.parse("2026-10-25T12:00:00.000Z");
function state(change: Partial<ObsOverlayState> = {}): ObsOverlayState {
  return { schemaVersion: 1, generatedAt: new Date(now).toISOString(), enabled: true, active: true, language: "ru", width: 1920, height: 1080, position: "top-right", opponent: { nickname: "SyntheticOpponent", race: "Terran", mmr: null }, ...change };
}

describe("OBS stream composition", () => {
  it("renders only safe display data and keeps unknown statistics unknown", () => {
    const html = renderToStaticMarkup(createElement(ObsOpponentCard, { language: "ru", opponent: { ...state().opponent!, secretNote: "PRIVATE_NOTE" } as NonNullable<ObsOverlayState["opponent"]> }));
    expect(html).toContain("SyntheticOpponent");
    expect(html).toContain("—");
    expect(html).not.toContain("PRIVATE_NOTE");
    expect(html).not.toContain("window.sc2Assistant");
  });

  it("preserves English snapshots and renders English card labels", () => {
    const english = parseObsOverlayState(state({ language: "en" }));
    expect(english?.language).toBe("en");
    const html = renderToStaticMarkup(createElement(ObsOpponentCard, { language: english!.language, opponent: english!.opponent! }));
    expect(html).toContain('aria-label="Current match opponent"');
    expect(html).toContain("Meetings");
    expect(html).not.toContain("Встречи");
    expect(html).not.toContain("Соперник текущего матча");
    expect(parseObsOverlayState({ ...state(), language: "de" })).toBeNull();
    expect(parseObsOverlayState({ ...state(), language: undefined })).toBeNull();
  });

  it("hides disabled, inactive, stale and future snapshots rather than retaining a previous opponent", () => {
    expect(visibleObsState(state(), 100, 100, now)).toBe(true);
    expect(visibleObsState(state({ enabled: false }), 100, 100, now)).toBe(false);
    expect(visibleObsState(state({ active: false }), 100, 100, now)).toBe(false);
    expect(visibleObsState(state(), 100, 5101, now)).toBe(false);
    expect(visibleObsState(state({ generatedAt: new Date(now - 5001).toISOString() }), 100, 100, now)).toBe(false);
    expect(visibleObsState(state({ generatedAt: new Date(now + 5001).toISOString() }), 100, 100, now)).toBe(false);
  });

  it("rejects malformed identities, dimensions and statistics without manufacturing a card", () => {
    expect(parseObsOverlayState(state())).not.toBeNull();
    for (const bad of [{ schemaVersion: 99 }, { generatedAt: "invalid" }, { width: 0 }, { height: 1080.5 }, { position: "arbitrary" }, { opponent: null }, { opponent: { nickname: "", race: "Zerg" } }, { opponent: { nickname: "Opponent", race: "Zerg", mmr: -10 } }]) {
      expect(parseObsOverlayState({ ...state(), ...bad })).toBeNull();
    }
  });

  it("places one card inside all native preset positions and scales the canvas independently", () => {
    expect(obsCardPosition("top-left", 1920, 1080)).toEqual({ x: 24, y: 24 });
    expect(obsCardPosition("bottom-1", 1920, 1080)).toEqual({ x: 24, y: 908 });
    expect(obsCardPosition("bottom-6", 1920, 1080)).toEqual({ x: 1496, y: 908 });
    expect(obsCardPosition("top-center", 1920, 1080).x).toBe(760);
    expect(obsCardPosition("middle-right", 2560, 1440).y).toBe(646);
  });

  it("routes OBS controls through native commands independently of the desktop overlay", async () => {
    const invoke = vi.fn(async (_command: string, _args: unknown) => ({ running: true, url: "http://127.0.0.1:8766/widgets/" }));
    const bridge = createTauriBridge({ invoke, listen: vi.fn() } as unknown as DesktopTransport);
    await bridge.getObsOverlayInfo!();
    expect(invoke).toHaveBeenLastCalledWith("getObsOverlayInfo", null);
    await bridge.configureObsOverlay!({ enabled: true, position: "bottom-4", width: 2560, height: 1440 });
    expect(invoke).toHaveBeenLastCalledWith("configureObsOverlay", { enabled: true, position: "bottom-4", width: 2560, height: 1440 });
    await bridge.openObsOverlayPreview!();
    expect(invoke).toHaveBeenLastCalledWith("openObsOverlayPreview", null);
    expect(invoke.mock.calls.some(([command]) => command === "showOverlay")).toBe(false);
  });
});
