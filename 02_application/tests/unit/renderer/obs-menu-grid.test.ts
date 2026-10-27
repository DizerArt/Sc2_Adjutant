import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { clampWidget, defaultMenuLayout, isMenuLayout, MenuWidgets, moveMenuWidget, postmatchFrameUrl } from "../../../src/renderer/components/MenuWidgetGrid.js";
import { parseSmartSettings } from "../../../src/renderer/components/SmartOverlayLayer.js";
import { runSmartOverlayAction } from "../../../src/renderer/components/SmartOverlaySettings.js";
import type { Sc2AssistantBridge, SmartOverlayConfig } from "../../../src/shared/ipc/contracts.js";
const appearance: SmartOverlayConfig = { enabled: true, modes: { menu: { enabled: true }, loading: { enabled: true }, game: { enabled: true }, pause: { enabled: true } } };
describe("menu composition on a 32-column, 64-row grid", () => {
  it("migrates old appearances to four disabled quadrants without enabling a broadcast widget", () => {
    const info = parseSmartSettings({ revision: 1, appliedRevision: 1, draft: appearance, applied: appearance });
    expect(info?.draft.menuLayout).toEqual(defaultMenuLayout());
    expect(Object.values(info!.applied.menuLayout!.widgets).every((value) => !value.enabled)).toBe(true);
    expect(info?.draft.menuLayout?.widgets.heroes).toEqual({ enabled: false, x: 16, y: 32, w: 16, h: 32 });
  });
  it("permits single cells and overlaps while rejecting fractions, wrong axes and escaped bounds", () => {
    const layout = defaultMenuLayout();
    const one = { enabled: true, x: 31, y: 63, w: 1, h: 1 };
    expect(isMenuLayout({ ...layout, widgets: { ...layout.widgets, fountain: one, heroes: one } })).toBe(true);
    for (const bad of [{ x: -1 }, { y: 64 }, { w: 33 }, { h: 0 }, { x: 0.5 }]) expect(isMenuLayout({ ...layout, widgets: { ...layout.widgets, fountain: { ...layout.widgets.fountain, ...bad } } })).toBe(false);
    expect(isMenuLayout({ ...layout, columns: 64, rows: 32 })).toBe(false);
  });
  it("keeps whole widgets on the canvas during drag and clamps resizing at the far edge", () => {
    const start = { enabled: true, x: 4, y: 8, w: 16, h: 32 };
    expect(moveMenuWidget(start, 99, 99, false)).toEqual({ ...start, x: 16, y: 32 });
    expect(moveMenuWidget(start, -99, -99, false)).toEqual({ ...start, x: 0, y: 0 });
    expect(moveMenuWidget(start, 99, 99, true)).toEqual({ ...start, w: 28, h: 56 });
    expect(moveMenuWidget(start, -99, -99, true)).toEqual({ ...start, w: 1, h: 1 });
    expect(clampWidget({ ...start, x: NaN, h: NaN })).toEqual({ ...start, x: 0, h: 1 });
  });
  it("mounts four independent real renderers in stable layer order, with no native bridge or invented match", () => {
    const layout = defaultMenuLayout();
    const enabled = { ...layout, widgets: Object.fromEntries(Object.entries(layout.widgets).map(([kind, place]) => [kind, { ...place, enabled: true }])) as typeof layout.widgets };
    const html = renderToStaticMarkup(createElement(MenuWidgets, { layout: enabled, language: "en" }));
    expect(html.match(/<iframe/g)).toHaveLength(4);
    expect(html.indexOf("kind=fountain")).toBeLessThan(html.indexOf("kind=battle_map"));
    expect(html.indexOf("kind=armies")).toBeLessThan(html.indexOf("kind=heroes"));
    expect(html).toContain("left:50%;top:50%;width:50%;height:50%");
    expect(renderToStaticMarkup(createElement(MenuWidgets, { layout, language: "en" }))).not.toContain("<iframe");
    expect(postmatchFrameUrl("heroes", "ru", "http://127.0.0.1:8766/widgets/", true)).toBe("http://127.0.0.1:8766/widgets/postmatch.html?kind=heroes&lang=ru&preview=1");
    expect(postmatchFrameUrl("heroes", "ru", "https://example.com/widgets/", true)).toBeNull();
  });
  it("saves a placement as a revision-checked draft without applying it to OBS", async () => {
    const initial = { revision: 2, appliedRevision: 2, draft: { ...appearance, menuLayout: defaultMenuLayout() }, applied: appearance };
    const layout = { ...initial.draft.menuLayout, widgets: { ...initial.draft.menuLayout.widgets, fountain: { enabled: true, x: 1, y: 2, w: 20, h: 40 } } };
    const saveSmartOverlayDraft = vi.fn(async () => ({ ...initial, revision: 3, draft: { ...initial.draft, menuLayout: layout } }));
    const applySmartOverlay = vi.fn();
    const result = await runSmartOverlayAction({ saveSmartOverlayDraft, applySmartOverlay } as unknown as Sc2AssistantBridge, initial, { kind: "save", config: { ...initial.draft, menuLayout: layout } });
    expect(saveSmartOverlayDraft).toHaveBeenCalledWith({ revision: 2, ...initial.draft, menuLayout: layout });
    expect(result.info.draft.menuLayout?.widgets.fountain.x).toBe(1);
    expect(applySmartOverlay).not.toHaveBeenCalled();
  });
});
