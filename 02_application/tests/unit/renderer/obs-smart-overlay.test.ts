import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Sc2AssistantBridge, SmartOverlayConfig, SmartOverlayImage, SmartOverlaySettingsInfo } from "../../../src/shared/ipc/contracts.js";
import { createTauriBridge, type DesktopTransport } from "../../../src/renderer/platform/tauri-bridge.js";
import { parseObsOverlayState, retainSmartLoading, mergeSmartSnapshot, visibleObsState, type ObsOverlayState } from "../../../src/renderer/components/ObsOverlayCanvas.js";
import { isSmartImage, parseSmartSettings, smartMediaUrl, SmartOverlayLayer } from "../../../src/renderer/components/SmartOverlayLayer.js";
import { runSmartOverlayAction } from "../../../src/renderer/components/SmartOverlaySettings.js";

const config: SmartOverlayConfig = { enabled: true, modes: { menu: { enabled: true }, loading: { enabled: true }, game: { enabled: false }, pause: { enabled: true } } };
function info(revision = 3): SmartOverlaySettingsInfo { return { revision, appliedRevision: 2, draft: config, applied: { ...config, enabled: false } }; }
const image: SmartOverlayImage = { id: "00000000-0000-4000-8000-000000000001", mime: "image/gif", width: 1920, height: 1080, animated: true, url: "/widgets/media/00000000-0000-4000-8000-000000000001", posterUrl: "/widgets/media/00000000-0000-4000-8000-000000000001/poster", name: "Fixture.gif" };
function loading(): ObsOverlayState { return { schemaVersion: 1, generatedAt: "2026-10-25T12:00:00Z", language: "en", enabled: false, active: false, width: 1920, height: 1080, position: "top-right", smart: { enabled: true, phase: "loading", mode: { enabled: true } } }; }
afterEach(() => vi.unstubAllGlobals());

describe("smart overlay editing and stream isolation", () => {
  it("saves only a draft at the displayed revision, then applies the returned revision explicitly", async () => {
    const saved = info(4);
    const applied = { ...saved, revision: 5, appliedRevision: 5, applied: saved.draft };
    const saveSmartOverlayDraft = vi.fn(async () => saved);
    const applySmartOverlay = vi.fn(async () => applied);
    const bridge = { saveSmartOverlayDraft, applySmartOverlay } as unknown as Sc2AssistantBridge;
    const draft = await runSmartOverlayAction(bridge, info(), { kind: "save", config });
    expect(saveSmartOverlayDraft).toHaveBeenCalledWith({ revision: 3, ...config });
    expect(applySmartOverlay).not.toHaveBeenCalled();
    const live = await runSmartOverlayAction(bridge, draft.info, { kind: "apply" });
    expect(applySmartOverlay).toHaveBeenCalledWith({ revision: 4 });
    expect(live.info.appliedRevision).toBe(5);
    expect(live.failed).toBe(false);
  });

  it("refreshes a rejected revision once without retrying or applying a conflicting draft", async () => {
    const saveSmartOverlayDraft = vi.fn(async () => { throw Error("revision conflict"); });
    const getSmartOverlaySettings = vi.fn(async () => info(7));
    const applySmartOverlay = vi.fn();
    const result = await runSmartOverlayAction({ saveSmartOverlayDraft, getSmartOverlaySettings, applySmartOverlay } as unknown as Sc2AssistantBridge, info(), { kind: "save", config });
    expect(saveSmartOverlayDraft).toHaveBeenCalledTimes(1);
    expect(getSmartOverlaySettings).toHaveBeenCalledTimes(1);
    expect(applySmartOverlay).not.toHaveBeenCalled();
    expect(result.failed).toBe(true);
    expect(result.problem).toContain("revision conflict");
    expect(result.info.revision).toBe(7);
  });

  it("keeps cancellation unchanged and imports into a draft without publishing it", async () => {
    const chooseSmartOverlayImage = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({ ...info(4), draft: { ...config, modes: { ...config.modes, menu: { enabled: true, image } } } });
    const applySmartOverlay = vi.fn();
    const bridge = { chooseSmartOverlayImage, applySmartOverlay } as unknown as Sc2AssistantBridge;
    expect((await runSmartOverlayAction(bridge, info(), { kind: "choose", phase: "menu" })).cancelled).toBe(true);
    const chosen = await runSmartOverlayAction(bridge, info(), { kind: "choose", phase: "menu" });
    expect(chooseSmartOverlayImage).toHaveBeenCalledWith({ revision: 3, mode: "menu" });
    expect(chosen.info.draft.modes.menu.image?.id).toBe(image.id);
    expect(applySmartOverlay).not.toHaveBeenCalled();
  });

  it("rejects unsafe images and incomplete configuration before sending a draft", async () => {
    const saveSmartOverlayDraft = vi.fn();
    expect(isSmartImage(image)).toBe(true);
    for (const bad of [{ mime: "image/webp" }, { width: 5000 }, { width: 4096, height: 4096 }, { posterUrl: undefined }, { animated: false }, { id: "invalid-id" }]) expect(isSmartImage({ ...image, ...bad })).toBe(false);
    for (const url of ["file:///C:/private.png", "https://example.com/x.gif", "/widgets/media/../private", "/api/overlay/state"]) expect(isSmartImage({ ...image, url })).toBe(false);
    expect(parseSmartSettings({ ...info(), draft: { ...config, modes: { menu: { enabled: true } } } })).toBeNull();
    expect(parseSmartSettings({ ...info(), appliedRevision: 4 })).toBeNull();
    await expect(runSmartOverlayAction({ saveSmartOverlayDraft } as unknown as Sc2AssistantBridge, info(), { kind: "save", config: { ...config, modes: { ...config.modes, menu: { enabled: true, image: { ...image, url: "https://example.com/x.gif" } } } } })).rejects.toThrow();
    expect(saveSmartOverlayDraft).not.toHaveBeenCalled();
  });

  it("resolves previews only against the trusted loopback source", () => {
    expect(smartMediaUrl(image.url, "http://127.0.0.1:8766/widgets/")).toBe("http://127.0.0.1:8766/widgets/media/00000000-0000-4000-8000-000000000001");
    expect(smartMediaUrl(image.url, "https://example.com/widgets/")).toBeNull();
    expect(smartMediaUrl(image.url, "http://user:pass@127.0.0.1:8766/widgets/")).toBeNull();
    expect(smartMediaUrl("//example.com/x.gif")).toBeNull();
  });

  it("keeps an established loading cover through unknown/stale states but clears on known exit or disable", () => {
    const previous = loading();
    const unknown: ObsOverlayState = { ...previous, smart: { enabled: true, phase: "unknown", mode: { enabled: false } } };
    expect(retainSmartLoading(mergeSmartSnapshot(previous, unknown))).toBe(true);
    expect(retainSmartLoading(mergeSmartSnapshot(previous, { ...unknown, smart: { ...unknown.smart!, loadingEnabled: false } }))).toBe(false);
    expect(parseObsOverlayState({ ...previous, smart: { ...previous.smart, loadingEnabled: "false" } })).toBeNull();
    expect(retainSmartLoading(previous)).toBe(true);
    expect(visibleObsState(previous, 100, 10000)).toBe(false);
    for (const smart of [{ enabled: true, phase: "game", mode: { enabled: true } }, { enabled: false, phase: "unknown", mode: { enabled: false } }] as const) expect(retainSmartLoading(mergeSmartSnapshot(previous, { ...previous, smart }))).toBe(false);
    expect(parseObsOverlayState({ ...previous, smart: { enabled: true, phase: "postmatch", mode: { enabled: true } } })).toBeNull();
  });

  it("renders opaque loading independently of an inactive opponent card and leaves standard menu transparent", () => {
    const html = renderToStaticMarkup(createElement(SmartOverlayLayer, { smart: loading().smart!, language: "en" }));
    expect(html).toContain("smart-phase-loading");
    expect(html).toContain("loading.gif");
    const menu = renderToStaticMarkup(createElement(SmartOverlayLayer, { smart: { enabled: true, phase: "menu", mode: { enabled: true } }, language: "en" }));
    expect(menu).not.toContain("<img");
    expect(menu).not.toContain("Menu is transparent");
  });

  it("uses a still poster for custom animated images when reduced motion is requested", () => {
    vi.stubGlobal("window", { matchMedia: () => ({ matches: true }) });
    const html = renderToStaticMarkup(createElement(SmartOverlayLayer, { smart: { enabled: true, phase: "loading", mode: { enabled: true, image } }, language: "en" }));
    expect(html).toContain(`/widgets/media/${image.id}/poster`);
    expect(html).not.toContain(`src="${image.url}"`);
  });

  it("preserves the standard pause HUD and localized label as separate layers from its animated scrim", () => {
    const smart = { enabled: true, phase: "pause", mode: { enabled: true } } as const;
    const russian = renderToStaticMarkup(createElement(SmartOverlayLayer, { smart, language: "ru" }));
    expect(russian).toContain("<img");
    expect(russian).toContain('class="smart-pause-scrim"');
    expect(russian).toContain('class="smart-pause-label">Пауза');
    expect(renderToStaticMarkup(createElement(SmartOverlayLayer, { smart, language: "en" }))).toContain('class="smart-pause-label">Paused');
  });

  it("routes edit and apply commands separately through the native bridge", async () => {
    const invoke = vi.fn(async (_command: string, _payload: unknown) => info());
    const bridge = createTauriBridge({ invoke, listen: vi.fn() } as unknown as DesktopTransport);
    await bridge.getSmartOverlaySettings!();
    expect(invoke).toHaveBeenLastCalledWith("getSmartOverlaySettings", null);
    await bridge.saveSmartOverlayDraft!({ revision: 3, ...config });
    expect(invoke).toHaveBeenLastCalledWith("saveSmartOverlayDraft", { revision: 3, ...config });
    await bridge.chooseSmartOverlayImage!({ revision: 3, mode: "pause" });
    expect(invoke).toHaveBeenLastCalledWith("chooseSmartOverlayImage", { revision: 3, mode: "pause" });
    await bridge.applySmartOverlay!({ revision: 4 });
    expect(invoke).toHaveBeenLastCalledWith("applySmartOverlay", { revision: 4 });
  });
});
