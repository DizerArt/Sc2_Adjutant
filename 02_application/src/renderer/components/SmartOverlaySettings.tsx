import { useEffect, useRef, useState } from "react";
import type { AppLanguage } from "../../domain/entities/app-settings.js";
import type { Sc2AssistantBridge, SmartOverlayConfig, SmartOverlayPhase, SmartOverlaySettingsInfo } from "../../shared/ipc/contracts.js";
import { isSmartConfig, parseSmartSettings, smartPhases, SmartOverlayLayer } from "./SmartOverlayLayer.js";
import "../styles/obs-smart-settings.css";
import { defaultMenuLayout, MenuWidgetGrid } from "./MenuWidgetGrid.js";
import { PostmatchPreparation } from "./PostmatchPreparation.js";

type SmartAction = { readonly kind: "save"; readonly config: SmartOverlayConfig } | { readonly kind: "apply" } | { readonly kind: "choose"; readonly phase: SmartOverlayPhase };
/** Every action uses the displayed revision. A conflict refreshes once and never retries a write. */
export async function runSmartOverlayAction(bridge: Sc2AssistantBridge, current: SmartOverlaySettingsInfo, action: SmartAction): Promise<{ info: SmartOverlaySettingsInfo; failed: boolean; cancelled: boolean; problem?: string }> {
  if (!parseSmartSettings(current) || (action.kind === "save" && !isSmartConfig(action.config))) throw Error("Invalid overlay settings");
  try {
    let value: unknown;
    if (action.kind === "save") {
      if (!bridge.saveSmartOverlayDraft) throw Error("Unavailable");
      value = await bridge.saveSmartOverlayDraft({ revision: current.revision, ...action.config });
    } else if (action.kind === "apply") {
      if (!bridge.applySmartOverlay) throw Error("Unavailable");
      value = await bridge.applySmartOverlay({ revision: current.revision });
    } else {
      if (!bridge.chooseSmartOverlayImage) throw Error("Unavailable");
      value = await bridge.chooseSmartOverlayImage({ revision: current.revision, mode: action.phase });
      if (value === null) return { info: current, failed: false, cancelled: true };
    }
    const info = parseSmartSettings(value);
    if (!info) throw Error("Invalid overlay response");
    return { info, failed: false, cancelled: false };
  } catch (error: unknown) {
    const problem = (error instanceof Error ? error.message : String(error)).slice(0, 600);
    try { const refreshed = parseSmartSettings(await bridge.getSmartOverlaySettings?.()); return { info: refreshed ?? current, failed: true, cancelled: false, problem }; }
    catch { return { info: current, failed: true, cancelled: false, problem }; }
  }
}
const words = {
  ru: { title: "Умный оверлей", description: "Четыре кадра переключаются по состоянию StarCraft II. Изменения сохраняются в черновик; трансляция обновится после применения.", enabled: "Включить умный оверлей", modeEnabled: "Показывать этот кадр", choose: "Выбрать изображение…", reset: "Вернуть стандартный вид", apply: "Применить в OBS", draft: "Предпросмотр черновика", live: "Черновик применён в OBS", pending: "Есть изменения для OBS", loading: "Загружаем настройки…", saving: "Сохраняем черновик…", choosing: "Выберите файл в открывшемся окне…", applying: "Применяем в OBS…", failed: "Изменение не сохранено. Настройки перечитаны; проверьте их перед повтором.", unavailable: "Настройки умного оверлея недоступны.", retry: "Повторить загрузку", builtin: "Стандартный вид", disabled: "Этот кадр выключен. На трансляции он будет прозрачным.", offline: "Для предпросмотра своего изображения запустите локальный источник OBS.", imageHint: "PNG/JPEG: до 16 МиБ; GIF: до 128 МиБ, 60 секунд и 1800 кадров. До 4096 пикселей на сторону и 16 млн пикселей; суммарно до 600 млн декодированных пикселей GIF. При уменьшении движения — неподвижный кадр.", standard: { menu: "Прозрачный кадр. Для оформления меню выберите своё изображение.", loading: "Непрозрачная загрузочная заставка Brat_OK.", game: "Контур интерфейса Terran в нижней части экрана.", pause: "Затемнение с мягкой пульсацией; без движения — постоянное." }, phases: { menu: "Меню", loading: "Загрузка", game: "Игра", pause: "Пауза" } },
  en: { title: "Smart overlay", description: "Four frames follow the state of StarCraft II. Changes are saved as a draft; the stream updates only after you apply them.", enabled: "Enable smart overlay", modeEnabled: "Show this frame", choose: "Choose image…", reset: "Restore standard appearance", apply: "Apply to OBS", draft: "Draft preview", live: "Draft applied to OBS", pending: "Changes waiting for OBS", loading: "Loading settings…", saving: "Saving draft…", choosing: "Choose a file in the dialog…", applying: "Applying to OBS…", failed: "The change was not saved. Settings were refreshed; check them before retrying.", unavailable: "Smart overlay settings are unavailable.", retry: "Reload settings", builtin: "Standard appearance", disabled: "This frame is off. It will be transparent on stream.", offline: "Start the local OBS source to preview your image.", imageHint: "PNG/JPEG: up to 16 MiB; GIF: up to 128 MiB, 60 seconds and 1800 frames. Up to 4096 pixels per side and 16 million pixels; up to 600 million decoded GIF pixels. Reduced motion uses a still frame.", standard: { menu: "Transparent frame. Choose your own image to style the menu.", loading: "Opaque Brat_OK loading screen.", game: "Terran interface outline at the bottom of the screen.", pause: "A gently pulsing shade; a constant shade with reduced motion." }, phases: { menu: "Menu", loading: "Loading", game: "Game", pause: "Pause" } }
};
export function SmartOverlaySettings({ language, sourceUrl }: { readonly language: AppLanguage; readonly sourceUrl?: string }) {
  const text = words[language];
  const [info, setInfo] = useState<SmartOverlaySettingsInfo | null>(null);
  const [phase, setPhase] = useState<SmartOverlayPhase>("menu");
  const [busy, setBusy] = useState<"load" | "save" | "choose" | "apply" | null>("load");
  const [error, setError] = useState(false);
  const [problem, setProblem] = useState("");
  const mounted = useRef(false);
  const locked = useRef(false);
  const supported = Boolean(window.sc2Assistant?.getSmartOverlaySettings);
  async function load() {
    if (locked.current) return;
    locked.current = true; setBusy("load"); setError(false); setProblem("");
    try { const result = parseSmartSettings(await window.sc2Assistant?.getSmartOverlaySettings?.()); if (!result) throw Error("Invalid overlay settings"); if (mounted.current) setInfo(result); }
    catch { if (mounted.current) setError(true); }
    finally { locked.current = false; if (mounted.current) setBusy(null); }
  }
  useEffect(() => { mounted.current = true; if (supported) void load(); else setBusy(null); return () => { mounted.current = false; }; }, []);
  async function act(action: SmartAction) {
    if (!info || locked.current || !window.sc2Assistant) return;
    locked.current = true; setBusy(action.kind); setError(false); setProblem("");
    try { const result = await runSmartOverlayAction(window.sc2Assistant, info, action); if (mounted.current) { setInfo(result.info); setError(result.failed); setProblem(result.problem ?? ""); } }
    catch { if (mounted.current) setError(true); }
    finally { locked.current = false; if (mounted.current) setBusy(null); }
  }
  function changeMode(change: Partial<SmartOverlayConfig["modes"][SmartOverlayPhase]>) {
    if (!info) return;
    void act({ kind: "save", config: { ...info.draft, modes: { ...info.draft.modes, [phase]: { ...info.draft.modes[phase], ...change } } } });
  }
  const mode = info?.draft.modes[phase];
  const waiting = Boolean(info && info.revision !== info.appliedRevision);
  const status = busy === "load" ? text.loading : busy === "choose" ? text.choosing : busy === "apply" ? text.applying : busy === "save" ? text.saving : waiting ? text.pending : info ? text.live : "";
  return <section className="smart-settings" aria-labelledby="smart-overlay-heading">
    <div className="obs-settings-heading"><h3 id="smart-overlay-heading">{text.title}</h3><span className="smart-draft-status" role="status">{status}</span></div>
    <p className="settings-helper">{text.description}</p>
    {!supported ? <p className="settings-helper">{text.unavailable}</p> : info ? <>
      <label className="obs-enable"><input type="checkbox" checked={info.draft.enabled} disabled={Boolean(busy)} onChange={(event) => void act({ kind: "save", config: { ...info.draft, enabled: event.currentTarget.checked } })} />{text.enabled}</label>
      <div className="smart-frame-tabs" role="group" aria-label={language === "ru" ? "Кадр для настройки" : "Frame to edit"}>{smartPhases.map((value) => <button type="button" key={value} className="ghost-button" aria-pressed={phase === value} onClick={() => setPhase(value)}>{text.phases[value]}</button>)}</div>
      <div className="smart-frame-editor">
        <div className="smart-frame-options">
          <h4>{text.phases[phase]}</h4>
          <label className="obs-enable"><input type="checkbox" checked={mode?.enabled ?? false} disabled={Boolean(busy)} onChange={(event) => changeMode({ enabled: event.currentTarget.checked })} />{text.modeEnabled}</label>
          <p className="settings-helper smart-image-name">{mode?.image?.name || text.builtin}</p>
          <div className="obs-settings-actions"><button type="button" className="ghost-button" disabled={Boolean(busy)} onClick={() => void act({ kind: "choose", phase })}>{text.choose}</button><button type="button" className="ghost-button" disabled={Boolean(busy) || !mode?.image} onClick={() => changeMode({ image: null })}>{text.reset}</button></div>
          {!mode?.image ? <p className="settings-helper">{text.standard[phase]}</p> : null}
          <p className="settings-helper">{text.imageHint}</p>
        </div>
        <div><p className="smart-preview-label">{text.draft} · {text.phases[phase]}</p><div className="smart-draft-preview">
          {mode?.enabled && info.draft.enabled ? mode.image && !sourceUrl ? <p className="smart-preview-empty">{text.offline}</p> : <SmartOverlayLayer key={phase} smart={{ enabled: true, phase, mode, menuLayout: info.draft.menuLayout }} language={language} sourceUrl={sourceUrl} preview /> : <p className="smart-preview-empty">{text.disabled}</p>}
        </div></div>
      </div>
      {phase === "menu" ? <><PostmatchPreparation language={language} /><MenuWidgetGrid value={info.draft.menuLayout ?? defaultMenuLayout()} language={language} sourceUrl={sourceUrl} disabled={Boolean(busy)} onChange={(menuLayout) => void act({ kind: "save", config: { ...info.draft, menuLayout } })} /></> : null}
      <div className="smart-apply-row"><button type="button" className="action-button" disabled={Boolean(busy) || !waiting} onClick={() => void act({ kind: "apply" })}>{text.apply}</button><p className="settings-helper">{language === "ru" ? "Предпросмотр не меняет трансляцию." : "Preview does not change the stream."}</p></div>
    </> : null}
    {error ? <div className="obs-settings-recovery"><p className="form-status error" role="alert">{info ? text.failed : text.unavailable}{problem ? ` ${problem}` : ""}</p><button type="button" className="ghost-button" disabled={Boolean(busy)} onClick={() => void load()}>{text.retry}</button></div> : null}
  </section>;
}
