const DRAG_HANDLES = ".window-titlebar-drag, .app-frame-compact .panel-heading, .overlay-card";
const NO_DRAG = [
  "button", "a", "input", "select", "textarea", "option", "label", "summary",
  '[contenteditable]:not([contenteditable="false"])',
  '[role="button"]', '[role="link"]', '[role="checkbox"]', '[role="slider"]',
  "[data-no-drag]", ".compact-exit-tab", ".window-titlebar-controls"
].join(", ");

type DragElement = { closest(selector: string): unknown; parentElement?: unknown };
export type DragMouseEvent = {
  readonly target: unknown;
  readonly button: number;
  readonly defaultPrevented: boolean;
  readonly altKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly shiftKey?: boolean;
  preventDefault(): void;
};
export type DragDocument = {
  addEventListener(type: "mousedown", listener: (event: DragMouseEvent) => void, capture: boolean): void;
  removeEventListener(type: "mousedown", listener: (event: DragMouseEvent) => void, capture: boolean): void;
};

function dragElement(target: unknown): DragElement | undefined {
  if (target === null || typeof target !== "object") return;
  const candidate = target as { closest?: unknown; parentElement?: unknown };
  if (typeof candidate.closest === "function") return candidate as DragElement;
  // Text nodes do not implement closest; their parent still identifies the handle.
  const parent = candidate.parentElement;
  if (parent !== null && typeof parent === "object" &&
      typeof (parent as { closest?: unknown }).closest === "function") {
    return parent as DragElement;
  }
}

/** Explicit handles replace Electron-only CSS app-region behavior in Tauri. */
export function isWindowDragTarget(target: unknown): boolean {
  const element = dragElement(target);
  return Boolean(element && !element.closest(NO_DRAG) && element.closest(DRAG_HANDLES));
}

const installed = new WeakMap<DragDocument, () => void>();

export function installDragRegions(
  documentTarget: DragDocument,
  startDragging: () => Promise<unknown>,
  reportError: (error: unknown) => void = (error) => console.error("Window movement failed", error)
): () => void {
  const existing = installed.get(documentTarget);
  if (existing) return existing;
  let disposed = false;
  let pending = false;
  const onMouseDown = (event: DragMouseEvent) => {
    if (disposed || pending || event.defaultPrevented || event.button !== 0 ||
        event.altKey || event.ctrlKey || event.metaKey || event.shiftKey ||
        !isWindowDragTarget(event.target)) return;
    event.preventDefault();
    pending = true;
    try {
      void startDragging().catch((error: unknown) => {
        if (!disposed) reportError(error);
      }).finally(() => { pending = false; });
    } catch (error) {
      pending = false;
      if (!disposed) reportError(error);
    }
  };
  documentTarget.addEventListener("mousedown", onMouseDown, true);
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    documentTarget.removeEventListener("mousedown", onMouseDown, true);
    installed.delete(documentTarget);
  };
  installed.set(documentTarget, dispose);
  return dispose;
}
