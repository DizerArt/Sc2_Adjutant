import { type FormEvent, useEffect, useState } from "react";
import type { AppSettings } from "../../domain/entities/app-settings.js";
import {
  PIPER_VOICE_IDS,
  SILERO_RU_VOICE_IDS,
  type PiperVoiceId,
  type SileroRuVoiceId,
  type VoiceProvider,
  type VoiceSettings,
  VOICE_RATE_MAX,
  VOICE_RATE_MIN,
  VOICE_VOLUME_MAX,
  VOICE_VOLUME_MIN,
  defaultVoiceSettings
} from "../../domain/entities/voice-settings.js";
import type { VoiceRuntimeStatus } from "../../domain/ports/voice-synthesis-port.js";
import type { TranslationKey, Translator } from "../i18n.js";
import type { VoiceNarratorService } from "../voice/voice-narrator-service.js";

const EN_VOICES: readonly PiperVoiceId[] = PIPER_VOICE_IDS.filter((id) => id.startsWith("en_"));
const RU_VOICES: readonly SileroRuVoiceId[] = SILERO_RU_VOICE_IDS;

type SaveState = "idle" | "saving" | "saved" | "error";

export type VoiceSettingsPanelProps = {
  readonly settings: AppSettings | null;
  readonly onSave: (next: VoiceSettings) => Promise<void>;
  readonly narrator: VoiceNarratorService | null;
  readonly runtimeStatus: VoiceRuntimeStatus;
  readonly t: Translator;
};

export function VoiceSettingsPanel(props: VoiceSettingsPanelProps) {
  const initial = props.settings?.voice ?? defaultVoiceSettings();
  const [draft, setDraft] = useState<VoiceSettings>(initial);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [availableVoices, setAvailableVoices] = useState<ReadonlySet<string> | null>(null);

  useEffect(() => {
    if (props.settings?.voice) {
      setDraft(props.settings.voice);
      setSaveState("idle");
    }
  }, [props.settings?.voice]);

  useEffect(() => {
    let cancelled = false;
    if (!window.sc2Assistant?.listAvailableVoices) {
      return;
    }
    void window.sc2Assistant
      .listAvailableVoices()
      .then((response) => {
        if (!cancelled) {
          setAvailableVoices(new Set(response.available));
        }
      })
      .catch((error: unknown) => {
        console.warn("[VoiceSettingsPanel] failed to list voices:", error);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const speechLanguage = props.settings?.language ?? "en";
  const previewVoiceId = speechLanguage === "ru" ? draft.voiceRu : draft.voiceEn;

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setSaveState("saving");
    try {
      await props.onSave(draft);
      setSaveState("saved");
    } catch {
      setSaveState("error");
    }
  }

  async function handlePreview(kind: "greeting" | "opponent"): Promise<void> {
    if (!props.narrator) {
      return;
    }
    await props.narrator.previewPhrase({
      language: speechLanguage,
      voiceId: previewVoiceId,
      volume: draft.volume,
      speakingRate: draft.speakingRate,
      kind
    });
  }

  function handleStopPreview(): void {
    props.narrator?.stopAll();
  }

  const disabled = !draft.enabled || draft.provider === "off";
  const statusLabel = formatRuntimeStatusLabel(props.runtimeStatus, props.t);
  const previewAvailable = availableVoices === null || availableVoices.has(previewVoiceId);

  return (
    <section className="settings-layout voice-settings-layout">
      <form className="panel settings-form" onSubmit={handleSubmit}>
        <div className="panel-heading">
          <p className="eyebrow">{props.t("voice.title")}</p>
          <h3>{props.t("voice.subtitle")}</h3>
        </div>

        <div className="voice-runtime-status">
          <span className="voice-runtime-status-label">{props.t("voice.runtimeStatus")}:</span>
          <span className="voice-runtime-status-value" data-kind={props.runtimeStatus.kind}>
            <span className="voice-runtime-status-dot" />
            {statusLabel}
          </span>
        </div>

        <label className="toggle-row">
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(event) => setDraft({ ...draft, enabled: event.currentTarget.checked })}
          />
          {props.t("voice.field.enable")}
        </label>

        <div className="settings-row">
          <label>
            {props.t("voice.field.provider")}
            <select
              disabled={!draft.enabled}
              value={draft.provider}
              onChange={(event) =>
                setDraft({ ...draft, provider: event.currentTarget.value as VoiceProvider })
              }
            >
              <option value="piper">{props.t("voice.provider.piper")}</option>
              <option value="off">{props.t("voice.provider.off")}</option>
            </select>
          </label>

          <label>
            {props.t("voice.field.voiceEn")}
            <select
              disabled={disabled}
              value={draft.voiceEn}
              onChange={(event) =>
                setDraft({ ...draft, voiceEn: event.currentTarget.value as PiperVoiceId })
              }
            >
              {EN_VOICES.map((voiceId) => (
                <option
                  key={voiceId}
                  value={voiceId}
                  disabled={availableVoices !== null && !availableVoices.has(voiceId)}
                >
                  {props.t(`voice.voice.${voiceId}` as TranslationKey)}
                  {availableVoices !== null && !availableVoices.has(voiceId)
                    ? ` - ${props.t("voice.notDownloaded")}`
                    : ""}
                </option>
              ))}
            </select>
          </label>

          <label>
            {props.t("voice.field.voiceRu")}
            <select
              disabled={disabled}
              value={draft.voiceRu}
              onChange={(event) =>
                setDraft({ ...draft, voiceRu: event.currentTarget.value as SileroRuVoiceId })
              }
            >
              {RU_VOICES.map((voiceId) => (
                <option
                  key={voiceId}
                  value={voiceId}
                  disabled={availableVoices !== null && !availableVoices.has(voiceId)}
                >
                  {props.t(`voice.voice.${voiceId}` as TranslationKey)}
                  {availableVoices !== null && !availableVoices.has(voiceId)
                    ? ` - ${props.t("voice.notDownloaded")}`
                    : ""}
                </option>
              ))}
            </select>
          </label>
        </div>

        {!previewAvailable ? (
          <p className="voice-warning">{props.t("voice.warning.missingModel")}</p>
        ) : null}

        <div className="settings-row">
          <label>
            {props.t("voice.field.volume")} ({Math.round(draft.volume * 100)}%)
            <input
              type="range"
              min={VOICE_VOLUME_MIN}
              max={VOICE_VOLUME_MAX}
              step={0.05}
              disabled={disabled}
              value={draft.volume}
              onChange={(event) =>
                setDraft({ ...draft, volume: Number.parseFloat(event.currentTarget.value) })
              }
            />
          </label>

          <label>
            {props.t("voice.field.speakingRate")} ({draft.speakingRate.toFixed(2)}x)
            <input
              type="range"
              min={VOICE_RATE_MIN}
              max={VOICE_RATE_MAX}
              step={0.05}
              disabled={disabled}
              value={draft.speakingRate}
              onChange={(event) =>
                setDraft({ ...draft, speakingRate: Number.parseFloat(event.currentTarget.value) })
              }
            />
          </label>
        </div>

        <label className="toggle-row">
          <input
            type="checkbox"
            disabled={disabled}
            checked={draft.announceOnLaunch}
            onChange={(event) =>
              setDraft({ ...draft, announceOnLaunch: event.currentTarget.checked })
            }
          />
          {props.t("voice.field.announceLaunch")}
        </label>
        <label className="toggle-row">
          <input
            type="checkbox"
            disabled={disabled}
            checked={draft.announceOpponentCard}
            onChange={(event) =>
              setDraft({ ...draft, announceOpponentCard: event.currentTarget.checked })
            }
          />
          {props.t("voice.field.announceOpponent")}
        </label>
        <div className="form-actions voice-preview-actions">
          <button
            className="ghost-button voice-preview-button"
            type="button"
            disabled={disabled || !props.narrator || !previewAvailable}
            onClick={() => void handlePreview("greeting")}
          >
            {props.t("voice.button.testGreeting")}
          </button>
          <button
            className="ghost-button voice-preview-button"
            type="button"
            disabled={disabled || !props.narrator || !previewAvailable}
            onClick={() => void handlePreview("opponent")}
          >
            {props.t("voice.button.testOpponent")}
          </button>
          <button
            className="ghost-button voice-preview-button"
            type="button"
            disabled={!props.narrator}
            onClick={handleStopPreview}
          >
            {props.t("voice.button.stopPreview")}
          </button>
        </div>

        <div className="form-actions">
          <button className="action-button" type="submit" disabled={saveState === "saving"}>
            {props.t("voice.button.save")}
          </button>
          {saveState === "saving" ? (
            <span className="form-status">{props.t("voice.status.saving")}</span>
          ) : null}
          {saveState === "saved" ? (
            <span className="form-status">{props.t("voice.status.saved")}</span>
          ) : null}
          {saveState === "error" ? (
            <span className="form-status error">{props.t("voice.status.saveFailed")}</span>
          ) : null}
        </div>
      </form>
    </section>
  );
}

function formatRuntimeStatusLabel(status: VoiceRuntimeStatus, t: Translator): string {
  switch (status.kind) {
    case "idle":
      return t("voice.status.idle");
    case "loading":
      return t("voice.status.loading");
    case "ready":
      return t("voice.status.ready");
    case "error":
      return `${t("voice.status.error")}: ${status.message}`;
  }
}
