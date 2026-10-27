import { describe, expect, it, vi } from "vitest";
import {
  installDragRegions,
  isWindowDragTarget,
  type DragDocument,
  type DragMouseEvent
} from "../../../src/renderer/platform/drag-regions.js";

function targetFor(handles: readonly string[], excluded = false) {
  return {
    closest: (selector: string) => {
      if (selector.includes("button")) return excluded ? {} : null;
      return handles.some((handle) => selector.split(", ").includes(handle)) ? {} : null;
    }
  };
}

function fakeDocument() {
  let listener: ((event: DragMouseEvent) => void) | undefined;
  const target: DragDocument = {
    addEventListener: vi.fn((_type, callback) => { listener = callback; }),
    removeEventListener: vi.fn((_type, callback) => { if (listener === callback) listener = undefined; })
  };
  return {
    target,
    mouseDown: (overrides: Partial<DragMouseEvent> = {}) => {
      const event: DragMouseEvent = {
        target: targetFor([".window-titlebar-drag"]), button: 0, defaultPrevented: false,
        preventDefault: vi.fn(), ...overrides
      };
      listener?.(event);
      return event;
    }
  };
}

describe("native window drag regions", () => {
  it("accepts only the title handle, compact headings and overlay card", () => {
    for (const handle of [".window-titlebar-drag", ".app-frame-compact .panel-heading", ".overlay-card"]) {
      expect(isWindowDragTarget(targetFor([handle]))).toBe(true);
    }
    for (const handle of [".window-titlebar-controls", ".panel-heading", ".content-area", ".window-titlebar"]) {
      expect(isWindowDragTarget(targetFor([handle]))).toBe(false);
    }
    expect(isWindowDragTarget(null)).toBe(false);
    expect(isWindowDragTarget({})).toBe(false);
    expect(isWindowDragTarget({ parentElement: targetFor([".window-titlebar-drag"]) })).toBe(true);
  });

  it("excludes controls and no-drag regions even inside a drag handle", () => {
    const seen: string[] = [];
    const control = {
      closest: (selector: string) => {
        seen.push(selector);
        return {};
      }
    };
    expect(isWindowDragTarget(control)).toBe(false);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("button");
    expect(seen[0]).toContain("a");
    expect(seen[0]).toContain("input");
    expect(seen[0]).toContain("select");
    expect(seen[0]).toContain("textarea");
    expect(seen[0]).toContain("[data-no-drag]");
    expect(seen[0]).toContain(".compact-exit-tab");
    expect(seen[0]).toContain(".window-titlebar-controls");
  });

  it("installs one capture listener and cleans it up exactly once", async () => {
    const document = fakeDocument();
    const startDragging = vi.fn().mockResolvedValue(undefined);
    const dispose = installDragRegions(document.target, startDragging);
    expect(installDragRegions(document.target, startDragging)).toBe(dispose);
    expect(document.target.addEventListener).toHaveBeenCalledTimes(1);
    expect(document.target.addEventListener).toHaveBeenCalledWith("mousedown", expect.any(Function), true);
    const event = document.mouseDown();
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(startDragging).toHaveBeenCalledOnce();
    dispose();
    dispose();
    document.mouseDown();
    expect(startDragging).toHaveBeenCalledOnce();
    expect(document.target.removeEventListener).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(installDragRegions(document.target, startDragging)).not.toBe(dispose);
  });

  it("does not consume controls, right clicks, modified clicks or already-handled events", () => {
    const document = fakeDocument();
    const startDragging = vi.fn().mockResolvedValue(undefined);
    installDragRegions(document.target, startDragging);
    for (const overrides of [
      { target: targetFor([".window-titlebar-drag"], true) },
      { target: targetFor([]) }, { button: 2 }, { defaultPrevented: true },
      { altKey: true }, { ctrlKey: true }, { metaKey: true }, { shiftKey: true }
    ]) {
      expect(document.mouseDown(overrides).preventDefault).not.toHaveBeenCalled();
    }
    expect(startDragging).not.toHaveBeenCalled();
  });

  it("handles native refusal and permits a subsequent drag", async () => {
    const document = fakeDocument();
    const error = new Error("Overlay placement is disabled");
    const startDragging = vi.fn().mockRejectedValue(error);
    const report = vi.fn();
    installDragRegions(document.target, startDragging, report);
    document.mouseDown({ target: targetFor([".overlay-card"]) });
    document.mouseDown();
    expect(startDragging).toHaveBeenCalledOnce();
    await Promise.resolve();
    await Promise.resolve();
    expect(report).toHaveBeenCalledWith(error);
    document.mouseDown();
    expect(startDragging).toHaveBeenCalledTimes(2);
    await Promise.resolve();
    await Promise.resolve();
  });

  it("handles a synchronous native error and ignores errors after teardown", async () => {
    const document = fakeDocument();
    const report = vi.fn();
    const synchronousError = new Error("Unavailable window");
    let reject: ((error: unknown) => void) | undefined;
    const startDragging = vi.fn<() => Promise<unknown>>()
      .mockImplementationOnce(() => { throw synchronousError; })
      .mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    const dispose = installDragRegions(document.target, startDragging, report);
    document.mouseDown();
    expect(report).toHaveBeenCalledWith(synchronousError);
    document.mouseDown();
    dispose();
    reject?.(new Error("Window closed"));
    await Promise.resolve();
    await Promise.resolve();
    expect(report).toHaveBeenCalledTimes(1);
  });
});
