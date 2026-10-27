import { useEffect, useState } from "react";
import type { AppLanguage } from "../../domain/entities/app-settings.js";
import type { MenuWidgetLayout, SmartOverlayConfig, SmartOverlayImage, SmartOverlayPhase, SmartOverlaySettingsInfo } from "../../shared/ipc/contracts.js";
import { defaultMenuLayout, isMenuLayout, MenuWidgets, menuWidgetKinds } from "./MenuWidgetGrid.js";
import loadingUrl from "../assets/smart-overlay/loading.gif";
import loadingPosterUrl from "../assets/smart-overlay/loading-poster.png";
import outlineUrl from "../assets/smart-overlay/outline.svg";
import "../styles/obs-smart.css";

export const smartPhases: readonly SmartOverlayPhase[] = ["menu", "loading", "game", "pause"];
export type SmartOverlaySnapshot = { readonly enabled: boolean; readonly loadingEnabled?: boolean; readonly phase: SmartOverlayPhase | "unknown"; readonly mode: { readonly enabled: boolean; readonly image?: SmartOverlayImage | null }; readonly menuLayout?: MenuWidgetLayout };
const mediaId = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
export function isSmartImage(value: unknown): value is SmartOverlayImage {
  if (!object(value) || typeof value.id !== "string" || !new RegExp(`^${mediaId}$`).test(value.id)) return false;
  return ["image/png", "image/jpeg", "image/gif"].includes(String(value.mime))
    && value.animated === (value.mime === "image/gif") && typeof value.width === "number" && Number.isInteger(value.width) && value.width > 0 && value.width <= 4096
    && typeof value.height === "number" && Number.isInteger(value.height) && value.height > 0 && value.height <= 4096 && value.width * value.height <= 16_000_000
    && value.url === `/widgets/media/${value.id}` && (value.animated ? value.posterUrl === `/widgets/media/${value.id}/poster` : value.posterUrl === undefined)
    && (value.name === undefined || (typeof value.name === "string" && [...value.name].length <= 160));
}
export function isSmartSnapshot(value: unknown): value is SmartOverlaySnapshot {
  return object(value) && typeof value.enabled === "boolean" && (value.loadingEnabled === undefined || typeof value.loadingEnabled === "boolean") && [...smartPhases, "unknown"].includes(String(value.phase))
    && (value.menuLayout === undefined || isMenuLayout(value.menuLayout))
    && object(value.mode) && typeof value.mode.enabled === "boolean" && (value.mode.image == null || isSmartImage(value.mode.image));
}
export function isSmartConfig(value: unknown): value is SmartOverlayConfig {
  return object(value) && typeof value.enabled === "boolean" && object(value.modes) && Object.keys(value.modes).length === 4
    && (value.menuLayout === undefined || isMenuLayout(value.menuLayout))
    && smartPhases.every((phase) => { const mode = value.modes && (value.modes as Record<string, unknown>)[phase]; return object(mode) && typeof mode.enabled === "boolean" && (mode.image == null || isSmartImage(mode.image)); });
}
export function parseSmartSettings(value: unknown): SmartOverlaySettingsInfo | null {
  return object(value) && Number.isSafeInteger(value.revision) && Number(value.revision) >= 0 && Number.isSafeInteger(value.appliedRevision)
    && Number(value.appliedRevision) >= 0 && Number(value.appliedRevision) <= Number(value.revision)
    && isSmartConfig(value.draft) && isSmartConfig(value.applied) ? { ...value, draft: { ...value.draft, menuLayout: value.draft.menuLayout ?? defaultMenuLayout() }, applied: { ...value.applied, menuLayout: value.applied.menuLayout ?? defaultMenuLayout() } } as SmartOverlaySettingsInfo : null;
}
/** Settings preview accepts only the server's own loopback media, never arbitrary URLs. */
export function smartMediaUrl(path: string, sourceUrl?: string): string | null {
  if (!new RegExp(`^/widgets/media/${mediaId}(?:/poster)?$`).test(path)) return null;
  if (!sourceUrl) return path;
  try { const source = new URL(sourceUrl); return source.protocol === "http:" && source.hostname === "127.0.0.1" && !source.username && !source.password ? new URL(path, source.origin).href : null; }
  catch { return null; }
}
function useReducedMotion() {
  const [reduced, setReduced] = useState(() => typeof window !== "undefined" && Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches));
  useEffect(() => { const query = window.matchMedia?.("(prefers-reduced-motion: reduce)"); if (!query) return; const update = () => setReduced(query.matches); query.addEventListener("change", update); return () => query.removeEventListener("change", update); }, []);
  return reduced;
}
export function SmartOverlayLayer({ smart, language, sourceUrl, preview = false }: { readonly smart: SmartOverlaySnapshot; readonly language: AppLanguage; readonly sourceUrl?: string; readonly preview?: boolean }) {
  const reduced = useReducedMotion();
  const custom = smart.mode.image;
  const source = custom ? (reduced && custom.animated ? custom.posterUrl ? smartMediaUrl(custom.posterUrl, sourceUrl) : null : smartMediaUrl(custom.url, sourceUrl))
    : smart.phase === "loading" ? reduced ? loadingPosterUrl : loadingUrl : smart.phase === "game" || smart.phase === "pause" ? outlineUrl : null;
  const [failedSource, setFailedSource] = useState<string | null>(null);
  if (!smart.enabled || !smart.mode.enabled || smart.phase === "unknown") return null;
  const loading = smart.phase === "loading";
  const failed = Boolean(custom && !source) || Boolean(source && source === failedSource);
  const frameLabel = language === "ru" ? "Слой умного оверлея" : "Smart overlay layer";
  const menuLayout = smart.menuLayout ?? defaultMenuLayout();
  const hasMenuWidgets = menuWidgetKinds.some((kind) => menuLayout.widgets[kind].enabled);
  return <div className={`smart-overlay-layer smart-phase-${smart.phase}${!custom ? " smart-builtin" : ""}${preview ? " smart-preview-layer" : ""}`} aria-label={frameLabel}>
    {source && !failed ? <img src={source} alt="" onError={() => setFailedSource(source)} className="smart-frame-image" /> : null}
    {!custom && smart.phase === "pause" ? <><div className="smart-pause-scrim" /><div className="smart-pause-label">{language === "ru" ? "Пауза" : "Paused"}</div></> : null}
    {failed ? <p className={loading ? "smart-media-error" : "smart-media-error smart-media-error-compact"} role="status">{language === "ru" ? "Изображение недоступно" : "Image unavailable"}</p> : null}
    {!custom && smart.phase === "menu" && preview && !hasMenuWidgets ? <p className="smart-preview-empty">{language === "ru" ? "Меню прозрачно. Выберите изображение или включите виджеты." : "Menu is transparent. Choose an image or enable widgets."}</p> : null}
    {smart.phase === "menu" ? <MenuWidgets layout={menuLayout} language={language} sourceUrl={sourceUrl} preview={preview} /> : null}
  </div>;
}
