import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import type { AppLanguage } from "../../domain/entities/app-settings.js";
import type { MenuWidgetKind, MenuWidgetLayout, MenuWidgetPlacement } from "../../shared/ipc/contracts.js";
import "../styles/obs-menu-widgets.css";

export const menuWidgetKinds: readonly MenuWidgetKind[] = ["fountain", "battle_map", "armies", "heroes"];
export const widgetNames = { ru: { fountain: "Фонтан потерь", battle_map: "Карта сражений", armies: "Армии и размены", heroes: "Герои матча" }, en: { fountain: "Loss fountain", battle_map: "Battle map", armies: "Armies and trades", heroes: "Match heroes" } };
export function defaultMenuLayout(): MenuWidgetLayout {
  return { columns: 32, rows: 64, widgets: { fountain: { enabled: false, x: 0, y: 0, w: 16, h: 32 }, battle_map: { enabled: false, x: 16, y: 0, w: 16, h: 32 }, armies: { enabled: false, x: 0, y: 32, w: 16, h: 32 }, heroes: { enabled: false, x: 16, y: 32, w: 16, h: 32 } } };
}
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
export function isMenuLayout(value: unknown): value is MenuWidgetLayout {
  if (!record(value) || value.columns !== 32 || value.rows !== 64 || !record(value.widgets) || Object.keys(value.widgets).length !== 4) return false;
  return menuWidgetKinds.every((kind) => {
    const place = (value.widgets as Record<string, unknown>)[kind];
    if (!record(place) || typeof place.enabled !== "boolean" || ![place.x, place.y, place.w, place.h].every(Number.isInteger)) return false;
    return Number(place.x) >= 0 && Number(place.y) >= 0 && Number(place.w) >= 1 && Number(place.h) >= 1 && Number(place.x) + Number(place.w) <= 32 && Number(place.y) + Number(place.h) <= 64;
  });
}
export function clampWidget(place: MenuWidgetPlacement): MenuWidgetPlacement {
  const number = (value: number, min: number, max: number) => Math.min(max, Math.max(min, Number.isFinite(value) ? Math.round(value) : min));
  const x = number(place.x, 0, 31), y = number(place.y, 0, 63);
  return { enabled: place.enabled, x, y, w: number(place.w, 1, 32 - x), h: number(place.h, 1, 64 - y) };
}
export function moveMenuWidget(place: MenuWidgetPlacement, dx: number, dy: number, resize: boolean): MenuWidgetPlacement {
  return resize ? clampWidget({ ...place, w: place.w + dx, h: place.h + dy }) : { ...place, x: Math.min(32 - place.w, Math.max(0, place.x + Math.round(dx))), y: Math.min(64 - place.h, Math.max(0, place.y + Math.round(dy))) };
}
function placementStyle(place: MenuWidgetPlacement): CSSProperties { return { left: `${place.x / 32 * 100}%`, top: `${place.y / 64 * 100}%`, width: `${place.w / 32 * 100}%`, height: `${place.h / 64 * 100}%` }; }
export function postmatchFrameUrl(kind: MenuWidgetKind, language: AppLanguage, sourceUrl?: string, preview = false): string | null {
  const path = `/widgets/postmatch.html?kind=${kind}&lang=${language}${preview ? "&preview=1" : ""}`;
  if (!sourceUrl) return preview ? null : path;
  try { const origin = new URL(sourceUrl); return origin.protocol === "http:" && origin.hostname === "127.0.0.1" && !origin.username && !origin.password ? new URL(path, origin.origin).href : null; } catch { return null; }
}
/** DOM order is the stable stacking order, independent of selection in the editor. */
export function MenuWidgets({ layout, language, sourceUrl, preview = false }: { readonly layout: MenuWidgetLayout; readonly language: AppLanguage; readonly sourceUrl?: string; readonly preview?: boolean }) {
  return <div className="menu-widgets" aria-label={language === "ru" ? "Послематчевые виджеты" : "Post-match widgets"}>{menuWidgetKinds.map((kind) => {
    const place = layout.widgets[kind]; if (!place.enabled) return null;
    const src = postmatchFrameUrl(kind, language, sourceUrl, preview);
    return <div key={kind} className="menu-widget-frame" style={placementStyle(place)}>{src ? <iframe title={widgetNames[language][kind]} src={src} sandbox="allow-scripts allow-same-origin" referrerPolicy="no-referrer" /> : <p className="menu-widget-unavailable">{language === "ru" ? "Источник OBS недоступен" : "OBS source unavailable"}</p>}</div>;
  })}</div>;
}
type Gesture = { pointer: number; target: HTMLElement; kind: MenuWidgetKind; startX: number; startY: number; width: number; height: number; initial: MenuWidgetLayout; resize: boolean };
export function MenuWidgetGrid({ value, language, sourceUrl, disabled, onChange }: { readonly value: MenuWidgetLayout; readonly language: AppLanguage; readonly sourceUrl?: string; readonly disabled: boolean; readonly onChange: (layout: MenuWidgetLayout) => void }) {
  const [local, setLocal] = useState(value);
  const [selected, setSelected] = useState<MenuWidgetKind>("fountain");
  const board = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const latest = useRef(local); latest.current = local;
  function cancelGesture() { const active = gesture.current; gesture.current = null; if (active) { if (active.target.hasPointerCapture(active.pointer)) active.target.releasePointerCapture(active.pointer); setLocal(active.initial); } }
  useEffect(() => { cancelGesture(); setLocal(value); }, [value]);
  useEffect(() => { if (disabled) cancelGesture(); }, [disabled]);
  useEffect(() => () => { const active = gesture.current; gesture.current = null; if (active?.target.hasPointerCapture(active.pointer)) active.target.releasePointerCapture(active.pointer); }, []);
  function update(kind: MenuWidgetKind, place: MenuWidgetPlacement, commit: boolean) { const next = { ...latest.current, widgets: { ...latest.current.widgets, [kind]: clampWidget(place) } }; latest.current = next; setLocal(next); if (commit) onChange(next); }
  function begin(event: ReactPointerEvent<HTMLElement>, kind: MenuWidgetKind, resize: boolean) {
    if (disabled || gesture.current || event.button !== 0 || !board.current) return;
    event.preventDefault(); event.stopPropagation(); event.currentTarget.focus(); setSelected(kind);
    const rect = board.current.getBoundingClientRect();
    gesture.current = { pointer: event.pointerId, target: event.currentTarget, kind, startX: event.clientX, startY: event.clientY, width: rect.width, height: rect.height, initial: latest.current, resize };
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function move(event: ReactPointerEvent<HTMLElement>) {
    const active = gesture.current; if (!active || active.pointer !== event.pointerId) return;
    const place = moveMenuWidget(active.initial.widgets[active.kind], Math.round((event.clientX - active.startX) / active.width * 32), Math.round((event.clientY - active.startY) / active.height * 64), active.resize);
    update(active.kind, place, false);
  }
  function end(event: ReactPointerEvent<HTMLElement>) { if (gesture.current?.pointer !== event.pointerId) return; gesture.current = null; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); onChange(latest.current); }
  const place = local.widgets[selected];
  const ru = language === "ru";
  return <section className="menu-grid-editor" aria-labelledby="menu-grid-title">
    <div className="obs-settings-heading"><h4 id="menu-grid-title">{ru ? "Виджеты меню · сетка 32 × 64" : "Menu widgets · 32 × 64 grid"}</h4><button type="button" className="ghost-button" disabled={disabled} onClick={() => { const preset = defaultMenuLayout(); onChange({ ...preset, widgets: Object.fromEntries(menuWidgetKinds.map((kind) => [kind, { ...preset.widgets[kind], enabled: local.widgets[kind].enabled }])) as MenuWidgetLayout["widgets"] }); }}>{ru ? "Разложить 2 × 2" : "Arrange 2 × 2"}</button></div>
    <p className="settings-helper">{ru ? "32 столбца слева направо; 64 строки сверху вниз. Перетащите рамку; нижний правый угол меняет размер. Стрелки перемещают, Shift + стрелки меняют размер. Перекрытия разрешены; порядок слоёв: фонтан, карта, армии, герои." : "32 columns from left to right; 64 rows from top to bottom. Drag a frame or its bottom-right resize handle. Arrow keys move; Shift + arrows resize. Overlap is allowed; stacking order: fountain, map, armies, heroes."}</p>
    <div className="menu-widget-toggles">{menuWidgetKinds.map((kind) => <label className="obs-enable" key={kind}><input type="checkbox" checked={local.widgets[kind].enabled} disabled={disabled} onChange={(event) => { setSelected(kind); update(kind, { ...local.widgets[kind], enabled: event.currentTarget.checked }, true); }} />{widgetNames[language][kind]}</label>)}</div>
    <div className="menu-grid-axis-x" aria-hidden="true"><span>0</span><span>{ru ? "Столбцы X → 32" : "Columns X → 32"}</span></div>
    <div className="menu-grid-board" ref={board} aria-label={ru ? "Макет меню, 32 столбца и 64 строки" : "Menu layout, 32 columns and 64 rows"}>
      <MenuWidgets layout={local} language={language} sourceUrl={sourceUrl} preview />
      <span className="menu-grid-axis-y" aria-hidden="true">{ru ? "Строки Y ↓ 64" : "Rows Y ↓ 64"}</span>
      {menuWidgetKinds.map((kind, index) => { const current = local.widgets[kind]; return <div key={kind} className="menu-grid-box" data-selected={kind === selected} data-enabled={current.enabled} style={{ ...placementStyle(current), zIndex: index + 1 }} role="button" tabIndex={disabled ? -1 : 0} aria-label={`${widgetNames[language][kind]}: X ${current.x}, Y ${current.y}, ${current.w} × ${current.h}`} onFocus={() => setSelected(kind)} onPointerDown={(event) => begin(event, kind, false)} onPointerMove={move} onPointerUp={end} onPointerCancel={cancelGesture} onLostPointerCapture={cancelGesture} onKeyDown={(event) => {
        const directions: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
        const delta = directions[event.key]; if (!delta || disabled) return; event.preventDefault(); update(kind, moveMenuWidget(current, ...delta, event.shiftKey), true);
      }}><span>{widgetNames[language][kind]}</span><small>{current.x}, {current.y} · {current.w} × {current.h}</small><button type="button" className="menu-grid-resize" aria-label={`${ru ? "Размер" : "Resize"} · ${widgetNames[language][kind]}`} disabled={disabled} tabIndex={-1} onPointerDown={(event) => begin(event, kind, true)} onPointerMove={move} onPointerUp={end} onPointerCancel={cancelGesture} onLostPointerCapture={cancelGesture}>↘</button></div>; })}
    </div>
    <div className="menu-widget-numeric"><label>{ru ? "Виджет" : "Widget"}<select value={selected} disabled={disabled} onChange={(event) => setSelected(event.currentTarget.value as MenuWidgetKind)}>{menuWidgetKinds.map((kind) => <option key={kind} value={kind}>{widgetNames[language][kind]}</option>)}</select></label>{(["x", "y", "w", "h"] as const).map((key) => <label key={key}>{({ x: ru ? "Слева (X)" : "Left (X)", y: ru ? "Сверху (Y)" : "Top (Y)", w: ru ? "Ширина" : "Width", h: ru ? "Высота" : "Height" })[key]}<input type="number" min={key === "x" || key === "y" ? 0 : 1} max={key === "x" ? 32 - place.w : key === "y" ? 64 - place.h : key === "w" ? 32 - place.x : 64 - place.y} value={place[key]} disabled={disabled} onChange={(event) => update(selected, { ...place, [key]: event.currentTarget.valueAsNumber }, false)} onBlur={() => { if (!disabled) onChange(latest.current); }} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); } }} /></label>)}</div>
    {menuWidgetKinds.some((kind) => local.widgets[kind].enabled && (local.widgets[kind].w < 8 || local.widgets[kind].h < 12)) ? <p className="settings-helper" role="status">{ru ? "Некоторые рамки очень малы: подписи и анимация могут быть неразборчивы. Размер разрешён; проверьте предпросмотр." : "Some frames are very small: labels and animation may be hard to read. This size is allowed; check the preview."}</p> : null}
  </section>;
}
