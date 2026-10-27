import { useCallback, useEffect, useRef, useState } from "react";
import type { AppLanguage, OverlayPosition } from "../../domain/entities/app-settings.js";
import type { ConfigureObsOverlayRequest, ObsOverlayInfo } from "../../shared/ipc/contracts.js";
import "../styles/obs-settings.css";
import { SmartOverlaySettings } from "./SmartOverlaySettings.js";

const copy = {
  ru: {
    heading: "Оверлей OBS", description: "Добавьте в OBS источник «Браузер» по этому адресу. Один источник объединяет умный оверлей и карточку соперника.",
    enabled: "Показывать карточку соперника в OBS", position: "Положение карточки", canvas: "Размер полотна", source: "Адрес источника OBS", copy: "Копировать адрес", preview: "Открыть предпросмотр",
    checking: "Проверяем подключение…", running: "Источник готов", unavailable: "Источник недоступен", notSupported: "Браузерный источник доступен в сборке Compose.", copied: "Адрес скопирован.", failedCopy: "Не удалось скопировать. Выделите адрес и скопируйте его вручную.", failed: "Не удалось обновить настройки оверлея.", saving: "Применяем…", saved: "Оформление сохранено.", immediate: "Настройки карточки и размер полотна применяются сразу. Настольное окно включать не нужно.", transparent: "Карточка скрыта без активного матча. Кадры умного оверлея настраиваются ниже. Приложение должно работать во время трансляции.", dimensions: "В OBS укажите такой же размер источника:", retry: "Проверить снова",
    positions: ["Сверху слева", "Сверху по центру", "Сверху справа", "Посередине слева", "Посередине справа", "Снизу · 1", "Снизу · 2", "Снизу · 3", "Снизу · 4", "Снизу · 5", "Снизу · 6"]
  },
  en: {
    heading: "OBS overlay", description: "Add a Browser source in OBS using this address. One source combines the smart overlay and opponent card.",
    enabled: "Show opponent card in OBS", position: "Card position", canvas: "Canvas size", source: "OBS source address", copy: "Copy address", preview: "Open preview",
    checking: "Checking connection…", running: "Source ready", unavailable: "Source unavailable", notSupported: "The browser source is available in the Compose build.", copied: "Address copied.", failedCopy: "Could not copy. Select the address and copy it manually.", failed: "Could not update overlay settings.", saving: "Applying…", saved: "Overlay saved.", immediate: "Card settings and canvas size apply immediately. The desktop overlay can stay off.", transparent: "The card is hidden without an active match. Configure smart overlay frames below. Keep the application running during the stream.", dimensions: "Use the same source size in OBS:", retry: "Check again",
    positions: ["Top left", "Top center", "Top right", "Middle left", "Middle right", "Bottom · 1", "Bottom · 2", "Bottom · 3", "Bottom · 4", "Bottom · 5", "Bottom · 6"]
  }
};
const positionValues: OverlayPosition[] = ["top-left", "top-center", "top-right", "middle-left", "middle-right", "bottom-1", "bottom-2", "bottom-3", "bottom-4", "bottom-5", "bottom-6"];

export function ObsOverlaySettings({ language }: { readonly language: AppLanguage }) {
  const text = copy[language === "ru" ? "ru" : "en"];
  const [info, setInfo] = useState<ObsOverlayInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const generation = useRef(0);
  const mounted = useRef(true);
  const busy = useRef(false);
  const supported = Boolean(window.sc2Assistant?.getObsOverlayInfo);
  const load = useCallback(async () => {
    if (busy.current) return;
    const request = ++generation.current;
    const getInfo = window.sc2Assistant?.getObsOverlayInfo;
    if (!getInfo) { setLoading(false); return; }
    try {
      const result = await getInfo();
      if (mounted.current && generation.current === request) { setInfo(result); setError(""); }
    } catch (problem: unknown) {
      if (mounted.current && generation.current === request) { setInfo(null); setError(problem instanceof Error ? problem.message : String(problem)); }
    } finally { if (mounted.current && generation.current === request) setLoading(false); }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void load();
    const refresh = setInterval(() => void load(), 5000);
    return () => { mounted.current = false; generation.current++; clearInterval(refresh); };
  }, [load]);

  async function configure(change: Partial<ConfigureObsOverlayRequest>) {
    if (!info || !window.sc2Assistant?.configureObsOverlay) return;
    const request = ++generation.current;
    busy.current = true;
    setSaving(true); setError(""); setNotice("");
    try {
      const result = await window.sc2Assistant.configureObsOverlay({ enabled: info.enabled, position: info.position, width: info.width, height: info.height, ...change });
      if (mounted.current && generation.current === request) { setInfo(result); setNotice(text.saved); }
    } catch { if (mounted.current) setError(text.failed); }
    finally { busy.current = false; if (mounted.current) setSaving(false); }
  }
  async function copyAddress() {
    if (!info?.running || !info.url) return;
    try { await navigator.clipboard.writeText(info.url); setNotice(text.copied); setError(""); }
    catch { setError(text.failedCopy); }
  }
  async function preview() {
    try { await window.sc2Assistant?.openObsOverlayPreview?.(); }
    catch (problem: unknown) { setError(problem instanceof Error ? problem.message : String(problem)); }
  }
  const ready = Boolean(info?.running && info.url);
  const size = info ? `${info.width}×${info.height}` : "";
  return <section className="panel obs-settings" aria-labelledby="obs-overlay-heading">
    <div className="obs-settings-heading">
      <h3 id="obs-overlay-heading">{text.heading}</h3>
      <span className="obs-source-status" data-ready={ready} role="status">{loading ? text.checking : ready ? text.running : text.unavailable}</span>
    </div>
    <p className="settings-helper">{text.description}</p>
    {!supported ? <p className="settings-helper">{text.notSupported}</p> : <>
      <div className="obs-settings-connection">
        <label>{text.source}<input aria-label={text.source} readOnly value={ready ? info!.url : ""} onFocus={(event) => event.currentTarget.select()} /></label>
        <div className="obs-settings-actions">
          <button className="action-button" type="button" disabled={!ready} onClick={() => void copyAddress()}>{text.copy}</button>
          <button className="ghost-button" type="button" disabled={!ready || !window.sc2Assistant?.openObsOverlayPreview} onClick={() => void preview()}>{text.preview}</button>
        </div>
      </div>
      <div className="obs-settings-controls">
        <label className="obs-enable"><input type="checkbox" checked={info?.enabled ?? false} disabled={!ready || saving} onChange={(event) => void configure({ enabled: event.currentTarget.checked })} />{text.enabled}</label>
        <label>{text.position}<select value={info?.position ?? "top-right"} disabled={!ready || saving} onChange={(event) => void configure({ position: event.currentTarget.value as OverlayPosition })}>{positionValues.map((value, index) => <option key={value} value={value}>{text.positions[index]}</option>)}</select></label>
        <label>{text.canvas}<select value={size || "1920×1080"} disabled={!ready || saving} onChange={(event) => { const [width, height] = event.currentTarget.value.split("×").map(Number); void configure({ width, height }); }}>
          {[...new Set(["1920×1080", "2560×1440", size].filter(Boolean))].map((value) => <option key={value} value={value}>{value}</option>)}
        </select></label>
      </div>
      {info ? <p className="settings-helper">{text.dimensions} <strong>{size}</strong>. {text.transparent}</p> : null}
      <p className="settings-helper">{text.immediate}</p>
      {!ready && !loading ? <div className="obs-settings-recovery"><p className="form-status error" role="alert">{error || info?.error || text.unavailable}</p><button className="ghost-button" type="button" onClick={() => void load()}>{text.retry}</button></div> : null}
      {ready && error ? <p className="form-status error" role="alert">{error}</p> : null}
      <p className="obs-settings-notice" role="status">{saving ? text.saving : notice}</p>
      <SmartOverlaySettings language={language} sourceUrl={ready ? info!.url : undefined} />
    </>}
  </section>;
}
